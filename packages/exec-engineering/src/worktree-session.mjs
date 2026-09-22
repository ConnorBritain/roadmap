// roadmap — the worktree-session Executor (engineering). A slice is worked by a terminal session
// running in its own git worktree on its own branch, kicked off from an uncommitted .kickoff.md.
// This module owns the wave planner, the launch-script renderers (tmux / wt / warp / print /
// background), the single-target grab, worktree pruning, and the Executor facade over them.
// The CLIs in scripts/{fanout,grab,cleanup}.mjs are thin argv shells over these functions.
//
// SAFETY: every renderer is pure (string out). Spawning happens only in spawnLaunchScript /
// launchWave when the launch decision says so; opts.dry never spawns.

import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { join, resolve, sep } from "node:path";
import { flatten, computeWaves, readyNodes, coherenceEnabled } from "@connorbritain/roadmap-core/graph.mjs";
import { loadBacklog, mutateBacklog } from "@connorbritain/roadmap-core/store.mjs";
import { backlogItemToNode, setItemFields } from "@connorbritain/roadmap-core/backlog-core.mjs";
import { filterByTrack } from "@connorbritain/roadmap-core/execution.mjs";
import { recommendConcurrency, probeDisk, probeReviewDebt } from "./recommend.mjs";
import { synthesizeBrief, branchFor, worktreeFor, launchPrompt, baseRefOf, remoteOf, agentCmdFor } from "./brief.mjs";
import { bashWorktreeLines, pwshWorktreeLines, diskBlockLines } from "./fanout-core.mjs";
import { terminalChoices } from "./wizard-core.mjs";
import { readLocalConfig, resolveProfile, commandFor, launchDecisionForProfile } from "./assistant-core.mjs";
import { engineeringPlanContext } from "./plan-engineering.mjs";
import { engineeringScope } from "./scoper.mjs";
import { worktrees } from "./external-state.mjs";

// The lead pane's claude prompt (only with --lead-claude). It coordinates; it cannot see the
// workers' context (separate processes) but observes their PRs/branches and merges.
export const LEAD_PROMPT = "You are the LEAD for this fanout wave. The other panes are independent worker sessions - each owns one slice in its own git worktree and opens a PR. You cannot see their context, but you can observe their work: run gh pr list to see PRs, use git to inspect branches and worktrees, and review then merge each PR in dependency order as it lands. Only you merge - workers never do. Do not write slice code yourself.";

export const TERMINALS = ["tmux", "wt", "warp", "print", "background"];

// ── launch settings ───────────────────────────────────────────────────────────
// Resolve the per-launch settings from flags + meta + the local assistant config. Terminal
// default is platform-aware (no machine-specifics in the committed YAML): Windows → Windows
// Terminal tabs; elsewhere → tmux panes. Worker permission mode: flag > meta.worker_mode > plan.
export function launchSettings(graph, opts = {}) {
  const root = opts.root || process.cwd();
  const meta = graph.meta || {};
  const term = opts.term || meta.terminal || terminalChoices(opts.platform || os.platform())[0];
  const workerMode = opts.workerMode || meta.worker_mode || "plan";
  const { config: localConfig } = opts.localConfig ? { config: opts.localConfig } : readLocalConfig(root);
  const profile = resolveProfile(graph, localConfig, opts.assistant || null);
  return {
    root, term, workerMode, profile,
    lane: opts.lane || "max",                    // max (subscription) | api (ANTHROPIC_API_KEY)
    autonomous: !!opts.autonomous,               // headless claude -p (else interactive, watchable)
    leadClaude: !!opts.leadClaude,               // launch claude in the lead pane (else a shell)
  };
}

