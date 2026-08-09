# Deploying roadmap — every surface, every config, where secrets live

Two rules govern everything on this page:

> **Committed files contain configuration and planning state, never credentials.**
> API keys belong in environment variables or the explicitly machine-local, protected Routine
> profile described below — never in roadmap YAML, `.mcp.json`, plugin files, PRs, or comments.
>
> **GitHub is durable Gauntlet reality; local run state is only a ledger/cache.**
> `.roadmap-gauntlet-state.json` stores frozen-bar and launch receipts without tokens or
> transcripts and must be gitignored. PR bodies/comments retain the auditable bar and exact-SHA
> verdicts.

## The surfaces at a glance

| Surface | What you get | Install | Credentials come from |
|---|---|---|---|
| **CLI** (`roadmap ...`) | Plan/fan/backlog/Gauntlet/reconcile/optional Linear families | `npm install -D @connorbritain/roadmap` | Shell env + optional protected Routine profile |
| **Claude Code plugin** | Skills including `/gauntlet`, agents, hooks/monitor, and all `graph` MCP tool families | `claude plugin install roadmap@roadmap` | Inherited env + optional protected Routine profile |
| **Standalone MCP** (no plugin) | The same `graph` tool families in any MCP client | register `scripts/mcp.mjs` (below) | Inherited env, optional client env block, and Routine profile |
| **Codex / other agents** | CLI + MCP + optional local assistant profile | `npm install -D @connorbritain/roadmap` + `roadmap init` | Shell environment |
| **CI / headless** | CLI (`validate`, `render`, optional sync/conduct actuators) | `npm ci` in the tool checkout | CI secret store -> env var |

A **consuming repo** commits its own `docs/roadmap/roadmap.yaml` + `backlog.yaml` and generated
views. The tool itself is installed once per machine. `.roadmap-linear-state.json` is a local
Linear cursor and `.roadmap-gauntlet-state.json` is a local launch ledger/cache; gitignore both.
Neither is a credential store. The frozen Gauntlet bar is also carried in the implementation PR
body so a lead can recover when the local cache is unavailable.

## 1 · CLI

```bash
npm install --save-dev @connorbritain/roadmap
npx roadmap init
```

`roadmap` now works from anywhere inside any repo that has `docs/roadmap/roadmap.yaml`. No configuration files beyond the repo's own YAML.

## 2 · Claude Code plugin (the full experience)

```bash
claude plugin marketplace add ConnorBritain/roadmap    # or a local path
claude plugin install roadmap@roadmap                  # --scope project to pin per-repo
```

That single install wires the skills (including `/gauntlet`), agents, the SessionStart hook, the
PR-watch monitor, **and** the bundled MCP server (`.mcp.json` -> server name `graph`, tools
`mcp__plugin_roadmap_graph__*`). There is nothing to configure inside the plugin itself.

**How the plugin's MCP server finds your repo:** it walks up from the session's project directory (`CLAUDE_PROJECT_DIR`) to the nearest `docs/roadmap/roadmap.yaml`.

**How it gets credentials:** the spawned server inherits your environment. If `LINEAR_API_KEY` is set at the user level (below), the plugin's Linear tools are authed with zero extra steps.

