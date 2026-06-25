# AGENTS.md

This repo is designed to be workable from Codex without any repo-specific bootstrapping.

## What This Repo Is

`slice-roadmap` is a Node-based CLI plus MCP server for managing `docs/roadmap/roadmap.yaml` as the canonical source of truth and generating `docs/SLICES.md`.

The repo still contains Claude-oriented plugin assets under `.claude-plugin/`, `skills/`, `agents/`, `hooks/`, and `monitors/`. In Codex, the most reliable surfaces are:

- the CLI in [`scripts/cli.mjs`](C:\Users\connor.england\.codex\worktrees\66df\slice-roadmap\scripts\cli.mjs)
- the MCP server in [`scripts/mcp.mjs`](C:\Users\connor.england\.codex\worktrees\66df\slice-roadmap\scripts\mcp.mjs)
- the pure logic in [`scripts/lib`](C:\Users\connor.england\.codex\worktrees\66df\slice-roadmap\scripts\lib)

## Working Agreements

- Treat `docs/roadmap/roadmap.yaml` as canonical when it exists.
- Treat `docs/SLICES.md` as generated output. Never hand-edit it unless the user explicitly asks.
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

## Codex-Specific Notes

- Codex can use this repo directly through shell commands; no Claude plugin install is required.
- The fanout launcher in [`scripts/fanout.mjs`](C:\Users\connor.england\.codex\worktrees\66df\slice-roadmap\scripts\fanout.mjs) still launches `claude` worker processes today. Keep that behavior unless the user explicitly asks to generalize it.
- If you change roadmap structure or mutation behavior, run both `npm test` and `npm run validate`.
