# Roadmap: scope, manage, and orchestrate Claude Code sessions in any repo

`roadmap` is a CLI and a Claude Code plugin. It turns one YAML file into your repo's plan of record (a **hierarchical, dependency-aware graph**), then **fans that plan out into parallel Claude Code sessions**, each scoped to a single unit of work in its own git worktree.

- **One source of truth.** `docs/roadmap/roadmap.yaml` holds the PIs, sprints, deps, file-ownership, session estimates, gates, and kickoff briefs.
- **Generated view.** `docs/SLICES.md` is *rendered* from the YAML; never hand-edit it.
- **Derived, never stored.** Per-PI exec-plan lines (`(S0 ∥ S1)→S2→S3`), the cross-PI "ready now" wave map, and "sessions remaining" rollups are all computed from `deps` + `touches` + `status`.
- **Deterministic fanout.** A scheduler decides which slices can run concurrently under a cap (which it *recommends* from a CPU/RAM and review eval), then launches each in its own worktree and Claude Code session.
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
| **Wave** | The set of slices that can run **concurrently right now**: mutually dependency-free, sharing no files, under the cap. |
| **Fanout** | Launching a wave. One git worktree plus Claude Code session per slice, plus an optional **lead** session that reviews and merges the resulting PRs. |

> **Roadmap = the whole plan. Slice = one launchable piece of it.**
> You edit the **roadmap** (the YAML); you launch **slices** (by `invoke` key). `SLICES.md` is the human-readable render of the roadmap, generated and never hand-edited.

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
roadmap render     # regenerate docs/SLICES.md
roadmap validate   # structural + cycle checks
roadmap fan -w 1   # spin up wave 1 (lead + slice sessions); add -d to preview first
```

That's the whole loop: `cd` into a repo, type `roadmap ...`, it finds the roadmap and fires.

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
| `roadmap plan [-c N] [--review-ceiling N] [--use-free-ram] [-j]` | **Recommended cap** (and what constrains it), the execution **waves**, and per-node launch commands. Spawns nothing. `-j/--json` emits the plan for tooling. |
| `roadmap render [-c N] [-s]` | Regenerate `docs/SLICES.md` from the YAML (`-s/--stdout` prints instead of writing). |
| `roadmap validate` | Structural, dependency, and cycle checks. Non-zero exit on error. |
| `roadmap fan [-t wt\|warp\|tmux\|print\|background] [-c N] [-w N] [--track A] [--lead-claude] [-d] [-o file] [--worker-mode <m>] [--autonomous --yes-spawn-autonomous]` | Launch a wave: a lead pane/tab plus one per slice, each in its own worktree with a synthesized kickoff brief. **Launches by default**; `-d/--dry` or `-o/--out` to preview. `--track <lane>` fans out only the slices in that lane. Worker **and** lead sessions take `--permission-mode` from `meta.worker_mode` (falls back to `plan`); `--worker-mode` overrides per run. Terminal defaults per platform (win32 to `wt`, else `tmux`). |
| `roadmap cleanup [-r] [-f]` | Prune fanout worktrees merged into the base branch and clean. **Dry by default**; `-r/--remove` acts; `-f/--force` includes unmerged/dirty. Only touches worktrees under the worktree root. |
| `roadmap mcp` | Run the MCP server (stdio JSON-RPC) directly, for debugging or non-plugin registration. The plugin starts it for you. |
| `roadmap watch` | Watch this roadmap's fanout PRs and print a line as each becomes ready / conflicts / merges. The plugin runs it as a monitor; this is the manual pane version. |
| `roadmap sync` / `roadmap init` | Reserved on the CLI. Reconcile and bootstrap live as the `/slice-sync` and `/slice-init` **plugin skills** (surface 2). |

Short flags (`-w -c -t -d -o -j -r -f -lc -wm`) expand to their long forms; positional slice keys pass through untouched.

```bash
# See the plan + why the cap is what it is (the binding constraint is reported):
roadmap plan
#   Concurrency cap: 5 (recommended)
#     bound by: review (PR review/merge bottleneck, soft ceiling)
#     machine:  24 cores, 59.6GB total / 20.6GB free
#     ceilings: 12 [CPU] · 13 [RAM] · 23 [work] · 5 [review]
#   Wave 1, 5 concurrent: auth-sessions, billing-invoices, search-index, ...

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
  - `/slice <key>`: orient on one slice (read-only) by its what, read-order, next action, gate, and branch.
  - `/slice-sync`: reconcile statuses against merged PRs and the tracker, then re-render `SLICES.md`.
  - `/slice-init`: a PM-style interview that bootstraps a `roadmap.yaml` (warm-start from existing docs, or cold).
  - `/slice-fanout`: compute the waves and launch (wraps the same scheduler and adapters as the CLI).
