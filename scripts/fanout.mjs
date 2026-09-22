#!/usr/bin/env node
// roadmap — fanout launcher (thin CLI over the worktree-session executor).
// Computes the ready wave (auto-capped by the resource/purpose recommender unless
// --cap is given) and launches each slice in its own git worktree via a terminal
// adapter. Default terminal is tmux: a LEAD pane (your review/merge session) plus
// one pane per slice, each cd'd into its worktree and running its kickoff.
//
// SAFETY: dry by default — prints the launch script and spawns NOTHING. --launch
// runs it. Autonomous (headless claude -p) additionally requires --yes-spawn-autonomous.
//
// Usage:
//   node fanout.mjs [--in roadmap.yaml] [--cap N] [--term tmux|print|warp|wt|background]
//                   [--wave N] [--lane max|api] [--lead-claude] [--autonomous]
//                   [--launch] [--yes-spawn-autonomous] [--out file]

import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { REL } from "@connorbritain/roadmap-core/cli-core.mjs";
import { planCloudWave } from "@connorbritain/roadmap-exec-engineering/cloud-dispatch.mjs";
import {
  planWave, launchSettings, renderWaveScript, waveLaunchDecision, waveSummaryLine,
  withBom, spawnLaunchScript, commandExists, commandExistsWin,
} from "@connorbritain/roadmap-exec-engineering/worktree-session.mjs";

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const inPath = val("--in", join(...REL));
const waveIdx = Number(val("--wave", 1));
const track = val("--track", null);             // forward-compat: fan out only one lane of the three-track partition
const dry = has("--dry") || has("--print");      // preview only — launch is the DEFAULT
const outFile = val("--out", null);

const graph = loadGraph(inPath);

// ── cloud fanout: dispatch the wave to CLOUD agents instead of local worktrees. Placed BEFORE
// all worktree/disk/terminal logic on purpose — no disk ceiling, no checkout.
if (has("--cloud")) {
  const cloud = planCloudWave(graph, { cap: has("--cap") ? val("--cap", 5) : null, reviewCeiling: val("--review-ceiling", 5), wave: waveIdx, track });
  if (!cloud.wave.length) { console.error(`No runnable slices in wave ${waveIdx} (cap ${cloud.cap}).`); process.exit(0); }
  console.error(`cloud fanout: wave ${waveIdx}, ${cloud.wave.length} slice(s) → roadmap dispatch (no worktrees, no disk ceiling; cap = review ceiling ${cloud.cap})`);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  let failed = 0;
  for (const n of cloud.wave) {
    const r = spawnSync("node", [join(scriptsDir, "dispatch.mjs"), n.invoke, ...(val("--to") ? ["--to", val("--to")] : [])], { stdio: "inherit" });
    if ((r.status ?? 1) !== 0) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

let plan;
try {
  plan = planWave(graph, { root: process.cwd(), worktreeRoot: val("--worktree-root", null), wave: waveIdx, track,
    cap: has("--cap") ? val("--cap", null) : null, reviewCeiling: Number(val("--review-ceiling", 5)) });
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
if (plan.blocked) { plan.lines.forEach((l) => console.error(l)); process.exit(1); }
if (!plan.wave.length) {
  const trackNote = track ? ` on track ${track} (of ${plan.fullWave.length} in the wave)` : "";
  console.error(`No runnable slices in wave ${waveIdx} (cap ${plan.cap})${trackNote}.`);
  process.exit(0);
}

let settings, decision;
try {
  settings = launchSettings(graph, { root: process.cwd(), term: val("--term", null), workerMode: val("--worker-mode", null),
    assistant: val("--assistant", null), lane: val("--lane", "max"), autonomous: has("--autonomous"), leadClaude: has("--lead-claude") });
  decision = waveLaunchDecision(settings, { outFile, dry, requestedLaunch: has("--launch"), okAutonomous: has("--yes-spawn-autonomous") });
} catch (e) { console.error(`fanout: ${e.message}`); process.exit(2); }

const artifact = renderWaveScript(plan, settings);
const term = settings.term;
console.error(waveSummaryLine(plan, settings, decision));
console.error(`slices: ${plan.wave.map((n) => n.invoke).join(", ")}`);

if (outFile) {
  writeFileSync(outFile, withBom(term, artifact), "utf8");
  console.error(`\n✓ wrote launch script → ${outFile} (not launched — run it yourself, or drop --out to launch)`);
  process.exit(0);
}

if (!decision.spawn) {
  if (decision.mode === "autonomous-needs-ack") {
    console.error(`\n⚠ --autonomous launches headless sessions that commit/push/open PRs unattended.`);
    console.error(`  Re-run with --yes-spawn-autonomous to actually launch. (Workers still never merge.)`);
  }
  process.stdout.write(artifact);
  if (decision.mode === "dry") console.error(`\n(--dry — nothing spawned. Drop --dry to launch; --out <file> to save the script.)`);
  process.exit(0);
}

// LAUNCH (default).
if (term === "tmux" && !commandExists("tmux")) {
  process.stdout.write(artifact);
  console.error(`\n⚠ tmux not found on PATH from here (are you in PowerShell? tmux lives in WSL).`);
  console.error(`  Above is the launch script. Run it in a tmux-capable shell, e.g.:`);
  console.error(`    roadmap fan --wave ${waveIdx} --out wave${waveIdx}.sh   # then, in WSL:  bash wave${waveIdx}.sh`);
  process.exit(0);
}
if (term === "wt" && !commandExistsWin("wt")) {
  process.stdout.write(artifact);
  console.error(`\n⚠ Windows Terminal (wt) not found. Above is the PowerShell launch script —`);
  console.error(`  install Windows Terminal, or 'roadmap fan --out wave${waveIdx}.ps1' and run it yourself.`);
  process.exit(0);
}
if (term === "tmux" || term === "background" || term === "wt" || term === "warp") {
  const code = await spawnLaunchScript(artifact, { term, tmpName: `roadmap-wave${waveIdx}` });
  process.exit(code);
} else {
  // print → just print
  process.stdout.write(artifact);
}
