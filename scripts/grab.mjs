#!/usr/bin/env node
// roadmap grab <backlog-id> — launch ONE backlog item in its own worktree + session (thin CLI
// over the worktree-session executor). The single-target sibling of `fan`: worktree
// <root>/backlog-<id>, branch backlog/<id>, a synthesized .kickoff.md (the item's prompt embedded
// verbatim), one terminal target. Marks the item in_progress on launch (not on --dry).
//
// Usage: node grab.mjs <id> [--term wt|tmux|print] [--dry] [--worker-mode m]

import { join } from "node:path";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { REL } from "@connorbritain/roadmap-core/cli-core.mjs";
import { planGrab, markBacklogInProgress, spawnLaunchScript } from "@connorbritain/roadmap-exec-engineering/worktree-session.mjs";

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const id = args.find((a) => !a.startsWith("-"));
const dry = args.includes("--dry");

if (!id) { console.error("usage: roadmap grab <backlog-id> [--term wt|tmux|print] [--dry] [--worker-mode m]"); process.exit(2); }

const root = process.cwd();
const graph = loadGraph(join(...REL));
const plan = planGrab(root, graph, id, { dry, term: val("--term", null), workerMode: val("--worker-mode", null) });
if (plan.error) { console.error(plan.error); process.exit(plan.code); }

const { item, script, settings: { term }, wt, br } = plan;
console.error(`grab: ${id} (${item.kind}) · branch ${br} · worktree ${wt} · term=${term} · ${dry ? "dry" : "launch"}`);

if (dry || term === "print") {
  process.stdout.write(script);
  if (dry) console.error(`\n(--dry — nothing spawned. Drop --dry to launch.)`);
  process.exit(0);
}

const code = await spawnLaunchScript(script, { term, tmpName: `roadmap-grab-${id}` });
if (code === 0 && item.status !== "in_progress") {
  try { markBacklogInProgress(root, id); console.error(`✓ ${id} marked in_progress`); }
  catch (e) { console.error(`⚠ launched, but couldn't mark ${id} in_progress: ${e.message}`); }
}
process.exit(code);
