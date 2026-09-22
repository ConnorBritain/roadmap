#!/usr/bin/env node
// roadmap — package boundary check (static; reads import lines only, executes nothing).
//
// Rule 1: core never imports an executor. Nothing under packages/core may import a path outside
//         packages/core (a relative import that escapes the package) or the exec-*/cli packages
//         by name. Node builtins and npm dependencies are fine.
// Rule 2: exactly one file reads meta.profile — the profile loader. Every other read is refused.
// Rule 1c: only that loader imports the general executor package by name (see below).
//
// EXPECTED lists violations that are known and tracked in docs/roadmap/roadmap.yaml. The check
// fails on any UNEXPECTED violation and ALSO fails when an expected one has disappeared, so the
// list can only shrink, one slice at a time. It is empty since the core-extract slice.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED = [];

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
const inside = (dir, p) => { const r = relative(dir, p); return !r.startsWith("..") && !isAbsolute(r); };

export function checkBoundaries(root = process.cwd()) {
  const violations = [];

  // Rule 1 — packages/core is self-contained: no relative import escapes it, no exec-*/cli import.
  const coreDir = join(root, "packages", "core");
  for (const file of walk(coreDir)) {
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const abs = resolve(dirname(file), spec);
        if (!inside(coreDir, abs)) violations.push(`${rel(root, file)} -> ${spec} (escapes packages/core)`);
      } else if (/^@connorbritain\/roadmap-(exec-|cli)/.test(spec)) {
        violations.push(`${rel(root, file)} -> ${spec}`);
      }
    }
  }

  // Rule 1b — an executor package is self-contained too: it may import core (and, for exec packages,
  // nothing else by name), never a relative path outside itself and never the scripts/ tree.
  for (const pkg of ["exec-engineering", "exec-general", "cli"]) {
    const dir = join(root, "packages", pkg);
    for (const file of walk(dir)) {
      if (rel(root, file).startsWith(`packages/${pkg}/test/`)) continue;   // tests may reach core's harness
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".")) {
          const abs = resolve(dirname(file), spec);
          if (!inside(dir, abs)) violations.push(`${rel(root, file)} -> ${spec} (escapes packages/${pkg})`);
        } else if (pkg.startsWith("exec-") && /^@connorbritain\/roadmap-(exec-|cli)/.test(spec)) {
          violations.push(`${rel(root, file)} -> ${spec} (an executor imports another executor)`);
        }
      }
    }
  }

  // Rule 1c — the general executor package is reached only through the loader: outside its own
  // package, only the profile loader may import it by name (engineering CLIs import their own
  // package directly because they ARE the engineering profile's commands).
  for (const file of [...walk(join(root, "scripts")), ...walk(join(root, "hooks")), ...walk(join(root, "packages", "cli")), ...walk(join(root, "packages", "exec-engineering")), ...walk(join(root, "packages", "core"))]) {
    const r = rel(root, file);
    if (r === PROFILE_READER || r.startsWith("packages/cli/test/") || r.startsWith("scripts/test/")) continue;
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith("@connorbritain/roadmap-exec-general")) violations.push(`${r} -> ${spec} (only ${PROFILE_READER} loads the general package)`);
    }
  }

  // Rule 2 — meta.profile has exactly one reader.
  const self = rel(root, fileURLToPath(import.meta.url));
  const scan = [...walk(join(root, "scripts")), ...walk(join(root, "hooks")), ...walk(join(root, "packages"))];
  for (const file of scan) {
    const r = rel(root, file);
    if (r === PROFILE_READER || r === self) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("//")) return;
      if (PROFILE_READ.test(line)) violations.push(`${r}:${i + 1} reads meta.profile (only ${PROFILE_READER} may)`);
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
  console.log(r.ok ? `✓ boundaries: packages/core is self-contained; no stray meta.profile reads (${known} known edge${known === 1 ? "" : "s"} still to cut)` : `${r.unexpected.length} unexpected, ${r.stale.length} stale`);
  process.exit(r.ok ? 0 : 1);
}
