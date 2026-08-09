#!/usr/bin/env node
// roadmap — MCP server (hand-rolled JSON-RPC 2.0 over stdio, newline-delimited).
// Exposes the roadmap as agent-callable tools: read (plan / ready_wave / show / validate) and
// mutate (add_pi / add_sprint / set_status / set_fields / prune). Mutations edit roadmap.yaml
// through the yaml Document API (comments preserved), validate the result before writing, and
// re-render SLICES.md. Zero new deps: just `yaml` + the repo's own libs.
//
// Bundled in the plugin via .mcp.json; also runnable as `roadmap mcp` for debugging.

import { createInterface } from "node:readline";
import { findRepoRoot, REL } from "./lib/cli-core.mjs";
import { loadGraph } from "./lib/graph.mjs";
import { mutateRoadmap, mutateBacklog, mutateBoth, loadBacklog, roadmapPaths, originBacklogIds } from "./lib/store.mjs";
import { TOOLS, READ_HANDLERS, MUTATION_HANDLERS } from "./lib/mcp-core.mjs";
import { BACKLOG_TOOLS, BACKLOG_READ_HANDLERS, BACKLOG_MUTATION_HANDLERS, performPromotion } from "./lib/backlog-core.mjs";
import { linearState, linearStatusLine, normalizeLinearConfig } from "./lib/linear-core.mjs";
import { platedKeys } from "./lib/plate-core.mjs";
import { runSync, runNote, runNotes, runProjectUpdate } from "./linear.mjs";
import { runDispatch, runFanCloud } from "./dispatch.mjs";
import { runGauntletStart, runGauntletStatus, runGauntletAcknowledge, runGauntletCritic, runGauntletRepair, runGauntletCancel } from "./gauntlet.mjs";
import { runEstimate, runTimeline, runLog } from "./estimate.mjs";
import { LOG_STATUSES } from "./lib/estimate-core.mjs";

// Always registered; politely erroring when unconfigured beats config-gated registration
// (tools/list would need IO). linear_sync reuses linear.mjs's runSync — one sync implementation.
const LINEAR_TOOLS = [
  { name: "linear_status", description: "Linear integration state for this roadmap (configured / authed / last sync). Zero network. Read-only.",
    inputSchema: { type: "object", properties: {} } },
  { name: "linear_sync", description: "Run the Linear sync: push the roadmap/backlog projection, fetch the pull inbox. dry=true plans without writing. With meta.linear.pull=propose the inbox is returned as proposals for you to apply via backlog_add/set_status/backlog_set.",
    inputSchema: { type: "object", properties: { dry: { type: "boolean" }, push: { type: "boolean" }, pull: { type: "boolean" } } } },
];

