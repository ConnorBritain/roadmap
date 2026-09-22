# Roadmap for `roadmap`

The tool plans itself. Canonical state is [`docs/roadmap/roadmap.yaml`](docs/roadmap/roadmap.yaml)
(rendered to [`docs/SLICES.md`](docs/SLICES.md)); live progress is in
[`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md). This file is the narrative.

## PI `core-executor-split` — core + executor packages

Re-architect the flat `scripts/` tree into an npm-workspaces monorepo so the planning/ritual engine
can serve non-engineering work without a mode flag through every command. Design in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). One line per deliverable, one commit per slice:

1. `estimate-native` — port agent-time's estimator (shapes, risks, PERT, calibration cascade, JSONL history) into `estimate-core` with its tests; `meta.estimation.engine` stays as an optional external override.
2. `workspaces` — `packages/core`, `packages/exec-engineering`, `packages/exec-general`, `packages/cli`; the root `roadmap` bin keeps working.
3. `core-extract` — move the pure core modules and their tests into `packages/core`, re-export from the old paths.
4. `gauntlet-split` — protocol, decisions, authorization, receipts and evaluation packets into core; the github-pr `GauntletArtifact` adapter into exec-engineering. The protocol stops knowing it talks to GitHub.
5. `exec-engineering` — fanout, providers, ceilings, doctor, pr-watch as `Executor` implementations; slice-scoper's code grepping becomes the engineering scoper; core keeps a doc-based scoper.
6. `profile-loader` — `meta.profile` (engineering | general, default engineering) read in exactly one place; boundary check enforced.
7. `exec-general` — human and doc-agent executors, git-file `GauntletArtifact`, checklist gates, no ceilings; a general roadmap with no `touches` round-trips plan / render / sync / gauntlet start-critic-ack-repair against a markdown artifact.
8. `skills-agents` — core skills work under both profiles; /fanout and /gauntlet PR text move to engineering; general gains /conduct and /assign; MCP registration follows the profile.
9. `docs` — README becomes concepts + install + a pointer per profile; per-package READMEs; AGENTS.md; MIGRATION.md.
10. `unshim` — remove the shims; full suite, packed install check, end-to-end dry fanout (engineering) and end-to-end conduct loop on a markdown artifact (general).

Constraints held throughout: existing `roadmap.yaml` files work with zero edits; YAML comments
survive every mutation; every interface method has a contract test both implementations pass.
