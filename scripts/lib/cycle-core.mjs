// roadmap — cycle election brain (PURE). The weekly lock: what's committed (active/next),
// what's electable (ready scheduled work), what fits the capacity, and what's out of the
// cycle (the dispatch guard's question). No IO — cycle.mjs (CLI) and dispatch.mjs consume
// this; linear-core.mjs owns CYCLE_STATUSES (the committed set IS the cycle's semantic).

import { flatten, readyNodes, isDone } from "./graph.mjs";
import { comparePriority } from "./priority.mjs";
import { CYCLE_STATUSES } from "./linear-core.mjs";

// The dispatch/fan lock: with cycles on, work outside the committed set doesn't launch
// without an explicit override. Null/absent cfg or cycles off → never locks (opt-in).
export function outOfCycle(cfg, status) {
  return !!cfg && cfg.cycles === "on" && !CYCLE_STATUSES.includes(status);
}

const summarize = (stale) => (n) => ({
  invoke: n.invoke, title: n.title, status: n.status, pi: n.piId,
  est: typeof n.estSessions === "number" ? n.estSessions : null,
  priority: n.priority || null,
  stale: stale.has(n.invoke),
});

// The election picture. elected = the current committed set (active/next) with the stale set
// marked — the ritual reviews those FIRST. candidates = ready (deps satisfied, not held)
// scheduled slices, priority-sorted then smallest-first; optionality is hand-promotable, never
// auto-proposed. packed = the greedy candidate PREFIX that fits capacity on top of what's
// already committed — priority order is honored strictly (no skip-ahead knapsack: a big P0
// blocking the prefix is a signal to split it, not to sneak P2s past it). Slices with no
// est_sessions are never silently packed (the honesty gate, mirroring the timeline rollup's
// unpriced rule) — they land in `unestimated` for the human to price or pass on.
export function electionPlan(graph, { capacity = 10, staleInvokes = [] } = {}) {
  const model = flatten(graph);
  const stale = new Set(staleInvokes);
  const brief = summarize(stale);

  const elected = model.nodes.filter((n) => !isDone(n.status) && CYCLE_STATUSES.includes(n.status)).map(brief);
  // Elected-but-unpriced work can't hide from the capacity math as a silent zero — it's
  // surfaced beside the candidate-side honesty gate so the ritual prices it or calls it out.
  const unpricedElected = elected.filter((x) => x.est == null);
  let used = elected.reduce((s, x) => s + (x.est || 0), 0);

  const candidates = readyNodes(model)
    .filter((n) => n.status === "scheduled")
    .sort((a, b) => comparePriority(a.priority, b.priority) || (a.estSessions ?? Infinity) - (b.estSessions ?? Infinity))
    .map(brief);
  const unestimated = candidates.filter((c) => c.est == null);
  const estimable = candidates.filter((c) => c.est != null);

  const packed = [];
  for (const c of estimable) {
    if (used + c.est > capacity) break;
    packed.push(c);
    used += c.est;
  }
  const overflow = estimable.slice(packed.length);

  return { elected, unpricedElected, candidates, packed, overflow, unestimated, capacity, estUsed: used };
}
