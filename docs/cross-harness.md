# Cross-harness roadmap — design + plan

**Status:** design + scaffold (this branch lands the seam; per-harness build-out is staged below).
**Goal:** make `roadmap` drive *any* agent harness, not just Claude Code. The graph brain is already
harness-agnostic; only the **execution/launch layer** and the **directive vocabulary** are Claude-bound.
A `harness` profile translates the neutral `execution:` intent into the right wording, launch command,
and valid reference values for the active harness. Config selects the profile (`meta.harness` + `--harness`),
and **`claude` stays the default so every existing repo is unchanged.**

---

## What the research found (the landscape is two-tier)

The four named targets are **not the same kind of thing**, and that reshapes the design:

| Target | What it actually is | How roadmap integrates |
|---|---|---|
| **Claude Code** | A coding CLI (`claude`), native **Agent Teams**, `--permission-mode`, MCP, hooks, CLAUDE.md. | **Launch profile** (current default). |
| **Codex** (OpenAI) | A coding CLI: `codex exec`, `--sandbox`, `--ask-for-approval`, `--cd`, `--json`, AGENTS.md. | **Launch profile.** |
| **OpenClaw** | An **orchestrator** that spawns *external* coding agents over **ACP** via `acpx` (`sessions_spawn`, `/acp spawn`). | **Consumer** — best served by an ACP-aligned export, not a launch template. |
| **Hermes Agent** (Nous) | A terminal-first **orchestrator** that *delegates* coding to CLIs (Codex, Claude, OpenCode). | **Consumer** — delegates to a launch profile / consumes the neutral brief. |

The unifying standard underneath OpenClaw (and Zed, Kiro, Cursor…) is **ACP — the Agent Client Protocol**
("LSP for coding agents," JSON-RPC 2.0, protocol version 1). Claude Code, Codex, Gemini CLI, Cursor,
OpenCode, Copilot, Droid, Kimi, and Qwen all have ACP adapters. Targeting ACP gets us those for free.

So the architecture is **two tiers**:

- **Tier A — launch profiles** (the "spawn a session in a worktree" layer `fanout.mjs` needs):
  `claude`, `codex`, `generic`, later `opencode`/`gemini`. Each maps the neutral fields to a real command.
- **Tier B — orchestrator interop** (OpenClaw, Hermes, ACP editors): roadmap does **not** launch these;
  they consume roadmap. Integration = emit a neutral, machine-readable **wave/slice spec** aligned with
  ACP's `sessions_spawn` shape (`{ task, cwd, agentId, mode }`) so an orchestrator can dispatch each slice.

> **Insight:** OpenClaw and Hermes don't need a bespoke launch template — they need roadmap to *emit*
> what to run. One ACP-shaped export covers both, plus every other ACP editor.

---

## The neutral contract (what stays in the YAML)

The `execution:` block already declares **harness-neutral intent** and does not change:

```yaml
execution:
  mode: agent-team        # solo | subagents | dynamic-workflow | agent-team
  concurrency: 5
  min_concurrency: 4
  team: [{ role: verifier }, { role: implementer, count: 3 }, { role: reviewer }]
  rationale: "..."
```

`mode` is the only value with a Claude-native *name* (`agent-team`). We treat it as **semantic** —
"many independent clusters wanting peer-coordinated, max parallelism" — and let each profile *render* it:

| neutral `mode` | claude | codex | generic / ACP |
|---|---|---|---|
| `solo` | single `claude` session, no fan-out | single `codex exec` | one session |
| `subagents` | N background subagents (CLAUDE.md § Subagent Hand-off) | N `codex exec` over disjoint files | N sessions, lead merges |
| `dynamic-workflow` | in-slice pipeline | sequential `codex exec` steps | step-gated pipeline |
| `agent-team` | **Agent Teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) | N parallel `codex exec`, `integrator` reconciles | N parallel ACP sessions, `integrator` reconciles |

A profile declares which modes it supports **natively**; an unsupported mode **degrades** to its closest
equivalent (with truthful wording) instead of emitting dead Claude-only instructions. Nothing is lost.

---

## Harness profile shape (`scripts/lib/harness.mjs`)

```js
{
  id: "codex",
  handoffDoc: "AGENTS.md",            // CLAUDE.md | AGENTS.md (the project-instructions file the harness reads)
  nativeModes: new Set([...]),        // which execution.mode values run natively (others degrade)
  // normalized permission {readonly|edit|full-auto} -> the harness's real flags
  permission: { readonly: "...", edit: "...", "full-auto": "..." },
  // build the launch command for one slice/session
  launch({ promptOrBriefPath, cwd, permission, headless }) -> "codex exec ...",
  // the imperative directive lines for a (mode, workers, composition, floor, rationale)
  directive(spec) -> string[],
}
```

