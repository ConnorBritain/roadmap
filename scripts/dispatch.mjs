#!/usr/bin/env node
// roadmap dispatch <key> [--to claude] — send a slice/backlog item to a CLOUD agent via its
// Linear issue, instead of a local worktree. The wave-scale version is `roadmap fan --cloud`.
//
// v0.5 STUB — PENDING LIVE VERIFICATION with the user's next test key. commentCreate's
// signature is verified against a live workspace; whether an @-mention actually summons the
// delegate agent is NOT, and the delegate-field mutation is NOT attempted at all. This
// command therefore does the one verified transport (an @-mention comment carrying the
// dispatch capsule) and reports exactly what it tried.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, flatten } from "./lib/graph.mjs";
import { loadBacklog, roadmapPaths } from "./lib/store.mjs";
import { runSync, postDispatchComment } from "./linear.mjs";
import { linearState, linearStatusLine, machineFooter } from "./lib/linear-core.mjs";

export const DISPATCH_AGENTS = { claude: "@Claude", codex: "@Codex", oz: "@Oz" };

export async function runDispatch(root, key, opts = {}) {
  const env = opts.env || process.env;
  const agent = DISPATCH_AGENTS[(opts.to || "claude").toLowerCase()];
  if (!agent) throw new Error(`unknown dispatch agent "${opts.to}" (${Object.keys(DISPATCH_AGENTS).join("|")})`);
  const io = { apiKey: env.LINEAR_API_KEY, fetchImpl: opts.fetchImpl || fetch };

  const find = () => {
    const graph = loadGraph(roadmapPaths(root).yaml);
    const node = flatten(graph).nodes.find((n) => n.invoke === key);
    if (node) return { type: "slice", identifier: node.linear, graph };
    const item = ((loadBacklog(root) || {}).items || []).find((i) => i.id === key);
    if (item) return { type: "backlog", identifier: item.linear, graph };
    return null;
  };

  let found = find();
  if (!found) throw new Error(`no slice or backlog item "${key}"`);
  const state = linearState({ meta: found.graph.meta, env });
  if (!state.configured || !state.authed) throw new Error(linearStatusLine(state));

  let pushed = false;
  if (!found.identifier) {
    await runSync(root, { pushOnly: true, env, fetchImpl: opts.fetchImpl });
    pushed = true;
    found = find();
    if (!found.identifier) {
      throw new Error(`push didn't map "${key}" to a Linear issue — check meta.linear.granularity (and per-PI overrides) covers it.`);
    }
  }

  const body = [
    `${agent} please work this issue.`,
    "",
    machineFooter({ type: found.type, key }, null),
    "",
    "Follow the repo's dispatch guidance (CLAUDE.md/AGENTS.md — 'Working a roadmap-dispatched Linear issue'). In short: the repo's docs/roadmap YAML is canonical, honor the slice's gate, open a PR and never merge, leftovers to the backlog only.",
  ].join("\n");

  try {
    await postDispatchComment(found.identifier, body, io);
  } catch (e) {
    throw new Error(`dispatch failed — tried: push-map (${pushed ? "pushed" : "already mapped"} → ${found.identifier}), commentCreate on ${found.identifier} (${e.message}). Delegate-field mutation not attempted (unverified).`);
  }
  return { dispatched: key, identifier: found.identifier, agent, pushed };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const key = args.find((a) => !a.startsWith("-"));
  if (!key) {
    console.error(`usage: roadmap dispatch <slice-invoke|backlog-id> [--to ${Object.keys(DISPATCH_AGENTS).join("|")}]`);
    process.exit(2);
  }
  try {
    const r = await runDispatch(process.cwd(), key, { to: val("--to") });
    console.log(`dispatched ${r.dispatched} → ${r.identifier} via ${r.agent} @-mention comment.`);
    console.log(`VERIFY the agent picked it up. Live-tested finding: the comment posts fine, but summoning requires the agent's`);
    console.log(`integration to be INSTALLED in the Linear workspace (Settings → Integrations — e.g. the Claude/coding-sessions`);
    console.log(`agent); without it there is nothing to summon. If installed and nothing happens, delegate by hand — the capsule`);
    console.log(`comment is already on the issue to orient the agent.`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
