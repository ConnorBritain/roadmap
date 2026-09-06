import { existsSync } from "node:fs";
import { win32 } from "node:path";

// npm.cmd is not directly executable with shell:false on Windows. Run its JS
// entry point with Node so archive paths never pass through cmd.exe quoting.
export function npmCommand(args, { platform = process.platform, node = process.execPath,
  npmEntry = process.env.npm_execpath, exists = existsSync } = {}) {
  if (platform !== "win32") return { command: "npm", args };
  const candidates = [npmEntry, win32.join(win32.dirname(node), "node_modules", "npm", "bin", "npm-cli.js")];
  const entry = candidates.find((path) => typeof path === "string" && /\.[cm]?js$/i.test(path) && exists(path));
  if (!entry) throw new Error("Cannot locate npm's JS entry point on Windows; run this check through npm run test:packed -- <archive.tgz>");
  return { command: node, args: [entry, ...args] };
}