`execution.executionDirectiveLines(node, { harness })` delegates the *wording* to the active profile while
keeping the neutral computation (worker count, floor, composition) shared. With no harness given it uses
`claude` — byte-for-byte identical to today.

---

## Config + flags

- `meta.harness: claude` (default) — repo-wide default profile.
- `roadmap fan --harness codex` / `roadmap show --harness codex` — per-invocation override.
- `meta.worker_mode` stays, but is **normalized** at the seam: `plan→readonly`, `acceptEdits→edit`,
  `bypassPermissions/auto→full-auto`, then mapped to the profile's real flag (Codex `--sandbox`/`--ask-for-approval`).
- Validation becomes harness-aware: an `execution.mode` unsupported by the selected harness is a **warning**
  (it will degrade), never a hard error.

---

## Staged delivery

1. **Seam — DONE.** `harness.mjs` registry with `claude` (default, current behavior), `codex`, and
   `generic` profiles. `executionDirectiveLines` is harness-aware; `meta.harness`/`--harness` plumbed
   through render/show/brief. claude output is byte-identical; codex/generic reword `agent-team`
   without Agent-Teams-only language.
2. **Launch layer — DONE.** `fanout.mjs`'s hardcoded `claude …` is now `profile.launch(...)`. worker_mode
   normalizes ({readonly|edit|full-auto}) and each profile maps it to its real flags (claude
   `--permission-mode`; codex `--sandbox` + `--ask-for-approval`). claude commands are byte-identical in
   both bash and powershell forms; the handoff-doc reference (CLAUDE.md vs AGENTS.md) comes from the profile.
   The non-spawnable `generic` profile refuses a direct launch and points at the ACP export.
3. **ACP export (Tier B) — DONE.** `roadmap fan --emit acp` writes a JSON wave manifest of
   `sessions_spawn`-shaped specs (`{ agentId, task: <brief>, cwd, branch, baseRef, mode }`) so
   OpenClaw/Hermes/ACP editors dispatch each slice. The self-contained kickoff brief (in the selected
   dialect) is the `task`; `--agent <id>` names the target ACP agent (required for `generic`); autonomous
   maps to ACP `mode: "run"`, else `"session"`.
4. **More profiles — future.** `opencode`, `gemini`, etc., are mostly declarative now the seam + launch
   layer exist: add a profile object (handoffDoc, nativeModes, permission map, launch, directive).

---

## Decisions (resolved)

1. **`agent-team` naming — keep it.** The Claude-native value stays as the neutral semantic
   ("many independent clusters, peer-coordinated, max parallelism"); each profile renders it. No alias.
   Backward-compatible with the shipped `execution:` block.
2. **Degrade, don't refuse.** A mode a harness can't run natively (e.g. `agent-team` on codex) **degrades
   to its equivalent + warns** (never errors). A future `--strict-harness` could make it fatal for CI.
3. **Handoff doc — per profile.** Non-claude profiles reference `AGENTS.md` (the emerging cross-agent
   standard) in their directives; the claude profile keeps CLAUDE.md. Driven by `profile.handoffDoc`.

## Consuming the ACP export

```bash
roadmap fan --wave 1 --harness codex --emit acp --out wave1.acp.json
# → { protocol:"acp", version:1, harness:"codex", sessions:[ { agentId, task, cwd, branch, baseRef, mode } ] }
```

An orchestrator creates each worktree (`git worktree add <cwd> -b <branch> <baseRef>`) and dispatches the
session — e.g. OpenClaw `sessions_spawn({ runtime:"acp", agentId, task, cwd, mode })`. For a non-specific
target use `--harness generic --agent <id>` to name the ACP agent. The `task` is the full kickoff brief, so
the session is self-contained — no plugin or `/slice` command required on the far side.

---

## Sources

- Codex CLI reference — https://developers.openai.com/codex/cli/reference
- Codex sandboxing / approvals — https://developers.openai.com/codex/concepts/sandboxing , https://developers.openai.com/codex/agent-approvals-security
- OpenClaw ACP agents — https://docs.openclaw.ai/tools/acp-agents , https://docs.openclaw.ai/concepts/agent-runtimes
- Agent Client Protocol — https://agentclientprotocol.com/get-started/introduction , https://github.com/agentclientprotocol/agent-client-protocol
- Hermes Agent — https://hermes-agent.nousresearch.com/docs/ , https://github.com/nousresearch/hermes-agent
