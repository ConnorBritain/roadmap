// roadmap — shared mutation IO. The ONE read → mutate → validate → write → re-render
// sequence every mutating surface uses (mcp.mjs, set.mjs, backlog.mjs, promote.mjs), so a
// validation failure can never leave a half-written YAML or a stale generated view.
// Both mutators re-render BOTH generated files when both sources exist (a backlog edit
// changes the open-count pointer in SLICES.md; a roadmap edit changes nothing in BACKLOG.md
// but re-rendering is cheaper than proving it).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

// Same sequence for backlog.yaml → BACKLOG.md, plus a SLICES.md refresh (open-count pointer).
// createIfMissing: backlog_add bootstraps the file on first capture.
export function mutateBacklog(root, fn, { createIfMissing = false } = {}) {
  const p = backlogPaths(root);
  let src;
  if (existsSync(p.yaml)) src = readFileSync(p.yaml, "utf8");
  else if (createIfMissing) src = EMPTY_BACKLOG;
  else throw new Error(`no ${BACKLOG_REL.join("/")} — capture something first ('roadmap backlog add' or the backlog_add tool creates it)`);
  const doc = YAML.parseDocument(src);
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
