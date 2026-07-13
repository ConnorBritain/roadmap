#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadGraph } from "./lib/graph.mjs";
import { LOCAL_CONFIG_REL, BUILTIN_PROFILES, readLocalConfig, configuredProfiles } from "./lib/assistant-core.mjs";

const args = process.argv.slice(2);
const action = args[0] || "list";
const graph = loadGraph("docs/roadmap/roadmap.yaml");
const root = process.cwd();
const { path, config } = readLocalConfig(root);
if (action === "list") {
  const all = configuredProfiles(graph, config);
  console.log(`default: ${all.defaultProfile}`);
  for (const p of Object.values(all.profiles)) console.log(`${p.name}\tlaunch=${Boolean(p.launch)}\tautonomous=${Boolean(p.autonomous)}\t${p.description || ""}`);
} else if (action === "doctor") {
  const all = configuredProfiles(graph, config);
  console.log(existsSync(path) ? `ok: ${LOCAL_CONFIG_REL} found` : `warning: ${LOCAL_CONFIG_REL} absent; manual profile is active`);
  for (const p of Object.values(all.profiles)) if (p.launch && !p.command) console.log(`error: ${p.name} is launch-enabled but has no command`);
  console.log("ok: no credentials found in local assistant configuration");
} else if (action === "configure") {
  const name = args[1];
  if (!name || !BUILTIN_PROFILES[name]) { console.error(`usage: roadmap assistant configure <${Object.keys(BUILTIN_PROFILES).join("|")}> [--enable-launch]`); process.exit(2); }
  mkdirSync(join(root, ".roadmap"), { recursive: true });
  const command = BUILTIN_PROFILES[name].command || "REPLACE_ME {prompt}";
  const next = { version: 1, ...config, assistants: { ...(config.assistants || {}), [name]: { ...(config.assistants?.[name] || {}), command, launch: args.includes("--enable-launch") } } };
  writeFileSync(path, `# Machine-local. Do not commit secrets.\n${stringify(next)}`, "utf8");
  console.log(`configured ${name}; launch=${args.includes("--enable-launch")}`);
} else { console.error("assistant: expected list | configure | doctor"); process.exit(2); }
