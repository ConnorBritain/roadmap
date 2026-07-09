// roadmap — pure validator: roadmap graph -> { errors, warnings, nodeCount }.
// No IO. validate.mjs prints + exits on the result; the MCP `validate` read tool returns it.
// Structural checks + dependency resolution (via flatten) + cycle detection.

import { flatten, detectCycle, STATUS } from "./graph.mjs";
import { validateExecution } from "./execution.mjs";
import { validatePriority } from "./priority.mjs";
import { validateLinearConfig } from "./linear-core.mjs";
import { validateEstimation } from "./estimate-core.mjs";

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

  // Jira is the designed follow-up but NOT implemented — surface a stray block instead of
  // letting someone believe it syncs (docs/DEPLOYMENT.md documents the planned shape).
  if (meta.jira != null) warn("meta.jira is not implemented yet (Linear is the only tracker today) — the block is ignored");

  // Scope-discipline knobs + the review anchor. Absent → no-op.
  if (meta.discipline != null) {
    if (typeof meta.discipline !== "object" || Array.isArray(meta.discipline)) err("meta.discipline must be a mapping");
    else {
      if (meta.discipline.capture_ratio != null && !(typeof meta.discipline.capture_ratio === "number" && meta.discipline.capture_ratio > 0)) {
        err("meta.discipline.capture_ratio must be a number > 0");
      }
      if (meta.discipline.coherence != null && typeof meta.discipline.coherence !== "boolean") {
        err("meta.discipline.coherence must be a boolean");
      }
    }
  }
  if (meta.last_review != null) {
    if (typeof meta.last_review !== "object" || Array.isArray(meta.last_review) || typeof meta.last_review.date !== "string" || typeof meta.last_review.commit !== "string") {
      err("meta.last_review must be a mapping with string date + commit");
    }
  }

  // Optional meta.linear + per-PI overrides + sprint linear fields. Absent → no-op.
  const lin = validateLinearConfig(graph);
  for (const e of lin.errors) err(e);
  for (const w of lin.warnings) warn(w);

  // Optional agent-time estimation config + per-slice estimate fields. Absent → no-op.
  const est = validateEstimation(graph);
  for (const e of est.errors) err(e);
  for (const w of est.warnings) warn(w);

  const validStatus = new Set(Object.keys(STATUS));
  const seenPiIds = new Set();
  for (const pi of graph.pis || []) {
    if (!pi.id) { err("a PI is missing id"); continue; }
    if (seenPiIds.has(pi.id)) err(`duplicate PI id "${pi.id}"`);
    seenPiIds.add(pi.id);
    if (!pi.title) err(`PI ${pi.id}: title required`);
    if (pi.initiative != null && typeof pi.initiative !== "string") err(`PI ${pi.id}: initiative must be a string (the Linear initiative name)`);
    for (const e of validatePriority(pi.priority, `PI ${pi.id}`).errors) err(e);
    if (pi.target_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(pi.target_date)) err(`PI ${pi.id}: target_date must be YYYY-MM-DD (got ${JSON.stringify(pi.target_date)})`);
    if (pi.start_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(pi.start_date)) err(`PI ${pi.id}: start_date must be YYYY-MM-DD (got ${JSON.stringify(pi.start_date)})`);
    if (pi.projected_target_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(pi.projected_target_date)) err(`PI ${pi.id}: projected_target_date must be YYYY-MM-DD (got ${JSON.stringify(pi.projected_target_date)})`);
    if (pi.summary != null && (typeof pi.summary !== "string" || pi.summary.length > 255)) err(`PI ${pi.id}: summary must be a string of at most 255 chars (it's the Linear subtitle — keep it to one line)`);
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
