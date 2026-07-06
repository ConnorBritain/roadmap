# AGENTS.md

This repo is designed to be workable from Codex without any repo-specific bootstrapping.

## What This Repo Is

`roadmap` is a Node-based CLI plus MCP server for managing two canonical YAML files — `docs/roadmap/roadmap.yaml` (the planned roadmap graph) and `docs/roadmap/backlog.yaml` (the erratic-work backlog) — and generating `docs/SLICES.md` + `docs/BACKLOG.md` from them.

The repo still contains Claude-oriented plugin assets under `.claude-plugin/`, `skills/`, `agents/`, `hooks/`, and `monitors/`. In Codex, the most reliable surfaces are:

- the CLI in [`scripts/cli.mjs`](scripts/cli.mjs)
- the MCP server in [`scripts/mcp.mjs`](scripts/mcp.mjs) (server name `graph`; roadmap + backlog tools)
- the pure logic in [`scripts/lib`](scripts/lib)

## Working Agreements

- Treat `docs/roadmap/roadmap.yaml` and `docs/roadmap/backlog.yaml` as canonical when they exist.
- Treat `docs/SLICES.md` and `docs/BACKLOG.md` as generated output. Never hand-edit them unless the user explicitly asks.
- Mutations go through the yaml Document API behind a pre-write validation gate (`lib/store.mjs` — `mutateRoadmap` / `mutateBacklog` / `mutateBoth`); never write the YAMLs with ad-hoc string edits.
- Prefer small changes in the pure libraries under `scripts/lib/` and keep the CLI wrappers thin.
- Preserve zero-dependency behavior in tests except for the existing `yaml` dependency.
- Keep changes cross-platform when possible. This repo intentionally supports PowerShell/Windows and tmux/bash flows.

## Useful Commands

- `npm test`
- `npm run validate`
- `npm run render`
- `npm run plan`
- `npm run mcp`
- `node scripts/cli.mjs show <slice>`
- `node scripts/cli.mjs next` · `backlog` · `set <slice> f=v` · `grab <id>` · `promote <id> --pi <pi>` · `linear status|sync`

## Linear (optional)

When `meta.linear` exists, the YAML projects to Linear (push) and inbound issues arrive as proposals (pull) — see README → Linear. The pure brain is `scripts/lib/linear-core.mjs`; ALL network IO lives in `scripts/linear.mjs` (injectable transport — tests use a fake, never the API). No `meta.linear` → all Linear behavior is off; keep it that way (backward compat is asserted by tests).

## Codex-Specific Notes

- Codex can use this repo directly through shell commands; no Claude plugin install is required.
- The fanout launcher in [`scripts/fanout.mjs`](scripts/fanout.mjs) still launches `claude` worker processes today. Keep that behavior unless the user explicitly asks to generalize it.
- If you change roadmap/backlog structure or mutation behavior, run both `npm test` and `npm run validate`.
