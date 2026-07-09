// roadmap — estimation brain (PURE: no fs, no network, no spawn). Bridges agent-time's
// estimator.py into the roadmap: builds the estimator CLI args from a slice, parses its
// JSON record, shapes the compact `estimate` block cached on the slice, and validates the
// estimation config + fields. The IO (spawning python, YAML write-back) lives in
// scripts/estimate.mjs; the timeline rollup (Phase 2) adds to this file.
//
// agent-time owns the shape/risk vocabulary — its SHAPES/RISKS tables validate and reject
// unknown values — so the roadmap deliberately does NOT duplicate the enum (no drift).

import { flatten, computeWaves, isDone } from "./graph.mjs";

const DEFAULTS = { python: "python3", hours_per_day: 6, point: "expected", model: "opus-4.8" };

// meta.estimation → a filled config (defaults applied). Estimation is an explicit command,
// so this returns a usable config even when meta.estimation is absent; the block just
// overrides defaults. `engine: null` → the IO layer resolves the default estimator path.
export function estimationConfig(meta) {
  const raw = (meta && meta.estimation) || {};
  return {
    engine: raw.engine || null,
    python: raw.python || DEFAULTS.python,
    hours_per_day: typeof raw.hours_per_day === "number" && raw.hours_per_day > 0 ? raw.hours_per_day : DEFAULTS.hours_per_day,
    point: raw.point === "high" ? "high" : DEFAULTS.point,
    model: raw.model || DEFAULTS.model,
  };
}

// argv for `estimator.py estimate` from a slice. A FRESH estimate every call: agent-time's
// reestimate needs rounds-spent from a live session, which batch planning doesn't have, so
// re-estimation is a fresh estimate (via --force), not a reestimate. Throws when the slice
// isn't classified — an explicit shape is required (no silent heuristic).
export function estimateArgs(sprint, cfg) {
  if (!sprint || !sprint.shape) {
    throw new Error(`slice "${(sprint && sprint.invoke) || "?"}" has no shape — set shape (+ optional risks) before estimating`);
  }
  const args = ["estimate", "--summary", sprint.title || sprint.invoke, "--shape", sprint.shape, "--json"];
  const risks = Array.isArray(sprint.risks) ? sprint.risks.filter((r) => typeof r === "string" && r) : [];
  if (risks.length) args.push("--risks", risks.join(","));
  if (cfg && cfg.model) args.push("--model", cfg.model);
  return args;
}

// `estimate --json` prints a markdown block, a blank line, then the pretty JSON record LAST.
// Pull the trailing top-level object (the record starts on its own `{` line).
export function parseEstimateRecord(stdout) {
  const s = String(stdout || "").replace(/\r\n/g, "\n");   // Windows python emits CRLF
  const at = s.lastIndexOf("\n{\n");
  const jsonText = at >= 0 ? s.slice(at + 1) : (s.trimStart().startsWith("{") ? s : null);
  if (!jsonText) throw new Error("no JSON record in estimator output (was --json passed?)");
  let rec;
  try { rec = JSON.parse(jsonText.trim()); } catch { throw new Error("could not parse the estimator's JSON record"); }
  if (!rec || rec.type !== "estimate" || !rec.est_minutes) throw new Error("estimator record missing est_minutes");
  // Trust boundary: the estimator is an external process. A status-0 response with a present-but-
  // non-numeric est_minutes would otherwise cache a bogus block that only warns on validate — reject it.
  const m = rec.est_minutes;
  if (["low", "expected", "high"].some((k) => typeof m[k] !== "number")) throw new Error("estimator record has non-numeric est_minutes");
  return rec;
}

// The compact block cached on the slice (schema: sprint.estimate).
export function applyEstimate(record) {
  const m = (record && record.est_minutes) || {};
  return {
    minutes: { low: m.low, expected: m.expected, high: m.high },
    confidence: record.confidence,
    task_id: record.task_id,
    at: record.ts,
    basis: record.calibration_basis,
  };
}

