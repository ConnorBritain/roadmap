// roadmap — the engineering scoper. Core's genericScope fills what the documents justify (gate,
// read order, session estimate); this layers code-derived `touches` on top by matching the slice's
// own words against the tracked files, the way the slice-scoper agent greps. Proposals only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { genericScope } from "@connorbritain/roadmap-core/executor.mjs";

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "slice", "add", "fix", "make", "update", "wire", "build", "move", "keep", "core", "test", "tests", "docs", "src", "lib", "index", "main", "file", "files", "new", "old"]);

// Tracked files (git ls-files) or an injected list; empty on a non-git directory.
export function trackedFiles(root, { execImpl = spawnSync } = {}) {
  try {
    const r = execImpl("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean) : [];
  } catch { return []; }
}

const words = (text) => new Set(String(text || "").toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter((w) => !STOP.has(w)) || []);

// Candidate `touches`: tracked files whose path segments share a meaningful word with the slice's
// title / what / prompt, ranked by how many words match, capped so the proposal stays reviewable.
export function candidateTouches(node, files, { limit = 12 } = {}) {
  const vocab = words([node.title, node.what, node.prompt, node.resume_action || node.resumeAction].filter(Boolean).join(" "));
  if (!vocab.size) return [];
  const scored = [];
  for (const f of files) {
    if (/^(node_modules|dist|\.git)\//.test(f) || /\.(png|jpe?g|gif|webp|ico|lock)$/i.test(f)) continue;
    const parts = new Set(f.toLowerCase().split(/[\/._-]+/).filter((p) => p.length > 2));
    let score = 0;
    for (const w of vocab) if (parts.has(w)) score += 1;
    if (score) scored.push({ f, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.f.localeCompare(b.f)).slice(0, limit).map((s) => s.f);
}

export function engineeringScope(node, graph, ctx = {}) {
  const root = ctx.root || process.cwd();
  const base = genericScope(node, graph, { fileExists: (p) => existsSync(join(root, p)) });
  const files = ctx.files || trackedFiles(root, { execImpl: ctx.execImpl });
  const fields = { ...base.fields };
  const rationale = [...base.rationale];
  if (!(node.touches && node.touches.length)) {
    const touches = candidateTouches(node, files);
    if (touches.length) { fields.touches = touches; rationale.push(`touches: ${touches.length} tracked file(s) whose path words match the slice's own words — confirm before relying on wave contention`); }
    else rationale.push("touches: no tracked file matches the slice's words; name the files or refine `what`");
  }
  return { fields, rationale };
}
