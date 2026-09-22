// roadmap — native estimation engine (PURE: no fs, no network, no clock reads unless injected).
//
// A faithful port of agent-time's estimator.py (ConnorBritain/agent-time, skills/agent-time-estimator):
// estimate in agent ROUNDS first (discovery / planning / implementation / verification / rework /
// documentation / coordination), convert to wall-clock minutes from local calibration history
// (JSONL outcome records), and self-correct as outcomes are logged. Every tunable lives in CONFIG /
// SHAPES / RISKS / MODEL_HORIZONS below. The record shapes (`estimate`, `outcome`) are byte-compatible
// with agent-time's history.jsonl so an existing history keeps calibrating, and an external
// estimator.py (meta.estimation.engine) can still be swapped in by scripts/estimate.mjs.
//
// IO (reading/appending history.jsonl, session files, the YAML write-back) lives in scripts/estimate.mjs.

export const CATEGORIES = ["discovery", "planning", "implementation", "verification", "rework", "documentation", "coordination"];

export const CONFIG = {
  static_minutes_per_round: 3.0,   // uncalibrated fallback (one round ≈ think→act→verify)
  checkpoint_minutes: 45,          // expected above this → recommend checkpoint / split
  risk_cap: 3.0,                   // combined multiplier ceiling
  risk_skew_low: 0.3,              // low gets 30% of the risk excess
  risk_skew_high: 1.5,             // high gets 150% of the risk excess
  similarity_threshold: 0.2,       // Jaccard keyword similarity to count as "similar"
  min_similar: 3,
  min_shape: 3,
  min_global: 5,
  empirical_spread_min_n: 15,      // ratios needed to switch to empirical p20/p80 spread
  correction_min_ratios: 3,
  correction_clamp: [0.5, 2.5],
  recency_days: 90,
  recency_weight: 2,
  widen_k: 0.75,                   // width = 1 + k / sqrt(n + 1)
  override_low_frac: 0.7,
  override_high_frac: 1.6,
  model_pace_min_n: 5,
  model_pace_other_min_n: 5,
  model_pace_clamp: [0.5, 2.0],
  user_blend_local_weight: 3,      // local outcomes weigh 3× user-level ones in a blend
  user_blend_user_weight: 1,
  session_auto_min_rounds: 1,      // minimum derivable rounds to accept a session auto-fill
};

// METR-style single-run reliability horizons (minutes). Editable priors, not measurements.
export const MODEL_HORIZONS = {
  "opus-4.8": 90, "opus-4.7": 90, "opus-4.6": 75, "opus-4.5": 60,
  "sonnet-4.6": 30, "sonnet-4.5": 30, "haiku-4.5": 20,
  "gpt-5.5": 90, "gpt-5": 75, "gemini-3.1-pro": 45,
};

