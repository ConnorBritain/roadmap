// roadmap cycle — the weekly election surface.
//   roadmap cycle plan [--capacity N] [--json]     zero-network: graph + sync cursor (stale set)
//   roadmap cycle lock --promote a,b [--demote x,y] one atomic validated write (scheduled↔next)
// The interview lives in the /cycle skill; this owns the data and the write. Statuses are the
// bookkeeping: promote = scheduled→next (committed this cycle), demote = next→scheduled. The
// Linear cycle itself follows on the next sync (cyclePlan mirrors active+next).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, flatten } from "./graph.mjs";
import { roadmapPaths, mutateRoadmap } from "./store.mjs";
import { normalizeLinearConfig } from "./linear-core.mjs";
import { electionPlan } from "./cycle-core.mjs";
import { bulkSet } from "./mcp-core.mjs";
import { readCursor } from "./linear-io.mjs";

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

