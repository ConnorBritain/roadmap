# Status — PI `core-executor-split`

Last updated: 2026-09-22 · branch `claude/roadmap-core-executor-split-hjrbxn` · baseline `main@565f96c`
(448 tests passing; 499 after slice 5).

Canonical state: [`roadmap.yaml`](roadmap.yaml) · rendered: [`../SLICES.md`](../SLICES.md) ·
design: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) · narrative: [`../../ROADMAP.md`](../../ROADMAP.md).

## Resume here

Step 1 (plan) landed in `729e343`. Slice 1 `estimate-native` is complete: the agent-time model is
ported to `scripts/lib/estimator-core.mjs`, `roadmap estimate` prices natively (no Python), the
history stays agent-time's `history.jsonl` format, and an external `estimator.py` is used only when
`meta.estimation.engine` / `$AGENT_TIME_ENGINE` is set. Slice 2 `workspaces` is complete: four
workspace packages scaffolded, the root depends on them by exact version, `npm run pack:all` +
`npm run test:packed -- dist` install all five tarballs together. Slice 3 `core-extract` is
complete: 24 modules live in `packages/core/src` (shims at `scripts/lib/*`), the seven mixed edges
are cut (boundary check: 0 known edges), and the core-only test sections (1,710 lines) run from
`packages/core/test` through a shared harness. Sections still in `scripts/test/run.mjs` that
exercise core through the shims are the mixed ones (they assert on branches, PRs, `linear.mjs` or
`estimate.mjs`); they migrate with their engineering halves. Slice 4 `gauntlet-split` is complete:
the protocol lives in core and reads only the neutral artifact shape; the github-pr adapter and the
protected authority store live in exec-engineering; the runtime is `scripts/lib/gauntlet-runtime.mjs`
(no import cycles left); the contract test passes on the in-memory reference and the github-pr
adapter. Slice 5 `exec-engineering` is complete: every engineering library and the gauntlet runtime
live in `packages/exec-engineering/src` (shims at `scripts/lib/*`); the CLI bodies of `linear`,
`estimate`, `cycle` (core `*-io.mjs`) and `dispatch`, `evaluate` (`cloud-dispatch.mjs`,
`evaluate-runtime.mjs`) moved out of their script files; the Executor interface, its contract test
and the generic scoper are in core (`executor.mjs`); `worktreeSessionExecutor` and
`cloudDispatchExecutor` pass the contract; `fanout`/`grab`/`cleanup` are thin CLIs whose dry runs
are pinned byte for byte by golden fixtures (`scripts/test/fixtures/launchers/`). The gauntlet
runtime still calls the adapter by its GitHub-era names through `asGauntletArtifact`; the
canonical-name switch is deferred to `unshim`. Dogfooding note: `roadmap estimate --all` wrote
native `estimate:` blocks into this PI's slices (uncalibrated priors; the first `roadmap estimate
log` outcomes will calibrate them). Slice 6 `profile-loader` is complete: `packages/cli/src/profile.mjs`
is the single `meta.profile` reader (engineering when absent; any other value is an error); both
executor packages export `profile(root)` and the loader merges core's commands/skills on top;
`cli.mjs`, `validate.mjs`, `scheduler.mjs` and `mcp.mjs` consume the loaded profile (command map,
validators, plan context, MCP tools); the engineering MCP tables live in
`packages/exec-engineering/src/mcp-engineering.mjs`; the schema declares `meta.profile`; a general
roadmap with no `touches` and checklist gates round-trips validate / plan / show / MCP with zero
edits (`packages/cli/test/profile.mjs`). Backlog b3 (MCP server version) closed in passing. Slice 7
`exec-general` is complete: `human` + `doc-agent` Executors (brief files as receipts), the `git-file`
GauntletArtifact (committed sidecar, atomic git-ref claims) on the core contract, general validators,
and the conducted loop (`conduct.mjs`: start / status / critic / verdict / ack / repair / reconcile)
with `roadmap conduct` / `roadmap assign` and `conduct_*` MCP tools; core gained the `artifact`
field, checklist-gate rendering and gate/artifact validation. The exit test round-trips a
touches-free general roadmap through the whole loop on a markdown artifact and survives ledger
loss. Slice 8 `skills-agents` is complete: `/conduct` + `/assign` skills (general), profile banners
on `/fanout` + `/gauntlet`, both-profile wording in `/sync` `/backlog` `/slice` `/init` and the
agents, hooks re-pointed at the packages and driven by the profile's `nudge` / `sessionHint`
(the Stop hook is engineering-only), manifests updated; `packages/cli/test/plugin-assets.mjs`
pins skills to the registries and runs both hooks per profile. Slice 9 `docs` is complete: the
README is concepts + quickstart + work profiles + install (~200 lines) with a pointer per profile;
the long-form engineering reference moved verbatim to `docs/REFERENCE.md`; `MIGRATION.md` states
that no YAML changes are required and lists the import-path moves; AGENTS.md, CONTRIBUTING.md,
DEPLOYMENT.md and the package READMEs point at the packages; the plugin-assets test pins the doc
set. Slice 10 `unshim` is complete: the 49 `scripts/lib/*` shims are deleted and every script,
hook and test imports the packages by name; the gauntlet runtime, the evaluation IO and the GitHub
authority store call the artifact by its canonical names (`fetch`, `actor`, `comment`,
`descendsFrom`, `claim`, `readClaim`, `listClaims`, `assertClaimSafety`; legacy-named clients are
still accepted through `asGauntletArtifact`); `npm run test:e2e` runs the dry-fanout goldens and
the general conduct loop on their own. **The PI is complete.** Gates at the last commit: 524 tests,
boundary check clean, packed install of all five tarballs green, e2e green.

The PI merged to `main` in PR #56. The three backlog items are closed: b1 (the schemas now declare
`command_lane`, `assistants`, `jira` and backlog `meta.audit`; `packages/core/test/schema.mjs` pins
every meta key the code reads to the schema), b2 (watch-prs and worktree pruning read from
`external-state`'s one set of gatherers), b3 (MCP server version).

Next command: `roadmap next` (nothing is ready; the roadmap is complete).

## Slices

| # | Slice | Status | Commit | Note |
|---|---|---|---|---|
| 1 | `estimate-native` | complete | `682b575` | 462 tests; agent-time's test suite ported |
| 2 | `workspaces` | complete | `d32b04d` | packages scaffolded; packed check covers all tarballs |
| 3 | `core-extract` | complete | `384282d` | 24 modules + core tests moved; 7 edges cut; shims remain |
| 4 | `gauntlet-split` | complete | `dfbc8c9` | 475 tests; contract on memory + github-pr |
| 5 | `exec-engineering` | complete | `c1bd959` | 499 tests; Executor contract on memory + worktree-session + cloud-dispatch; golden launcher fixtures |
| 6 | `profile-loader` | complete | `75ce038` | 504 tests; single reader + rule 1c in the boundary check |
| 7 | `exec-general` | complete | `5330492` | 522 tests; git-file + human + doc-agent on the contracts; round-trip exit test |
| 8 | `skills-agents` | complete | `71d0e4b` | 524 tests; skills pinned to the registries; hooks per profile |
| 9 | `docs` | complete | `7f0ec68` | README 618 → 202 lines; REFERENCE.md; MIGRATION.md |
| 10 | `unshim` | complete | (this branch, slice 10 commit) | shims gone; canonical artifact names; test:e2e |

## Decisions log

- 2026-09-22 — Fold-in first: port agent-time to JS as slice 1 rather than sequencing it after the
  split, so core never depends on a Python engine. `meta.estimation.engine` remains an optional
  override for the external estimator.
- 2026-09-22 — Keep the name `meta.profile` as briefed; document the distinction from assistant
  profiles and Routine profiles in ARCHITECTURE.md.
- 2026-09-22 — GauntletArtifact carries a durability group (actor, claim, descendsFrom,
  assertClaimSafety) beyond freeze/head/fetch/comment/ack, because every actuator today runs
  identity → claim probe → atomic claim → attestation → launch. General backends answer or fail closed.
- 2026-09-22 — Boundary check runs on `scripts/lib` allowlists until packages exist, with an
  explicit expected-violations list that shrinks per slice, so it is green from day 1.
