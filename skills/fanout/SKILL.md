---
name: fanout
description: Compute the ready wave and launch independent slices concurrently. Fanout schedules across slices; meaningful cloud slices should each be conducted as a separate Gauntlet run.
argument-hint: "[--wave N] [--cap N] [--track A] [--dry] [--out file] [--autonomous | --cloud]"
allowed-tools: Read, Bash(roadmap:*), Bash(roadmap fan:*), Bash(roadmap plan:*), Bash(roadmap dispatch:*), Bash(roadmap gauntlet:*), Bash(node:*), Bash(git worktree:*), Bash(git fetch:*)
---

You orchestrate concurrency **across** independent roadmap slices. Do not confuse that with the
Gauntlet's implementation/critic/repair iteration **inside** one slice.

1. **Show the plan first.** Run `roadmap plan` (or `roadmap plan --cap N`) and relay the recommended
   cap, binding constraint, and waves.
2. **Choose the cap.** Default to the recommendation. `--cap N` is the user's concurrency knob;
   `--track <lane>` narrows the launch to one lane.
3. **Choose the execution mode per wave.**
   - **Conducted cloud work (recommended for meaningful slices):** start one distinct Gauntlet run
     per selected slice with `gauntlet_start` or `roadmap gauntlet start <key>`. Confirm the set
     immediately before firing because each start consumes Routine usage and creates real GitHub
     work. The lead may oversee several runs concurrently, but it calls `gauntlet_status` and
     makes critic/repair decisions separately for each run. Use one independent critic per run by
     default and never build an automatic repair loop.
   - **Local interactive fanout:** `roadmap fan --wave <N>` opens a lead plus one `claude` process
     per slice in separate worktrees. From inside a Claude session, prefer
     `roadmap fan --wave <N> --dry` or `--out wave<N>.sh`; interactive tmux cannot attach to the
     Bash tool.
   - **Raw one-shot cloud dispatch:** `fan_cloud` / `roadmap fan --cloud` and `dispatch` /
     `roadmap dispatch <key>` remain low-level actuators for explicitly low-risk work, debugging,
     or manual review workflows. They are not independent evaluation and should not be presented
     as a completed Gauntlet.
4. **Honor `execution:` hints.** Local kickoff briefs carry the declared `agent-team`, `subagents`,
   or `solo` topology verbatim. Do not override the requested worker count/composition. The
   Gauntlet role boundary still applies: a builder-side reviewer is not the fresh SHA-pinned
   critic.
5. **Guard unattended local work.** `--autonomous` requires the explicit
   `--autonomous --yes-spawn-autonomous` double acknowledgement. Confirm before using it. No
   launched worker merges.
6. **Conduct, then reconcile.** For each Gauntlet run: implementation PR -> exact-SHA critic ->
   frozen-lead acknowledgment -> lead-synthesized repair -> fresh critic and fresh acknowledgment
   until a stop condition. An acknowledged current-head `PASS` only makes that PR eligible for
   the normal lead/human merge decision. Merge in dependency order, run `/sync`, then recompute
   the next wave with `roadmap plan`.

Cloud Gauntlet V1 is GitHub-first and requires an authenticated `gh` CLI plus role-capable Claude
Routines (`docs/DEPLOYMENT.md` and `docs/GAUNTLET.md`). Local fanout remains cross-platform: if
tmux is unavailable, `roadmap fan` prints the script and WSL guidance instead of guessing.
