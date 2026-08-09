---
name: sync
description: Reconcile canonical roadmap/backlog state with merged GitHub PRs, then re-render generated views and optionally project to Linear. Run after lead/human merge decisions; never touches product code.
argument-hint: "[--since YYYY-MM-DD] [--dry-run]"
allowed-tools: Read, Bash(roadmap render:*), Bash(roadmap backlog:*), Bash(roadmap linear:*), Bash(roadmap gauntlet status:*), Bash(roadmap:*), Bash(node:*), Bash(git log:*), Bash(gh pr list:*), Bash(gh pr view:*)
---

Reconcile `docs/roadmap/roadmap.yaml` and `docs/roadmap/backlog.yaml` with durable GitHub reality,
then re-render `docs/SLICES.md` and `docs/BACKLOG.md`. GitHub is the primary execution record;
Linear, when configured, is a later projection/pull-inbox phase.

1. **Window.** Use `--since <date>` when given; otherwise infer from the newest PR already cited
   in canonical YAML, falling back to roughly 14 days.
2. **Read GitHub ground truth.** List merged PRs and first-parent commits in the window. Associate
   roadmap work through the shared membership rules: recognized local fanout branch, exact
   `roadmap: slice=<key>` / backlog marker, or a Gauntlet run marker. Cloud branch names are not
   identity.
3. **Audit Gauntlet evidence.** For every associated Gauntlet PR, inspect the run/status, frozen
   bar, merge SHA/head history, and critic comments. Only call a verdict valid for an artifact
   when its recorded full SHA matches the reviewed PR head and its immutable body digest and exact
   GitHub comment-URL digest are bound by a frozen-lead acknowledgment. Surface stale or unacknowledged
   verdicts, a merge without an acknowledged current-head `PASS`, human-required state, exhausted
   repair rounds, or ambiguous run association; never rewrite history or invent a pass. A
   human-authorized merge is still durable shipment, so record it while reporting the exception.
4. **Compute the delta.** A slice whose associated PR merged becomes `complete` with a cited PR;
   a started subject is promoted appropriately. Keep `invoke` keys stable. New strategic scope is
   a proposal for the human, never an automatic PI/sprint addition.
5. **Apply only through validated mutation surfaces.** Prefer `set_status`, `set_fields`,
   `bulk_set`, `backlog_set`, and the other `graph` MCP mutators; use the matching `roadmap`
   commands where available. Those paths preserve YAML comments and validate before writing.
   Never hand-edit generated Markdown. With `--dry-run`, print the proposed PR-to-change mapping
   and stop. Otherwise run `roadmap render` after the canonical mutations.
6. **Harvest leftovers, with consent.** Scan merged PR bodies and critic findings for material
   follow-ups. Propose each as `backlog_add` / `roadmap backlog add ... --slice <invoke>` and ask
   before filing. Workers and critics never create PIs or sprints. Do not turn nits or rejected
   critic advice into backlog churn.
7. **Retain discipline guardrails.** Surface under-parallelization telemetry when available and
   run the sprawl checks for completions, captures, added sprints, and added PIs. These are
   advisory, not blockers.
8. **Project to Linear only when wired.** If no `meta.linear` exists, skip silently. If configured
   but unauthenticated, emit one setup advisory and finish the GitHub/YAML reconciliation. If
   wired, preview `roadmap linear sync --dry`, walk any `pull: propose` inbox with the user, apply
   accepted proposals through validated mutators, then run `roadmap linear sync`. Never use
   Linear issue state as a substitute for GitHub run evidence.
9. **Report concisely.** Give a PR -> canonical change mapping, cite every merge used for a status
   flip, list any stale/missing Gauntlet verdicts, and name ambiguous associations. Note unrelated
   dirty work without touching it.

This is a docs/data reconciliation, not a product-code test gate. The Gauntlet concludes the
artifact review; `/sync` records the already-authorized merge in the planning graph.
