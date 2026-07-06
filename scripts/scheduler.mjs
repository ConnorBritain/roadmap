#!/usr/bin/env node
// roadmap — wave scheduler CLI (print-only; spawns nothing).
// Builds the execution plan via lib/plan.mjs (recommended cap + waves) and prints it,
// or emits it as JSON (consumed by fanout.mjs / adapters / the MCP read tools).
//
// Usage:
//   node scheduler.mjs [--in docs/roadmap/roadmap.yaml] [--cap N] [--json]
//                      [--use-free-ram] [--review-ceiling N] [--wave N]
//   --cap N         override the recommended cap
//   --json          emit the plan as JSON
//   --use-free-ram  size RAM off currently-free memory instead of 75% of total
//   --wave N        when printing, mark the launch detail for wave N (default 1)

import { loadGraph } from "./lib/graph.mjs";
import { buildPlan } from "./lib/plan.mjs";
import { baseRefOf, remoteOf } from "./lib/brief.mjs";

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

const hasCap = has("--cap");
const capVal = hasCap ? Number(val("--cap", "")) : null;

const graph = loadGraph(inPath);

let plan;
try {
  plan = buildPlan(graph, { cap: hasCap && Number.isFinite(capVal) ? capVal : undefined, useFree, reviewCeiling });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

if (asJson) {
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  process.exit(0);
}

// ── human plan ─────────────────────────────────────────────────────────────
const capNote = hasCap ? `(you set --cap ${plan.cap}; recommended ${plan.recommended})` : `(recommended)`;
console.log(`Concurrency cap: ${plan.cap} ${capNote}`);
console.log(`  bound by: ${plan.binding.why}`);
console.log(`  machine:  ${plan.sys.cores} cores, ${plan.sys.totalGb}GB total / ${plan.sys.freeGb}GB free (${plan.sys.platform})`);
console.log(`  ceilings: ${plan.candidates.map((c) => `${c.n} [${c.why.split(" — ")[0]}]`).join("  ·  ")}`);
console.log("");
if (!plan.waves.length) console.log("No agent-runnable slices right now.");
plan.waves.forEach((w, i) => {
  const marker = i + 1 === detailWave ? " ◀ detail" : "";
  console.log(`Wave ${i + 1}${marker} — ${w.length} concurrent:`);
  for (const n of w) console.log(`  • ${n.invoke}  (${n.weight}, ~${n.est_sessions ?? "?"} sess)  — ${n.what}`);
});
if (plan.held.onHuman.length) {
  console.log(`\nHeld on a human:`);
  for (const n of plan.held.onHuman) console.log(`  • ${n.invoke} — gated on ${n.gatedOn}`);
}

// Expand launch commands for the detail wave (print-only — copy/paste or feed to fanout).
const dw = plan.waves[detailWave - 1];
if (dw && dw.length) {
  console.log(`\n--- Wave ${detailWave} launch (illustrative) — 'roadmap fan --wave ${detailWave}' does this AND writes each worktree's .kickoff.md (which the session reads) ---`);
  console.log(`git fetch ${remoteOf(graph)} --quiet`);
  for (const n of dw) {
    console.log(`git worktree add "${n.worktree}" -b "${n.branch}" ${baseRefOf(graph)}`);
    console.log(`(cd "${n.worktree}" && claude "${n.prompt}")   # ${n.invoke}`);
  }
}
