#!/usr/bin/env node
// roadmap — MCP server (hand-rolled JSON-RPC 2.0 over stdio, newline-delimited).
// Exposes the roadmap as agent-callable tools: read (plan / ready_wave / show / validate) and
// mutate (add_pi / add_sprint / set_status / set_fields / prune). Mutations edit roadmap.yaml
// through the yaml Document API (comments preserved), validate the result before writing, and
// re-render SLICES.md. Zero new deps: just `yaml` + the repo's own libs.
//
// Bundled in the plugin via .mcp.json; also runnable as `roadmap mcp` for debugging.

import { createInterface } from "node:readline";
import { findRepoRoot, REL } from "@connorbritain/roadmap-core/cli-core.mjs";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { mutateRoadmap, mutateBacklog, mutateBoth, loadBacklog, roadmapPaths, originBacklogIds } from "@connorbritain/roadmap-core/store.mjs";
import { TOOLS, READ_HANDLERS, MUTATION_HANDLERS } from "@connorbritain/roadmap-core/mcp-core.mjs";
import { BACKLOG_TOOLS, BACKLOG_READ_HANDLERS, BACKLOG_MUTATION_HANDLERS, performPromotion } from "@connorbritain/roadmap-core/backlog-core.mjs";
import { linearState, linearStatusLine, normalizeLinearConfig } from "@connorbritain/roadmap-core/linear-core.mjs";
import { platedKeys } from "@connorbritain/roadmap-core/plate-core.mjs";
import { runSync, runNote, runNotes, runProjectUpdate } from "./linear.mjs";
import { runEstimate, runTimeline, runLog } from "./estimate.mjs";
import { LOG_STATUSES } from "@connorbritain/roadmap-core/estimate-core.mjs";
import { loadProfileForRoot } from "@connorbritain/roadmap-cli/profile.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Always registered; politely erroring when unconfigured beats config-gated registration
// (tools/list would need IO). linear_sync reuses linear.mjs's runSync — one sync implementation.
const LINEAR_TOOLS = [
  { name: "linear_status", description: "Linear integration state for this roadmap (configured / authed / last sync). Zero network. Read-only.",
    inputSchema: { type: "object", properties: {} } },
  { name: "linear_sync", description: "Run the Linear sync: push the roadmap/backlog projection, fetch the pull inbox. dry=true plans without writing. With meta.linear.pull=propose the inbox is returned as proposals for you to apply via backlog_add/set_status/backlog_set.",
    inputSchema: { type: "object", properties: { dry: { type: "boolean" }, push: { type: "boolean" }, pull: { type: "boolean" } } } },
];

// plate_list is a read that needs the backlog too (in_progress items), so it's handled inline here
// rather than in mcp-core's graph-only READ_HANDLERS. The plate_set/add/remove mutations live in TOOLS.
const PLATE_TOOLS = [
  { name: "plate_list", description: "The current plate — the curated batch projected to Linear's My Issues (assignee=you): explicit meta.plate entries plus auto-included active/in_progress work. Returns { enabled, explicit, plate, plate_max }. Read-only.",
    inputSchema: { type: "object", properties: {} } },
];

