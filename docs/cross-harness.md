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

1. **Seam (this branch).** `harness.mjs` registry with `claude` (default, current behavior), `codex`, and
   `generic` profiles for the **directive layer** only. `executionDirectiveLines` becomes harness-aware.
   `meta.harness`/`--harness` plumbed through `show`. Tests prove: claude output unchanged; codex/generic
   reword `agent-team` without Agent-Teams-only language. **Lowest risk, highest signal.**
2. **Launch layer.** Refactor `fanout.mjs`'s hardcoded `claude …` into `profile.launch(...)`; map worker_mode
   → profile permissions; emit AGENTS.md alongside/instead of the CLAUDE.md reference per profile.
3. **ACP export (Tier B).** `roadmap fan --emit acp` → a JSON wave manifest of `sessions_spawn`-shaped specs
   (`{ task: <brief>, cwd: <worktree>, agentId, mode }`) so OpenClaw/Hermes/ACP editors dispatch each slice.
   The kickoff brief becomes the neutral `task`.
4. **More profiles.** `opencode`, `gemini`, etc., mostly declarative once the seam + launch layer exist.

---

## Open decisions

1. **`agent-team` naming.** Keep the Claude-native value as the neutral semantic (backward-compatible —
   recommended), or add a neutral alias like `cluster-parallel` with `agent-team` as a claude-profile synonym.
2. **Degrade vs. refuse.** When a slice asks for `agent-team` on a harness without native teams, default to
   **degrade + warn**. A `--strict-harness` flag could turn it into an error for CI.
3. **Handoff doc.** Emit `AGENTS.md` (the emerging cross-agent standard) for non-claude profiles; keep the
   CLAUDE.md reference only for the claude profile. Possibly emit both when ambiguous.

---

## Sources

- Codex CLI reference — https://developers.openai.com/codex/cli/reference
- Codex sandboxing / approvals — https://developers.openai.com/codex/concepts/sandboxing , https://developers.openai.com/codex/agent-approvals-security
- OpenClaw ACP agents — https://docs.openclaw.ai/tools/acp-agents , https://docs.openclaw.ai/concepts/agent-runtimes
- Agent Client Protocol — https://agentclientprotocol.com/get-started/introduction , https://github.com/agentclientprotocol/agent-client-protocol
- Hermes Agent — https://hermes-agent.nousresearch.com/docs/ , https://github.com/nousresearch/hermes-agent
