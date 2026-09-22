// @connorbritain/roadmap-exec-general — the general (non-engineering) profile. The profile loader
// (packages/cli/src/profile.mjs) imports this lazily when meta.profile is `general`.
//
// The `exec-general` slice fills this in with the human + doc-agent Executors, the git-file
// GauntletArtifact and checklist gates. Until then the profile registers core only: no
// executor (planning falls back to core's defaultCapacity), no extra commands, tools or skills.
export const PACKAGE = "@connorbritain/roadmap-exec-general";

export async function profile(root) {
  return {
    root,
    executor: null,
    artifacts: {},
    validators: [],
    commands: {},
    mcp: { tools: [], call: async () => undefined },
    skills: [],
    planContext: {},
    note: "general profile: executors land in the exec-general slice; planning uses core's default capacity",
  };
}
