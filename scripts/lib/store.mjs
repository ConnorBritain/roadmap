// roadmap — shared mutation IO. The ONE read → mutate → validate → write → re-render
// sequence every mutating surface uses (mcp.mjs, set.mjs, backlog.mjs, promote.mjs), so a
// validation failure can never leave a half-written YAML or a stale generated view.
// Both mutators re-render BOTH generated files when both sources exist (a backlog edit
// changes the open-count pointer in SLICES.md; a roadmap edit changes nothing in BACKLOG.md
// but re-rendering is cheaper than proving it).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { REL } from "./cli-core.mjs";
import { loadGraph } from "./graph.mjs";
import { renderMarkdown } from "./render-core.mjs";
import { validateDocOrThrow, serialize } from "./mcp-core.mjs";
import { validateBacklogDocOrThrow, renderBacklogMarkdown, openCount } from "./backlog-core.mjs";

export const BACKLOG_REL = ["docs", "roadmap", "backlog.yaml"];
const EMPTY_BACKLOG = "meta:\n  schema_version: 1\nitems: []\n";

export function roadmapPaths(root) {
  return { yaml: join(root, ...REL), slices: join(root, "docs", "SLICES.md") };
}
export function backlogPaths(root) {
  return { yaml: join(root, ...BACKLOG_REL), md: join(root, "docs", "BACKLOG.md") };
}

// Plain backlog object, or null when the repo has no backlog.yaml.
export function loadBacklog(root) {
  const p = backlogPaths(root).yaml;
  if (!existsSync(p)) return null;
  return YAML.parse(readFileSync(p, "utf8"));
}

// Backlog item ids as of origin/main's LAST-FETCHED state (the remote-tracking ref — no
// network call). Concurrent sessions each allocate ids against their own stale checkout;
// five bNN collisions in one day (2026-07-10) came from exactly that. Feeding these ids
// into addItem closes most of the race window without a fetch. Degrades to [] on any
// failure (no git, no remote-tracking ref, no backlog upstream) — allocation then falls
// back to local-only, exactly the pre-guard behavior.
export function originBacklogIds(root, { ref = "origin/main" } = {}) {
  try {
    const r = spawnSync("git", ["show", `${ref}:${BACKLOG_REL.join("/")}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return [];
    const parsed = YAML.parse(r.stdout);
    return (parsed && parsed.items ? parsed.items : []).map((i) => String(i.id));
  } catch { return []; }
}

// Render opts for SLICES.md: the backlog pointer appears only when backlog.yaml exists.
export function slicesRenderOpts(root, backlog = loadBacklog(root)) {
  return backlog ? { backlog: { open: openCount(backlog) } } : {};
}

// fn(doc) mutates the roadmap Document in place and returns a summary object.
// Any throw (from fn or the pre-write gate) leaves every file untouched.
export function mutateRoadmap(root, fn) {
  const p = roadmapPaths(root);
  const doc = YAML.parseDocument(readFileSync(p.yaml, "utf8"));
  const summary = fn(doc);
  const graph = validateDocOrThrow(doc);
  writeFileSync(p.yaml, serialize(doc), "utf8");
  writeFileSync(p.slices, renderMarkdown(graph, slicesRenderOpts(root)), "utf8");
  return { ...summary, rerendered: "docs/SLICES.md" };
}

// Two-file mutation (promote): fn(roadmapDoc, backlogDoc) edits both; BOTH are validated
// before EITHER is written, so the only remaining failure window is an fs error between the
// two writes. ponytail: not truly atomic; temp-file+rename choreography across two files
// isn't worth it for a local dev tool.
export function mutateBoth(root, fn) {
  const rp = roadmapPaths(root);
  const bp = backlogPaths(root);
  if (!existsSync(bp.yaml)) throw new Error(`no ${BACKLOG_REL.join("/")} — nothing to promote from`);
  const rDoc = YAML.parseDocument(readFileSync(rp.yaml, "utf8"));
  const bDoc = YAML.parseDocument(readFileSync(bp.yaml, "utf8"));
  const summary = fn(rDoc, bDoc);
  const graph = validateDocOrThrow(rDoc);
  const backlog = validateBacklogDocOrThrow(bDoc);
  writeFileSync(rp.yaml, serialize(rDoc), "utf8");
  writeFileSync(bp.yaml, serialize(bDoc), "utf8");
  writeFileSync(rp.slices, renderMarkdown(graph, { backlog: { open: openCount(backlog) } }), "utf8");
  writeFileSync(bp.md, renderBacklogMarkdown(backlog), "utf8");
  return { ...summary, rerendered: "docs/SLICES.md + docs/BACKLOG.md" };
}

// Same sequence for backlog.yaml → BACKLOG.md, plus a SLICES.md refresh (open-count pointer).
// createIfMissing: backlog_add bootstraps the file on first capture.
export function mutateBacklog(root, fn, { createIfMissing = false } = {}) {
  const p = backlogPaths(root);
  let src;
  let created = false;
  if (existsSync(p.yaml)) src = readFileSync(p.yaml, "utf8");
  else if (createIfMissing) { src = EMPTY_BACKLOG; created = true; }
  else throw new Error(`no ${BACKLOG_REL.join("/")} — capture something first ('roadmap backlog add' or the backlog_add tool creates it)`);
  const doc = YAML.parseDocument(src);
  if (created) {
    // Block style from birth — the template's `items: []` is a flow seq, and items added to a
    // flow collection stay flow (unreadable once prompts go multiline). Existing files keep
    // whatever style their author chose.
    const seq = doc.get("items");
    if (seq) seq.flow = false;
  }
  const summary = fn(doc);
  const backlog = validateBacklogDocOrThrow(doc);
  writeFileSync(p.yaml, serialize(doc), "utf8");
  writeFileSync(p.md, renderBacklogMarkdown(backlog), "utf8");
  const rp = roadmapPaths(root);
  if (existsSync(rp.yaml)) {
    writeFileSync(rp.slices, renderMarkdown(loadGraph(rp.yaml), slicesRenderOpts(root, backlog)), "utf8");
  }
  return { ...summary, rerendered: "docs/BACKLOG.md" };
}
