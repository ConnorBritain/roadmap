// slice-roadmap — harness profiles (PURE). A profile translates the NEUTRAL execution intent
// (mode + worker count + composition + floor) into the right imperative directive for a specific
// agent harness. The graph brain and the `execution:` block stay harness-agnostic; only the WORDING
// (and, in later stages, the launch command + permission flags) are dialect.
//
// `claude` is the default and reproduces the original directive verbatim, so an existing repo is
// byte-for-byte unchanged. `codex` and `generic` reword the Claude-native `agent-team` mode into its
// truthful equivalent (parallel sessions + an integrator) instead of emitting Agent-Teams-only text.
//
// See docs/cross-harness.md for the full two-tier design (launch profiles vs. ACP orchestrator interop).

export const DEFAULT_HARNESS = "claude";

// ── shared framing (same neutral computation, different dialect on line 2) ──────
function headline(spec) {
  if (spec.mode === "solo") return `▶ EXECUTION: solo — single agent, no fan-out.`;
  const wk = spec.workers != null ? `${spec.workers} worker${spec.workers === 1 ? "" : "s"}` : `worker count TBD`;
  return `▶ EXECUTION: ${spec.mode} — ${wk}${spec.composition ? ` (${spec.composition})` : ""}.`;
}
function floorClause(spec) {
  return spec.mode !== "solo" && spec.floor != null ? ` DO NOT run solo or fewer than ${spec.floor}.` : "";
}
function withRationale(lines, spec) {
  if (spec.rationale) lines.push(`  Rationale: ${spec.rationale}`);
  return lines;
}
const nWorkers = (spec) => (spec.workers != null ? `${spec.workers} ` : "");

// ── claude (default): the original, Agent-Teams-native wording — unchanged ───────
const claude = {
  id: "claude",
  handoffDoc: "CLAUDE.md",
  nativeModes: new Set(["solo", "subagents", "dynamic-workflow", "agent-team"]),
  // normalized {readonly|edit|full-auto} -> claude --permission-mode value
  permission: { readonly: "plan", edit: "acceptEdits", "full-auto": "bypassPermissions" },
  directive(spec) {
    const lines = [headline(spec)];
    const fc = floorClause(spec);
    if (spec.mode === "agent-team") {
      lines.push(`  The touched files are disjoint.${fc} Invoke Agent Teams now (set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1).`);
    } else if (spec.mode === "subagents") {
      lines.push(`  Spawn ${nWorkers(spec)}background subagents per CLAUDE.md § Subagent Hand-off (disjoint files; the lead merges).${fc}`);
    } else if (spec.mode === "dynamic-workflow") {
      lines.push(`  Run an in-slice pipeline — each step gates the next; do not collapse it to a single pass.${fc}`);
    } else if (spec.mode === "solo") {
      lines.push(`  Single agent, no fan-out — atomic/exploratory/branching-sequential. Do not spawn workers.`);
    }
    return withRationale(lines, spec);
  },
};

// ── codex (OpenAI): no native Agent Teams → parallel `codex exec` over disjoint clusters ──
const codex = {
  id: "codex",
  handoffDoc: "AGENTS.md",
  nativeModes: new Set(["solo", "subagents", "dynamic-workflow"]), // agent-team degrades to parallel sessions
  // normalized -> codex sandbox + approval flags
  permission: {
    readonly: "--sandbox read-only --ask-for-approval untrusted",
    edit: "--sandbox workspace-write --ask-for-approval on-request",
    "full-auto": "--sandbox danger-full-access --ask-for-approval never",
  },
  directive(spec) {
    const lines = [headline(spec)];
    const fc = floorClause(spec);
    if (spec.mode === "agent-team") {
      lines.push(`  The touched files are disjoint.${fc} Launch ${nWorkers(spec)}parallel \`codex exec\` sessions over disjoint clusters; the integrator role reconciles. (Codex has no native Agent Teams — parallel sessions are the equivalent.)`);
    } else if (spec.mode === "subagents") {
      lines.push(`  Run ${nWorkers(spec)}\`codex exec\` sessions over disjoint files per AGENTS.md; the lead merges.${fc}`);
    } else if (spec.mode === "dynamic-workflow") {
      lines.push(`  Chain \`codex exec\` steps — each gates the next; do not collapse to one pass.${fc}`);
    } else if (spec.mode === "solo") {
      lines.push(`  Single \`codex exec\`, no fan-out — atomic/exploratory/branching-sequential.`);
    }
    return withRationale(lines, spec);
  },
};

// ── generic / ACP: harness-neutral wording for any ACP orchestrator (OpenClaw, Hermes, editors) ──
const generic = {
  id: "generic",
  handoffDoc: "AGENTS.md",
  nativeModes: new Set(["solo", "subagents", "dynamic-workflow"]),
  permission: { readonly: "readonly", edit: "edit", "full-auto": "full-auto" },
  directive(spec) {
    const lines = [headline(spec)];
    const fc = floorClause(spec);
    if (spec.mode === "agent-team") {
      lines.push(`  The touched files are disjoint.${fc} Launch ${nWorkers(spec)}parallel worker sessions over disjoint clusters; the integrator role reconciles.`);
    } else if (spec.mode === "subagents") {
      lines.push(`  Spawn ${nWorkers(spec)}parallel worker sessions over disjoint files per AGENTS.md; the lead merges.${fc}`);
    } else if (spec.mode === "dynamic-workflow") {
      lines.push(`  Run a step-gated pipeline — each step gates the next.${fc}`);
    } else if (spec.mode === "solo") {
      lines.push(`  Single worker session, no fan-out — atomic/exploratory/branching-sequential.`);
    }
    return withRationale(lines, spec);
  },
};

export const HARNESSES = { claude, codex, generic };

// Resolve a harness id to its profile; unknown/missing falls back to the default (claude).
export function getHarness(id) {
  return HARNESSES[id] || HARNESSES[DEFAULT_HARNESS];
}

export function isKnownHarness(id) {
  return Object.prototype.hasOwnProperty.call(HARNESSES, id);
}

// True when the harness runs `mode` natively (else the directive degrades to its equivalent).
export function supportsModeNatively(id, mode) {
  return getHarness(id).nativeModes.has(mode);
}
