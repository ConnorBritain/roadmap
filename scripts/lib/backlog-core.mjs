// roadmap — backlog brain (PURE). The erratic-work tracker beside the roadmap: validation,
// yaml-Document mutations (comment-preserving, mirroring mcp-core), the BACKLOG.md renderer,
// the item→node adapter that lets `grab` reuse the fanout brief machinery, and pickNext —
// the highest-priority ready thing across roadmap AND backlog. No IO.

import { flatten, readyNodes } from "./graph.mjs";
import { comparePriority, tierBadge, validatePriority, TIERS } from "./priority.mjs";
import { addSprint } from "./mcp-core.mjs";

export const KINDS = ["bug", "chore", "followup", "urgent", "idea"];
export const ITEM_STATUSES = ["open", "in_progress", "promoted", "done", "dropped"];
const OPEN = new Set(["open", "in_progress"]);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Fields a caller may set on an item via backlog_set (id is structural, set only at add).
const ITEM_SETTABLE = new Set([
  "title", "kind", "status", "priority", "source", "refs", "touches",
  "est_sessions", "gate", "prompt", "prs", "completed_on", "promoted_to", "linear", "dispatch_tier", "receipts",
]);

// ── validation (plain object) ───────────────────────────────────────────────
export function validateBacklog(backlog) {
  const errors = [];
  const warnings = [];
  const meta = (backlog && backlog.meta) || {};
  if (meta.schema_version !== 1) errors.push(`backlog meta.schema_version must be 1 (got ${JSON.stringify(meta.schema_version)})`);
  const items = (backlog && backlog.items) || [];
  const seen = new Set();
  for (const it of items) {
    const where = `backlog/${it.id || "?"}`;
    if (!it.id || !SLUG.test(it.id)) errors.push(`${where}: id required (lowercase slug)`);
    else if (seen.has(it.id)) errors.push(`duplicate backlog id "${it.id}"`);
    seen.add(it.id);
    if (!it.title) errors.push(`${where}: title required`);
    if (!KINDS.includes(it.kind)) errors.push(`${where}: kind "${it.kind}" is not one of ${KINDS.join("|")}`);
    if (!ITEM_STATUSES.includes(it.status)) errors.push(`${where}: status "${it.status}" is not one of ${ITEM_STATUSES.join("|")}`);
    for (const e of validatePriority(it.priority, where).errors) errors.push(e);
    if (it.est_sessions != null && (typeof it.est_sessions !== "number" || it.est_sessions < 0)) {
      errors.push(`${where}: est_sessions must be a number >= 0`);
    }
    if (it.status === "promoted" && !it.promoted_to) warnings.push(`${where}: promoted but promoted_to is unset (no back-link)`);
  }
  return { errors, warnings, itemCount: items.length };
}

// ── Document helpers + mutations (yaml AST; mirror mcp-core's style) ─────────
function itemsSeq(doc) {
  const s = doc.get("items");
  if (!s || !s.items) throw new Error("backlog has no items sequence");
  return s;
}
function itemLocById(doc, id) {
  const items = itemsSeq(doc).items;
  for (let i = 0; i < items.length; i++) if (String(items[i].get("id")) === id) return i;
  return -1;
}

// Next free auto-id b1..bN. Scans the local doc AND any caller-supplied id list — the IO
// layers pass origin/main's ids (store.originBacklogIds) so concurrent sessions allocating
// against stale checkouts stop minting the same bNN (five live collisions on 2026-07-10).
// Custom slugs don't collide with the counter.
function nextAutoId(doc, alsoIds = []) {
  let max = 0;
  const bump = (id) => { const m = /^b(\d+)$/.exec(String(id)); if (m) max = Math.max(max, Number(m[1])); };
  for (const it of itemsSeq(doc).items) bump(it.get("id"));
  for (const id of alsoIds) bump(id);
  return `b${max + 1}`;
}

