#!/usr/bin/env node
// SessionStart hook: if the repo at cwd has docs/roadmap/roadmap.yaml, inject the current
// ready wave as context. Degrades SILENTLY (emits nothing) when there's no roadmap or deps
// are missing — it must never break or slow a session in a non-roadmap repo.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";

// Merged PRs via gh, for reconcile detection. Guarded + short-timeout: if gh is missing, unauthed,
// or slow, return [] so the hook stays fast and silent. Never throws.
function mergedPrs(root) {
  try {
    const r = spawnSync("gh", ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,headRefName"],
      { cwd: root, encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return [];
    return JSON.parse(r.stdout);
  } catch { return []; }
}

function emit(ctx) {
  if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }));
  process.exit(0);
}

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
const start = resolve(input.cwd || process.cwd());

// Walk up to the repo's roadmap.
let root = null;
for (let dir = start; ;) {
  if (existsSync(join(dir, "docs", "roadmap", "roadmap.yaml"))) { root = dir; break; }
  const up = dirname(dir);
  if (up === dir) break;
  dir = up;
}
if (!root) emit("");   // no roadmap here — stay silent

try {
  const graph = await import(new URL("../scripts/lib/graph.mjs", import.meta.url));
  const g = graph.loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  const model = graph.flatten(g);
  const cap = (g.meta && g.meta.default_concurrency) || 3;
  const { waves, held } = graph.computeWaves(model, cap);
  const ready = (waves[0] || []).map((n) => n.invoke);
  const onHuman = held.onHuman.map((n) => n.invoke);

  // Reconcile detection: slices whose fanout branch has a merged PR but are still open.
  // Deterministic detection here; the agent does the judgment + the status flip (agentic sync).
  let nudge = "";
  try {
    const sync = await import(new URL("../scripts/lib/sync-core.mjs", import.meta.url));
    nudge = sync.reconcileNudge(sync.findUnrecordedMerges(g, mergedPrs(root)));
  } catch { /* gh or sync-core unavailable — skip the nudge */ }

  if (!ready.length && !onHuman.length && !nudge) emit("");

  let ctx = `slice-roadmap (${(g.pis || []).length} PIs): ready now (cap ${cap}) — ${ready.join(", ") || "none"}.`;
  if (onHuman.length) ctx += ` Held on a human: ${onHuman.join(", ")}.`;
  if (nudge) ctx += ` ⟳ ${nudge}`;
  ctx += ` Use /slice <name> to orient, /slice-fanout to launch a wave, or 'roadmap plan' for the full wave map.`;
  emit(ctx);
} catch {
  emit("");   // missing deps / parse error → silent; never break the session
}
