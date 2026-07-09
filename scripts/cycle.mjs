#!/usr/bin/env node
// roadmap cycle — the weekly election surface.
//   roadmap cycle plan [--capacity N] [--json]     zero-network: graph + sync cursor (stale set)
//   roadmap cycle lock --promote a,b [--demote x,y] one atomic validated write (scheduled↔next)
// The interview lives in the /cycle skill; this owns the data and the write. Statuses are the
// bookkeeping: promote = scheduled→next (committed this cycle), demote = next→scheduled. The
// Linear cycle itself follows on the next sync (cyclePlan mirrors active+next).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, flatten } from "./lib/graph.mjs";
import { roadmapPaths, mutateRoadmap } from "./lib/store.mjs";
import { normalizeLinearConfig } from "./lib/linear-core.mjs";
import { electionPlan } from "./lib/cycle-core.mjs";
import { bulkSet } from "./lib/mcp-core.mjs";
import { readCursor } from "./linear.mjs";

export function runCyclePlan(root, opts = {}) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const cfg = normalizeLinearConfig(graph.meta || {});
  const capacity = opts.capacity || (cfg && cfg.cycle_capacity) || 10;
  const cursor = readCursor(root);
  return electionPlan(graph, { capacity, staleInvokes: (cursor && cursor.stale) || [] });
}

// One atomic validated write via bulkSet — all promotions/demotions land together or not at
// all. Pre-checks give the human a clear refusal instead of a store validation error.
export function runCycleLock(root, { promote = [], demote = [] } = {}) {
  if (!promote.length && !demote.length) throw new Error("cycle lock needs --promote and/or --demote invoke keys");
  const graph = loadGraph(roadmapPaths(root).yaml);
  const statusOf = new Map(flatten(graph).nodes.map((n) => [n.invoke, n.status]));
  for (const k of promote) {
    const s = statusOf.get(k);
    if (s == null) throw new Error(`no slice "${k}"`);
    if (s !== "scheduled" && s !== "optionality") throw new Error(`can't promote "${k}" (status ${s}) — the election promotes scheduled/optionality to next`);
  }
  for (const k of demote) {
    const s = statusOf.get(k);
    if (s == null) throw new Error(`no slice "${k}"`);
    if (s !== "next") throw new Error(`can't demote "${k}" (status ${s}) — only next (committed, unstarted) demotes back to scheduled`);
  }
  const updates = [
    ...promote.map((invoke) => ({ invoke, fields: { status: "next" } })),
    ...demote.map((invoke) => ({ invoke, fields: { status: "scheduled" } })),
  ];
  mutateRoadmap(root, (doc) => bulkSet(doc, { updates }));
  return { promoted: promote, demoted: demote };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const sub = args[0];
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const list = (n) => (val(n) ? val(n).split(",").map((s) => s.trim()).filter(Boolean) : []);
  const root = process.cwd();
  try {
    if (sub === "plan" || sub == null) {
      const p = runCyclePlan(root, { capacity: val("--capacity") ? Number(val("--capacity")) : undefined });
      if (args.includes("--json")) { console.log(JSON.stringify(p, null, 2)); process.exit(0); }
      const line = (x) => `  ${x.stale ? "⚠ STALE " : ""}${x.invoke} (${x.status}${x.est != null ? ` · ${x.est}s` : " · unestimated"}${x.priority && x.priority.tier ? ` · ${x.priority.tier}` : ""}) — ${x.title}`;
      const staleElected = p.elected.filter((x) => x.stale);
      if (staleElected.length) {
        console.log(`STALE — review these FIRST (journal silence past stale_days):`);
        for (const x of staleElected) console.log(line(x));
      }
      console.log(`committed (${p.elected.length}, ${p.elected.reduce((s, x) => s + (x.est || 0), 0)}s of ${p.capacity}s capacity):`);
      for (const x of p.elected) console.log(line(x));
      console.log(`fits on top (greedy prefix, priority order):`);
      for (const x of p.packed) console.log(line(x));
      if (!p.packed.length) console.log(`  (nothing — capacity full or no estimated ready candidates)`);
      if (p.overflow.length) console.log(`over capacity (ready, estimated, doesn't fit): ${p.overflow.map((x) => x.invoke).join(", ")}`);
      if (p.unestimated.length) console.log(`unestimated (never auto-packed — price or pass): ${p.unestimated.map((x) => x.invoke).join(", ")}`);
      console.log(`lock with: roadmap cycle lock --promote <a,b,...> [--demote <x,y,...>]  · then 'roadmap linear sync' projects the cycle`);
    } else if (sub === "lock") {
      const r = runCycleLock(root, { promote: list("--promote"), demote: list("--demote") });
      console.log(`locked: promoted ${r.promoted.length ? r.promoted.join(", ") : "none"} → next${r.demoted.length ? ` · demoted ${r.demoted.join(", ")} → scheduled` : ""}.`);
      console.log(`run 'roadmap linear sync' to project the cycle (active+next join the active Linear cycle).`);
    } else {
      console.error(`usage: roadmap cycle plan [--capacity N] [--json] | roadmap cycle lock --promote a,b [--demote x,y]`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
