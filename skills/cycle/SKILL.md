---
name: cycle
description: The weekly cycle election — a strict, capacity-capped lock of what gets worked this cycle. Reviews stale (journal-silent) committed work FIRST, forces a carry/kill reason per holdover, elects ready scheduled slices up to capacity, writes one atomic lock, then syncs so the Linear cycle mirrors it. Run weekly on cycle rollover, or on demand when the cycle got crushed or cleared. With cycles on, dispatch/fan refuse out-of-cycle work — this ritual is the only normal way work enters the week.
argument-hint: "[optional: 'crushed' for a mid-cycle re-election, or a capacity override like '8']"
allowed-tools: Read, Bash(roadmap cycle:*), Bash(roadmap linear:*), Bash(roadmap plan:*), Bash(roadmap next:*), Bash(node:*)
---

You run the cycle election: the one ritual that decides what gets worked this week. Be strict — the whole point is a bounded, honest batch. Everything else stays in the YAML, visible via the horizon when it approaches.

1. **Refresh the board state.** `roadmap linear sync` (not dry — you want fresh staleness + the current cycle mirrored). If Linear isn't wired, skip and note the election is YAML-only this round.

2. **Read the picture.** `roadmap cycle plan --json`. It gives you: `elected` (the committed set, stale-flagged), `packed` (ready candidates that fit capacity, priority order), `overflow`, `unestimated`, `capacity`, `estUsed`.

3. **Stale items FIRST — every ⚠ gets a decision before anything new enters:**
   - *Still moving?* → post a journal note (`roadmap linear note <key> "<what's true now>"`) — the note clears the flag on next sync.
   - *Stalled but still this week's work?* → keep, with a stated reason AND an unblock action (who/what today).
   - *Not happening this week?* → demote (`--demote`). Say it plainly: an honest small cycle beats a wishful full one.
   Never let a stale item ride into the next cycle without one of those three.

4. **Walk the election.** Present `packed` as the proposal (it's priority-ordered and fits capacity on top of what's committed). For each: in or out, one line why. The user can pull from `overflow`/`unestimated` — but an unestimated slice needs an `est_sessions` first (`roadmap set <key> est_sessions=N`), and going over capacity needs an explicit "we're overcommitting because…". Mid-week arrivals do NOT enter here — they go to the backlog (`/backlog`) and wait for the next election unless the user invokes the emergency path (dispatch --force, which surfaces as scope change).

5. **Lock atomically.** Play back the final promote/demote lists, get a yes, then ONE
   `roadmap cycle lock --promote a,b,c --demote x,y`. Never hand-edit statuses for this.

6. **Project it.** `roadmap linear sync` — active+next join the active Linear cycle, demotions leave it, the This-cycle view is now the week. Close with the one-line summary: N committed · M est_sessions of C capacity · stale resolved K/K.

A crushed cycle ("everything shipped" or "the week blew up") is the same ritual run early — nothing special, just rerun it. If there is no active cycle in Linear (between cycles / cooldown), the lock still works; the projection catches up when the next cycle starts.
