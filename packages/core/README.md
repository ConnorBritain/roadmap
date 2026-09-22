# @connorbritain/roadmap-core

The planning + ritual engine: graph, store, priority, render, validate, backlog, review, plan,
linear, estimate, and (from the `gauntlet-split` slice on) the Gauntlet protocol. Imports no
executor: nothing here knows about CPUs, disks, branches, worktrees, PRs or cloud providers.
`scripts/check-boundaries.mjs` enforces that on every `npm test`.

## Modules (`src/`)

| Module | Role |
|---|---|
| `graph` | parse `roadmap.yaml`, flatten PIs → sprint nodes, deps, cycles, ready set, wave packing |
| `priority` | `{ tier, weight, reason }` validation + the derived comparator |
| `store` | the one read → mutate → validate → write → re-render path (YAML Document API, comments preserved) |
| `mcp-core` | MCP tool registry, read handlers, Document mutations, pre-write integrity gate |
| `backlog-core`, `backlog-audit` | the erratic-work tracker and its collision-damage detector |
| `render-core` | `SLICES.md` renderer |
| `validate-core` | structural + dependency + cycle validator |
| `plan` | the execution plan; capacity and per-node annotation are injected by the executor |
| `execution` | the `execution:` staffing-topology vocabulary |
| `sync-core` | scope discipline (capture ratio, sprawl warnings) |
| `review-core`, `journal-core` | the `/debrief` digest and tracker progress notes (branch resolver injected) |
| `linear-core`, `plate-core`, `cycle-core` | the Linear projection brain, the plate, the weekly election |
| `init-core`, `cli-core` | scaffolding blueprints; CLI routing tables |
| `estimate-core`, `estimator-core` | native agent-time estimation model, timeline rollup, calibration idempotency |
| `model-policy` | requested-vs-transport-vs-actual model honesty (used by the gauntlet protocol) |
| `gauntlet-artifact` | the `GauntletArtifact` interface: neutral Artifact/Comment shapes, `asGauntletArtifact`, `assertGauntletArtifact`, `commentWasEdited` |
| `gauntlet-core` | the protocol: markers, digests, frozen bar, verdict derivation, run state machine, worker prompts (backend wording injected) |
| `gauntlet-authorization`, `gauntlet-authority` | bounded-execution state machine; the store-agnostic compare-and-swap journal (`mutateAuthorization`, `recordRunContinuation`) |
| `gauntlet-decisions`, `implementation-authorization`, `evaluation-review-core`, `gauntlet-portfolio-core` | attributable lead decisions; capacity reservation; the evaluation review loop; portfolio reporting |
| `subject-marker` | the `roadmap: slice=<key>` identity grammar |
| `gauntlet-store`, `evaluation-core`, `evaluation-packet` | local ledger; evaluation run policy; evidence-packet schema |

Import a module as `@connorbritain/roadmap-core/<module>.mjs`. Until the `unshim` slice, the
old `scripts/lib/<module>.mjs` paths re-export from here.

## Tests

`test/harness.mjs` is the tiny shared harness (no framework). Each `test/*.mjs` file runs its
tests on import; the root `npm test` imports them and adds the engineering and gauntlet suites to
the same summary. `test/fixtures.mjs` holds the Linear fixtures both runners share.
`test/contracts/gauntlet-artifact.mjs` is the interface contract every `GauntletArtifact`
implementation registers; `test/fixtures/memory-artifact.mjs` is the in-memory reference it is
validated against.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and
[`docs/roadmap/STATUS.md`](../../docs/roadmap/STATUS.md).
