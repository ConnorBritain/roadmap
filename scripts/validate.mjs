#!/usr/bin/env node
// slice-roadmap — validate a roadmap.yaml.
// Thin wrapper around lib/validate-core.mjs. Exits non-zero on any error.
// Usage: node validate.mjs [path-to-roadmap.yaml]   (default: docs/roadmap/roadmap.yaml)

import { loadGraph } from "./lib/graph.mjs";
import { validateGraph } from "./lib/validate-core.mjs";

const path = process.argv[2] || "docs/roadmap/roadmap.yaml";

let graph;
try {
  graph = loadGraph(path);
} catch (e) {
  console.error(`✗ could not load ${path}: ${e.message}`);
  process.exit(2);
}

const { errors, warnings, nodeCount } = validateGraph(graph);

for (const w of warnings) console.warn(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n${errors.length} error(s) in ${path}`);
  process.exit(1);
}
console.log(`✓ ${path} valid — ${(graph.pis || []).length} PIs, ${nodeCount} sprints, ${warnings.length} warning(s)`);
process.exit(0);
