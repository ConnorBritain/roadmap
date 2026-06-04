#!/usr/bin/env node
// slice-roadmap — wave scheduler CLI (print-only; spawns nothing).
// Computes the recommended concurrency cap from a resource+purpose eval, then the
// execution waves under that cap, and prints the plan (or emits it as JSON for an adapter).
//
// Usage:
//   node scheduler.mjs [--in docs/roadmap/roadmap.yaml] [--cap N] [--json]
//                      [--use-free-ram] [--review-ceiling N] [--wave N]
//   --cap N         override the recommended cap
//   --json          emit the plan as JSON (consumed by fanout.mjs / adapters)
//   --use-free-ram  size RAM off currently-free memory instead of 75% of total
//   --wave N        when printing, expand the launch commands for wave N (default 1)

import { loadGraph, flatten, computeWaves, readyNodes } from "./lib/graph.mjs";
import { recommendConcurrency, nodeWeight } from "./lib/recommend.mjs";
import { branchFor, worktreeFor, launchPrompt, baseRefOf, remoteOf } from "./lib/brief.mjs";

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const inPath = val("--in", "docs/roadmap/roadmap.yaml");
const asJson = has("--json");
const useFree = has("--use-free-ram");
const reviewCeiling = Number(val("--review-ceiling", 5));
const detailWave = Number(val("--wave", 1));

const graph = loadGraph(inPath);
const model = flatten(graph);
const ready = readyNodes(model);
const rec = recommendConcurrency(ready, graph, { useFree, reviewCeiling });
const cap = args.includes("--cap") ? Number(val("--cap", rec.recommended)) : rec.recommended;

let waves, held;
try {
  ({ waves, held } = computeWaves(model, cap));
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

const plan = {
  cap,
  recommended: rec.recommended,
  binding: rec.binding,
  sys: { cores: rec.sys.cores, totalGb: round(rec.sys.totalGb), freeGb: round(rec.sys.freeGb), platform: rec.sys.platform },
  candidates: rec.candidates,
  waves: waves.map((w, i) =>
    w.map((n) => ({
      invoke: n.invoke,
      pi: n.piId,
      sprint: n.id,
      weight: nodeWeight(n, graph),
      est_sessions: n.estSessions,
      branch: branchFor(n, graph),
      worktree: worktreeFor(n, graph),
      prompt: launchPrompt(n),
      what: n.what,
    }))
  ),
  held: {
    onHuman: held.onHuman.map((n) => ({ invoke: n.invoke, gatedOn: n.gatedOn, what: n.what })),
    blocked: held.blocked.map((n) => ({ invoke: n.invoke, what: n.what })),
  },
};

if (asJson) {
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  process.exit(0);
}

// ── human plan ─────────────────────────────────────────────────────────────
const capNote = args.includes("--cap") ? `(you set --cap ${cap}; recommended ${rec.recommended})` : `(recommended)`;
console.log(`Concurrency cap: ${cap} ${capNote}`);
console.log(`  bound by: ${rec.binding.why}`);
console.log(`  machine:  ${rec.sys.cores} cores, ${round(rec.sys.totalGb)}GB total / ${round(rec.sys.freeGb)}GB free (${rec.sys.platform})`);
console.log(`  ceilings: ${rec.candidates.map((c) => `${c.n} [${c.why.split(" — ")[0]}]`).join("  ·  ")}`);
console.log("");
if (!waves.length) console.log("No agent-runnable slices right now.");
waves.forEach((w, i) => {
  const marker = i + 1 === detailWave ? " ◀ detail" : "";
  console.log(`Wave ${i + 1}${marker} — ${w.length} concurrent:`);
  for (const n of w) console.log(`  • ${n.invoke}  (${nodeWeight(n, graph)}, ~${n.estSessions ?? "?"} sess)  — ${n.what}`);
});
if (held.onHuman.length) {
  console.log(`\nHeld on a human:`);
  for (const n of held.onHuman) console.log(`  • ${n.invoke} — gated on ${n.gatedOn}`);
}

// Expand launch commands for the detail wave (print-only — copy/paste or feed to fanout).
const dw = waves[detailWave - 1];
if (dw && dw.length) {
  console.log(`\n--- Wave ${detailWave} launch (illustrative) — 'roadmap fan --wave ${detailWave}' does this AND writes each worktree's .kickoff.md (which the session reads) ---`);
  console.log(`git fetch ${remoteOf(graph)} --quiet`);
  for (const n of dw) {
    console.log(`git worktree add "${worktreeFor(n, graph)}" -b "${branchFor(n, graph)}" ${baseRefOf(graph)}`);
    console.log(`(cd "${worktreeFor(n, graph)}" && claude "${launchPrompt(n)}")   # ${n.invoke}`);
  }
}

function round(x) { return Math.round(x * 10) / 10; }