- **Hook** (`hooks/hooks.json`): a `SessionStart` hook injects the at-a-glance plus the current ready-wave, so a fresh session immediately knows what's runnable (and, on first run, installs the `yaml` dep).
- **Agents** (`agents/*.md`): four specialized subagents Claude invokes across the roadmap, fanout, and review lifecycle.

| Agent | Role | Read/write | Suggested model |
|---|---|---|---|
| **roadmap-bootstrapper** | Cold/warm-start: reads the repo's existing roadmap docs, tracker, sprint dirs, and `git log`, and **drafts a `roadmap.yaml`**. Used by `/slice-init` to pre-fill before the interactive confirmation. | reads repo, proposes YAML | sonnet |
| **slice-scoper** | Takes a thin `scheduled` slice and **fills it in**: infers `touches`/`owns` by grepping the code, drafts `read_order`, `est_sessions`, and the `gate`, and writes the sprint spec, turning it into a `next`-ready slice. | reads code, proposes slice fields | sonnet/opus |
| **roadmap-auditor** | Read-only **drift and gap finder**: audits `roadmap.yaml` against reality (merged PRs, strategy docs, sprint dirs) and reports stale statuses and un-surfaced work. | read-only report | sonnet |
| **wave-shepherd** | The **lead-pane brain**: after a fanout wave produces PRs, reviews each against its slice's gate and scope and recommends a safe **merge order** (respecting deps, flagging conflicts). Reviews; never merges. | read-only review | opus |

The CLI and the plugin share the same scripts: the CLI is your *shell* entry, the plugin is the *in-session* entry. The interactive PM interview stays a **skill** (not an agent), because a forked subagent can't hold a back-and-forth with you.

### 3 · MCP (agent-callable)

The plugin ships its own MCP server (`.mcp.json`, auto-started on install), so an agent drives the roadmap with typed tools instead of shelling out and parsing text:

