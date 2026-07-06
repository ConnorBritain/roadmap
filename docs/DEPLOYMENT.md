# Deploying roadmap — every surface, every config, where secrets live

One rule governs everything on this page:

> **Committed YAML carries configuration. The environment carries secrets. Nothing else exists.**
> `docs/roadmap/roadmap.yaml` (including `meta.linear`) is committed and shareable — it never contains a credential. API keys live in environment variables only — never in the YAML, never in `.mcp.json`, never in plugin files. There is no hidden per-plugin config store to manage.

## The surfaces at a glance

| Surface | What you get | Install | Credentials come from |
|---|---|---|---|
| **CLI** (`roadmap ...`) | Everything: plan/fan/backlog/next/set/linear | `npm install && npm link` | Your shell environment |
| **Claude Code plugin** | Skills (`/slice /backlog /imagine /prioritize /sync /init /fanout`), 4 agents, SessionStart hook, PR-watch monitor, **and** the MCP server `graph` (16 tools) — one install | `claude plugin install roadmap@roadmap` | Inherited from your shell environment |
| **Standalone MCP** (no plugin) | Just the 16 `graph` tools in any MCP client | register `scripts/mcp.mjs` (below) | Inherited env, or an `env` block in the client's MCP config |
| **Codex / other agents** | CLI + MCP (no skills/hooks) | CLI install + `npm run mcp` | Shell environment |
| **CI / headless** | CLI (`validate`, `render`, `linear sync`) | `npm ci` in the tool checkout | CI secret store → env var |

A **consuming repo** commits only its own `docs/roadmap/roadmap.yaml` + `backlog.yaml` (and the generated `SLICES.md`/`BACKLOG.md`). The tool itself is installed once per machine. The Linear sync cursor (`.roadmap-linear-state.json`) is per-machine local state — git-ignore it.

## 1 · CLI

```bash
git clone https://github.com/ConnorBritain/roadmap.git
cd roadmap && npm install && npm link      # once per Node environment (Windows + WSL are separate)
```

`roadmap` now works from anywhere inside any repo that has `docs/roadmap/roadmap.yaml`. No configuration files beyond the repo's own YAML.

## 2 · Claude Code plugin (the full experience)

```bash
claude plugin marketplace add ConnorBritain/roadmap    # or a local path
claude plugin install roadmap@roadmap                  # --scope project to pin per-repo
```

That single install wires the skills, agents, the SessionStart hook, the PR-watch monitor, **and** the bundled MCP server (`.mcp.json` → server name `graph`, tools `mcp__plugin_roadmap_graph__*`). There is nothing to configure inside the plugin itself.

**How the plugin's MCP server finds your repo:** it walks up from the session's project directory (`CLAUDE_PROJECT_DIR`) to the nearest `docs/roadmap/roadmap.yaml`.

**How it gets credentials:** the spawned server inherits your environment. If `LINEAR_API_KEY` is set at the user level (below), the plugin's Linear tools are authed with zero extra steps.

**Permissions:** in a consuming repo's `.claude/settings.json`, reads are safe to allow; mutators belong on the ask list:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_roadmap_graph__plan", "mcp__plugin_roadmap_graph__ready_wave",
      "mcp__plugin_roadmap_graph__show", "mcp__plugin_roadmap_graph__validate",
      "mcp__plugin_roadmap_graph__backlog_list", "mcp__plugin_roadmap_graph__linear_status"
    ],
    "ask": [
      "mcp__plugin_roadmap_graph__set_fields", "mcp__plugin_roadmap_graph__bulk_set",
      "mcp__plugin_roadmap_graph__backlog_add", "mcp__plugin_roadmap_graph__linear_sync"
    ]
  }
}
```

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
roadmap linear sync --dry        # shows the push plan + pull inbox, writes nothing
roadmap linear sync              # projects the roadmap; /sync now includes the Linear phase
```

**Detection is graceful at every state** — the same sentence everywhere (hook, CLI, MCP):

| State | Behavior |
|---|---|
| No `meta.linear` | All Linear behavior off; tool is byte-identical to an unwired install |
| Configured, no key | One advisory line; everything else works; sync errors with the fix |
| Wired | `/sync` runs the Linear phase; hook reports team/pull/last-sync |

## 5 · Jira (planned — not yet implemented)

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

## 6 · Troubleshooting

- `roadmap linear status` tells you which of the three states you're in and the exact next command.
- Plugin tools missing in a session → `/mcp` to reconnect, or restart the session after install.
- Two `graph` servers listed → you both installed the plugin and `claude mcp add`ed it; remove one.
- `Linear API HTTP 401` → key invalid/expired; re-issue and reset the env var.
- Upgrading from `slice-roadmap` ≤0.1.x → see README → *Upgrading* (permission allow-lists need rewriting to `mcp__plugin_roadmap_graph__*`).
