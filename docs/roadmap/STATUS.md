# Status — PI `core-executor-split`

Last updated: 2026-09-22 · branch `claude/roadmap-core-executor-split-hjrbxn` · baseline `main@565f96c`
(448 tests passing).

Canonical state: [`roadmap.yaml`](roadmap.yaml) · rendered: [`../SLICES.md`](../SLICES.md) ·
design: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) · narrative: [`../../ROADMAP.md`](../../ROADMAP.md).

## Resume here

Step 1 (plan) landed in `729e343`. Slice 1 `estimate-native` is complete: the agent-time model is
ported to `scripts/lib/estimator-core.mjs`, `roadmap estimate` prices natively (no Python), the
history stays agent-time's `history.jsonl` format, and an external `estimator.py` is used only when
`meta.estimation.engine` / `$AGENT_TIME_ENGINE` is set. Next is `workspaces`.

Next command: `roadmap show workspaces`.

## Slices

| # | Slice | Status | Commit | Note |
|---|---|---|---|---|
| 1 | `estimate-native` | complete | (this branch, slice 1 commit) | 462 tests; agent-time's test suite ported |
| 2 | `workspaces` | next | — | |
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
