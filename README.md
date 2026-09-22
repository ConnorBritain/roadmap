# Roadmap: plan work and conduct independently evaluated loops

`roadmap` is a CLI, MCP server, and Claude Code plugin. It turns two YAML files into a
dependency-aware plan of record, then helps a long-lived lead conduct fresh workers through a
**review loop** with a frozen quality bar: implementation → independent critic at an exact
version → frozen-lead acknowledgment → lead-synthesized repair → fresh critic and acknowledgment.
The lead keeps intent and judgment; roadmap supplies deterministic senses and actuators.

The same engine serves two **work profiles**:

| Profile | The work | The worker | The artifact | The gate |
|---|---|---|---|---|
| **engineering** (default) | code in a git repository | a worktree session or a cloud agent | a pull request at an exact head SHA | a verification command |
| **general** (`meta.profile: general`) | documents, plans, handbooks | a person, or a doc-agent session | a file at an exact commit | a checklist a reviewer confirms |

Nothing branches on the profile inside the planning engine: one loader (`packages/cli/src/profile.mjs`)
reads `meta.profile` and registers the executor package; every command, tool, skill and hook asks
the loaded profile for what differs. An existing `roadmap.yaml` needs **no edits** — absent means
engineering.

- **One source of truth (each).** `docs/roadmap/roadmap.yaml` holds the PIs, sprints, deps, priorities, session estimates, gates, prompts, and kickoff briefs (plus `touches` for code, `artifact` for documents). `docs/roadmap/backlog.yaml` holds the erratic work: follow-ups, bugs, chores, urgent items.
- **Generated views.** `docs/SLICES.md` and `docs/BACKLOG.md` are *rendered* from the YAML; never hand-edit them.
- **Derived, never stored.** Exec-plan lines, the "ready now" wave map, sessions-remaining rollups, and priority ordering are computed from `deps` + `touches` + `status` + `priority`.
- **Conducted execution, not one-shot hope.** A meaningful slice freezes its quality bar before a worker starts. A fresh critic reviews the actual artifact at an exact version; the frozen lead acknowledges the exact comment before the verdict can drive state, then decides which findings justify repair. One critic and at most three repair rounds are the defaults. Nothing auto-merges or auto-completes.
- **Restartable reality.** The artifact carries the run identity and frozen bar; lead-authored launch attestations and verdict acknowledgments reconstruct authoritative rounds. `.roadmap-gauntlet-state.json` is only a gitignored local ledger/cache.
- **Zero-prompt pickup.** Stash the pickup instructions on the slice itself (`prompt:`); `/slice <key>`, `roadmap grab <id>` (engineering) or `roadmap assign <key>` (general) is then all a session or a person needs.

---

## Concepts

| Term | What it is |
|---|---|
| **Roadmap** | The whole graph: every PI and sprint in `roadmap.yaml`. |
| **PI** *(Program Increment)* | A top-level initiative. Groups related sprints; carries a status, dependencies, exit criteria. |
| **Sprint** | A unit of work inside a PI (`s1`, `s2`, …): deps, session estimate, gate, kickoff brief, and `touches` (code) or `artifact` (documents). |
| **Slice** | A sprint *as the thing you act on*, by its stable `invoke` key. The atomic, launchable unit. |
| **Wave** | The slices that can run **concurrently right now**: dependency-free, sharing no files, under the cap. |
| **Work profile** | `meta.profile`: `engineering` (default) or `general`. Selects the **Executor** package; nothing else changes. |
| **Executor** | How a slice gets worked: `worktree-session` and `cloud-dispatch` (engineering); `human` and `doc-agent` (general). One interface, one contract test. |
| **Artifact** | What the frozen bar attaches to and the critic reads: a `github-pr` (engineering) or a `git-file` (general). One interface, one contract test. |
| **Gauntlet / conduct** | The within-slice loop: frozen bar, fresh worker, independent critic, frozen-lead acknowledgment, lead-directed repair, fresh re-criticism. `/gauntlet` conducts it on a PR; `/conduct` on a file. Fanout is across slices; the loop is inside each. |
| **Backlog** | The tracker beside the roadmap for **erratic work**. Items are launchable or promotable into sprints, cross-linked both ways. |
| **Priority** | `{ tier: P0–P3, weight: 0–100, reason }` on any sprint or backlog item. Sort order is derived, never stored. |

