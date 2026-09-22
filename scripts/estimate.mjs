#!/usr/bin/env node
// roadmap estimate — calibrated per-slice duration estimates and the projected timeline.
//   roadmap estimate <slice> [--force]      estimate one slice (skips if already estimated)
//   roadmap estimate --all [--force]        estimate every classified, un-estimated slice
//   roadmap estimate timeline [--now DATE]  roll durations up into projected_target_date per PI
//   roadmap estimate log <slice> --status … log a completed slice's outcome → calibration
// The pricing model is lib/estimator-core.mjs (pure; a port of agent-time's estimator.py). This layer
// owns the IO: the JSONL calibration history (byte-compatible with agent-time's history.jsonl, so an
// existing history keeps calibrating), session activity files, and the YAML write-back via lib/store.mjs.
// An external estimator.py is used ONLY when explicitly configured (meta.estimation.engine or
// $AGENT_TIME_ENGINE); otherwise estimation is native and needs no Python.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph } from "./lib/graph.mjs";
import { mutateRoadmap, roadmapPaths } from "./lib/store.mjs";
import { setFields } from "./lib/mcp-core.mjs";
import { estimationConfig, estimateArgs, parseEstimateRecord, applyEstimate, timelinePlan, logArgs, alreadyLogged, LOG_STATUSES } from "./lib/estimate-core.mjs";
import { computeEstimate, buildEstimateRecord, buildOutcomeRecord, findTaskRecords, parseRecords, makeTaskId } from "./lib/estimator-core.mjs";

// ── external engine (opt-in) ──────────────────────────────────────────────────
// Resolve an explicitly configured estimator.py: meta.estimation.engine → $AGENT_TIME_ENGINE. Returns
// null when neither is set (native estimation). An installed skill is NOT auto-detected any more —
// native is the default; set the engine explicitly to keep using the Python one.
export function resolveEngine(cfg, env = process.env, exists = existsSync) {
  const cands = [cfg && cfg.engine, env.AGENT_TIME_ENGINE].filter(Boolean);
  if (!cands.length) return null;
  for (const c of cands) if (exists(c)) return c;
  throw new Error(`estimator not found at ${cands.join(" or ")} — fix meta.estimation.engine / $AGENT_TIME_ENGINE, or unset both to use the native estimator.`);
}

// Default external runner: spawn python, return spawnSync's { status, stdout, stderr, error }.
// python3 → python fallback for Windows boxes without the python3 shim. PYTHONIOENCODING forces UTF-8.
function spawnEstimator(python, engine, args, cwd) {
  const opts = { cwd, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } };
  const r = spawnSync(python, [engine, ...args], opts);
  if (r.error && r.error.code === "ENOENT" && python === "python3") return spawnSync("python", [engine, ...args], opts);
  return r;
}

// The external runner when one is configured or injected; null → native.
function externalRunner(cfg, opts) {
  if (opts.runEstimator) return opts.runEstimator;
  const engine = resolveEngine(cfg, opts.env || process.env);
  return engine ? (args, o) => spawnEstimator(cfg.python, engine, args, o.cwd) : null;
}

// ── history / session IO (native) ────────────────────────────────────────────
// The calibration history for this repo — the same path agent-time uses when spawned with cwd=root
// (<root>/.claude/agent-time/history.jsonl), or $AGENT_TIME_DATA.
export function resolveHistory(root, env = process.env) {
  return env.AGENT_TIME_DATA || join(root, ".claude", "agent-time", "history.jsonl");
}

// User-level (cross-repo) history blended into sparse local buckets: $AGENT_TIME_USER_DATA or
// ~/.claude/agent-time/history.jsonl; skipped when it is the same file as the local history.
export function resolveUserHistory(localPath, env = process.env, home = homedir()) {
  const p = env.AGENT_TIME_USER_DATA || join(home, ".claude", "agent-time", "history.jsonl");
  return resolve(p) === resolve(localPath) ? null : p;
}

const readRecords = (path) => (path && existsSync(path)) ? parseRecords(readFileSync(path, "utf8")) : [];
function appendRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

