# Contributing

## Setup

```bash
npm ci
npm test                      # 520+ pure tests, ~30 s, no network (includes the boundary check)
npm run validate              # this repo's own docs/roadmap/roadmap.yaml
npm run pack:all && npm run test:packed -- dist   # installed-tarball smoke: root + every workspace package
```

The repo is an npm-workspaces monorepo: `packages/core`, `packages/exec-engineering`,
`packages/exec-general`, `packages/cli`. The root package `@connorbritain/roadmap` owns the
`roadmap` bin and depends on the workspace packages by exact version, so `npm ci` links them and
`npm run pack:all` produces one tarball per package plus the root.

`packages/cli/src/profile.mjs` is the only reader of `meta.profile`; it loads the executor package
and every surface asks it for what differs. `scripts/check-boundaries.mjs` (part of `npm test`)
refuses a core → executor import, a second `meta.profile` reader, or a stray import of the general
package. New executors and artifacts register the contract tests under `packages/core/test/contracts/`.

## Working agreements

The agreements in [`AGENTS.md`](AGENTS.md) apply to humans too. In particular: mutate the YAML
only through `packages/core/src/store.mjs` (comments must survive), keep the pure libraries pure,
keep CLI wrappers thin, and keep changes cross-platform.

## Resuming work

This repo plans itself. Before touching code on an in-flight initiative:

1. Read [`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md). It says which slice is open, which
   commit last moved it, and what "resume here" means.
2. Run `roadmap show <slice>` (or `node scripts/cli.mjs show <slice>`) and read its `read_order`.
3. Never start a slice whose `deps` are not `complete`. `roadmap plan` shows what is ready.
4. Work one slice per commit. The commit that finishes a slice also flips its status
   (`roadmap set <slice> status=complete prs='["#N"]'`), updates `STATUS.md`, and re-renders
   `docs/SLICES.md`. Tests must be green at every commit.
5. If you stop mid-slice, leave a `resume_action` on the slice and a line in `STATUS.md` so the
   next session (human or agent) can pick up without re-deriving context.
6. Leftovers go to `docs/roadmap/backlog.yaml` (`roadmap backlog add …`), never into a new sprint
   or PI; scope decisions belong to the person steering the roadmap.
