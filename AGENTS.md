# AGENTS.md

This repo is designed to be workable from Codex without any repo-specific bootstrapping.

## What This Repo Is

`roadmap` is a Node-based CLI plus MCP server for managing two canonical YAML files —
`docs/roadmap/roadmap.yaml` (the planned roadmap graph) and `docs/roadmap/backlog.yaml` (the
erratic-work backlog) — and generating `docs/SLICES.md` + `docs/BACKLOG.md` from them. Its
execution model is a conducted review loop with a frozen quality bar: plan -> worker ->
independent critic at an exact version -> frozen-lead acknowledgment -> lead-synthesized repair
-> fresh critic and acknowledgment -> merge/complete decision -> reconcile. Under the
**engineering** work profile (the default) that is the [Gauntlet](docs/GAUNTLET.md) on a GitHub
PR; under **general** (`meta.profile: general`) it is `roadmap conduct` on a file at a commit.

It is an npm-workspaces monorepo ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- [`packages/core`](packages/core) — the planning + ritual engine and the protocol; imports no executor
- [`packages/exec-engineering`](packages/exec-engineering) — `worktree-session` + `cloud-dispatch` executors, the `github-pr` artifact, ceilings, doctor, PR watch
- [`packages/exec-general`](packages/exec-general) — `human` + `doc-agent` executors, the `git-file` artifact, the conducted loop
- [`packages/cli`](packages/cli) — the profile loader, the ONLY reader of `meta.profile`
- the CLI in [`scripts/cli.mjs`](scripts/cli.mjs), the MCP server in [`scripts/mcp.mjs`](scripts/mcp.mjs)
  (server name `graph`; core tools plus the loaded profile's), thin command scripts in `scripts/`
- there is no `scripts/lib/` any more: import the packages by name.

The Claude plugin assets live under `.claude-plugin/`, `skills/`, `agents/`, `hooks/`, and `monitors/`.

## Working Agreements

- Treat `docs/roadmap/roadmap.yaml` and `docs/roadmap/backlog.yaml` as canonical when they exist.
- Treat `docs/SLICES.md` and `docs/BACKLOG.md` as generated output. Never hand-edit them unless the user explicitly asks.
- Mutations go through the yaml Document API behind a pre-write validation gate (`packages/core/src/store.mjs` — `mutateRoadmap` / `mutateBacklog` / `mutateBoth`); never write the YAMLs with ad-hoc string edits.
- Prefer small changes in the pure libraries under `packages/*/src/` and keep the CLI wrappers in `scripts/` thin.
- Keep the split honest: core never imports an executor package; only `packages/cli/src/profile.mjs`
  reads `meta.profile`; no core command branches on the profile — it asks the loaded profile
  (`commands`, `validators`, `planContext`, `mcp`, `nudge`, `sessionHint`). `scripts/check-boundaries.mjs`
  runs in `npm test`. Every `Executor` / `GauntletArtifact` implementation registers the core contract test.
- Preserve zero-dependency behavior in tests except for the existing `yaml` dependency.
- Keep changes cross-platform when possible. This repo intentionally supports PowerShell/Windows and tmux/bash flows.
- Keep Gauntlet V1 GitHub-first and reconstructable. GitHub PRs/comments are durable reality;
  lead-authored launch precommits and verdict acknowledgments bound to both the exact body and
  GitHub comment-URL digests authenticate recovered rounds. Protected `roadmap-gauntlet-locks/*`
  branches are durable distributed claims. Their required ruleset restricts creation, updates,
  and deletion to the trusted lead/service bypass actor, blocks force pushes, and excludes workers.
  `.roadmap-gauntlet-state.json` is a gitignored launch ledger/cache, not a database and never a
  credential/transcript store.
- Pre-PR cancellation creates a protected shared tombstone so delayed worker output cannot
  resurrect the run after local-ledger loss. Its detailed human reason remains local until a PR
  exists and a lead-authored cancellation comment can carry it.
- A conductor that loses the implementation election must not persist its candidate packet or
  silently trust the winner. Status exposes a differing winning PR protocol read-only; only that
  packet's authenticated frozen lead may inspect and explicitly confirm it through an actuator,
  which then adopts it and upserts authenticated GitHub launch attestations before mutation.
- Treat PR head SHA as an optimistic-concurrency token. A critic verdict counts only for the
  exact current head; repair aborts if its expected head moved. Never force-push around this.
- Keep the lead intelligent: runtime code provides senses, actuators, markers, and idempotency;
  it does not blindly translate critic findings into repairs or auto-merge.
- Keep remote-agent provider mechanics isolated from Git-host dispatch adapters. Provider receipts use
  exact external IDs/URLs; never associate a Codex task by recency, create a local worktree for a
  Codex Cloud worker, or silently fall back to Claude. Codex environment IDs are committed config,
  secrets are never committed, and current Cloud model/PR-publication limits must stay explicit.

## Useful Commands

- `npm test`
- `npm run validate`
- `npm run render`
- `npm run plan`
- `npm run mcp`
- `node scripts/cli.mjs show <slice>`
- `node scripts/cli.mjs next` · `backlog` · `set <slice> f=v` · `grab <id>` · `promote <id> --pi <pi>` · `review [--json]`
- `node scripts/cli.mjs gauntlet start|status|critic|ack|repair|cancel ...` (engineering)
- `node scripts/cli.mjs conduct start|status|critic|verdict|ack|repair|reconcile ...` · `assign <key> --to <who>` (general)
- Low level: `node scripts/cli.mjs dispatch <key>` · `fan --cloud`; optional projection:
  `linear status|provision|sync`
- `node scripts/check-boundaries.mjs` · `npm run pack:all && npm run test:packed -- dist`

The matching MCP tools are `gauntlet_start`, `gauntlet_status`, `gauntlet_critic`,
`gauntlet_ack`, `gauntlet_repair`, and `gauntlet_cancel` under engineering (`dispatch` and
`fan_cloud` remain debuggable lower-level actuators), and `conduct_start`, `conduct_status`,
`conduct_critic`, `conduct_verdict`, `conduct_ack`, `conduct_repair`, `conduct_reconcile`, `assign`
under general.

## Scope discipline

Worker sessions file leftovers to the **backlog only** — never add sprints or PIs (scope decisions belong to the human; the kickoff brief and tool descriptions say so). `/sync` and `roadmap review` surface sprawl warnings when captures outrun completions (`meta.discipline.capture_ratio`). Wave packing prefers finishing started PIs (`meta.discipline.coherence`, default on, strictly below declared priority).

## Deployment

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) is authoritative for CLI/plugin/MCP/CI surfaces,
provider/Routine resolution, GitHub requirements, and secret placement. Never write a credential
into a repo, PR/comment, or `.roadmap-gauntlet-state.json`. Routine credentials may live in
environment variables or the protected machine-local `~/.claude-routines.json`; `LINEAR_API_KEY`
stays in the environment.

