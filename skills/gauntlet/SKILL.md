---
name: gauntlet
description: Conduct a roadmap slice through frozen-bar cloud implementation, independent exact-SHA criticism, frozen-lead acknowledgment after every critic, lead-synthesized repair, and fresh re-criticism plus acknowledgment. GitHub is durable reality; the lead decides, workers never merge.
argument-hint: "<slice-or-backlog-key> [--max-rounds N]"
allowed-tools: Read, Bash(roadmap:*), Bash(roadmap gauntlet:*), Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh api:*), mcp__plugin_roadmap_graph__show, mcp__plugin_roadmap_graph__gauntlet_start, mcp__plugin_roadmap_graph__gauntlet_status, mcp__plugin_roadmap_graph__gauntlet_critic, mcp__plugin_roadmap_graph__gauntlet_ack, mcp__plugin_roadmap_graph__gauntlet_repair, mcp__plugin_roadmap_graph__gauntlet_cancel
---

You are the long-lived lead conducting a Gauntlet run. You hold intent, context, and judgment;
fresh cloud agents perform implementation, independent criticism, and repair. GitHub is the
durable rendezvous point. Do not turn this procedure into a blind loop.

Prefer the `graph` MCP tools `gauntlet_start`, `gauntlet_status`, `gauntlet_critic`,
`gauntlet_ack`, `gauntlet_repair`, and `gauntlet_cancel`. If they are unavailable, use the
identical CLI family:

```text
roadmap gauntlet start|status|critic|ack|repair|cancel
```

Read `docs/GAUNTLET.md` when you need the protocol, provider configuration, or recovery model.

1. **Orient and make the bar observable.** Read the subject with `show`, its canonical roadmap or
   backlog YAML entry, resolved gate, prompt/kickoff constraints, and relevant repository context.
   Turn vague success language into externally checkable acceptance criteria without expanding
   scope. Include immutable user instructions, architectural invariants, required verification,
   and the selected base SHA. The builder must not define its own grading criteria.
2. **Inspect before actuating.** Call `gauntlet_status` for the key first. Resume an active run
   instead of launching a duplicate. If GitHub, the PR association, or the current state is
   ambiguous, stop and surface that ambiguity.
   Before any launch claim, the repository must have an active ruleset for
   `roadmap-gauntlet-locks/*` that restricts creation, updates, and deletion to the trusted
   lead/service identity and blocks non-fast-forward updates; Routine workers must not bypass it.
   On GitHub-only recovery without lead-authored launch attestations, treat historical verdicts
   as advisory. The same applies when this machine lost the distributed implementation election
   and the winning PR carries a different frozen protocol. Status must stay read-only: authenticate
   as the winning packet's frozen lead, inspect its bar, frozen base, round ceiling, and tiers
   against current roadmap/user intent, then explicitly use `confirm_recovered_bar`; never pass it
   blindly. The confirmed actuator may adopt the winner and upsert authenticated GitHub lead launch
   attestations before mutation; a status call never writes them.
3. **Start deliberately.** Explain the frozen bar and ask for confirmation immediately before
   `gauntlet_start`; starting spends provider usage and may create remote work. The start writes
   the bar to `.roadmap-gauntlet-state.json` and requires the implementation worker to carry the
   same bar and run identity into its PR body. Default to one critic and at most three repair
   rounds unless the user sets a different limit.
4. **Observe, do not infer.** Poll `gauntlet_status` at useful transition points. Wait for the
   marked implementation PR and a stable, reviewable head. Treat CI/test infrastructure failure
   separately from a failure of the implementation. Do not require or relay the implementation
   worker's private reasoning.
5. **Dispatch a fresh critic.** Confirm the current full head SHA from status, then call
   `gauntlet_critic`. The critic must independently inspect the repository, diff, behavior, and
   relevant tests against the frozen bar, and publish its structured PR comment for that exact
   SHA. V1 conducts one selected critic role at a time; a security or architecture specialist may
   be selected explicitly, but do not simulate fan-out with duplicate launches.
6. **Inspect and acknowledge the exact verdict.** Refresh `gauntlet_status`, open the candidate
   comment URL, and independently inspect its evidence against the artifact and frozen bar. If it
   is the comment you intend to accept as critic input, call `gauntlet_ack` with that exact URL and
   explicit confirmation, then refresh status. A verdict counts only when its run identity,
   reviewed SHA, nonce, immutable body digest, exact GitHub comment-URL digest, and lead
   acknowledgment match. A stale `PASS` does not pass; a stale `REVISE` does not justify
   repairing newer code. Canonical outcomes are
   `PASS`, `REVISE`, `HUMAN_REQUIRED`, and `INVALID_OR_STALE`.
7. **Exercise lead judgment on `REVISE`.** Read the evidence, not just the label. Separate:
   `MUST FIX` acceptance failures; supported architectural/security risk; useful `SHOULD FIX`;
   speculative preference; and nits. Deduplicate overlapping findings, resolve contradictions,
   reject scope creep, and detect advice that conflicts with existing architecture. If the critic
   exposed ambiguity in the bar, escalate or begin an explicitly revised run instead of moving
   the goalposts.
8. **Write the repair packet yourself.** It should name only accepted changes, why each is material
   to the frozen bar, relevant file/evidence pointers, required verification, and explicit
   non-goals. Never pass the critic transcript through wholesale. Ask for confirmation immediately
   before firing a repair worker.
9. **Repair the same PR safely.** Call `gauntlet_repair` with the exact expected head and the
   lead-synthesized packet. The fresh worker must recheck that head, abort if it moved, apply the
   packet narrowly, verify, and push to the existing PR branch. It never force-pushes, merges, or
   opens a competing PR by default.
10. **Re-critic the new artifact.** Refresh status, confirm the new full head, and launch a fresh
    critic. Then return to step 6 to inspect and acknowledge this new result. Never ask the
    builder/repair worker to grade itself or carry an old verdict or acknowledgment forward.
11. **Stop economically and safely.** Stop on an acknowledged current-head `PASS`;
    `HUMAN_REQUIRED`;
    default maximum of three repair rounds; repeated material non-convergence; low-value
    preference churn after the bar is met; or infrastructure failure. A repair ceiling is not a
    pass. Explain the frozen-bar status and the smallest decision needed from the human.
    A lost provider response is `launch_ambiguous`, not permission to retry. Reconcile the provider
    receipt/GitHub first; if work is genuinely abandoned, use `gauntlet_cancel` with explicit human
    confirmation and a reason. Receipts and any open PR remain intact. A PR-backed cancellation
    is durable GitHub state. A pre-PR cancellation creates a protected shared tombstone claim so
    delayed worker output cannot resurrect the run; retain the human's portal reconciliation
    evidence because its detailed reason stays local until a PR comment exists. Never delete
    branches matching `roadmap-gauntlet-locks/*` for an active or recoverable run.
12. **Hand off merge and reconcile.** A `PASS` makes the exact head eligible for the normal
    lead/human merge decision; it never merges automatically. After merge, run `/sync` so the
    canonical YAML and optional projections record what shipped. Workers put discoveries in the
    backlog only and never create PIs or sprints.

When several slices are ready, conduct one separately identified run per slice. Fanout decides
which slices can proceed in parallel; Gauntlet controls iteration inside each slice. Never mix a
critic, repair packet, PR, or SHA across run identities.