// Task-shape priors: rounds per category as [low, mode, high].
export const SHAPES = {
  "trivial-edit":          { discovery: [1, 1, 2],  planning: [0, 0, 0], implementation: [1, 1, 2],   verification: [1, 1, 1],  rework: [0, 0, 1],  documentation: [0, 0, 1], coordination: [0, 0, 0] },
  "localized-bugfix":      { discovery: [2, 3, 5],  planning: [0, 1, 1], implementation: [1, 2, 4],   verification: [1, 2, 3],  rework: [1, 2, 4],  documentation: [0, 0, 1], coordination: [0, 0, 0] },
  "localized-feature":     { discovery: [2, 3, 5],  planning: [1, 1, 2], implementation: [3, 5, 8],   verification: [2, 3, 4],  rework: [1, 2, 4],  documentation: [0, 1, 2], coordination: [0, 0, 0] },
  "cross-cutting-feature": { discovery: [4, 6, 10], planning: [1, 2, 3], implementation: [6, 10, 16], verification: [3, 5, 8],  rework: [2, 4, 8],  documentation: [1, 2, 3], coordination: [0, 1, 2] },
  "refactor":              { discovery: [3, 5, 8],  planning: [1, 2, 3], implementation: [5, 8, 14],  verification: [3, 5, 8],  rework: [2, 3, 6],  documentation: [0, 1, 2], coordination: [0, 0, 0] },
  "migration-schema":      { discovery: [3, 5, 8],  planning: [1, 2, 3], implementation: [4, 6, 10],  verification: [3, 5, 8],  rework: [2, 4, 8],  documentation: [1, 1, 2], coordination: [0, 1, 2] },
  "test-only":             { discovery: [2, 3, 5],  planning: [0, 1, 1], implementation: [2, 4, 7],   verification: [2, 3, 5],  rework: [1, 2, 3],  documentation: [0, 0, 1], coordination: [0, 0, 0] },
  "debugging-unknown":     { discovery: [4, 7, 12], planning: [0, 1, 2], implementation: [1, 3, 6],   verification: [2, 4, 6],  rework: [2, 5, 10], documentation: [0, 0, 1], coordination: [0, 0, 0] },
  "integration-env":       { discovery: [3, 5, 8],  planning: [1, 1, 2], implementation: [2, 4, 8],   verification: [3, 5, 10], rework: [2, 4, 8],  documentation: [0, 1, 2], coordination: [0, 1, 2] },
  "research-design":       { discovery: [5, 8, 14], planning: [2, 3, 5], implementation: [0, 1, 2],   verification: [0, 1, 2],  rework: [0, 1, 2],  documentation: [1, 2, 4], coordination: [0, 0, 0] },
};

// Risk factors: [multiplier, "estimate may change if" trigger].
export const RISKS = {
  "ambiguous-requirements":   [1.30, "requirements are clarified (or turn out to mean something else than assumed)"],
  "unfamiliar-code-path":     [1.25, "the code path works differently than discovery suggested"],
  "no-tests":                 [1.20, "manual verification proves harder than expected (no test safety net)"],
  "slow-flaky-tests":         [1.25, "test flakiness forces extra verification rounds"],
  "env-setup":                [1.30, "environment/tooling setup fails or drifts"],
  "external-api":             [1.25, "the external API behaves differently than documented"],
  "auth-permissions":         [1.30, "auth/permission issues block progress"],
  "db-migration":             [1.30, "schema/data migration surprises appear"],
  "ui-e2e":                   [1.35, "UI/e2e/browser automation proves brittle"],
  "generated-code-build":     [1.25, "generated code or the build pipeline misbehaves"],
  "multi-agent-coordination": [1.30, "coordination/handoff overhead exceeds plan"],
  "large-diff":               [1.25, "the diff surface grows beyond the mapped files"],
  "unknown-root-cause":       [1.50, "the root cause is somewhere other than hypothesized"],
};

const STOPWORDS = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "with",
  "from", "into", "when", "that", "this", "is", "are", "be", "it", "at",
  "as", "by", "so", "we", "use", "using", "new", "should", "not"]);

const sorted = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, [lo, hi]) => Math.min(Math.max(x, lo), hi);

// Python's `round()` (banker's rounding) for integer display parity is not needed for the numbers we
// emit; JS Math.round is what roadmap has always cached, so we keep it.

export function median(values) {
  const vs = [...values].sort((a, b) => a - b);
  if (!vs.length) return null;
  const mid = vs.length >> 1;
  return vs.length % 2 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
}