// The journal — progress notes on the mapped issue, so in-flight work survives a dead session.
const JOURNAL_TOOLS = [
  { name: "issue_note", description: "Post a progress note to a slice/backlog item's mapped Linear issue — the resumability trail. Use at checkpoints (a gate cleared, a blocker hit, a logical unit done) so a session that dies mid-flight can be picked up from where it left off. kind: progress|blocker|done.",
    inputSchema: { type: "object", required: ["key", "text"], properties: { key: { type: "string", description: "slice invoke key or backlog id" }, text: { type: "string" }, kind: { enum: ["progress", "blocker", "done"] } } } },
  { name: "issue_notes", description: "Read a slice/backlog item's Linear issue comment stream (chronological). Call this FIRST when picking up in-flight work — it's where the last session left off. Read-only.",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string", description: "slice invoke key or backlog id" } } } },
  { name: "project_update", description: "Post a PI-level digest to its Linear project update (the 'where this bet stands' rollup) — for milestones, not per-checkpoint. Degradation-guarded: returns { posted:false } if Linear rejects it.",
    inputSchema: { type: "object", required: ["pi", "body"], properties: { pi: { type: "string" }, body: { type: "string" } } } },
];

// agent-time bridge — a slice's duration estimate, cached on the slice for the timeline rollup.
const ESTIMATE_TOOLS = [
  { name: "estimate", description: "Estimate a slice's duration via agent-time (calibrated agent-rounds → wall-clock minutes) and cache it on the slice. Set the slice's shape (+ optional risks) first — an unclassified slice is skipped. Skips an already-estimated slice unless force=true; all=true estimates every classified slice. Needs the agent-time-estimator skill installed (or meta.estimation.engine).",
    inputSchema: { type: "object", properties: { invoke: { type: "string", description: "slice invoke key" }, all: { type: "boolean" }, force: { type: "boolean" } } } },
  { name: "timeline", description: "Roll the cached per-slice estimates up into a projected target date per PI (using the same wave/dependency/concurrency schedule the fanout runs) and write pi.projected_target_date back — the estimate-driven Linear timeline. Never overwrites an explicit pi.target_date. Returns the per-PI dates plus any unpriced/held slices excluded from the projection.",
    inputSchema: { type: "object", properties: {} } },
  { name: "estimate_log", description: "Log a completed slice's outcome to agent-time's calibration history (status pass|fail|partial|abandoned) so future estimates self-correct — the calibration loop. Requires the slice to have been estimated (carries estimate.task_id). Pass actual_rounds (and optionally actual_minutes) unless agent-time's round-counter hook auto-filled them; without either, agent-time rejects the log. Idempotent per task_id.",
    inputSchema: { type: "object", required: ["invoke"], properties: { invoke: { type: "string", description: "slice invoke key" }, status: { enum: LOG_STATUSES }, actual_rounds: { type: "integer", minimum: 0 }, actual_minutes: { type: "number", minimum: 0 }, force: { type: "boolean" } } } },
];

const PROTOCOL_VERSION = "2024-11-05";
// The server version is the installed package's (read once; it cannot drift from what npm shipped).
const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version; } catch { return "unknown"; } })();
const SERVER_INFO = { name: "graph", version: PKG_VERSION };

function repoRoot() {
  const root = findRepoRoot(process.env.CODEX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) throw new Error(`no ${REL.join("/")} found at or above the project directory`);
  return root;
}

// The work profile (engineering | general) decides which executor package's tools are registered
// and how `plan` sizes capacity. Loaded once per root through the single meta.profile reader.
function profileOf(root) {
  return loadProfileForRoot(root, { loadGraph, roadmapPath: roadmapPaths(root).yaml });
}

async function toolList() {
  let extra = [];
  try { extra = (await profileOf(repoRoot())).mcp.tools; } catch { /* no roadmap yet: core tools only */ }
  return [...TOOLS, ...BACKLOG_TOOLS, ...LINEAR_TOOLS, ...PLATE_TOOLS, ...JOURNAL_TOOLS, ...ESTIMATE_TOOLS, ...extra];
}

