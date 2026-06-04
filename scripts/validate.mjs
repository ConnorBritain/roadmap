#!/usr/bin/env node
// slice-roadmap — validate a roadmap.yaml.
// Structural checks + dependency resolution + cycle detection. Exits non-zero on any error.
// Usage: node validate.mjs [path-to-roadmap.yaml]   (default: docs/roadmap/roadmap.yaml)

import { loadGraph, flatten, detectCycle, STATUS } from "./lib/graph.mjs";

const path = process.argv[2] || "docs/roadmap/roadmap.yaml";
const errors = [];
const warnings = [];

function err(m) { errors.push(m); }
function warn(m) { warnings.push(m); }

let graph;
try {
  graph = loadGraph(path);
} catch (e) {
  console.error(`✗ could not load ${path}: ${e.message}`);
  process.exit(2);
}

// meta
const meta = graph.meta || {};
if (meta.schema_version !== 1) err(`meta.schema_version must be 1 (got ${JSON.stringify(meta.schema_version)})`);
if (!meta.program) err("meta.program is required");
if (meta.terminal && !["warp", "wt", "tmux", "iterm", "background", "print"].includes(meta.terminal)) {
  err(`meta.terminal "${meta.terminal}" is not a known adapter`);
}
// meta.worktree_root unset is fine — the CLI defaults to <repo>/../_worktrees per platform.

// pis + sprints
const validStatus = new Set(Object.keys(STATUS));
const seenPiIds = new Set();
for (const pi of graph.pis || []) {
  if (!pi.id) { err("a PI is missing id"); continue; }
  if (seenPiIds.has(pi.id)) err(`duplicate PI id "${pi.id}"`);
  seenPiIds.add(pi.id);
  if (!pi.title) err(`PI ${pi.id}: title required`);
  if (!validStatus.has(pi.status)) err(`PI ${pi.id}: status "${pi.status}" invalid`);
  if (!Array.isArray(pi.sprints) || pi.sprints.length === 0) { err(`PI ${pi.id}: needs >=1 sprint`); continue; }
  const seenSprintIds = new Set();
  for (const sp of pi.sprints) {
    const where = `${pi.id}/${sp.id || "?"}`;
    if (!sp.id) err(`${pi.id}: a sprint is missing id`);
    else if (seenSprintIds.has(sp.id)) err(`${pi.id}: duplicate sprint id "${sp.id}"`);
    seenSprintIds.add(sp.id);
    if (!sp.title) err(`${where}: title required`);
    if (!validStatus.has(sp.status)) err(`${where}: status "${sp.status}" invalid`);
    if (!sp.invoke) err(`${where}: invoke key required`);
    if (sp.gated_on && sp.status !== "gated") warn(`${where}: gated_on set but status is "${sp.status}" (expected gated)`);
    if (!isDoneStatus(sp.status) && (sp.est_sessions == null)) warn(`${where}: no est_sessions (sessions-remaining rollup will undercount)`);
  }
}

// flatten resolves deps + unique invoke keys (throws on failure), then cycle-detect
let model;
try {
  model = flatten(graph);
} catch (e) {
  err(e.message);
}
if (model) {
  try {
    const cyc = detectCycle(model);
    if (cyc) err(`dependency cycle: ${cyc.join(" → ")}`);
  } catch (e) {
    err(`cycle detection failed: ${e.message}`);
  }
}

function isDoneStatus(s) { return !!(STATUS[s] && STATUS[s].done); }

for (const w of warnings) console.warn(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n${errors.length} error(s) in ${path}`);
  process.exit(1);
}
const nodeCount = model ? model.nodes.length : 0;
console.log(`✓ ${path} valid — ${(graph.pis || []).length} PIs, ${nodeCount} sprints, ${warnings.length} warning(s)`);
process.exit(0);
