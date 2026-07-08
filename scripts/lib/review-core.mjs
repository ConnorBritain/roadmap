// roadmap — review brain (PURE). Diffs two graph/backlog snapshots (old = the YAML at the
// review anchor via git show, new = the working tree) into the /debrief digest: what shipped,
// what grew, what's stuck, and whether scope is outrunning shipping. No IO — scripts/review.mjs
// resolves the anchor commit and injects both parsed YAMLs.

import { flatten, isDone, HELD_STATUSES } from "./graph.mjs";
import { sprawlWarnings, captureRatio } from "./sync-core.mjs";

const HELD = new Set(HELD_STATUSES);

// Sprints keyed by invoke (the stable key); PIs by id. A sprint added AND completed inside
// the window appears in both addedSprints and completedSlices — that's honest, not a bug.
export function graphDiff(oldGraph, newGraph) {
  const oldM = flatten(oldGraph && oldGraph.pis ? oldGraph : { pis: [] });
  const newM = flatten(newGraph);
  const oldByInvoke = new Map(oldM.nodes.map((n) => [n.invoke, n]));
  const newByInvoke = new Map(newM.nodes.map((n) => [n.invoke, n]));
  const oldPis = new Set(((oldGraph && oldGraph.pis) || []).map((p) => p.id));

  const addedPis = (newGraph.pis || []).filter((p) => !oldPis.has(p.id)).map((p) => ({ id: p.id, title: p.title }));
  const addedSprints = [];
  const completedSlices = [];
  const statusFlips = [];
  const priorityChanges = [];
  const stillHeld = [];

  for (const n of newM.nodes) {
    const o = oldByInvoke.get(n.invoke);
    if (!o) {
      addedSprints.push({ invoke: n.invoke, pi: n.piId, title: n.title });
      if (isDone(n.status)) completedSlices.push({ invoke: n.invoke, pi: n.piId, title: n.title, prs: n.prs });
      continue;
    }
    if (!isDone(o.status) && isDone(n.status)) {
      completedSlices.push({ invoke: n.invoke, pi: n.piId, title: n.title, prs: n.prs });
    } else if (o.status !== n.status) {
      statusFlips.push({ invoke: n.invoke, from: o.status, to: n.status });
    }
    const ot = (o.priority && o.priority.tier) || null;
    const nt = (n.priority && n.priority.tier) || null;
    if (ot !== nt) priorityChanges.push({ invoke: n.invoke, from: ot, to: nt });
    if (HELD.has(o.status) && HELD.has(n.status)) stillHeld.push({ invoke: n.invoke, status: n.status });
  }
  const removedSprints = oldM.nodes.filter((o) => !newByInvoke.has(o.invoke))
    .map((o) => ({ invoke: o.invoke, pi: o.piId, title: o.title }));

  return { addedPis, addedSprints, completedSlices, removedSprints, statusFlips, priorityChanges, stillHeld };
}

// Either snapshot may be null (no backlog.yaml then/now).
export function backlogDiff(oldB, newB) {
  const oldItems = new Map((((oldB && oldB.items) || [])).map((i) => [i.id, i]));
  const captured = [];
  const closed = [];
  const promoted = [];
  for (const i of (newB && newB.items) || []) {
    const o = oldItems.get(i.id);
    if (!o) { captured.push({ id: i.id, title: i.title, kind: i.kind }); continue; }
    const wasOpen = o.status === "open" || o.status === "in_progress";
    if (wasOpen && (i.status === "done" || i.status === "dropped")) closed.push({ id: i.id, title: i.title, status: i.status });
    if (o.status !== "promoted" && i.status === "promoted") promoted.push({ id: i.id, promoted_to: i.promoted_to || null });
  }
  return { captured, closed, promoted };
}

// Fragmentation: PIs with work both started (done/active sprint) AND still open — the count
// of half-open PIs the coherence scheduler exists to shrink.
export function pisInFlight(graph) {
  let count = 0;
  for (const pi of graph.pis || []) {
    const sprints = pi.sprints || [];
    const started = sprints.some((s) => isDone(s.status) || s.status === "active");
    const open = sprints.some((s) => !isDone(s.status));
    if (started && open) count += 1;
  }
  return count;
}

// The /debrief evidence base. The sprawl lines come from the SAME function /sync uses —
// the two guardrails can never disagree.
export function reviewDigest({ gd, bd, graph }) {
  const added = bd.captured.length + gd.addedSprints.length;
  const completed = gd.completedSlices.length;
  return {
    shipped: gd.completedSlices,
    captured: { items: bd.captured, sprints: gd.addedSprints },
    closedItems: bd.closed,
    promoted: bd.promoted,
    netGrowth: { added, completed, ratio: Math.round((added / Math.max(completed, 1)) * 10) / 10 },
    sprawl: sprawlWarnings({
      completed,
      captured: bd.captured.length,
      addedSprints: gd.addedSprints.length,
      addedPis: gd.addedPis.map((p) => p.id),
      ratioThreshold: captureRatio(graph.meta),
    }),
    aging: gd.stillHeld,
    newPis: gd.addedPis,
    removed: gd.removedSprints,
    pisInFlight: pisInFlight(graph),
    priorityChanges: gd.priorityChanges,
    statusFlips: gd.statusFlips,
  };
}
