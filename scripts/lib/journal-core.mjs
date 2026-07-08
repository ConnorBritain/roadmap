// roadmap — "the journal" (PURE): the progress trail agents leave ON a tracker issue so a session that
// dies mid-flight is resumable. This module formats note bodies, resolves the current git branch back to
// a slice (for the auto-post hook), and renders a git-derived snapshot from raw git output. NO IO:
// linear.mjs posts/reads the comments; hooks/journal-post.mjs runs git + fires the post; this decides.

import { flatten } from "./graph.mjs";
import { branchFor } from "./brief.mjs";

export const NOTE_KINDS = ["progress", "blocker", "done", "auto"];

// A note body for a Linear/tracker comment. The `[kind]` heading + `roadmap-note` marker make the stream
// human-scannable on pickup (roadmap linear notes just prints comments chronologically — no parsing).
export function noteBody({ kind = "progress", text } = {}) {
  const k = NOTE_KINDS.includes(kind) ? kind : "progress";
  return `**[${k}]** ${String(text || "").trim()}\n\n_roadmap-note_`;
}

// Invert branchFor over the graph's nodes: given a git branch name, the slice whose branch_convention
// branch equals it — or null when zero or MORE THAN ONE match (the hook only auto-posts on a clean 1:1).
export function sliceForBranch(graph, branch) {
  if (!branch) return null;
  const matches = flatten(graph).nodes.filter((n) => branchFor(n, graph) === branch);
  return matches.length === 1 ? matches[0] : null;
}

// Render the auto-post snapshot from ALREADY-COLLECTED git strings (the hook runs git; this just formats).
// commits: array of subject lines (newest first); dirty: `git status -s` text. Returns null when there's
// no real work to report (no commits ahead + clean tree) so the hook skips empty posts.
export function gitSnapshot({ branch, commits = [], dirty = "" } = {}) {
  const cleanCommits = commits.map((c) => c.trim()).filter(Boolean);
  const dirtyLines = String(dirty || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!cleanCommits.length && !dirtyLines.length) return null;
  const parts = [`Session ended on \`${branch}\`.`];
  if (cleanCommits.length) parts.push(`Recent commits:\n${cleanCommits.slice(0, 3).map((c) => `- ${c}`).join("\n")}`);
  if (dirtyLines.length) parts.push(`Uncommitted (${dirtyLines.length} path(s)):\n${dirtyLines.slice(0, 10).map((l) => `- ${l}`).join("\n")}`);
  return parts.join("\n\n");
}

// The session-end auto-post DECISION (PURE): given the graph + collected git facts, the { identifier, body }
// to post — or null to skip. Guards: the branch must map 1:1 to a MAPPED slice, and there must be real
// work (gitSnapshot non-null). The hook (hooks/journal-post.mjs) runs git + fetch; this decides.
export function autoPostPlan(graph, { branch, commits = [], dirty = "" } = {}) {
  const node = sliceForBranch(graph, branch);
  if (!node || !node.linear) return null;
  const snapshot = gitSnapshot({ branch, commits, dirty });
  if (!snapshot) return null;
  return { identifier: node.linear, body: noteBody({ kind: "auto", text: snapshot }) };
}
