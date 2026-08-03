#!/usr/bin/env node
// roadmap init — bootstrap a repo's docs/roadmap files + local assistant config.
//
// Two modes:
//   Interactive (default, TTY only) — walks the user through program name,
//     first PI, first sprint, assistant, and whether to scaffold backlog +
//     local config. Previews all writes, confirms once, writes atomically.
//   Non-interactive (--yes, or any non-TTY) — writes the shape from
//     --program / --assistant / --backlog / --local flags (all optional;
//     defaults are the same the interactive mode would suggest).
//
// Design intent (Firebase-style): the FIRST run is the demo. A new user
// types `roadmap init` in a fresh repo, sees clear prompts, gets a working
// roadmap they can validate + render immediately. No prior knowledge, no
// docs required, no risk of an unintended write (--yes is only used for CI).
//
// The pure logic lives in lib/init-core.mjs (planInit, renderers,
// validators). This file is the IO shell — fs writes, TTY detection, and
// the interactive prompt orchestration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOCAL_CONFIG_REL, BUILTIN_PROFILES } from "./lib/assistant-core.mjs";
import {
  BACKLOG_REL, LOCAL_REL, REL,
  appendToGitignore, planGitignore, planInit, suggestProgramName, validators,
} from "./lib/init-core.mjs";
import { select, confirm, text } from "./prompt.mjs";

const S = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};

const root = process.cwd();
const args = process.argv.slice(2);
const has = (v) => args.includes(v);
const value = (v, d = null) => { const i = args.indexOf(v); return i >= 0 ? args[i + 1] || d : d; };

// The CLI parser bounces on --interactive being an alias for the default,
// so it only exists to force the interactive path in a non-TTY (mostly for
// tests that pipe answers through stdin).
const forceInteractive = has("--interactive");
const forceNonInteractive = has("--yes");
const isTTY = process.stdin.isTTY && process.stdout.isTTY;

const useInteractive = forceInteractive || (isTTY && !forceNonInteractive);

// The MCP-writer half of the old init lives further below and stays behind
// --client / --apply flags. It's out of the interactive walkthrough's scope
// on purpose: interactive should scaffold a working repo, not touch the
// user's Codex/Claude config the first time they invoke it.

if (useInteractive) {
  await interactiveInit();
} else {
  await nonInteractiveInit();
}

writeMcpConfigIfRequested();

// ── modes ────────────────────────────────────────────────────────────────

async function interactiveInit() {
  const repoNameHint = detectRepoName(root);
  const programDefault = suggestProgramName({ repoName: repoNameHint, cwdBasename: basename(root) });

  console.log("");
  console.log(`${S.bold}${S.cyan}roadmap init${S.reset}  ${S.dim}${root}${S.reset}`);
  if (repoNameHint) {
    console.log(`${S.dim}  detected repo: ${repoNameHint}${S.reset}`);
  }
  console.log("");

  const program = await text("Program name (slug)", {
    def: programDefault,
    validate: validators.slug,
  });
  const piTitle = await text("First initiative (PI) title", {
    def: "Foundations",
    validate: validators.title,
  });
  const sprintTitle = await text("First sprint title", {
    def: "Bootstrap the roadmap",
    validate: validators.title,
  });

  const assistantChoices = Object.entries(BUILTIN_PROFILES).map(([id, profile]) => ({
    label: id,
    value: id,
    hint: describeAssistant(id, profile),
  }));
  const assistant = await select("AI assistant that drives fanout", assistantChoices, {
    defaultIdx: Math.max(0, assistantChoices.findIndex((c) => c.value === "manual")),
  });

  const withBacklog = await confirm("Also scaffold docs/roadmap/backlog.yaml (erratic-work tracker)?", true);
  const withLocal = await confirm(`Also scaffold ${LOCAL_REL.join("/")} (assistant config, gitignored)?`, true);

  const existingFiles = detectExistingFiles(root, { includeGitignore: true });
  const files = planInit({ program, piTitle, sprintTitle, assistant, withBacklog, withLocal }, { existingFiles });
  const gi = planGitignore({ currentText: readTextOrEmpty(join(root, ".gitignore")) });

  console.log("");
  console.log(`${S.bold}Preview${S.reset}`);
  for (const f of files) {
    const marker = f.action === "preserve" ? `${S.yellow}!${S.reset} preserve` : `${S.green}+${S.reset} create  `;
    console.log(`  ${marker} ${f.path}${f.action === "preserve" ? `  ${S.dim}(exists — leaving as-is)${S.reset}` : ""}`);
  }
  if (withLocal && gi.need) {
    console.log(`  ${S.green}+${S.reset} update  .gitignore  ${S.dim}(append '${gi.line}')${S.reset}`);
  }
  console.log("");

  const proceed = await confirm("Write these files now?", true);
  if (!proceed) {
    console.log(`${S.dim}Cancelled — no files changed.${S.reset}`);
    process.exit(0);
  }

  const result = writeBlueprint(root, files, { updateGitignore: withLocal && gi.need, ignoreLine: gi.line });
  reportWrite(result);
  console.log("");
  console.log(`${S.bold}${S.green}Done.${S.reset}  Next steps:`);
  console.log(`  ${S.cyan}roadmap validate${S.reset}       ${S.dim}structural check${S.reset}`);
  console.log(`  ${S.cyan}roadmap render${S.reset}         ${S.dim}generate docs/SLICES.md${withBacklog ? " + BACKLOG.md" : ""}${S.reset}`);
  console.log(`  ${S.cyan}roadmap${S.reset}                ${S.dim}interactive fanout console (in a TTY)${S.reset}`);
  if (assistant === "codex") {
    console.log("");
    console.log(`${S.dim}To wire the MCP server for Codex, run:${S.reset}  roadmap init --client codex --apply`);
  }
}

