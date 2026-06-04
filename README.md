# Roadmap — scope, manage, and orchestrate Claude Code sessions in any repo

`roadmap` is a CLI **and** a Claude Code plugin that turns one YAML file into your repo's plan of record — a **hierarchical, dependency-aware graph** — then **fans that plan out into parallel Claude Code sessions**, each scoped to a single unit of work in its own git worktree.

- **One source of truth** — `docs/roadmap/roadmap.yaml` (PIs → sprints, deps, file-ownership, session estimates, gates, kickoff briefs).
- **Generated view** — `docs/SLICES.md` is *rendered* from the YAML; never hand-edit it.
- **Derived, never stored** — per-PI exec-plan lines (`(S0 ∥ S1)→S2→S3`), the cross-PI "ready now" wave map, and "sessions remaining" rollups, all computed from `deps` + `touches` + `status`.
- **Deterministic fanout** — a scheduler decides which slices can run concurrently under a cap (which it *recommends* from a CPU/RAM + review eval), then launches each in its own worktree + Claude Code session.
- **Repo-agnostic** — the resource classifier knows .NET / Node / Rust / Python / Go / Gradle / Maven / Ruby / Elixir / make / Bazel out of the box; every repo-specific assumption (gate, base branch, weights, doc links) comes from `meta`.

---

## Concepts

`roadmap` has a small, deliberate vocabulary:

| Term | What it is |
|---|---|
| **Roadmap** | The whole graph — every PI and sprint in `roadmap.yaml`. The map of *all* the work. |
| **PI** *(Program Increment)* | A top-level initiative / epic. Groups related sprints; carries a status, dependencies, and exit criteria. |
| **Sprint** | A unit of work inside a PI (`s1`, `s2`, …). Carries its deps, the files it `touches`, a session estimate, a verification `gate`, and a kickoff brief. |
| **Slice** | A sprint *as the thing you act on*, addressed by its stable `invoke` key (e.g. `auth-sessions`): "show me a slice", "fan out this slice." The slice is the atomic, **launchable** unit. |
| **Wave** | The set of slices that can run **concurrently right now** — mutually dependency-free, sharing no files, under the cap. |
| **Fanout** | Launching a wave: one git worktree + Claude Code session per slice, plus an optional **lead** session that reviews and merges the resulting PRs. |

> **Roadmap = the whole plan. Slice = one launchable piece of it.**
> You edit the **roadmap** (the YAML); you launch **slices** (by `invoke` key). `SLICES.md` is the human-readable render of the roadmap — generated, never hand-edited.

---

## Quickstart

```bash
# 1) one-time: install deps + put the `roadmap` CLI on your PATH
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link

# 2) in any repo, author docs/roadmap/roadmap.yaml (see "The roadmap.yaml model")

# 3) from ANYWHERE inside that repo (root or a subdir — the roadmap is auto-discovered):
roadmap            # interactive console: pick terminal / wave / cap, then launch
roadmap plan       # the text plan: recommended cap + what's runnable (no prompts)
roadmap render     # regenerate docs/SLICES.md
roadmap validate   # structural + cycle checks
roadmap fan -w 1   # spin up wave 1 (lead + slice sessions) — add -d to preview first
```

That's the whole loop: `cd` into a repo, type `roadmap …`, it finds the roadmap and fires.

---

## The three surfaces

The same engine — `roadmap.yaml` + the graph brain — driven three ways.

### 1 · The `roadmap` CLI (from your shell)

Run from anywhere inside a repo; `docs/roadmap/roadmap.yaml` is found by walking up from your cwd, and every subcommand runs with cwd set to that repo root. Two ways to drive it:

- **Interactive console** — bare `roadmap` in a terminal opens a guided picker: **terminal → max concurrency → wave → lead? → launch / preview / save**. Walk the prompts with the arrow keys, hit Enter. Best when you want to *see* what's runnable and choose. (Piped or non-interactive, bare `roadmap` prints the text plan instead, so scripts and CI are unaffected; `roadmap go` forces the console.)
- **Flag-fed** — every choice as a flag: `roadmap fan -w 1 -c 2 -t wt`. No prompts, same outcome — for muscle memory, aliases, and scripts.

