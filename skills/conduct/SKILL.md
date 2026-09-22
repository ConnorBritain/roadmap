---
name: conduct
description: Conduct a roadmap slice through the general profile's review loop on a document artifact — freeze the bar, assign the work, launch an independent critic at the exact committed version, acknowledge the verdict as the frozen lead, synthesize a repair packet, re-critic, then reconcile. No pull request, no cloud provider; the artifact is a file at a commit. Profile: general.
argument-hint: "<slice-or-backlog-key> [--executor human|doc-agent] [--assignee who]"
allowed-tools: Read, Bash(roadmap:*), Bash(roadmap conduct:*), Bash(roadmap show:*), Bash(git log:*), Bash(git show:*), mcp__plugin_roadmap_graph__show, mcp__plugin_roadmap_graph__conduct_start, mcp__plugin_roadmap_graph__conduct_status, mcp__plugin_roadmap_graph__conduct_critic, mcp__plugin_roadmap_graph__conduct_verdict, mcp__plugin_roadmap_graph__conduct_ack, mcp__plugin_roadmap_graph__conduct_repair, mcp__plugin_roadmap_graph__conduct_reconcile
---

**Profile: general** (`meta.profile: general`). Under the engineering profile use `/gauntlet`
instead; the protocol is the same, the artifact is a pull request there.

You are the long-lived lead conducting a review loop on a document. You hold intent, context,
and judgment; a person or a doc-agent session produces the artifact, an independent critic reads
it at an exact committed version, and you decide. The committed sidecar under
`.roadmap/gauntlet/` is durable reality; `.roadmap-gauntlet-state.json` is only a cache.

Prefer the `graph` MCP tools `conduct_start`, `conduct_status`, `conduct_critic`,
`conduct_verdict`, `conduct_ack`, `conduct_repair`, `conduct_reconcile`. The identical CLI family:

```text
roadmap conduct start|status|critic|verdict|ack|repair|reconcile
```

1. **Orient and make the bar observable.** `show` the subject and read its checklist gate,
   `what`, prompt, read order and `artifact` path (default `docs/roadmap/artifacts/<key>.md`).
   Turn vague success language into criteria a reviewer can confirm line by line, without
   expanding scope. The person doing the work must not define their own grading criteria.
2. **Inspect before actuating.** `conduct_status` for the key first; resume an active run instead
   of starting a duplicate. State names: `awaiting_pr` (no committed artifact yet),
   `awaiting_critic`, `critic_in_flight`, `awaiting_lead_ack`, `needs_repair`,
   `repair_in_flight`, `passed`, `exhausted`, `human_required`.
3. **Start deliberately.** Explain the frozen bar and confirm, then `conduct_start` with the
   executor (`human` writes an assignment brief under `.roadmap/assignments/`; `doc-agent` also
   starts the configured assistant at the repository root) and, for a person, the assignee.
   The bar is committed to the artifact's sidecar; the run is claimed with an atomic git ref.
4. **Wait for a committed artifact.** The worker writes the file and commits it. `conduct_status`
   then reports `awaiting_critic` with the exact head (the last commit touching the file).
5. **Launch a fresh critic at that exact head.** `conduct_critic` with `expected_head`. It
   records the launch, posts the lead attestation to the sidecar, and writes the critic brief
   (a person reads `.roadmap/assignments/<key>.critic-r<N>.md`; the doc-agent gets it as its
   prompt). Never review the artifact yourself in place of the critic.
6. **The critic posts its verdict** with `conduct_verdict` (`PASS`, `REVISE`, `HUMAN_REQUIRED`,
   `INVALID_OR_STALE`) and a rationale; it is bound to the launch nonce and immutable in git.
7. **Inspect and acknowledge the exact comment.** Refresh status, read the verdict's evidence
   against the artifact and the bar, then `conduct_ack` with its exact locator and
   `confirm=true`. A verdict drives nothing until acknowledged; a stale one never counts.
8. **On `REVISE`, write the repair packet yourself.** Separate must-fix from preference; reject
   scope creep; name only accepted changes with their evidence. Confirm, then `conduct_repair`
   with the exact expected head. The worker edits the same file and commits; the head moves.
9. **Re-critic the new version** (step 5 at the new head) and acknowledge again. Never carry an
   old verdict forward. Default maximum: three repair rounds.
10. **Stop and reconcile.** An acknowledged current-head `PASS` ends the loop.
    `conduct_reconcile` proposes the slice complete; with `apply=true` it writes the status
    through the store (YAML comments preserved). Leftovers go to the backlog only; workers and
    critics never create PIs or sprints.
