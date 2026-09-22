// roadmap — the work-profile loader (docs/ARCHITECTURE.md § Profile loader). The ONLY reader of
// meta.profile in the whole tree (scripts/check-boundaries.mjs enforces it). Every other surface
// asks this module which executor package is in play and merges what it registers:
//
//   loadProfile(meta, { root }) → { name, package, executor, artifacts, validators, commands,
//                                  mcp: { tools, call }, skills, planContext, note? }
//
// `engineering` is the default when meta.profile is absent, so every existing roadmap.yaml keeps
// working with zero edits. Core commands / tools / skills are always registered; the profile adds
// its own. Packages are imported lazily so a general-profile repo never loads the engineering
// machinery (and vice versa).

export const PROFILES = ["engineering", "general"];
export const DEFAULT_PROFILE = "engineering";

const PACKAGES = {
  engineering: "@connorbritain/roadmap-exec-engineering",
  general: "@connorbritain/roadmap-exec-general",
};

// Commands and skills every profile has. Profiles append; they never remove a core entry.
export const CORE_COMMANDS = { plan: "scheduler.mjs", render: "render.mjs", validate: "validate.mjs", show: "show.mjs", mcp: "mcp.mjs",
  set: "set.mjs", backlog: "backlog.mjs", promote: "promote.mjs", next: "next.mjs", linear: "linear.mjs", review: "review.mjs",
  plate: "plate.mjs", estimate: "estimate.mjs", cycle: "cycle.mjs", init: "init.mjs" };
export const CORE_SKILLS = ["init", "imagine", "prioritize", "debrief", "retro", "sync", "backlog", "cycle", "slice"];

// The single meta.profile read. A wrong value is an error, never a silent default: a typo that
// quietly fell back to engineering would launch worktrees against a handbook.
export function profileNameOf(meta) {
  const raw = meta == null ? undefined : meta.profile;
  if (raw == null || raw === "") return DEFAULT_PROFILE;
  if (typeof raw !== "string" || !PROFILES.includes(raw)) {
    throw new Error(`meta.profile must be one of ${PROFILES.join("|")} (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

// Validate a profile's registration before anything trusts it.
export function assertProfile(p) {
  for (const k of ["name", "package", "commands", "validators", "mcp", "skills", "planContext", "artifacts"]) {
    if (p == null || p[k] == null) throw new Error(`profile ${p && p.name || "?"} is missing ${k}`);
  }
  if (!Array.isArray(p.mcp.tools) || typeof p.mcp.call !== "function") throw new Error(`profile ${p.name}: mcp must be { tools[], call() }`);
  if (!Array.isArray(p.validators) || !Array.isArray(p.skills)) throw new Error(`profile ${p.name}: validators and skills are arrays`);
  return p;
}

const cache = new Map();

export async function loadProfile(meta, { root = process.cwd(), importImpl = (s) => import(s) } = {}) {
  const name = profileNameOf(meta);
  const key = `${name}\0${root}`;
  if (cache.has(key)) return cache.get(key);
  const pkg = await importImpl(PACKAGES[name]);
  if (typeof pkg.profile !== "function") throw new Error(`${PACKAGES[name]} exports no profile(root) factory`);
  const registered = await pkg.profile(root);
  const merged = assertProfile({
    nudge: () => "",          // SessionStart reconcile nudge (optional; profiles override)
    sessionHint: "Use /slice <name> to orient, or 'roadmap plan' for the full wave map.",
    ...registered,
    name, package: PACKAGES[name],
    commands: { ...CORE_COMMANDS, ...(registered.commands || {}) },
    skills: [...CORE_SKILLS, ...(registered.skills || [])],
  });
  cache.set(key, merged);
  return merged;
}

// The profile for a repo root: reads the roadmap once (meta only matters) and loads. A missing
// roadmap (e.g. `roadmap init`) yields the core-only registration under the default profile.
export async function loadProfileForRoot(root, { loadGraph, roadmapPath, importImpl } = {}) {
  let meta = {};
  if (root && loadGraph && roadmapPath) {
    try { meta = (loadGraph(roadmapPath).meta) || {}; } catch { meta = {}; }
  }
  return loadProfile(meta, { root: root || process.cwd(), ...(importImpl ? { importImpl } : {}) });
}
