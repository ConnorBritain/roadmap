#!/usr/bin/env node
// roadmap — package boundary check (static; reads import lines only, executes nothing).
//
// Rule 1: core never imports an executor. Today that means the CORE allowlist in scripts/lib must
//         not import a module outside the allowlist. Once packages/ exists, any file under
//         packages/core must not import packages/exec-* or packages/cli (relative or by name).
// Rule 2: exactly one file reads meta.profile — the profile loader. Every other read is refused.
//
// EXPECTED lists the violations that exist on main today (the mixed modules from
// docs/ARCHITECTURE.md). The check fails on any UNEXPECTED violation and ALSO fails when an
// expected one has disappeared, so the list can only shrink, one slice at a time.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// C-verdict modules plus the G→C pure ones (see docs/ARCHITECTURE.md § Dependency map).
export const CORE_MODULES = [
  "graph", "priority", "store", "render-core", "validate-core", "backlog-core", "backlog-audit",
  "review-core", "journal-core", "plan", "linear-core", "init-core", "estimate-core", "estimator-core", "mcp-core",
  "sync-core", "execution", "cli-core", "plate-core", "cycle-core",
  "gauntlet-store", "evaluation-core", "evaluation-packet",
];

// Known core→executor edges on main. Each slice that cuts one removes its line here.
export const EXPECTED = [
  "scripts/lib/validate-core.mjs -> model-policy",      // meta.gauntlet validation (gauntlet-split / profile-loader)
  "scripts/lib/journal-core.mjs -> brief",              // branchFor (exec-engineering)
  "scripts/lib/plan.mjs -> recommend",                  // resource probes → Executor.capacity (exec-engineering)
  "scripts/lib/plan.mjs -> brief",                      // branch/worktree/prompt → Executor.annotate (exec-engineering)
  "scripts/lib/sync-core.mjs -> brief",                 // findUnrecordedMerges (exec-engineering)
  "scripts/lib/sync-core.mjs -> pr-identity",           // roadmapSubjectMarkers (gauntlet-split)
  "scripts/lib/init-core.mjs -> assistant-core",        // renderLocalConfig (exec-engineering)
];

export const PROFILE_READER = "packages/cli/src/profile.mjs";
const PROFILE_READ = /\bmeta\??\.profile\b|\bmeta\[\s*["']profile["']\s*\]|\{[^}]*\bprofile\b[^}]*\}\s*=\s*[\w.?]*\bmeta\b/;
const IMPORT_RE = /^\s*(?:import\b[^'"]*|export\b[^'"]*\bfrom\s*)['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*new URL\(\s*['"]([^'"]+)['"]/gm;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

function importsOf(text) {
  const specs = [];
  for (const m of text.matchAll(IMPORT_RE)) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

const rel = (root, p) => relative(root, p).split(sep).join("/");

export function checkBoundaries(root = process.cwd()) {
  const violations = [];

  // Rule 1a — scripts/lib allowlist (pre-packages).
  const libDir = join(root, "scripts", "lib");
  for (const name of CORE_MODULES) {
    const file = join(libDir, `${name}.mjs`);
    if (!existsSync(file)) continue;   // moved into packages/core already
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;   // node:/npm imports are fine
      const target = basename(spec).replace(/\.mjs$/, "");
      const inLib = dirname(resolve(libDir, spec)) === libDir;
      if (inLib && CORE_MODULES.includes(target)) continue;
      violations.push(`${rel(root, file)} -> ${target}`);
    }
  }

  // Rule 1b — packages/core never imports exec-* or cli.
  const coreDir = join(root, "packages", "core");
  for (const file of walk(coreDir)) {
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      const abs = spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      const crosses = abs
        ? /[\\/]packages[\\/](exec-[^\\/]+|cli)([\\/]|$)/.test(abs)
        : /^@connorbritain\/roadmap-(exec-|cli)/.test(spec);
      if (crosses) violations.push(`${rel(root, file)} -> ${spec}`);
    }
  }

  // Rule 2 — meta.profile has exactly one reader.
  const scan = [...walk(join(root, "scripts")), ...walk(join(root, "hooks")), ...walk(join(root, "packages"))];
  const self = rel(root, fileURLToPath(import.meta.url));
  for (const file of scan) {
    const r = rel(root, file);
    if (r === PROFILE_READER || r === self) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("//")) return;
      if (PROFILE_READ.test(line)) violations.push(`${rel(root, file)}:${i + 1} reads meta.profile (only ${PROFILE_READER} may)`);
    });
  }

  const unexpected = violations.filter((v) => !EXPECTED.includes(v));
  const stale = EXPECTED.filter((e) => !violations.includes(e));
  return { violations, unexpected, stale, ok: unexpected.length === 0 && stale.length === 0 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = checkBoundaries(process.cwd());
  for (const v of r.unexpected) console.error(`✗ boundary: ${v}`);
  for (const s of r.stale) console.error(`✗ stale EXPECTED entry (edge is gone — delete it from scripts/check-boundaries.mjs): ${s}`);
  const known = r.violations.length - r.unexpected.length;
  console.log(r.ok ? `✓ boundaries: no unexpected core→executor imports, no stray meta.profile reads (${known} known edge${known === 1 ? "" : "s"} still to cut)` : `${r.unexpected.length} unexpected, ${r.stale.length} stale`);
  process.exit(r.ok ? 0 : 1);
}
