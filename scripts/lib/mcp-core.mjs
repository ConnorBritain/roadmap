// roadmap — MCP brain (PURE). Tool registry, read handlers, YAML-Document mutation
// functions, and the pre-write integrity gate. No IO: the server (mcp.mjs) does the fs reads,
// writes, and JSON-RPC. Mutations operate on a `yaml` Document (parseDocument) so comments and
// formatting in roadmap.yaml survive the edit; reads operate on a plain graph object.

import { flatten, detectCycle, STATUS } from "./graph.mjs";
import { buildPlan } from "./plan.mjs";
import { validateGraph } from "./validate-core.mjs";
import { normalizeExecution, suggestedConcurrency, validateExecution } from "./execution.mjs";

const STATUSES = Object.keys(STATUS);
const VALID_STATUS = new Set(STATUSES);
const DONE = new Set(STATUSES.filter((s) => STATUS[s].done));

// Fields a caller may set on a sprint via set_fields / add_sprint (allow-list; protects id/invoke
// integrity by omission — invoke is set only at creation, ids are structural).
const SETTABLE = new Set([
  "title", "what", "status", "status_label", "est_sessions", "weight",
  "deps", "touches", "owns", "gate", "gated_on", "read_order", "resume_action",
  "prs", "completed_on", "optional", "execution", "track",
]);

// ── tool registry ─────────────────────────────────────────────────────────────
export const TOOLS = [
  { name: "plan", description: "Recommended concurrency cap + execution waves + held-on-human. Read-only.",
    inputSchema: { type: "object", properties: { cap: { type: "integer", minimum: 1 }, reviewCeiling: { type: "integer", minimum: 1 } } } },
  { name: "ready_wave", description: "The slices runnable right now (wave 1) under the recommended or given cap. Read-only.",
    inputSchema: { type: "object", properties: { cap: { type: "integer", minimum: 1 } } } },
  { name: "show", description: "One slice's detail by its invoke key. Read-only.",
    inputSchema: { type: "object", required: ["invoke"], properties: { invoke: { type: "string" } } } },
  { name: "validate", description: "Structural + dependency + cycle checks. Returns { ok, errors, warnings }. Read-only.",
    inputSchema: { type: "object", properties: {} } },
  { name: "add_pi", description: "Append a new PI (program increment). Validates and re-renders SLICES.md.",
    inputSchema: { type: "object", required: ["id", "title"], properties: {
      id: { type: "string" }, title: { type: "string" }, status: { enum: STATUSES },
      theme: { type: "string" }, program_label: { type: "string" }, estimate_weeks: { type: "string" },
      exit_criteria: { type: "string" }, deps: { type: "array", items: { type: "string" } } } } },
  { name: "add_sprint", description: "Append a sprint to an existing PI. Validates and re-renders SLICES.md.",
    inputSchema: { type: "object", required: ["pi", "id", "title", "invoke"], properties: {
      pi: { type: "string" }, id: { type: "string" }, title: { type: "string" }, invoke: { type: "string" },
      status: { enum: STATUSES }, what: { type: "string" }, est_sessions: { type: "number" },
      deps: { type: "array", items: { type: "string" } }, touches: { type: "array", items: { type: "string" } },
      owns: { type: "array", items: { type: "string" } }, gate: { type: "string" },
      weight: { enum: ["heavy", "medium", "light"] }, gated_on: { type: "string" },
      read_order: { type: "array", items: { type: "string" } }, resume_action: { type: "string" } } } },
  { name: "set_status", description: "Set a slice's status (by invoke), optionally recording PRs + completed_on. Re-renders.",
    inputSchema: { type: "object", required: ["invoke", "status"], properties: {
      invoke: { type: "string" }, status: { enum: STATUSES },
      prs: { type: "array", items: { type: "string" } }, completed_on: { type: "string" } } } },
  { name: "set_fields", description: "Set one or more allowed fields on a slice (by invoke). null value deletes a field. Re-renders.",
    inputSchema: { type: "object", required: ["invoke", "fields"], properties: {
      invoke: { type: "string" }, fields: { type: "object" } } } },
  { name: "prune", description: "Remove a slice (by invoke), a whole PI (by pi id), or every complete slice (scope='completed'). Re-renders SLICES.md. Validated before writing: the removal is rejected with no change made if it would orphan a dependency, duplicate an invoke key, or otherwise break the graph.",
    inputSchema: { type: "object", properties: {
      invoke: { type: "string" }, pi: { type: "string" }, scope: { enum: ["completed"] } } } },
];

