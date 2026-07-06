#!/usr/bin/env node
// roadmap — render roadmap.yaml → SLICES.md (+ backlog.yaml → BACKLOG.md when present).
// Thin file-writer around lib/render-core.mjs / lib/backlog-core.mjs (the pure renderers).
// Usage:
//   node render.mjs [--in docs/roadmap/roadmap.yaml] [--out docs/SLICES.md] [--cap N] [--stdout]
// Default: in=docs/roadmap/roadmap.yaml, out=docs/SLICES.md. --stdout prints SLICES only.

import { writeFileSync } from "node:fs";
import { loadGraph } from "./lib/graph.mjs";
import { renderMarkdown } from "./lib/render-core.mjs";
import { loadBacklog, slicesRenderOpts, backlogPaths } from "./lib/store.mjs";
import { renderBacklogMarkdown } from "./lib/backlog-core.mjs";

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
const backlog = loadBacklog(process.cwd());
const out = renderMarkdown(graph, { cap, ...slicesRenderOpts(process.cwd(), backlog) });

if (toStdout) {
  process.stdout.write(out);
} else {
  writeFileSync(outPath, out, "utf8");
  const sprintCount = (graph.pis || []).reduce((a, p) => a + ((p.sprints || []).length), 0);
  console.error(`✓ rendered ${outPath} (${(graph.pis || []).length} PIs, ${sprintCount} sprints)`);
  if (backlog) {
    const mdPath = backlogPaths(process.cwd()).md;
    writeFileSync(mdPath, renderBacklogMarkdown(backlog), "utf8");
    console.error(`✓ rendered docs/BACKLOG.md (${(backlog.items || []).length} items)`);
  }
}
