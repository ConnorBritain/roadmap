# slice-roadmap

A portable Claude Code plugin that turns a repo's roadmap into a **hierarchical, dependency-aware graph** and a **deterministic multi-session fanout** tool.

- **One source of truth:** `docs/roadmap/roadmap.yaml` (PIs → sprints, deps, file-ownership, session estimates, gates, kickoff briefs).
- **Generated view:** `docs/SLICES.md` is *rendered* from the YAML (don't hand-edit — edit the YAML and re-render).
- **Derived, never stored:** the per-PI exec-plan line (`(S0 ∥ S1)→S2→S3`), the cross-PI "ready now" wave map, and "sessions remaining" rollups — all computed from `deps` + `touches` + `status`.
- **Fanout:** a wave scheduler computes which slices can run concurrently under a cap, **recommends** that cap from a CPU/RAM + repo-purpose eval, and launches each slice in its own git worktree — by default a tmux session with a lead pane + one pane per slice.
- **Repo-agnostic:** the resource classifier knows .NET / Node / Rust / Python / Go / Gradle / Maven / Ruby / Elixir / make / Bazel out of the box, and every repo-specific assumption (gate, base branch, doc cross-links, weights) comes from `meta` — nothing is hardcoded to one stack.

---

## Quickstart

```bash
# 1) one-time: install deps + put the `roadmap` CLI on your PATH
cd /path/to/roadmap && npm install && npm link

# 2) in any repo, author docs/roadmap/roadmap.yaml (see "The roadmap.yaml model")

# 3) from ANYWHERE inside that repo (root or a subdir — the roadmap is auto-discovered):
roadmap            # interactive console: pick terminal/wave/cap, then launch (in a TTY)
roadmap plan       # the text plan: recommended cap + what's runnable (no prompts)
roadmap render     # regenerate docs/SLICES.md
roadmap validate   # structural + cycle checks
roadmap fan --wave 1             # spin up the wave (tmux lead + slice panes) — add --dry to preview first
```

That's the whole loop: `cd` into a repo, type `roadmap …`, it finds the roadmap and fires.

---

## Commands

### The `roadmap` CLI (primary)

Run from anywhere inside a repo — the `docs/roadmap/roadmap.yaml` is found by walking up from your cwd, and each subcommand runs with cwd set to that repo root.

| Command | What it does |
|---|---|
| `roadmap` / `roadmap go` | **Interactive console.** Hot-loads this repo's roadmap and walks you through **terminal → max concurrency → wave → lead? → launch/preview/save**, then runs `fan` for you. Bare `roadmap` opens it in a TTY (and prints the `plan` instead when piped/non-interactive, so scripts are unaffected); `roadmap go` forces it. Worker permission mode isn't asked here — it comes from `meta.worker_mode`. |
| `roadmap plan [--cap N] [--review-ceiling N] [--use-free-ram] [--json]` | **Recommended cap** (and what constrains it) + the execution **waves** + per-node launch commands. Spawns nothing. |
| `roadmap render [--cap N] [--stdout]` | Regenerate `docs/SLICES.md` from the YAML. |
| `roadmap validate` | Structural + dependency + cycle checks. Non-zero on error. |
| `roadmap fan [--term wt\|warp\|tmux\|print\|background] [--cap N] [--wave N] [--worktree-root <dir>] [--lane max\|api] [--lead-claude] [--dry] [--out file] [--autonomous] [--yes-spawn-autonomous]` | Launch a wave — a lead pane/tab + one per slice, each in its own worktree. **Launches by default**; `--dry`/`--out` to preview. Worker **and lead** sessions take their `--permission-mode` from `meta.worker_mode` (falls back to `plan`); `--worker-mode <mode>` overrides per run. Terminal defaults per platform (win32 → `wt`, else `tmux`). `warp` writes a Tab Config (TOML) and auto-opens it via the `warp://tab_config/<name>` deeplink (the registered `warp://` URI handler). |
| `roadmap cleanup [--remove] [--force]` | Prune fanout worktrees merged into the base branch + clean. **Dry by default**; `--remove` acts; `--force` includes unmerged/dirty. Only touches worktrees under the worktree root. |
| `roadmap sync` / `roadmap init` | (P4 skill) reconcile+re-render / PM-interview bootstrap. |

Each wraps the matching script (`scheduler.mjs`/`render.mjs`/`validate.mjs`/`fanout.mjs`) — you can still call those directly with `--in <path>` if you prefer.

### Worked examples

```bash
# See the plan + why the cap is what it is (binding constraint reported):
roadmap plan
#   Concurrency cap: 5 (recommended)
#     bound by: review — PR review/merge bottleneck (soft ceiling)
#     machine:  24 cores, 59.6GB total / 20.6GB free
#     ceilings: 12 [CPU] · 13 [RAM] · 23 [work] · 5 [review]
#   Wave 1 — 5 concurrent: auth-sessions, billing-invoices, search-index, ...

roadmap fan --wave 1                          # launch — lead pane + one watched pane per slice (default)
roadmap fan --wave 1 --dry                    # preview the tmux script, spawn nothing
roadmap fan --wave 1 --out wave1.sh           # write the script to a file to inspect/run yourself
roadmap fan --cap 3                           # override the recommended cap
roadmap fan --autonomous --yes-spawn-autonomous   # headless workers that commit/push/PR (double-acked)
```

**Safety:** `fan` **launches by default** — but interactive launch just opens watchable panes (you're at the keyboard). Preview without spawning via `--dry` or `--out`. The only unattended mode, `--autonomous` (headless `claude -p` that commits/pushes/PRs), additionally requires `--yes-spawn-autonomous`. No launched session ever merges — each opens a PR and stops; the lead merges. If tmux isn't on PATH (e.g. you're in PowerShell), `fan` prints the script + how to run it in WSL instead of failing.

---

## The roadmap.yaml model

```yaml
meta:
  schema_version: 1
  program: MYPROJ
  default_gate: |                 # inherited by sprints whose gate is 'default'/{{default}}
    npm test
  base_branch: main               # worktree base + PR base (default main)
  remote: origin                  # git remote (default origin)
  terminal: tmux                  # default fanout adapter: tmux|warp|wt|background|print
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
        invoke: auth-login        # the /slice key — stable, unique across the file
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

- **`deps`** are the DAG edges; the exec-plan line and wave map are derived from them.
- **`touches`/`owns`** mechanize the two-wave pattern: two ready slices that write the same file never share a wave; a convergence sprint just `deps`-on the divergent ones.
- **`gated_on: <name>`** marks a human-gated slice — it never auto-schedules; it surfaces under "held on a human."
- **`weight`** (`heavy|medium|light`) optionally overrides the inferred resource class for a sprint.

---

## Bundled agents

Plugin agents (`agents/*.md`) are specialized subagents Claude invokes for roadmap work. Each maps to a real step in the roadmap → fanout → review lifecycle. (Plugin-agent frontmatter supports `model`, `tools`, `disallowedTools`, `effort`, `maxTurns`, `isolation: worktree`; not hooks/mcp/permissionMode.)

| Agent | Role | Read/write | Suggested model |
|---|---|---|---|
| **roadmap-bootstrapper** | Cold/warm-start: reads the repo's existing roadmap docs, tracker, sprint dirs, and `git log` and **drafts a `roadmap.yaml`**. Used by `slice-init` to pre-fill before the interactive confirmation. | reads repo → proposes YAML | sonnet |
| **slice-scoper** | Takes a thin `scheduled` slice ("scope a sprint spec first") and **fills it in**: infers `touches`/`owns` by grepping the code, drafts `read_order`, `est_sessions`, and the `gate`, and writes the sprint spec — turning it into a `next`-ready slice with a real brief. | reads code → proposes slice fields + a spec | sonnet/opus |
| **roadmap-auditor** | Read-only **drift + gap finder**: audits `roadmap.yaml` against reality (merged PRs, strategy docs, sprint dirs) and reports stale statuses, un-surfaced work, and unscoped wedges. (The agent version of "where did conform go?") | read-only report | sonnet |
| **wave-shepherd** | The **lead-pane brain**: after a fanout wave produces PRs, reviews each against its slice's gate + scope and recommends a safe **merge order** (respecting deps, flagging conflicts). Reviews; never merges. | read-only review | opus |

Why these and not more: each removes a specific friction — *getting started* (bootstrapper), *making a slice runnable* (scoper), *keeping the map honest* (auditor), and *closing out a wave* (shepherd). The interactive PM interview stays a **skill** (`slice-init`), not an agent, because a forked subagent can't hold a back-and-forth with you.

---

## Plugin primitives this uses

Grounded in the [plugins reference](https://code.claude.com/docs/en/plugins-reference):

- **Skills** (`skills/*/SKILL.md`) — `slice` (orient, read-only), `slice-sync` (reconcile statuses + re-render), `slice-init` (PM-interview bootstrap), `slice-fanout` (waves + launch).
- **Agents** (`agents/*.md`) — the four above.
- **Hooks** (`hooks/hooks.json`) — a `SessionStart` hook injects the at-a-glance + current ready-wave (and, on first run, `npm install` of the `yaml` dep into `${CLAUDE_PLUGIN_DATA}`).
- **Monitor** (`monitors/monitors.json`, optional) — a background `gh pr list` watcher on the active fanout branches that notifies the lead when a wave's PRs land, so review can begin without polling. Good OOTB fit (`when: on-skill-invoke:slice-fanout`).
- **MCP** (`.mcp.json`, later) — optionally expose `ready_wave` / `recommend_cap` / `plan` as agent-callable tools so an agent can query the roadmap, not just the CLI.

---

## Install the `roadmap` CLI

```bash
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link
```

`npm link` puts `roadmap` on your PATH in every shell — on Windows it writes `roadmap.cmd`/`roadmap.ps1` shims (works in PowerShell + cmd) and a unix bin (works in WSL/bash; run `npm link` once in each Node environment you use). `npm unlink -g slice-roadmap` to remove.

### Alias fallback (no npm)

If you'd rather not `npm link`, drop a shim in your shell profile:

```powershell
# PowerShell — $PROFILE
function roadmap { node "$HOME\Code\roadmap\scripts\cli.mjs" @args }
```
```bash
# bash/zsh — ~/.bashrc / ~/.zshrc
roadmap() { node "$HOME/Code/roadmap/scripts/cli.mjs" "$@"; }
```

### Recommending it in a consuming repo

Don't commit a device-specific alias into the repo. Instead point contributors at this tool from your onboarding docs (e.g. a CONTRIBUTING note): *"Drive the roadmap from your shell — clone `roadmap`, `npm install && npm link`, then `roadmap` from anywhere in this repo."* The repo only ever carries its own `docs/roadmap/roadmap.yaml`.

## Install as a Claude plugin (in-session surface)

```bash
claude --plugin-dir /path/to/roadmap        # single session
/plugin install --local /path/to/roadmap    # all sessions
```

The CLI is your **shell** entry (spin up a wave from a terminal); the plugin is the **in-Claude-session** surface — `/slice` (orient), `/slice-sync` (reconcile+render), `/slice-init` (bootstrap), `/slice-fanout` (launch). Both share the same scripts.

---

## What's built

- **Graph brain** — `graph.mjs`: dependency resolution (sibling / fully-qualified / whole-PI deps), cycle detection, wave scheduling with two-wave file-contention, sessions-remaining + exec-plan derivation.
- **Renderer** — `render.mjs`: hierarchical `SLICES.md` (per-PI sections, nested sprint tables, derived exec-plan lines, cross-PI wave map, held-on-human).
- **Scheduler** — `scheduler.mjs`: recommended-cap eval (CPU / RAM / independent-work / review ceiling, reporting which binds) + the waves.
- **Fanout** — `fanout.mjs`: `tmux`, `wt`, `warp`, `print`, `background` adapters; per-slice worktree + synthesized kickoff brief; the interactive console (`wizard.mjs`); guarded launch (`--dry`/`--out` preview, autonomous double-ack); `cleanup.mjs` worktree pruning.
- **Plugin surface** — four skills (`slice`, `slice-sync`, `slice-init`, `slice-fanout`), four agents (`roadmap-bootstrapper`, `slice-scoper`, `roadmap-auditor`, `wave-shepherd`), and a `SessionStart` hook that injects the ready-wave.
- **Tests** — `npm test` runs the zero-dependency suite over the pure brain (graph, recommender, brief, CLI core, wizard core).

The resource classifier ships with .NET / Node / Rust / Python / Go / Gradle / Maven / Ruby / Elixir / make / Bazel patterns and is extensible per-repo via `meta.weight_patterns` — nothing is hardcoded to one stack.

## Requirements & license

Node 18+ and a one-time `npm install` (for the `yaml` parser). MIT licensed.
