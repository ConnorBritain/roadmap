# Architecture: core + executor packages

Status: **plan of record for the core/executor split** (Step 1 of the re-architecture, 2026-09-22).
Tracked as PI `core-executor-split` in [`docs/roadmap/roadmap.yaml`](roadmap/roadmap.yaml);
live state in [`docs/roadmap/STATUS.md`](roadmap/STATUS.md). Nothing described under
"Target layout" exists yet; the dependency map describes `main` as of `565f96c`.

## Why

`roadmap` is one flat package. `scripts/lib/*` mixes the planning/ritual engine (graph, store,
priority, render, validate, backlog, review, brief, plan, linear, estimate) with engineering-only
execution machinery (worktree fanout, cloud dispatch, the GitHub-PR Gauntlet, disk/CPU ceilings,
doctor, PR watch). The engine should be able to plan and conduct non-engineering work (docs, ops,
research, writing) without a mode flag branching through every command.

The rule that keeps this honest: **no command in core may branch on the work profile.** If core
needs to behave differently per profile, that behaviour belongs in an executor and the interface
gets a method.

## Target layout (npm workspaces, this repo)

```
packages/
  core/              graph, store, priority, render, validate, backlog, review/journal, plan,
                     linear, wizard/init, estimate, gauntlet PROTOCOL (markers, digests,
                     decisions, authorization state machine, receipts, evaluation packets),
                     the Executor + GauntletArtifact interfaces and their contract tests
  exec-engineering/  worktree-session + cloud-dispatch Executors, github-pr GauntletArtifact,
                     ceilings (CPU/RAM/work/review/disk), doctor, pr-watch, providers,
                     code-grepping scoper, /fanout + /gauntlet PR instructions
  exec-general/      human + doc-agent Executors, git-file GauntletArtifact (+ doc stub),
                     checklist gates, generic scoper, /conduct + /assign
  cli/               thin: reads meta.profile ONCE, loads the profile's package, merges command,
                     MCP tool, validator, skill and hook registrations; owns the `roadmap` bin
```

Plugin assets (`skills/`, `agents/`, `hooks/`, `monitors/`, `.mcp.json`, `.claude-plugin/`) stay
at the repo root because `${CLAUDE_PLUGIN_ROOT}` points there; they are re-pointed at
`packages/cli`. The root `roadmap` bin keeps working at every step.

### Three things already called "profile"

| Term | Where | Meaning |
|---|---|---|
| **work profile** (new) | `meta.profile: engineering \| general` | which executor package and adapters the CLI loads. Default `engineering`. Read in exactly one place: `packages/cli/src/profile.mjs`. |
| assistant profile | `meta.assistants.{default,profiles}`, `.roadmap/config.local.yaml`, `scripts/lib/assistant-core.mjs` | which local CLI to spawn as a fanout worker (`manual\|claude\|codex\|custom`) and whether this machine may launch it. Engineering-executor concern. |
| Routine profile | `~/.claude-routines.json`, `CLAUDE_ROUTINE_PROFILE`, `scripts/dispatch.mjs:38-95`, `--profile` on `gauntlet critic\|repair` | which Claude Code Remote Routine account/trigger a cloud launch uses. Engineering-executor concern. |

Error messages and docs must say which one they mean.

## Dependency map: `scripts/lib/*` today

Legend. **C** core. **E** engineering. **G** gauntlet, to be split into protocol (core) and the
github-pr adapter (engineering). **M** mixed: the module stays where its verdict says, but the
named functions move the other way. Line numbers are as of `main@565f96c`.

