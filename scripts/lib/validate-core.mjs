// roadmap — pure validator: roadmap graph -> { errors, warnings, nodeCount }.
// No IO. validate.mjs prints + exits on the result; the MCP `validate` read tool returns it.
// Structural checks + dependency resolution (via flatten) + cycle detection.

import { flatten, detectCycle, STATUS } from "./graph.mjs";
import { validateExecution } from "./execution.mjs";
import { validatePriority } from "./priority.mjs";
import { validateLinearConfig } from "./linear-core.mjs";

const isDone = (s) => !!(STATUS[s] && STATUS[s].done);

export function validateGraph(graph) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  const meta = graph.meta || {};
  if (meta.schema_version !== 1) err(`meta.schema_version must be 1 (got ${JSON.stringify(meta.schema_version)})`);
  if (!meta.program) err("meta.program is required");
  if (meta.terminal && !["warp", "wt", "tmux", "iterm", "background", "print"].includes(meta.terminal)) {
    err(`meta.terminal "${meta.terminal}" is not a known adapter`);
  }

  // Optional meta.linear + per-PI overrides + sprint linear fields. Absent → no-op.
  const lin = validateLinearConfig(graph);
  for (const e of lin.errors) err(e);
  for (const w of lin.warnings) warn(w);

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
      if (!isDone(sp.status) && sp.est_sessions == null) warn(`${where}: no est_sessions (sessions-remaining rollup will undercount)`);
      // Optional execution-strategy hint. Absent → no-op (backward-compatible); present → enum/type/consistency checks.
      const exec = validateExecution(sp.execution, where);
      for (const e of exec.errors) err(e);
      for (const w of exec.warnings) warn(w);
      // Optional priority block. Absent → no-op.
      for (const e of validatePriority(sp.priority, where).errors) err(e);
    }
  }

  // flatten resolves deps + unique invoke keys (throws on failure), then cycle-detect.
  let model = null;
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

  return { errors, warnings, nodeCount: model ? model.nodes.length : 0 };
}
