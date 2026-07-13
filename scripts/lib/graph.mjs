// roadmap — graph brain.
// Loads roadmap.yaml, flattens PIs→sprint nodes, resolves dependency edges,
// detects cycles, derives the exec-plan line + session rollups, and computes
// the fanout waves. Every consumer (render, validate, scheduler) goes through here
// so the human-facing view and the executed plan can never disagree.

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { comparePriority, laneComparator } from "./priority.mjs";

export const STATUS = {
  active:      { emoji: "🟢", label: "Active",      done: false, rank: 0 },
  next:        { emoji: "🟡", label: "Next",        done: false, rank: 1 },
  scheduled:   { emoji: "⚪", label: "Scheduled",   done: false, rank: 2 },
  complete:    { emoji: "✅", label: "Complete",    done: true,  rank: 9 },
  blocked:     { emoji: "🔴", label: "Blocked",     done: false, rank: 3 },
  paused:      { emoji: "⏸️", label: "Paused",      done: false, rank: 4 },
  gated:       { emoji: "🔒", label: "Gated",       done: false, rank: 5 },
  optionality: { emoji: "🟣", label: "Optionality", done: false, rank: 8 },
};

export function emojiFor(status) {
  return (STATUS[status] || { emoji: "❔" }).emoji;
}
export function statusDisplay(status, statusLabel) {
  const meta = STATUS[status] || { emoji: "❔", label: status };
  return `${meta.emoji} ${statusLabel || meta.label}`;
}
export function isDone(status) {
  return !!(STATUS[status] && STATUS[status].done);
}

export function loadGraph(path) {
  const raw = readFileSync(path, "utf8");
  const doc = YAML.parse(raw);
  if (!doc || typeof doc !== "object") {
    throw new Error(`roadmap.yaml at ${path} did not parse to an object`);
  }
  return doc;
}

// Flatten to a node list. Each node carries its PI context, its resolved
// dependency node-keys, and the raw fields. nodeKey = `${piId}/${sprintId}`.
export function flatten(graph) {
  const pis = graph.pis || [];
  const sprintIndex = new Map();   // nodeKey -> node
  const piIndex = new Map();       // piId -> pi
  const invokeIndex = new Map();   // invoke -> nodeKey
  const nodes = [];

  for (const pi of pis) {
    piIndex.set(pi.id, pi);
    for (const sp of pi.sprints || []) {
      const nodeKey = `${pi.id}/${sp.id}`;
      const node = {
        nodeKey,
        piId: pi.id,
        piTitle: pi.title,
        piStatus: pi.status,
        programLabel: pi.program_label || pi.id.toUpperCase(),
        id: sp.id,
        invoke: sp.invoke,
        title: sp.title,
        status: sp.status,
        statusLabel: sp.status_label || null,
        what: sp.what || sp.title,
        estSessions: typeof sp.est_sessions === "number" ? sp.est_sessions : null,
        estMinutes: sp.estimate && sp.estimate.minutes ? sp.estimate.minutes : null,   // { low, expected, high } from agent-time; drives the timeline rollup
        rawDeps: sp.deps || [],
        deps: [],        // resolved sprint nodeKeys
        piDeps: [],      // resolved PI ids this sprint waits on
        touches: sp.touches || [],
        owns: sp.owns || [],
        gate: sp.gate || "default",
        gatedOn: sp.gated_on || null,
        optional: !!sp.optional,
        execution: sp.execution || null,   // optional staffing-strategy hint (see lib/execution.mjs)
        track: sp.track || null,            // optional lane label for the three-track partition (--track)
        priority: sp.priority || null,      // optional { tier, weight, reason } (see lib/priority.mjs)
        prompt: sp.prompt || null,          // optional author-stashed pickup instructions
        linear: sp.linear || null,          // optional Linear issue identifier (see lib/linear-core.mjs)
        dispatchTier: sp.dispatch_tier || null, // optional cloud-routine tier (see dispatch.mjs resolveRoutine)
        readOrder: sp.read_order || [],
        resumeAction: sp.resume_action || "",
        kickoffBrief: sp.kickoff_brief || "brief",
        prs: sp.prs || [],
        receipts: sp.receipts || null,   // optional per-slice completion evidence (see validate-core required_receipts)
        outcome: sp.outcome || null,     // optional founder-review rollup group (render groups siblings by this)
        completedOn: sp.completed_on || null,
        pi,
        sprint: sp,
      };
      nodes.push(node);
      sprintIndex.set(nodeKey, node);
      if (sp.invoke) {
        if (invokeIndex.has(sp.invoke)) {
          throw new Error(`duplicate invoke key "${sp.invoke}" (${invokeIndex.get(sp.invoke)} and ${nodeKey})`);
        }
        invokeIndex.set(sp.invoke, nodeKey);
      }
    }
  }

  // Resolve dependency edges now that every node exists.
  for (const node of nodes) {
    for (const dep of node.rawDeps) {
      if (dep.includes("/")) {                       // fully-qualified pi/sprint
        if (!sprintIndex.has(dep)) {
          throw new Error(`${node.nodeKey}: dep "${dep}" does not resolve to a sprint`);
        }
        node.deps.push(dep);
      } else if (sprintIndex.has(`${node.piId}/${dep}`)) {   // sibling sprint id
        node.deps.push(`${node.piId}/${dep}`);
      } else if (piIndex.has(dep)) {                  // a whole PI
        node.piDeps.push(dep);
      } else if (invokeIndex.has(dep)) {              // tolerate an invoke key as a dep
        node.deps.push(invokeIndex.get(dep));
      } else {
        throw new Error(`${node.nodeKey}: dep "${dep}" matches no sprint id, pi/sprint, PI id, or invoke key`);
      }
    }
  }

  return { nodes, sprintIndex, piIndex, invokeIndex, pis };
}

