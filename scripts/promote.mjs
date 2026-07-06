#!/usr/bin/env node
// roadmap promote <backlog-id> --pi <pi> [--id sN] — convert a backlog item into a roadmap
// sprint. The item's id becomes the sprint's invoke key; title/est/gate/touches/prompt/priority
// carry over; the item is marked promoted with a promoted_to back-link. Both YAMLs are
// validated before either is written; both generated views re-render.

import { mutateBoth } from "./lib/store.mjs";
import { performPromotion } from "./lib/backlog-core.mjs";

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const id = args.find((a) => !a.startsWith("-") && a !== val("--pi") && a !== val("--id"));
const pi = val("--pi");

if (!id || !pi) {
  console.error("usage: roadmap promote <backlog-id> --pi <pi> [--id sN]");
  process.exit(2);
}

try {
  const r = mutateBoth(process.cwd(), (rDoc, bDoc) => performPromotion(rDoc, bDoc, { id, pi, sprint_id: val("--id") }));
  console.log(`✓ promoted ${r.promoted} → ${r.to}  (invoke stays '${r.promoted}'; re-rendered ${r.rerendered})`);
  console.log(`  Next: roadmap show ${r.promoted} · scope it (deps/touches/read_order) via roadmap set or the slice-scoper agent.`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