**Permissions:** in a consuming repo's `.claude/settings.json`, reads are safe to allow; mutators belong on the ask list:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_roadmap_graph__plan", "mcp__plugin_roadmap_graph__ready_wave",
      "mcp__plugin_roadmap_graph__show", "mcp__plugin_roadmap_graph__validate",
      "mcp__plugin_roadmap_graph__backlog_list", "mcp__plugin_roadmap_graph__linear_status",
      "mcp__plugin_roadmap_graph__gauntlet_status"
    ],
    "ask": [
      "mcp__plugin_roadmap_graph__set_fields", "mcp__plugin_roadmap_graph__bulk_set",
      "mcp__plugin_roadmap_graph__backlog_add", "mcp__plugin_roadmap_graph__linear_sync",
      "mcp__plugin_roadmap_graph__gauntlet_start", "mcp__plugin_roadmap_graph__gauntlet_critic",
      "mcp__plugin_roadmap_graph__gauntlet_ack",
      "mcp__plugin_roadmap_graph__gauntlet_repair", "mcp__plugin_roadmap_graph__gauntlet_cancel"
    ]
  }
}
```

The split is intentional: `gauntlet_status` senses GitHub without launching anything; start,
critic, and repair fire billable Routines. Ack and cancel mutate durable protocol records. All five
actuators belong behind confirmation.

## 3 · Standalone MCP (Claude Desktop, other MCP clients, plugin-less Claude Code)

The server is one command: `node <tool-checkout>/scripts/mcp.mjs` (stdio JSON-RPC). Register it wherever your client takes MCP servers.

**Claude Code without the plugin** — in the consuming repo:

```bash
claude mcp add graph -- node "C:/Users/you/Code/roadmap/scripts/mcp.mjs"
```

(Repo discovery works because Claude Code runs servers with the project dir available. Don't do this *and* install the plugin — you'd get two servers.)

**Claude Desktop** (`claude_desktop_config.json`) — Desktop has no "current repo", so point the server at one explicitly via the env block. This is also where Desktop users put the Linear key, because GUI apps don't always inherit your shell profile:

```json
{
  "mcpServers": {
    "roadmap-graph": {
      "command": "node",
      "args": ["C:/Users/you/Code/roadmap/scripts/mcp.mjs"],
      "env": {
        "CLAUDE_PROJECT_DIR": "C:/Users/you/Code/my-app",
        "LINEAR_API_KEY": "lin_api_..."
      }
    }
  }
}
```

> `claude_desktop_config.json` lives in your OS user profile and is never committed — a key here is machine-local, same trust level as an env var. **Never** put a key in a repo's `.mcp.json` or any committed file.

**Codex / anything else:** `npm run mcp` from the tool checkout (set `CODEX_PROJECT_DIR` or run with cwd inside the consuming repo).

## 4 · Linear

**Config** (committed, secret-free) — in the consuming repo's `roadmap.yaml`:

```yaml
meta:
  linear:
    team: ENG                    # push target
    granularity: slices          # pis | slices | slices+backlog
    pull: propose                # off | propose | auto
    watch:                       # optional inbound sources
      - { team: PUB, project: "Submit an issue", kind: bug, priority: { tier: P3 } }
```

**Secret** (environment only) — `LINEAR_API_KEY`, a Linear personal API key (Linear → Settings → Security & access → Personal API keys):

| Where | How |
|---|---|
| Windows (persistent) | `[Environment]::SetEnvironmentVariable('LINEAR_API_KEY','<key>','User')` then a new shell |
| macOS / Linux | `echo 'export LINEAR_API_KEY=<key>' >> ~/.zshrc` (or `.bashrc`) |
| Claude Code plugin / CLI | nothing extra — both inherit the above |
| Claude Desktop | the `env` block shown in §3 |
| CI | repo/organization secret → exposed as `LINEAR_API_KEY` on the job |

**Bootstrap sequence** in a consuming repo:

```bash
roadmap linear auth              # prints the key instructions (never stores anything)
roadmap linear status --probe    # confirms auth with one viewer query
roadmap linear setup --team ENG  # queries your teams, writes meta.linear via the validated store
roadmap linear provision         # labels + standard views + the two guidance texts to paste
roadmap linear sync --dry        # shows the push plan + pull inbox, writes nothing
roadmap linear sync              # projects the roadmap; /sync now includes the Linear phase
```

`provision` also prints the **repo dispatch contract** — paste it into `CLAUDE.md`/`AGENTS.md` so cloud agents delegated a Linear issue (Claude Code coding sessions, Codex, Warp Oz) self-orient from the issue footer.

**Detection is graceful at every state** — the same sentence everywhere (hook, CLI, MCP):

| State | Behavior |
|---|---|
| No `meta.linear` | All Linear behavior off; tool is byte-identical to an unwired install |
| Configured, no key | One advisory line; everything else works; sync errors with the fix |
| Wired | `/sync` runs the Linear phase; hook reports team/pull/last-sync |

## 5 · Cloud execution and the Gauntlet (remote agents)

The recommended meaningful-work path is `roadmap gauntlet start <key>` or the `gauntlet_start`
MCP actuator. The local lead then uses `gauntlet_status`, `gauntlet_critic`, `gauntlet_ack`,
`gauntlet_repair`, and the explicit stuck-run escape hatch `gauntlet_cancel` to conduct
implementation -> independent exact-SHA criticism -> lead acknowledgment -> lead-synthesized
repair -> fresh criticism -> fresh lead acknowledgment. Every critic result is inert until the
frozen lead acknowledges both its immutable body digest and exact GitHub comment-URL digest. The
implementation and repair workers never merge.
The default is one critic and at most three repair rounds.

`roadmap dispatch <key>` / `roadmap fan --cloud` remain lower-level one-shot actuators. By default
they fire **Claude Code cloud sessions** directly through the Routines API: no Linear plan and no
local worktrees. The endpoint is beta (`experimental-cc-routine-2026-04-01`) and may change.

Codex Cloud is opt-in through committed, secret-free repository mapping:

```yaml
meta:
  dispatch:
    providers:
      codex:
        environment_id: env_roadmap
  gauntlet:
    implementation_provider: codex
    critic_provider: claude
    repair_provider: codex
