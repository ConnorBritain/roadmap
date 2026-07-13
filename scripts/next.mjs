#!/usr/bin/env node
// roadmap next — print the single highest-priority ready thing across the roadmap AND the
// backlog, with its pickup brief. Roadmap wins ties (planned value work outranks erratic
// work at equal priority). Read-only.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadGraph } from "./lib/graph.mjs";
import { loadBacklog } from "./lib/store.mjs";
import { pickNext } from "./lib/backlog-core.mjs";
import { tierBadge } from "./lib/priority.mjs";

const graph = loadGraph("docs/roadmap/roadmap.yaml");
const backlog = loadBacklog(process.cwd());
const next = pickNext(graph, backlog, new Date().toISOString().slice(0, 10));

if (!next) {
  console.log("Nothing ready: no runnable slices, no open backlog items. ('roadmap plan' shows what's held and why.)");
  process.exit(0);
}

if (next.type === "slice") {
  console.log(`Next up (roadmap): ${next.node.invoke}\n`);
  const r = spawnSync("node", [join(dirname(fileURLToPath(import.meta.url)), "show.mjs"), next.node.invoke], { stdio: "inherit" });
  console.log(`\nPick it up: /slice ${next.node.invoke}  ·  or fan it out: roadmap fan`);
  process.exit(r.status ?? 0);
}

const it = next.item;
const badge = tierBadge(it.priority);
console.log(`Next up (backlog): ${it.id}  [${it.kind}${badge ? ` · ${badge}${it.priority.weight != null ? ` ${it.priority.weight}` : ""}` : ""}]`);
console.log(`What:  ${it.title}`);
if (it.priority && it.priority.reason) console.log(`Why:   ${it.priority.reason}`);
if (it.source && (it.source.slice || it.source.note)) {
  console.log(`From:  ${[it.source.slice, it.source.note].filter(Boolean).join(" — ")}`);
}
if (it.est_sessions != null) console.log(`Est:   ~${it.est_sessions} session(s)`);
if (it.prompt) {
  console.log(`\nPrompt (author instructions, verbatim):`);
  String(it.prompt).trimEnd().split("\n").forEach((l) => console.log(`  ${l}`));
}
console.log(`\nPick it up: roadmap grab ${it.id}  ·  or promote it: roadmap promote ${it.id} --pi <pi>`);
