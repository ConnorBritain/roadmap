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
import { mutateRoadmap, mutateBacklog, mutateBoth, loadBacklog, roadmapPaths } from "./lib/store.mjs";
import { TOOLS, READ_HANDLERS, MUTATION_HANDLERS } from "./lib/mcp-core.mjs";
import { BACKLOG_TOOLS, BACKLOG_READ_HANDLERS, BACKLOG_MUTATION_HANDLERS, performPromotion } from "./lib/backlog-core.mjs";
import { linearState } from "./lib/linear-core.mjs";
import { runSync } from "./linear.mjs";

// Always registered; politely erroring when unconfigured beats config-gated registration
// (tools/list would need IO). linear_sync reuses linear.mjs's runSync — one sync implementation.
const LINEAR_TOOLS = [
  { name: "linear_status", description: "Linear integration state for this roadmap (configured / authed / last sync). Zero network. Read-only.",
    inputSchema: { type: "object", properties: {} } },
  { name: "linear_sync", description: "Run the Linear sync: push the roadmap/backlog projection, fetch the pull inbox. dry=true plans without writing. With meta.linear.pull=propose the inbox is returned as proposals for you to apply via backlog_add/set_status/backlog_set.",
    inputSchema: { type: "object", properties: { dry: { type: "boolean" }, push: { type: "boolean" }, pull: { type: "boolean" } } } },
];

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "graph", version: "0.2.0" };

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
    return mutateBacklog(repoRoot(), (doc) => BACKLOG_MUTATION_HANDLERS[name](doc, args || {}),
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
      ...(st.configured ? {} : { note: "not configured — add meta.linear or run 'roadmap linear setup --team <KEY>'" }) };
  }
  if (name === "linear_sync") {
    // async; the tools/call path awaits. runSync itself throws the setup-guidance errors.
    return runSync(repoRoot(), { dry: !!args.dry, pushOnly: args.pull === false, pullOnly: args.push === false });
  }
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
    return out({ jsonrpc: "2.0", id, result: { tools: [...TOOLS, ...BACKLOG_TOOLS, ...LINEAR_TOOLS] } });
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
