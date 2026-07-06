#!/usr/bin/env node
// roadmap — fanout launcher.
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
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { loadGraph, flatten, computeWaves, readyNodes } from "./lib/graph.mjs";
import { recommendConcurrency, probeDisk } from "./lib/recommend.mjs";
import { synthesizeBrief, branchFor, worktreeFor, launchPrompt, baseRefOf, remoteOf } from "./lib/brief.mjs";
import { launchDecision, bashWorktreeLines, pwshWorktreeLines, diskBlockLines } from "./lib/fanout-core.mjs";
import { terminalChoices } from "./lib/wizard-core.mjs";
import { filterByTrack } from "./lib/execution.mjs";

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const inPath = val("--in", "docs/roadmap/roadmap.yaml");
const waveIdx = Number(val("--wave", 1));
const track = val("--track", null);             // forward-compat: fan out only one lane of the three-track partition
const lane = val("--lane", "max");              // max (subscription) | api (ANTHROPIC_API_KEY)
const autonomous = has("--autonomous");          // headless claude -p (else interactive, watchable)
const dry = has("--dry") || has("--print");      // preview only — launch is the DEFAULT
const okAutonomous = has("--yes-spawn-autonomous");
const leadClaude = has("--lead-claude");         // launch claude in the lead pane (else a shell)
const outFile = val("--out", null);
// The lead pane's claude prompt (only with --lead-claude). It coordinates; it cannot see the
// workers' context (separate processes) but observes their PRs/branches and merges.
const LEAD_PROMPT = "You are the LEAD for this fanout wave. The other panes are independent worker sessions - each owns one slice in its own git worktree and opens a PR. You cannot see their context, but you can observe their work: run gh pr list to see PRs, use git to inspect branches and worktrees, and review then merge each PR in dependency order as it lands. Only you merge - workers never do. Do not write slice code yourself.";

const graph = loadGraph(inPath);
const wtRootOverride = val("--worktree-root", null);
if (wtRootOverride) (graph.meta ||= {}).worktree_root = wtRootOverride;
const model = flatten(graph);
// Terminal default is platform-aware (no machine-specifics in the committed YAML):
// Windows → Windows Terminal tabs; elsewhere → tmux panes. terminalChoices() owns that rule.
const term = val("--term", (graph.meta && graph.meta.terminal) || terminalChoices(os.platform())[0]);
// Worker permission mode: flag > meta.worker_mode > 'plan'. The lead session uses the same mode.
const workerMode = val("--worker-mode", (graph.meta && graph.meta.worker_mode) || "plan");

const ready = readyNodes(model);
const rec = recommendConcurrency(ready, graph, { reviewCeiling: Number(val("--review-ceiling", 5)), disk: probeDisk(graph) });
// Disk hard-block: auto-dialing handles the soft path (recommended >= 1), but when even ONE
// worktree won't fit, launching would fail mid-checkout — refuse before creating anything.
if (rec.disk && rec.disk.cap < 1) {
  diskBlockLines(rec.disk).forEach((l) => console.error(l));
  process.exit(1);
}
const cap = has("--cap") ? Number(val("--cap", rec.recommended)) : rec.recommended;

let waves;
try { ({ waves } = computeWaves(model, cap)); }
catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }

const fullWave = waves[waveIdx - 1] || [];
// Optional --track filter: a person fans out only their lane (slices whose `track` matches).
const wave = filterByTrack(fullWave, track);
if (!wave.length) {
  const trackNote = track ? ` on track ${track} (of ${fullWave.length} in the wave)` : "";
  console.error(`No runnable slices in wave ${waveIdx} (cap ${cap})${trackNote}.`);
  process.exit(0);
}

// claude invocation per session. Interactive workers START IN PLAN MODE (--permission-mode
// plan) so each plans its slice before touching anything; autonomous workers run headless.
function claudeCmd(node) {
  const prompt = launchPrompt(node);
  const base = autonomous
    ? `claude -p "${prompt}" --permission-mode acceptEdits`   // NOTE: confirm flag at build/test time
    : `claude --permission-mode ${workerMode} "${prompt}"`;
  const withLane = lane === "api"
    ? `ANTHROPIC_API_KEY="$ROADMAP_API_KEY" ${base}`     // api overflow lane (rarely used)
    : base;                                                    // max: inherit the logged-in subscription
  return withLane;
}

const repoRoot = process.cwd();

