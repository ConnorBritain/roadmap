---
name: debrief
description: Date-anchored lookback on the roadmap — what shipped vs what grew since the last review, presented high-signal/no-noise, logged to REVIEWS.md, anchor updated. LOOKBACK ONLY — no graph mutations; for the full review-and-redirect ritual use /retro. Use when the wave of agent work has outrun your picture of it.
argument-hint: "[--since <rev|YYYY-MM-DD>]"
allowed-tools: Read, Edit, Bash(roadmap review:*), Bash(roadmap validate:*), Bash(roadmap linear:*), Bash(roadmap:*), Bash(node:*), Bash(git log:*)
---

You run the lookback half of the review ritual. **You do not mutate the graph** — no status flips, no priority changes, no prunes. Your product is an honest picture, a log entry, and a fresh anchor. (Decisions belong to /retro or the user's explicit follow-up.)

1. **Digest.** Capture the pre-review anchor FIRST: `git log -1 --format=%H -- docs/roadmap/roadmap.yaml` (you'll write it in step 3 — capturing it after edits would swallow this review's own changes from the next window). Then run `roadmap review --json` (pass `--since` through if given; if it reports no anchor, say so and offer `--since`).

2. **Present the digest under these HARD style rules:**
   - **≤15 lines total.** If it doesn't fit, you are summarizing wrong — you are not allowed more lines.
   - **Every recommendation names what it displaces.** "Do X" is banned; "Do X instead of Y" is the form.
   - **Every recommendation ties to `meta.north_star`** (read the doc it points at) **or explicitly says "no north-star principle applies."**
   - **Agent-originated scope growth is flagged explicitly, by name** — each sprint/item/PI the digest shows arriving without a human decision, said plainly.
   - **No cheerleading.** Banned: "great progress", "exciting", "well done", exclamation marks. State what shipped, what grew, what's stuck (`aging` = held since before the last review), how fragmented (`pisInFlight`), and every `sprawl` line verbatim.

3. **Close the loop** (this is a lookback, so this is ALL you write):
   - Update `meta.last_review` (`date` = today, `commit` = the sha captured in step 1) by editing meta directly with Edit, then `roadmap validate` (the meta.north_star precedent — meta isn't tool-settable).
   - Append a **≤10-line entry, newest first**, to `docs/roadmap/REVIEWS.md` — the captain's log. Hand-authored: your words for what the window showed and what it implies, NOT a paste of the digest. Create the file with a `# Reviews` heading if missing.
   - If Linear is wired (`roadmap linear status`): optionally post the digest to active PIs' projects via `roadmap linear post-update`; if it reports the API rejected it, skip with a one-line note.

4. **Hand off.** If the digest warrants action (sprawl warnings, aging work, drifted priorities), end with one line: which of `/retro` (decide and apply), `/prioritize` (re-tier), or `/imagine` (strategy reset) you'd run and why — then stop.
