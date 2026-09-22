// Portable assistant-profile configuration.  Canonical roadmap data may select a
// safe default; machine commands and launch authority always live in .roadmap.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const LOCAL_CONFIG_REL = join(".roadmap", "config.local.yaml");
export const BUILTIN_PROFILES = {
  manual: { launch: false, autonomous: false, description: "Create worktrees and briefs only." },
  claude: { launch: false, autonomous: true, command: "claude --permission-mode {mode} {prompt}", description: "Claude Code in a terminal." },
  codex: { launch: false, autonomous: false, command: "codex {prompt}", description: "Codex CLI in a terminal." },
  custom: { launch: false, autonomous: false, description: "A locally configured command template." },
};

const SECRET = /(api[_-]?key|token|secret|password|credential|bearer|authorization)/i;
export function safeConfig(value, path = "config") {
  if (typeof value === "string" && SECRET.test(path)) throw new Error(`${path} must not contain a credential; use the environment instead`);
  if (Array.isArray(value)) value.forEach((v, i) => safeConfig(v, `${path}[${i}]`));
  if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => safeConfig(v, `${path}.${k}`));
  return value;
}

export function readLocalConfig(root, read = readFileSync, exists = existsSync) {
  const path = join(root, LOCAL_CONFIG_REL);
  if (!exists(path)) return { path, config: { version: 1, assistants: {} } };
  let config;
  try { config = parse(read(path, "utf8")) || {}; } catch (e) { throw new Error(`could not parse ${LOCAL_CONFIG_REL}: ${e.message}`); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${LOCAL_CONFIG_REL} must be a YAML mapping`);
  safeConfig(config);
  return { path, config };
}

export function configuredProfiles(graph, local = {}) {
  const selected = graph.meta?.assistants || {};
  const localProfiles = local.assistants || {};
  const names = new Set(["manual", ...Object.keys(BUILTIN_PROFILES), ...Object.keys(selected.profiles || {}), ...Object.keys(localProfiles)]);
  const profiles = {};
  for (const name of names) {
    const base = BUILTIN_PROFILES[name] || {};
    profiles[name] = { name, ...base, ...(selected.profiles?.[name] || {}), ...(localProfiles[name] || {}) };
  }
  return { defaultProfile: selected.default || "manual", profiles };
}

export function resolveProfile(graph, local, requested) {
  const all = configuredProfiles(graph, local);
  const name = requested || all.defaultProfile || "manual";
  const profile = all.profiles[name];
  if (!profile) throw new Error(`unknown assistant profile "${name}"; run 'roadmap assistant list'`);
  return profile;
}

export function commandFor(profile, { prompt, mode = "plan" }) {
  if (!profile.command) throw new Error(`assistant profile "${profile.name}" has no local command configured`);
  if (!profile.command.includes("{prompt}")) throw new Error(`assistant profile "${profile.name}" command must contain {prompt}`);
  return profile.command.replaceAll("{mode}", mode).replaceAll("{prompt}", `"${prompt}"`);
}

export function launchDecisionForProfile(profile, { requestedLaunch = false, autonomous = false } = {}) {
  if (!requestedLaunch || profile.name === "manual") return { spawn: false, mode: "manual" };
  if (!profile.launch) throw new Error(`assistant profile "${profile.name}" is not authorized to launch; configure it locally first`);
  if (autonomous && !profile.autonomous) throw new Error(`assistant profile "${profile.name}" does not support autonomous launch`);
  return { spawn: true, mode: autonomous ? "autonomous" : "interactive" };
}
