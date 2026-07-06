---
name: retro
description: The full review-and-redirect ritual — /debrief's date-anchored lookback COMPOSED with forward planning: strategic options per bet (double/kill/defer), decisions applied to the graph, optional /imagine handoff, then the anchor + captain's-log close. Use on a cadence (or whenever the deluge outruns you) to keep the direction YOURS instead of the agents'.
argument-hint: "[--since <rev|YYYY-MM-DD>]"
allowed-tools: Read, Edit, Bash(roadmap review:*), Bash(roadmap validate:*), Bash(roadmap render:*), Bash(roadmap next:*), Bash(roadmap linear:*), Bash(roadmap:*), Bash(node:*), Bash(git log:*)
---

You run the whole ritual: look back honestly, decide forward deliberately, apply, close. This is how the human rides the wave — the digest is evidence, the user's answers are the direction, the graph is where both land.

1. **Lookback.** Perform /debrief's steps 1–2 exactly (capture the pre-review anchor sha FIRST; run `roadmap review --json`; present the digest under the same HARD style rules — ≤15 lines, displacement-form recommendations, north-star tied, agent-originated scope named, no cheerleading). **HOLD the close** — the anchor and log entry are written at the end so they cover the decisions too.

2. **Strategic options.** Walk the active bets (PIs with open work) one at a time: **double down / kill / defer / hold** — and for the backlog, what to drop. Rules:
   - Every kill/defer proposal names what the freed sessions buy.
   - Every sprawl-flagged sprint/item/PI gets an explicit keep-or-drop question — friendly sidequests don't get to stay by default.
   - Aging held work (`aging` in the digest) gets "unblock, re-scope, or kill?" — held-forever is a decision someone didn't make.
   - One question at a time; the user's words become the reasons.

3. **Apply via the existing tools only** — `bulk_set` for priority shifts (reasons from step 2), `set_status` for kills/defers, `prune` for removals, `backlog_set` for item triage/drops. Never hand-edit sprint fields. If tiering deserves its own full pass, run the /prioritize flow here rather than half-doing it.

4. **Reset check.** If the digest + decisions show real drift (north star stale, bets no longer believed), offer `/imagine` for the strategy re-interview — don't run it inline; this ritual ends first.

5. **Close the loop** (/debrief step 3, now covering the decisions): update `meta.last_review` (date = today, commit = the step-1 sha) via Edit + `roadmap validate`; append the **≤10-line, newest-first** captain's-log entry to `docs/roadmap/REVIEWS.md` — what was decided and why, in your words; `roadmap render`; if Linear is wired, optionally `roadmap linear post-update` per active PI (API rejection → one-line skip note). End with `roadmap next` — the single thing that now leads.
