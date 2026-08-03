#!/usr/bin/env node
// roadmap — validate a roadmap.yaml AND its sibling backlog.yaml.
//
// Thin wrapper around lib/validate-core.mjs (roadmap graph) + lib/backlog-core.mjs
// (parsed-object schema) + lib/backlog-audit.mjs (raw-text damage). Exits
// non-zero on any error surfaced by any layer.
//
// Usage: node validate.mjs [path-to-roadmap.yaml]   (default: docs/roadmap/roadmap.yaml)
//
// Backlog checks are OPT-IN by convention: if a `backlog.yaml` sibling exists
// next to the roadmap.yaml, it is validated too. Absent → validation stays
// roadmap-only, preserving backward compatibility for repos that don't use it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadGraph } from "./lib/graph.mjs";
import { validateGraph } from "./lib/validate-core.mjs";
import { validateBacklog } from "./lib/backlog-core.mjs";
import { auditBacklog, AUDIT_CODES, knownDamageOf } from "./lib/backlog-audit.mjs";

const path = process.argv[2] || "docs/roadmap/roadmap.yaml";

let graph;
try {
  graph = loadGraph(path);
} catch (e) {
  console.error(`✗ could not load ${path}: ${e.message}`);
  process.exit(2);
}

const graphResult = validateGraph(graph);
for (const w of graphResult.warnings) console.warn(`⚠ ${w}`);
const graphErrors = graphResult.errors;

// Backlog sibling — opt-in by presence. A repo without one skips this half.
const backlogPath = join(dirname(path), "backlog.yaml");
const backlogErrors = [];
const backlogWarnings = [];
let backlogItemCount = null;

if (existsSync(backlogPath)) {
  let text;
  try {
    text = readFileSync(backlogPath, "utf8");
  } catch (e) {
    console.error(`✗ could not read ${backlogPath}: ${e.message}`);
    process.exit(2);
  }

  // Try the parsed-object read early so we can pull the known_damage baseline
  // (meta.audit.known_damage) into the audit call. A parse failure is captured
  // and reported, and the audit still runs on the raw text — the two checks
  // are independent (that's the whole point of the audit).
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    backlogErrors.push(`${backlogPath}: yaml.parse failed — ${e.message}`);
  }
  const knownDamage = parsed ? knownDamageOf(parsed) : [];

  // Raw-text audit — the parsed object may look clean while the text is
  // quietly damaged (duplicate title keys, orphan reasons, bare stub id-lines).
  // This is the check that catches what `yaml.parse` silently normalizes away
  // AND the check that names the line to fix when yaml.parse throws.
  const audit = auditBacklog(text, { knownDamage });
  for (const f of audit.findings) {
    // The four collision shapes gate; MALFORMED_ID is INFO, surfaced as a warning.
    if (f.code === AUDIT_CODES.MALFORMED_ID) {
      backlogWarnings.push(`${backlogPath}: ${f.message}`);
    } else {
      backlogErrors.push(`${backlogPath}: [${f.code}] ${f.message}`);
    }
  }
  // A repo that has repaired an entry MUST prune it from meta.audit.known_damage,
  // or the baseline outlives the damage it describes — and the guard silently
  // loses its ability to catch a NEW instance of that same signature.
  for (const s of audit.staleKnown) {
    backlogWarnings.push(`${backlogPath}: meta.audit.known_damage still lists '${s}' but the underlying damage is repaired — prune this entry.`);
  }
  // Grandfathered damage is reported for visibility (a stranger reading the
  // file must be able to see WHAT is being tolerated) but does not gate.
  if (audit.grandfathered.length) {
    backlogWarnings.push(`${backlogPath}: ${audit.grandfathered.length} finding(s) grandfathered by meta.audit.known_damage: ${audit.grandfathered.map((f) => `${f.code}:${f.id}`).join(", ")}`);
  }

  if (parsed) {
    const bResult = validateBacklog(parsed);
    for (const w of bResult.warnings) backlogWarnings.push(`${backlogPath}: ${w}`);
    for (const err of bResult.errors) backlogErrors.push(`${backlogPath}: ${err}`);
    backlogItemCount = bResult.itemCount;
  }

  for (const w of backlogWarnings) console.warn(`⚠ ${w}`);
}

const allErrors = [...graphErrors, ...backlogErrors];
if (allErrors.length) {
  for (const e of allErrors) console.error(`✗ ${e}`);
  const parts = [`${allErrors.length} error(s) in ${path}`];
  if (backlogErrors.length) parts.push(`(${backlogErrors.length} in the sibling backlog.yaml)`);
  console.error(`\n${parts.join(" ")}`);
  process.exit(1);
}
const totalWarnings = graphResult.warnings.length + backlogWarnings.length;
const backlogSummary = backlogItemCount !== null ? `, ${backlogItemCount} backlog items` : "";
console.log(`✓ ${path} valid — ${(graph.pis || []).length} PIs, ${graphResult.nodeCount} sprints${backlogSummary}, ${totalWarnings} warning(s)`);
process.exit(0);