// PI-dep satisfied iff every sprint of that PI is complete.
function piComplete(piId, sprintIndex) {
  for (const node of sprintIndex.values()) {
    if (node.piId === piId && !isDone(node.status)) return false;
  }
  return true;
}

// 3-color DFS cycle detection over sprint deps (+ PI-deps expanded to that PI's sprints).
export function detectCycle(model) {
  const { nodes, sprintIndex } = model;
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map((n) => [n.nodeKey, WHITE]));
  const adj = new Map();
  for (const n of nodes) {
    const outs = [...n.deps];
    for (const piId of n.piDeps) {
      for (const m of nodes) if (m.piId === piId) outs.push(m.nodeKey);
    }
    adj.set(n.nodeKey, outs);
  }
  const stack = [];
  function dfs(key) {
    color.set(key, GRAY);
    stack.push(key);
    for (const next of adj.get(key) || []) {
      if (color.get(next) === GRAY) {
        const from = stack.indexOf(next);
        return [...stack.slice(from), next];
      }
      if (color.get(next) === WHITE) {
        const cyc = dfs(next);
        if (cyc) return cyc;
      }
    }
    color.set(key, BLACK);
    stack.pop();
    return null;
  }
  for (const n of nodes) {
    if (color.get(n.nodeKey) === WHITE) {
      const cyc = dfs(n.nodeKey);
      if (cyc) return cyc; // array of nodeKeys forming the cycle
    }
  }
  return null;
}

function depsSatisfied(node, sprintIndex) {
  for (const dep of node.deps) {
    const d = sprintIndex.get(dep);
    if (!d || !isDone(d.status)) return false;
  }
  for (const piId of node.piDeps) {
    if (!piComplete(piId, sprintIndex)) return false;
  }
  return true;
}

// Held statuses: not-done, not-active — a slice that can't auto-schedule and isn't being
// worked. The one source of truth (linear-core's held labels + review-core's aging both
// import this, so a new held-like status is added in exactly one place).
export const HELD_STATUSES = ["blocked", "paused", "gated"];
const READY_BLOCKING = new Set(HELD_STATUSES);

// The pool of slices that COULD start now: deps satisfied, not done, not blocked/gated.
// (Ignores file contention — that's a wave-packing concern, handled in computeWaves.)
export function readyNodes(model) {
  const { nodes, sprintIndex } = model;
  return nodes.filter(
    (n) => !isDone(n.status) && !READY_BLOCKING.has(n.status) && !n.gatedOn && depsSatisfied(n, sprintIndex)
  );
}