## Gauntlet (primary execution, engineering profile)

Meaningful cloud slices should use `/gauntlet` or the Gauntlet tool/CLI family, not one-shot
delegation followed by hope. Under the general profile the same protocol runs as `/conduct` on a
`git-file` artifact ([packages/exec-general/README.md](packages/exec-general/README.md)). Freeze the quality bar before implementation and carry it in the
ledger plus implementation PR body. Use one fresh critic by default and at most three repair
rounds by default. Critics are advisory; the long-lived lead deduplicates findings, rejects scope
creep, acknowledges the exact critic artifact before it can drive state, and writes the repair
packet. Repeat inspection and acknowledgment after every fresh critic. No worker or roadmap
command merges automatically.

Role-aware Routine keys extend existing config:

```text
<repo>#<role> / default#<role>
<repo>#<role>#<tier> / default#<role>#<tier>
```

Preserve existing repo/tier/default fallbacks, and never silently downgrade an explicitly
requested tier. See [docs/GAUNTLET.md](docs/GAUNTLET.md) for the full contract.

## Linear (optional)

When `meta.linear` exists, the YAML projects to Linear (push) and inbound issues arrive as proposals (pull) — see README → Linear. The pure brain is `packages/core/src/linear-core.mjs`; ALL network IO lives in `packages/core/src/linear-io.mjs` (`scripts/linear.mjs` is its CLI) (injectable transport — tests use a fake, never the API). No `meta.linear` → all Linear behavior is off; keep it that way (backward compat is asserted by tests).

## Codex-Specific Notes

- Codex can use this repo directly through shell commands; no Claude plugin install is required.
- The local fanout launcher (`scripts/fanout.mjs` over the `worktree-session` executor) still
  launches `claude` worker processes. Fanout schedules across slices; a Gauntlet iterates within
  one slice. Keep those dimensions separate.
- Resuming an in-flight initiative on this repo: read [docs/roadmap/STATUS.md](docs/roadmap/STATUS.md)
  first ([CONTRIBUTING.md](CONTRIBUTING.md) § Resuming work).
- If you change roadmap/backlog structure or mutation behavior, run both `npm test` and `npm run validate`.
