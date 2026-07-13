// roadmap — pure plan builder: roadmap graph -> the execution plan object.
// No IO: flattens, recommends a cap, computes the waves, and returns the structured plan
// (cap, recommended, binding, sys, candidates, waves[], held). scheduler.mjs prints it;
// the MCP read tools (plan / ready_wave) return it as JSON. computeWaves may throw on a
// dependency cycle; callers catch.

import { flatten, computeWaves, readyNodes, coherenceEnabled, isDone } from "./graph.mjs";
import { recommendConcurrency, nodeWeight, probeDisk, probeReviewDebt } from "./recommend.mjs";
import { branchFor, worktreeFor, launchPrompt } from "./brief.mjs";
import { normalizeExecution, suggestedConcurrency } from "./execution.mjs";

const round = (x) => Math.round(x * 10) / 10;

// buildPlan(graph, { cap, useFree, reviewCeiling, reviewDebt, today, disk }). cap omitted -> the
// recommended cap. disk/reviewDebt: undefined -> probe the real surfaces; value -> injected (tests).
export function buildPlan(graph, opts = {}) {
  const model = flatten(graph);
  const ready = readyNodes(model);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const rec = recommendConcurrency(ready, graph, {
    useFree: opts.useFree,
    reviewCeiling: opts.reviewCeiling ?? 5,
    reviewDebt: opts.reviewDebt !== undefined ? opts.reviewDebt : probeReviewDebt(process.cwd(), graph),
    today,
    disk: opts.disk !== undefined ? opts.disk : probeDisk(graph),
  });
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

  return {
    cap,
    recommended: rec.recommended,
    binding: rec.binding,
    sys: { cores: rec.sys.cores, totalGb: round(rec.sys.totalGb), freeGb: round(rec.sys.freeGb), platform: rec.sys.platform },
    disk: rec.disk ? { perWorktreeGb: round(rec.disk.perWorktreeGb), freeGb: round(rec.disk.freeGb), cap: rec.disk.cap } : null,
    candidates: rec.candidates,
    waveCloses,
    waves: waves.map((w) =>
      w.map((n) => ({
        invoke: n.invoke,
        pi: n.piId,
        sprint: n.id,
        status: n.status,
        ...(n.dispatchTier ? { dispatch_tier: n.dispatchTier } : {}),
        weight: nodeWeight(n, graph),
        est_sessions: n.estSessions,
        branch: branchFor(n, graph),
        worktree: worktreeFor(n, graph),
        prompt: launchPrompt(n),
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
