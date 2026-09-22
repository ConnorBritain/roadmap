// roadmap — scope-discipline brain (PURE, core). The sprawl guardrail surfaced in /sync, /debrief
// and the review digest. The PR-matching half of the old sync-core (findUnrecordedMerges,
// underParallelizedWarnings, reconcileNudge) is engineering-executor logic and lives in
// reconcile-core.mjs (exec-engineering); importers pick the half they need.

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
