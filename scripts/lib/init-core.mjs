// roadmap — pure init brain. Everything init.mjs's interactive walkthrough
// needs, without IO: default derivation (program name from git or cwd),
// validators (SLUG shape, non-empty), and blueprint rendering (roadmap.yaml,
// backlog.yaml, .roadmap/config.local.yaml). Keeping the shape rendering here
// lets tests assert byte-exact output without spawning the CLI.

import { BUILTIN_PROFILES } from "./assistant-core.mjs";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const REL = ["docs", "roadmap", "roadmap.yaml"];
export const BACKLOG_REL = ["docs", "roadmap", "backlog.yaml"];
export const LOCAL_REL = [".roadmap", "config.local.yaml"];

// Derive a sensible default program name from either an explicit hint (a git
// repo name, a dir basename) or fall through to the generic "MYPROJ" — never
// throw, since this is a default only, the user gets to confirm/edit it.
export function suggestProgramName({ repoName = null, cwdBasename = null } = {}) {
  const raw = repoName || cwdBasename || "";
  const cleaned = String(raw)
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (SLUG_RE.test(cleaned)) return cleaned;
  return "myproj";
}

/**
 * Validators the interactive walkthrough hands to prompt.text — return null
 * on success, an error string on rejection. The strings surface directly in
 * the terminal, so they must be short and actionable.
 */
export const validators = {
  required: (v) => (v && String(v).trim() ? null : "cannot be empty"),
  slug: (v) => {
    if (!v || !String(v).trim()) return "cannot be empty";
    if (!SLUG_RE.test(v)) return "use lowercase letters, digits, and dashes only (e.g. my-project)";
    return null;
  },
  // A title may contain any printable text — the only guard is non-empty.
  title: (v) => (v && String(v).trim() ? null : "cannot be empty"),
};

/**
 * Blueprint = the full set of file-writes an init would produce, given a
 * set of user choices. Kept as data so the walkthrough can PREVIEW it
 * before writing (or write it after --yes) without duplicating the shape.
 *
 * Choices:
 *   program        (slug)      the program name at meta.program
 *   piTitle        (string)    the first initiative title
 *   sprintTitle    (string)    the first sprint title
 *   assistant      (string)    'manual' | 'claude' | 'codex' — matches BUILTIN_PROFILES
 *   withBacklog    (bool)      also scaffold backlog.yaml
 *   withLocal      (bool)      also scaffold .roadmap/config.local.yaml
 *
 * Returns [{ path, contents, exists?, action }, ...]. `exists` is filled in
 * by the caller (has fs access); `action` is 'create' or 'preserve' —
 * preserve means the file already exists and init will not overwrite.
 */
export function planInit(choices, { existingFiles = new Set() } = {}) {
  const {
    program = "myproj",
    piTitle = "First initiative",
    sprintTitle = "First slice",
    assistant = "manual",
    withBacklog = true,
    withLocal = true,
  } = choices || {};

  const files = [];

  const roadmapPath = REL.join("/");
  files.push({
    path: roadmapPath,
    contents: renderRoadmapYaml({ program, piTitle, sprintTitle }),
    exists: existingFiles.has(roadmapPath),
    action: existingFiles.has(roadmapPath) ? "preserve" : "create",
  });

  if (withBacklog) {
    const backlogPath = BACKLOG_REL.join("/");
    files.push({
      path: backlogPath,
      contents: renderBacklogYaml(),
      exists: existingFiles.has(backlogPath),
      action: existingFiles.has(backlogPath) ? "preserve" : "create",
    });
  }

  if (withLocal) {
    const localPath = LOCAL_REL.join("/");
    files.push({
      path: localPath,
      contents: renderLocalConfig({ assistant }),
      exists: existingFiles.has(localPath),
      action: existingFiles.has(localPath) ? "preserve" : "create",
    });
  }

  return files;
}

/**
 * The roadmap.yaml starter — a valid file that renders cleanly, walks the
 * user through the shape without being so bare that they misread it as a
 * schema-example rather than a working file. The active PI + `next` sprint
 * means `roadmap plan` immediately shows something runnable, which is what
 * a first-run user needs to see.
 */
export function renderRoadmapYaml({ program, piTitle, sprintTitle }) {
  const p = program || "myproj";
  const pTitle = piTitle || "First initiative";
  const sTitle = sprintTitle || "First slice";
  return [
    `# roadmap.yaml — the canonical plan. Edit here; docs/SLICES.md is generated.`,
    `# 'roadmap validate' → structural check. 'roadmap render' → regenerate SLICES.md.`,
    `meta:`,
    `  schema_version: 1`,
    `  program: ${p}`,
    `pis:`,
    `  - id: first`,
    `    title: ${quote(pTitle)}`,
    `    status: active`,
    `    sprints:`,
    `      - id: s1`,
    `        title: ${quote(sTitle)}`,
    `        status: next`,
    `        invoke: first-s1`,
    `        est_sessions: 1`,
    ``,
  ].join("\n");
}

export function renderBacklogYaml() {
  return [
    `# backlog.yaml — erratic-work tracker. 'roadmap backlog add "title"' captures items;`,
    `# 'roadmap promote <id>' turns one into a roadmap sprint.`,
    `meta:`,
    `  schema_version: 1`,
    `items: []`,
    ``,
  ].join("\n");
}

export function renderLocalConfig({ assistant = "manual" } = {}) {
  const profile = BUILTIN_PROFILES[assistant] || BUILTIN_PROFILES.manual;
  const command = profile && profile.command;
  const lines = [
    `# Machine-local assistant commands + launch authority. Gitignored — never commit secrets.`,
    `version: 1`,
    `assistants:`,
    `  ${assistant}:`,
    `    launch: false`,
  ];
  if (command) lines.push(`    command: ${quote(command)}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Compute the .gitignore additions this init would make. Returns { line, need,
 * currentText } — `need` is true only when the line isn't already present.
 */
export function planGitignore({ currentText = "" } = {}) {
  const line = `${LOCAL_REL.join("/")}`;
  const lines = currentText.split(/\r?\n/);
  const need = !lines.includes(line);
  return { line, need, currentText };
}

export function appendToGitignore(currentText, line) {
  const trimmed = currentText.trimEnd();
  const sep = trimmed === "" ? "" : "\n";
  return `${trimmed}${sep}\n${line}\n`;
}

// A YAML-safe scalar rendered for hand-formed YAML output. Init keeps its
// deps to zero, so a string with characters that would change the parse
// (`:`, `#` — comment marker, `"`, `'`, `\`) must be double-quoted and
// escaped. Plain words + spaces stay unquoted — plain scalars accept them,
// and the file reads better when init doesn't quote everything reflexively.
// Newlines aren't expected in an init prompt (the validators are single-line).
function quote(s) {
  const str = String(s == null ? "" : s);
  // A leading char that would trigger a YAML flow/tag/anchor parse forces a quote.
  const leadingSpecial = /^[!&*|>%@`\[{'"#]/.test(str);
  // Any `:` starts a mapping-value interpretation mid-string; `#` starts a
  // comment. Either character anywhere → quote for safety.
  const hasSeparator = /[:#\\]/.test(str);
  const hasQuote = /["]/.test(str);
  if (str === "" || leadingSpecial || hasSeparator || hasQuote) {
    return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return str;
}
