// slice-roadmap — ACP wave export (PURE). Turns a computed wave into a machine-readable manifest
// of session specs shaped like ACP / OpenClaw `sessions_spawn` calls, so an *orchestrator* (OpenClaw,
// Hermes, or any Agent Client Protocol editor) can dispatch each slice to a coding agent. This is
// Tier B of the cross-harness design (docs/cross-harness.md): roadmap doesn't launch these harnesses;
// it emits what to run. One export covers every ACP consumer.
//
// No IO: fanout.mjs writes the JSON. Each session carries the self-contained kickoff brief as its
// `task` (in the active harness dialect), plus the cwd/branch/baseRef an orchestrator needs to
// create the worktree it spawns into.

import { synthesizeBrief, branchFor, worktreeFor, baseRefOf } from "./brief.mjs";
import { getHarness, DEFAULT_HARNESS } from "./harness.mjs";

// buildAcpManifest(wave, graph, { harness, agent, autonomous, wave: waveIdx, track })
//   -> { protocol:"acp", version:1, wave, harness, sessions:[{ agentId, label, task, cwd, branch, baseRef, mode }] }
// `agentId` defaults to the harness's ACP id (claude→"claude", codex→"codex"); --agent overrides it
// (required for the generic profile, which targets no specific agent). `mode` is ACP's session mode:
// "run" (one-shot) for autonomous, else "session" (persistent, so a lead can interact).
export function buildAcpManifest(wave, graph, opts = {}) {
  const harnessId = opts.harness || (graph.meta && graph.meta.harness) || DEFAULT_HARNESS;
  const agentId = opts.agent || getHarness(harnessId).acpAgentId || harnessId;
  const sessionMode = opts.autonomous ? "run" : "session";
  // Synthesize each task-brief in the SELECTED harness's dialect (so an agent-team slice exported for
  // codex carries the codex wording). Pin it on a shallow-cloned graph rather than mutating the input.
  const dialectGraph = { ...graph, meta: { ...(graph.meta || {}), harness: harnessId } };
  return {
    protocol: "acp",
    version: 1,
    wave: opts.wave || 1,
    harness: harnessId,
    ...(opts.track ? { track: opts.track } : {}),
    sessions: (wave || []).map((n) => ({
      agentId,
      label: n.invoke,
      task: synthesizeBrief(n, dialectGraph),
      cwd: worktreeFor(n, graph),
      branch: branchFor(n, graph),
      baseRef: baseRefOf(graph),
      mode: sessionMode,
    })),
  };
}