export function addItem(doc, args) {
  if (!args || !args.title) throw new Error("backlog_add requires title");
  const originIds = args.origin_ids || [];
  const id = args.id || nextAutoId(doc, originIds);
  if (itemLocById(doc, id) >= 0) throw new Error(`backlog item "${id}" already exists`);
  // An explicit id that origin/main already holds is the OTHER half of the id race — the
  // local file hasn't pulled it yet, so the local-duplicate check above can't see it.
  if (args.id && originIds.includes(String(args.id))) {
    throw new Error(`backlog item "${args.id}" already exists on origin/main — pull/rebase first, or choose another id`);
  }
  const node = { id, title: args.title, kind: args.kind || "chore", status: args.status || "open" };
  for (const k of ["priority", "source", "refs", "touches", "est_sessions", "gate", "prompt", "linear", "dispatch_tier"]) {
    if (args[k] != null) node[k] = args[k];
  }
  // createNode: addIn stores a plain object un-wrapped, which breaks later AST reads (.get)
  // on the same Document (e.g. a second add in one mutation batch).
  doc.addIn(["items"], doc.createNode(node));
  return { added: id };
}

export function setItemFields(doc, args) {
  if (!args || !args.id || !args.fields) throw new Error("backlog_set requires id + fields");
  const i = itemLocById(doc, args.id);
  if (i < 0) throw new Error(`no backlog item "${args.id}"`);
  const changed = [];
  for (const [k, v] of Object.entries(args.fields)) {
    if (!ITEM_SETTABLE.has(k)) throw new Error(`field "${k}" is not settable on a backlog item`);
    if (v === null) doc.deleteIn(["items", i, k]);
    else doc.setIn(["items", i, k], v);
    changed.push(k);
  }
  return { updated: args.id, fields: changed };
}

// Pre-write gate: throws if the edited Document would corrupt the backlog; returns the
// plain backlog on success so the caller hands it straight to renderBacklogMarkdown.
export function validateBacklogDocOrThrow(doc) {
  const backlog = doc.toJS();
  const { errors } = validateBacklog(backlog);
  if (errors.length) throw new Error(`edit would corrupt the backlog: ${errors[0]}`);
  return backlog;
}

// ── ordering + counts ────────────────────────────────────────────────────────
// Stable priority sort (JS sort is stable: equal priorities keep capture order).
export function sortByPriority(items) {
  return [...items].sort((a, b) => comparePriority(a.priority, b.priority));
}
export function openItems(backlog) {
  return ((backlog && backlog.items) || []).filter((it) => OPEN.has(it.status));
}
export function openCount(backlog) {
  return openItems(backlog).length;
}

