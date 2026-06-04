// slice-roadmap — reconcile brain (PURE). Detects slices whose work has merged but whose roadmap
// status still says open, so the SessionStart hook and the PR monitor can nudge the agent to
// reconcile (mark complete + record the PR, then re-render). No IO: the caller supplies the
// merged-PR list (from gh); this just matches it against the graph by fanout branch.

import { flatten, isDone } from "./graph.mjs";
import { branchFor } from "./brief.mjs";

// findUnrecordedMerges(graph, mergedPrs): mergedPrs is [{ number, headRefName }] (state=merged).
// Returns the not-done slices whose fanout branch has a merged PR: [{ invoke, pr, branch }].
export function findUnrecordedMerges(graph, mergedPrs) {
  const byBranch = new Map();
  for (const pr of mergedPrs || []) {
    if (pr && pr.headRefName && !byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr.number);
  }
  const model = flatten(graph);
  const out = [];
  for (const n of model.nodes) {
    if (isDone(n.status)) continue;
    const branch = branchFor(n, graph);
    if (byBranch.has(branch)) out.push({ invoke: n.invoke, pr: byBranch.get(branch), branch });
  }
  return out;
}

// One-line, actionable nudge for the agent. Empty string when nothing is unrecorded (stay quiet).
export function reconcileNudge(unrecorded) {
  if (!unrecorded || !unrecorded.length) return "";
  const items = unrecorded.map((u) => `${u.invoke} (PR #${u.pr})`).join(", ");
  return `${unrecorded.length} slice(s) have a merged PR but are still open: ${items}. `
    + `Reconcile the roadmap: run /slice-sync, or call the roadmap set_status tool for each `
    + `(status=complete, record the PR). It re-renders SLICES.md.`;
}
