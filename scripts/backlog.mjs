#!/usr/bin/env node
// roadmap backlog [list|add|set] — the erratic-work tracker CLI.
//   roadmap backlog                          priority-sorted open items (--all includes closed)
//   roadmap backlog add "title" [-k kind] [--id slug] [--tier P1] [--weight N] [--note s] [--slice invoke] [--est N]
//   roadmap backlog set <id> field=value ... (field=@file | field=null; same semantics as roadmap set)
// First `add` creates docs/roadmap/backlog.yaml. Every mutation re-renders BACKLOG.md (+ the
// SLICES.md open-count pointer).

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { parseAssignments } from "./lib/cli-core.mjs";
import { loadBacklog, mutateBacklog, originBacklogIds } from "./lib/store.mjs";
import { addItem, setItemFields, sortByPriority, openCount, KINDS } from "./lib/backlog-core.mjs";
import { tierBadge } from "./lib/priority.mjs";

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("-") ? args[0] : "list";
const rest = sub === args[0] ? args.slice(1) : args;
const val = (...names) => {
  for (const n of names) {
    const i = rest.indexOf(n);
    if (i >= 0 && rest[i + 1] != null) return rest[i + 1];
  }
  return undefined;
};

try {
  if (sub === "list") {
    const backlog = loadBacklog(process.cwd());
    if (!backlog) {
      console.log(`No backlog yet. Capture the first item:\n  roadmap backlog add "fix the thing" -k bug --tier P1`);
      process.exit(0);
    }
    const all = rest.includes("--all");
    const items = sortByPriority(all ? backlog.items || [] : (backlog.items || []).filter((it) => it.status === "open" || it.status === "in_progress"));
    console.log(`Backlog — ${openCount(backlog)} open item(s)${all ? ` (${(backlog.items || []).length} total)` : ""}`);
    if (!items.length) console.log("  (empty)");
    for (const it of items) {
      const badge = tierBadge(it.priority);
      const bits = [
        badge ? `[${badge}${it.priority.weight != null ? ` ${it.priority.weight}` : ""}]` : null,
        `${it.id}`, `(${it.kind}${all ? `, ${it.status}` : ""})`, `— ${it.title}`,
        it.source && it.source.slice ? `· from ${it.source.slice}` : null,
      ].filter(Boolean);
      console.log(`  ${bits.join(" ")}`);
      if (it.priority && it.priority.reason) console.log(`      why: ${it.priority.reason}`);
    }
    console.log(`\nGrab one: roadmap grab <id> · promote one: roadmap promote <id> --pi <pi>`);
  } else if (sub === "add") {
    const title = rest.find((a) => !a.startsWith("-") && a !== val("-k", "--kind") && a !== val("--id") && a !== val("--tier") && a !== val("--weight") && a !== val("--why") && a !== val("--note") && a !== val("--slice") && a !== val("--est"));
    if (!title) { console.error(`usage: roadmap backlog add "title" [-k ${KINDS.join("|")}] [--id slug] [--tier P0-P3] [--weight 0-100] [--why reason] [--note s] [--slice invoke] [--est N]`); process.exit(2); }
    const tier = val("--tier"), weight = val("--weight"), why = val("--why"), note = val("--note"), slice = val("--slice"), est = val("--est");
    const item = {
      title,
      id: val("--id"),
      kind: val("-k", "--kind"),
      est_sessions: est != null ? Number(est) : undefined,
    };
    if (tier || weight || why) item.priority = { ...(tier ? { tier } : {}), ...(weight != null ? { weight: Number(weight) } : {}), ...(why ? { reason: why } : {}) };
    if (note || slice) item.source = { ...(slice ? { slice } : {}), date: new Date().toISOString().slice(0, 10), ...(note ? { note } : {}) };
    else item.source = { date: new Date().toISOString().slice(0, 10) };
    const r = mutateBacklog(process.cwd(), (doc) => addItem(doc, { ...item, origin_ids: originBacklogIds(process.cwd()) }), { createIfMissing: true });
    console.log(`✓ added ${r.added}  (re-rendered ${r.rerendered})`);
  } else if (sub === "set") {
    const id = rest.find((a) => !a.includes("=") && !a.startsWith("-"));
    const assigns = rest.filter((a) => a.includes("="));
    if (!id || !assigns.length) { console.error("usage: roadmap backlog set <id> field=value [...]   (field=@file | field=null)"); process.exit(2); }
    const fields = {};
    for (const a of parseAssignments(assigns)) {
      fields[a.field] = a.fromFile !== undefined ? readFileSync(a.fromFile, "utf8") : YAML.parse(a.raw);
    }
    const r = mutateBacklog(process.cwd(), (doc) => setItemFields(doc, { id, fields }));
    console.log(`✓ ${id}: set ${r.fields.join(", ")}  (re-rendered ${r.rerendered})`);
  } else {
    console.error(`roadmap backlog: unknown subcommand "${sub}" (list | add | set)`);
    process.exit(2);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
