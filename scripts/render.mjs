#!/usr/bin/env node
// slice-roadmap — render roadmap.yaml → SLICES.md (the generated human view).
// Thin file-writer around lib/render-core.mjs (the pure renderer).
// Usage:
//   node render.mjs [--in docs/roadmap/roadmap.yaml] [--out docs/SLICES.md] [--cap N] [--stdout]
// Default: in=docs/roadmap/roadmap.yaml, out=docs/SLICES.md. --stdout prints instead of writing.

import { writeFileSync } from "node:fs";
import { loadGraph } from "./lib/graph.mjs";
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
const harness = flag("--harness", undefined);   // override the execution-directive dialect (else meta.harness)

const graph = loadGraph(inPath);
const out = renderMarkdown(graph, { cap, harness });

if (toStdout) {
  process.stdout.write(out);
} else {
  writeFileSync(outPath, out, "utf8");
  const sprintCount = (graph.pis || []).reduce((a, p) => a + ((p.sprints || []).length), 0);
  console.error(`✓ rendered ${outPath} (${(graph.pis || []).length} PIs, ${sprintCount} sprints)`);
}