// Session activity files written by agent-time's PostToolUse hook: <history dir>/sessions/<id>.json.
const sessionsDir = (historyPath) => join(dirname(historyPath), "sessions");
export function readSession(historyPath, sessionId) {
  if (!sessionId) return null;
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  const p = join(sessionsDir(historyPath), `${safe}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
// $CLAUDE_SESSION_ID, else the most recently updated session file.
export function resolveSessionId(historyPath, env = process.env) {
  if (env.CLAUDE_SESSION_ID) return env.CLAUDE_SESSION_ID;
  const dir = sessionsDir(historyPath);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { try { return JSON.parse(readFileSync(f, "utf8")).session_id || null; } catch { /* next */ } }
  return null;
}

// ── estimate ──────────────────────────────────────────────────────────────────
// Estimate selected slices. opts: { invoke?, all?, force?, runEstimator?, env?, now?, taskIdHex? }.
// `runEstimator(args, {cwd})` (returns { status, stdout, stderr }) selects the external path; absent,
// and with no engine configured, estimation is native. One transactional mutateRoadmap writes every
// successful estimate back. Returns { estimated, skipped, errors }.
export function runEstimate(root, opts = {}) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const cfg = estimationConfig(graph.meta || {});
  const env = opts.env || process.env;
  const external = externalRunner(cfg, opts);

  const all = [];
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) all.push(sp);
  let targets;
  if (opts.invoke) {
    const sp = all.find((s) => s.invoke === opts.invoke);
    if (!sp) throw new Error(`no slice "${opts.invoke}"`);
    targets = [sp];
  } else if (opts.all) {
    targets = all.filter((s) => s.shape);   // only classified slices are candidates
  } else {
    throw new Error("estimate needs a slice invoke key or --all");
  }

  // Native: history is read once; each new estimate is appended as agent-time would.
  const histPath = resolveHistory(root, env);
  const records = external ? null : readRecords(histPath);
  const userRecords = external ? null : readRecords(resolveUserHistory(histPath, env));

  const estimated = [], skipped = [], errors = [];
  const blocks = {};   // invoke -> estimate block
  for (const sp of targets) {
    if (!sp.shape) { skipped.push({ invoke: sp.invoke, why: "no shape" }); continue; }
    if (sp.estimate && !opts.force) { skipped.push({ invoke: sp.invoke, why: "already estimated (use --force)" }); continue; }
    try {
      let record;
      if (external) {
        const args = estimateArgs(sp, cfg);
        const r = external(args, { cwd: root });
        if (!r || r.status !== 0) {
          const detail = (r && (r.stderr || (r.error && r.error.message))) || "";
          throw new Error(`estimator exited ${r ? r.status : "?"}: ${String(detail).trim().slice(0, 200)}`);
        }
        record = parseEstimateRecord(r.stdout);
      } else {
        const now = opts.now ? new Date(opts.now) : new Date();
        const risks = Array.isArray(sp.risks) ? sp.risks.filter((x) => typeof x === "string" && x) : [];
        const est = computeEstimate(sp.title || sp.invoke, sp.shape, risks, {}, records, { now, model: cfg.model, userRecords });
        const sessionId = resolveSessionId(histPath, env);
        record = buildEstimateRecord(est, { taskId: makeTaskId(now, opts.taskIdHex), now, model: cfg.model, sessionId, session: readSession(histPath, sessionId) });
        appendRecord(histPath, record);
        records.push(record);
      }
      blocks[sp.invoke] = applyEstimate(record);
      const b = blocks[sp.invoke];
      estimated.push({ invoke: sp.invoke, minutes: b.minutes, confidence: b.confidence });
    } catch (e) {
      errors.push({ invoke: sp.invoke, error: e.message });
    }
  }

  if (Object.keys(blocks).length) {
    // One validate + write for the whole batch; a throw leaves the YAML untouched.
    mutateRoadmap(root, (doc) => {
      for (const [invoke, block] of Object.entries(blocks)) setFields(doc, { invoke, fields: { estimate: block } });
      return { estimated: Object.keys(blocks) };
    });
  }
  return { estimated, skipped, errors };
}

// ── timeline ──────────────────────────────────────────────────────────────────
// Roll the per-slice estimates up into a projected_target_date per PI and write it back (never
// touching an explicit target_date — a separate field, so the commitment always wins). Only PIs
// whose projection changed are written. `now` is injectable for deterministic tests. Returns the
// plan plus `changed` (the PI ids whose projected_target_date moved).
export function runTimeline(root, opts = {}) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const now = opts.now || new Date().toISOString();
  const plan = timelinePlan(graph, { now, concurrency: opts.concurrency });
  const wanted = new Map(plan.pis.map((p) => [p.pi, p.projected_target_date]));
  const changed = [];
  for (const pi of graph.pis || []) {
    const cur = pi.projected_target_date || null;
    const want = wanted.has(pi.id) ? wanted.get(pi.id) : null;
    if (cur !== want) changed.push(pi.id);
  }
  if (changed.length) {
    mutateRoadmap(root, (doc) => {
      const items = (doc.get("pis") || {}).items || [];
      for (let i = 0; i < items.length; i++) {
        const id = String(items[i].get("id"));
        const want = wanted.has(id) ? wanted.get(id) : null;
        if (want) doc.setIn(["pis", i, "projected_target_date"], want);
        else if (items[i].get("projected_target_date") != null) doc.deleteIn(["pis", i, "projected_target_date"]);
      }
      return { projected: plan.pis.length };
    });
  }
  return { ...plan, changed };
}

// ── log (calibration loop) ────────────────────────────────────────────────────
// Log a completed slice's outcome so estimates self-correct. Idempotent per task_id via the history
// (re-firing from the Stop hook never double-counts). Best-effort: a rejected log is RETURNED, never
// thrown through. opts: { invoke, status?, force?, actualMinutes?, actualRounds?, runEstimator?, env?, now? }.
export function runLog(root, opts = {}) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const cfg = estimationConfig(graph.meta || {});
  const env = opts.env || process.env;
  let sprint = null;
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) if (sp.invoke === opts.invoke) sprint = sp;
  if (!sprint) throw new Error(`no slice "${opts.invoke}"`);
  const status = opts.status || "pass";
  const args = logArgs(sprint, status, { actualMinutes: opts.actualMinutes, actualRounds: opts.actualRounds });   // throws if not estimated
  const taskId = sprint.estimate.task_id;

  const histPath = resolveHistory(root, env);
  if (!opts.force && existsSync(histPath) && alreadyLogged(readFileSync(histPath, "utf8"), taskId)) {
    return { skipped: true, invoke: opts.invoke, reason: "already calibrated (use --force)" };
  }
  const external = externalRunner(cfg, opts);
  if (external) {
    const r = external(args, { cwd: root });
    if (!r || r.status !== 0) {
      const detail = (r && (r.stderr || (r.error && r.error.message))) || "";
      return { error: `estimator log exited ${r ? r.status : "?"}: ${String(detail).trim().slice(0, 200)}`, invoke: opts.invoke };
    }
    return { invoke: opts.invoke, logged: true, status, task_id: taskId };
  }

  const records = readRecords(histPath);
  const [base, revision] = findTaskRecords(records, taskId);
  if (!base) return { error: `no estimate found for task id '${taskId}' in ${histPath}`, invoke: opts.invoke };
  try {
    const now = opts.now ? new Date(opts.now) : new Date();
    const session = readSession(histPath, base.session_id || resolveSessionId(histPath, env));
    const outcome = buildOutcomeRecord({ base, revision, taskId, now, status, actualMinutes: opts.actualMinutes, actualRounds: opts.actualRounds, session });
    appendRecord(histPath, outcome);
    return { invoke: opts.invoke, logged: true, status, task_id: taskId, actual_minutes: outcome.actual_minutes, actual_rounds: outcome.actual_rounds, auto_filled: Boolean(outcome.auto_filled) };
  } catch (e) {
    return { error: `estimator log rejected: ${e.message}`, invoke: opts.invoke };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const has = (n) => args.includes(n);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a) => !a.startsWith("-"));
  const sub = positional[0];
  const root = process.cwd();
  try {
    if (sub === "timeline") {
      const nowArg = val("--now");
      const r = runTimeline(root, nowArg ? { now: nowArg } : {});
      console.log(`timeline: anchored ${r.anchor} · ${r.concurrency}-wide · ${r.point} · ${r.hoursPerDay}h/day`);
      for (const p of r.pis) console.log(`  ${p.pi} → ${p.projected_target_date}`);
      console.log(r.changed.length ? `projected_target_date updated on ${r.changed.length} PI(s): ${r.changed.join(", ")}` : "projected_target_date: already current (no change).");
      if (r.unpriced.length) console.log(`unpriced (no estimate — 0 span, run 'roadmap estimate --all'): ${[...new Set(r.unpriced)].join(", ")}`);
      if (r.held.length) console.log(`held (blocked / gated — not scheduled, excluded): ${r.held.join(", ")}`);
      process.exit(0);
    }
    if (sub === "log") {
      const invoke = positional[1];
      if (!invoke) { console.error(`usage: roadmap estimate log <slice> [--status ${LOG_STATUSES.join("|")}] [--actual-rounds N] [--actual-minutes M] [--force]`); process.exit(2); }
      const ar = val("--actual-rounds"), am = val("--actual-minutes");
      const r = runLog(root, { invoke, status: val("--status"), force: has("--force"),
        actualRounds: ar != null ? Number(ar) : undefined, actualMinutes: am != null ? Number(am) : undefined });
      if (r.skipped) console.log(`- ${r.invoke}: ${r.reason}`);
      else if (r.error) { console.error(`✗ ${r.invoke}: ${r.error}`); process.exit(1); }
      else console.log(`✓ ${r.invoke}: outcome logged (${r.status}${r.actual_minutes != null ? `, ${r.actual_minutes} min / ${r.actual_rounds} rounds${r.auto_filled ? ", auto-filled" : ""}` : ""}) → calibration updated.`);
      process.exit(0);
    }
    const opts = { force: has("--force") };
    if (has("--all")) opts.all = true;
    else if (sub) opts.invoke = sub;
    else { console.error("usage: roadmap estimate <slice> [--force] | roadmap estimate --all [--force]"); process.exit(2); }
    const r = runEstimate(root, opts);
    for (const e of r.estimated) console.log(`✓ ${e.invoke}: ${e.minutes.expected} min (≈ ${e.minutes.low}–${e.minutes.high}) · ${e.confidence}`);
    for (const s of r.skipped) console.log(`- ${s.invoke} skipped (${s.why})`);
    for (const x of r.errors) console.error(`✗ ${x.invoke}: ${x.error}`);
    if (!r.estimated.length && r.errors.length) process.exit(1);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
