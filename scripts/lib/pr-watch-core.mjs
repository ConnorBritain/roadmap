// slice-roadmap — PR-watch brain (PURE). Decides which PR changes are worth telling the lead
// about, and which branches belong to this roadmap's fanout. No IO: watch-prs.mjs polls `gh`,
// normalizes each PR, and feeds snapshots through here. The watcher stays quiet until a PR
// actually changes phase, so an always-on monitor never spams.

import { flatten } from "./graph.mjs";
import { branchFor } from "./brief.mjs";

// The single phase we'd tell the lead about. Derived from the normalized PR fields
// { state, isDraft, mergeStateStatus, checks }.
export function prPhase(pr) {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  if (pr.mergeStateStatus === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflicts";
  if (pr.checks === "failing") return "checks-failing";
  if (pr.checks === "pending") return "checks-pending";
  return "ready"; // open, not draft, no conflicts, checks passing or none
}

const PHASE_MSG = {
  merged: "merged",
  closed: "closed without merging",
  draft: "opened as a draft",
  conflicts: "has merge conflicts",
  "checks-failing": "checks failing",
  "checks-pending": "checks running",
  ready: "ready to merge",
};

// diffPrStates(prev, curr): both are { [number]: normalizedPr }. Returns one event per PR that is
// newly seen or has changed phase, each with a one-line message for the lead. Deterministic.
export function diffPrStates(prev, curr) {
  const events = [];
  for (const num of Object.keys(curr)) {
    const pr = curr[num];
    const before = prev[num];
    const phase = prPhase(pr);
    if (before && prPhase(before) === phase) continue; // unchanged
    events.push({
      number: pr.number,
      headRefName: pr.headRefName,
      title: pr.title,
      phase,
      message: `PR #${pr.number} (${pr.headRefName}) ${PHASE_MSG[phase] || phase}`,
    });
  }
  return events;
}

// The branch names this roadmap's slices fan out onto (one per node, via branchFor).
export function roadmapBranches(graph) {
  const model = flatten(graph);
  return new Set(model.nodes.map((n) => branchFor(n, graph)));
}

// Is a PR's head branch one of this roadmap's fanout branches? (So the lead only hears about
// its own wave, not every PR in the repo.)
export function matchesRoadmapBranches(headRef, graph) {
  return roadmapBranches(graph).has(headRef);
}
