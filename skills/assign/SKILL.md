---
name: assign
description: Hand a roadmap slice to a person — write the assignment brief (checklist gate, artifact path, read order, pickup notes) under .roadmap/assignments/ so they can work from it without the tool. The general profile's launch; the brief file is the receipt. Profile: general.
argument-hint: "<slice-key> [--to who] [--dry]"
allowed-tools: Read, Bash(roadmap:*), Bash(roadmap assign:*), Bash(roadmap show:*), mcp__plugin_roadmap_graph__show, mcp__plugin_roadmap_graph__assign
---

**Profile: general** (`meta.profile: general`). Under the engineering profile a slice is launched
into a worktree session with `/fanout` or `roadmap grab`.

1. **Orient.** `show` the slice: its `what`, checklist gate, read order, `artifact` path and any
   `Prompt:` block. If the gate is still a command string or absent, propose a checklist (via
   `set_fields`) before assigning — a person needs criteria to confirm, not a command to run.
2. **Assign.** `roadmap assign <key> --to <who>` (or the `assign` MCP tool). It writes
   `.roadmap/assignments/<key>.md` with the receipt header, the checklist, the artifact path and
   the pickup notes verbatim. `--dry` previews the brief and writes nothing. A slice already
   assigned keeps its first assignment; say so instead of overwriting.
3. **Hand off.** Tell the assignee where the brief is and that the deliverable goes at the
   artifact path, committed when a draft is ready for review. They do not mark the slice
   complete — `/conduct` runs the review loop and `/sync` records the outcome.