```

Use `roadmap dispatch <key> --provider codex` or the role-specific Gauntlet provider flags. The
adapter submits remote work with `codex cloud exec`, stores only the exact returned task receipt,
and polls the stored ID through paginated JSON task lists. It never allocates a local worktree and
never chooses the most recent task. Current supported Codex Cloud does not offer per-task model
selection or an unattended task-to-PR CLI command; model requests fail, and implementation status
is `awaiting_artifact_publication` until a GitHub PR independently appears. `codex cloud apply` is
an interactive recovery path, not normal Roadmap execution.

Gauntlet V1 is deliberately GitHub-first. Before conducting a run, the consuming repo must have a
GitHub `origin`, the repository must be connected to each Routine, and `gh auth status` must
succeed. GitHub holds the marked PR, frozen bar, commits, checks, and exact-SHA verdict comments.
Provider-neutral `dispatch` can still be used outside GitHub, but the Gauntlet fails loudly rather
than pretending a GitLab/git-native observation is sufficient.

The authenticated `gh` identity is frozen as the run lead. Critic/repair launches use durable
lead-authored precommit comments plus deterministic `refs/heads/roadmap-gauntlet-locks/*`
create-if-absent claims, so independent conductors cannot spend the same Routine launch twice.
Configure an active GitHub ruleset for `roadmap-gauntlet-locks/*` that restricts creation,
updates, and deletion to the trusted lead/service bypass identity and blocks non-fast-forward
updates. Routine worker identities must not have the bypass; verify that actor list in GitHub.
Before every claim, the runtime verifies that all four rule types apply to that exact prospective
ref, but the effective-rules response cannot prove bypass membership.
`ROADMAP_GAUNTLET_UNSAFE_CLAIMS=1` is an explicit unsafe escape hatch
for isolated tests only. These refs are protocol receipts, not disposable branches. A critic
verdict becomes authoritative only after the frozen lead acknowledges both its immutable body
digest and exact GitHub comment-URL digest. PR-backed cancellation is likewise recorded as a
full-protocol lead comment plus claim ref and survives local-ledger loss. Pre-PR cancellation
creates a protected shared tombstone claim so a delayed PR cannot resurrect the run; its detailed
reason remains local until a PR comment exists.

**One-time Routine setup (per claude.ai account, per repo):**

1. On claude.ai → **Code → Routines** (claude.ai/code/routines) → New routine.
2. Point it at the target **GitHub repo** (must be pushed/connected). Create generic saved prompts
   for the roles you will use; the run-specific capsule arrives as fired text:
   - **implementation:** implement the frozen bar, verify, open a marked PR, never merge;
   - **critic:** independently inspect the PR at the expected full SHA and publish the structured
     verdict comment; never rely on the builder's private reasoning;
   - **repair:** recheck the expected head, apply only the lead's packet to the existing PR branch,
     verify and push; abort on a moved head and never merge.
3. Add an **API trigger** (save the routine first — the endpoint is generated after saving). The modal shows a **URL** (the `trig_…` id is embedded in it, never labeled separately) and a **Generate token** button — the token (`sk-ant-oat01-…`) is shown ONCE; copy it immediately. Use the whole URL as the `trigger` value — the tool accepts either the full URL or the bare `trig_…` id.

**Single generic override:** `CLAUDE_ROUTINE_TRIGGER` + `CLAUDE_ROUTINE_TOKEN` remains available
for low-level dispatch. A Gauntlet call additionally requires the matching
`CLAUDE_ROUTINE_ROLE=implementation|critic|repair`; a requested tier also requires
`CLAUDE_ROUTINE_TIER=<tier>`. This prevents an unclassified generic override from silently
downgrading the builder/reviewer separation. Role-specific production setups should use the
profile map below.

**Multi-account on one workstation** (people swapping `claude /login` on the same OS user): each person creates the same routine under *their own* claude.ai account, and the pairs live in a machine-local **`~/.claude-routines.json`** (never committed; same trust level as env — override the path with `CLAUDE_ROUTINES_FILE`):

```json
{
  "connor": {
    "account": "connor@example.com",
    "routines": {
      "default":                     { "trigger": "trig_impl", "token": "sk-ant-oat01-..." },
      "default#critic":              { "trigger": "trig_critic", "token": "sk-ant-oat01-..." },
      "acme/webapp#repair":           { "trigger": "trig_repair", "token": "sk-ant-oat01-..." },
      "acme/webapp#critic#fable":     { "trigger": "trig_fable", "token": "sk-ant-oat01-..." }
    }
  },
  "sam": {
    "account": "sam@example.com",
    "routines": { "default": { "trigger": "trig_ccc", "token": "sk-ant-oat01-..." } }
  }
}
```

**Profile selection (the hot-swap):** the env pair wins outright (CI/override) ->
`CLAUDE_ROUTINE_PROFILE=<name>` pins a profile -> otherwise roadmap reads the currently
authenticated claude.ai account from `~/.claude.json` and matches the profile's `account`. Swap
accounts with `claude /login`; the next launch uses the new account's limits.

**Role selection inside that profile:**

```text
untiered: <owner/repo>#<role> -> default#<role> -> <owner/repo> -> default
tiered:   <owner/repo>#<role>#<tier> -> default#<role>#<tier>
          -> <owner/repo>#<tier> -> default#<tier>
```

These role keys extend the existing repo/tier/default scheme. An explicitly requested tier never
falls back to an untiered Routine; a missing strong critic is an actionable configuration error.
The common role names are `implementation`, `critic`, and `repair`.

Optional committed policy belongs under `meta.gauntlet`:

```yaml
meta:
  gauntlet:
    max_rounds: 3
    critic_tier: fable            # requires a matching role+tier Routine key
    # implementation_tier: economy
    # repair_tier: economy
```

This contains selection labels, not credentials. A slice/backlog `dispatch_tier` overrides the
repository implementation/repair tier; critic strength remains separately selectable.

The machine-local `.roadmap-gauntlet-state.json` records run and launch receipts immediately,
closing the pre-PR duplicate window. It contains no Routine token. The implementation PR body
must repeat the run identity and frozen bar; critic comments bind verdicts to the exact full PR
head SHA. A status refresh always prefers live GitHub reality over cached state.

When a subject is also Linear-mapped and `LINEAR_API_KEY` is set, low-level dispatch may comment
the session URL onto the issue. This is a convenience link, not Gauntlet state.

## 6 · Jira (planned — not yet implemented)

Jira support is the designed follow-up and will mirror this layout exactly, so nothing about your deployment changes shape:

```yaml
meta:
  jira:                          # PLANNED — does not work yet
    project: ENG                 # push target project key
    granularity: slices
    pull: propose
```

with secrets in `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (Atlassian API token), and a `roadmap jira status|setup|sync` family. The sync brain is already tracker-neutral; only the field maps and REST transport are Jira-specific. Until it ships, a `meta.jira` block is ignored and `roadmap validate` warns about it — don't add it yet.

**Why direct APIs instead of the Linear/Atlassian MCP servers?** The sync is a deterministic batch program (diffing, batching, cursors, idempotent re-runs) that must run headless from CLI/CI — MCP tools are built for a model in the loop, and the hosted servers authenticate with the *same* credential anyway, so routing through them adds a protocol layer without removing the key. Interactive agent work (chatting about issues, agent delegation from Linear/Jira) is exactly what those hosted MCP servers are for — pushed issues carry a machine footer so agents dispatched from them self-orient with one command.

## 7 · Troubleshooting

- `roadmap gauntlet status <run-or-key>` is the first recovery command. It is read-only and
  refreshes current GitHub reality before suggesting a safe next action.
- Gauntlet says GitHub unavailable -> confirm the remote with `git remote get-url origin`, install
  `gh`, then run `gh auth login` / `gh auth status` with access to the repository.
- A critic says `PASS` but status still refuses -> compare its reviewed full SHA with the current
  PR head. A verdict for an older head is intentionally stale.
- Lost `.roadmap-gauntlet-state.json`, or a local conductor that lost the distributed implementation
  election to a differently frozen winning PR -> run status while authenticated as the winning
  packet's frozen GitHub lead. Status is read-only. Recovery verifies the marked PR body/current
  head, protected launch claims against immutable lead launch attestations, and critic comments
  against body+exact-comment-URL-bound verdict ACKs. Either half of a claim/attestation or
  verdict/ACK pair is fail-closed. A ledgerless/incomplete run or differing remote winner remains
  advisory until that lead inspects its recovered bar/base/ceiling/tiers and launches a fresh
  critic with `--confirm-recovered-bar` (MCP: `confirm_recovered_bar: true`). Only that confirmed
  actuator adopts the winning packet and upserts authenticated GitHub launch attestations before
  mutation. The local file is a cache/launch ledger; do not copy tokens into it to “repair” recovery.
- A role/tier Routine cannot resolve -> add the exact role-aware key shown in the error. Do not
  map a requested critic tier to a weaker untiered Routine.
- `roadmap linear status` tells you which of the three states you're in and the exact next command.
- Plugin tools missing in a session → `/mcp` to reconnect, or restart the session after install.
- Two `graph` servers listed → you both installed the plugin and `claude mcp add`ed it; remove one.
- `Linear API HTTP 401` → key invalid/expired; re-issue and reset the env var.
- Upgrading from `slice-roadmap` ≤0.1.x → see README → *Upgrading* (permission allow-lists need rewriting to `mcp__plugin_roadmap_graph__*`).
