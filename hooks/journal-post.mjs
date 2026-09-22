#!/usr/bin/env node
// Stop hook: on session end, auto-post a git-derived progress snapshot to the mapped issue of the slice
// this worktree's branch belongs to — so a session that dies mid-flight leaves a resumable trail. Content
// is git-derived (branch · recent commits · uncommitted paths); NO handoff.md dependency. Heavily guarded,
// best-effort, ZERO-noise: any miss (not a roadmap repo, Linear off, no key, branch isn't a mapped slice,
// nothing to report, network fail) is a SILENT no-op. A journal post must NEVER fail or block a session.
//
// The branch → slice mapping is the ENGINEERING executor's convention (one worktree branch per slice).
// Under the general profile there is no such branch, so the hook is a no-op there (the assignment
// brief and the conducted run's sidecar are the general profile's trail).

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
  const graphMod = await import("@connorbritain/roadmap-core/graph.mjs");
  const { normalizeLinearConfig } = await import("@connorbritain/roadmap-core/linear-core.mjs");
  const { autoPostPlan, sliceForBranch } = await import("@connorbritain/roadmap-core/journal-core.mjs");

  const graph = graphMod.loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  if (!normalizeLinearConfig(graph.meta || {})) done();   // Linear not configured for this roadmap

  // Only the engineering profile maps a branch to a slice (the loader is the one meta.profile reader).
  const { loadProfile } = await import("@connorbritain/roadmap-cli/profile.mjs");
  const profile = await loadProfile(graph.meta, { root });
  if (profile.name !== "engineering") done();
  const { branchFor } = await import("@connorbritain/roadmap-exec-engineering/brief.mjs");   // the engineering branch convention

  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = (graph.meta && graph.meta.base_branch) || "main";
  const commits = (git(root, ["log", "--format=%s", `${base}..HEAD`]) || "").split("\n").filter(Boolean);
  const dirty = git(root, ["status", "-s"]) || "";

  // Calibration loop (best-effort, silent): if this branch's slice is now DONE and was estimated, log
  // its outcome so the estimate self-corrects. Idempotent per task_id (runLog checks the history), so
  // firing on every session end is safe. Rides this Linear-gated hook, so it's active when Linear is
  // configured; otherwise use `roadmap estimate log`.
  try {
    const slice = sliceForBranch(graph, branch, branchFor);
    if (slice && graphMod.isDone(slice.status) && slice.estMinutes) {
      const { runLog } = await import("@connorbritain/roadmap-core/estimate-io.mjs");
      runLog(root, { invoke: slice.invoke, status: "pass" });
    }
  } catch { /* best-effort — a calibration miss must never block session end */ }

  const plan = autoPostPlan(graph, { branch, commits, dirty, branchFor });
  if (!plan) done();   // branch isn't a mapped slice, or no real work to report

  const { postDispatchComment } = await import("@connorbritain/roadmap-core/linear-io.mjs");
  await postDispatchComment(plan.identifier, plan.body, { apiKey: process.env.LINEAR_API_KEY, fetchImpl: fetch });
} catch { /* best-effort — swallow everything */ }
done();
