#!/usr/bin/env node
// roadmap show <invoke> — print one slice's detail (what / deps / read-order / next / gate
// + branch/worktree), for /slice orientation. Read-only.

import { loadGraph, flatten, statusDisplay, resolveGate } from "./lib/graph.mjs";
import { branchFor, worktreeFor } from "./lib/brief.mjs";
import { executionDirectiveLines } from "./lib/execution.mjs";

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const inPath = val("--in", "docs/roadmap/roadmap.yaml");
const invoke = args.find((a) => !a.startsWith("--"));

if (!invoke) { console.error("usage: roadmap show <slice-invoke>"); process.exit(2); }

const graph = loadGraph(inPath);
const model = flatten(graph);
const node = model.nodes.find((n) => n.invoke === invoke);
if (!node) {
  const names = model.nodes.map((n) => n.invoke).sort();
  console.error(`roadmap: no slice "${invoke}". Available:\n  ${names.join("\n  ")}`);
  process.exit(2);
}

const gate = resolveGate(node, graph).replace(/\{\{\s*default\s*\}\}/gi, "default gate").trim();
const deps = [...node.deps.map((d) => d.split("/")[1].toUpperCase()), ...node.piDeps.map((p) => p.toUpperCase())];
const out = [];
out.push(`Slice: ${node.invoke}  [${statusDisplay(node.status, node.statusLabel)}]`);
out.push(`PI:    ${node.programLabel} · ${node.id.toUpperCase()}${node.estSessions != null ? `  (~${node.estSessions} sessions)` : ""}`);
out.push(`What:  ${node.what}`);
// Execution directive at the top of the read-out (only when the slice declares one).
const execLines = executionDirectiveLines(node);
if (execLines) { out.push(""); execLines.forEach((l) => out.push(l)); }
if (deps.length) out.push(`Deps:  ${deps.join(", ")}`);
out.push(`Branch:   ${branchFor(node, graph)}`);
out.push(`Worktree: ${worktreeFor(node, graph)}`);
if (node.gatedOn) out.push(`Gated on: ${node.gatedOn} — an agent prepares; it does NOT perform the gate.`);
out.push("");
out.push("Read-order:");
(node.readOrder.length ? node.readOrder : ["(none listed — see the PI's detail dir)"]).forEach((r, i) => out.push(`  ${i + 1}. ${r}`));
out.push("");
out.push(`Next: ${node.resumeAction ? node.resumeAction.trim() : "(see read-order)"}`);
out.push(`Gate: ${gate}`);
console.log(out.join("\n"));
