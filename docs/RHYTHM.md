# The rhythm — operating a many-agent roadmap as one human

The roadmap selects work; the Gauntlet makes each artifact earn its way to merge. The recurring
rhythm is GitHub-first:

```text
plan -> conducted Gauntlet -> merge decision -> reconcile -> plan again
```

The long-lived lead owns intent and judgment. Disposable cloud Routines implement, criticize,
and repair. GitHub holds the PR, current SHA, checks, frozen bar, and verdict history. Linear can
project the plan and collect intake, but it is not required to conduct work.

## Daily — conduct, do not shuttle

Use three compact views:

| View | Decision |
|---|---|
| `roadmap plan` | Which dependency-safe slice should enter a run next? |
| `roadmap gauntlet status <run-or-key>` | Is implementation, criticism, repair, human input, or no action safe now? |
| GitHub PR/checks | What durable artifact and exact head actually exist? |

For every active slice:

1. Refresh status before acting; resume the existing run instead of launching a duplicate.
2. When implementation produces a stable head, fire one fresh independent critic for that SHA.
3. Inspect the exact critic comment and acknowledge both its immutable body digest and GitHub
   comment-URL digest. On acknowledged `REVISE`, synthesize the material findings into a narrow
   repair packet; never forward the review blindly.
4. Re-critic the new head, then repeat the inspection and acknowledgment. A verdict or
   acknowledgment for an older SHA is stale, even if it says `PASS`.
5. Stop on acknowledged current-head `PASS`, human judgment, infrastructure failure,
   non-convergence, or the default ceiling of three repair rounds.
6. A pass makes that exact head eligible for the normal lead/human merge decision. Nothing
   auto-merges. After merge, run `/sync`.

The local `.roadmap-gauntlet-state.json` file is a gitignored launch ledger/cache. It helps the
lead resume and protects the pre-PR launch window, but GitHub PRs/comments and protected
`roadmap-gauntlet-locks/*` receipt branches remain durable reality.

## Weekly — elect the next wave

Use the planning graph to bound work before adding more agents:

1. `/sync` merged GitHub PRs into canonical YAML; project to Linear afterward only if configured.
2. Run `roadmap plan` and inspect dependency, file-contention, priority, and capacity constraints.
3. Resolve stale/human-required/exhausted Gauntlet runs before opening more fronts.
4. Elect a small ready wave. Fanout is concurrency across slices; start one separately identified
   Gauntlet per meaningful cloud slice.
5. Keep one critic per run by default. Several runs may be at different phases, but their run IDs,
   PRs, heads, and repair packets never mix.
6. Post the weekly digest wherever the team works. If Linear is wired, sync it as a projection,
   not as the source of Gauntlet truth.

When `meta.linear.cycles` is on, `roadmap cycle plan` / `roadmap cycle lock` can still elect and
bound the batch shown in Linear. Out-of-cycle refusal remains a useful scope guard. It does not
replace the within-slice implement -> critic -> acknowledge -> repair -> fresh critic ->
acknowledge loop.

## Monthly — inspect the bets, not the transcripts

Review initiatives and run `/debrief`: what shipped, what grew, which runs repeatedly failed to
converge, and where humans overruled or clarified a frozen bar. Re-plan with `/imagine` when the
roadmap no longer matches product intent. Cloud session transcripts are optional debugging
material, never the program database.

## Composition and scope discipline

- A new PI is a strategic bet: normally at least three real slices, an exit criterion, and an
  initiative.
- A slice in an existing PI is the default home for planned work.
- A backlog item is erratic work: follow-ups, bugs, chores, and ideas discovered by builders or
  critics.
- Implementation, repair, and critic workers do not create PIs or sprints. The lead decides which
  findings are material; accepted leftovers go through backlog triage.
- A PI under roughly three slices is usually a slice wearing a PI's coat.

## Optional Linear operating view

If Linear is configured, use My Issues / the plate for personal focus and the current-cycle view
for the elected batch. Provisioned views remain useful for Ready wave, In flight, Held on human,
Backlog triage, Stale, and Recently shipped. Their issue state is a projection of planning/work
state; exact Gauntlet verdicts live on GitHub and are pinned to PR head SHAs.

On cycle rollover, sync GitHub/YAML first, then `roadmap linear sync`, plan/lock the next cycle,
and sync again. Mid-cycle arrivals enter the backlog rather than bypassing the election.

See [GAUNTLET.md](GAUNTLET.md) for the full conduct, recovery, Routine-resolution, and safety
contracts.
