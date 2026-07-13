// roadmap — pure validator: roadmap graph -> { errors, warnings, nodeCount }.
// No IO. validate.mjs prints + exits on the result; the MCP `validate` read tool returns it.
// Structural checks + dependency resolution (via flatten) + cycle detection.

import { flatten, detectCycle, STATUS, HELD_STATUSES } from "./graph.mjs";
import { validateExecution } from "./execution.mjs";
import { validatePriority } from "./priority.mjs";
import { validateLinearConfig } from "./linear-core.mjs";
import { validateEstimation } from "./estimate-core.mjs";

const isDone = (s) => !!(STATUS[s] && STATUS[s].done);

// Known per-slice completion-evidence keys (sp.receipts). meta.discipline.required_receipts
// opts a repo into WARNing when a complete slice omits one.
export const RECEIPT_KEYS = ["build", "test", "clone_install", "screenshot", "signoff", "publish"];

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
  if (meta.assistants != null) {
    if (typeof meta.assistants !== "object" || Array.isArray(meta.assistants)) err("meta.assistants must be a mapping");
    else {
      if (meta.assistants.default != null && typeof meta.assistants.default !== "string") err("meta.assistants.default must be a profile name string");
      if (meta.assistants.profiles != null && (typeof meta.assistants.profiles !== "object" || Array.isArray(meta.assistants.profiles))) err("meta.assistants.profiles must be a mapping");
    }
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
      if (meta.discipline.pi_min_slices != null && !(Number.isInteger(meta.discipline.pi_min_slices) && meta.discipline.pi_min_slices >= 1)) {
        err("meta.discipline.pi_min_slices must be an integer >= 1 (a bad knob silently disabling a guardrail is the failure mode)");
      }
      if (meta.discipline.active_pi_cap != null && !(Number.isInteger(meta.discipline.active_pi_cap) && meta.discipline.active_pi_cap >= 1)) {
        err("meta.discipline.active_pi_cap must be an integer >= 1 (the max concurrently-active PIs the portfolio allows)");
      }
      // Finishing-discipline: which receipts a complete slice must carry (opt-in). A bad value
      // would silently disable the check, so reject a non-array or an unknown key.
      const rr = meta.discipline.required_receipts;
      if (rr != null && !(Array.isArray(rr) && rr.every((k) => RECEIPT_KEYS.includes(k)))) {
        err(`meta.discipline.required_receipts must be an array of known receipt keys (${RECEIPT_KEYS.join("|")})`);
      }
      // Composition SHAPE (capture_ratio guards growth RATE): a PI under the floor is usually a
      // slice wearing a PI's coat — 13 one-slice PIs is how a 64-project wall happens. ONE
      // aggregated warning (signal, not a wall); complete PIs exempt (history is what it is).
      const floor = meta.discipline.pi_min_slices;
      if (Number.isInteger(floor) && floor >= 1) {
        const thin = (graph.pis || []).filter((pi) => !isDone(pi.status) && (pi.sprints || []).length < floor);
        if (thin.length) {
          warn(`composition: ${thin.length} non-complete PI(s) hold fewer than ${floor} slice(s) (${thin.map((p) => p.id).join(", ")}) — a PI is a strategic bet; fold these into siblings or grow them`);
        }
      }
      // WIP cap: too many concurrently-ACTIVE PIs is how a portfolio stops finishing and starts
      // sprawling. The roadmap should reward closure over discovery — one aggregated warning when
      // the funded-active count exceeds policy (complete/held/scheduled PIs don't count against it).
      const cap = meta.discipline.active_pi_cap;
      if (Number.isInteger(cap) && cap >= 1) {
        const activePis = (graph.pis || []).filter((pi) => pi.status === "active");
        if (activePis.length > cap) {
          warn(`WIP: ${activePis.length} active PI(s) exceed the cap of ${cap} (${activePis.map((p) => p.id).join(", ")}) — finish an active PI before starting another; the roadmap rewards closure over discovery`);
        }
      }
    }
  }
  if (meta.last_review != null) {
    if (typeof meta.last_review !== "object" || Array.isArray(meta.last_review) || typeof meta.last_review.date !== "string" || typeof meta.last_review.commit !== "string") {
      err("meta.last_review must be a mapping with string date + commit");
    }
  }

  // Optional meta.command_lane: a dated finishing override (see graph.mjs commandLaneMembers/Active).
  // SHAPE only — the pure validator has no clock, so expiry vs `until` is checked at PLAN time.
  // A dangling pi/slice ref only WARNS: the lane would look armed but boost nothing.
  if (meta.command_lane != null) {
    const lane = meta.command_lane;
    if (typeof lane !== "object" || Array.isArray(lane)) {
      err("meta.command_lane must be a mapping { objective, until, pi?, slices? }");
    } else {
      if (typeof lane.objective !== "string" || !lane.objective) err("meta.command_lane.objective must be a non-empty string");
      if (typeof lane.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lane.until)) err(`meta.command_lane.until must be YYYY-MM-DD (got ${JSON.stringify(lane.until)})`);
      const piIds = new Set((graph.pis || []).map((p) => p.id));
      const invokeKeys = new Set();
      for (const p of graph.pis || []) for (const s of p.sprints || []) if (s.invoke) invokeKeys.add(s.invoke);
      if (lane.pi != null) {
        if (typeof lane.pi !== "string") err("meta.command_lane.pi must be a PI id string");
        else if (!piIds.has(lane.pi)) warn(`meta.command_lane.pi "${lane.pi}" matches no PI — the lane covers nothing via pi`);
      }
      if (lane.slices != null) {
        if (!Array.isArray(lane.slices)) err("meta.command_lane.slices must be an array of invoke keys");
        else for (const s of lane.slices) if (!invokeKeys.has(s)) warn(`meta.command_lane.slices: "${s}" resolves to no slice invoke`);
      }
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

  const requiredReceipts = (meta.discipline && Array.isArray(meta.discipline.required_receipts)) ? meta.discipline.required_receipts : [];
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
      // Finishing discipline (opt-in): a done slice must carry every required receipt; a missing one
      // means "done" was declared without the evidence. Off entirely when required_receipts is absent.
      if (requiredReceipts.length && isDone(sp.status)) {
        const missing = requiredReceipts.filter((k) => !(sp.receipts && sp.receipts[k]));
        if (missing.length) warn(`receipt: ${where} is complete but missing required receipt(s): ${missing.join(", ")}`);
      }
      if (!isDone(sp.status) && sp.est_sessions == null) warn(`${where}: no est_sessions (sessions-remaining rollup will undercount)`);
      // Optional execution-strategy hint. Absent → no-op (backward-compatible); present → enum/type/consistency checks.
      const exec = validateExecution(sp.execution, where);
      for (const e of exec.errors) err(e);
      for (const w of exec.warnings) warn(w);
      // Optional priority block. Absent → no-op.
      for (const e of validatePriority(sp.priority, where).errors) err(e);
    }
    // Active-state integrity: an "active" PI must hold REAL agent-runnable work, or the board lies
    // about what's in flight and the concurrency planner over-recommends. Two failure modes:
    //   (a) every sprint is complete → a stale-active PI that should have rolled up to complete;
    //   (b) no sprint is advanceable → every open sprint is held (gated/blocked/paused) or parked
    //       (optionality), so it's a human-gated lane, not active development — a session dispatched
    //       here has nothing to run. This is the "gated decision counted as runnable work" smell.
    if (pi.status === "active" && Array.isArray(pi.sprints) && pi.sprints.length) {
      const open = pi.sprints.filter((sp) => !isDone(sp.status));
      if (open.length === 0) {
        warn(`active-integrity: PI ${pi.id} is active but every sprint is complete — mark it complete (a stale-active PI inflates the in-flight count and hides real closure)`);
      } else if (open.every((sp) => HELD_STATUSES.includes(sp.status) || sp.status === "optionality")) {
        const held = open.filter((sp) => HELD_STATUSES.includes(sp.status)).length;
        const parked = open.length - held;
        warn(`active-integrity: PI ${pi.id} is active but has no agent-runnable slice — ${held} held (gated/blocked/paused)${parked ? ` + ${parked} optionality` : ""}; this is a human-gated lane, not active development`);
      }
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
