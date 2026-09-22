# @connorbritain/roadmap-exec-general

General (non-engineering) executors for roadmap: human + doc-agent, the git-file GauntletArtifact,
checklist gates, no resource ceilings.

Status: registered with the profile loader (`profile(root)` in `index.mjs`) as a core-only profile
— no executor, commands, tools or skills yet, so planning falls back to core's default capacity.
The `exec-general` slice fills it in. A `meta.profile: general` roadmap already validates, plans,
shows and answers the core MCP tools through this registration.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and [`docs/roadmap/STATUS.md`](../../docs/roadmap/STATUS.md).
