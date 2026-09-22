# Status — PI `core-executor-split`

Last updated: 2026-09-22 · branch `claude/roadmap-core-executor-split-hjrbxn` · baseline `main@565f96c`
(448 tests passing).

Canonical state: [`roadmap.yaml`](roadmap.yaml) · rendered: [`../SLICES.md`](../SLICES.md) ·
design: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) · narrative: [`../../ROADMAP.md`](../../ROADMAP.md).

## Resume here

Step 1 (plan) is done: ARCHITECTURE.md, this PI, CONTRIBUTING.md's "Resuming work" rule, and the
boundary check are committed. Step 2 starts with `estimate-native` (the agent-time fold-in),
which must land before `estimate-core` moves into `packages/core`.

Next command: `roadmap show estimate-native`.

## Slices

| # | Slice | Status | Commit | Note |
|---|---|---|---|---|
| 1 | `estimate-native` | next | — | port agent-time's estimator to JS; engine override stays |
| 2 | `workspaces` | scheduled | — | |
| 3 | `core-extract` | scheduled | — | shims at old paths |
| 4 | `gauntlet-split` | scheduled | — | protocol never learns it's GitHub |
| 5 | `exec-engineering` | scheduled | — | |
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
