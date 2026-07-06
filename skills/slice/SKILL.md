---
name: slice
description: Orient on a named slice of work from the repo's roadmap graph (docs/roadmap/roadmap.yaml) — print what it is, its read-order, branch/worktree, next action, and gate, then stop. Read-only; use before picking up a unit of work.
argument-hint: "<slice-name>"
allowed-tools: Read, Glob, Grep, Bash(roadmap show:*), Bash(roadmap:*), Bash(node:*), Bash(git rev-parse:*), Bash(git status:*), Bash(git fetch:*), Bash(git branch:*)
---

You are orienting on a named slice. **Read-only** — do not edit, commit, or start work. Pause after the summary.

1. **Load the slice.** Run `roadmap show $ARGUMENTS`. (If `roadmap` isn't on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" show $ARGUMENTS`.) If it reports "no slice", show the available list it printed and ask which one. Stop.
2. **Follow the read-order.** Read each doc the slice lists, in order, to get current. If one is missing, note it (the slice may be in a scaffolding phase) — don't fabricate.
3. **Check branch state.** `git rev-parse --abbrev-ref HEAD` + `git fetch origin --quiet` + `git status -s`. Compare against the slice's expected branch; note drift or dirty files.
4. **Print a short orientation** (Slice/Status · What · Priority if set · Read-order: N read · Branch: sync/drift/dirty · Next · Gate). If the slice carries a `Prompt:` block (author-stashed instructions), relay it **verbatim** — it is the pickup brief. Then **STOP** and wait.

If the slice prints a `▶ EXECUTION:` directive, **honor it**: staff the work at the declared topology and worker count (e.g. invoke Agent Teams for `agent-team`, spawn N background subagents for `subagents`, stay solo for `solo`) rather than defaulting to a lone agent. Relay the directive in your orientation.

If the user then says "go": begin from the slice's **Next** action, honoring its **Gate** before declaring done. A slice marked **Gated on `<human>`** is prep-only — prepare checklists/tests/docs; do not perform the gate. Engine/correctness slices carry a "never deepen the value-logic the refactor deletes" discipline — surface it, don't override it.
