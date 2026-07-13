#!/usr/bin/env node
// Safe bootstrap: no machine-level client setting is changed unless --apply is supplied.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { LOCAL_CONFIG_REL, BUILTIN_PROFILES } from "./lib/assistant-core.mjs";

const args = process.argv.slice(2);
const has = (v) => args.includes(v);
const value = (v, d = null) => { const i = args.indexOf(v); return i >= 0 ? args[i + 1] || d : d; };
const root = process.cwd();
const roadmap = join(root, "docs", "roadmap", "roadmap.yaml");
const local = join(root, LOCAL_CONFIG_REL);
const assistant = value("--assistant", "manual");
const client = value("--client", assistant === "codex" ? "codex" : null);
if (!BUILTIN_PROFILES[assistant]) { console.error(`unknown assistant ${assistant}; choose ${Object.keys(BUILTIN_PROFILES).join(", ")}`); process.exit(2); }

if (!existsSync(roadmap)) {
  if (!has("--yes")) {
    console.log(`roadmap init preview\n  would create ${roadmap}\n  would create ${local}\nRe-run with --yes to create the minimal roadmap.`);
    process.exit(0);
  }
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(roadmap, `meta:\n  schema_version: 1\n  program: ${value("--program", "MYPROJ")}\n  assistants:\n    default: manual\npis:\n  - id: first\n    title: First initiative\n    status: active\n    sprints:\n      - { id: s1, title: First slice, status: next, invoke: first-s1, est_sessions: 1 }\n`, "utf8");
  console.error(`created ${roadmap}`);
}

if (!existsSync(local)) {
  const command = BUILTIN_PROFILES[assistant].command;
  const config = `# Machine-local assistant commands and launch authority. Never put secrets here.\nversion: 1\nassistants:\n  ${assistant}:\n    launch: false\n${command ? `    command: '${command}'\n` : ""}`;
  if (has("--write-local") || has("--yes")) {
    mkdirSync(join(root, ".roadmap"), { recursive: true });
    writeFileSync(local, config, "utf8");
    console.error(`created ${local} (launch remains disabled)`);
  } else console.log(`local profile preview (${local}):\n${config}`);
}

const ignore = join(root, ".gitignore");
const ignoreLine = ".roadmap/config.local.yaml";
const ignoreText = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
if (!ignoreText.split(/\r?\n/).includes(ignoreLine)) {
  if (has("--yes")) writeFileSync(ignore, `${ignoreText.trimEnd()}${ignoreText.trim() ? "\n" : ""}${ignoreLine}\n`, "utf8");
  else console.log(`gitignore preview: add ${ignoreLine}`);
}

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "mcp.mjs");
if (client === "codex") {
  const codexConfig = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  const section = `[mcp_servers.roadmap]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcpPath)}]\n\n[mcp_servers.roadmap.env]\nCODEX_PROJECT_DIR = ${JSON.stringify(root)}\n`;
  console.log(`Codex MCP preview (${codexConfig}):\n${section}`);
  if (has("--apply")) {
    const current = existsSync(codexConfig) ? readFileSync(codexConfig, "utf8") : "";
    if (current.includes("[mcp_servers.roadmap]")) console.log("Codex MCP entry already exists; no change made.");
    else { writeFileSync(codexConfig, `${current.trimEnd()}\n\n${section}`, "utf8"); console.log(`applied Codex MCP entry to ${codexConfig}`); }
  }
} else {
  console.log(`MCP preview: node ${mcpPath} (set CODEX_PROJECT_DIR or CLAUDE_PROJECT_DIR to ${root})`);
  if (has("--apply")) console.log("No writer for this client; copy the preview into its user-level MCP settings.");
}