| Module | Imports (lib only) | Verdict | Mixed parts / engineering leaks |
|---|---|---|---|
| graph | priority | C | `touches`/`owns` are the wave file-contention key (391); `resolveGate` (410) returns text, never runs it |
| priority | — | C | |
| store | cli-core, graph, render-core, mcp-core, backlog-core, backlog-audit | C | `originBacklogIds` (42) spawns `git show`; git-as-data, stays |
| render-core | execution, priority | C | emits engineering prose (`executionDirectiveLines`, `roadmap fan` hints, "Do NOT merge") → becomes a render option supplied by the executor |
| validate-core | graph, execution, priority, linear-core, estimate-core, evaluation-core, model-policy | **M** | `meta.terminal` (28), `meta.assistants` (31-37), `meta.dispatch` (95-127), `meta.gauntlet` (131-156) validation + the evaluation-core / model-policy imports → executor-contributed validators |
| backlog-core | graph, priority, mcp-core | C | `backlogItemToNode` (199) is shape-only |
| backlog-audit | — | C | |
| review-core | graph, sync-core | C | imports `sprawlWarnings`, `captureRatio` from sync-core; those two are pure and move to core with it |
| journal-core | graph, brief | **M** | `sliceForBranch` (20) and `gitSnapshot` (29) depend on the branch convention → the branch resolver is injected by the executor; `noteBody`, `autoPostPlan` stay |
| brief | graph, execution | E | branches, worktrees, agent command, PR contract, gate block. Widest core→E edge: `branchFor` is imported by journal-core, sync-core, pr-identity |
| plan | graph, recommend, brief, execution | **M** | waves/held/cap packing is core; resource probes (20-26) and branch/worktree/prompt annotation (58-60) come from `Executor.capacity()` and `Executor.annotate()` |
| recommend | graph, external-state | E | statfs, `os.cpus`, gh review debt, worktrees, gate-text weight classifier |
| linear-core | graph, priority, plate-core | C | `dispatchGuidance` (565) is PR/marker prose → engineering |
| wizard-core | — | E | fanout console decisions |
| init-core | assistant-core | C | `renderLocalConfig` (146) writes an assistant profile → executor-contributed blueprint |
| estimate-core | graph | C | slice `estimate-native` makes it the native pricing engine (today it only builds argv for agent-time's `estimator.py`) |
| mcp-core | graph, plan, validate-core, execution, priority, linear-core, cycle-core, plate-core | C | settable-field allow-list carries `touches`/`execution`/`dispatch_tier` as opaque data |
| sync-core | graph, brief, execution, pr-identity | **M** | `findUnrecordedMerges` (18), `reconcileNudge` (83), `underParallelizedWarnings` (43) → E; `captureRatio` (63), `sprawlWarnings` (69) → C |
| execution | — | **M** | `normalizeExecution`/`validateExecution` schema → C; `executionDirectiveLines` (133), `filterByTrack` (182) → E |
| cli-core | — | **M** | the command MAP (8) and SHORT flags (62-67) hardwire engineering scripts → per-package command registries merged by the loader |
| assistant-core | — | E | |
| plate-core | graph | C | the plate is Linear's "My Issues" hopper, not an executor concern |
| cycle-core | graph, priority, linear-core | C | `outOfCycle` is a predicate the executors consult |
| model-policy | — | E | cloud roles and transport capability qualification |
| fanout-core | — | E | |
| external-state | — | E | `TODO(dedupe)` at 12-14: hooks/session-start, watch-prs, cleanup carry inline copies; fold when they move |
| doctor-core | sync-core, pr-watch-core, pr-identity, backlog-audit | E | the backlog-audit section is core data and could stay in `validate` |
| pr-identity | graph, brief, gauntlet-core | E | imports `FROZEN_BAR_*` markers from gauntlet-core; the marker grammar itself moves to core protocol |
| pr-watch-core | gauntlet-core | E | |
| cloud-agent-providers | — | E | |
| dispatch-providers | — | E | existing backend-agnostic adapter seam (`detect`/`available`/`listOpenPrs`), read-only |
| gauntlet-core | — | **G** | PROTOCOL, but GitHub-shaped: 40-hex SHA (58), GitHub login regex (56), `comment.url`/`author.login`/`createdAt`/`updatedAt` edit detection (76-82, 913), PR number in critic/repair prompts (1325, 1340-1342, 1367, 1384), `pr.headRefName`/`isDraft`/`mergeStateStatus` in `deriveRunStatus` (1218-1221) |
| gauntlet-decisions | gauntlet-authorization, gauntlet-authorization-io, evaluation-packet | **G** | `#issuecomment-` URL regex (26); `github.viewerLogin`/`getPr` (55-63) |
| gauntlet-authorization | model-policy, evaluation-packet | **G** | PROTOCOL; GitHub login regex (33); Codex task URL validation (155-159) |
| gauntlet-authorization-io | gauntlet-authorization, evaluation-packet | **G** | `githubAuthorizationStore` (11-90) is GitHub; `mutateAuthorization` (97), `recordRunContinuation` (110) are store-agnostic |
| gauntlet-store | — | G → C | local ledger (fs); `launchReceipt`, `findLedgerRun` pure |
| gauntlet-observation | cloud-agent-providers | E | codex-only |
| gauntlet-portfolio | graph, gauntlet-store, gauntlet-core, evaluation-core, gauntlet-authorization-io, gauntlet-authorization, gauntlet-decisions, `../gauntlet.mjs`, `../evaluate.mjs` | **G/M** | `authorizationReport`, `evaluationSafeActions` pure; `runGauntletPortfolio` GitHub + fs; **circular** with gauntlet.mjs |
| implementation-authorization | gauntlet-authorization, gauntlet-authorization-io, gauntlet-core, model-policy | **G** | store selection (10-11), `viewerLogin` (56) |
| evaluation-core | evaluation-packet | G → C | pure; forces `provider: "codex"` (79, 86-87) → provider comes from the executor |
| evaluation-io | evaluation-core, evaluation-packet | E (git) | disposable git index, `git apply` |
| evaluation-packet | — | G → C | pure |
| evaluation-review-core | gauntlet-authorization, gauntlet-core, evaluation-core, evaluation-packet | **G** | PR-shaped input (`pr.number/url/comments/commits` 35, 49; `#issuecomment-` 85) |
| evaluation-review-io | evaluation-core, evaluation-io, evaluation-packet, gauntlet-authorization, gauntlet-authorization-io, evaluation-review-core, gauntlet-core, cloud-agent-providers, model-policy | E | GitHub + git + codex |

### Entry points, hooks, plugin assets

| Group | Core | Engineering |
|---|---|---|
| `scripts/*.mjs` | render, validate, show, set, backlog, promote, next, review, plate, cycle, estimate, init, prompt, linear (network only; one `git remote get-url` at 687), mcp (registration point), cli (router) | fanout, grab, wizard, cleanup, dispatch, gauntlet (IO layer + `githubClient`), evaluate, watch-prs, doctor, scheduler (uses recommend), assistant |
| skills | backlog, cycle, prioritize, imagine, init, retro, debrief, slice (after dropping its git branch-state step into the executor) | fanout, gauntlet, sync (merged-PR reconciliation) |
| agents | slice-scoper (grep-based today → engineering scoper; core keeps a doc-based generic scoper), roadmap-bootstrapper | roadmap-auditor, wave-shepherd |
| hooks | session-start (ready wave, backlog count, Linear line) | session-start's `gh pr list` merge nudge; journal-post's git snapshot + estimate log |
| monitors | — | roadmap-prs (`watch-prs.mjs`) |

### Seams the extraction has to cut

- **Circular imports**: `gauntlet.mjs` ⟷ `gauntlet-portfolio.mjs` (dynamic import at 1008, comment
  at 1610); `evaluate.mjs` → `gauntlet.mjs` → portfolio → `evaluate.mjs`; `gauntlet.mjs` →
  `dispatch.mjs` puts the artifact client and the executor in mutually importing files.
- **CLI routing**: `cli-core.mjs:8` MAP and `cli.mjs:152` spawn sibling scripts with cwd = repo
  root. Target: each package exports `commands`; the loader merges core + profile commands.
- **MCP**: `tools/list` is one spread of 9 arrays (`mcp.mjs:307`); `callTool` is an if-chain
  (`mcp.mjs:216-294`). `mcp-core` and `backlog-core` already export `TOOLS` + `*_HANDLERS` pairs;
  generalize that pattern to every group so registration follows the loaded profile. Preserve the
  in-place `model_preference` schema injection (`mcp.mjs:139-144`). Make the heavy imports at
  `mcp.mjs:18-23` lazy. Read the server version from package.json (hardcoded 0.6.0 today).
- **Hooks and manifests**: `hooks/session-start.mjs:41-71` and `hooks/journal-post.mjs:31-61`
  import `../scripts/lib/*` and `../scripts/{estimate,linear}.mjs` by relative URL; `hooks.json`,
  `monitors.json`, `.mcp.json`, `skills/slice/SKILL.md` hardcode `${CLAUDE_PLUGIN_ROOT}/scripts/…`;
  `skills/gauntlet/SKILL.md` hardcodes `mcp__plugin_roadmap_graph__*` tool ids.
- **Tests**: no framework; `test(name, fn)` at `scripts/test/run.mjs:108`, sub-suites register via
  `register*(test)`. One hardcoded script path (`run.mjs:3523`, `resolve("scripts")/review.mjs`);
  eight `../<script>.mjs` module imports (36, 48, 51, 59, 77-79, 84). `scripts/test/packed.mjs`
  pins the tarball layout (21-23, 36) and five doc paths (68). `package.json#files` omits `hooks/`,
  `agents/`, `monitors/`, `.claude-plugin/`, `.mcp.json`. Comment-preservation tests live at
  `run.mjs:663, 793, 1153`. Plan: `packages/core/test/` keeps the harness and the core sections;
  each executor package has its own `test/run.mjs` importing the harness; root `npm test` runs all.
- **Hardcoded `docs/roadmap/roadmap.yaml`** in fanout:33, grab:41, next:14, cleanup:19, review:40,
  show:11, scheduler:26, render:19, validate:22, assistant:10, wizard:18 and both hooks, instead of
  `REL`/`roadmapPaths`. Normalize during the core extract.
- **Schema drift**: `roadmap.schema.json` meta is `additionalProperties: false` yet
  `command_lane`, `assistants`, `jira`, `audit` are read by code and undeclared; `backlog.schema.json`
  lacks `meta.audit`. Tracked in the backlog.
- **Gates are never executed** by roadmap. `resolveGate` has three consumers: `show.mjs:25`
  (display), `brief.mjs:65` (embedded in the kickoff brief for the worker to run),
  `recommend.mjs:68` (regex-classified for resource weight). Checklist gates therefore need no new
  execution path; only the executor's brief/render/weight treatment changes.

## Interface: Executor

How a slice gets worked. The profile loader registers one; core reaches execution only through
this surface. Pure data in, receipts out. All methods are async and take `(…, ctx)` where `ctx` =
`{ root, graph, meta, env, io }` with injectable io (`exec`, `fetch`, `fs`, `now`) for tests.

```js
Executor {
  name              // "worktree-session" | "cloud-dispatch" | "human" | "doc-agent"
  capabilities()    // { concurrent: bool, artifactKinds: ["github-pr"|"git-file"|"doc"], gateKind: "command"|"checklist" }

  scope(slice, ctx)          // proposals for est_sessions / gate / read_order / touches → { fields, rationale }; never writes
  capacity(graph, ctx)       // → { cap, boundBy, ceilings: [{ name, cap, note }] }
                             //   engineering: CPU · RAM · work · review · disk;  general: review capacity only
  annotate(node, ctx)        // → per-node plan fields merged into the plan/brief
                             //   engineering: { branch, worktree, prompt, agentCmd };  general: { assignee, artifactPath, brief }
  launch(slice, opts, ctx)   // → Receipt; idempotent per launch key (a retry returns the existing receipt)
  status(slice, ctx)         // → { state, receipts, artifactRef?, notes[] }
                             //   state ∈ idle | assigned | running | awaiting_artifact | done | ambiguous
  receipts(slice, ctx)       // → Receipt[]  (durable evidence, re-readable after local ledger loss)
  cleanup(opts, ctx)         // → { removed[], kept[], dry }  dry by default; `remove: true` acts
}

Receipt { key, executor, slice, role?, external_id?, url?, artifactRef?, actor?, started_at, ended_at?, evidence? }
```

| Implementation | Package | launch | status | receipts | cleanup |
|---|---|---|---|---|---|
| worktree-session | exec-engineering | `git worktree add` + terminal pane/tab + kickoff brief (today's fanout.mjs, fanout-core, brief, wizard) | worktree exists / branch ahead / PR open | branch, worktree path, PR number | prune merged worktrees (today's cleanup.mjs) |
| cloud-dispatch | exec-engineering | fire a Routine or Codex Cloud task (today's dispatch.mjs, dispatch-providers, cloud-agent-providers) | provider observation + in-flight PR marker | exact task id/URL, session URL | none |
| human | exec-general | mark `assigned` with assignee + due note; write the brief to the artifact path | assigned / done from recorded evidence | completion evidence: who, when, link or path, checklist ticks | none |
| doc-agent | exec-general | write an assignment brief and launch the configured assistant against a file/doc path | artifact exists at a commit / doc version | path + commit (or doc version id) | remove temp briefs |

**Contract test** (`packages/core/test/contracts/executor.mjs`, exported as
`executorContract(makeExecutor, fixture, test)`), registered by every implementation:
launch is idempotent per key; status transitions are monotone (`idle → assigned|running →
awaiting_artifact → done`, `ambiguous` only from a lost response); receipts survive deleting the
local ledger; `cleanup()` is dry by default; `capacity().cap ≥ 1`; `scope()` performs no writes.

## Interface: GauntletArtifact

What the frozen bar attaches to and what the critic reads. The protocol (markers, digests,
verdict derivation, authorization state machine, decisions, receipts) lives in core and never
learns which backend it is talking to. Today every actuator runs the same envelope: identity
assert → claim-protection probe → atomic claim → attestation comment → external launch → receipt.
So the adapter surface is the five methods in the brief plus a durability group.

```js
GauntletArtifact {
  kind                          // "github-pr" | "git-file" | "doc"

  freeze(bar, ctx)              // attach the frozen bar + run markers → { barSha256, location }
  head(ctx)                     // exact version identity, content-addressed → { id, ref, descriptor }
                                //   github-pr: 40-hex head SHA;  git-file: 40-hex commit of the file;  doc: version id
  fetch(head, ctx)              // → Artifact { id, url, body, markers, head, base, comments[], versions[], state }
                                //   the normalizeGauntletPr shape (gauntlet.mjs:116-136) with backend-neutral names
  comment(verdictOrEvent, ctx)  // post an IMMUTABLE protocol comment → Comment { id, url, body, bodySha256, author, createdAt, updatedAt }
  ack(commentId, ctx)           // lead acknowledgment; binds body digest AND locator digest of that comment → { ackId }

  // durability group (every actuator needs these today; general backends must answer or fail closed)
  actor(ctx)                    // authenticated lead identity: gh login | git user.email | doc principal
  descendsFrom(ancestor, head)  // lineage check
  claim(key, head, ctx)         // atomic create-if-absent election → { claimed, ref }
  readClaim(key, ctx) / listClaims(runId, ctx)
  assertClaimSafety(key, runId, ctx)   // protection probe → { unsafe, ref, rules }
  workerFetchInstructions(head) // text a remote critic/repair worker needs to fetch exactly this head
}
```

Notes that shape the implementations:

- `ack` is not "ack a comment id" in today's protocol: the acknowledgment binds the comment's body
  digest and its locator digest (`gauntlet-core.mjs:586, 913`). The adapter resolves the id to both
  digests; a comment whose `updatedAt` moved after creation fails `commentWasEdited`
  (`gauntlet-core.mjs:76`).
- `head()` must be content-addressed. A backend whose "version" can be rewritten in place cannot
  host an authoritative run; it must fail closed (`unsupported_backend`).
- Verdict comments, launch attestations, cancellations and acks are all `comment()` events with
  different marker headers; the protocol renders and parses them, the adapter only posts and lists.

| Implementation | Package | head | comment | claim | actor |
|---|---|---|---|---|---|
| github-pr | exec-engineering | PR head SHA via `gh pr view` (today's `githubClient`, gauntlet.mjs:140-294) | PR issue comment; locator = `…#issuecomment-N` | `refs/heads/roadmap-gauntlet-locks/*` create-if-absent, ruleset probe | `gh api user` |
| git-file | exec-general | commit SHA of the file at `HEAD` of the artifact branch | append-only entries in `<artifact>.gauntlet.md` (each entry a commit; locator = `<sha>:<path>#<n>`) | refs under `refs/roadmap-gauntlet-locks/*` in the repo (remote when present) | `git config user.email` |
| doc | exec-general (stub) | document version id | throws `unsupported_backend` | throws `unsupported_backend` | throws `unsupported_backend` |

The existing documentation-only evaluation flow (`roadmap gauntlet eval`, `evaluation-*.mjs`)
already conducts a SHA-pinned gauntlet on a doc corpus; it becomes the first consumer of
`git-file` and must keep its behaviour and tests.

**Contract test** (`packages/core/test/contracts/gauntlet-artifact.mjs`, exported as
`gauntletArtifactContract(makeArtifact, fixture, test)`), registered by github-pr (against a fake
`gh`) and git-file (against a temp repo); the doc stub registers the fail-closed subset:
freeze → head → fetch round-trips the bar digest; `comment()` is immutable-detectable; `ack()` binds
both digests and is idempotent; `claim()` elects exactly one of two racing callers; `head()`
changes when content changes; `isVerdictStale` fires for a verdict on a previous head.

## Profile loader

`packages/cli/src/profile.mjs` is the only reader of `meta.profile`:

```js
loadProfile(meta) → { name, executor, artifacts: { [kind]: GauntletArtifact }, validators, commands, mcpTools, skills, hooks }
```

`engineering` (default when absent, so every existing `roadmap.yaml` keeps working with zero edits)
loads `@connorbritain/roadmap-exec-engineering`; `general` loads `…-exec-general`. Core commands,
tools and skills are always registered; the profile adds its own. The boundary check
(`scripts/check-boundaries.mjs`, run by `npm test`) fails when any core module imports from an
executor package or the CLI, or when any file other than the loader reads `meta.profile`.

## General profile: what changes in the YAML (nothing required)

A general-profile `roadmap.yaml` may omit `touches` entirely and may write gates as checklists:

```yaml
meta:
  schema_version: 1
  program: handbook
  profile: general
pis:
  - id: onboarding
    title: Onboarding handbook
    status: active
    sprints:
      - id: s1
        title: Draft the first-week guide
        status: next
        invoke: onboarding-week1
        est_sessions: 2
        gate:
          - Every section has an owner named
          - Reviewed by one person outside the team
        read_order: ["docs/handbook/STYLE.md"]
```

`gate` accepts a string (command) or an array of strings (checklist). Core validates the shape;
the executor decides what to do with it (engineering embeds the command in the brief; general
renders the checklist for the human or critic to confirm). No resource ceilings apply in the
general profile: the cap is review capacity.

## Extraction order (one commit per slice, tests green at every step)

See the PI in [`docs/roadmap/roadmap.yaml`](roadmap/roadmap.yaml) and the narrative in
[`ROADMAP.md`](../ROADMAP.md). In short: estimate-native → workspaces → core-extract (with
re-export shims at the old paths) → gauntlet-split → exec-engineering → profile-loader →
exec-general → skills-agents → docs → unshim.
