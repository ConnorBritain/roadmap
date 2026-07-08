// roadmap — "the plate" (PURE): the curated batch that projects to Linear's My Issues (assignee=you).
// meta.plate is an explicit list of slice invoke keys / backlog item ids; the live plate ALSO includes
// whatever you're actively working (active slices, in_progress items) so "what I'm doing" is always on it.
// The feature is OFF (byte-identical, no assignee projection) unless meta.plate is defined.
// No IO: linear.mjs fetches the viewer id + assignee snapshot and does the assign/unassign; this decides.

import { isDone } from "./graph.mjs";

// The set of keys that should be assigned to you right now, or null when the feature is off.
// = meta.plate (explicit) ∪ active slices ∪ in_progress backlog items ("active is always on the plate").
export function platedKeys(graph, backlog = null) {
  const meta = graph.meta || {};
  if (meta.plate == null) return null;
  const keys = new Set(Array.isArray(meta.plate) ? meta.plate.filter((k) => typeof k === "string") : []);
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) if (sp.status === "active" && sp.invoke) keys.add(sp.invoke);
  for (const it of (backlog && backlog.items) || []) if (it.status === "in_progress" && it.id) keys.add(it.id);
  return keys;
}

// Which EXPLICIT meta.plate entries should auto-drain — "complete only": the work finished (slice done,
// or item done/dropped/promoted). Blocked/paused/gated stay (a visible reminder). Active is never here.
// Returns the keys to REMOVE from meta.plate (a subset of the explicit list).
export function plateDrainKeys(graph, backlog = null) {
  const list = (graph.meta && graph.meta.plate) || [];
  if (!Array.isArray(list) || !list.length) return [];
  const done = new Set();
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) if (isDone(sp.status) && sp.invoke) done.add(sp.invoke);
  for (const it of (backlog && backlog.items) || []) if (["done", "dropped", "promoted"].includes(it.status)) done.add(it.id);
  return list.filter((k) => done.has(k));
}

// Set meta.plate to `keys` on a YAML Document (block style — a flow seq goes unreadable once it grows).
// Empty list is written (not deleted) so "the feature is on, batch is empty" stays distinct from "off".
export function setPlateDoc(doc, keys) {
  const node = doc.createNode([...keys]);
  node.flow = false;
  doc.setIn(["meta", "plate"], node);
  return keys.length;
}

// Structural validation + the signal-preservation cap. Reference checking (a key that matches no
// slice/item) is done at projection time (buildPushPlan reports unmatchedPlate) since it needs the backlog.
export function validatePlate(graph, plateMax) {
  const errors = [], warnings = [];
  const p = graph.meta && graph.meta.plate;
  if (p == null) return { errors, warnings };
  if (!Array.isArray(p)) { errors.push("meta.plate must be a list of slice invoke keys / backlog item ids"); return { errors, warnings }; }
  for (const k of p) if (typeof k !== "string") errors.push(`meta.plate entries must be strings (got ${JSON.stringify(k)})`);
  if (plateMax && p.length > plateMax) {
    warnings.push(`meta.plate has ${p.length} explicit entries > plate_max ${plateMax} — trim it so My Issues stays signal (active work adds on top automatically)`);
  }
  return { errors, warnings };
}
