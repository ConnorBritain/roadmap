#!/usr/bin/env node
// roadmap grab <backlog-id> — launch ONE backlog item in its own worktree + session.
// The single-target sibling of `fan`: worktree <root>/backlog-<id>, branch backlog/<id>,
// a synthesized .kickoff.md (the item's prompt embedded verbatim), one terminal target.
// Marks the item in_progress on launch (not on --dry).
//
// Usage: node grab.mjs <id> [--term wt|tmux|print] [--dry] [--worker-mode m]

import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { loadGraph } from "./lib/graph.mjs";
import { loadBacklog, mutateBacklog } from "./lib/store.mjs";
import { backlogItemToNode, setItemFields } from "./lib/backlog-core.mjs";
import { synthesizeBrief, branchFor, worktreeFor, launchPrompt, baseRefOf, remoteOf } from "./lib/brief.mjs";
import { probeDisk } from "./lib/recommend.mjs";
import { bashWorktreeLines, pwshWorktreeLines, diskBlockLines } from "./lib/fanout-core.mjs";
import { terminalChoices } from "./lib/wizard-core.mjs";

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const id = args.find((a) => !a.startsWith("-"));
const dry = args.includes("--dry");

if (!id) { console.error("usage: roadmap grab <backlog-id> [--term wt|tmux|print] [--dry] [--worker-mode m]"); process.exit(2); }

const backlog = loadBacklog(process.cwd());
if (!backlog) { console.error("✗ no docs/roadmap/backlog.yaml — capture something first ('roadmap backlog add')"); process.exit(1); }
const item = (backlog.items || []).find((it) => it.id === id);
if (!item) {
  const open = (backlog.items || []).filter((it) => it.status === "open" || it.status === "in_progress").map((it) => it.id);
  console.error(`✗ no backlog item "${id}". Open items:\n  ${open.join("\n  ") || "(none)"}`);
  process.exit(1);
}
if (item.status !== "open" && item.status !== "in_progress") {
  console.error(`✗ backlog item "${id}" is ${item.status} — only open/in_progress items launch`);
  process.exit(1);
}

const graph = loadGraph("docs/roadmap/roadmap.yaml");

// Disk hard-block (skipped on --dry: previewing costs nothing).
if (!dry) {
  const disk = probeDisk(graph);
  if (disk && disk.freeGb - 2 < disk.perWorktreeGb) {
    diskBlockLines(disk).forEach((l) => console.error(l));
    process.exit(1);
  }
}

const node = backlogItemToNode(item);
const term = val("--term", (graph.meta && graph.meta.terminal) || terminalChoices(os.platform())[0]);
const workerMode = val("--worker-mode", (graph.meta && graph.meta.worker_mode) || "plan");
const wt = worktreeFor(node, graph);
const br = branchFor(node, graph);
const brief = synthesizeBrief(node, graph).trimEnd();
const claudeCmd = (q) => `claude --permission-mode ${workerMode} ${q}${launchPrompt(node)}${q}`;

let script;
if (term === "tmux") {
  script = [
    `#!/usr/bin/env bash`,
    `# roadmap grab — ${id} (${item.kind}), terminal=tmux`,
    `set -euo pipefail`,
    `git fetch ${remoteOf(graph)} --quiet`,
    ...bashWorktreeLines(wt, br, baseRefOf(graph), brief),
    `tmux new-window -c "${wt}" -n "${id}" '${claudeCmd('"')}' 2>/dev/null || tmux new-session -s "grab-${id}" -c "${wt}" '${claudeCmd('"')}'`,
  ].join("\n") + "\n";
} else if (term === "wt") {
  script = [
    `# roadmap grab — ${id} (${item.kind}), terminal=wt`,
    `$ErrorActionPreference = 'Continue'`,
    `git fetch ${remoteOf(graph)} --quiet`,
    ...pwshWorktreeLines(wt, br, baseRefOf(graph), brief),
    // ';' is wt's tab delimiter even inside quotes — the launch prompt contains none, keep it that way.
    `Start-Process wt -ArgumentList 'new-tab --title "${id}" -d "${wt}" powershell -NoExit -Command "${claudeCmd("'")}"'`,
  ].join("\n") + "\n";
} else {
  script = [
    `# roadmap grab — ${id} (${item.kind})`,
    `git fetch ${remoteOf(graph)} --quiet`,
    `git worktree add "${wt}" -b "${br}" ${baseRefOf(graph)}`,
    `# write ${wt}/.kickoff.md (brief below), then:`,
    `(cd "${wt}" && ${claudeCmd('"')})`,
    ``,
    `# --- .kickoff.md ---`,
    brief,
  ].join("\n") + "\n";
}

console.error(`grab: ${id} (${item.kind}) · branch ${br} · worktree ${wt} · term=${term} · ${dry ? "dry" : "launch"}`);

if (dry || term === "print") {
  process.stdout.write(script);
  if (dry) console.error(`\n(--dry — nothing spawned. Drop --dry to launch.)`);
  process.exit(0);
}

if (term === "tmux") {
  const p = spawn("bash", ["-c", script], { stdio: "inherit" });
  p.on("exit", (code) => { if ((code ?? 0) === 0) markInProgress(); process.exit(code ?? 0); });
} else {
  // wt: PowerShell script with a UTF-8 BOM (briefs contain non-ASCII).
  const tmp = join(os.tmpdir(), `roadmap-grab-${id}.ps1`);
  writeFileSync(tmp, "﻿" + script, "utf8");
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], { stdio: "inherit" });
  p.on("exit", (code) => { if ((code ?? 0) === 0) markInProgress(); process.exit(code ?? 0); });
}

function markInProgress() {
  if (item.status === "in_progress") return;
  try {
    mutateBacklog(process.cwd(), (doc) => setItemFields(doc, { id, fields: { status: "in_progress" } }));
    console.error(`✓ ${id} marked in_progress`);
  } catch (e) {
    console.error(`⚠ launched, but couldn't mark ${id} in_progress: ${e.message}`);
  }
}
