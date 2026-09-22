# @connorbritain/roadmap-exec-general

The general (non-engineering) profile for roadmap: the same planning and ritual engine, conducting
work whose deliverable is a document rather than a pull request. Loaded by the profile loader when
`meta.profile: general`. Depends on `@connorbritain/roadmap-core` only.

## What changes in the YAML (nothing required)

- `touches` may be omitted entirely (no wave contention on files).
- `gate` may be a **checklist**: a list of criteria a reviewer confirms.
- `artifact` (optional) names the deliverable path; default `docs/roadmap/artifacts/<invoke>.md`.

## Executors (`docs/ARCHITECTURE.md` § Executor)

| Executor | launch | status | receipts | cleanup |
|---|---|---|---|---|
| `human` | writes `.roadmap/assignments/<invoke>.md` — the checklist gate, the artifact path, read order, pickup notes, and (for critic/repair roles) the protocol brief | `assigned` → `running` (artifact drafted) → `done` (artifact committed) | the brief files themselves (committable; they survive ledger loss) | removes briefs of complete slices; dry by default |
| `doc-agent` | the same brief, then starts the configured assistant (`meta.agent_cmd`, default `claude --permission-mode {mode} {prompt}`) at the repository root — no worktree, no branch | same | same | same |

Capacity has no machine ceiling: `meta.default_concurrency` (default 3) is the review capacity.
Scope proposals come from core's document-based `genericScope`.

## GauntletArtifact: `git-file`

The artifact is a file at a commit. Its exact head is the last commit that touched it; the frozen
bar packet and every protocol comment (launch attestations, verdicts, acknowledgments) are
committed to a sidecar under `.roadmap/gauntlet/<slug>/`, so an in-place edit is detectable
against git history; claims are atomic `git update-ref` create-if-absent refs under
`refs/roadmap-gauntlet-locks/`. It passes the core contract
(`packages/core/test/contracts/gauntlet-artifact.mjs`). It has no remote protection: every
conductor must share the repository, and `assertClaimSafety` says so.

## The conducted loop (`conduct.mjs`, `roadmap conduct …`, MCP `conduct_*`)

```
conduct start <key> [--executor human|doc-agent] [--assignee who]   freeze the bar → sidecar packet (committed), claim, assign
conduct status <run|key>                                           derive the state from the ledger or the committed sidecar
conduct critic <run> --head <sha>                                  launch a fresh critic at the exact head (attested in the sidecar)
conduct verdict <run> --verdict PASS|REVISE… --rationale "…"       the critic posts its immutable verdict (bound to the launch nonce)
conduct ack <run> --comment <locator> --confirm                    the frozen lead acknowledges one exact comment
conduct repair <run> --head <sha> --packet <text|@file>             lead-synthesized repair at the exact head
conduct reconcile [--apply]                                        the general sync: acknowledged PASS → slice complete
```

The protocol is core's `gauntlet-core` unchanged (markers, digests, staleness, round budget). The
local ledger is a cache: `.roadmap-gauntlet-state.json` can be deleted and a run is rebuilt from
its committed sidecar with its lead-attested launches.

## Tests

`test/general.mjs` registers both Executors on the core Executor contract, `git-file` on the
GauntletArtifact contract (real temp git repositories), and runs the exit test: a general roadmap
with no `touches` and a checklist gate goes through validate / plan / render / start → critic →
REVISE → ack → repair → fresh critic → PASS → reconcile on a markdown artifact, with the YAML's
hand-written comment preserved, and survives ledger loss.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and [`docs/roadmap/STATUS.md`](../../docs/roadmap/STATUS.md).