// claude invocation per session. Interactive workers START IN PLAN MODE (--permission-mode
// plan) so each plans its slice before touching anything; autonomous workers run headless.
export function workerCmd(node, graph, s) {
  const prompt = launchPrompt(node);
  if (s.profile.name === "manual") return `echo "${node.invoke}: worktree and .kickoff.md ready; start your configured assistant here."`;
  // meta.agent_cmd remains the legacy Claude compatibility path. New local profiles win.
  const base = s.profile.command
    ? commandFor(s.profile, { prompt, mode: s.autonomous ? "acceptEdits" : s.workerMode })
    : agentCmdFor(graph, { prompt, mode: s.workerMode });
  return s.lane === "api"
    ? `ANTHROPIC_API_KEY="$ROADMAP_API_KEY" ${base}`     // api overflow lane (rarely used)
    : base;                                                    // max: inherit the logged-in subscription
}

// claude invocation for a PowerShell tab (single-quote the prompt so the outer -Command "" needs no escaping).
export function workerCmdPwsh(node, graph, s) {
  const prompt = launchPrompt(node);
  if (s.profile.name === "manual") return `Write-Host '${node.invoke}: worktree and .kickoff.md ready; start your configured assistant here.'`;
  return s.profile.command
    ? commandFor(s.profile, { prompt, mode: s.autonomous ? "acceptEdits" : s.workerMode })
    : agentCmdFor(graph, { prompt, mode: s.workerMode, quote: "'" });
}

// ── wave planning ─────────────────────────────────────────────────────────────
// Compute the wave to launch: the ready set, the ceiling recommendation (auto-cap unless
// opts.cap), the waves, and the (optionally track-filtered) wave. Returns { blocked: "disk" }
// when even ONE worktree won't fit — launching would fail mid-checkout, so refuse before
// creating anything. Probes (disk / review debt) are injectable for tests.
export function planWave(graph, opts = {}) {
  const root = opts.root || process.cwd();
  if (opts.worktreeRoot) (graph.meta ||= {}).worktree_root = opts.worktreeRoot;
  const model = flatten(graph);
  const ready = readyNodes(model);
  const rec = recommendConcurrency(ready, graph, {
    reviewCeiling: opts.reviewCeiling ?? 5,
    reviewDebt: opts.reviewDebt !== undefined ? opts.reviewDebt : probeReviewDebt(root, graph),
    today: opts.today || new Date().toISOString().slice(0, 10),
    disk: opts.disk !== undefined ? opts.disk : probeDisk(graph, root),
    sys: opts.sys,
  });
  if (rec.disk && rec.disk.cap < 1) return { blocked: "disk", disk: rec.disk, rec, lines: diskBlockLines(rec.disk) };
  const cap = opts.cap != null ? Number(opts.cap) : rec.recommended;
  const waveIdx = Number(opts.wave || 1);
  const { waves } = computeWaves(model, cap, { coherence: coherenceEnabled(graph.meta) });
  const fullWave = waves[waveIdx - 1] || [];
  const track = opts.track || null;
  const wave = filterByTrack(fullWave, track);   // a person fans out only their lane
  return { graph, model, ready, rec, cap, waves, waveIdx, fullWave, wave, track, root };
}

// ── renderers (pure) ──────────────────────────────────────────────────────────
function tmuxScript(p, s) {
  const { graph, wave, waveIdx, cap } = p;
  const session = "roadmap";
  const L = [];
  L.push(`#!/usr/bin/env bash`);
  L.push(`# roadmap fanout — wave ${waveIdx}, cap ${cap}, ${wave.length} slice(s), terminal=tmux, lane=${s.lane}, ${s.autonomous ? "autonomous" : "interactive"}`);
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
  L.push(`tmux new-session -d -s ${session} -n wave${waveIdx} -c "${s.root}"`);
  L.push(`tmux set -g pane-border-status top 2>/dev/null || true`);
  L.push(`tmux select-pane -t ${session} -T "LEAD — review + merge PRs (workers never merge)"`);
  L.push(s.leadClaude
    ? `tmux send-keys -t ${session} '${agentCmdFor(graph, { prompt: LEAD_PROMPT, mode: s.workerMode })}' C-m`
    : `tmux send-keys -t ${session} 'echo "LEAD pane - review + merge each slice PR as it lands. Workers do NOT merge."' C-m`);
  for (const n of wave) {
    const wt = worktreeFor(n, graph);
    L.push(`tmux split-window -t ${session} -c "${wt}"`);
    L.push(`tmux select-pane -t ${session} -T "${n.invoke}"`);
    L.push(`tmux send-keys -t ${session} '${workerCmd(n, graph, s)}' C-m`);
    L.push(`tmux select-layout -t ${session} tiled >/dev/null`);
  }
  L.push(`tmux select-layout -t ${session} main-vertical`);
  L.push(`tmux attach -t ${session}`);
  return L.join("\n") + "\n";
}

