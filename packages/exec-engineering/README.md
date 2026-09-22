# @connorbritain/roadmap-exec-engineering

Engineering executors for roadmap: the worktree-session and cloud-dispatch Executors, the
github-pr GauntletArtifact, machine ceilings, doctor, PR watch, providers, and the code-grepping
scoper. Depends on `@connorbritain/roadmap-core` only.

Status: complete — the Executors, the artifact adapter, the runtime and every engineering library
live here; the `scripts/lib/*` shims are gone.

## Executors (`docs/ARCHITECTURE.md` § Executor)

| Module | Executor | Notes |
|---|---|---|
| `worktree-session` | `worktreeSessionExecutor({ root, disk?, reviewDebt?, execImpl?, files?, localConfig?, platform? })` | one terminal session per slice in its own git worktree. Also exports the wave planner (`planWave`), launch settings, the tmux / wt / warp / print / background renderers (`renderWaveScript`, `renderSingleScript`), `planGrab`, `pruneWorktrees`, and `spawnLaunchScript`. `scripts/{fanout,grab,cleanup}.mjs` are thin argv shells over these. |
| `cloud-dispatch` | `cloudDispatchExecutor({ root, dispatch?, listOpenPrs?, reviewCeiling? })` | fires a cloud agent (`runDispatch`) and reads receipts back from open PRs carrying the `roadmap: slice=<key>` marker. `planCloudWave` is `fan --cloud`'s wave. No machine ceilings; the review ceiling still binds. |
| `scoper` | `engineeringScope(node, graph, { root, files?, execImpl? })` | core's `genericScope` (gate, read order, sessions) plus code-derived `touches` from the tracked files whose path words match the slice's own words. Proposals only. |
| `plan-engineering` | `engineeringPlanContext({ disk?, reviewDebt?, cwd })` | the `{ capacity, annotate }` pair `buildPlan` takes: the five ceilings and per-node branch / worktree / prompt / weight. |

## Other modules (`src/`)

| Module | Role |
|---|---|
| `github-pr-artifact` | the github-pr `GauntletArtifact`: a pull request is the artifact, exact head = 40-hex SHA, comments = PR issue comments, claims = protected refs under `roadmap-gauntlet-locks/*`, actor = the `gh` login. Exposes the canonical interface plus the GitHub-era method names. |
| `github-authority-store` | the protected-Git-objects compare-and-swap journal behind core's `gauntlet-authority` store interface. |
| `gauntlet-runtime`, `gauntlet-portfolio-io`, `gauntlet-observation` | the Gauntlet actuators (start / status / critic / ack / repair / cancel), the portfolio read-out, and provider observation. |
| `evaluate-runtime`, `evaluation-io`, `evaluation-review-io` | the documentation-only evaluation family (git index / apply, review IO). |
| `cloud-agent-providers`, `dispatch-providers` | remote-agent provider mechanics and Git-host dispatch adapters (kept apart on purpose). |
| `brief`, `fanout-core`, `wizard-core`, `assistant-core` | kickoff briefs, launch-script fragments, the wizard's pure decisions, assistant profiles. |
| `recommend`, `external-state`, `doctor-core`, `pr-identity`, `pr-watch-core`, `reconcile-core` | ceilings, git/gh probes, drift doctor, PR markers, PR watch, merged-PR reconciliation. |

## Tests

`test/github-pr-artifact.mjs` and `test/executors.mjs` register the core contracts
(`packages/core/test/contracts/{gauntlet-artifact,executor}.mjs`) against fakes; `test/launchers.mjs`
replays the launcher CLIs' dry runs against the golden fixtures in `scripts/test/fixtures/launchers/`.
The root `npm test` imports all three.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and [`docs/roadmap/STATUS.md`](../../docs/roadmap/STATUS.md).