export const LOG_STATUSES = ["pass", "fail", "partial", "abandoned"];   // agent-time's outcome statuses (single source)

// argv for `estimator.py log` — the calibration outcome for a completed slice. agent-time auto-fills
// actual rounds/minutes from its own session tracking when present; we always pass --status, and the
// optional actuals for a manual entry. Throws when the slice was never estimated (no task_id to key on).
export function logArgs(sprint, status, opts = {}) {
  const tid = sprint && sprint.estimate && sprint.estimate.task_id;
  if (!tid) throw new Error(`slice "${(sprint && sprint.invoke) || "?"}" has no estimate.task_id — run 'roadmap estimate ${(sprint && sprint.invoke) || "<slice>"}' first`);
  const st = status || "pass";
  if (!LOG_STATUSES.includes(st)) throw new Error(`status must be one of ${LOG_STATUSES.join("|")} (got "${st}")`);
  const args = ["log", "--task-id", tid, "--status", st];
  if (typeof opts.actualMinutes === "number") args.push("--actual-minutes", String(opts.actualMinutes));
  if (typeof opts.actualRounds === "number") args.push("--actual-rounds", String(opts.actualRounds));
  return args;
}

// Has agent-time already logged an outcome for this task_id? Idempotency for the calibration loop —
// reads agent-time's own JSONL history (its store, not the roadmap's), so re-firing never double-counts.
export function alreadyLogged(historyText, taskId) {
  if (!historyText || !taskId) return false;
  for (const line of String(historyText).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec; try { rec = JSON.parse(t); } catch { continue; }
    if (rec && rec.type === "outcome" && rec.task_id === taskId) return true;
  }
  return false;
}