> **Roadmap = the planned work. Backlog = the erratic work. Slice = one launchable piece of either.**
> You edit the **YAML**; you launch **slices** and **backlog items**. `SLICES.md` / `BACKLOG.md` are generated, never hand-edited.

---

## Quickstart

```bash
# one-time: put the `roadmap` CLI on your PATH
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link

# in any repo: author docs/roadmap/roadmap.yaml (or `roadmap init`), then from anywhere inside it
roadmap plan       # recommended cap + what's runnable
roadmap next       # the single highest-priority ready thing across roadmap + backlog
roadmap render     # regenerate docs/SLICES.md (+ docs/BACKLOG.md)
roadmap validate   # structural + dependency + cycle checks (+ the profile's validators)
```

**Engineering** (default): `roadmap gauntlet start|status|critic|ack|repair auth-sessions …` conducts a
slice on a GitHub PR; `roadmap fan -w 1` launches a wave of worktree sessions (`-d` previews);
`roadmap grab b1` launches one backlog item. Full reference: [`docs/REFERENCE.md`](docs/REFERENCE.md),
[`docs/GAUNTLET.md`](docs/GAUNTLET.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**General** (`meta.profile: general`): `roadmap assign onboarding-week1 --to pat` writes an
assignment brief with the checklist gate and the artifact path; `roadmap conduct start|status|critic|verdict|ack|repair|reconcile`
runs the review loop on the committed file. Full reference:
[`packages/exec-general/README.md`](packages/exec-general/README.md).

The operating loop is `plan → conduct → merge/complete decision → /sync → plan again`. In a
session the same loop is `/slice`, `/gauntlet` or `/conduct`, `/sync`; `/backlog`, `/prioritize`,
`/debrief`, `/retro`, `/imagine` and `/init` are the planning rituals and work under both profiles.

---

## Work profiles

```yaml
meta:
  schema_version: 1
  program: handbook
  profile: general        # omit for engineering
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
        artifact: docs/week1.md          # the deliverable; default docs/roadmap/artifacts/<invoke>.md
        gate:                            # a checklist instead of a command
          - Every section names an owner
          - Reviewed by one person outside the team
```

| | engineering | general |
|---|---|---|
| Package | `packages/exec-engineering` | `packages/exec-general` |
| Launch | `/fanout`, `roadmap fan`, `roadmap grab`, cloud `dispatch` | `/assign`, `roadmap assign`, `roadmap conduct start` |
| Review loop | `/gauntlet`, `roadmap gauntlet …`, MCP `gauntlet_*` | `/conduct`, `roadmap conduct …`, MCP `conduct_*` |
| Reconcile | `/sync` reads merged PRs | `/sync` runs `roadmap conduct reconcile` |
| Capacity | CPU / RAM / work / review / disk ceilings | review capacity only (`meta.default_concurrency`) |
| Scoper | code-grepping `touches` proposals | document-based (gate, read order, sessions) |
| Extra validators | warns on `next` slices with no `touches` | checklist gates; distinct `artifact` paths |

The design and the boundary rules (core imports no executor; exactly one `meta.profile` reader)
are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); upgrading is covered in
[`MIGRATION.md`](MIGRATION.md).

### Using it in Codex

- Codex reads [`AGENTS.md`](AGENTS.md) from this repo automatically, so repo conventions live there.
- Drive everything from the shared terminal with `npm run plan`, `npm run validate`, `npm run render`, or `node scripts/cli.mjs …`.
- `npm run mcp` starts the same MCP server the Claude plugin uses.

---

## Install

> **Full deployment guide** — every surface, GitHub/Gauntlet prerequisites, role-aware Routine
> setup, local ledger placement, config vs. secrets, optional Linear, and the planned Jira shape:
> **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

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

That wires the skills (`/gauntlet` and `/fanout` for engineering, `/conduct` and `/assign` for general,
the planning rituals for both), agents, hooks, PR-watch monitor, and MCP server in one step (new sessions pick them up; `/mcp` reconnects the current one). The plugin
bundles its MCP via `.mcp.json` as `graph`, so don't also add a second copy.

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

---

## Requirements & license

Node 18.15+ (for `fs.statfsSync`, the disk pre-check) and a one-time `npm install` (for the `yaml` parser). MIT licensed.
