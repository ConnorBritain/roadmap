// roadmap — doctor brain (PURE). Reconciles the roadmap against reality and reports DRIFT
// between the plan and what actually shipped/tracked. No IO: doctor.mjs gathers the merged
// PRs, open PRs, fanout worktrees, the rendered-vs-disk doc diff, and the Linear pull deltas,
// then this classifies them into report sections. It REUSES the existing detection brains
// (findUnrecordedMerges, prPhase/matchesRoadmapBranches, validateGraph) rather than re-deriving
// them, so doctor can never disagree with /sync or the PR watcher. Structural (static) checks are
// NOT drift — they're `roadmap validate`'s job — so they are deliberately not folded in here.

import { findUnrecordedMerges } from "./sync-core.mjs";
import { prPhase, checksOf } from "./pr-watch-core.mjs";
import { belongsToRoadmapPr } from "./pr-identity.mjs";
import { auditBacklog, knownDamageOf } from "./backlog-audit.mjs";

// Open-PR phases that count as drift — a PR sitting in one of these needs a human/agent nudge.
// "ready" (mergeable) and the transient "checks-pending" are NOT drift; merged/closed aren't open.
const OPEN_PR_DRIFT = new Set(["draft", "conflicts", "checks-failing"]);

// doctorReport(inputs) -> { sections: [{ title, items }], driftCount }.
// A section is included ONLY when it has drift items, so a clean roadmap yields
// { sections: [], driftCount: 0 }. Inputs are already-gathered (see doctor.mjs):
//   graph           parsed roadmap YAML
//   backlog         parsed backlog YAML, or null when the repo has none
//   backlogText     the raw backlog.yaml text (for the audit), or null when absent
//   dispatchStatus  { enabled, reason, adapter, source } from dispatch-providers, or null
//   mergedPrs       [{ number, headRefName, title, body }]        (state=merged)
//   allPrs          [{ number, headRefName, state, isDraft, mergeStateStatus, statusCheckRollup }]
//   worktrees       fanout worktrees [{ branch, path, dirty, isMerged }]
//   renderedVsDisk  { staleDocs: [path, ...] } — generated docs whose on-disk bytes != a fresh render
//   linearDeltas    result.proposals.deltas, or null when Linear is unconfigured/unreachable
export function doctorReport({ graph, backlog = null, backlogText = null, dispatchStatus = null, mergedPrs = [], allPrs = [], worktrees = [], renderedVsDisk = {}, linearDeltas = null } = {}) {
  const sections = [];
  const add = (title, items) => { if (items.length) sections.push({ title, items }); };

  // 1. SHIPPED-BUT-NOT-MARKED — a merged PR whose slice is still open in the roadmap.
  add("Shipped but not marked complete",
    findUnrecordedMerges(graph, mergedPrs).map(
      (u) => `${u.invoke} — merged in PR #${u.pr} (${u.branch}) but still open; reconcile (roadmap set / /sync).`));

  // 2. STALE GENERATED DOCS — the YAML moved but SLICES.md/BACKLOG.md weren't re-rendered.
  add("Generated docs stale",
    (renderedVsDisk.staleDocs || []).map((p) => `${p} differs from a fresh render — run 'roadmap render'.`));

  // 3. LINEAR != ROADMAP — pull-only sync deltas (status/priority the tracker disagrees on).
  //    null = Linear off/unreachable → skip the section entirely (the graceful guard).
  if (linearDeltas) {
    add("Linear disagrees with the roadmap",
      linearDeltas.map((d) => `${d.kind} ${d.key}: ${d.field} ${d.from} → ${d.to ?? `(${d.note})`} in Linear.`));
  }

  // 4. OPEN-PR REALITY — roadmap-branch PRs stuck in a drift phase (draft/conflicts/failing).
  //    allPrs may be null (gh absent) — external-state signals "unknown" that way; treat as none.
  //    Normalize the raw rollup → `checks` via checksOf FIRST (the same step watch-prs does): prPhase
  //    keys off pr.checks, so without this the "checks-failing" signal could never fire.
  add("Open PRs needing attention",
    (allPrs || [])
      .map((pr) => ({ ...pr, checks: checksOf(pr) }))
      .filter((pr) => belongsToRoadmapPr(pr, graph) && OPEN_PR_DRIFT.has(prPhase(pr)))
      .map((pr) => `PR #${pr.number} (${pr.headRefName}) — ${prPhase(pr)}.`));

  // 5. STALE WORKTREES — fanout worktrees left unmerged or dirty (work parked mid-air).
  add("Stale fanout worktrees",
    worktrees
      .filter((w) => !w.isMerged || w.dirty)
      .map((w) => `${w.branch || "(detached)"} — ${w.isMerged ? "merged" : "UNMERGED"}, ${w.dirty ? "dirty" : "clean"} (${w.path}).`));

  // 6. BACKLOG COLLISION DAMAGE — structural damage in the raw text that
  //    yaml.parse either throws on or silently normalizes. The audit runs
  //    against the raw text so it can see damage the parsed object can't;
  //    grandfathered signatures (meta.audit.known_damage) don't add drift
  //    but ARE reported so a stranger can see what's being tolerated.
  if (typeof backlogText === "string") {
    const audit = auditBacklog(backlogText, { knownDamage: knownDamageOf(backlog) });
    add("Backlog collision damage",
      audit.findings
        .filter((f) => f.code !== "MALFORMED_ID")
        .map((f) => `[${f.code}] ${f.message}`));
    // Stale known_damage pins are drift the other way — the file has been
    // repaired but the baseline hasn't been pruned. Surface separately so a
    // reviewer can tell "repair still owed" from "housekeeping owed".
    add("Stale meta.audit.known_damage entries",
      audit.staleKnown.map((s) => `${s} — the underlying damage is repaired; prune this pin so the guard can catch a fresh occurrence.`));
  }

  // 7. CROSS-ENGINE DISPATCH LOCK STATUS — when the in-flight check is
  //    disabled (CLI missing, unauthed, no matching provider, or explicitly
  //    off), a stranger clones this repo, runs `roadmap dispatch`, and gets
  //    NO protection from a duplicate fire. That's fine (best-effort by
  //    design), but the user must be able to see it — otherwise they think
  //    the lock is running when it isn't.
  //
  //    An enabled lock is silence: no section, no items, no drift. A
  //    disabled lock is ONE item explaining why (never enough to make
  //    doctor red on its own, since it's a diagnostic).
  if (dispatchStatus && dispatchStatus.enabled === false) {
    add("Cross-engine dispatch lock disabled",
      [`in-flight PR check is off — ${dispatchStatus.reason}. A duplicate dispatch from another engine (Claude.ai Routines portal, a second CLI worktree) will not be caught. Fix the cause or set meta.dispatch.provider to disable this warning intentionally.`]);
  }

  const driftCount = sections.reduce((n, s) => n + s.items.length, 0);
  return { sections, driftCount };
}
