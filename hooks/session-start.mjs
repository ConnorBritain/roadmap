#!/usr/bin/env node
// SessionStart hook: if the repo at cwd has docs/roadmap/roadmap.yaml, inject the current
// ready wave as context. Degrades SILENTLY (emits nothing) when there's no roadmap or deps
// are missing — it must never break or slow a session in a non-roadmap repo.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

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
  if (!ready.length && !onHuman.length) emit("");

  let ctx = `slice-roadmap (${(g.pis || []).length} PIs): ready now (cap ${cap}) — ${ready.join(", ") || "none"}.`;
  if (onHuman.length) ctx += ` Held on a human: ${onHuman.join(", ")}.`;
  ctx += ` Use /slice <name> to orient, /slice-fanout to launch a wave, or 'roadmap plan' for the full wave map.`;
  emit(ctx);
} catch {
  emit("");   // missing deps / parse error → silent; never break the session
}
