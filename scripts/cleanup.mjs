#!/usr/bin/env node
// roadmap cleanup — prune fanout worktrees whose branch is merged to <remote>/<base> and
// whose tree is clean. DRY by default (lists the plan); --remove acts; --force includes
// unmerged/dirty. ONLY touches worktrees under the configured worktree_root (the fanout's
// own) — never the main checkout or your manual worktrees.

import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { loadGraph } from "./lib/graph.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const doRemove = has("--remove");
const force = has("--force");

const git = (...a) => spawnSync("git", a, { encoding: "utf8" });

let meta = {};
try { meta = loadGraph("docs/roadmap/roadmap.yaml").meta || {}; } catch { /* no roadmap — fall back to defaults */ }
const remote = meta.remote || "origin";
const base = meta.base_branch || "main";
const wtRoot = resolve(meta.worktree_root || resolve(process.cwd(), "..", "_worktrees"));

git("fetch", remote, "--quiet");

// Parse `git worktree list --porcelain` into {path, branch}.
const porcelain = (git("worktree", "list", "--porcelain").stdout || "").trim();
const worktrees = (porcelain ? porcelain.split(/\n\n+/) : []).map((b) => ({
  path: (b.match(/^worktree (.+)$/m) || [])[1],
  branch: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || null,
})).filter((w) => w.path);

const mergedOut = git("branch", "--merged", `${remote}/${base}`, "--format=%(refname:short)").stdout || "";
const merged = new Set(mergedOut.split("\n").map((s) => s.trim()).filter(Boolean));

const underRoot = (p) => { const rp = resolve(p); return rp === wtRoot || rp.startsWith(wtRoot + sep); };
const candidates = worktrees.filter((w) => underRoot(w.path));

if (!candidates.length) { console.log(`No fanout worktrees under ${wtRoot}.`); process.exit(0); }

const plan = candidates.map((w) => {
  const dirty = ((git("-C", w.path, "status", "--porcelain").stdout) || "").trim().length > 0;
  const isMerged = w.branch ? merged.has(w.branch) : false;
  return { ...w, dirty, isMerged, removable: isMerged && !dirty };
});

console.log(`Fanout worktrees under ${wtRoot} (merged into ${remote}/${base}?):`);
for (const p of plan) {
  const flags = `${p.isMerged ? "merged" : "UNMERGED"}, ${p.dirty ? "DIRTY" : "clean"}`;
  const action = (p.removable || force) ? (doRemove ? "→ removing" : "→ would remove") : "→ keep";
  console.log(`  ${(p.branch || "(detached)").padEnd(40)} [${flags}]  ${action}`);
  console.log(`      ${p.path}`);
}

if (!doRemove) {
  console.log(`\n(dry — nothing removed. 'roadmap cleanup --remove' prunes merged+clean; add --force for unmerged/dirty.)`);
  process.exit(0);
}

let removed = 0;
for (const p of plan) {
  if (!(p.removable || force)) continue;
  const rm = git("worktree", "remove", ...(p.dirty || !p.isMerged ? ["--force"] : []), p.path);
  if (rm.status !== 0) { console.error(`  ✗ ${p.path}: ${(rm.stderr || "").trim()}`); continue; }
  if (p.branch) git("branch", force ? "-D" : "-d", p.branch);
  console.log(`  ✓ removed ${p.path}`);
  removed++;
}
console.log(`\nremoved ${removed} worktree(s).`);