// Sessions remaining to clear a PI = sum of est_sessions over its not-complete sprints.
export function sessionsRemaining(pi) {
  return (pi.sprints || []).reduce((acc, sp) => {
    if (isDone(sp.status)) return acc;
    return acc + (typeof sp.est_sessions === "number" ? sp.est_sessions : 0);
  }, 0);
}

// Derive the compact exec-plan line for a PI from INTRA-PI sprint deps among the
// NOT-YET-COMPLETE sprints (the remaining execution shape): longest-path layering;
// same-level sprints with no edge between them are parallel.
// e.g. "(S0 ∥ S1)→S2→S3". Optional sprints get a trailing "?".
export function execPlan(pi) {
  const sprints = (pi.sprints || []).filter((s) => !isDone(s.status));
  if (sprints.length === 0) return "";
  if (sprints.length === 1) {
    return sprints.map((s) => label(s)).join("");
  }
  const byId = new Map(sprints.map((s) => [s.id, s]));
  const intraDeps = (s) => (s.deps || []).filter((d) => byId.has(d)); // only same-PI edges
  const level = new Map();
  function lvl(id, seen = new Set()) {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) return 0; // defensive; real cycles caught by detectCycle
    seen.add(id);
    const deps = intraDeps(byId.get(id));
    const v = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => lvl(d, seen)));
    level.set(id, v);
    return v;
  }
  for (const s of sprints) lvl(s.id);
  const layers = [];
  for (const s of sprints) {
    const v = level.get(s.id);
    (layers[v] ||= []).push(s);
  }
  return layers
    .filter(Boolean)
    .map((group) => {
      const parts = group.map((s) => label(s));
      return parts.length > 1 ? `(${parts.join(" ∥ ")})` : parts[0];
    })
    .join("→");

  function label(s) {
    const base = s.id.toUpperCase();
    return s.optional ? `${base}?` : base;
  }
}

// Wave-packing coherence knob: prefer finishing STARTED PIs over opening fresh ones, so a
// capped wave doesn't leave every PI half-open. Strictly subordinate to declared priority.
// meta.discipline.coherence: false restores pure priority/status/est ordering.
export function coherenceEnabled(meta) {
  return !(meta && meta.discipline && meta.discipline.coherence === false);
}

// Command lane: meta.command_lane = { objective, until: "YYYY-MM-DD", pi?, slices?: [invoke,...] }.
// A dated objective that outranks generic priority until its date passes OR its slices all complete —
// so the roadmap makes finishing the most important outcome easier than discovering the next slice.
// members(): the set of slice invoke keys in the lane (by explicit `slices` and/or every sprint of `pi`).
export function commandLaneMembers(graph) {
  const lane = graph && graph.meta && graph.meta.command_lane;
  if (!lane) return new Set();
  const members = new Set();
  if (Array.isArray(lane.slices)) for (const s of lane.slices) members.add(s);
  if (lane.pi) for (const pi of graph.pis || []) if (pi.id === lane.pi) for (const sp of pi.sprints || []) if (sp.invoke) members.add(sp.invoke);
  return members;
}

// active: lane set, not past `until` (YYYY-MM-DD lexical compare), and >=1 member slice still open.
// Once every member ships (or the date passes) the override releases and ordering returns to normal.
// `today` is injected (a YYYY-MM-DD string) so the gate is testable and deterministic.
export function commandLaneActive(graph, today) {
  const lane = graph && graph.meta && graph.meta.command_lane;
  if (!lane) return false;
  if (lane.until && today && String(today) > lane.until) return false;
  const members = commandLaneMembers(graph);
  if (!members.size) return false;
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) {
    if (sp.invoke && members.has(sp.invoke) && !isDone(sp.status)) return true;
  }
  return false;
}

