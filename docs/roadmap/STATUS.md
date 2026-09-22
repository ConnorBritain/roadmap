# Status — PI `core-executor-split`

Last updated: 2026-09-22 · branch `claude/roadmap-core-executor-split-hjrbxn` · baseline `main@565f96c`
(448 tests passing).

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
adapter. The runtime still calls the adapter by its GitHub-era method names through
`asGauntletArtifact`; it switches to the canonical names when it moves in `exec-engineering`. Next
is `exec-engineering`.

Next command: `roadmap show exec-engineering`.

## Slices

| # | Slice | Status | Commit | Note |
|---|---|---|---|---|
| 1 | `estimate-native` | complete | `682b575` | 462 tests; agent-time's test suite ported |
| 2 | `workspaces` | complete | `d32b04d` | packages scaffolded; packed check covers all tarballs |
| 3 | `core-extract` | complete | `384282d` | 24 modules + core tests moved; 7 edges cut; shims remain |
| 4 | `gauntlet-split` | complete | (this branch, slice 4 commit) | 475 tests; contract on memory + github-pr |
| 5 | `exec-engineering` | next | — | |
| 6 | `profile-loader` | scheduled | — | single `meta.profile` reader |
| 7 | `exec-general` | scheduled | — | general round-trip fixture is the exit test |
| 8 | `skills-agents` | scheduled | — | |
| 9 | `docs` | scheduled | — | |
| 10 | `unshim` | scheduled | — | |

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
