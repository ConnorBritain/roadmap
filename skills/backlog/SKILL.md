---
name: backlog
description: Capture and triage erratic work (follow-ups, bugs, chores, urgent items) on the repo's backlog (docs/roadmap/backlog.yaml) beside the roadmap. Normalizes a dump into prioritized items, then offers grab (launch directly) or promote (into the roadmap). Use whenever work surfaces that isn't planned roadmap work.
argument-hint: "[what to capture, or empty to triage]"
allowed-tools: Read, Glob, Grep, Bash(roadmap backlog:*), Bash(roadmap grab:*), Bash(roadmap promote:*), Bash(roadmap:*), Bash(node:*)
---

You manage the repo's **backlog** — the tracker for erratic work (follow-ups, bugs, chores, urgent items) that surfaces outside the planned roadmap. Roadmap = feature/value work; backlog = everything that just shows up.

**Capture** (arguments given, or the user describes work):
1. Normalize what they said into one item per distinct piece of work: a crisp `title`, a `kind` (`bug|chore|followup|urgent|idea`), and — when the user's words imply urgency or stakes — a `priority` (`tier` P0–P3, optional `weight` 0–100, and a one-line `reason` in their words). Don't interview for fields they didn't imply; capture beats ceremony.
2. File each via the `backlog_add` MCP tool (server `graph`), or `roadmap backlog add "<title>" -k <kind> [--tier PN] [--weight N] [--note "<why>"] [--slice <invoke>]`. First capture creates `docs/roadmap/backlog.yaml` and renders `docs/BACKLOG.md`.
3. Echo back what was filed (id · kind · tier · title) so the user can correct.

**Triage** (no arguments): run `roadmap backlog` and walk the open items with the user — set/adjust `priority` (with reasons), drop stale ones (`status=dropped`), and stash pickup instructions on items that are ready to run (`roadmap backlog set <id> prompt=@file` or `backlog_set`). Edits go through `backlog_set` / `roadmap backlog set` only — never hand-edit BACKLOG.md (generated).

**Then route** each actionable item, and say which you'd pick:
- **Small / self-contained** → `roadmap grab <id>` (own worktree + session, launches directly).
- **Bigger / belongs in the plan** → `roadmap promote <id> --pi <pi>` (becomes a roadmap sprint; keeps the back-link).
- **Not yet** → leave it captured; `roadmap next` will surface it when it outranks the roadmap's ready work.
