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
// CLI shell: the body lives in @connorbritain/roadmap-core/estimate-io.mjs; this file parses argv and re-exports it.
export * from "@connorbritain/roadmap-core/estimate-io.mjs";
import { runEstimate, runLog, runTimeline } from "@connorbritain/roadmap-core/estimate-io.mjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_STATUSES } from "@connorbritain/roadmap-core/estimate-core.mjs";
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
