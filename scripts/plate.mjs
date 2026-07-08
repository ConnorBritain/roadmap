#!/usr/bin/env node
// roadmap plate [list|add|rm|set|clear] — the curated batch that projects to Linear's My Issues (assignee=you).
//   roadmap plate                 show the current plate (explicit entries + auto-included active work)
//   roadmap plate add <key>...    add slice invoke keys / backlog ids (creates meta.plate if absent → feature on)
//   roadmap plate rm  <key>...    remove explicit entries
//   roadmap plate set <key>...    replace the explicit list
//   roadmap plate clear           empty the explicit list (feature stays on; active work still auto-shows)
// Assignment lands on the next 'roadmap linear sync' (or /sync). Completed slices auto-drain there.

import { loadGraph } from "./lib/graph.mjs";
import { loadBacklog, mutateRoadmap, roadmapPaths } from "./lib/store.mjs";
import { setPlateDoc, platedKeys } from "./lib/plate-core.mjs";
import { normalizeLinearConfig } from "./lib/linear-core.mjs";

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("-") ? args[0] : "list";
const keys = (sub === args[0] ? args.slice(1) : args).filter((a) => !a.startsWith("-"));
const root = process.cwd();

// key → { title, status, mapped } across slices + backlog items (for the list view)
function indexOf(graph, backlog) {
  const idx = new Map();
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) idx.set(sp.invoke, { title: sp.title, status: sp.status, mapped: !!sp.linear });
  for (const it of (backlog && backlog.items) || []) idx.set(it.id, { title: it.title, status: it.status, mapped: !!it.linear });
  return idx;
}

try {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const backlog = loadBacklog(root);
  const explicit = Array.isArray(graph.meta && graph.meta.plate) ? graph.meta.plate.slice() : null;

  if (sub === "list") {
    const set = platedKeys(graph, backlog);
    if (set == null) { console.log("The plate is OFF (no meta.plate). Turn it on:  roadmap plate add <slice-or-id>"); process.exit(0); }
    const idx = indexOf(graph, backlog);
    const cfg = normalizeLinearConfig(graph.meta || {});
    const cap = cfg ? cfg.plate_max : 7;
    const exp = Array.isArray(explicit) ? explicit : [];   // malformed meta.plate (validate errors on it) shouldn't raw-crash the list
    console.log(`Plate — ${set.size} on My Issues${exp.length > cap ? `  (⚠ ${exp.length} explicit > plate_max ${cap})` : ""}`);
    if (!set.size) console.log("  (empty)");
    for (const key of set) {
      const info = idx.get(key);
      const auto = !exp.includes(key) ? "  (auto: active)" : "";
      if (!info) console.log(`  • ${key}  — ⚠ matches no slice/backlog item (typo?)`);
      else console.log(`  • ${key}  [${info.status}] ${info.title}${info.mapped ? "" : " — not in Linear yet (pushes on sync)"}${auto}`);
    }
    console.log("\nAssignment lands on the next 'roadmap linear sync'. Completed slices auto-drain.");
    process.exit(0);
  }

  if (sub === "clear") {
    const r = mutateRoadmap(root, (doc) => { setPlateDoc(doc, []); return { plate: "cleared" }; });
    console.log(`✓ plate cleared (feature stays on; active work still auto-shows).  (re-rendered ${r.rerendered})`);
    process.exit(0);
  }

  if (["add", "rm", "set"].includes(sub)) {
    if (!keys.length) { console.error(`usage: roadmap plate ${sub} <slice-invoke-or-backlog-id> ...`); process.exit(2); }
    let next;
    if (sub === "set") next = [...new Set(keys)];
    else if (sub === "add") next = [...new Set([...(explicit || []), ...keys])];
    else { // rm
      if (explicit == null) { console.log("The plate is off (no meta.plate) — nothing to remove."); process.exit(0); }
      next = explicit.filter((k) => !keys.includes(k));
    }
    const r = mutateRoadmap(root, (doc) => { setPlateDoc(doc, next); return { plate: next.length }; });
    console.log(`✓ plate ${sub}: ${next.length} explicit entr${next.length === 1 ? "y" : "ies"}${next.length ? ` [${next.join(", ")}]` : ""}  (sync to apply · re-rendered ${r.rerendered})`);
    process.exit(0);
  }

  console.error(`roadmap plate: unknown subcommand "${sub}" (list | add | rm | set | clear)`);
  process.exit(2);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