// Cloud dispatch conducts remote agents without consuming local worktrees. Claude
// Routines can publish PRs; Codex Cloud records a task receipt and may await
// artifact publication because its supported CLI has no unattended task→PR call.
const CLOUD_TOOLS = [
  { name: "dispatch", description: "Launch one remote cloud agent for a slice or backlog item. provider=claude (default) fires a Routine; provider=codex submits an exact Codex Cloud task receipt in the configured repository environment. Neither consumes a local worktree. Codex currently cannot be claimed as an unattended task→PR transport, so its result may be awaiting artifact publication.",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string", description: "slice invoke key or backlog id" }, provider: { enum: ["claude", "codex"] }, attempts: { type: "integer", minimum: 1, maximum: 4, description: "Codex Cloud best-of-N attempts; not independent critics" }, force: { type: "boolean", description: "override the cycle lock for this one dispatch (out-of-cycle work; surfaces as scope change)" } } } },
  { name: "fan_cloud", description: "Preview or conduct a provider-aware cloud fanout of a ready wave without local worktrees. provider=claude opens Routine sessions; provider=codex creates distinct remote task receipts. DEFAULT is a preview; pass confirm=true to submit.",
    inputSchema: { type: "object", properties: {
      wave: { type: "integer", minimum: 1, description: "which ready wave (default 1)" },
      cap: { type: "integer", minimum: 1, description: "max slices in the wave (default the review ceiling, 5 — machine limits don't apply to cloud)" },
      confirm: { type: "boolean", description: "false/absent = preview only; true = actually fire the cloud sessions" },
      all: { type: "boolean", description: "include out-of-cycle slices in the wave (explicit override of the cycle lock)" },
      provider: { enum: ["claude", "codex"] }, attempts: { type: "integer", minimum: 1, maximum: 4 } } } },
];

// Conducted cloud work: deterministic senses/actuators only. The lead model remains the
// executive function that judges critic materiality, synthesizes repairs, and decides stops.
const GAUNTLET_TOOLS = [
  { name: "gauntlet_start", description: "Freeze the current quality bar, create a run, and launch one provider-selected implementation execution. GitHub remains the durable artifact; the local ledger records generic provider receipts. Codex implementation may await artifact publication rather than claiming a PR.",
    inputSchema: { type: "object", required: ["key"], properties: {
      key: { type: "string", description: "slice invoke key or backlog id" },
      max_rounds: { type: "integer", minimum: 0, maximum: 20, description: "maximum repair launches (default meta.gauntlet.max_rounds or 3)" },
      bar: { type: "string", description: "additional immutable acceptance criteria/references appended to the roadmap-derived bar" },
      implementation_tier: { type: "string" }, critic_tier: { type: "string" }, repair_tier: { type: "string" },
      implementation_provider: { enum: ["claude", "codex"] }, critic_provider: { enum: ["claude", "codex"] }, repair_provider: { enum: ["claude", "codex"] },
      force: { type: "boolean", description: "explicitly override the roadmap cycle lock for this run" },
      critic_profile: { type: "string", description: "optional machine-local Routine profile label for critics" } } } },
  { name: "gauntlet_status", description: "Reconstruct a Gauntlet run from the local launch ledger plus GitHub PR/body/head/checks/comments and protected claim refs. Strictly read-only, including when exposing a different winning protocol to a distributed loser. Reports stale or unacknowledged worker verdicts as non-authoritative, detects claim/attestation and repair-history gaps, and returns the safe next actuator(s).",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string", description: "run id or roadmap subject key" } } } },
  { name: "gauntlet_ack", description: "After the frozen lead independently inspects one exact critic comment from gauntlet_status, post a lead-authored acknowledgment bound to both its immutable body digest and exact GitHub comment-URL digest. A worker verdict cannot drive PASS/REVISE until acknowledged. Requires the exact comment URL and explicit confirmation.",
    inputSchema: { type: "object", required: ["run", "comment_url", "confirm"], properties: {
      run: { type: "string" }, comment_url: { type: "string", minLength: 1 }, confirm: { const: true } } } },
  { name: "gauntlet_critic", description: "Fire one fresh-context independent critic for an exact open PR head. Refuses when the expected SHA is stale, checks are unstable/failing, or the same run/head/critic role is already launched. The critic receives the frozen bar and artifact—not builder reasoning—and posts a structured SHA-pinned GitHub candidate verdict that remains non-authoritative until frozen-lead acknowledgment.",
    inputSchema: { type: "object", required: ["run", "expected_head"], properties: {
      run: { type: "string" }, expected_head: { type: "string", pattern: "^[a-f0-9]{40}$" },
      critic_role: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "one selected critic role for this run/head; defaults to critic" },
      tier: { type: "string" }, profile: { type: "string" }, provider: { enum: ["claude", "codex"] },
      confirm_recovered_bar: { type: "boolean", description: "after ledgerless recovery or discovery of a different distributed-election winner, explicitly attest as that packet's frozen lead that its bar still matches lead/human intent before local adoption and re-criticism" },
      force_checks: { type: "boolean", description: "explicitly review despite pending/failing checks; SHA safety is never bypassed" } } } },
  { name: "gauntlet_repair", description: "Fire a fresh repair Routine against the existing PR at an exact expected head, using a lead-synthesized repair packet. Requires a frozen-lead-acknowledged current-head REVISE verdict, refuses duplicates/stale heads/exhausted rounds, and never creates or merges a competing PR.",
    inputSchema: { type: "object", required: ["run", "expected_head", "packet"], properties: {
      run: { type: "string" }, expected_head: { type: "string", pattern: "^[a-f0-9]{40}$" },
      packet: { type: "string", minLength: 1, maxLength: 50000 }, tier: { type: "string" }, profile: { type: "string" }, provider: { enum: ["claude", "codex"] } } } },
  { name: "gauntlet_cancel", description: "Explicitly abandon a stuck or ambiguous Gauntlet run while preserving all launch receipts. Human confirmation and a reason are required. A protected pre-PR tombstone prevents delayed-PR resurrection after ledger loss; the detailed reason remains local until a PR comment exists. An existing GitHub PR is never closed or deleted.",
    inputSchema: { type: "object", required: ["run", "reason", "confirm"], properties: {
      run: { type: "string" }, reason: { type: "string", minLength: 1, maxLength: 2000 }, confirm: { const: true } } } },
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
const SERVER_INFO = { name: "graph", version: "0.6.0" };

function repoRoot() {
  const root = findRepoRoot(process.env.CODEX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) throw new Error(`no ${REL.join("/")} found at or above the project directory`);
  return root;
}

function callTool(name, args) {
  if (READ_HANDLERS[name]) {
    const graph = loadGraph(roadmapPaths(repoRoot()).yaml);
    return READ_HANDLERS[name](graph, args || {});
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
  if (name === "dispatch") {
    // async; runDispatch fires the routine (or the Linear @-mention) and returns the session/comment.
    return runDispatch(repoRoot(), args.key, { force: !!args.force, provider: args.provider, attempts: args.attempts });
  }
  if (name === "fan_cloud") {
    // preview unless confirm=true; runFanCloud loops runDispatch over the ready wave.
    return runFanCloud(repoRoot(), args || {});
  }
  if (name === "gauntlet_start") {
    return runGauntletStart(repoRoot(), args.key, {
      maxRounds: args.max_rounds, additionalBar: args.bar,
      implementationTier: args.implementation_tier, criticTier: args.critic_tier,
      repairTier: args.repair_tier, implementationProvider: args.implementation_provider,
      criticProvider: args.critic_provider, repairProvider: args.repair_provider,
      criticProfile: args.critic_profile, force: !!args.force,
    });
  }
  if (name === "gauntlet_status") return runGauntletStatus(repoRoot(), args.run);
  if (name === "gauntlet_ack") return runGauntletAcknowledge(repoRoot(), args.run,
    { commentUrl: args.comment_url, confirm: args.confirm === true });
  if (name === "gauntlet_critic") {
    return runGauntletCritic(repoRoot(), args.run, {
      expectedHead: args.expected_head,
      criticRole: args.critic_role || "critic", tier: args.tier, profile: args.profile, provider: args.provider, forceChecks: !!args.force_checks,
      confirmRecoveredBar: !!args.confirm_recovered_bar,
    });
  }
  if (name === "gauntlet_repair") {
    return runGauntletRepair(repoRoot(), args.run, {
      expectedHead: args.expected_head, packet: args.packet, tier: args.tier, profile: args.profile, provider: args.provider,
    });
  }
  if (name === "gauntlet_cancel") return runGauntletCancel(repoRoot(), args.run, { reason: args.reason, confirm: args.confirm === true });
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
  throw new Error(`unknown tool "${name}"`);
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
    return out({ jsonrpc: "2.0", id, result: { tools: [...TOOLS, ...BACKLOG_TOOLS, ...LINEAR_TOOLS, ...CLOUD_TOOLS, ...GAUNTLET_TOOLS, ...PLATE_TOOLS, ...JOURNAL_TOOLS, ...ESTIMATE_TOOLS] } });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    // Promise-wrapped so async tools (linear_sync) work; sync tools resolve immediately.
    return Promise.resolve().then(() => callTool(name, args)).then(
      (result) => out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } }),
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
