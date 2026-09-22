// @connorbritain/roadmap-exec-general — the general (non-engineering) profile. The profile loader
// (packages/cli/src/profile.mjs) imports this lazily when meta.profile is `general`.
//
// Executors: human (a person works from an assignment brief) and doc-agent (the brief plus the
// configured assistant, started at the repo root — no worktree). Artifact: git-file (a file at a
// commit; packet + comments in a committed sidecar; claims are atomic git refs). Gates are
// checklists. No resource ceilings: review capacity binds.
import { humanExecutor, docAgentExecutor, artifactPathFor } from "./src/executors.mjs";
import { gitFileArtifact } from "./src/git-file-artifact.mjs";
import { generalValidators } from "./src/validate-general.mjs";
import { GENERAL_TOOLS, callGeneralTool } from "./src/mcp-general.mjs";

export const PACKAGE = "@connorbritain/roadmap-exec-general";
export { humanExecutor, docAgentExecutor, gitFileArtifact };
export * as conduct from "./src/conduct.mjs";

export const COMMANDS = { conduct: "conduct.mjs", assign: "assign.mjs" };
export const SKILLS = ["conduct", "assign"];

export async function profile(root) {
  const human = humanExecutor({ root });
  return {
    root,
    executor: human,
    executors: { human, "doc-agent": docAgentExecutor({ root }) },
    artifacts: { "git-file": (opts = {}) => gitFileArtifact(root, opts) },
    validators: generalValidators,
    commands: COMMANDS,
    mcp: { tools: GENERAL_TOOLS, call: (name, args) => callGeneralTool(name, args, { root }) },
    skills: SKILLS,
    // buildPlan's capacity/annotate: review capacity, and the artifact + brief per node.
    planContext: { capacity: (ready, graph) => human.capacity(graph), annotate: (n) => ({ ...human.annotate(n), artifact: artifactPathFor(n) }) },
  };
}
