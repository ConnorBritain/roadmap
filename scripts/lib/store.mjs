// roadmap — shared mutation IO. The ONE read → mutate → validate → write → re-render
// sequence every mutating surface uses (mcp.mjs, set.mjs, backlog.mjs, promote.mjs), so a
// validation failure can never leave a half-written roadmap.yaml or a stale SLICES.md.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { REL } from "./cli-core.mjs";
import { renderMarkdown } from "./render-core.mjs";
import { validateDocOrThrow, serialize } from "./mcp-core.mjs";

export function roadmapPaths(root) {
  return { yaml: join(root, ...REL), slices: join(root, "docs", "SLICES.md") };
}

// fn(doc) mutates the yaml Document in place and returns a summary object.
// Any throw (from fn or the pre-write gate) leaves both files untouched.
export function mutateRoadmap(root, fn) {
  const p = roadmapPaths(root);
  const doc = YAML.parseDocument(readFileSync(p.yaml, "utf8"));
  const summary = fn(doc);
  const graph = validateDocOrThrow(doc);
  writeFileSync(p.yaml, serialize(doc), "utf8");
  writeFileSync(p.slices, renderMarkdown(graph), "utf8");
  return { ...summary, rerendered: "docs/SLICES.md" };
}
