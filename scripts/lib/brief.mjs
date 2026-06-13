// slice-roadmap — kickoff-brief synthesizer.
// Turns a sprint node into the self-contained brief a launched session reads to
// "just start". Mirrors the 6-part subagent-handoff contract (target/scope, reference,
// gate+commands, branch/commit/PR, DO NOT MERGE, report-back) so an autonomous or
// watched session owns its atomic sequence and never merges its own work.

import { resolveGate } from "./graph.mjs";
import { executionDirectiveLines } from "./execution.mjs";
import { resolve } from "node:path";

// Repo conventions (default to git's common defaults; overridable in meta).
export const remoteOf = (graph) => (graph.meta && graph.meta.remote) || "origin";
export const baseBranchOf = (graph) => (graph.meta && graph.meta.base_branch) || "main";
export const baseRefOf = (graph) => `${remoteOf(graph)}/${baseBranchOf(graph)}`;

export function branchFor(node, graph) {
  const conv = (graph.meta && graph.meta.branch_convention) || "{pi}/{sprint}";
  return conv.replace("{pi}", node.piId).replace("{sprint}", node.id);
}

export function worktreeFor(node, graph) {
  // Default to an absolute sibling of the repo (<cwd>/../_worktrees) when unset — the CLI
  // runs with cwd = repo root, so this is portable + machine-specific-free in the committed YAML.
  const root = (graph.meta && graph.meta.worktree_root) || resolve(process.cwd(), "..", "_worktrees");
  return `${root}/${node.piId}-${node.id}`;
}

// The prompt each launched session starts with. SELF-CONTAINED: it reads the kickoff brief
// written into the worktree, so it works whether or not the slice-roadmap plugin/skill is
// installed in the spawned session. ASCII + no quote chars (it's embedded in shell quotes).
export function launchPrompt(node) {
  // Steers to research -> plan -> WAIT -> implement. Combined with a permissive --worker-mode
  // (acceptEdits / bypassPermissions) the research runs without approval prompts, but the agent
  // still pauses for you to approve the plan before it changes anything. No ';' (wt's delimiter).
  return `Read the .kickoff.md file in this directory. First research autonomously - read the brief read-order and explore the code, without asking - to build a thorough plan. Then present the plan and STOP: wait for my approval before you implement anything. After I approve, carry it out - build, test, commit, push, open a PR. Do NOT merge.`;
}

// The full brief written to <worktree>/.kickoff.md (uncommitted).
export function synthesizeBrief(node, graph) {
  if (node.kickoffBrief && node.kickoffBrief !== "brief") {
    // inline brief or a path — pass through (caller resolves a path if needed)
    return node.kickoffBrief;
  }
  const gate = resolveGate(node, graph) || "(see SLICES.md default gate)";
  const branch = branchFor(node, graph);
  const owns = [...(node.owns || []), ...(node.touches || [])];
  const ro = (node.readOrder || []).map((r, i) => `${i + 1}. ${r}`).join("\n") || "_(see the slice's detail entry in docs/SLICES.md)_";

  // Carry the imperative execution directive VERBATIM (only when the slice declares one), so the
  // launched session staffs at the declared topology — an agent-team slice invokes Agent Teams
  // rather than running solo. Section 0 = the very first thing the session reads.
  const execLines = executionDirectiveLines(node);
  const execSection = execLines
    ? `## 0. Execution strategy — staff this BEFORE you start
${execLines.join("\n")}

`
    : "";

  return `# Kickoff — ${node.invoke}  (${node.programLabel} · ${node.id.toUpperCase()})

> Uncommitted brief for this fanout session. You own the atomic sequence
> **read → plan → build → test → commit → push → open PR**. Do **NOT** merge — the lead merges.

**Slice:** \`${node.invoke}\`  ·  **Branch:** \`${branch}\`
**What:** ${node.what || node.title}

${execSection}## 1. Scope / target
${owns.length ? owns.map((f) => `- \`${f}\``).join("\n") : "- (scope to this slice only; see read-order)"}

## 2. Read-order (orient first — paths are relative to \`docs/\`; you're at the repo root, so e.g. \`sprints/...\` = \`docs/sprints/...\`, and \`../STATUS.md\` = \`STATUS.md\`)
${ro}

## 3. Next action
${node.resumeAction || "(see the slice detail entry)"}

## 4. Verification gate (must pass before commit)
\`\`\`
${gate}
\`\`\`

## 5. Commit + PR
- Commit style: \`<area>: <what> (${node.piId}-${node.id.toUpperCase()})\`, professional, no AI attribution.
- Open a PR \`--base ${baseBranchOf(graph)} --head ${branch}\`. **Do NOT merge.**

## 6. Report back
LOC delta · file inventory · gate result (pass/fail with output) · commit SHA · PR # · 2–3 line retro.
`;
}