- **Read:** `plan`, `ready_wave`, `show`, `validate` return structured JSON.
- **Mutate:** `add_pi`, `add_sprint`, `set_status`, `set_fields`, `prune` edit `roadmap.yaml` through the YAML Document API (comments preserved), refuse any edit that would corrupt the graph (duplicate invoke key, unresolved dependency, cycle), and re-render `SLICES.md` in the same step. Seed and scaffold a roadmap, flip a slice to complete with its PR, or prune finished work, all schema-safe and atomic.

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
- **`execution`** declares HOW to staff the slice (see [Execution strategy hints](#execution-strategy-hints)); **`track`** tags the slice's lane for `--track`.

### Execution strategy hints

Agents chronically **under-parallelize** — a lone subagent where a team fits, 2–3 workers where 5+ are fruitful, rarely reaching for Agent Teams. The optional per-slice `execution:` block lets the author *declare* the staffing so the launched session works at the intended topology instead of choosing by gut. **Every field is optional and backward-compatible: a slice that omits the block behaves exactly as before, and an existing `roadmap.yaml` validates and renders unchanged.**

```yaml
execution:
  mode: agent-team        # solo | subagents | dynamic-workflow | agent-team
  concurrency: 5          # suggested LIVE worker count
  min_concurrency: 4      # floor — /slice-sync warns if a run used fewer on disjoint files
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

**Validation** (`roadmap validate`) checks the enums (`mode`, `role`), the integer bounds (`concurrency`/`min_concurrency`/`count` ≥ 1), `min_concurrency ≤ concurrency`, and that a declared `team` head-count agrees with `concurrency` when both are present. When `execution` is absent or `concurrency` is unset, a *suggested* floor is computed from the slice's `touches` (the count of distinct disjoint top-level dir clusters, capped at 6) and surfaced as a hint — never a hard default. After a wave, `/slice-sync` flags any slice that declared a `min_concurrency` floor, touches disjoint dirs, yet ran with fewer live workers (*"slice X ran 2 workers; min_concurrency 4 — under-parallelized"*).

**`--track`** lets one person fan out only their lane: `roadmap fan --wave 1 --track A` keeps just the wave's slices tagged `track: A` (forward-compat with the three-track partition).

**Cross-harness.** The directive's *intent* (mode, count, composition, floor) is harness-neutral; only the *wording* is dialect. `meta.harness` (`claude` default | `codex` | `generic`) — or `--harness` per run — selects the profile, so `agent-team` renders as "Invoke Agent Teams" on Claude but degrades to "N parallel `codex exec` sessions; the integrator reconciles" on Codex (and a neutral form for any ACP orchestrator like OpenClaw/Hermes). An unknown harness or non-native mode warns and falls back/degrades — never errors. See [`docs/cross-harness.md`](docs/cross-harness.md) for the full two-tier design (launch profiles vs. ACP interop).

---

## Install

### The `roadmap` CLI

```bash
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link
```

`npm link` puts `roadmap` on your PATH in every shell. On Windows it writes `roadmap.cmd`/`roadmap.ps1` shims (PowerShell and cmd) plus a unix bin (WSL/bash; run `npm link` once in each Node environment you use). `npm unlink -g slice-roadmap` removes it.

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

claude plugin install slice-roadmap@roadmap   # user scope; --scope project to pin per-repo
```

That wires the skills, agents, the SessionStart hook, the PR-watch monitor, and the MCP server in one step (new sessions pick them up; `/mcp` reconnects the current one). The plugin bundles its MCP via `.mcp.json`, so don't also `claude mcp add roadmap` (you would get two servers named `roadmap`).

### Recommending it in a consuming repo

Don't commit a device-specific alias into a repo. Point contributors at this tool from your onboarding docs (e.g. a CONTRIBUTING note): *"Drive the roadmap from your shell. Clone `roadmap`, `npm install && npm link`, then run `roadmap` from anywhere in this repo."* A consuming repo only ever carries its own `docs/roadmap/roadmap.yaml` (plus the generated `SLICES.md`).

---

## What's built

- **Graph brain** (`graph.mjs`): dependency resolution (sibling / fully-qualified / whole-PI deps), cycle detection, wave scheduling with two-wave file-contention, sessions-remaining and exec-plan derivation.
- **Renderer** (`render.mjs`): hierarchical `SLICES.md` (per-PI sections, nested sprint tables, derived exec-plan lines, cross-PI wave map, held-on-human).
- **Scheduler** (`scheduler.mjs`): recommended-cap eval (CPU / RAM / independent-work / review ceiling, reporting which binds) plus the waves.
- **Fanout** (`fanout.mjs`): `tmux`, `wt`, `warp`, `print`, `background` adapters; per-slice worktree plus synthesized kickoff brief; the interactive console (`wizard.mjs`); guarded launch (`--dry`/`--out` preview, autonomous double-ack); `cleanup.mjs` worktree pruning.
- **Plugin surface**: four skills (`slice`, `slice-sync`, `slice-init`, `slice-fanout`), four agents, and a `SessionStart` hook.
- **MCP server** (`mcp.mjs` + `lib/mcp-core.mjs`): a bundled, hand-rolled JSON-RPC stdio server with read tools (plan / ready_wave / show / validate) and comment-preserving, schema-validated mutate tools (add_pi / add_sprint / set_status / set_fields / prune) that re-render `SLICES.md` on every edit.
- **PR-watch monitor** (`watch-prs.mjs` + `lib/pr-watch-core.mjs` + `monitors/monitors.json`): polls `gh` for the fanout branches and notifies the lead on each PR phase transition.
- **Tests**: `npm test` runs the zero-dependency suite over the pure brain (graph, recommender, brief, plan, render, validate, CLI core, wizard core, MCP core, PR-watch core).

The resource classifier matches build/test runner commands, not languages. It ships patterns for the common runners (`npm`/`yarn`/`pnpm`, `jest`, `vitest`, `tsc`, `pytest`, `tox`, Maven, Gradle, `make`, CMake/CTest, `go`, `cargo`, and more), ordered by how common they are, and `meta.weight_patterns` teaches it any bespoke runner.

## Requirements & license

Node 18+ and a one-time `npm install` (for the `yaml` parser). MIT licensed.
