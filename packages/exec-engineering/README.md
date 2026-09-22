# @connorbritain/roadmap-exec-engineering

Engineering executors for roadmap: worktree-session + cloud-dispatch Executors, the github-pr
GauntletArtifact, ceilings, doctor, PR watch, providers, and the code-grepping scoper.

Status: the `gauntlet-split` slice landed the artifact adapter; the executors move in with the
`exec-engineering` slice.

## Modules (`src/`)

| Module | Role |
|---|---|
| `github-pr-artifact` | the github-pr `GauntletArtifact`: a pull request is the artifact, exact head = 40-hex SHA, comments = PR issue comments, claims = protected refs under `roadmap-gauntlet-locks/*`, actor = the `gh` login. Exposes the canonical interface plus the GitHub-era method names. `normalizeGauntletPr` maps `gh --json` output onto the neutral artifact shape; `normalizingGauntletClient` wraps any client (real or test fake) the runtime is handed. |
| `github-authority-store` | the protected-Git-objects compare-and-swap journal behind core's `gauntlet-authority` store interface. |

## Tests

`test/github-pr-artifact.mjs` registers the core contract (`packages/core/test/contracts/gauntlet-artifact.mjs`)
against a fake `gh` and checks the GitHub-specific normalization. The root `npm test` imports it.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and [`docs/roadmap/STATUS.md`](../../docs/roadmap/STATUS.md).
