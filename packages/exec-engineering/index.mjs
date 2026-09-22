// @connorbritain/roadmap-exec-engineering — the engineering executors and their adapters.
// Import modules by path (`@connorbritain/roadmap-exec-engineering/<module>.mjs`); this index
// names the Executors and exports the profile(root) factory the loader registers.
import { worktreeSessionExecutor } from "./src/worktree-session.mjs";
import { cloudDispatchExecutor } from "./src/cloud-dispatch.mjs";
import { githubPrArtifact } from "./src/github-pr-artifact.mjs";
import { engineeringPlanContext } from "./src/plan-engineering.mjs";
import { ENGINEERING_TOOLS, callEngineeringTool } from "./src/mcp-engineering.mjs";
import { engineeringValidators } from "./src/validate-engineering.mjs";
import { mergedPrs } from "./src/external-state.mjs";
import { findUnrecordedMerges, reconcileNudge } from "./src/reconcile-core.mjs";

export const PACKAGE = "@connorbritain/roadmap-exec-engineering";
export { worktreeSessionExecutor, cloudDispatchExecutor, githubPrArtifact, engineeringPlanContext };
export { engineeringScope } from "./src/scoper.mjs";

// Commands the engineering profile adds to the CLI (script names under scripts/), its skills, and
// its MCP tools. Core's own commands, skills and tools are merged in by the loader.
export const COMMANDS = { fan: "fanout.mjs", fanout: "fanout.mjs", cleanup: "cleanup.mjs", wizard: "wizard.mjs", go: "wizard.mjs", watch: "watch-prs.mjs",
  grab: "grab.mjs", dispatch: "dispatch.mjs", gauntlet: "gauntlet.mjs", "gauntlet-eval": "evaluate.mjs", assistant: "assistant.mjs", doctor: "doctor.mjs" };
export const SKILLS = ["fanout", "gauntlet"];

export async function profile(root) {
  return {
    root,
    executor: worktreeSessionExecutor({ root }),
    executors: { "worktree-session": worktreeSessionExecutor({ root }), "cloud-dispatch": cloudDispatchExecutor({ root }) },
    artifacts: { "github-pr": (opts = {}) => githubPrArtifact(root, opts) },
    validators: engineeringValidators,
    commands: COMMANDS,
    mcp: { tools: ENGINEERING_TOOLS, call: (name, args) => callEngineeringTool(name, args, { root }) },
    skills: SKILLS,
    planContext: engineeringPlanContext({ cwd: root }),
    // SessionStart: the reconcile nudge (merged PRs whose slices are still open; gh-guarded,
    // never throws) and the closing hint in this profile's vocabulary.
    nudge: (graph) => reconcileNudge(findUnrecordedMerges(graph, mergedPrs(root))),
    sessionHint: "Use /slice <name> to orient, /fanout to launch a wave, or 'roadmap plan' for the full wave map.",
  };
}
