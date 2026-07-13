// roadmap — external reality probes (git + gh). IMPURE but GUARDED: every probe returns a safe/empty
// value when git/gh is missing, unauthed, slow, or errors, so callers never throw and stay fast. The
// same gatherers were inlined in hooks/session-start.mjs, scripts/watch-prs.mjs, and scripts/cleanup.mjs;
// this is the ONE shared home so drift-doctor + review-debt backpressure don't add a fourth/fifth copy.
// The parsing is split into a PURE helper (parseWorktrees) so it can be unit-tested without a repo.

import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";

const git = (root, ...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });

// TODO(dedupe): hooks/session-start.mjs, scripts/watch-prs.mjs, and scripts/cleanup.mjs still carry
// their own inline copies of these gatherers (pre-dating this module). Fold them onto this one home
// in a follow-up so there's a single implementation. Tracked in the finishing-discipline backlog.

// Merged PRs: [{ number, headRefName, title, body }]. [] on any failure. 5s cap.
export function mergedPrs(root) {
  try {
    const r = spawnSync("gh", ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,headRefName,title,body"],
      { cwd: root, encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return [];
    return JSON.parse(r.stdout);
  } catch { return []; }
}

// All PRs incl. open/draft with merge + check state:
// [{ number, title, headRefName, state, isDraft, mergeStateStatus, statusCheckRollup }].
// null on failure (lets a caller distinguish "gh absent" from "zero PRs"). 5s cap.
export function allPrs(root) {
  try {
    const r = spawnSync("gh", ["pr", "list", "--state", "all", "--limit", "100",
      "--json", "number,title,headRefName,state,isDraft,mergeStateStatus,statusCheckRollup"],
      { cwd: root, encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return null;
    return JSON.parse(r.stdout);
  } catch { return null; }
}

// PURE: parse `git worktree list --porcelain` → [{ path, branch, isMerged }], optionally filtered to
// those under wtRoot. mergedSet = branch names merged into the base (from `git branch --merged`).
export function parseWorktrees(porcelain, { mergedSet = new Set(), wtRoot = null } = {}) {
  const all = (porcelain ? porcelain.split(/\n\n+/) : []).map((b) => ({
    path: (b.match(/^worktree (.+)$/m) || [])[1],
    branch: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || null,
  })).filter((w) => w.path);
  const under = wtRoot
    ? all.filter((w) => { const rp = resolve(w.path); return rp === wtRoot || rp.startsWith(wtRoot + sep); })
    : all;
  return under.map((w) => ({ ...w, isMerged: w.branch ? mergedSet.has(w.branch) : false }));
}

// Fanout worktrees under wtRoot with dirty + merged classification: [{ path, branch, isMerged, dirty }].
// [] on any failure. meta drives remote/base/worktree_root exactly as cleanup.mjs resolves them.
export function worktrees(root, meta = {}) {
  try {
    const remote = meta.remote || "origin";
    const base = meta.base_branch || "main";
    const wtRoot = resolve(meta.worktree_root || resolve(root, "..", "_worktrees"));
    const porcelain = (git(root, "worktree", "list", "--porcelain").stdout || "").trim();
    const mergedOut = git(root, "branch", "--merged", `${remote}/${base}`, "--format=%(refname:short)").stdout || "";
    const mergedSet = new Set(mergedOut.split("\n").map((s) => s.trim()).filter(Boolean));
    return parseWorktrees(porcelain, { mergedSet, wtRoot }).map((w) => ({
      ...w,
      dirty: ((git(root, "-C", w.path, "status", "--porcelain").stdout) || "").trim().length > 0,
    }));
  } catch { return []; }
}
