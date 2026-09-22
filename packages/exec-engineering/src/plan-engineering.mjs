// roadmap — the engineering executor's contribution to buildPlan (docs/ARCHITECTURE.md § Executor):
//   capacity → the five real ceilings (CPU / RAM / independent work / review debt / free disk)
//   annotate → per-node branch / worktree / kickoff prompt / resource weight
// Wired by scheduler.mjs and mcp.mjs; injected into tests. Nothing here is imported by core.

import { recommendConcurrency, nodeWeight, probeDisk, probeReviewDebt } from "./recommend.mjs";
import { branchFor, worktreeFor, launchPrompt } from "./brief.mjs";

// engineeringPlanContext({ disk, reviewDebt, cwd }): disk/reviewDebt undefined -> probe the real
// surfaces at plan time; a value -> injected (tests). Returns the { capacity, annotate } pair.
export function engineeringPlanContext({ disk, reviewDebt, cwd = process.cwd() } = {}) {
  return {
    capacity: (ready, graph, { useFree, reviewCeiling, today } = {}) => recommendConcurrency(ready, graph, {
      useFree,
      reviewCeiling: reviewCeiling ?? 5,
      reviewDebt: reviewDebt !== undefined ? reviewDebt : probeReviewDebt(cwd, graph),
      today,
      disk: disk !== undefined ? disk : probeDisk(graph),
    }),
    annotate: (n, graph) => ({
      weight: nodeWeight(n, graph),
      branch: branchFor(n, graph),
      worktree: worktreeFor(n, graph),
      prompt: launchPrompt(n),
    }),
  };
}