// Compute execution waves under a concurrency cap N.
// Returns { waves: [[node,...],...], held: { onHuman:[node], blocked:[node] } }.
// opts.coherence (default true): PI-coherence tiebreak in the ready sort — see coherenceEnabled.
// opts.meta + opts.today: an active command lane (see commandLaneMembers/Active) floats its member
//   slices to the top of the ready sort. Both absent → lane inactive → ordering byte-identical to today.
export function computeWaves(model, N = 3, opts = {}) {
  const coherence = opts.coherence !== false;
  const { nodes, sprintIndex } = model;
  const cyc = detectCycle(model);
  if (cyc) {
    const err = new Error(`dependency cycle: ${cyc.join(" → ")}`);
    err.cycle = cyc;
    throw err;
  }

  // Command-lane boost, computed once per call. model.pis is graph.pis; meta rides in via opts.
  const laneGraph = { meta: opts.meta, pis: model.pis };
  const laneMembers = commandLaneMembers(laneGraph);
  const laneActive = commandLaneActive(laneGraph, opts.today);
  const laneCmp = laneComparator(laneMembers, laneActive);

  // Work on a mutable copy of statuses so optimistic completion drives layering.
  const status = new Map(nodes.map((n) => [n.nodeKey, n.status]));
  const localDone = (key) => isDone(status.get(key));
  const localDepsSatisfied = (node) => {
    for (const dep of node.deps) if (!localDone(dep)) return false;
    for (const piId of node.piDeps) {
      for (const m of nodes) if (m.piId === piId && !localDone(m.nodeKey)) return false;
    }
    return true;
  };

  let remaining = nodes.filter((n) => !isDone(n.status));
  const waves = [];

  while (remaining.length) {
    const ready = remaining.filter(
      (n) => !READY_BLOCKING.has(n.status) && !n.gatedOn && localDepsSatisfied(n)
    );
    if (!ready.length) break;

    // Per-iteration PI coherence stats over the OPTIMISTIC statuses: a PI counts as started
    // once any sprint is done/active (incl. waves already packed this run); `remaining` drives
    // "closest to done first". Siblings share a rank, so the cap fills contiguously.
    const coh = new Map();
    if (coherence) {
      for (const n of nodes) {
        const s = coh.get(n.piId) || { started: false, remaining: 0 };
        const st = status.get(n.nodeKey);
        if (isDone(st) || st === "active") s.started = true;
        if (!isDone(st)) s.remaining += 1;
        coh.set(n.piId, s);
      }
    }

    ready.sort((a, b) => {
      const lc = laneCmp(a, b);                             // active command lane floats its members first
      if (lc) return lc;                                    // inactive/absent → 0 → priority, coherence, existing order
      const pc = comparePriority(a.priority, b.priority);  // declared priority wins the cap slot
      if (pc) return pc;                                    // both absent → 0 → coherence, then existing order
      if (coherence && a.piId !== b.piId) {
        const ca = coh.get(a.piId), cb = coh.get(b.piId);
        if (ca.started !== cb.started) return ca.started ? -1 : 1;   // finish started PIs first
        if (ca.remaining !== cb.remaining) return ca.remaining - cb.remaining;  // closest-to-done first
      }
      const ra = (STATUS[a.status] || {}).rank ?? 7;
      const rb = (STATUS[b.status] || {}).rank ?? 7;
      if (ra !== rb) return ra - rb;
      const ea = a.estSessions ?? 99, eb = b.estSessions ?? 99;
      if (ea !== eb) return ea - eb;
      return a.invoke.localeCompare(b.invoke);
    });

    const wave = [];
    const claimed = new Set();
    for (const n of ready) {
      if (wave.length >= N) break;
      const files = [...n.touches, ...n.owns];
      if (files.some((f) => claimed.has(f))) continue; // two-wave: file contention defers
      wave.push(n);
      files.forEach((f) => claimed.add(f));
    }
    if (!wave.length) break; // pure contention with empty file sets shouldn't happen, guard anyway

    waves.push(wave);
    wave.forEach((n) => status.set(n.nodeKey, "complete")); // optimistic for layering
    const inWave = new Set(wave.map((n) => n.nodeKey));
    remaining = remaining.filter((n) => !inWave.has(n.nodeKey));
  }

  const onHuman = remaining.filter((n) => n.gatedOn);
  const blocked = remaining.filter((n) => !n.gatedOn);
  return { waves, held: { onHuman, blocked } };
}

// Resolve a sprint's gate string, interpolating {{default}} / 'default'.
export function resolveGate(node, graph) {
  const def = (graph.meta && graph.meta.default_gate) || "";
  if (!node.gate || node.gate === "default") return def;
  return node.gate.replace(/\{\{\s*default\s*\}\}/g, def);
}