async function callTool(name, args) {
  if (READ_HANDLERS[name]) {
    const root = repoRoot();
    const graph = loadGraph(roadmapPaths(root).yaml);
    return READ_HANDLERS[name](graph, args || {}, (await profileOf(root)).planContext);
  }
  if (MUTATION_HANDLERS[name]) {
    // mutateRoadmap = read → mutate → validate → write → re-render; a throw leaves files untouched.
    return mutateRoadmap(repoRoot(), (doc) => MUTATION_HANDLERS[name](doc, args || {}));
  }
  if (BACKLOG_READ_HANDLERS[name]) {
    return BACKLOG_READ_HANDLERS[name](loadBacklog(repoRoot()), args || {});
  }
  if (BACKLOG_MUTATION_HANDLERS[name]) {
    // backlog_add gets origin/main ids injected so concurrent sessions cannot mint the same bNN.
    const margs = name === "backlog_add" ? { ...(args || {}), origin_ids: (args && args.origin_ids) || originBacklogIds(repoRoot()) } : (args || {});
    return mutateBacklog(repoRoot(), (doc) => BACKLOG_MUTATION_HANDLERS[name](doc, margs),
      { createIfMissing: name === "backlog_add" });
  }
  if (name === "backlog_promote") {
    // Spans both YAMLs: both validated before either is written.
    return mutateBoth(repoRoot(), (rDoc, bDoc) => performPromotion(rDoc, bDoc, args || {}));
  }
  if (name === "linear_status") {
    const root = repoRoot();
    const graph = loadGraph(roadmapPaths(root).yaml);
    const st = linearState({ meta: graph.meta, env: process.env });
    return { configured: st.configured, authed: st.authed,
      ...(st.cfg ? { team: st.cfg.team, granularity: st.cfg.granularity, pull: st.cfg.pull } : {}),
      status: linearStatusLine(st) };
  }
  if (name === "linear_sync") {
    // async; the tools/call path awaits. runSync itself throws the setup-guidance errors.
    return runSync(repoRoot(), { dry: !!args.dry, pushOnly: args.pull === false, pullOnly: args.push === false });
  }
  if (name === "plate_list") {
    const root = repoRoot();
    const graph = loadGraph(roadmapPaths(root).yaml);
    const set = platedKeys(graph, loadBacklog(root));
    const explicit = Array.isArray(graph.meta && graph.meta.plate) ? graph.meta.plate : [];
    const cfg = normalizeLinearConfig(graph.meta || {});
    return { enabled: set != null, explicit, plate: set ? [...set] : [], plate_max: cfg ? cfg.plate_max : 7 };
  }
  if (name === "estimate") {
    // sync (spawnSync); the tools/call path Promise-wraps it. Writes est_minutes back to the YAML.
    return runEstimate(repoRoot(), { invoke: args.invoke, all: !!args.all, force: !!args.force });
  }
  if (name === "timeline") {
    // pure rollup over cached estimates + write-back; no network.
    return runTimeline(repoRoot(), {});
  }
  if (name === "estimate_log") {
    // sync (spawnSync estimator log); idempotent per task_id. No YAML write.
    return runLog(repoRoot(), { invoke: args.invoke, status: args.status, force: !!args.force,
      actualRounds: args.actual_rounds, actualMinutes: args.actual_minutes });
  }
  if (name === "issue_note") return runNote(repoRoot(), args.key, { kind: args.kind, text: args.text }, {});
  if (name === "issue_notes") return runNotes(repoRoot(), args.key, {});
  if (name === "project_update") return runProjectUpdate(repoRoot(), args.pi, args.body, {});
  // Profile tools last: the loaded executor package answers its own (undefined = not one of its).
  const root = repoRoot();
  const profile = await profileOf(root);
  const result = await profile.mcp.call(name, args || {});
  if (result !== undefined) return result;
  throw new Error(`unknown tool "${name}" (profile ${profile.name} registers ${profile.mcp.tools.length} extra tool(s))`);
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return out({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
  }
  if (method === "notifications/initialized" || method === "initialized") return; // notification: no reply
  if (method === "ping") return out({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") {
    return toolList().then(
      (tools) => out({ jsonrpc: "2.0", id, result: { tools } }),
      (e) => out({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } }),
    );
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    // Promise-wrapped so async tools (linear_sync) work; sync tools resolve immediately.
    return Promise.resolve().then(() => callTool(name, args)).then(
      (result) => out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(result?.ok === false ? { isError: true } : {}) } }),
      // MCP convention: tool failures come back as a result with isError, so the model sees why.
      (e) => out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } }),
    );
  }
  if (id !== undefined && id !== null) {
    return out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg && msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } });
  }
});
