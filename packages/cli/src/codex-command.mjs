// How `roadmap init --client codex` reaches Codex's own `codex mcp add`.
// On Windows `codex` is an npm .cmd shim, and a .cmd only runs through cmd.exe, where `&`,
// `|`, `%` and `^` in a path would be interpreted. So run the shim's JS entry with Node
// instead, the way scripts/test/npm-command.mjs runs npm, and never go through a shell.
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** { command, args } to spawn with shell:false, or null when Codex's entry is not found. */
export function codexCommand(args, { platform = process.platform, node = process.execPath,
  pathEnv = process.env.PATH ?? process.env.Path ?? "", exists = existsSync } = {}) {
  if (platform !== "win32") return { command: "codex", args };
  for (const dir of pathEnv.split(";").filter(Boolean)) {
    if (!exists(win32.join(dir, "codex.cmd"))) continue;
    const entry = win32.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (exists(entry)) return { command: node, args: [entry, ...args] };
  }
  return null;
}

/**
 * The command as a person would paste it: POSIX shells and PowerShell both take a
 * single-quoted string literally (POSIX escapes ' as '\'', PowerShell as '').
 */
export function shellPreview(argv, { platform = process.platform } = {}) {
  const quote = platform === "win32" ? (a) => `'${a.replace(/'/g, "''")}'` : (a) => `'${a.replace(/'/g, "'\\''")}'`;
  return argv.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : quote(a))).join(" ");
}
