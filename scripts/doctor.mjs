#!/usr/bin/env node
// roadmap doctor — reconcile the roadmap against reality and report DRIFT. READ-ONLY: it never
// writes the YAML, the docs, or Linear. It gathers merged PRs, open PRs, fanout worktrees, a
// rendered-vs-disk doc diff, and the Linear pull deltas, then lib/doctor-core.mjs classifies
// them. Every gatherer is guarded: gh/git/Linear missing or slow → that section degrades to
// empty (like the SessionStart hook), so doctor stays fast and never throws on a bare checkout.
// Usage: roadmap doctor [--json]   (--json like review.mjs; exits 1 when drift is found.)

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { loadGraph } from "./lib/graph.mjs";
import { loadBacklog, roadmapPaths, slicesRenderOpts } from "./lib/store.mjs";
import { renderMarkdown } from "./lib/render-core.mjs";
import { renderBacklogMarkdown } from "./lib/backlog-core.mjs";
import { doctorReport } from "./lib/doctor-core.mjs";

const root = process.cwd();
const args = process.argv.slice(2);

// ── gatherers (all guarded → [] / null on any failure) ──────────────────────────
function ghJson(state, fields) {
  try {
    const r = spawnSync("gh", ["pr", "list", "--state", state, "--limit", "100", "--json", fields],
      { cwd: root, encoding: "utf8", timeout: 8000 });
    if (r.status !== 0 || !r.stdout) return [];
    return JSON.parse(r.stdout);
  } catch { return []; }
}
const mergedPrs = () => ghJson("merged", "number,headRefName,title,body");
const openPrs = () => ghJson("open", "number,headRefName,state,isDraft,mergeStateStatus,statusCheckRollup");

// Fanout worktrees under the configured worktree_root, each tagged dirty/merged. Mirrors
// cleanup.mjs's porcelain parse, minus the fetch — doctor is read-only, so it reads the
// last-known remote-tracking state instead of touching the network.
function fanoutWorktrees(meta) {
  try {
    const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
    const remote = meta.remote || "origin";
    const base = meta.base_branch || "main";
    const wtRoot = resolve(meta.worktree_root || resolve(root, "..", "_worktrees"));
    const porcelain = (git("worktree", "list", "--porcelain").stdout || "").trim();
    const all = (porcelain ? porcelain.split(/\n\n+/) : []).map((b) => ({
      path: (b.match(/^worktree (.+)$/m) || [])[1],
      branch: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || null,
    })).filter((w) => w.path);
    const mergedOut = git("branch", "--merged", `${remote}/${base}`, "--format=%(refname:short)").stdout || "";
    const merged = new Set(mergedOut.split("\n").map((s) => s.trim()).filter(Boolean));
    const underRoot = (p) => { const rp = resolve(p); return rp === wtRoot || rp.startsWith(wtRoot + sep); };
    return all.filter((w) => underRoot(w.path)).map((w) => ({
      ...w,
      dirty: ((git("-C", w.path, "status", "--porcelain").stdout) || "").trim().length > 0,
      merged: w.branch ? merged.has(w.branch) : false,
    }));
  } catch { return []; }
}

// Generated docs whose on-disk bytes differ from a fresh render. Line endings are normalized
// (renderMarkdown emits LF; a Windows checkout may hold CRLF) so a checkout-style newline
// difference never masquerades as content drift. A MISSING generated doc counts as stale — a
// roadmap with content but no rendered catalog is drift the same 'roadmap render' fixes.
function staleDocs(graph, backlog) {
  const stale = [];
  const norm = (s) => s.replace(/\r\n/g, "\n");
  const check = (rel, rendered) => {
    let disk = null;
    try { disk = readFileSync(join(root, rel), "utf8"); } catch { /* missing/unreadable → below */ }
    if (disk == null || norm(disk) !== norm(rendered)) stale.push(rel);
  };
  try { check("docs/SLICES.md", renderMarkdown(graph, slicesRenderOpts(root, backlog))); } catch { /* render failure → skip */ }
  if (backlog) { try { check("docs/BACKLOG.md", renderBacklogMarkdown(backlog)); } catch { /* skip */ } }
  return { staleDocs: stale };
}

// Linear pull deltas (dry, pull-only → zero writes). null when Linear is off/unauthed/unreachable,
// which doctor-core reads as "skip the Linear section".
async function linearDeltas() {
  try {
    const { runSync } = await import("./linear.mjs");
    const r = await runSync(root, { dry: true, pullOnly: true });
    return (r.proposals && r.proposals.deltas) || null;
  } catch { return null; }
}

// ── run ──────────────────────────────────────────────────────────────────────
let graph;
try {
  graph = loadGraph(roadmapPaths(root).yaml);
} catch (e) {
  console.error(`✗ could not load the roadmap: ${e.message}`);
  process.exit(2);
}
const backlog = loadBacklog(root);

const report = doctorReport({
  graph,
  backlog,
  mergedPrs: mergedPrs(),
  allPrs: openPrs(),
  worktrees: fanoutWorktrees(graph.meta || {}),
  renderedVsDisk: staleDocs(graph, backlog),
  linearDeltas: await linearDeltas(),
});

if (args.includes("--json")) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.driftCount ? 1 : 0);
}

if (!report.driftCount) {
  console.log("✓ no drift — the roadmap matches reality (merged PRs, docs, Linear, worktrees, structure).");
  process.exit(0);
}
console.log(`roadmap doctor — ${report.driftCount} drift signal(s):\n`);
for (const s of report.sections) {
  console.log(`${s.title} (${s.items.length}):`);
  for (const item of s.items) console.log(`  • ${item}`);
  console.log("");
}
console.log("Read-only — nothing was changed. Reconcile with /sync, 'roadmap render', or the set tools.");
process.exit(1);
