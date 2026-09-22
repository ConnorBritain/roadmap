#!/usr/bin/env node
// roadmap assign <key> [--to who] [--dry] — assign a slice to a person (the general profile's human
// executor): writes .roadmap/assignments/<key>.md with the checklist gate and the artifact path.
import { join } from "node:path";
import { loadGraph, flatten } from "@connorbritain/roadmap-core/graph.mjs";
import { REL } from "@connorbritain/roadmap-core/cli-core.mjs";
import { humanExecutor } from "@connorbritain/roadmap-exec-general/executors.mjs";

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const key = args.find((a) => !a.startsWith("-"));
if (!key) { console.error("usage: roadmap assign <key> [--to who] [--dry]"); process.exit(2); }

const root = process.cwd();
const graph = loadGraph(join(...REL));
const node = flatten(graph).nodes.find((n) => n.invoke === key);
if (!node) { console.error(`✗ no slice "${key}"`); process.exit(1); }
const r = await humanExecutor({ root }).launch(node, { assignee: val("--to", null), dry: args.includes("--dry") }, { root, graph });
if (r.dry) process.stdout.write(r.text);
console.error(r.dry ? `(--dry — brief previewed above; nothing written)` : `✓ ${key} assigned to ${r.actor} — brief at ${r.brief}${r.existing ? " (already assigned; brief kept)" : ""}`);