async function nonInteractiveInit() {
  const assistant = value("--assistant", "manual");
  if (!BUILTIN_PROFILES[assistant]) {
    console.error(`unknown assistant "${assistant}"; choose ${Object.keys(BUILTIN_PROFILES).join(", ")}`);
    process.exit(2);
  }
  const withBacklog = !has("--no-backlog");
  const withLocal = !has("--no-local") && (has("--yes") || has("--write-local"));
  const program = value("--program") || suggestProgramName({ repoName: detectRepoName(root), cwdBasename: basename(root) });
  const piTitle = value("--pi-title", "Foundations");
  const sprintTitle = value("--sprint-title", "Bootstrap the roadmap");

  const existingFiles = detectExistingFiles(root, { includeGitignore: true });
  const files = planInit({ program, piTitle, sprintTitle, assistant, withBacklog, withLocal }, { existingFiles });
  const gi = planGitignore({ currentText: readTextOrEmpty(join(root, ".gitignore")) });

  if (!has("--yes")) {
    // Preview-only (matches the pre-rewrite default). This is what a naive
    // `roadmap init` in a non-TTY (piped, CI) does — no destructive change
    // without --yes, ever.
    console.log("roadmap init preview");
    for (const f of files) console.log(`  ${f.action} ${f.path}`);
    if (withLocal && gi.need) console.log(`  update .gitignore  (append '${gi.line}')`);
    console.log("Re-run with --yes to write these files.");
    return;
  }
  const result = writeBlueprint(root, files, { updateGitignore: withLocal && gi.need, ignoreLine: gi.line });
  reportWrite(result);
}

// ── helpers ──────────────────────────────────────────────────────────────

function detectRepoName(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    if (r.status === 0 && r.stdout) return basename(r.stdout.trim());
  } catch { /* fall through */ }
  return null;
}

function detectExistingFiles(cwd, { includeGitignore = false } = {}) {
  const set = new Set();
  const check = (rel) => { if (existsSync(join(cwd, ...rel))) set.add(rel.join("/")); };
  check(REL);
  check(BACKLOG_REL);
  check(LOCAL_REL);
  if (includeGitignore && existsSync(join(cwd, ".gitignore"))) set.add(".gitignore");
  return set;
}

function readTextOrEmpty(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function writeBlueprint(cwd, files, { updateGitignore = false, ignoreLine = null } = {}) {
  const written = [];
  const preserved = [];
  for (const f of files) {
    if (f.action === "preserve") { preserved.push(f.path); continue; }
    const abs = join(cwd, ...f.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, "utf8");
    written.push(f.path);
  }
  let gitignoreUpdated = false;
  if (updateGitignore && ignoreLine) {
    const abs = join(cwd, ".gitignore");
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    writeFileSync(abs, appendToGitignore(current, ignoreLine), "utf8");
    gitignoreUpdated = true;
  }
  return { written, preserved, gitignoreUpdated };
}

function reportWrite({ written, preserved, gitignoreUpdated }) {
  for (const p of written) console.log(`${S.green}✓${S.reset} created  ${p}`);
  for (const p of preserved) console.log(`${S.yellow}!${S.reset} preserved ${p}  ${S.dim}(already existed)${S.reset}`);
  if (gitignoreUpdated) console.log(`${S.green}✓${S.reset} updated  .gitignore`);
}

function describeAssistant(id, profile) {
  const cmd = profile && profile.command;
  if (id === "manual") return "write commands yourself (no CLI dependency)";
  if (id === "claude") return "Claude Code" + (cmd ? "" : " (command auto-detected)");
  if (id === "codex") return "Codex CLI" + (cmd ? "" : " (command auto-detected)");
  return cmd ? `command: ${cmd}` : "";
}

// ── MCP writer (legacy flag path, preserved) ─────────────────────────────
// The interactive walkthrough deliberately does NOT touch the user's Codex
// or Claude config — those are personal settings, and a first-run init
// should scaffold this repo, not modify the machine. `roadmap init --client
// codex --apply` remains for users who want that step done for them.

function writeMcpConfigIfRequested() {
  const client = value("--client", value("--assistant") === "codex" ? "codex" : null);
  if (!client) return;
  const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "mcp.mjs");
  if (client === "codex") {
    const codexConfig = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
    const section = `[mcp_servers.roadmap]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcpPath)}]\n\n[mcp_servers.roadmap.env]\nCODEX_PROJECT_DIR = ${JSON.stringify(root)}\n`;
    console.log(`\nCodex MCP preview (${codexConfig}):\n${section}`);
    if (has("--apply")) {
      const current = existsSync(codexConfig) ? readFileSync(codexConfig, "utf8") : "";
      if (current.includes("[mcp_servers.roadmap]")) console.log("Codex MCP entry already exists; no change made.");
      else { writeFileSync(codexConfig, `${current.trimEnd()}\n\n${section}`, "utf8"); console.log(`applied Codex MCP entry to ${codexConfig}`); }
    }
  } else {
    console.log(`\nMCP preview: node ${mcpPath} (set CODEX_PROJECT_DIR or CLAUDE_PROJECT_DIR to ${root})`);
    if (has("--apply")) console.log("No writer for this client; copy the preview into its user-level MCP settings.");
  }
}
