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

// Normalize Claude's worker_mode vocabulary (the existing meta field) to a harness-neutral
// permission LEVEL. Non-claude profiles map the level to their own real flags; the claude
// profile passes the raw worker_mode straight through (it already speaks claude's dialect),
// so existing claude launches are byte-identical.
export function normalizePermission(workerMode) {
  switch (workerMode) {
    case "bypassPermissions": return "full-auto";
    case "auto": return "edit";
    case "acceptEdits": return "edit";
    case "plan": default: return "readonly";
  }
}

// Outer quote char for the prompt, per target shell (bash → ", powershell → '). The launch prompt
// is built to contain no quotes or ';' (see brief.launchPrompt), so a bare wrap is safe.
const quoteFor = (shell) => (shell === "pwsh" ? "'" : '"');

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
  acpAgentId: "claude",
  spawnable: true,
  nativeModes: new Set(["solo", "subagents", "dynamic-workflow", "agent-team"]),
  // normalized {readonly|edit|full-auto} -> claude --permission-mode value
  permission: { readonly: "plan", edit: "acceptEdits", "full-auto": "bypassPermissions" },
  // Build the per-session launch command. claude passes the RAW worker_mode through (its own
  // dialect), so this is byte-identical to the pre-harness fanout. Lane (api overflow key) wraps
  // only the bash form, matching the original (the pwsh adapters never wired --lane api).
  launch({ prompt, workerMode = "plan", autonomous = false, shell = "bash", lane = "max" }) {
    const q = quoteFor(shell);
    const base = autonomous
      ? `claude -p ${q}${prompt}${q} --permission-mode acceptEdits`
      : `claude --permission-mode ${workerMode} ${q}${prompt}${q}`;
    return shell !== "pwsh" && lane === "api"
      ? `ANTHROPIC_API_KEY="$SLICE_ROADMAP_API_KEY" ${base}`
      : base;
  },
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
  acpAgentId: "codex",
  spawnable: true,
  nativeModes: new Set(["solo", "subagents", "dynamic-workflow"]), // agent-team degrades to parallel sessions
  // normalized -> codex sandbox + approval flags
  permission: {
    readonly: "--sandbox read-only --ask-for-approval untrusted",
    edit: "--sandbox workspace-write --ask-for-approval on-request",
    "full-auto": "--sandbox danger-full-access --ask-for-approval never",
  },
  // `codex exec` is non-interactive (headless/autonomous); the bare `codex` TUI is interactive. The
  // normalized worker_mode maps to codex's sandbox + approval flags. Lane uses OPENAI_API_KEY (bash).
  launch({ prompt, workerMode = "plan", autonomous = false, shell = "bash", lane = "max" }) {
    const q = quoteFor(shell);
    const flags = this.permission[normalizePermission(workerMode)];
    const bin = autonomous ? "codex exec" : "codex";
    const base = `${bin} ${flags} ${q}${prompt}${q}`;
    return shell !== "pwsh" && lane === "api"
      ? `OPENAI_API_KEY="$SLICE_ROADMAP_API_KEY" ${base}`
      : base;
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
  acpAgentId: null,           // no specific ACP agent — the orchestrator/caller picks (--agent)
  spawnable: false,           // no binary to spawn directly; use `roadmap fan --emit acp`
  nativeModes: new Set(["solo", "subagents", "dynamic-workflow"]),
  permission: { readonly: "readonly", edit: "edit", "full-auto": "full-auto" },
  // The generic profile has no binary of its own — it targets ACP orchestrators (OpenClaw/Hermes/
  // editors), which consume `roadmap fan --emit acp`. This template is a clearly-placeholder preview
  // for --dry; a real launch is refused (spawnable:false) and pointed at the ACP export.
  launch({ prompt, workerMode = "plan", shell = "bash" }) {
    const q = quoteFor(shell);
    return `<agent-cli> --permission ${normalizePermission(workerMode)} ${q}${prompt}${q}`;
  },
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