| Command | What it does |
|---|---|
| `roadmap` / `roadmap go` | **Interactive console** (above). Hot-loads this repo's roadmap and walks you through the launch. Worker permission mode isn't asked here — it comes from `meta.worker_mode`. |
| `roadmap plan [-c N] [--review-ceiling N] [--use-free-ram] [-j]` | **Recommended cap** (and what constrains it) + the execution **waves** + per-node launch commands. Spawns nothing. `-j/--json` emits the plan for tooling. |
| `roadmap render [-c N] [-s]` | Regenerate `docs/SLICES.md` from the YAML (`-s/--stdout` to print instead of write). |
| `roadmap validate` | Structural + dependency + cycle checks. Non-zero exit on error. |
| `roadmap fan [-t wt\|warp\|tmux\|print\|background] [-c N] [-w N] [--lead-claude] [-d] [-o file] [--worker-mode <m>] [--autonomous --yes-spawn-autonomous]` | Launch a wave — a lead pane/tab + one per slice, each in its own worktree with a synthesized kickoff brief. **Launches by default**; `-d/--dry` or `-o/--out` to preview. Worker **and** lead sessions take `--permission-mode` from `meta.worker_mode` (falls back to `plan`); `--worker-mode` overrides per run. Terminal defaults per platform (win32 → `wt`, else `tmux`). |
| `roadmap cleanup [-r] [-f]` | Prune fanout worktrees merged into the base branch + clean. **Dry by default**; `-r/--remove` acts; `-f/--force` includes unmerged/dirty. Only touches worktrees under the worktree root. |
| `roadmap sync` / `roadmap init` | Reserved on the CLI — reconcile + bootstrap live as the `/slice-sync` and `/slice-init` **plugin skills** (surface 2). |

Short flags (`-w -c -t -d -o -j -r -f -lc -wm`) expand to their long forms; positional slice keys pass through untouched.

```bash
# See the plan + why the cap is what it is (the binding constraint is reported):
roadmap plan
#   Concurrency cap: 5 (recommended)
#     bound by: review — PR review/merge bottleneck (soft ceiling)
#     machine:  24 cores, 59.6GB total / 20.6GB free
#     ceilings: 12 [CPU] · 13 [RAM] · 23 [work] · 5 [review]
#   Wave 1 — 5 concurrent: auth-sessions, billing-invoices, search-index, ...

roadmap fan -w 1                         # launch — lead + one watched session per slice (default)
roadmap fan -w 1 -d                      # preview the launch script, spawn nothing
roadmap fan -w 1 -o wave1.sh             # write the script to a file to inspect/run yourself
roadmap fan -c 3                         # override the recommended cap
roadmap fan --autonomous --yes-spawn-autonomous   # headless workers that commit/push/PR (double-acked)
```

