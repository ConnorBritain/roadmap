// roadmap — PR-watch brain (PURE). Decides which PR changes are worth telling the lead
// about, and which branches belong to this roadmap's fanout. No IO: watch-prs.mjs polls `gh`,
// normalizes each PR, and feeds snapshots through here. The watcher stays quiet until a PR
// actually changes phase, head, or Gauntlet verdict, so an always-on monitor never spams.

import { parseCriticMarker, parseGauntletRunMarker } from "./gauntlet-core.mjs";
export { roadmapBranches, matchesRoadmapBranches, belongsToRoadmapPr } from "./pr-identity.mjs";

// Reduce a PR's statusCheckRollup (raw `gh` JSON) to one of: none | passing | pending | failing.
// Pure, so the rollup-to-enum mapping that prPhase keys off is unit-testable without calling gh.
export function checksOf(pr) {
  const rollup = (pr && pr.statusCheckRollup) || [];
  if (!rollup.length) return "none";
  const states = rollup.map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "failing";
  if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED", ""].includes(s))) return "pending";
  return "passing";
}

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
  merged: "merged — reconcile the roadmap (/sync or the set_status tool)",
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
    const beforePhase = before && prPhase(before);
    const headChanged = !!before && before.headRefOid !== pr.headRefOid;
    const criticChanged = !!before && before.criticSignature !== pr.criticSignature;
    if (before && beforePhase === phase && !headChanged && !criticChanged) continue;
    let message = `PR #${pr.number} (${pr.headRefName}) ${PHASE_MSG[phase] || phase}`;
    if (headChanged) message += `; head advanced to ${String(pr.headRefOid || "unknown").slice(0, 12)} — re-evaluate Gauntlet status`;
    if (criticChanged && pr.criticVerdict) {
      if (pr.criticStale) {
        message += `; observed stale ${pr.criticVerdict} marker for ${String(pr.criticReviewedHead || "unknown").slice(0, 12)} — ignored for current head; validate with roadmap gauntlet status`;
      } else {
        message += `; observed ${pr.criticVerdict} marker for ${String(pr.headRefOid || "unknown").slice(0, 12)} — validate with roadmap gauntlet status`;
      }
    }
    events.push({
      number: pr.number,
      headRefName: pr.headRefName,
      title: pr.title,
      phase,
      headChanged,
      criticChanged,
      message,
    });
  }
  return events;
}

// A watcher signal is deliberately weaker than a Gauntlet verdict: it only says an
// exact structured marker for this run/current head appeared. The status command also
// checks launch receipts, commits, checks, and stop conditions before taking action.
export function criticSignalOf(pr) {
  const runId = parseGauntletRunMarker(pr && pr.body);
  const head = pr && pr.headRefOid;
  if (!runId || typeof head !== "string") return null;
  const candidates = [];
  for (const [index, comment] of ((pr && pr.comments) || []).entries()) {
    const marker = parseCriticMarker(comment && comment.body);
    if (!marker || marker.runId !== runId) continue;
    const parsed = Date.parse(comment.createdAt || comment.created_at || "");
    candidates.push({ marker, index, time: Number.isFinite(parsed) ? parsed : index });
  }
  const latest = candidates.sort((a, b) => b.time - a.time)[0];
  if (!latest) return null;
  return {
    verdict: latest.marker.verdict,
    reviewedHead: latest.marker.head,
    stale: latest.marker.head !== head,
    signature: `${runId}:${latest.marker.head}:${latest.marker.criticRole}:${latest.marker.round}:${latest.marker.nonce}:${latest.marker.verdict}`,
  };
}
