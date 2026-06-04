#!/usr/bin/env node
// slice-roadmap — render roadmap.yaml → SLICES.md (the generated human view).
// Thin file-writer around lib/render-core.mjs (the pure renderer).
// Usage:
//   node render.mjs [--in docs/roadmap/roadmap.yaml] [--out docs/SLICES.md] [--cap N] [--stdout]
// Default: in=docs/roadmap/roadmap.yaml, out=docs/SLICES.md. --stdout prints instead of writing.

import { writeFileSync } from "node:fs";
import { loadGraph, flatten } from "./lib/graph.mjs";
import { renderMarkdown } from "./lib/render-core.mjs";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
}
const inPath = flag("--in", "docs/roadmap/roadmap.yaml");
const outPath = flag("--out", "docs/SLICES.md");
const toStdout = args.includes("--stdout");
const cap = args.includes("--cap") ? Number(flag("--cap")) : undefined;

const graph = loadGraph(inPath);
const out = renderMarkdown(graph, { cap });

if (toStdout) {
  process.stdout.write(out);
} else {
  writeFileSync(outPath, out, "utf8");
  const model = flatten(graph);
  console.error(`✓ rendered ${outPath} (${graph.pis.length} PIs, ${model.nodes.length} sprints)`);
}