// ── read handlers (operate on a plain graph object) ────────────────────────────
export function readPlan(graph, args = {}) {
  return buildPlan(graph, { cap: args.cap, reviewCeiling: args.reviewCeiling });
}
export function readReadyWave(graph, args = {}) {
  const plan = buildPlan(graph, { cap: args.cap });
  return { cap: plan.cap, recommended: plan.recommended, wave: plan.waves[0] || [], held: plan.held };
}
export function readShow(graph, args) {
  if (!args || !args.invoke) throw new Error("show requires invoke");
  const model = flatten(graph);
  const n = model.nodes.find((x) => x.invoke === args.invoke);
  if (!n) throw new Error(`no slice with invoke "${args.invoke}"`);
  return {
    invoke: n.invoke, pi: n.piId, sprint: n.id, title: n.title, status: n.status, what: n.what,
    deps: n.deps, piDeps: n.piDeps, touches: n.touches, owns: n.owns, gate: n.gate,
    gatedOn: n.gatedOn, readOrder: n.readOrder, resumeAction: n.resumeAction,
    estSessions: n.estSessions, prs: n.prs,
    track: n.track, execution: normalizeExecution(n.execution), suggestedConcurrency: suggestedConcurrency(n),
  };
}
export function readValidate(graph) {
  const { errors, warnings, nodeCount } = validateGraph(graph);
  return { ok: errors.length === 0, errors, warnings, nodeCount };
}

export const READ_HANDLERS = { plan: readPlan, ready_wave: readReadyWave, show: readShow, validate: readValidate };

// ── Document helpers (yaml AST navigation) ──────────────────────────────────────
function pisSeq(doc) {
  const s = doc.get("pis");
  if (!s || !s.items) throw new Error("roadmap has no pis sequence");
  return s;
}
function piIndexById(doc, piId) {
  const items = pisSeq(doc).items;
  for (let i = 0; i < items.length; i++) if (String(items[i].get("id")) === piId) return i;
  return -1;
}
function sprintLocByInvoke(doc, invoke) {
  const pis = pisSeq(doc).items;
  for (let i = 0; i < pis.length; i++) {
    const sprints = pis[i].get("sprints");
    const items = (sprints && sprints.items) || [];
    for (let j = 0; j < items.length; j++) {
      if (String(items[j].get("invoke")) === invoke) return { pi: i, sprint: j };
    }
  }
  return null;
}

// ── mutation functions (operate on a yaml Document; mutate in place, return a summary) ──
export function addPi(doc, args) {
  if (!args || !args.id || !args.title) throw new Error("add_pi requires id + title");
  if (piIndexById(doc, args.id) >= 0) throw new Error(`PI "${args.id}" already exists`);
  const node = { id: args.id, title: args.title, status: args.status || "scheduled" };
  for (const k of ["theme", "program_label", "estimate_weeks", "exit_criteria"]) if (args[k] != null) node[k] = args[k];
  if (Array.isArray(args.deps)) node.deps = args.deps;
  node.sprints = [];
  doc.addIn(["pis"], node);
  return { added: "pi", id: args.id };
}

export function addSprint(doc, args) {
  for (const k of ["pi", "id", "title", "invoke"]) if (!args || !args[k]) throw new Error(`add_sprint requires ${k}`);
  const pi = piIndexById(doc, args.pi);
  if (pi < 0) throw new Error(`no PI "${args.pi}"`);
  const node = { id: args.id, title: args.title, status: args.status || "scheduled", invoke: args.invoke };
  for (const k of ["what", "est_sessions", "gate", "weight", "gated_on", "resume_action"]) if (args[k] != null) node[k] = args[k];
  for (const k of ["deps", "touches", "owns", "read_order"]) if (Array.isArray(args[k])) node[k] = args[k];
  const piMap = pisSeq(doc).items[pi];
  if (!piMap.has("sprints") || !piMap.get("sprints")) doc.setIn(["pis", pi, "sprints"], [node]);
  else doc.addIn(["pis", pi, "sprints"], node);
  return { added: "sprint", pi: args.pi, invoke: args.invoke };
}

