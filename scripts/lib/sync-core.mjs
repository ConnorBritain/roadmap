// roadmap — reconcile brain (PURE). Detects slices whose work has merged but whose roadmap
// status still says open, so the SessionStart hook and the PR monitor can nudge the agent to
// reconcile (mark complete + record the PR, then re-render). No IO: the caller supplies the
// merged-PR list (from gh); this just matches it against the graph by fanout branch.

import { flatten, isDone } from "./graph.mjs";
import { branchFor } from "./brief.mjs";
import { normalizeExecution, dirClusters } from "./execution.mjs";

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

// Post-run guardrail (the under-parallelization warning surfaced in /sync). `runStats` is the
// observed run telemetry/log: [{ invoke, workers }] (the LIVE worker count a slice actually ran with).
// Flags any slice that declares a `min_concurrency` floor, touches ≥2 disjoint dir clusters (so it
// COULD have parallelized), and ran with fewer live workers than its floor. Returns warning strings.
export function underParallelizedWarnings(graph, runStats) {
  const model = flatten(graph);
  const byInvoke = new Map(model.nodes.map((n) => [n.invoke, n]));
  const out = [];
  for (const r of runStats || []) {
    if (!r || r.workers == null || !Number.isFinite(r.workers)) continue;
    const n = byInvoke.get(r.invoke);
    if (!n || !n.execution) continue;
    const exec = normalizeExecution(n.execution);
    if (!exec || exec.minConcurrency == null) continue;
    const disjoint = dirClusters([...(n.touches || []), ...(n.owns || [])]).size >= 2;
    if (disjoint && r.workers < exec.minConcurrency) {
      out.push(`slice ${r.invoke} ran ${r.workers} worker${r.workers === 1 ? "" : "s"}; min_concurrency ${exec.minConcurrency} — under-parallelized`);
    }
  }
  return out;
}

// Scope-discipline knob: max (captured items + added sprints) per completed slice per review
// window before the sprawl warning fires. The knob is meta.discipline.capture_ratio.
export const captureRatio = (meta) => (meta && meta.discipline && meta.discipline.capture_ratio) ?? 2;

// Post-run scope guardrail (the sprawl warning surfaced in /sync and /debrief). Counts are
// window-relative: what completed vs what was captured/added since the last review anchor.
// PIs are ALWAYS flagged regardless of ratio — a PI is strategic scope and should never
// appear from a worker session without a human decision.
export function sprawlWarnings({ completed = 0, captured = 0, addedSprints = 0, addedPis = [], ratioThreshold = 2 } = {}) {
  const out = [];
  const grown = captured + addedSprints;
  const ratio = grown / Math.max(completed, 1);
  if (grown > 0 && ratio > ratioThreshold) {
    out.push(`sprawl: ${grown} captured (${captured} item(s) + ${addedSprints} sprint(s)) vs ${completed} completed since the last review — ratio ${ratio.toFixed(1)} exceeds capture_ratio ${ratioThreshold}; scope is growing faster than it ships. Triage before adding more.`);
  }
  for (const pi of addedPis || []) {
    out.push(`sprawl: PI "${pi}" added since the last review — new PIs are strategic scope; confirm this was a human decision, not an agent capture.`);
  }
  return out;
}

// One-line, actionable nudge for the agent. Empty string when nothing is unrecorded (stay quiet).
export function reconcileNudge(unrecorded) {
  if (!unrecorded || !unrecorded.length) return "";
  const items = unrecorded.map((u) => `${u.invoke} (PR #${u.pr})`).join(", ");
  return `${unrecorded.length} slice(s) have a merged PR but are still open: ${items}. `
    + `Reconcile the roadmap: run /sync, or call the roadmap set_status tool for each `
    + `(status=complete, record the PR). It re-renders SLICES.md.`;
}