// ── text similarity ─────────────────────────────────────────────────────────
export function keywords(text) {
  const tokens = String(text || "").toLowerCase().match(/[a-z0-9_.\-]+/g) || [];
  return new Set(tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// ── core math ───────────────────────────────────────────────────────────────
export function combinedRisk(risks) {
  const unknown = sorted(new Set((risks || []).filter((r) => !(r in RISKS))));
  if (unknown.length) throw new Error(`unknown risk factor(s): ${unknown.join(", ")}. Known: ${sorted(Object.keys(RISKS)).join(", ")}`);
  const m = 1 + (risks || []).reduce((s, r) => s + (RISKS[r][0] - 1), 0);
  return Math.min(m, CONFIG.risk_cap);
}

export function applyRisk(low, mode, high, m) {
  const e = m - 1;
  return [low * (1 + CONFIG.risk_skew_low * e), mode * m, high * (1 + CONFIG.risk_skew_high * e)];
}

export const pert = (low, mode, high) => (low + 4 * mode + high) / 6;

// Per-category [low, mode, high] rounds: shape priors + explicit overrides. A single-number override is
// the mode (low/high scaled by override_*_frac); a 3-array is taken literally.
export function buildRounds(shape, overrides = {}) {
  if (!(shape in SHAPES)) throw new Error(`unknown shape '${shape}'. Known: ${sorted(Object.keys(SHAPES)).join(", ")}`);
  const rounds = {};
  for (const c of CATEGORIES) rounds[c] = [...SHAPES[shape][c]];
  for (const [cat, val] of Object.entries(overrides || {})) {
    if (!CATEGORIES.includes(cat)) throw new Error(`unknown round category '${cat}'. Known: ${CATEGORIES.join(", ")}`);
    if (Array.isArray(val)) {
      if (val.length !== 3) throw new Error(`round override for '${cat}' must be a number or [low, mode, high]`);
      rounds[cat] = val.map(Number);
    } else {
      const v = Number(val);
      rounds[cat] = [v * CONFIG.override_low_frac, v, v * CONFIG.override_high_frac];
    }
  }
  return rounds;
}

export const totalRounds = (rounds) => [0, 1, 2].map((i) => CATEGORIES.reduce((s, c) => s + rounds[c][i], 0));

export const widen = (n) => 1 + CONFIG.widen_k / Math.sqrt(n + 1);

// Linear-interpolated percentile, p in [0, 1].
export function percentile(values, p) {
  const vs = [...values].sort((a, b) => a - b);
  if (!vs.length) return null;
  if (vs.length === 1) return vs[0];
  const idx = p * (vs.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx), frac = idx - lo;
  return vs[lo] * (1 - frac) + vs[hi] * frac;
}

// Median of values where each [value, weight] is repeated `weight` times.
export function weightedMedian(pairs) {
  const expanded = [];
  for (const [v, w] of pairs) for (let i = 0; i < Math.trunc(w); i++) expanded.push(v);
  return expanded.length ? median(expanded) : null;
}

// ── calibration ─────────────────────────────────────────────────────────────
export function usableOutcomes(records) {
  return (records || []).filter((r) => r && r.type === "outcome" && r.actual_minutes > 0 && r.actual_rounds > 0);
}
const mprOf = (o) => o.actual_minutes / o.actual_rounds;

export function normalizeModel(name) {
  if (!name) return null;
  const s = String(name).trim().toLowerCase().split("/").pop().replace("claude-", "");
  const m = s.match(/^(opus|sonnet|haiku|gpt|gemini)[-_ ]?(\d+)[-_.](\d+)/);
  return m ? `${m[1]}-${m[2]}.${m[3]}` : s;
}

// [minutes, matchedKey] single-run reliability horizon for a model, or the default.
export function modelHorizon(model) {
  const norm = normalizeModel(model);
  if (norm) {
    if (norm in MODEL_HORIZONS) return [MODEL_HORIZONS[norm], norm];
    for (const [key, minutes] of Object.entries(MODEL_HORIZONS)) if (norm.includes(key) || key.includes(norm)) return [minutes, key];
  }
  return [CONFIG.checkpoint_minutes, null];
}

// [factor, note]: how much faster/slower this model runs per round vs the whole pool; 1.0 when the
// same-model or other-model pools are too thin for a fair comparison. Clamped.
export function modelPaceFactor(outcomes, model) {
  const norm = normalizeModel(model);
  if (!norm) return [1, null];
  const same = outcomes.filter((o) => normalizeModel(o.model) === norm);
  const other = outcomes.filter((o) => o.model && normalizeModel(o.model) !== norm);
  if (same.length < CONFIG.model_pace_min_n || other.length < CONFIG.model_pace_other_min_n) return [1, null];
  const allMpr = median(outcomes.map(mprOf));
  if (!(allMpr > 0)) return [1, null];
  const factor = clamp(median(same.map(mprOf)) / allMpr, CONFIG.model_pace_clamp);
  return [factor, `model pace ×${factor.toFixed(2)}`];
}

function bucketAt(pool, level, shape, kw) {
  if (level === "similar") return pool.filter((o) => o.shape === shape && jaccard(kw, keywords(o.summary || "")) >= CONFIG.similarity_threshold);
  if (level === "shape") return pool.filter((o) => o.shape === shape);
  return [...pool];
}

const parseTs = (s) => new Date(String(s).replace("Z", "+00:00"));
const daysBetween = (a, b) => Math.floor((a.getTime() - b.getTime()) / 86400000);

// Pick minutes-per-round + bias correction from the best available history. Cascade by LOCAL count:
// similar → shape → global; else the same cascade over user-level (cross-repo) history; else the static
// prior (UNCALIBRATED). When a local level qualifies, same-level user outcomes blend in down-weighted.
export function calibrate(records, shape, summary, { now = new Date(), userRecords = [], model = null } = {}) {
  const local = usableOutcomes(records);
  const user = usableOutcomes(userRecords || []);
  const kw = keywords(summary);
  const thresholds = { similar: CONFIG.min_similar, shape: CONFIG.min_shape, global: CONFIG.min_global };
  const wl = CONFIG.user_blend_local_weight, wu = CONFIG.user_blend_user_weight;

  let chosen = null;
  for (const level of ["similar", "shape", "global"]) if (bucketAt(local, level, shape, kw).length >= thresholds[level]) { chosen = [level, "local"]; break; }
  if (!chosen) for (const level of ["similar", "shape", "global"]) if (bucketAt(user, level, shape, kw).length >= thresholds[level]) { chosen = [level, "user"]; break; }

  if (!chosen) {
    return { mpr: CONFIG.static_minutes_per_round, kind: "static", n: local.length, correction: 1, ratios: [], ratio_n: 0, model_factor: 1,
      basis: `UNCALIBRATED (static prior ${CONFIG.static_minutes_per_round.toFixed(1)} min/round; only ${local.length} logged outcome${local.length === 1 ? "" : "s"})` };
  }

  const [level, source] = chosen;
  const localBucket = source === "local" ? bucketAt(local, level, shape, kw) : [];
  const userBucket = bucketAt(user, level, shape, kw);
  const weighted = source === "local"
    ? [...localBucket.map((o) => [o, wl]), ...userBucket.map((o) => [o, wu])]
    : userBucket.map((o) => [o, 1]);

  let mpr = weightedMedian(weighted.map(([o, w]) => [mprOf(o), w]));

  const ratios = [], pairs = [];
  for (const [o, w] of weighted) {
    const estExpected = o.est_minutes && o.est_minutes.expected;
    if (estExpected > 0) {
      const ratio = o.actual_minutes / estExpected;
      let rec = 1;
      try { const d = daysBetween(now, parseTs(o.ts)); if (Number.isFinite(d) && d <= CONFIG.recency_days) rec = CONFIG.recency_weight; } catch { /* keep 1 */ }
      for (let i = 0; i < Math.trunc(w); i++) ratios.push(ratio);
      pairs.push([ratio, w * rec]);
    }
  }
  const ratioN = pairs.length;
  let correction = 1;
  if (ratioN >= CONFIG.correction_min_ratios) correction = clamp(weightedMedian(pairs), CONFIG.correction_clamp);

  const [factor, factorNote] = modelPaceFactor([...local, ...user], model);
  mpr *= factor;

  const n = localBucket.length + userBucket.length;
  const kindLabel = { similar: "similar tasks", shape: "shape median", global: "global median" }[level];
  let basis;
  if (source === "user") basis = `user-level (${kindLabel}, n=${userBucket.length}) · ${mpr.toFixed(2)} min/round`;
  else if (userBucket.length) basis = `blended (${kindLabel}: local n=${localBucket.length} + user n=${userBucket.length}) · ${mpr.toFixed(2)} min/round`;
  else basis = `calibrated (${kindLabel}, n=${localBucket.length}) · ${mpr.toFixed(2)} min/round`;
  if (correction !== 1) basis += ` · bias correction ×${correction.toFixed(2)}`;
  if (factorNote) basis += ` · ${factorNote}`;

  return { mpr, kind: level, n, correction, ratios, ratio_n: ratioN, model_factor: factor, basis };
}

// Convert a rounds triple to wall-clock minutes using calibration. Returns [minutes, spreadNote].
export function minutesFromRounds(rLow, rExpected, rHigh, cal, mprOverride = null) {
  const mpr = mprOverride == null ? cal.mpr : mprOverride;
  const c = cal.correction;
  const expected = rExpected * mpr * c;
  const ratioN = cal.ratio_n != null ? cal.ratio_n : (cal.ratios || []).length;
  let low, high, spreadNote;
  if (cal.kind !== "static" && ratioN >= CONFIG.empirical_spread_min_n) {
    low = rExpected * mpr * percentile(cal.ratios, 0.2);
    high = rExpected * mpr * percentile(cal.ratios, 0.8);
    spreadNote = `empirical p20/p80 spread from ${ratioN} prior ratios`;
  } else {
    const w = widen(cal.n);
    low = rLow * mpr * c / w;
    high = rHigh * mpr * c * w;
    spreadNote = `sparse-data widening ×${w.toFixed(2)} (n=${cal.n})`;
  }
  low = Math.min(low, expected);
  high = Math.max(high, expected);
  return [{ low: round1(low), expected: round1(expected), high: round1(high) }, spreadNote];
}

export function confidence(kind, m) {
  let score = { similar: 3, shape: 2, global: 1, static: 0 }[kind];
  if (m >= 1.75) score -= 1;
  if (m >= 2.5) score -= 1;
  return { 3: "medium-high", 2: "medium", 1: "low-medium" }[score] || "low";
}

export function fmtMinutes(m) {
  m = Math.max(m, 0);
  if (m < 1) return "<1 min";
  if (m < 120) return `${Math.round(m)} min`;
  return `${Math.round(m)} min (~${(m / 60).toFixed(1)} h)`;
}

export function checkpointAdvice(expectedMinutes, rounds, expectedRounds, { horizon = null, horizonModel = null } = {}) {
  horizon = horizon == null ? CONFIG.checkpoint_minutes : horizon;
  const discoveryMode = rounds.discovery[1];
  if (expectedMinutes > horizon) {
    const half = Math.max(1, Math.round(expectedRounds / 2));
    const modelNote = horizonModel ? ` for ${horizonModel}` : "";
    return `expected wall-clock (${fmtMinutes(expectedMinutes)}) exceeds the ${horizon}-min single-run horizon${modelNote} — re-estimate after discovery (~${Math.round(discoveryMode)} rounds) and again at ~${half} rounds; consider splitting the task`;
  }
  return "re-estimate after the first verification round if anything surprised you";
}

export function changeTriggers(risks, kind) {
  const triggers = (risks || []).map((r) => RISKS[r][1]);
  triggers.push("discovery reveals a hidden dependency or architectural mismatch");
  triggers.push("scope grows beyond the stated summary");
  if (kind === "static") triggers.push("calibration data accumulates — log outcomes to narrow future ranges");
  return triggers;
}

// Full estimation pipeline: priors → overrides → risk → PERT → calibration.
export function computeEstimate(summary, shape, risks = [], overrides = {}, records = [], { now = new Date(), model = null, userRecords = [] } = {}) {
  const rounds = buildRounds(shape, overrides);
  const [baseLow, baseMode, baseHigh] = totalRounds(rounds);
  const m = combinedRisk(risks);
  const [rLow, rMode, rHigh] = applyRisk(baseLow, baseMode, baseHigh, m);
  const expectedRounds = pert(rLow, rMode, rHigh);
  const cal = calibrate(records, shape, summary, { now, userRecords, model });
  const [estMinutes, spreadNote] = minutesFromRounds(rLow, expectedRounds, rHigh, cal);
  const [horizon, horizonKey] = modelHorizon(model);
  const sortedRisks = sorted(risks);
  return {
    summary, shape, risks: sortedRisks,
    risk_multiplier: Math.round(m * 100) / 100,
    rounds_by_category: Object.fromEntries(CATEGORIES.map((c) => [c, [...rounds[c]]])),
    base_rounds: { low: round1(baseLow), mode: round1(baseMode), high: round1(baseHigh) },
    est_rounds: { low: round1(rLow), expected: round1(expectedRounds), high: round1(rHigh) },
    est_minutes: estMinutes,
    calibration_basis: `${cal.basis} · ${spreadNote}`,
    calibrated: cal.kind !== "static",
    confidence: confidence(cal.kind, m),
    checkpoint: checkpointAdvice(estMinutes.expected, rounds, expectedRounds, { horizon, horizonModel: horizonKey }),
    change_triggers: changeTriggers(sortedRisks, cal.kind),
    _cal: cal,
  };
}

// ── records (byte-compatible with agent-time's history.jsonl) ───────────────
export function parseRecords(text) {
  const records = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch { /* malformed line: skipped, never fatal */ }
  }
  return records;
}

// [baseEstimate, latestRevision] for a task id.
export function findTaskRecords(records, taskId) {
  let base = null, revision = null;
  for (const r of records || []) {
    if (!r || r.task_id !== taskId) continue;
    if (r.type === "estimate" && !base) base = r;
    else if (r.type === "revision") revision = r;
  }
  return [base, revision];
}

const isoSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

// A task id in agent-time's format: t-YYYYMMDD-<4 hex>. `hex4` is injectable for determinism.
export const makeTaskId = (now, hex4) => `t-${ymd(now)}-${String(hex4 || Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")).slice(0, 4)}`;

// The pending `estimate` record appended to history at estimate time. `session` is the activity snapshot
// (rounds / edited_files / bash_commands) so `log` can auto-fill actuals as deltas.
export function buildEstimateRecord(est, { taskId, now, model = null, findings = null, assumptions = null, sessionId = null, session = null }) {
  const s = session || {};
  return {
    type: "estimate", task_id: taskId, ts: isoSeconds(now),
    summary: est.summary, shape: est.shape,
    findings, assumptions,
    rounds_by_category: est.rounds_by_category,
    risks: est.risks, risk_multiplier: est.risk_multiplier,
    est_rounds: est.est_rounds, est_minutes: est.est_minutes,
    calibration_basis: est.calibration_basis, calibrated: est.calibrated,
    confidence: est.confidence, model, status: "pending",
    session_id: sessionId,
    round_counter_start: Number(s.rounds || 0),
    edited_files_start: (s.edited_files || []).length,
    bash_commands_start: (s.bash_commands || []).length,
  };
}

// A short label for a shell command: the program name, ignoring VAR=value prefixes.
export function firstToken(command) {
  const parts = String(command || "").split(/\s+/).filter(Boolean);
  for (const p of parts) { if (p.split("/")[0].includes("=")) continue; return p; }
  return parts[0] || command;
}

// Auto-fill actuals from session activity recorded since the estimate (deltas from the snapshot).
// Returns null when there is no usable session data.
export function deriveFromSession(base, session) {
  if (!base || !session) return null;
  const rounds = Number(session.rounds || 0) - Number(base.round_counter_start || 0);
  if (rounds < CONFIG.session_auto_min_rounds) return null;
  const files = Math.max((session.edited_files || []).length - Number(base.edited_files_start || 0), 0);
  const cmds = [];
  for (const c of (session.bash_commands || []).slice(Number(base.bash_commands_start || 0))) {
    const tok = firstToken(c);
    if (tok && !cmds.includes(tok)) cmds.push(tok);
  }
  return { rounds, files, commands: cmds, note: `auto-filled from session ${session.session_id || "?"} (Δ${rounds} rounds)` };
}

// The `outcome` record for a completed task. Throws (with agent-time's wording) when no actual rounds
// are available, so callers surface that as an error rather than caching a bogus outcome.
export function buildOutcomeRecord({ base = null, revision = null, taskId, now, status, actualMinutes = null, actualRounds = null,
  summary = null, shape = null, risks = null, model = null, session = null, verificationSteps = null, filesChanged = null, commands = null, variance = null, notes = null } = {}) {
  const derived = deriveFromSession(base, session);
  const rounds = actualRounds != null ? actualRounds : (derived ? derived.rounds : null);
  if (rounds == null) throw new Error("--actual-rounds is required (no session activity to auto-fill from). Pass --actual-rounds N, or enable the round-counting hook.");
  const autoFilled = actualRounds == null && derived != null;
  let minutes = actualMinutes;
  if (minutes == null) {
    if (!base) throw new Error("--actual-minutes is required when logging without --task-id");
    const t = parseTs(base.ts).getTime();
    if (!Number.isFinite(t)) throw new Error("could not compute elapsed time from the estimate record; pass --actual-minutes");
    minutes = round1((now.getTime() - t) / 60000);
  }
  const sum = summary || (base && base.summary) || "";
  const shp = shape || (base && base.shape) || null;
  if (!sum || !shp) throw new Error("--summary and --shape are required when logging without --task-id");
  if (!(shp in SHAPES)) throw new Error(`unknown shape '${shp}'. Known: ${sorted(Object.keys(SHAPES)).join(", ")}`);
  return {
    type: "outcome",
    task_id: taskId,
    ts: isoSeconds(now),
    summary: sum, shape: shp,
    est_rounds: base ? base.est_rounds : null,
    est_minutes: base ? base.est_minutes : null,
    revised_minutes: revision ? revision.est_minutes : null,
    risks: (base ? base.risks : risks) || [],
    model: model || (base && base.model) || null,
    calibration_basis: base ? base.calibration_basis : null,
    actual_minutes: minutes,
    actual_rounds: rounds,
    verification_steps: verificationSteps,
    files_changed: filesChanged != null ? filesChanged : (derived ? derived.files : null),
    commands_run: commands || (derived ? derived.commands : []),
    status,
    variance_explanation: variance,
    notes,
    auto_filled: autoFilled || null,
  };
}

// The markdown block agent-time prints (kept for CLI parity; roadmap prints a one-liner per slice).
export function renderMarkdown(est, { findings = null, assumptions = null, taskId = null } = {}) {
  const lines = ["## Agent Time Estimate", ""];
  if (taskId) lines.push(`Task id: \`${taskId}\``);
  lines.push(`Task shape: ${est.shape}`);
  lines.push(`Discovery findings: ${findings || "(none provided)"}`);
  lines.push(`Assumptions: ${assumptions || "(none provided)"}`);
  lines.push("Round estimate (mode per category, before risk):");
  for (const cat of CATEGORIES) {
    const [low, mode, high] = est.rounds_by_category[cat];
    if (high === 0) continue;
    lines.push(`* ${cat[0].toUpperCase()}${cat.slice(1)}: ${mode} (range ${low}–${high})`);
  }
  const b = est.base_rounds;
  lines.push(`  Base totals (low/mode/high): ${b.low} / ${b.mode} / ${b.high}`, "");
  lines.push(est.risks.length
    ? `Risk factors: ${est.risks.map((r) => `${r} (×${RISKS[r][0].toFixed(2)})`).join(", ")} → combined ×${est.risk_multiplier.toFixed(2)} (excess-additive, cap ${CONFIG.risk_cap.toFixed(1)})`
    : "Risk factors: none selected");
  lines.push(`Calibration basis: ${est.calibration_basis}`);
  const r = est.est_rounds;
  lines.push(`Agent rounds (low/expected/high): ${r.low} / ${r.expected} / ${r.high}`);
  const mm = est.est_minutes;
  lines.push("Wall-clock estimate:", `* Low: ${fmtMinutes(mm.low)}`, `* Expected: ${fmtMinutes(mm.expected)}`, `* High: ${fmtMinutes(mm.high)}`, "");
  lines.push(`Confidence: ${est.confidence}`, `Checkpoint: ${est.checkpoint}`, "Estimate may change if:");
  for (const t of est.change_triggers) lines.push(`* ${t}`);
  return lines.join("\n");
}