// A calendar date `offsetMinutes` of agent wall-clock after `anchor`, at `hoursPerDay`
// productive hours/day. Calendar days (ceil), not business days (a deferred knob). `anchor`
// is a fixed YYYY-MM-DD string, so this stays deterministic (no wall-clock read).
export function calendarFromMinutes(offsetMinutes, { hoursPerDay, anchor }) {
  const days = Math.ceil(Math.max(0, offsetMinutes) / (hoursPerDay * 60));
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Roll per-slice durations up into a projected target date per PI. Uses the SAME wave
// schedule the fanout runs (computeWaves: dependency + concurrency + file-contention order),
// so the projection matches how work actually flows. A wave runs concurrently → its span is
// the MAX slice duration in it (not the sum); waves are sequential → spans accumulate. Each PI's
// finish is its last scheduled slice's cumulative offset, laid on the calendar from `anchor`.
//
// Honest bounds (surfaced, never a silent hole in the DATE):
//  · Unpriced slice (no estimate) → it's scheduled work of unknown length, so it SUPPRESSES its
//    PI's date entirely (a PI is dated only when every remaining slice is priced) and is listed in
//    `unpriced`. We never emit a date that quietly omits it.
//  · Held slice (blocked / gated-on-human) → not schedulable, so computeWaves excludes it from the
//    makespan; it's listed in `held`. The date reflects the schedulable frontier, deliberately
//    optimistic there — but that's a labelled, surfaced exclusion, not a zero folded into the number.
export function timelinePlan(graph, opts = {}) {
  const cfg = estimationConfig(graph.meta || {});
  const point = opts.point || cfg.point;
  const hoursPerDay = opts.hoursPerDay || cfg.hours_per_day;
  const concurrency = opts.concurrency || (graph.meta && graph.meta.default_concurrency) || 3;
  const activeStarts = (graph.pis || []).filter((p) => p.status === "active" && p.start_date).map((p) => p.start_date).sort();
  const anchor = opts.anchor || activeStarts[0] || (opts.now ? opts.now.slice(0, 10) : null);
  if (!anchor) throw new Error("timelinePlan needs an anchor: no active start_date and no `now` supplied");

  const minsAt = (minutes) => (minutes && typeof minutes[point] === "number") ? minutes[point] : null;

  // Pricing gate from the GRAPH (authoritative — covers held slices too, which never reach the waves):
  // a PI earns a date only when it has a priced remaining slice AND no unpriced one.
  const unpriced = [];
  const hasPriced = new Set();
  const hasUnpriced = new Set();
  for (const pi of graph.pis || []) {
    for (const sp of pi.sprints || []) {
      if (isDone(sp.status)) continue;
      if (minsAt(sp.estimate && sp.estimate.minutes) == null) { unpriced.push(sp.invoke); hasUnpriced.add(pi.id); }
      else hasPriced.add(pi.id);
    }
  }

  // Makespan from the wave schedule: span = slowest slice (parallel), waves accumulate (sequential).
  // Every scheduled node registers its PI's finish (Math.max, so a 0-min wave still records offset 0).
  const model = flatten(graph);
  const { waves, held } = computeWaves(model, concurrency);
  const finishByPi = new Map();
  let cumulative = 0;
  for (const wave of waves) {
    let span = 0;
    for (const n of wave) { const m = minsAt(n.estMinutes); if (m != null && m > span) span = m; }
    cumulative += span;
    for (const n of wave) finishByPi.set(n.piId, Math.max(finishByPi.get(n.piId) ?? 0, cumulative));
  }

  const pis = [];
  for (const pi of graph.pis || []) {
    if (!hasPriced.has(pi.id) || hasUnpriced.has(pi.id)) continue;   // needs a basis AND no unpriced hole
    if (!finishByPi.has(pi.id)) continue;   // priced but every slice is held (none scheduled) → no makespan
    pis.push({ pi: pi.id, projected_target_date: calendarFromMinutes(finishByPi.get(pi.id), { hoursPerDay, anchor }) });
  }
  const heldInvokes = [...(held.onHuman || []), ...(held.blocked || [])].map((n) => n.invoke);
  return { anchor, concurrency, hoursPerDay, point, pis, unpriced, held: heldInvokes };
}

// Optional estimation config + per-slice estimate fields. Absent → no-op. Mirrors
// validateLinearConfig: returns { errors, warnings } folded into the main validator.
export function validateEstimation(graph) {
  const errors = [];
  const warnings = [];
  const raw = graph.meta && graph.meta.estimation;
  if (raw != null) {
    if (typeof raw !== "object" || Array.isArray(raw)) errors.push("meta.estimation must be a mapping");
    else {
      if (raw.hours_per_day != null && !(typeof raw.hours_per_day === "number" && raw.hours_per_day > 0)) {
        errors.push("meta.estimation.hours_per_day must be a number > 0");
      }
      if (raw.point != null && raw.point !== "expected" && raw.point !== "high") {
        errors.push('meta.estimation.point must be "expected" or "high"');
      }
    }
  }
  for (const pi of graph.pis || []) {
    for (const sp of pi.sprints || []) {
      const where = `${pi.id}/${sp.id || "?"}`;
      if (sp.shape != null && typeof sp.shape !== "string") errors.push(`${where}: shape must be a string`);
      if (sp.risks != null && (!Array.isArray(sp.risks) || sp.risks.some((r) => typeof r !== "string"))) {
        errors.push(`${where}: risks must be an array of strings`);
      }
      if (sp.estimate != null) {
        if (typeof sp.estimate !== "object" || Array.isArray(sp.estimate)) errors.push(`${where}: estimate must be a mapping`);
        else if (sp.estimate.minutes != null && typeof sp.estimate.minutes.expected !== "number") {
          warnings.push(`${where}: estimate.minutes has no numeric expected — re-run 'roadmap estimate ${sp.invoke} --force'`);
        }
      }
    }
  }
  return { errors, warnings };
}
