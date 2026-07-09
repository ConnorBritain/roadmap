# The rhythm — operating a many-agent roadmap as one human

The board is a pulse, not a filing cabinet. Every screen below exists to serve exactly one
decision; if you're staring at a screen and no decision is forming, you're on the wrong screen.
When overwhelmed, don't triage from the raw board — run the on-demand election (`/cycle`) and
let the ritual bound the problem.

## Daily — 5 minutes, two screens

| Screen | The decision it serves |
|---|---|
| **My Issues** (the plate) | *What do I touch right now?* Curated by `meta.plate` + auto-included active work. |
| **This cycle** view | *Dispatch next / unblock gated.* The elected batch — anything ⚠ `stale` gets a journal note, a demotion, or an unblock action today. |

Nothing else daily. Initiatives, far-future scheduled work, and shipped history are deliberately
off this loop.

## Weekly — 30 minutes, the election (`/cycle`)

Run on cycle rollover (or on demand when the week got crushed or cleared):

1. `roadmap linear sync` — fresh staleness + board state.
2. `roadmap cycle plan` — stale items FIRST: every ⚠ gets *note / demote / keep-with-reason*.
3. Elect from the packed candidates up to capacity. Unpriced work gets an `est_sessions` or waits.
4. One `roadmap cycle lock --promote … [--demote …]`, then sync — the Linear cycle now IS the week.
5. Post the digest: `roadmap linear post-update --pi <id>` per active project.

The cycle is the bar: with `cycles: on`, dispatch/fan refuse out-of-cycle work (`--force` is the
logged emergency hatch and shows up as scope change on the cycle graph). Mid-week arrivals go to
the backlog (`/backlog`), not the cycle.

## Monthly — the strategic screen

Initiatives page (rollup health per bet) + `/debrief` (what shipped vs what grew) + a
consolidation pass: `roadmap validate` composition warnings (`pi_min_slices`) name the PIs to
fold or grow. Re-plan with `/imagine` when the roadmap stops matching your intent.

## Composition ratios (when new work shows up)

- **A new PI** is a strategic bet: ≥3 slices of real shape, an exit criterion, an initiative.
- **A slice in an existing PI** is the default home for planned work.
- **A backlog item** is anything erratic — follow-ups, bugs, ideas. Capture first, triage at the
  election or `/prioritize`; never straight into the cycle.
- A PI under ~3 slices is usually a slice wearing a PI's coat — fold it into a sibling.

## One-time Linear checklist (manual — the API can't set these)

Team settings → Cycles: **active-issue auto-add ON**; cooldown as preferred.
Workspace/team settings: **auto-archive closed issues** at the shortest window.
Default team board: filter = current cycle, group by status.
Finish the provisioned views' filters (provision creates name + hint only):

- **This cycle** — current-cycle issues, label `roadmap`
- **Stale** — label `stale`
- **Ready wave** — state Todo, label `roadmap`, exclude `status:*`
- **In flight** — state In Progress, label `roadmap`
- **Held on human** — labels `status:gated|blocked|paused`
- **Backlog triage** — state Backlog, label `kind:*`
- **Recently shipped** — Done in the last 14 days, label `roadmap`

Favorite: This cycle · Held on human · Stale · My Issues. Everything else is drill-down.
