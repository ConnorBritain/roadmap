# Roadmap: scope, manage, and orchestrate AI coding sessions in any repo

`roadmap` is a CLI, MCP server, and Claude Code plugin. It turns two YAML files into your repo's plan of record — a **hierarchical, dependency-aware roadmap graph** plus a **prioritized backlog** for the work that surfaces erratically — then **fans that plan out into parallel coding sessions**, each scoped to a single unit of work in its own git worktree.

In a Codex environment, the primary surfaces are the CLI, the MCP server, and the repo-level [`AGENTS.md`](AGENTS.md). The Claude plugin assets are included for teams using them.

- **One source of truth (each).** `docs/roadmap/roadmap.yaml` holds the PIs, sprints, deps, priorities, file-ownership, session estimates, gates, prompts, and kickoff briefs. `docs/roadmap/backlog.yaml` holds the erratic work: follow-ups, bugs, chores, urgent items.
- **Generated views.** `docs/SLICES.md` and `docs/BACKLOG.md` are *rendered* from the YAML; never hand-edit them.
- **Derived, never stored.** Per-PI exec-plan lines (`(S0 ∥ S1)→S2→S3`), the cross-PI "ready now" wave map, "sessions remaining" rollups, and priority ordering are all computed from `deps` + `touches` + `status` + `priority`.
- **Deterministic fanout with feasibility pre-checks.** A scheduler decides which slices can run concurrently under a cap it *recommends* from five real ceilings — CPU, RAM, independent work, human review, and **free disk for the worktrees** — then launches each in its own worktree and Claude Code session. When even one worktree won't fit on disk, launch is refused before anything is created.
- **Zero-prompt pickup.** Stash the pickup instructions on the slice itself (`prompt:`); `/slice <key>` or `roadmap grab <id>` is then all a session needs.
- **Repo-agnostic.** The resource classifier reads the build/test runner command in each sprint's gate (not its language) to size the session. It recognizes the common runners across JS/TS, Python, Java/Kotlin, C/C++, Go, Rust, and Ruby, and `meta.weight_patterns` teaches it anything bespoke. Nothing is hardcoded to one stack.

---

## Concepts

`roadmap` has a small, deliberate vocabulary:

| Term | What it is |
|---|---|
| **Roadmap** | The whole graph: every PI and sprint in `roadmap.yaml`. The map of *all* the work. |
| **PI** *(Program Increment)* | A top-level initiative or epic. Groups related sprints; carries a status, dependencies, and exit criteria. |
| **Sprint** | A unit of work inside a PI (`s1`, `s2`, ...). Carries its deps, the files it `touches`, a session estimate, a verification `gate`, and a kickoff brief. |
| **Slice** | A sprint *as the thing you act on*, addressed by its stable `invoke` key (e.g. `auth-sessions`): "show me a slice", "fan out this slice." The slice is the atomic, **launchable** unit. |
| **Wave** | The set of slices that can run **concurrently right now**: mutually dependency-free, sharing no files, under the cap. Within a wave, declared `priority` decides who gets a scarce cap slot. |
| **Fanout** | Launching a wave. One git worktree plus Claude Code session per slice, plus an optional **lead** session that reviews and merges the resulting PRs. |
| **Backlog** | The tracker beside the roadmap for **erratic work** — follow-ups, bugs, chores, urgent items that surface outside the plan. Items are directly launchable (`roadmap grab <id>`) or promotable into roadmap sprints (`roadmap promote <id> --pi <pi>`), cross-linked both ways. |
| **Priority** | `{ tier: P0–P3, weight: 0–100, reason }` on any sprint or backlog item. Sort order is derived (tier, then weight), never stored — resorting is just editing the fields. |

> **Roadmap = the planned feature/value work. Backlog = the erratic work. Slice = one launchable piece of either.**
> You edit the **YAML**; you launch **slices** (by `invoke` key) and **backlog items** (by id). `SLICES.md` / `BACKLOG.md` are the human-readable renders, generated and never hand-edited.

---

## Quickstart

```bash
# 1) one-time: install deps + put the `roadmap` CLI on your PATH
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link

# 2) in any repo, author docs/roadmap/roadmap.yaml (see "The roadmap.yaml model")

# 3) from ANYWHERE inside that repo (root or a subdir; the roadmap is auto-discovered):
roadmap            # interactive console: pick terminal / wave / cap, then launch
roadmap plan       # the text plan: recommended cap + what's runnable (no prompts)
roadmap next       # the single highest-priority ready thing across roadmap + backlog
roadmap render     # regenerate docs/SLICES.md (+ docs/BACKLOG.md when a backlog exists)
roadmap validate   # structural + cycle checks
roadmap fan -w 1   # spin up wave 1 (lead + slice sessions); add -d to preview first

# and the erratic-work loop:
roadmap backlog add "wt adapter mangles quotes" -k bug --tier P0 --why "breaks every fanout"
roadmap grab b1                    # launch that one item in its own worktree + session
roadmap promote b2 --pi auth       # or fold a bigger one into the roadmap as a sprint
```

That's the whole loop: `cd` into a repo, type `roadmap ...`, it finds the roadmap and fires.

### Using it in Codex

- Codex reads [`AGENTS.md`](AGENTS.md) from this repo automatically, so repo conventions live there now.
- You can drive everything from the shared terminal with `npm run plan`, `npm run validate`, `npm run render`, or `node scripts/cli.mjs ...`.
- `npm run mcp` starts the same MCP server the Claude plugin uses.
- The fanout launcher still opens `claude` worker sessions today; the rest of the repo is usable from Codex directly.

---

## The three surfaces

The same engine (`roadmap.yaml` plus the graph brain) driven three ways.

### 1 · The `roadmap` CLI (from your shell)

