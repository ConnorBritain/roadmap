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
import { mutateRoadmap, mutateBacklog, loadBacklog, roadmapPaths } from "./lib/store.mjs";
import { TOOLS, READ_HANDLERS, MUTATION_HANDLERS } from "./lib/mcp-core.mjs";
import { BACKLOG_TOOLS, BACKLOG_READ_HANDLERS, BACKLOG_MUTATION_HANDLERS } from "./lib/backlog-core.mjs";

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
    return out({ jsonrpc: "2.0", id, result: { tools: [...TOOLS, ...BACKLOG_TOOLS] } });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = callTool(name, args);
      return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      // MCP convention: tool failures come back as a result with isError, so the model sees why.
      return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
    }
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
