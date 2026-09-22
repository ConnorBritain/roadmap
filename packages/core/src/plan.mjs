// roadmap — pure plan builder: roadmap graph -> the execution plan object.
// No IO: flattens, asks the EXECUTOR for a cap recommendation, computes the waves, and returns the
// structured plan (cap, recommended, binding, sys, candidates, waves[], held). scheduler.mjs prints
// it; the MCP read tools (plan / ready_wave) return it as JSON. computeWaves may throw on a
// dependency cycle; callers catch.
//
// Core knows nothing about CPUs, disks, branches or worktrees. Two hooks carry that knowledge:
//   opts.capacity(ready, graph, { useFree, reviewCeiling, today })
//     -> { recommended, binding, sys?, disk?, candidates? }   (engineering: recommendConcurrency)
//   opts.annotate(node, graph) -> extra per-node plan fields   (engineering: branch/worktree/prompt/weight)
// Absent, the plan falls back to meta.default_concurrency with no machine probes — the shape a
// general-profile executor gets by default.

import { flatten, computeWaves, readyNodes, coherenceEnabled, isDone } from "./graph.mjs";
import { normalizeExecution, suggestedConcurrency } from "./execution.mjs";

const round = (x) => Math.round(x * 10) / 10;

export function defaultCapacity(ready, graph) {
  const recommended = Math.max(1, Number((graph.meta && graph.meta.default_concurrency) || 3));
  return { recommended, binding: { n: recommended, why: "default_concurrency — no executor capacity probe" }, sys: {}, disk: null,
    candidates: [{ n: recommended, why: "default_concurrency — meta.default_concurrency (or 3)" }] };
}

// buildPlan(graph, { cap, useFree, reviewCeiling, today, capacity, annotate }). cap omitted -> the
// recommended cap.
export function buildPlan(graph, opts = {}) {
  const model = flatten(graph);
  const ready = readyNodes(model);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const capacity = opts.capacity || defaultCapacity;
  const annotate = opts.annotate || (() => ({}));
  const rec = capacity(ready, graph, { useFree: opts.useFree, reviewCeiling: opts.reviewCeiling ?? 5, today });
  const cap = opts.cap != null ? Number(opts.cap) : rec.recommended;
  // Command-lane float: pass meta + today so an active lane's member slices sort first in the wave
  // (see computeWaves). Inactive/absent lane → byte-identical to the pre-lane order.
  const { waves, held } = computeWaves(model, cap, { coherence: coherenceEnabled(graph.meta), meta: graph.meta, today });

  // Which PIs each wave CLOSES (all sprints done once the wave lands, counting earlier waves
  // optimistically) — the coherence read-out: "this wave finishes auth".
  const doneKeys = new Set(model.nodes.filter((n) => isDone(n.status)).map((n) => n.nodeKey));
  const waveCloses = waves.map((w) => {
    w.forEach((n) => doneKeys.add(n.nodeKey));
    return [...new Set(w.map((n) => n.piId))].filter((pi) =>
      model.nodes.filter((m) => m.piId === pi).every((m) => doneKeys.has(m.nodeKey)));
  });

  const sys = rec.sys || {};
  return {
    cap,
    recommended: rec.recommended,
    binding: rec.binding,
    sys: { cores: sys.cores, totalGb: sys.totalGb != null ? round(sys.totalGb) : undefined, freeGb: sys.freeGb != null ? round(sys.freeGb) : undefined, platform: sys.platform },
    disk: rec.disk ? { perWorktreeGb: round(rec.disk.perWorktreeGb), freeGb: round(rec.disk.freeGb), cap: rec.disk.cap } : null,
    candidates: rec.candidates || [],
    waveCloses,
    waves: waves.map((w) =>
      w.map((n) => ({
        invoke: n.invoke,
        pi: n.piId,
        sprint: n.id,
        status: n.status,
        ...(n.dispatchTier ? { dispatch_tier: n.dispatchTier } : {}),
        ...annotate(n, graph),
        est_sessions: n.estSessions,
        what: n.what,
        track: n.track,
        priority: n.priority,
        execution: normalizeExecution(n.execution),
        suggestedConcurrency: suggestedConcurrency(n),
      }))
    ),
    held: {
      onHuman: held.onHuman.map((n) => ({ invoke: n.invoke, gatedOn: n.gatedOn, what: n.what })),
      blocked: held.blocked.map((n) => ({ invoke: n.invoke, what: n.what })),
    },
  };
}