// ── adapters ─────────────────────────────────────────────────────────────────
function tmuxScript() {
  const session = "roadmap";
  const L = [];
  L.push(`#!/usr/bin/env bash`);
  L.push(`# roadmap fanout — wave ${waveIdx}, cap ${cap}, ${wave.length} slice(s), terminal=tmux, lane=${lane}, ${autonomous ? "autonomous" : "interactive"}`);
  L.push(`set -euo pipefail`);
  L.push(`git fetch ${remoteOf(graph)} --quiet`);
  L.push(``);
  L.push(`# 1) one worktree + uncommitted kickoff brief per slice`);
  for (const n of wave) {
    L.push(...bashWorktreeLines(worktreeFor(n, graph), branchFor(n, graph), baseRefOf(graph), synthesizeBrief(n, graph)));
  }
  L.push(``);
  L.push(`# 2) tmux: lead pane (review/merge) + one pane per slice`);
  L.push(`tmux kill-session -t ${session} 2>/dev/null || true`);
  L.push(`tmux new-session -d -s ${session} -n wave${waveIdx} -c "${repoRoot}"`);
  L.push(`tmux set -g pane-border-status top 2>/dev/null || true`);
  L.push(`tmux select-pane -t ${session} -T "LEAD — review + merge PRs (workers never merge)"`);
  L.push(leadClaude
    ? `tmux send-keys -t ${session} 'claude --permission-mode ${workerMode} "${LEAD_PROMPT}"' C-m`
    : `tmux send-keys -t ${session} 'echo "LEAD pane - review + merge each slice PR as it lands. Workers do NOT merge."' C-m`);
  for (const n of wave) {
    const wt = worktreeFor(n, graph);
    L.push(`tmux split-window -t ${session} -c "${wt}"`);
    L.push(`tmux select-pane -t ${session} -T "${n.invoke}"`);
    L.push(`tmux send-keys -t ${session} '${claudeCmd(n)}' C-m`);
    L.push(`tmux select-layout -t ${session} tiled >/dev/null`);
  }
  L.push(`tmux select-layout -t ${session} main-vertical`);
  L.push(`tmux attach -t ${session}`);
  return L.join("\n") + "\n";
}

function printCommands() {
  const out = [];
  out.push(`# fanout wave ${waveIdx} — cap ${cap}, ${wave.length} slice(s), lane=${lane}, ${autonomous ? "autonomous" : "interactive"}`);
  out.push(`git fetch ${remoteOf(graph)} --quiet`);
  for (const n of wave) {
    out.push(`git worktree add "${worktreeFor(n, graph)}" -b "${branchFor(n, graph)}" ${baseRefOf(graph)}   # ${n.invoke}`);
    out.push(`(cd "${worktreeFor(n, graph)}" && ${claudeCmd(n)})`);
  }
  return out.join("\n") + "\n";
}

function basicTerminalScript(kind) {
  // warp / wt / background — minimal per-node launchers (full adapters are P3 polish).
  const out = [`# fanout wave ${waveIdx} via ${kind} (basic adapter)`];
  for (const n of wave) {
    const wt = worktreeFor(n, graph), cmd = claudeCmd(n);
    out.push(`git worktree add "${wt}" -b "${branchFor(n, graph)}" ${baseRefOf(graph)} 2>/dev/null || true   # ${n.invoke}`);
    if (kind === "wt") out.push(`wt new-tab --title "${n.invoke}" -d "${wt}" powershell -NoExit -Command '${cmd}'`);
    else if (kind === "warp") out.push(`# Warp: open a tab at ${wt} running: ${cmd}  (Warp launch-config adapter is P3)`);
    else out.push(`(cd "${wt}" && ${cmd}) &   # background`);
  }
  return out.join("\n") + "\n";
}

// claude invocation for a PowerShell tab (single-quote the prompt so the outer -Command "" needs no escaping).
// Interactive workers start in PLAN MODE; autonomous run headless.
function claudeCmdPwsh(node) {
  const prompt = launchPrompt(node);
  return autonomous ? `claude -p '${prompt}' --permission-mode acceptEdits` : `claude --permission-mode ${workerMode} '${prompt}'`;
}

