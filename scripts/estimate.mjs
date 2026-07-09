#!/usr/bin/env node
// roadmap estimate — bridges agent-time's estimator.py into the roadmap.
//   roadmap estimate <slice> [--force]      estimate one slice (skips if already estimated)
//   roadmap estimate --all [--force]        estimate every classified, un-estimated slice
//   roadmap estimate timeline [--now DATE]  roll durations up into projected_target_date per PI
// The brain is lib/estimate-core.mjs (pure). This layer resolves the engine, spawns python
// (injectable for tests), and writes the est_minutes block back via lib/store.mjs.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph } from "./lib/graph.mjs";
import { mutateRoadmap, roadmapPaths } from "./lib/store.mjs";
import { setFields } from "./lib/mcp-core.mjs";
import { estimationConfig, estimateArgs, parseEstimateRecord, applyEstimate, timelinePlan } from "./lib/estimate-core.mjs";

// Resolve estimator.py: explicit meta.estimation.engine → $AGENT_TIME_ENGINE → the installed skill.
export function resolveEngine(cfg, env = process.env, exists = existsSync) {
  const cands = [cfg && cfg.engine, env.AGENT_TIME_ENGINE,
    join(homedir(), ".claude", "skills", "agent-time-estimator", "estimator.py")].filter(Boolean);
  for (const c of cands) if (exists(c)) return c;
  throw new Error(
    "agent-time estimator not found. Install the agent-time-estimator skill, set $AGENT_TIME_ENGINE, " +
    "or set meta.estimation.engine to the path of estimator.py."
  );
}

// Default runner: spawn python, return spawnSync's { status, stdout, stderr, error }.
// python3 → python fallback for Windows boxes without the python3 shim. PYTHONIOENCODING
// forces UTF-8 stdout — the estimator prints →/× and Python otherwise defaults to the
// Windows cp1252 codec on a non-console pipe and crashes on encode.
function spawnEstimator(python, engine, args, cwd) {
  const opts = { cwd, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } };
  const r = spawnSync(python, [engine, ...args], opts);
  if (r.error && r.error.code === "ENOENT" && python === "python3") {
    return spawnSync("python", [engine, ...args], opts);
  }
  return r;
}

// Estimate selected slices. opts: { invoke?, all?, force?, runEstimator? }. runEstimator(args,{cwd})
// is injectable (default = real spawn) and returns { status, stdout, stderr }. The python calls
// happen here (IO); a single transactional mutateRoadmap writes every successful estimate back.
// Returns { estimated, skipped, errors }.
export function runEstimate(root, opts = {}) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const cfg = estimationConfig(graph.meta || {});
  const run = opts.runEstimator || (() => { const e = resolveEngine(cfg); return (args, o) => spawnEstimator(cfg.python, e, args, o.cwd); })();

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

  const estimated = [], skipped = [], errors = [];
  const blocks = {};   // invoke -> estimate block
  for (const sp of targets) {
    if (!sp.shape) { skipped.push({ invoke: sp.invoke, why: "no shape" }); continue; }
    if (sp.estimate && !opts.force) { skipped.push({ invoke: sp.invoke, why: "already estimated (use --force)" }); continue; }
    let args;
    try { args = estimateArgs(sp, cfg); } catch (e) { errors.push({ invoke: sp.invoke, error: e.message }); continue; }
    const r = run(args, { cwd: root });
    if (!r || r.status !== 0) {
      const detail = (r && (r.stderr || (r.error && r.error.message))) || "";
      errors.push({ invoke: sp.invoke, error: `estimator exited ${r ? r.status : "?"}: ${String(detail).trim().slice(0, 200)}` });
      continue;
    }
    try { blocks[sp.invoke] = applyEstimate(parseEstimateRecord(r.stdout)); }
    catch (e) { errors.push({ invoke: sp.invoke, error: e.message }); continue; }
    const b = blocks[sp.invoke];
    estimated.push({ invoke: sp.invoke, minutes: b.minutes, confidence: b.confidence });
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
    if (sub === "log") { console.error("roadmap estimate log: not yet (Phase 3)."); process.exit(2); }
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