export function setStatus(doc, args) {
  if (!args || !args.invoke || !args.status) throw new Error("set_status requires invoke + status");
  if (!VALID_STATUS.has(args.status)) throw new Error(`invalid status "${args.status}"`);
  const loc = sprintLocByInvoke(doc, args.invoke);
  if (!loc) throw new Error(`no slice "${args.invoke}"`);
  const base = ["pis", loc.pi, "sprints", loc.sprint];
  doc.setIn([...base, "status"], args.status);
  if (Array.isArray(args.prs)) doc.setIn([...base, "prs"], args.prs);
  if (args.completed_on) doc.setIn([...base, "completed_on"], args.completed_on);
  return { updated: args.invoke, status: args.status };
}

export function setFields(doc, args) {
  if (!args || !args.invoke || !args.fields) throw new Error("set_fields requires invoke + fields");
  const loc = sprintLocByInvoke(doc, args.invoke);
  if (!loc) throw new Error(`no slice "${args.invoke}"`);
  const base = ["pis", loc.pi, "sprints", loc.sprint];
  const changed = [];
  for (const [k, v] of Object.entries(args.fields)) {
    if (!SETTABLE.has(k)) throw new Error(`field "${k}" is not settable`);
    if (v === null) doc.deleteIn([...base, k]);
    else doc.setIn([...base, k], v);
    changed.push(k);
  }
  return { updated: args.invoke, fields: changed };
}

export function prune(doc, args = {}) {
  if (args.invoke) {
    const loc = sprintLocByInvoke(doc, args.invoke);
    if (!loc) throw new Error(`no slice "${args.invoke}"`);
    doc.deleteIn(["pis", loc.pi, "sprints", loc.sprint]);
    return { pruned: [args.invoke] };
  }
  if (args.pi) {
    const i = piIndexById(doc, args.pi);
    if (i < 0) throw new Error(`no PI "${args.pi}"`);
    doc.deleteIn(["pis", i]);
    return { pruned: [`PI:${args.pi}`] };
  }
  if (args.scope === "completed") {
    const graph = doc.toJS();
    const doneInvokes = [];
    for (const pi of graph.pis || []) for (const sp of pi.sprints || []) if (DONE.has(sp.status) && sp.invoke) doneInvokes.push(sp.invoke);
    for (const inv of doneInvokes) {
      const loc = sprintLocByInvoke(doc, inv);     // re-find each time; indices shift as we delete
      if (loc) doc.deleteIn(["pis", loc.pi, "sprints", loc.sprint]);
    }
    const pis = pisSeq(doc).items;
    for (let i = pis.length - 1; i >= 0; i--) {     // drop PIs left empty, from the end
      const s = pis[i].get("sprints");
      if (!s || !s.items || s.items.length === 0) doc.deleteIn(["pis", i]);
    }
    return { pruned: doneInvokes };
  }
  throw new Error("prune requires one of: invoke, pi, or scope='completed'");
}

export const MUTATION_HANDLERS = { add_pi: addPi, add_sprint: addSprint, set_status: setStatus, set_fields: setFields, prune };

// ── pre-write integrity gate ────────────────────────────────────────────────────
// Throws if the edited Document would corrupt the roadmap (duplicate invoke, unresolved
// dependency, dependency cycle, or an invalid status). Returns the plain graph on success,
// so the server can hand it straight to renderMarkdown.
// Serialize a mutated Document back to YAML with options that MINIMIZE diff churn against a
// hand-authored roadmap.yaml: lineWidth 0 (never re-wrap long scalars like resume_action) and no
// flow-collection padding (match the common ["#1"] / [s1] style). Comments survive either way.
// Residual churn is irreducible when the source mixes flow styles; this picks the lower-churn side.
export function serialize(doc) {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

export function validateDocOrThrow(doc) {
  const graph = doc.toJS();
  let model;
  try {
    model = flatten(graph);   // throws on duplicate invoke / unresolved dep
  } catch (e) {
    throw new Error(`edit would corrupt the roadmap: ${e.message}`);
  }
  const cyc = detectCycle(model);
  if (cyc) throw new Error(`edit would create a dependency cycle: ${cyc.join(" -> ")}`);
  for (const n of model.nodes) {
    if (!VALID_STATUS.has(n.status)) throw new Error(`invalid status "${n.status}" on slice "${n.invoke}"`);
    const { errors } = validateExecution(n.execution, n.invoke);
    if (errors.length) throw new Error(`edit would corrupt the roadmap: ${errors[0]}`);
  }
  return graph;
}