// Windows Terminal adapter: a self-contained PowerShell script — worktree + brief per slice,
// then one `wt` window with a LEAD tab + one tab per slice (each cd'd into its worktree).
function wtScript() {
  const L = [];
  L.push(`# roadmap fanout — wave ${waveIdx}, cap ${cap}, ${wave.length} slice(s), terminal=wt, lane=${lane}, ${autonomous ? "autonomous" : "interactive"}`);
  if (lane === "api") L.push(`# note: --lane api is not yet wired for the wt adapter; using the logged-in (max) session.`);
  L.push(`$ErrorActionPreference = 'Continue'`);   // git writes progress to stderr; 'Stop' would abort on it
  L.push(`git fetch ${remoteOf(graph)} --quiet`);
  L.push(``);
  L.push(`# 1) one worktree + uncommitted kickoff brief per slice`);
  for (const n of wave) {
    L.push(...pwshWorktreeLines(worktreeFor(n, graph), branchFor(n, graph), baseRefOf(graph), synthesizeBrief(n, graph)));
  }
  L.push(``);
  L.push(`# 2) Windows Terminal: a LEAD tab + one tab per slice`);
  // ';' is wt's tab delimiter — it splits on ';' even inside quotes, so NEVER let one reach wt
  // inside a tab command (a ';' in a prompt would spawn bogus tabs). Replace with a comma.
  const wtSafe = (s) => s.replace(/;/g, ",");
  const lead = leadClaude
    ? `claude --permission-mode ${workerMode} '${LEAD_PROMPT}'`
    : `Write-Host 'LEAD tab - review + merge each slice PR as it lands. Workers do NOT merge.'`;
  const parts = [`new-tab --title "LEAD" -d "${repoRoot}" powershell -NoExit -Command "${wtSafe(lead)}"`];
  for (const n of wave) {
    parts.push(`new-tab --title "${n.invoke}" -d "${worktreeFor(n, graph)}" powershell -NoExit -Command "${wtSafe(claudeCmdPwsh(n))}"`);
  }
  // Launch via Start-Process so ShellExecute resolves the 'wt' App Execution Alias — bare `wt`
  // name-resolution fails from a non-interactive script (the alias is a 0-byte reparse point).
  // The full command line is a literal here-string (no quote-escaping); tabs are ';'-separated.
  L.push(`$wtArgs = @'`);
  L.push(parts.join(" ; "));
  L.push(`'@`);
  L.push(`Start-Process wt -ArgumentList $wtArgs`);
  return L.join("\n") + "\n";
}

// Warp adapter: Warp HAS a scriptable launch — the warp://tab_config/<name> deeplink
// (added 2026-05-18, the registered warp:// URI handler). So we set everything up
// (worktrees + briefs), write a Warp Tab Config (TOML) with a lead pane + one pane per slice,
// then fire the deeplink to open it — no manual keystroke.
const normPath = (p) => String(p).replace(/\\/g, "/");
function tomlSplit(id, split, children) {
  return `[[panes]]\nid = "${id}"\nsplit = "${split}"\nchildren = [${children.map((c) => `"${c}"`).join(", ")}]\n`;
}
function tomlLeaf(id, dir, cmd, focused) {
  // directory: single-quoted TOML literal (no escaping; Windows paths have no '). command:
  // double-quoted TOML basic string — claude/echo commands use only single quotes inside.
  // shell=powershell forces a WINDOWS shell so the pane's git matches the (Windows-created)
  // worktree — otherwise Warp's default shell (often WSL bash) reads the C:\ gitdir and fails.
  return `[[panes]]\nid = "${id}"\ntype = "terminal"\nshell = "powershell"\ndirectory = '${normPath(dir)}'\ncommands = ["${cmd}"]${focused ? `\nis_focused = true` : ""}\n`;
}
function warpTabConfigToml() {
  const ids = wave.map((_, i) => `s${i}`);
  const L = [`name = "roadmap-wave${waveIdx}"`, `color = "blue"`, ``];
  // lead on the left; slices stacked on the right (one pane each)
  L.push(tomlSplit("root", "horizontal", wave.length === 1 ? ["lead", "s0"] : ["lead", "slices"]));
  const leadCmd = leadClaude ? `claude --permission-mode ${workerMode} '${LEAD_PROMPT}'` : `echo 'LEAD - review + merge each slice PR; workers do NOT merge'`;
  L.push(tomlLeaf("lead", repoRoot, leadCmd, true));
  if (wave.length > 1) L.push(tomlSplit("slices", "vertical", ids));
  wave.forEach((n, i) => L.push(tomlLeaf(`s${i}`, worktreeFor(n, graph), claudeCmdPwsh(n), false)));
  return L.join("\n");
}
function warpScript() {
  const stem = `roadmap-wave${waveIdx}`;
  const L = [];
  L.push(`# roadmap fanout — wave ${waveIdx}, terminal=warp (Tab Config + warp://tab_config deeplink)`);
  L.push(`$ErrorActionPreference = 'Continue'`);   // git writes progress to stderr; 'Stop' would abort on it
  L.push(`git fetch ${remoteOf(graph)} --quiet`);
  L.push(``);
  L.push(`# 1) one worktree + uncommitted kickoff brief per slice`);
  for (const n of wave) {
    L.push(...pwshWorktreeLines(worktreeFor(n, graph), branchFor(n, graph), baseRefOf(graph), synthesizeBrief(n, graph)));
  }
  L.push(``);
  L.push(`# 2) write the Warp Tab Config, then open it via the warp:// deeplink`);
  L.push(`$cfgDir = Join-Path $env:APPDATA 'warp\\Warp\\data\\tab_configs'`);
  L.push(`New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null`);
  L.push(`Set-Content -LiteralPath (Join-Path $cfgDir '${stem}.toml') -Encoding utf8 -Value @'`);
  L.push(warpTabConfigToml().trimEnd());
  L.push(`'@`);
  L.push(`Start-Process "warp://tab_config/${stem}?new_window=true"`);
  L.push(`Write-Host "Opened Warp tab config '${stem}' - lead + ${wave.length} slice pane(s)."`);
  return L.join("\n") + "\n";
}