function printCommands(p, s) {
  const { graph, wave, waveIdx, cap } = p;
  const out = [];
  out.push(`# fanout wave ${waveIdx} — cap ${cap}, ${wave.length} slice(s), lane=${s.lane}, ${s.autonomous ? "autonomous" : "interactive"}`);
  out.push(`git fetch ${remoteOf(graph)} --quiet`);
  for (const n of wave) {
    out.push(`git worktree add "${worktreeFor(n, graph)}" -b "${branchFor(n, graph)}" ${baseRefOf(graph)}   # ${n.invoke}`);
    out.push(`(cd "${worktreeFor(n, graph)}" && ${workerCmd(n, graph, s)})`);
  }
  return out.join("\n") + "\n";
}

function basicTerminalScript(p, s, kind) {
  // background (and any unknown kind) — minimal per-node launchers.
  const { graph, wave, waveIdx } = p;
  const out = [`# fanout wave ${waveIdx} via ${kind} (basic adapter)`];
  for (const n of wave) {
    const wt = worktreeFor(n, graph), cmd = workerCmd(n, graph, s);
    out.push(`git worktree add "${wt}" -b "${branchFor(n, graph)}" ${baseRefOf(graph)} 2>/dev/null || true   # ${n.invoke}`);
    if (kind === "wt") out.push(`wt new-tab --title "${n.invoke}" -d "${wt}" powershell -NoExit -Command '${cmd}'`);
    else if (kind === "warp") out.push(`# Warp: open a tab at ${wt} running: ${cmd}  (Warp launch-config adapter is P3)`);
    else out.push(`(cd "${wt}" && ${cmd}) &   # background`);
  }
  return out.join("\n") + "\n";
}

