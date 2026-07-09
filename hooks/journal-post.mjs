#!/usr/bin/env node
// Stop hook: on session end, auto-post a git-derived progress snapshot to the mapped issue of the slice
// this worktree's branch belongs to — so a session that dies mid-flight leaves a resumable trail. Content
// is git-derived (branch · recent commits · uncommitted paths); NO handoff.md dependency. Heavily guarded,
// best-effort, ZERO-noise: any miss (not a roadmap repo, Linear off, no key, branch isn't a mapped slice,
// nothing to report, network fail) is a SILENT no-op. A journal post must NEVER fail or block a session.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";

const done = () => process.exit(0);   // always succeed — never block session end
const git = (root, args) => { try { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 4000 }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } };

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
const start = resolve(input.cwd || process.env.CODEX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());

// Walk up to the repo's roadmap; no roadmap here → silent no-op.
let root = null;
for (let dir = start; ;) {
  if (existsSync(join(dir, "docs", "roadmap", "roadmap.yaml"))) { root = dir; break; }
  const up = dirname(dir);
  if (up === dir) break;
  dir = up;
}
if (!root) done();
if (!process.env.LINEAR_API_KEY) done();   // unauthed → nothing to post to

try {
  const graphMod = await import(new URL("../scripts/lib/graph.mjs", import.meta.url));
  const { normalizeLinearConfig } = await import(new URL("../scripts/lib/linear-core.mjs", import.meta.url));
  const { autoPostPlan, sliceForBranch } = await import(new URL("../scripts/lib/journal-core.mjs", import.meta.url));

  const graph = graphMod.loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  if (!normalizeLinearConfig(graph.meta || {})) done();   // Linear not configured for this roadmap

  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = (graph.meta && graph.meta.base_branch) || "main";
  const commits = (git(root, ["log", "--format=%s", `${base}..HEAD`]) || "").split("\n").filter(Boolean);
  const dirty = git(root, ["status", "-s"]) || "";

  // Calibration loop (best-effort, silent): if this branch's slice is now DONE and was estimated, log
  // its outcome to agent-time so the estimate self-corrects. Idempotent per task_id (runLog checks
  // agent-time's history), so firing on every session end is safe. Rides this Linear-gated hook, so it's
  // active when Linear is configured; otherwise use `roadmap estimate log` or agent-time's own hooks.
  // ponytail: without agent-time's round-counter hook, log() has no actuals and is rejected, so this
  // re-fires one silent spawnSync every session end on a done+estimated slice until an outcome lands.
  // Bounded per session, harmless; the upgrade path is enabling that hook (then the first fire succeeds).
  try {
    const slice = sliceForBranch(graph, branch);
    if (slice && graphMod.isDone(slice.status) && slice.estMinutes) {
      const { runLog } = await import(new URL("../scripts/estimate.mjs", import.meta.url));
      runLog(root, { invoke: slice.invoke, status: "pass" });
    }
  } catch { /* best-effort — a calibration miss must never block session end */ }

  const plan = autoPostPlan(graph, { branch, commits, dirty });
  if (!plan) done();   // branch isn't a mapped slice, or no real work to report

  const { postDispatchComment } = await import(new URL("../scripts/linear.mjs", import.meta.url));
  await postDispatchComment(plan.identifier, plan.body, { apiKey: process.env.LINEAR_API_KEY, fetchImpl: fetch });
} catch { /* best-effort — swallow everything */ }
done();