// ── render the artifact ───────────────────────────────────────────────────────
let artifact;
if (term === "tmux") artifact = tmuxScript();
else if (term === "wt") artifact = wtScript();
else if (term === "warp") artifact = warpScript();
else if (term === "print") artifact = printCommands();
else artifact = basicTerminalScript(term);   // background

// PowerShell scripts (wt/warp) embed non-ASCII (briefs: → ✅ × §). Windows PowerShell reads
// -File as ANSI unless the file has a UTF-8 BOM — so write those with a BOM. bash (tmux) must NOT
// get a BOM (it would break the shebang).
const psScript = term === "wt" || term === "warp";
const withBom = (s) => (psScript ? "﻿" : "") + s;

// Launch is the DEFAULT (interactive). --dry/--out preview; autonomous needs the double-ack.
const decision = launchDecision({ dry, out: outFile, autonomous, okAutonomous });

console.error(`fanout: wave ${waveIdx}/${waves.length} · cap ${cap} (recommended ${rec.recommended}, bound by ${rec.binding.why.split(" — ")[0]}) · term=${term} · lane=${lane}${track ? ` · track=${track}` : ""} · ${decision.mode}`);
console.error(`slices: ${wave.map((n) => n.invoke).join(", ")}`);

if (outFile) {
  writeFileSync(outFile, withBom(artifact), "utf8");
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
if (term === "tmux" || term === "background") {
  if (term === "tmux" && !commandExists("tmux")) {
    process.stdout.write(artifact);
    console.error(`\n⚠ tmux not found on PATH from here (are you in PowerShell? tmux lives in WSL).`);
    console.error(`  Above is the launch script. Run it in a tmux-capable shell, e.g.:`);
    console.error(`    roadmap fan --wave ${waveIdx} --out wave${waveIdx}.sh   # then, in WSL:  bash wave${waveIdx}.sh`);
    process.exit(0);
  }
  const p = spawn("bash", ["-c", artifact], { stdio: "inherit" });
  p.on("exit", (code) => process.exit(code ?? 0));
} else if (term === "wt" || term === "warp") {
  // Both run a PowerShell script. wt opens the tabs directly; warp writes a launch config
  // (no scriptable launch) + prints the one-keystroke open instruction.
  if (term === "wt" && !commandExistsWin("wt")) {
    process.stdout.write(artifact);
    console.error(`\n⚠ Windows Terminal (wt) not found. Above is the PowerShell launch script —`);
    console.error(`  install Windows Terminal, or 'roadmap fan --out wave${waveIdx}.ps1' and run it yourself.`);
    process.exit(0);
  }
  const tmp = join(os.tmpdir(), `roadmap-wave${waveIdx}.ps1`);
  writeFileSync(tmp, withBom(artifact), "utf8");
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], { stdio: "inherit" });
  p.on("exit", (code) => process.exit(code ?? 0));
} else {
  // print / background → just print
  process.stdout.write(artifact);
}

function commandExists(bin) {
  try { return spawnSync("bash", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0; }
  catch { return false; }
}
function commandExistsWin(bin) {
  // `where`/`Get-Command` miss Store App Execution Aliases (e.g. wt.exe lives in
  // %LOCALAPPDATA%\Microsoft\WindowsApps and is a reparse point), so also Test-Path it.
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { exit 0 }; if (Test-Path (Join-Path $env:LOCALAPPDATA ('Microsoft\\WindowsApps\\${bin}.exe'))) { exit 0 }; exit 1`],
      { stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}