**Safety.** `fan` launches by default — but an interactive launch just opens watchable panes (you're at the keyboard). Preview without spawning via `-d` or `-o`. The only unattended mode, `--autonomous` (headless `claude -p` that commits/pushes/PRs), additionally requires `--yes-spawn-autonomous`. **No launched session ever merges** — each opens a PR and stops; the lead (or you) merges. If `tmux` isn't on PATH (e.g. you're in PowerShell), `fan` prints the script and how to run it in WSL instead of failing.

### 2 · The Claude Code plugin (inside a session)

Install it as a plugin (see [Install](#install)) and the roadmap becomes an *in-session* surface — slash-command **skills**, **agents**, and a startup **hook**:

- **Skills** (`skills/*/SKILL.md`)
  - `/slice <key>` — orient on one slice (read-only): its what, read-order, next action, gate, branch.
  - `/slice-sync` — reconcile statuses against merged PRs + the tracker, then re-render `SLICES.md`.
  - `/slice-init` — a PM-style interview that bootstraps a `roadmap.yaml` (warm-start from existing docs, or cold).
  - `/slice-fanout` — compute the waves and launch (wraps the same scheduler + adapters as the CLI).
- **Hook** (`hooks/hooks.json`) — a `SessionStart` hook injects the at-a-glance + current ready-wave, so a fresh session immediately knows what's runnable (and, first run, installs the `yaml` dep).
- **Agents** (`agents/*.md`) — four specialized subagents Claude invokes across the roadmap → fanout → review lifecycle:

| Agent | Role | Read/write | Suggested model |
|---|---|---|---|
| **roadmap-bootstrapper** | Cold/warm-start: reads the repo's existing roadmap docs, tracker, sprint dirs, and `git log`, and **drafts a `roadmap.yaml`**. Used by `/slice-init` to pre-fill before the interactive confirmation. | reads repo → proposes YAML | sonnet |
| **slice-scoper** | Takes a thin `scheduled` slice and **fills it in**: infers `touches`/`owns` by grepping the code, drafts `read_order`, `est_sessions`, and the `gate`, and writes the sprint spec — turning it into a `next`-ready slice. | reads code → proposes slice fields | sonnet/opus |
| **roadmap-auditor** | Read-only **drift + gap finder**: audits `roadmap.yaml` against reality (merged PRs, strategy docs, sprint dirs) and reports stale statuses + un-surfaced work. | read-only report | sonnet |
| **wave-shepherd** | The **lead-pane brain**: after a fanout wave produces PRs, reviews each against its slice's gate + scope and recommends a safe **merge order** (respecting deps, flagging conflicts). Reviews; never merges. | read-only review | opus |

The CLI and the plugin share the same scripts — the CLI is your *shell* entry, the plugin is the *in-session* entry. The interactive PM interview stays a **skill** (not an agent), because a forked subagent can't hold a back-and-forth with you.

### 3 · MCP (agent-callable)

Two ways `roadmap` meets MCP:

- **Launched sessions inherit your MCP servers.** Each fanout worker (and the lead) is a normal Claude Code session, so it can drive whatever MCP servers your repo/session already has wired — issue trackers, databases, browsers — while it works its slice. Bring your own; `roadmap` doesn't get in the way.
- **Roadmap-as-tools** *(planned, not shipped).* Exposing the read-only queries (`ready_wave`, `recommend_cap`, `plan`) over MCP via `.mcp.json`, so an agent can ask the roadmap what's runnable instead of shelling out to the CLI.

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
        invoke: auth-login        # the slice key — stable, unique across the file
        prs: ["#42"]
      - id: s2
        title: Session tokens
        status: active
        invoke: auth-sessions
        deps: [s1]                # sibling sprint id | pi-id/sprint-id | a whole PI id
        est_sessions: 3           # focused sessions remaining (drives rollups + scheduling)
        touches: [src/session.ts] # files written → two-wave contention detection
        gate: |
          {{default}}
          PLUS the session integration tests
        read_order: ["docs/auth.md — the design"]
        resume_action: Wire JWT issuance + refresh; thread through middleware.
```

- **`invoke`** is the slice key you launch with — stable and unique across the file, so renaming a title never breaks a reference.
- **`deps`** are the DAG edges; the exec-plan line and wave map are *derived* from them.
- **`touches`/`owns`** mechanize the two-wave pattern: two ready slices that write the same file never share a wave; a convergence sprint just `deps`-on the divergent ones.
- **`gated_on: <name>`** marks a human-gated slice — it never auto-schedules; it surfaces under "held on a human."
- **`worker_mode`** sets the `--permission-mode` launched sessions start in; **`weight`** (`heavy|medium|light`) optionally overrides a sprint's inferred resource class.

---

## Install

### The `roadmap` CLI

```bash
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link
```

`npm link` puts `roadmap` on your PATH in every shell — on Windows it writes `roadmap.cmd`/`roadmap.ps1` shims (PowerShell + cmd) plus a unix bin (WSL/bash; run `npm link` once in each Node environment you use). `npm unlink -g slice-roadmap` removes it.

**Alias fallback (no npm):** drop a shim in your shell profile instead —

```powershell
# PowerShell — $PROFILE
function roadmap { node "$HOME\Code\roadmap\scripts\cli.mjs" @args }
```
```bash
# bash/zsh — ~/.bashrc / ~/.zshrc
roadmap() { node "$HOME/Code/roadmap/scripts/cli.mjs" "$@"; }
```

### As a Claude plugin

```bash
claude --plugin-dir /path/to/roadmap        # single session
/plugin install --local /path/to/roadmap    # all sessions
```

### Recommending it in a consuming repo

Don't commit a device-specific alias into a repo. Point contributors at this tool from your onboarding docs (e.g. a CONTRIBUTING note): *"Drive the roadmap from your shell — clone `roadmap`, `npm install && npm link`, then `roadmap` from anywhere in this repo."* A consuming repo only ever carries its own `docs/roadmap/roadmap.yaml` (+ the generated `SLICES.md`).

---

## What's built

- **Graph brain** — `graph.mjs`: dependency resolution (sibling / fully-qualified / whole-PI deps), cycle detection, wave scheduling with two-wave file-contention, sessions-remaining + exec-plan derivation.
- **Renderer** — `render.mjs`: hierarchical `SLICES.md` (per-PI sections, nested sprint tables, derived exec-plan lines, cross-PI wave map, held-on-human).
- **Scheduler** — `scheduler.mjs`: recommended-cap eval (CPU / RAM / independent-work / review ceiling, reporting which binds) + the waves.
- **Fanout** — `fanout.mjs`: `tmux`, `wt`, `warp`, `print`, `background` adapters; per-slice worktree + synthesized kickoff brief; the interactive console (`wizard.mjs`); guarded launch (`--dry`/`--out` preview, autonomous double-ack); `cleanup.mjs` worktree pruning.
- **Plugin surface** — four skills (`slice`, `slice-sync`, `slice-init`, `slice-fanout`), four agents, and a `SessionStart` hook.
- **Tests** — `npm test` runs the zero-dependency suite over the pure brain (graph, recommender, brief, CLI core, wizard core).

Planned: roadmap-as-MCP-tools (`.mcp.json`) and a background PR-watch monitor for the lead.

## Requirements & license

Node 18+ and a one-time `npm install` (for the `yaml` parser). MIT licensed.
