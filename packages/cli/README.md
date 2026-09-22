# @connorbritain/roadmap-cli

Thin roadmap CLI/MCP wiring. Its one job today is the **work-profile loader**,
`src/profile.mjs`: the only place in the tree that reads `meta.profile` (the boundary check in
`scripts/check-boundaries.mjs` refuses any other read). The `roadmap` bin and the script files stay
in the root package until the `unshim` slice.

```js
import { loadProfile } from "@connorbritain/roadmap-cli/profile.mjs";
const p = await loadProfile(graph.meta, { root });
// p = { name, package, executor, artifacts, validators, commands, mcp: { tools, call }, skills, planContext }
```

- `engineering` (default when `meta.profile` is absent, so existing files need no edit) loads
  `@connorbritain/roadmap-exec-engineering`; `general` loads `@connorbritain/roadmap-exec-general`.
  Any other value is an error, never a silent fallback.
- Each executor package exports `profile(root)`; the loader merges core's commands and skills on
  top of what the package registers and caches the result per profile + root.
- Consumers: `scripts/cli.mjs` (command routing; an engineering command under `general` is refused
  with a message), `scripts/validate.mjs` (profile validators after core's), `scripts/scheduler.mjs`
  and `scripts/mcp.mjs` (`capacity`/`annotate` for `buildPlan`; the MCP tool list is core plus the
  profile's tools).

`test/profile.mjs` covers the loader against both real packages and drives a general-profile
roadmap (no `touches`, checklist gates) through validate / plan / show / MCP with zero edits.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) § Profile loader and
[`docs/roadmap/STATUS.md`](../../docs/roadmap/STATUS.md).
