---
name: fanout
description: Compute the ready wave from the roadmap graph and launch each slice concurrently in its own git worktree (tmux lead + slice panes). Recommends a concurrency cap from a CPU/RAM + repo-purpose eval. Honors each slice's execution-strategy hint. Use to parallelize independent slices.
argument-hint: "[--wave N] [--cap N] [--track A] [--dry] [--out file] [--autonomous]"
allowed-tools: Read, Bash(roadmap:*), Bash(roadmap fan:*), Bash(roadmap plan:*), Bash(node:*), Bash(git worktree:*), Bash(git fetch:*)
---

You orchestrate a concurrent fanout of independent slices. Each launched session is a **separate** `claude` process in its own git worktree (not a subagent) and owns its atomic read→build→test→commit→push→PR; **none ever merges** — the lead merges.

1. **Show the plan first.** Run `roadmap plan` (or `roadmap plan --cap N`) to display the recommended cap, the binding constraint, and the waves. Relay it.
2. **Decide the cap.** Default to the recommendation. The user sets the only knob that matters — how many concurrent sessions — via `--cap N`.
3. **Launch.** From the user's terminal the natural command is `roadmap fan --wave <N>` (launches interactive tmux: lead pane + one watched pane per slice).
   - **From inside this Claude session, prefer `roadmap fan --wave <N> --dry` or `--out wave<N>.sh`** and hand the user the command to run in their terminal — interactive tmux can't attach to the Bash tool. Only use `--launch`-equivalent direct spawning for **background/autonomous** runs.
   - **Autonomous** (headless `claude -p` workers that commit/push/PR unattended) requires the explicit `--autonomous --yes-spawn-autonomous` double-ack. Confirm with the user before passing it.
4. **Honor each slice's `execution:` hint.** When a slice declares one, its synthesized kickoff brief carries the imperative directive verbatim (section 0), so the launched session staffs itself correctly: an `agent-team` slice **invokes Agent Teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) at the named worker count + composition; a `subagents` slice spawns N background subagents per CLAUDE.md § Subagent Hand-off; a `solo` slice runs single, no fan-out. Don't override the declared topology — relay it. (Slices without a hint behave exactly as before.)
5. **`--track <lane>`** narrows a launch to one lane (e.g. `roadmap fan --wave 1 --track A`) so a person fans out only their slices in the three-track partition.
6. **After the wave**, review each slice's PR (or invoke the `wave-shepherd` agent) and merge in dependency order. Re-run `roadmap plan` to see the next wave.

tmux lives in WSL on Windows — if `roadmap fan` reports tmux missing, it prints the script + how to run it in WSL; relay that.
