#!/usr/bin/env node
// roadmap — wave scheduler CLI (print-only; spawns nothing).
// Builds the execution plan via packages/core/src/plan.mjs (recommended cap + waves) and prints it,
// or emits it as JSON (consumed by fanout.mjs / adapters / the MCP read tools).
//
// Usage:
//   node scheduler.mjs [--in docs/roadmap/roadmap.yaml] [--cap N] [--json]
//                      [--use-free-ram] [--review-ceiling N] [--wave N]
//   --cap N         override the recommended cap
//   --json          emit the plan as JSON
//   --use-free-ram  size RAM off currently-free memory instead of 75% of total
//   --wave N        when printing, mark the launch detail for wave N (default 1)

import { loadGraph, commandLaneActive, commandLaneMembers, isDone } from "@connorbritain/roadmap-core/graph.mjs";
import { buildPlan } from "@connorbritain/roadmap-core/plan.mjs";
import { loadProfile } from "@connorbritain/roadmap-cli/profile.mjs";
import { tierBadge } from "@connorbritain/roadmap-core/priority.mjs";
import { REL } from "@connorbritain/roadmap-core/cli-core.mjs";
import { join } from "node:path";

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const inPath = val("--in", join(...REL));
const asJson = has("--json");
const useFree = has("--use-free-ram");
const reviewCeiling = Number(val("--review-ceiling", 5));
const detailWave = Number(val("--wave", 1));

const hasCap = has("--cap");
const capVal = hasCap ? Number(val("--cap", "")) : null;

const graph = loadGraph(inPath);
const today = new Date().toISOString().slice(0, 10);   // one clock read for the whole run (plan + banner)

// Capacity + per-node annotation come from the loaded work profile's executor (engineering: the
// five machine ceilings + branch/worktree/prompt; general: core's default capacity, no annotation).
let plan, profile;
try {
  profile = await loadProfile(graph.meta, { root: process.cwd() });
  plan = buildPlan(graph, { cap: hasCap && Number.isFinite(capVal) ? capVal : undefined, useFree, reviewCeiling, today, ...profile.planContext });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

if (asJson) {
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  process.exit(0);
}

// ── human plan ─────────────────────────────────────────────────────────────
// Command-lane banner. Prints only while the lane is armed: past `until` or once every member ships,
// commandLaneActive goes false and the banner disappears. Reuses the single `today` computed above.
if (commandLaneActive(graph, today)) {
  const lane = graph.meta.command_lane;
  const members = commandLaneMembers(graph);
  let laneOpen = 0;
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) {
    if (sp.invoke && members.has(sp.invoke) && !isDone(sp.status)) laneOpen++;
  }
  console.log(`COMMAND LANE: ${lane.objective} (until ${lane.until}) — ${laneOpen} lane slice(s) sort first`);
  console.log("");
}

const capNote = hasCap ? `(you set --cap ${plan.cap}; recommended ${plan.recommended})` : `(recommended)`;
console.log(`Concurrency cap: ${plan.cap} ${capNote}`);
console.log(`  bound by: ${plan.binding.why}`);
if (plan.sys && plan.sys.cores != null) console.log(`  machine:  ${plan.sys.cores} cores, ${plan.sys.totalGb}GB total / ${plan.sys.freeGb}GB free (${plan.sys.platform})`);
console.log(`  ceilings: ${plan.candidates.map((c) => `${c.n} [${c.why.split(" — ")[0]}]`).join("  ·  ")}`);
console.log("");
if (!plan.waves.length) console.log("No agent-runnable slices right now.");
plan.waves.forEach((w, i) => {
  const marker = i + 1 === detailWave ? " ◀ detail" : "";
  const closes = (plan.waveCloses && plan.waveCloses[i]) || [];
  console.log(`Wave ${i + 1}${marker} — ${w.length} concurrent${closes.length ? ` (closes ${closes.join(", ")})` : ""}:`);
  for (const n of w) console.log(`  • ${tierBadge(n.priority) ? `[${tierBadge(n.priority)}] ` : ""}${n.invoke}  (${n.weight ?? "unweighted"}, ~${n.est_sessions ?? "?"} sess)  — ${n.what}`);
});
if (plan.held.onHuman.length) {
  console.log(`\nHeld on a human:`);
  for (const n of plan.held.onHuman) console.log(`  • ${n.invoke} — gated on ${n.gatedOn}`);
}

// Expand launch commands for the detail wave (print-only — copy/paste or feed to fanout). Only
// an executor that annotates nodes with a branch + worktree has anything to expand.
const dw = plan.waves[detailWave - 1];
if (dw && dw.length && dw.every((n) => n.worktree && n.branch)) {
  const remote = (graph.meta && graph.meta.remote) || "origin";
  const baseRef = `${remote}/${(graph.meta && graph.meta.base_branch) || "main"}`;
  console.log(`\n--- Wave ${detailWave} launch (illustrative) — 'roadmap fan --wave ${detailWave}' does this AND writes each worktree's .kickoff.md (which the session reads) ---`);
  console.log(`git fetch ${remote} --quiet`);
  for (const n of dw) {
    console.log(`git worktree add "${n.worktree}" -b "${n.branch}" ${baseRef}`);
    console.log(`(cd "${n.worktree}" && claude "${n.prompt}")   # ${n.invoke}`);
  }
}
