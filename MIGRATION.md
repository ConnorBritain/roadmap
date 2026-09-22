# Migrating to the core + executor split (0.7.x → workspaces)

**Your `roadmap.yaml` and `backlog.yaml` need no edits.** `meta.profile` defaults to `engineering`,
which is exactly what the flat package did. Every command, MCP tool, skill and hook keeps its name.

## What changed

| Before | After |
|---|---|
| one flat package, `scripts/lib/*.mjs` | four workspace packages: `@connorbritain/roadmap-core` (planning + the protocol), `-exec-engineering`, `-exec-general`, `-cli` (the profile loader). The root `@connorbritain/roadmap` still owns the `roadmap` bin. |
| `scripts/lib/<module>.mjs` imports | `@connorbritain/roadmap-core/<module>.mjs` or `@connorbritain/roadmap-exec-engineering/<module>.mjs`. The old paths re-export until the `unshim` slice removes them; move now. |
| engineering only | `meta.profile: general` loads `exec-general`: `human` / `doc-agent` executors, the `git-file` artifact, checklist gates, `roadmap conduct` / `roadmap assign`, `/conduct` / `/assign`, MCP `conduct_*`. |
| `gate` is a command string | also a **checklist** (a list of criteria). Both profiles accept both; engineering embeds a command in the brief, general renders the list for the reviewer. |
| — | `artifact` (optional sprint field): the deliverable path. Default `docs/roadmap/artifacts/<invoke>.md`. |
| MCP `tools/list` was one fixed list | core tools plus the loaded profile's (`gauntlet_*` and `dispatch` / `fan_cloud` under engineering; `conduct_*` and `assign` under general). Engineering installs see the same list as before. |
| hooks imported `../scripts/lib/*` | hooks import the packages by name and ask the loaded profile for the reconcile nudge and the session hint. The Stop hook is a no-op outside engineering. |

## If you import the library

```js
// before
import { loadGraph } from "roadmap/scripts/lib/graph.mjs";
// after
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { worktreeSessionExecutor } from "@connorbritain/roadmap-exec-engineering";
import { loadProfile } from "@connorbritain/roadmap-cli/profile.mjs";
```

The CLI bodies of `linear`, `estimate`, `cycle` moved to core (`linear-io`, `estimate-io`,
`cycle-io`); `dispatch` and `evaluate` moved to exec-engineering (`cloud-dispatch`,
`evaluate-runtime`); the Gauntlet runtime is `gauntlet-runtime.mjs` in exec-engineering. The
`buildPlan` signature takes `{ capacity, annotate }` from the executor (core's `defaultCapacity`
when none is injected).

## Rules the split enforces (`npm test` fails otherwise)

- `packages/core` imports no executor package and no file outside itself.
- Exactly one file reads `meta.profile`: `packages/cli/src/profile.mjs`.
- Only that loader and the general profile's own command scripts import `exec-general`.
- Every `Executor` and `GauntletArtifact` implementation passes the core contract tests.

## Switching an existing roadmap to the general profile

Add `profile: general` under `meta`. Optionally rewrite gates as checklists and name each
open slice's `artifact`. `touches` can stay or go; nothing reads it under general. Run
`roadmap validate`; the general validators warn on missing gates and error on two open slices
sharing an artifact path.

## Upgrading from `slice-roadmap` (≤ 0.1.x)

See the README's Install section: the plugin, marketplace entry and npm package were renamed
`slice-roadmap` → `roadmap` in 0.2.0, and MCP tool ids read `mcp__plugin_roadmap_graph__*`.