// Windows Terminal adapter: a self-contained PowerShell script — worktree + brief per slice,
// then one `wt` window with a LEAD tab + one tab per slice (each cd'd into its worktree).
function wtScript(p, s) {
  const { graph, wave, waveIdx, cap } = p;
  const L = [];
  L.push(`# roadmap fanout — wave ${waveIdx}, cap ${cap}, ${wave.length} slice(s), terminal=wt, lane=${s.lane}, ${s.autonomous ? "autonomous" : "interactive"}`);
  if (s.lane === "api") L.push(`# note: --lane api is not yet wired for the wt adapter; using the logged-in (max) session.`);
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
  const wtSafe = (x) => x.replace(/;/g, ",");
  const lead = s.leadClaude
    ? agentCmdFor(graph, { prompt: LEAD_PROMPT, mode: s.workerMode, quote: "'" })
    : `Write-Host 'LEAD tab - review + merge each slice PR as it lands. Workers do NOT merge.'`;
  const parts = [`new-tab --title "LEAD" -d "${s.root}" powershell -NoExit -Command "${wtSafe(lead)}"`];
  for (const n of wave) {
    parts.push(`new-tab --title "${n.invoke}" -d "${worktreeFor(n, graph)}" powershell -NoExit -Command "${wtSafe(workerCmdPwsh(n, graph, s))}"`);
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

// Warp adapter: Warp HAS a scriptable launch — the warp://tab_config/<name> deeplink. Set
// everything up (worktrees + briefs), write a Warp Tab Config (TOML) with a lead pane + one
// pane per slice, then fire the deeplink to open it — no manual keystroke.
const normPath = (x) => String(x).replace(/\\/g, "/");
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
export function warpTabConfigToml(p, s) {
  const { graph, wave, waveIdx } = p;
  const ids = wave.map((_, i) => `s${i}`);
  const L = [`name = "roadmap-wave${waveIdx}"`, `color = "blue"`, ``];
  // lead on the left; slices stacked on the right (one pane each)
  L.push(tomlSplit("root", "horizontal", wave.length === 1 ? ["lead", "s0"] : ["lead", "slices"]));
  const leadCmd = s.leadClaude ? agentCmdFor(graph, { prompt: LEAD_PROMPT, mode: s.workerMode, quote: "'" }) : `echo 'LEAD - review + merge each slice PR; workers do NOT merge'`;
  L.push(tomlLeaf("lead", s.root, leadCmd, true));
  if (wave.length > 1) L.push(tomlSplit("slices", "vertical", ids));
  wave.forEach((n, i) => L.push(tomlLeaf(`s${i}`, worktreeFor(n, graph), workerCmdPwsh(n, graph, s), false)));
  return L.join("\n");
}
function warpScript(p, s) {
  const { graph, wave, waveIdx } = p;
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
  L.push(warpTabConfigToml(p, s).trimEnd());
  L.push(`'@`);
  L.push(`Start-Process "warp://tab_config/${stem}?new_window=true"`);
  L.push(`Write-Host "Opened Warp tab config '${stem}' - lead + ${wave.length} slice pane(s)."`);
  return L.join("\n") + "\n";
}

// The launch artifact for a planned wave under the given terminal adapter (pure).
export function renderWaveScript(plan, settings) {
  const term = settings.term;
  if (term === "tmux") return tmuxScript(plan, settings);
  if (term === "wt") return wtScript(plan, settings);
  if (term === "warp") return warpScript(plan, settings);
  if (term === "print") return printCommands(plan, settings);
  return basicTerminalScript(plan, settings, term);   // background
}

// A single-target launch script (grab, and the Executor's per-slice launch): one worktree, one
// kickoff brief, one terminal target. `header` is the script's first comment line.
export function renderSingleScript(node, graph, s, { header, label = node.invoke } = {}) {
  const wt = worktreeFor(node, graph);
  const br = branchFor(node, graph);
  const brief = synthesizeBrief(node, graph).trimEnd();
  const cmd = (q) => agentCmdFor(graph, { prompt: launchPrompt(node), mode: s.workerMode, quote: q });
  if (s.term === "tmux") {
    return [
      `#!/usr/bin/env bash`,
      `${header}, terminal=tmux`,
      `set -euo pipefail`,
      `git fetch ${remoteOf(graph)} --quiet`,
      ...bashWorktreeLines(wt, br, baseRefOf(graph), brief),
      `tmux new-window -c "${wt}" -n "${label}" '${cmd('"')}' 2>/dev/null || tmux new-session -s "grab-${label}" -c "${wt}" '${cmd('"')}'`,
    ].join("\n") + "\n";
  }
  if (s.term === "wt") {
    return [
      `${header}, terminal=wt`,
      `$ErrorActionPreference = 'Continue'`,
      `git fetch ${remoteOf(graph)} --quiet`,
      ...pwshWorktreeLines(wt, br, baseRefOf(graph), brief),
      // ';' is wt's tab delimiter even inside quotes — the launch prompt contains none, keep it that way.
      `Start-Process wt -ArgumentList 'new-tab --title "${label}" -d "${wt}" powershell -NoExit -Command "${cmd("'")}"'`,
    ].join("\n") + "\n";
  }
  return [
    header,
    `git fetch ${remoteOf(graph)} --quiet`,
    `git worktree add "${wt}" -b "${br}" ${baseRefOf(graph)}`,
    `# write ${wt}/.kickoff.md (brief below), then:`,
    `(cd "${wt}" && ${cmd('"')})`,
    ``,
    `# --- .kickoff.md ---`,
    brief,
  ].join("\n") + "\n";
}

// PowerShell scripts (wt/warp) embed non-ASCII (briefs: → ✅ × §). Windows PowerShell reads
// -File as ANSI unless the file has a UTF-8 BOM — so write those with a BOM. bash (tmux) must NOT
// get a BOM (it would break the shebang).
export const isPwshTerm = (term) => term === "wt" || term === "warp";
export const withBom = (term, text) => (isPwshTerm(term) ? "\uFEFF" : "") + text;

// ── launch decision ───────────────────────────────────────────────────────────
// Manual is the default. A locally authorized profile plus --launch is required to spawn.
export function waveLaunchDecision(settings, { outFile = null, dry = false, requestedLaunch = false, okAutonomous = false } = {}) {
  let decision = outFile ? { spawn: false, mode: "wrote-script" } : dry ? { spawn: false, mode: "dry" }
    : launchDecisionForProfile(settings.profile, { requestedLaunch, autonomous: settings.autonomous });
  if (settings.autonomous && decision.spawn && !okAutonomous) decision = { spawn: false, mode: "autonomous-needs-ack" };
  return decision;
}

// The one-line wave summary the CLI prints to stderr.
export function waveSummaryLine(plan, settings, decision) {
  const { rec, cap, waveIdx, waves, track } = plan;
  return `fanout: wave ${waveIdx}/${waves.length} · cap ${cap} (recommended ${rec.recommended}, bound by ${rec.binding.why.split(" — ")[0]}) · term=${settings.term} · lane=${settings.lane}${track ? ` · track=${track}` : ""} · ${decision.mode}`;
}

// ── spawning ──────────────────────────────────────────────────────────────────
export function commandExists(bin, execImpl = spawnSync) {
  try { return execImpl("bash", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0; }
  catch { return false; }
}
export function commandExistsWin(bin, execImpl = spawnSync) {
  // `where`/`Get-Command` miss Store App Execution Aliases (e.g. wt.exe lives in
  // %LOCALAPPDATA%\Microsoft\WindowsApps and is a reparse point), so also Test-Path it.
  try {
    const r = execImpl("powershell.exe", ["-NoProfile", "-Command",
      `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { exit 0 }; if (Test-Path (Join-Path $env:LOCALAPPDATA ('Microsoft\\WindowsApps\\${bin}.exe'))) { exit 0 }; exit 1`],
      { stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}

// Run a rendered launch script: bash for tmux/background, a BOM'd temp .ps1 for wt/warp.
// Resolves with the child's exit code. `tmpName` names the temp PowerShell file.
export function spawnLaunchScript(script, { term, tmpName = "roadmap-launch", spawnImpl = spawn, tmpDir = os.tmpdir() }) {
  return new Promise((resolveP) => {
    let p;
    if (isPwshTerm(term)) {
      const tmp = join(tmpDir, `${tmpName}.ps1`);
      writeFileSync(tmp, withBom(term, script), "utf8");
      p = spawnImpl("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], { stdio: "inherit" });
    } else {
      p = spawnImpl("bash", ["-c", script], { stdio: "inherit" });
    }
    p.on("exit", (code) => resolveP(code ?? 0));
  });
}

// ── grab: one backlog item ────────────────────────────────────────────────────
// Plan a single backlog item's launch. Returns { error, code } for a refused item, else the
// rendered script plus what the CLI prints. Disk hard-block is skipped on dry (previewing costs nothing).
export function planGrab(root, graph, id, opts = {}) {
  const backlog = opts.backlog !== undefined ? opts.backlog : loadBacklog(root);
  if (!backlog) return { error: "✗ no docs/roadmap/backlog.yaml — capture something first ('roadmap backlog add')", code: 1 };
  const item = (backlog.items || []).find((it) => it.id === id);
  if (!item) {
    const open = (backlog.items || []).filter((it) => it.status === "open" || it.status === "in_progress").map((it) => it.id);
    return { error: `✗ no backlog item "${id}". Open items:\n  ${open.join("\n  ") || "(none)"}`, code: 1 };
  }
  if (item.status !== "open" && item.status !== "in_progress") {
    return { error: `✗ backlog item "${id}" is ${item.status} — only open/in_progress items launch`, code: 1 };
  }
  if (!opts.dry) {
    const disk = opts.disk !== undefined ? opts.disk : probeDisk(graph, root);
    if (disk && disk.freeGb - 2 < disk.perWorktreeGb) return { error: diskBlockLines(disk).join("\n"), code: 1 };
  }
  const node = backlogItemToNode(item);
  const s = launchSettings(graph, { root, term: opts.term, workerMode: opts.workerMode, platform: opts.platform, localConfig: opts.localConfig });
  const script = renderSingleScript(node, graph, s, { header: `# roadmap grab — ${id} (${item.kind})`, label: id });
  return { item, node, settings: s, script, wt: worktreeFor(node, graph), br: branchFor(node, graph) };
}

export function markBacklogInProgress(root, id) {
  mutateBacklog(root, (doc) => setItemFields(doc, { id, fields: { status: "in_progress" } }));
}

// ── cleanup: prune fanout worktrees ───────────────────────────────────────────
// Worktrees under the configured worktree_root whose branch is merged to <remote>/<base> and
// whose tree is clean. Dry unless `remove`; `force` includes unmerged/dirty. ONLY touches the
// fanout's own worktrees — never the main checkout or manual worktrees. Returns the plan, what
// was removed/kept, and the report lines the CLI prints.
export function pruneWorktrees(root, { remove = false, force = false, meta = {} } = {}, { execImpl = spawnSync } = {}) {
  const git = (...a) => execImpl("git", a, { cwd: root, encoding: "utf8" });
  const remote = meta.remote || "origin";
  const base = meta.base_branch || "main";
  const wtRoot = resolve(meta.worktree_root || resolve(root, "..", "_worktrees"));
  git("fetch", remote, "--quiet");
  const porcelain = (git("worktree", "list", "--porcelain").stdout || "").trim();
  const all = (porcelain ? porcelain.split(/\n\n+/) : []).map((b) => ({
    path: (b.match(/^worktree (.+)$/m) || [])[1],
    branch: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || null,
  })).filter((w) => w.path);
  const mergedOut = git("branch", "--merged", `${remote}/${base}`, "--format=%(refname:short)").stdout || "";
  const merged = new Set(mergedOut.split("\n").map((x) => x.trim()).filter(Boolean));
  const underRoot = (x) => { const rp = resolve(x); return rp === wtRoot || rp.startsWith(wtRoot + sep); };
  const candidates = all.filter((w) => underRoot(w.path));
  const lines = [];
  const out = { wtRoot, remote, base, plan: [], removed: [], kept: [], dry: !remove, lines, errors: [] };
  if (!candidates.length) { lines.push(`No fanout worktrees under ${wtRoot}.`); return out; }
  out.plan = candidates.map((w) => {
    const dirty = ((git("-C", w.path, "status", "--porcelain").stdout) || "").trim().length > 0;
    const isMerged = w.branch ? merged.has(w.branch) : false;
    return { ...w, dirty, isMerged, removable: isMerged && !dirty };
  });
  lines.push(`Fanout worktrees under ${wtRoot} (merged into ${remote}/${base}?):`);
  for (const p of out.plan) {
    const flags = `${p.isMerged ? "merged" : "UNMERGED"}, ${p.dirty ? "DIRTY" : "clean"}`;
    const action = (p.removable || force) ? (remove ? "→ removing" : "→ would remove") : "→ keep";
    lines.push(`  ${(p.branch || "(detached)").padEnd(40)} [${flags}]  ${action}`);
    lines.push(`      ${p.path}`);
  }
  if (!remove) {
    out.kept = out.plan.map((p) => p.path);
    lines.push(`\n(dry — nothing removed. 'roadmap cleanup --remove' prunes merged+clean; add --force for unmerged/dirty.)`);
    return out;
  }
  for (const p of out.plan) {
    if (!(p.removable || force)) { out.kept.push(p.path); continue; }
    const rm = git("worktree", "remove", ...(p.dirty || !p.isMerged ? ["--force"] : []), p.path);
    if (rm.status !== 0) { out.errors.push(`  ✗ ${p.path}: ${(rm.stderr || "").trim()}`); out.kept.push(p.path); continue; }
    if (p.branch) git("branch", force ? "-D" : "-d", p.branch);
    lines.push(`  ✓ removed ${p.path}`);
    out.removed.push(p.path);
  }
  lines.push(`\nremoved ${out.removed.length} worktree(s).`);
  return out;
}

// ── the Executor ──────────────────────────────────────────────────────────────
// opts: { root, disk, reviewDebt, execImpl, files, localConfig, platform, spawnImpl } — the
// injectable probes; undefined means probe the real machine.
export function worktreeSessionExecutor(opts = {}) {
  const root = opts.root || process.cwd();
  const name = "worktree-session";
  const probes = () => ({ disk: opts.disk, reviewDebt: opts.reviewDebt, cwd: root });
  const settingsFor = (graph, launch = {}) => launchSettings(graph, {
    root, term: launch.term, workerMode: launch.workerMode, assistant: launch.assistant, lane: launch.lane,
    autonomous: launch.autonomous, leadClaude: launch.leadClaude, platform: opts.platform, localConfig: opts.localConfig,
  });
  const receiptFor = (slice, graph, w, dry = false) => ({
    key: `${name}:${slice.invoke}:${branchFor(slice, graph)}`, executor: name, slice: slice.invoke,
    artifactRef: branchFor(slice, graph), worktree: w ? w.path : worktreeFor(slice, graph),
    started_at: (w && w.started_at) || new Date().toISOString(), dry,
    ...(w ? { evidence: { merged: w.isMerged, dirty: w.dirty } } : {}),
  });
  const findWorktree = (slice, graph) => {
    const br = branchFor(slice, graph);
    return worktrees(root, graph.meta || {}).find((w) => w.branch === br) || null;
  };
  return {
    name,
    capabilities() { return { concurrent: true, artifactKinds: ["github-pr"], gateKind: "command" }; },
    scope(slice, ctx = {}) { return engineeringScope(slice, ctx.graph, { root: ctx.root || root, files: opts.files, execImpl: opts.execImpl }); },
    capacity(graph, ctx = {}) {
      const { capacity } = engineeringPlanContext(probes());
      return capacity(readyNodes(flatten(graph)), graph, { reviewCeiling: ctx.reviewCeiling, today: ctx.today, useFree: ctx.useFree });
    },
    annotate(node, graph) { return engineeringPlanContext(probes()).annotate(node, graph); },
    async launch(slice, launch = {}, ctx = {}) {
      const graph = ctx.graph;
      const existing = findWorktree(slice, graph);
      if (existing) return receiptFor(slice, graph, existing);   // idempotent: already checked out
      const s = settingsFor(graph, launch);
      const script = renderSingleScript(slice, graph, s, { header: `# roadmap launch — ${slice.invoke}` });
      const receipt = { ...receiptFor(slice, graph, null, !!launch.dry), term: s.term, script };
      if (launch.dry) return receipt;
      const code = await spawnLaunchScript(script, { term: s.term, tmpName: `roadmap-launch-${slice.invoke}`, spawnImpl: opts.spawnImpl });
      if (code !== 0) throw new Error(`launch of ${slice.invoke} exited ${code}`);
      return receipt;
    },
    async status(slice, ctx = {}) {
      const w = findWorktree(slice, ctx.graph);
      if (!w) return { state: "idle", receipts: [], notes: [] };
      const r = receiptFor(slice, ctx.graph, w);
      return { state: w.isMerged ? "done" : "running", receipts: [r], artifactRef: r.artifactRef,
        notes: w.dirty ? ["worktree has uncommitted changes"] : [] };
    },
    async receipts(slice, ctx = {}) {
      const w = findWorktree(slice, ctx.graph);
      return w ? [receiptFor(slice, ctx.graph, w)] : [];
    },
    async cleanup(c = {}, ctx = {}) {
      const r = pruneWorktrees(root, { remove: !!c.remove, force: !!c.force, meta: (ctx.graph && ctx.graph.meta) || ctx.meta || {} }, { execImpl: opts.execImpl });
      return { removed: r.removed, kept: r.kept, dry: r.dry, lines: r.lines, errors: r.errors };
    },
  };
}