// ── BACKLOG.md renderer (pure: backlog -> markdown) ──────────────────────────
export function renderBacklogMarkdown(backlog) {
  const items = (backlog && backlog.items) || [];
  const lines = [];
  const w = (s = "") => lines.push(s);
  const B = "`";

  w("<!-- GENERATED from docs/roadmap/backlog.yaml (roadmap backlog / the backlog_* MCP tools). Do not edit this file directly — edit the YAML and re-render. -->");
  w("# Backlog — the erratic-work tracker");
  w("");
  w(`> ${openCount(backlog)} open item(s). Roadmap = planned feature/value work; backlog = the follow-up, trivial, or urgent work that surfaces erratically. Capture with ${B}/backlog${B} or ${B}roadmap backlog add${B}; launch a small item directly with ${B}roadmap grab <id>${B}; promote a bigger one into the roadmap with ${B}roadmap promote <id> --pi <pi>${B}.`);
  w("");

  const open = sortByPriority(items.filter((it) => it.status === "open"));
  const tierOf = (it) => tierBadge(it.priority) || "Untriaged";
  for (const tier of [...TIERS, "Untriaged"]) {
    const group = open.filter((it) => tierOf(it) === tier);
    if (!group.length) continue;
    w(`## ${tier}`);
    w("");
    table(group);
  }
  if (!open.length) {
    w("_No open items._");
    w("");
  }

  const inProgress = sortByPriority(items.filter((it) => it.status === "in_progress"));
  if (inProgress.length) {
    w("## In progress");
    w("");
    table(inProgress);
  }
  const promoted = items.filter((it) => it.status === "promoted");
  if (promoted.length) {
    w("## Promoted to the roadmap");
    w("");
    w("| Id | Title | Now at |");
    w("|---|---|---|");
    for (const it of promoted) w(`| ${B}${it.id}${B} | ${esc(it.title)} | ${it.promoted_to ? B + it.promoted_to + B : "—"} |`);
    w("");
  }
  const closed = items.filter((it) => it.status === "done" || it.status === "dropped");
  if (closed.length) {
    w("## Recently closed");
    w("");
    w("| Id | Title | Status | PRs | Closed |");
    w("|---|---|---|---|---|");
    for (const it of closed) w(`| ${B}${it.id}${B} | ${esc(it.title)} | ${it.status} | ${(it.prs || []).join(" ") || "—"} | ${it.completed_on || "—"} |`);
    w("");
  }
  return lines.join("\n") + "\n";

  function table(group) {
    w("| Id | Kind | Wt | Title | Est | Source | Refs |");
    w("|---|---|---|---|---|---|---|");
    for (const it of group) {
      const wt = it.priority && it.priority.weight != null ? it.priority.weight : "—";
      const reason = it.priority && it.priority.reason ? ` _(${esc(it.priority.reason)})_` : "";
      const src = it.source ? [it.source.slice && B + it.source.slice + B, it.source.date].filter(Boolean).join(" ") : "—";
      const refs = (it.refs || []).map((r) => B + r + B).join(", ") || "—";
      w(`| ${B}${it.id}${B} | ${it.kind} | ${wt} | ${esc(it.title)}${reason} | ${it.est_sessions != null ? "~" + it.est_sessions : "?"} | ${src || "—"} | ${refs} |`);
    }
    w("");
  }
  function esc(s) {
    return String(s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  }
}

// ── item → node adapter ──────────────────────────────────────────────────────
// Shapes a backlog item like a flattened sprint node so brief.mjs (branchFor / worktreeFor /
// synthesizeBrief / launchPrompt) works unchanged: branch backlog/<id>, worktree <root>/backlog-<id>.
// ponytail: collides only if a real PI is literally named "backlog" AND has a sprint id == item id.
export function backlogItemToNode(item) {
  return {
    nodeKey: `backlog/${item.id}`,
    piId: "backlog",
    piTitle: "Backlog",
    programLabel: "BACKLOG",
    id: item.id,
    invoke: item.id,
    title: item.title,
    status: item.status === "in_progress" ? "active" : "next",
    statusLabel: null,
    what: item.title,
    estSessions: typeof item.est_sessions === "number" ? item.est_sessions : null,
    deps: [], piDeps: [], rawDeps: [],
    touches: item.touches || [],
    owns: [],
    gate: item.gate || "default",
    gatedOn: null,
    optional: false,
    execution: null,
    track: null,
    priority: item.priority || null,
    prompt: item.prompt || null,
    readOrder: [],
    resumeAction: (item.source && item.source.note) || "",
    kickoffBrief: "brief",
    prs: item.prs || [],
    completedOn: item.completed_on || null,
  };
}

// ── pickNext: the single highest-priority ready thing across both trackers ───
// Roadmap wins full ties (planned value work outranks erratic work at equal priority).
// backlog may be null (no backlog.yaml). Returns { type: "slice"|"backlog", node|item } or null.
export function pickNext(graph, backlog) {
  const ready = readyNodes(flatten(graph));
  const topSlice = ready.length
    ? [...ready].sort((a, b) => {
        const pc = comparePriority(a.priority, b.priority);
        if (pc) return pc;
        return a.invoke.localeCompare(b.invoke);
      })[0]
    : null;
  const open = backlog ? sortByPriority(((backlog.items) || []).filter((it) => it.status === "open")) : [];
  const topItem = open[0] || null;
  if (!topSlice && !topItem) return null;
  if (!topItem) return { type: "slice", node: topSlice };
  if (!topSlice) return { type: "backlog", item: topItem };
  return comparePriority(topItem.priority, topSlice.priority) < 0
    ? { type: "backlog", item: topItem }
    : { type: "slice", node: topSlice };
}

// ── promote: backlog item → roadmap sprint (both Documents, caller writes) ───
// The item's id becomes the sprint's invoke key (a collision with an existing invoke is
// rejected by the roadmap's pre-write gate). The caller (store.mutateBoth) validates BOTH
// documents before writing either.
export function performPromotion(rDoc, bDoc, { id, pi, sprint_id } = {}) {
  if (!id || !pi) throw new Error("promote requires a backlog id and a --pi target");
  const item = ((bDoc.toJS().items) || []).find((it) => it.id === id);
  if (!item) throw new Error(`no backlog item "${id}"`);
  if (item.status !== "open" && item.status !== "in_progress") {
    throw new Error(`backlog item "${id}" is ${item.status} — only open/in_progress items promote`);
  }
  const piObj = ((rDoc.toJS().pis) || []).find((p) => p.id === pi);
  if (!piObj) throw new Error(`no PI "${pi}"`);
  let sid = sprint_id;
  if (!sid) {
    let max = 0;
    for (const s of piObj.sprints || []) {
      const m = /^s(\d+)$/.exec(String(s.id));
      if (m) max = Math.max(max, Number(m[1]));
    }
    sid = `s${max + 1}`;
  }
  const args = { pi, id: sid, title: item.title, invoke: item.id, status: "scheduled", what: item.title };
  for (const k of ["est_sessions", "gate", "prompt", "priority"]) if (item[k] != null) args[k] = item[k];
  if (Array.isArray(item.touches) && item.touches.length) args.touches = item.touches;
  // The item's Linear issue TRANSFERS to the sprint (same issue continues life as roadmap
  // work — next sync morphs its description/labels/project). Leaving it on the item would
  // orphan an open issue on the board and double-map the identifier.
  if (item.linear) args.linear = item.linear;
  addSprint(rDoc, args);
  setItemFields(bDoc, { id, fields: { status: "promoted", promoted_to: `${pi}/${sid}`, ...(item.linear ? { linear: null } : {}) } });
  return { promoted: id, to: `${pi}/${sid}` };
}

// ── MCP tool registry (spread into TOOLS by mcp.mjs) ─────────────────────────
const PRIORITY_SCHEMA = { type: "object", properties: {
  tier: { enum: ["P0", "P1", "P2", "P3"] }, weight: { type: "number", minimum: 0, maximum: 100 }, reason: { type: "string" } } };

export const BACKLOG_TOOLS = [
  { name: "backlog_list", description: "Backlog items, priority-sorted. Read-only. all=true includes promoted/done/dropped.",
    inputSchema: { type: "object", properties: { all: { type: "boolean" } } } },
  { name: "backlog_add", description: "Add a backlog item (erratic/follow-up/urgent work). Creates docs/roadmap/backlog.yaml on first use; re-renders BACKLOG.md. id auto-assigned (b1..bN) when omitted.",
    inputSchema: { type: "object", required: ["title"], properties: {
      title: { type: "string" }, id: { type: "string" }, kind: { enum: KINDS },
      priority: PRIORITY_SCHEMA,
      source: { type: "object", properties: { slice: { type: "string" }, date: { type: "string" }, note: { type: "string" },
        linear: { type: "object", properties: { team: { type: "string" }, project: { type: "string" }, issue: { type: "string" } } } } },
      refs: { type: "array", items: { type: "string" } }, touches: { type: "array", items: { type: "string" } },
      est_sessions: { type: "number" }, gate: { type: "string" }, prompt: { type: "string" }, linear: { type: "string" },
      dispatch_tier: { type: "string" },
      origin_ids: { type: "array", items: { type: "string" }, description: "ids already taken upstream (the MCP server injects origin/main's ids automatically; callers normally omit this)" } } } },
  { name: "backlog_set", description: "Set allowed fields on a backlog item (by id). null value deletes a field. Re-renders BACKLOG.md.",
    inputSchema: { type: "object", required: ["id", "fields"], properties: {
      id: { type: "string" }, fields: { type: "object" } } } },
  { name: "backlog_promote", description: "Promote a backlog item into a roadmap sprint (item id becomes the invoke key; carries title/est/gate/touches/prompt/priority; back-links promoted_to). Both YAMLs validated before either is written; re-renders both generated views.",
    inputSchema: { type: "object", required: ["id", "pi"], properties: {
      id: { type: "string" }, pi: { type: "string" }, sprint_id: { type: "string" } } } },
];

export function readBacklogList(backlog, args = {}) {
  if (!backlog) return { items: [], note: "no docs/roadmap/backlog.yaml yet — backlog_add creates it" };
  const items = args.all ? backlog.items || [] : openItems(backlog);
  return { items: sortByPriority(items), open: openCount(backlog) };
}

export const BACKLOG_READ_HANDLERS = { backlog_list: readBacklogList };
export const BACKLOG_MUTATION_HANDLERS = { backlog_add: addItem, backlog_set: setItemFields };