Run from anywhere inside a repo. `docs/roadmap/roadmap.yaml` is found by walking up from your cwd, and every subcommand runs with cwd set to that repo root. Two ways to drive it:

- **Interactive console.** Bare `roadmap` in a terminal opens a guided picker: terminal, then max concurrency, then wave, then lead?, then launch / preview / save. Walk the prompts with the arrow keys and hit Enter. Best when you want to *see* what's runnable and choose. (Piped or non-interactive, bare `roadmap` prints the text plan instead, so scripts and CI are unaffected; `roadmap go` forces the console.)
- **Flag-fed.** Every choice as a flag: `roadmap fan -w 1 -c 2 -t wt`. No prompts, same outcome, for muscle memory, aliases, and scripts.

| Command | What it does |
|---|---|
| `roadmap` / `roadmap go` | The **interactive console** (above). Hot-loads this repo's roadmap and walks you through the launch. Worker permission mode isn't asked here; it comes from `meta.worker_mode`. |
| `roadmap plan [-c N] [--review-ceiling N] [--use-free-ram] [-j]` | **Recommended cap** (and what constrains it — CPU / RAM / work / review / disk), the execution **waves** (priority-ordered), and per-node launch commands. Spawns nothing. `-j/--json` emits the plan for tooling. |
| `roadmap next` | The **single highest-priority ready thing** across the roadmap AND the backlog, with its pickup brief. Roadmap wins ties. Read-only. |
| `roadmap show <name>` | One slice's detail: what / priority / stashed prompt / read-order / next / gate / branch. |
| `roadmap set <name> f=v [...]` | Edit a slice's fields from the shell: YAML-scalar values (`priority='{tier: P1, weight: 60}'`), `f=@file` for multiline (prompts/briefs), `f=null` deletes. Same allow-list + pre-write gate as the MCP tools. |
| `roadmap render [-c N] [-s]` | Regenerate `docs/SLICES.md` (+ `docs/BACKLOG.md` when a backlog exists) from the YAML (`-s/--stdout` prints SLICES instead of writing). |
| `roadmap validate` | Structural, dependency, and cycle checks. Non-zero exit on error. |
| `roadmap backlog [list\|add\|set]` | The erratic-work tracker: `add "title" [-k kind] [--tier PN] [--weight N] [--why reason] [--slice invoke]` (first add creates `backlog.yaml`), `set <id> f=v ...`, bare = priority-sorted open items. |
| `roadmap grab <id> [-t term] [--dry]` | Launch **one backlog item** in its own worktree (`<root>/backlog-<id>`, branch `backlog/<id>`) with a synthesized kickoff brief (the item's `prompt` embedded). Marks it `in_progress`. |
| `roadmap promote <id> --pi <pi> [--id sN]` | Promote a backlog item into a roadmap **sprint** (item id becomes the invoke key; title/est/gate/touches/prompt/priority carry; `promoted_to` back-links). Both YAMLs validated before either is written. |
| `roadmap linear status\|auth\|setup\|provision\|sync\|post-update` | Optional **Linear** integration (see [Linear](#linear-optional--project-manage-from-linear-while-agents-execute)): `status [--probe]` state check, `auth` env-var instructions, `setup --team KEY` guided config, `provision` (labels + views + guidance texts), `sync [--dry] [--push-only] [--pull-only]`, `post-update --pi <id> --body <text>` (digest → project update). |
| `roadmap review [--since <rev\|date>] [-j]` | The **date-anchored review digest**: shipped vs captured vs aging vs new PIs vs sprawl since `meta.last_review` (git-snapshot diff). The `/debrief` and `/retro` engine; works with zero Linear. |
| `roadmap dispatch <key> [--to claude]` | Send one slice/backlog item to a **cloud agent** via its Linear issue (v0.5 seam, pending live verification). `roadmap fan --cloud` does the whole wave — no worktrees, no disk ceiling. |
| `roadmap fan [-t wt\|warp\|tmux\|print\|background] [-c N] [-w N] [--track A] [--lead-claude] [-d] [-o file] [--worker-mode <m>] [--autonomous --yes-spawn-autonomous]` | Launch a wave: a lead pane/tab plus one per slice, each in its own worktree with a synthesized kickoff brief. **Launches by default**; `-d/--dry` or `-o/--out` to preview. `--track <lane>` fans out only the slices in that lane. Worker **and** lead sessions take `--permission-mode` from `meta.worker_mode` (falls back to `plan`); `--worker-mode` overrides per run. Terminal defaults per platform (win32 to `wt`, else `tmux`). |
| `roadmap cleanup [-r] [-f]` | Prune fanout worktrees merged into the base branch and clean. **Dry by default**; `-r/--remove` acts; `-f/--force` includes unmerged/dirty. Only touches worktrees under the worktree root. |
| `roadmap mcp` | Run the MCP server (stdio JSON-RPC) directly, for debugging or non-plugin registration. The plugin starts it for you. |
| `roadmap watch` | Watch this roadmap's fanout PRs and print a line as each becomes ready / conflicts / merges. The plugin runs it as a monitor; this is the manual pane version. |
| `roadmap sync` / `roadmap init` | Reserved on the CLI. Reconcile and bootstrap live as the `/sync` and `/init` **plugin skills** (surface 2). |

Short flags (`-w -c -t -d -o -j -r -f -lc -wm`) expand to their long forms; positional slice keys pass through untouched.

```bash
# See the plan + why the cap is what it is (the binding constraint is reported):
roadmap plan
#   Concurrency cap: 5 (recommended)
#     bound by: review (PR review/merge bottleneck, soft ceiling)
#     machine:  24 cores, 59.6GB total / 20.6GB free
#     ceilings: 12 [CPU] · 13 [RAM] · 23 [work] · 5 [review] · 41 [disk]
#   Wave 1, 5 concurrent: [P0] auth-sessions, billing-invoices, search-index, ...

roadmap fan -w 1                         # launch: lead + one watched session per slice (default)
roadmap fan -w 1 -d                      # preview the launch script, spawn nothing
roadmap fan -w 1 -o wave1.sh             # write the script to a file to inspect/run yourself
roadmap fan -c 3                         # override the recommended cap
roadmap fan --autonomous --yes-spawn-autonomous   # headless workers that commit/push/PR (double-acked)
```

**Safety.** `fan` launches by default, but an interactive launch just opens watchable panes (you're at the keyboard). Preview without spawning via `-d` or `-o`. The only unattended mode, `--autonomous` (headless `claude -p` that commits/pushes/PRs), additionally requires `--yes-spawn-autonomous`. **No launched session ever merges:** each opens a PR and stops; the lead (or you) merges. If `tmux` isn't on PATH (e.g. you're in PowerShell), `fan` prints the script and how to run it in WSL instead of failing.

### 2 · The Claude Code plugin (inside a session)

Install it as a plugin (see [Install](#install)) and the roadmap becomes an *in-session* surface: slash-command **skills**, **agents**, and a startup **hook**.

- **Skills** (`skills/*/SKILL.md`)
  - `/slice <key>`: orient on one slice (read-only) — what, priority, the stashed `prompt` (relayed verbatim), read-order, next action, gate, branch. With a prompt stashed, this is the whole pickup: slash command + slice name, nothing else.
  - `/sync`: reconcile statuses against merged PRs and the tracker, harvest PR-body "Leftovers" into proposed backlog captures, then re-render `SLICES.md`.
  - `/init`: a PM-style interview that bootstraps a `roadmap.yaml` (warm-start from existing docs, or cold).
  - `/fanout`: compute the waves and launch (wraps the same scheduler and adapters as the CLI).
  - `/backlog`: capture + triage erratic work — normalizes your dump into prioritized items, then offers `grab` or `promote` per item.
  - `/imagine`: divergent strategy interview on a live roadmap — vision drift, bets, risks/cuts — whose every conclusion lands **in the graph** (north-star pointer, new PIs, thin scheduled slices). `/init` bootstraps; `/imagine` re-plans.
  - `/prioritize`: convergent tier-by-tier triage of ready slices + open backlog with a forced reason per placement ("these two can't both be P1 — which ships first and why?"); source-aware (an item from a public Linear intake team is weighted knowingly); writes in one atomic `bulk_set`.
  - `/debrief`: the atomic lookback — date-anchored digest under hard high-signal rules, captain's-log entry in `docs/roadmap/REVIEWS.md`, anchor update. No graph mutations.
  - `/retro`: the full review-and-redirect ritual — debrief's lookback + per-bet double-down/kill/defer decisions applied to the graph + optional `/imagine` handoff.
- **Hook** (`hooks/hooks.json`): a `SessionStart` hook injects the at-a-glance plus the current ready-wave and the backlog open-count, so a fresh session immediately knows what's runnable (and, on first run, installs the `yaml` dep).
- **Agents** (`agents/*.md`): four specialized subagents Claude invokes across the roadmap, fanout, and review lifecycle.

| Agent | Role | Read/write | Suggested model |
|---|---|---|---|
| **roadmap-bootstrapper** | Cold/warm-start: reads the repo's existing roadmap docs, tracker, sprint dirs, and `git log`, and **drafts a `roadmap.yaml`**. Used by `/init` to pre-fill before the interactive confirmation. | reads repo, proposes YAML | sonnet |
| **slice-scoper** | Takes a thin `scheduled` slice and **fills it in**: infers `touches`/`owns` by grepping the code, drafts `read_order`, `est_sessions`, and the `gate`, and writes the sprint spec, turning it into a `next`-ready slice. | reads code, proposes slice fields | sonnet/opus |
| **roadmap-auditor** | Read-only **drift and gap finder**: audits `roadmap.yaml` against reality (merged PRs, strategy docs, sprint dirs) and reports stale statuses and un-surfaced work. | read-only report | sonnet |
| **wave-shepherd** | The **lead-pane brain**: after a fanout wave produces PRs, reviews each against its slice's gate and scope and recommends a safe **merge order** (respecting deps, flagging conflicts). Reviews; never merges. | read-only review | opus |

The CLI and the plugin share the same scripts: the CLI is your *shell* entry, the plugin is the *in-session* entry. The interactive PM interview stays a **skill** (not an agent), because a forked subagent can't hold a back-and-forth with you.

### 3 · MCP (agent-callable)

The plugin ships its own MCP server — named **`graph`** in `.mcp.json`, auto-started on install (plugin tool ids read `mcp__plugin_roadmap_graph__*`) — so an agent drives the roadmap with typed tools instead of shelling out and parsing text:

- **Read:** `plan`, `ready_wave`, `show`, `validate`, `backlog_list` return structured JSON.
- **Mutate (roadmap):** `add_pi`, `add_sprint`, `set_status`, `set_fields`, `bulk_set` (atomic multi-slice edit: one validate, one write, one render — all-or-nothing), `prune` edit `roadmap.yaml` through the YAML Document API (comments preserved), refuse any edit that would corrupt the graph (duplicate invoke key, unresolved dependency, cycle, bad priority/execution block), and re-render `SLICES.md` in the same step.
- **Mutate (backlog):** `backlog_add` (creates `backlog.yaml` on first capture), `backlog_set`, and `backlog_promote` (spans both files: both validated before either is written).
- **Linear:** `linear_status` (zero-network state check) and `linear_sync { dry, push, pull }` — always registered, politely erroring with setup guidance when `meta.linear` is absent.
- **Cloud dispatch:** `dispatch { key }` fires one cloud session; `fan_cloud { wave, cap, confirm }` conducts a whole wave — **previews by default, fires only on `confirm: true`**, returning the session URLs. This is the conductor pattern: a local session plans the wave, fires cloud workers on its own plan (no worktree/disk), and reconciles their PRs via `/sync`.

Launched worker sessions are told to file leftovers before opening their PR — `backlog_add` if the MCP is available, `roadmap backlog add` if the CLI is linked, else a **Leftovers** section in the PR body that `/sync` harvests.

Mutators are natural `ask`-list entries in a consuming repo's `.claude/settings.json` (reads can be `allow`-listed). Separately, launched fanout sessions inherit whatever other MCP servers your repo already has wired, so a worker can drive your issue tracker or database while it works its slice.

---

## The roadmap.yaml model

```yaml
meta:
  schema_version: 1
  program: Q3-PLATFORM
  default_gate: |                 # inherited by sprints whose gate is 'default'/{{default}}
    npm test
  base_branch: main               # worktree base + PR base (default main)
  remote: origin                  # git remote (default origin)
  terminal: tmux                  # default fanout adapter: tmux|warp|wt|background|print
  worker_mode: plan               # launched sessions' --permission-mode: plan|auto|acceptEdits|bypassPermissions
  agent_cmd: "claude --permission-mode {mode} {prompt}"   # optional: launch a different agent
  default_concurrency: 3
  # Optional: teach the resource classifier a bespoke runner / override per-class cost
  weight_patterns: { heavy: ["my-e2e-suite"], medium: ["my-bundler"] }
  weight_cost:     { heavy: { ram: 5, cores: 3 } }
  # Optional: the renderer cross-links these in SLICES.md (omit any you don't have)
  links: { narrative: ROADMAP.md, status: ../STATUS.md, tracker: roadmap/TRACKER.md }

pis:
  - id: auth                      # stable; == branch slug
    title: Authentication
    status: active                # active|next|scheduled|complete|blocked|paused|gated|optionality
    initiative: Launch readiness  # optional; groups this PI's Linear project under a named Initiative
    priority: { tier: P1 }        # optional; STRATEGIC → Linear project priority (not slice-derived)
    target_date: 2026-09-01       # optional; YYYY-MM-DD → Linear project target date
    sprints:
      - id: s1
        title: Login flow
        status: complete
        invoke: auth-login        # the slice key, stable, unique across the file
        prs: ["#42"]
      - id: s2
        title: Session tokens
        status: active
        invoke: auth-sessions
        deps: [s1]                # sibling sprint id | pi-id/sprint-id | a whole PI id
        est_sessions: 3           # focused sessions remaining (drives rollups + scheduling)
        touches: [src/session.ts] # files written; used for two-wave contention detection
        gate: |
          {{default}}
          PLUS the session integration tests
        read_order: ["docs/auth.md (the design)"]
        resume_action: Wire JWT issuance + refresh; thread through middleware.
        priority:                 # optional; sort is derived (tier asc, weight desc), never stored
          tier: P1
          weight: 60
          reason: launch blocker for the pilot
        prompt: |                 # optional author-stashed pickup instructions — embedded VERBATIM
          Start from the failing e2e test in tests/session.e2e.ts.   # in the kickoff brief; shown
          Do not touch the middleware pipeline.                      # by /slice and roadmap show
        track: A                  # optional lane label (forward-compat with the three-track partition)
        execution:                # optional per-slice staffing-strategy hint (see below)
          mode: agent-team
          concurrency: 5
          min_concurrency: 4
          team:
            - role: verifier
            - role: implementer
              count: 3
            - role: reviewer
          rationale: "16 disjoint fault-class files; verifier-first; one reviewer reconciles."
```

- **`invoke`** is the slice key you launch with. Stable and unique across the file, so renaming a title never breaks a reference.
- **`deps`** are the DAG edges; the exec-plan line and wave map are *derived* from them.
- **`touches`/`owns`** mechanize the two-wave pattern: two ready slices that write the same file never share a wave; a convergence sprint just `deps`-on the divergent ones.
- **`gated_on: <name>`** marks a human-gated slice. It never auto-schedules; it surfaces under "held on a human."
- **`worker_mode`** sets the `--permission-mode` launched sessions start in; **`weight`** (`heavy|medium|light`) optionally overrides a sprint's inferred resource class.
- **`agent_cmd`** templates every INTERACTIVE worker/lead launch (`{mode}` + `{prompt}` tokens) so fanout can spawn codex or any other CLI agent; the default reproduces today's claude command byte-for-byte. Autonomous headless launches stay claude.
- **`priority`** (`{ tier: P0–P3, weight: 0–100, reason }`, all optional) decides who gets a scarce cap slot within a wave, badges the renders (`[P0]`), and drives `roadmap next`. Two unprioritized slices order exactly as before — an existing roadmap schedules and renders identically.
- **`prompt`** is the stashed init prompt: `/slice <key>` relays it, the synthesized kickoff brief embeds it verbatim (`## 0.5 Author instructions`), and it's updatable as new info comes in via `roadmap set <key> prompt=@notes.md` or the `set_fields`/`bulk_set` tools.
- **`execution`** declares HOW to staff the slice (see [Execution strategy hints](#execution-strategy-hints)); **`track`** tags the slice's lane for `--track`.

### Execution strategy hints

Agents chronically **under-parallelize** — a lone subagent where a team fits, 2–3 workers where 5+ are fruitful, rarely reaching for Agent Teams. The optional per-slice `execution:` block lets the author *declare* the staffing so the launched session works at the intended topology instead of choosing by gut. **Every field is optional and backward-compatible: a slice that omits the block behaves exactly as before, and an existing `roadmap.yaml` validates and renders unchanged.**

```yaml
execution:
  mode: agent-team        # solo | subagents | dynamic-workflow | agent-team
  concurrency: 5          # suggested LIVE worker count
  min_concurrency: 4      # floor — /sync warns if a run used fewer on disjoint files
  team:                   # composition (omit for solo); roles: verifier|implementer|reviewer|researcher|integrator
    - role: verifier
    - role: implementer
      count: 3
    - role: reviewer
  rationale: "16 disjoint fault-class files; verifier-first; one reviewer reconciles."
```

**Modes** (the topology rubric):

| `mode` | When | What the directive tells the session |
|---|---|---|
| `solo` | Atomic, exploratory, or branching-sequential work. | Single agent, no fan-out. |
| `subagents` | A scoped sprint: lead-merges + disjoint-file workers (the current default). | Spawn N background subagents per CLAUDE.md § Subagent Hand-off. |
| `dynamic-workflow` | An in-slice pipeline whose steps depend on each other. | Run a step-gated pipeline; don't collapse it to one pass. |
| `agent-team` | Many genuinely-independent file-clusters needing peer coordination. | Invoke Agent Teams now (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) with the named count + composition. |

The block renders as an **imperative directive** at the top of the slice's read-out — in `SLICES.md`, in `roadmap show` / `/slice`, and verbatim in each launched session's kickoff brief:

```
▶ EXECUTION: agent-team — 5 workers (1 verifier · 3 implementers · 1 reviewer).
  The touched files are disjoint. DO NOT run solo or fewer than 4. Invoke Agent Teams now (set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1).
  Rationale: 16 disjoint fault-class files; verifier-first; one reviewer reconciles.
```

**Validation** (`roadmap validate`) checks the enums (`mode`, `role`), the integer bounds (`concurrency`/`min_concurrency`/`count` ≥ 1), `min_concurrency ≤ concurrency`, and that a declared `team` head-count agrees with `concurrency` when both are present. When `execution` is absent or `concurrency` is unset, a *suggested* floor is computed from the slice's `touches` (the count of distinct disjoint top-level dir clusters, capped at 6) and surfaced as a hint — never a hard default. After a wave, `/sync` flags any slice that declared a `min_concurrency` floor, touches disjoint dirs, yet ran with fewer live workers (*"slice X ran 2 workers; min_concurrency 4 — under-parallelized"*).

**`--track`** lets one person fan out only their lane: `roadmap fan --wave 1 --track A` keeps just the wave's slices tagged `track: A` (forward-compat with the three-track partition).

---

## The backlog (backlog.yaml)

Roadmap work is planned, feature-driven, value-driven. But there's a second kind of work — follow-ups, necessary chores, trivial fixes, urgent/critical items — that **surfaces erratically** and needs a tracker, not a plan. That's `docs/roadmap/backlog.yaml`, rendered to `docs/BACKLOG.md` (priority-tier sections, untriaged last, in-progress / promoted / recently-closed tables). `SLICES.md` carries a one-line pointer with the open count.

```yaml
meta:
  schema_version: 1
items:
  - id: fix-wt-quoting            # stable slug; auto b1..bN when omitted at add
    title: wt adapter mangles prompts containing quotes
    kind: bug                     # bug | chore | followup | urgent | idea
    status: open                  # open | in_progress | promoted | done | dropped
    priority: { tier: P1, weight: 70, reason: breaks every Windows fanout }
    source: { slice: fanout-adapters, date: 2026-07-06 }   # where it surfaced
    refs: [fanout-adapters]       # related roadmap slices
    touches: [scripts/fanout.mjs]
    est_sessions: 0.5
    gate: default                 # inherits the roadmap's meta.default_gate
    prompt: |                     # embedded verbatim in the grab kickoff brief
      Repro: roadmap fan -t wt with a prompt containing '"'.
      Fix the wtSafe escaping; add a run.mjs case.
```

**Capture** anywhere work surfaces: `/backlog` (in-session dump → normalized items), `roadmap backlog add` (shell), `backlog_add` (agents), or automatically at the end of a slice — every kickoff brief tells the worker to file leftovers before opening its PR, and `/sync` harvests any that landed as a PR-body "Leftovers" section instead.

**Consume** by size:

- **Small / self-contained** → `roadmap grab <id>`: its own worktree (`<root>/backlog-<id>`, branch `backlog/<id>`) and session, kickoff brief synthesized from the item (prompt embedded), item marked `in_progress`.
- **Bigger / belongs in the plan** → `roadmap promote <id> --pi <pi>`: becomes a `scheduled` sprint (the item id becomes the invoke key; title/est/gate/touches/prompt/priority carry over) with a `promoted_to` back-link on the item. Both YAMLs are validated before either is written.
- **Not sure what's next?** → `roadmap next` picks the single highest-priority ready thing across both trackers (roadmap wins ties) and prints its pickup brief.

---

## Linear (optional) — project-manage from Linear while agents execute

Add `meta.linear` and the roadmap projects itself into Linear: **the YAML stays canonical; Linear is a projection plus a proposal inbox.** Humans see and steer the plan on a board; agents keep executing from the graph; nothing is written twice.

```yaml
meta:
  linear:
    team: ENG                      # push target (team key). Auth = LINEAR_API_KEY env var, never a file.
    granularity: slices            # pis (Projects only) | slices | slices+backlog — what leaks to Linear
    verbosity: brief               # title | brief | full — issue-description detail
    pull: propose                  # off | propose (walk the inbox in /sync) | auto
    status_map: { blocked: "Blocked" }   # optional exact-name overrides; defaults map by state TYPE
    watch:                         # inbound sources — e.g. a public "Submit an issue" team
      - { team: PUB, project: "Submit an issue", kind: bug, priority: { tier: P3 } }
```

**Mapping.** PI ↔ Linear **Project** (grouped under an **Initiative** when `pi.initiative` is set) · slice / backlog item ↔ **Issue** · `priority.tier` P0–P3 ↔ Urgent/High/Medium/Low · `status` ↔ workflow state by TYPE (`active`→In Progress; `next`/held→Todo; `scheduled`/`optionality`→Backlog; `complete`→Done; `status_map` overrides by name) · `est_sessions` → the issue's native **estimate** (rounded to an integer, clamped to `estimate_max`) — a sortable board column, not prose. Issue ids are written back into the YAML (`linear: ABC-123`) — the mapping's source of truth survives any machine.

**Project enrichment.** A PI's project carries a rich `content` body (the full theme + exit criteria + deps — the uncapped project doc, so nothing truncates) and a concise `description` subtitle (the exit's first sentence). Optional `pi.priority` (a **strategic** tier, *not* derived from slice heat — an urgent slice shouldn't hijack a PI's ranking) → the project's Linear priority; optional `pi.target_date` (`YYYY-MM-DD`) → its target date. Every project also gets a **color + icon by initiative** (same initiative → same hue + glyph), so the board reads as grouped lanes instead of Linear's random per-project assignment. Declare meaningful styling in `meta.initiatives` (`{ <name>: { icon, color } }`, e.g. `Lumen: { icon: WritingAI }`, `Trust surface: { icon: Shield }`) so grouping is *signal* rather than a coincidence of first-seen order — a declared initiative also gets its **header** styled to match. Undeclared initiatives keep Linear's default header, and their projects use the deterministic fallback palette. Icon names are a fixed Linear set pushed best-effort — an unrecognized name degrades to "no icon" (color still groups) rather than failing the sync. `validate` warns when a `meta.initiatives` entry names an initiative no PI references (a typo, or a half-applied rename).

**Estimates & the split-don't-extend rule.** `est_sessions` rides the issue's native estimate field, so session cost sorts and rolls up on the board. Set your Linear team to the **Linear scale** (`1..5`) for a direct 1-point = 1-session read (Fibonacci/T-shirt would distort it), and leave `meta.linear.estimate_max` at its default `5`. `validate` warns when a slice's estimate exceeds the max — the deliberate signal to **split** an oversize slice, not extend the scale: a slice bigger than one agent session isn't a slice. (Raise `estimate_max` to `7` only if you genuinely extend the team's scale.)

**Push** (`roadmap linear sync`, or automatically inside `/sync` when authed): diff-based and idempotent — an unchanged roadmap sends zero ops. Descriptions follow the `verbosity` lever, never copy read-order/prompt, and always end with a machine footer (`roadmap: slice=<invoke> · pick up: /slice <invoke>` + a SLICES.md link) — so an agent dispatched *from Linear* (via Linear's own agent delegation or hosted MCP) self-orients in one command. Set `branch_convention: "{pi}/{linear}-{sprint}"` and Linear auto-links every fanout PR to its issue.

**Pull.** New issues in `watch` sources become **proposed backlog items** carrying `source.linear: {team, project, issue}` — so `/prioritize` can weight work by where it came from (a public intake team ≠ a maintainer capture), with the watch's default `priority` as the implicit weighting. Edits to mapped issues (state/priority changes made in Linear) become proposed deltas. With `pull: propose` (recommended), `/sync` walks the inbox with you — keep / edit / skip per item; nothing enters the graph unconfirmed. The sync cursor is per-machine (`.roadmap-linear-state.json`, git-ignored) and only advances once the inbox is handled, so unhandled proposals reappear rather than vanish.

**Detection is graceful.** No `meta.linear` → every Linear behavior is off and the tool is byte-identical to before. Configured but no `LINEAR_API_KEY` → one advisory line, everything else works. The session-start hook reports state with zero network; `roadmap linear status --probe` is the only networked check. Bootstrap: `roadmap linear auth` (key instructions) → `roadmap linear setup --team <KEY>` → `roadmap linear sync --dry`.

**Per-PI override.** A PI can set its own `linear.granularity` (e.g. keep an internal PI's slices off a shared board). Creating one that conflicts with the global requires an explicit `yes_linear_override: true` ack — otherwise the mutation is rejected with instructions and nothing is written; `roadmap validate` warns on stored mismatches.

### Topology: Linear as the board

The recommended workspace shape at agent scale: **one team per actively-managed repo** (dispatch routing is deterministic, workflow states and `status_map` compose 1:1, and the issue identifier tells you the repo), **PIs = Projects, slices/items = Issues, native priority = tier**, plus **one shared intake team** (a public "Submit an issue" board) wired as a `watch` source. Repos not under agent management get no team.

`roadmap linear provision` shapes the workspace idempotently: creates the labels the graph knows (`roadmap` marker on every synced issue, `kind:*` for backlog items, `track:*` for the lanes present, `status:*` for held work), the standard views (**Ready wave · In flight · Held on human · Backlog triage · Recently shipped** plus a **Track X** view per lane; view API rejection degrades to a manual checklist), and prints two guidance texts — the workspace agent guidance and the **repo dispatch contract** for `CLAUDE.md`/`AGENTS.md`. Projects carry PI theme + exit criteria as descriptions.

**A clean board, not a wall.** The projection is honest and navigable, not a 1:1 dump:
- **Empty projects are skipped.** A PI whose slices are all shipped doesn't create a bare 0-issue project (already-mapped projects stay in sync).
- **Project names are the PI headline.** A title authored `Headline — subhead` projects as just **Headline**; the subhead moves into the description. No context lost, no tacky names.
- **Only `active` shows In Progress.** Held work (`blocked`/`paused`/`gated`) maps to Todo with a `status:<held>` label, so the board's In-Progress count means real live work and the "Held on human" view filters the rest. (The pull inbox also suppresses the round-trip echo, so held slices don't generate false status proposals every sync.)
- **Initiatives group the projects.** A PI declares `initiative: <name>` and sync creates the Linear Initiative (the tier above projects) and attaches the PI's project — turning a flat wall of projects into a handful of strategic groups you can steer. *(The initiative API is behind graceful degradation, pending live verification.)*

### Cloud dispatch

`roadmap dispatch <key>` sends one slice/backlog item to a **Claude Code cloud session** — the default `claude-cloud` transport fires the Routines API directly (**no Linear plan required, no worktrees, no disk ceiling**; bounded only by the firing account's Claude plan). Multi-account workstations hot-swap automatically: routine credentials live in `~/.claude-routines.json` keyed by account email, and dispatch fires as **whoever is currently `claude /login`'d** (see [DEPLOYMENT.md § Cloud dispatch](docs/DEPLOYMENT.md)). When the slice is also Linear-mapped, the session URL is commented onto the issue — the board links to the live session. ⚠ Routines fire is a beta API.

`roadmap fan --cloud` does it for a whole wave; the cap defaults to the review ceiling (machine ceilings vanish, but a human still merges). The alternative `--to claude|codex|oz` transport posts an @-mention capsule comment on the Linear issue instead — useful when the workspace has that agent's integration installed (Linear's native coding sessions are paid-plan-gated).

---

## Riding the wave: discipline + the review ritual

Two second-order effects of agent-scale work, both encoded:

**Sprawl curbing (advisory, never blocking).** Helpful agents love filing follow-up scope; unchecked, every sprint spawns two backlog items and a sibling sprint. The kickoff brief now hard-forbids worker sessions from adding sprints/PIs (leftovers go to the **backlog only**; "YAGNI applies to captures too"), the `add_sprint`/`add_pi` tool descriptions carry the same scope-discipline nudge, and `/sync` + the review digest surface **sprawl warnings**: a capture ratio ((captured items + added sprints) per completed slice, threshold `meta.discipline.capture_ratio`, default 2) plus an unconditional flag on any PI that appeared since the last review.

**Coherence wave packing.** Under a cap, the scheduler now prefers **finishing started PIs over opening fresh ones** (then closest-to-done first) — strictly *below* declared priority, so a P0 in a fresh PI still wins. Same-PI siblings fill the cap contiguously, `roadmap plan` prints `(closes auth)` on waves that finish a PI, and the digest reports **PIs in flight** (the fragmentation count). Opt out with `meta.discipline.coherence: false`.

**The review ritual — three modalities.** This is how the human stays in control of the deluge:

- **`/debrief`** — atomic lookback, **no graph mutations**: `roadmap review` diffs the graph against the date-anchored snapshot (`meta.last_review.commit`, via `git show`) and the skill presents it under hard style rules (≤15 lines; recommendations in "X instead of Y" form, tied to the north star; agent-originated scope named; no cheerleading), then logs a ≤10-line hand-authored entry to `docs/roadmap/REVIEWS.md` and re-anchors.
- **`/imagine` + `/prioritize`** — the forward atomics (strategy interview; tier triage with forced reasons).
- **`/retro`** — the composition: the debrief lookback, then per-bet **double-down / kill / defer** (every kill names what the freed sessions buy; every sprawl-flagged sidequest gets an explicit keep-or-drop), decisions applied through the mutation tools, optional `/imagine` handoff, and the close covers the decisions. When Linear is wired, the digest posts as project updates (`roadmap linear post-update`).

`roadmap review [--since <rev|date>] [--json]` is the engine: shipped vs captured vs aging vs new PIs vs sprawl, computed from git history — works with zero Linear.

---

## Feasibility pre-checks (the disk ceiling)

Fanning out N worktrees costs real disk. `roadmap plan` / `fan` / `grab` estimate the per-worktree cost (the tracked tree's size × 1.3, or `meta.worktree_gb` when your gates install `node_modules`/build artifacts per worktree — that's the calibration knob) and compare it against free space on the volume holding `meta.worktree_root`. Disk joins CPU / RAM / work / review as a **fifth ceiling**: the recommended cap auto-dials down and the plan reports `bound by: disk (need ~X GB/worktree, Y GB free)`. When even **one** worktree won't fit, `fan` and `grab` refuse to launch before creating anything. If the environment can't be probed (no git HEAD, unsupported statfs), the ceiling silently drops out — never blocking a plan on a failed probe.

---

## Install

> **Full deployment guide** — every surface (CLI, Claude Code plugin, standalone MCP, Claude Desktop, Codex, CI), exactly where config vs. secrets live, Linear setup per environment, and the planned Jira shape: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. The short versions follow.

### The `roadmap` CLI

```bash
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link
```

`npm link` puts `roadmap` on your PATH in every shell. On Windows it writes `roadmap.cmd`/`roadmap.ps1` shims (PowerShell and cmd) plus a unix bin (WSL/bash; run `npm link` once in each Node environment you use). `npm unlink -g roadmap` removes it.

### In Codex

No plugin install is required. Open the repo in Codex, use the commands above, and rely on [`AGENTS.md`](AGENTS.md) for repo-local guidance.

For MCP usage in agent environments, run:

```bash
npm run mcp
```

The checked-in [`.mcp.json`](.mcp.json) remains the Claude-plugin entrypoint (server name `graph`).

**Alias fallback (no npm):** drop a shim in your shell profile instead.

```powershell
# PowerShell, $PROFILE
function roadmap { node "$HOME\Code\roadmap\scripts\cli.mjs" @args }
```
```bash
# bash/zsh, ~/.bashrc / ~/.zshrc
roadmap() { node "$HOME/Code/roadmap/scripts/cli.mjs" "$@"; }
```

### As a Claude plugin

The repo is its own marketplace (`.claude-plugin/marketplace.json`). Add it, then install:

```bash
# from a GitHub clone:
claude plugin marketplace add ConnorBritain/roadmap
# or from a local checkout:
claude plugin marketplace add /path/to/roadmap

claude plugin install roadmap@roadmap   # user scope; --scope project to pin per-repo
```

That wires the skills, agents, the SessionStart hook, the PR-watch monitor, and the MCP server in one step (new sessions pick them up; `/mcp` reconnects the current one). The plugin bundles its MCP via `.mcp.json` as `graph`, so don't also `claude mcp add` a second copy of the server.

### Upgrading from `slice-roadmap` (≤ 0.1.x)

The plugin, marketplace entry, and npm package were renamed **`slice-roadmap` → `roadmap`** (and the bundled MCP server `roadmap` → `graph`) in 0.2.0. Old installs won't auto-update — migrate once:

- **npm:** `npm unlink -g slice-roadmap`, then `npm link` again from the repo (per Node environment). The `roadmap` bin name itself is unchanged.
- **Plugin:** `claude plugin uninstall slice-roadmap`, re-add the marketplace, `claude plugin install roadmap@roadmap`.
- **⚠ Permission allow-lists:** any `settings.json` entries naming `mcp__plugin_slice-roadmap_roadmap__*` tools **silently stop matching** — rewrite them as `mcp__plugin_roadmap_graph__*`.
- **Skills:** `/slice` is unchanged; `/slice-sync` → `/sync`, `/slice-init` → `/init`, `/slice-fanout` → `/fanout` (plus new `/backlog`).
- **Env:** the api-lane variable is now `ROADMAP_API_KEY` (was `SLICE_ROADMAP_API_KEY`).
- **Generated files:** the first `roadmap render` after upgrading rewrites SLICES.md boilerplate with the new skill names — a one-time diff.

### Recommending it in a consuming repo

Don't commit a device-specific alias into a repo. Point contributors at this tool from your onboarding docs (e.g. a CONTRIBUTING note): *"Drive the roadmap from your shell. Clone `roadmap`, `npm install && npm link`, then run `roadmap` from anywhere in this repo."* A consuming repo only ever carries its own `docs/roadmap/roadmap.yaml` and `backlog.yaml` (plus the generated `SLICES.md` / `BACKLOG.md`).

---

## What's built

- **Graph brain** (`graph.mjs`): dependency resolution (sibling / fully-qualified / whole-PI deps), cycle detection, wave scheduling with two-wave file-contention + priority-first cap packing, sessions-remaining and exec-plan derivation.
- **Priority** (`lib/priority.mjs`): the shared tier/weight/reason model — validation, the derived comparator, tier badges.
- **Backlog** (`lib/backlog-core.mjs` + `backlog.mjs`, `grab.mjs`, `promote.mjs`, `next.mjs`): the erratic-work tracker — capture/triage/launch/promote, `BACKLOG.md` rendering, the item→node adapter that reuses the fanout brief machinery, and cross-tracker pick-next.
- **Renderer** (`render.mjs`): hierarchical `SLICES.md` (per-PI sections, nested sprint tables, priority badges, derived exec-plan lines, cross-PI wave map, held-on-human, backlog pointer) + `BACKLOG.md`.
- **Scheduler** (`scheduler.mjs`): recommended-cap eval (CPU / RAM / independent-work / review / **disk** ceilings, reporting which binds) plus the waves.
- **Fanout** (`fanout.mjs`): `tmux`, `wt`, `warp`, `print`, `background` adapters; per-slice worktree plus synthesized kickoff brief (stashed `prompt` embedded, leftover-capture instruction); disk hard-block; the interactive console (`wizard.mjs`); guarded launch (`--dry`/`--out` preview, autonomous double-ack); `cleanup.mjs` worktree pruning.
- **Shared mutation store** (`lib/store.mjs`): the one read → mutate → validate → write → re-render path under every mutating surface (MCP, `set`, `backlog`, `promote`), including the validate-both-before-writing-either two-file promote.
- **Plugin surface**: five skills (`slice`, `sync`, `init`, `fanout`, `backlog`), four agents, and a `SessionStart` hook (ready wave + reconcile nudge + backlog count).
- **MCP server** (`mcp.mjs`, server `graph`): a bundled, hand-rolled JSON-RPC stdio server with read tools (plan / ready_wave / show / validate / backlog_list) and comment-preserving, schema-validated mutate tools (add_pi / add_sprint / set_status / set_fields / bulk_set / prune / backlog_add / backlog_set / backlog_promote) that re-render the generated views on every edit.
- **PR-watch monitor** (`watch-prs.mjs` + `lib/pr-watch-core.mjs` + `monitors/monitors.json`): polls `gh` for the fanout branches and notifies the lead on each PR phase transition.
- **Tests**: `npm test` runs the zero-dependency suite over the pure brain (graph, recommender + disk ceiling, priority, backlog, brief, plan, render, validate, CLI core, wizard core, MCP core, PR-watch core).

The resource classifier matches build/test runner commands, not languages. It ships patterns for the common runners (`npm`/`yarn`/`pnpm`, `jest`, `vitest`, `tsc`, `pytest`, `tox`, Maven, Gradle, `make`, CMake/CTest, `go`, `cargo`, and more), ordered by how common they are, and `meta.weight_patterns` teaches it any bespoke runner.

## Requirements & license

Node 18.15+ (for `fs.statfsSync`, the disk pre-check) and a one-time `npm install` (for the `yaml` parser). MIT licensed.
