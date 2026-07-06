// roadmap — Linear brain (PURE). Config normalization, zero-network state detection, the
// PI-override ack, status/priority mapping, issue-description building, and the diff-based
// push plan + pull proposals. NO network, NO fs: scripts/linear.mjs does the IO and injects
// snapshots. Shapes are tracker-neutral where possible so a later jira.mjs reuses the diff
// engine — Linear-specific names live in the payloads this module emits and the IO layer.

import { flatten, isDone } from "./graph.mjs";
import { validatePriority } from "./priority.mjs";

// ── config ────────────────────────────────────────────────────────────────────
export const GRANULARITIES = ["pis", "slices", "slices+backlog"];
export const VERBOSITIES = ["title", "brief", "full"];
export const PULL_MODES = ["off", "propose", "auto"];

// meta.linear with defaults applied, or null when absent/teamless (Linear off).
export function normalizeLinearConfig(meta) {
  const raw = meta && meta.linear;
  if (!raw || !raw.team) return null;
  return {
    team: raw.team,
    granularity: raw.granularity || "slices",
    verbosity: raw.verbosity || "brief",
    pull: raw.pull || "off",
    push_on: raw.push_on || "sync",
    status_map: raw.status_map || {},
    watch: (raw.watch || []).map((w) => ({
      team: w.team, project: w.project || null, capture: w.capture || "backlog",
      kind: w.kind || "idea", priority: w.priority || null,
    })),
  };
}

export function effectiveGranularity(cfg, pi) {
  return (pi && pi.linear && pi.linear.granularity) || cfg.granularity;
}

// Validation for validate-core (errors block, warnings surface). Watch `kind` is NOT
// validated here — an invalid kind is caught by the backlog pre-write gate at capture time.
export function validateLinearConfig(graph) {
  const errors = [];
  const warnings = [];
  const raw = graph.meta && graph.meta.linear;
  if (raw != null) {
    if (typeof raw !== "object" || Array.isArray(raw)) errors.push("meta.linear must be a mapping");
    else {
      if (!raw.team) errors.push("meta.linear.team is required (the push-target team key)");
      if (raw.granularity != null && !GRANULARITIES.includes(raw.granularity)) errors.push(`meta.linear.granularity "${raw.granularity}" is not one of ${GRANULARITIES.join("|")}`);
      if (raw.verbosity != null && !VERBOSITIES.includes(raw.verbosity)) errors.push(`meta.linear.verbosity "${raw.verbosity}" is not one of ${VERBOSITIES.join("|")}`);
      if (raw.pull != null && !PULL_MODES.includes(raw.pull)) errors.push(`meta.linear.pull "${raw.pull}" is not one of ${PULL_MODES.join("|")}`);
      if (raw.push_on != null && !["sync", "manual"].includes(raw.push_on)) errors.push(`meta.linear.push_on "${raw.push_on}" is not sync|manual`);
      for (const w of raw.watch || []) {
        if (!w.team) errors.push("meta.linear.watch: every entry needs a team key");
        if (w.capture != null && w.capture !== "backlog") errors.push(`meta.linear.watch: capture "${w.capture}" is not supported (only "backlog")`);
        for (const e of validatePriority(w.priority, "meta.linear.watch").errors) errors.push(e);
      }
    }
  }
  const cfg = normalizeLinearConfig(graph.meta || {});
  for (const pi of graph.pis || []) {
    if (pi.linear && pi.linear.granularity != null) {
      if (!GRANULARITIES.includes(pi.linear.granularity)) errors.push(`PI ${pi.id}: linear.granularity "${pi.linear.granularity}" is not one of ${GRANULARITIES.join("|")}`);
      else if (cfg && pi.linear.granularity !== cfg.granularity) {
        warnings.push(`PI ${pi.id}: linear.granularity "${pi.linear.granularity}" differs from meta.linear.granularity "${cfg.granularity}" — per-PI override in effect`);
      }
    }
    for (const sp of pi.sprints || []) {
      if (sp.linear != null && typeof sp.linear !== "string") errors.push(`${pi.id}/${sp.id}: linear must be a string issue identifier (e.g. ABC-123)`);
    }
  }
  return { errors, warnings };
}

// ── detection (zero network) ──────────────────────────────────────────────────
export function linearState({ meta, env = {}, cursor = null } = {}) {
  const cfg = normalizeLinearConfig(meta || {});
  return {
    configured: !!cfg,
    authed: !!(env.LINEAR_API_KEY && String(env.LINEAR_API_KEY).trim()),
    lastSync: (cursor && cursor.lastSync) || null,
    cfg,
  };
}

// ── PI-override ack (mirrors the --yes-spawn-autonomous double-ack) ───────────
export function checkPiOverrideAck(globalLinear, piLinear, acked, piId) {
  if (!globalLinear || !piLinear || piLinear.granularity == null) return;
  if (piLinear.granularity === globalLinear.granularity) return;
  if (acked) return;
  throw new Error(
    `PI "${piId}" overrides Linear granularity ("${piLinear.granularity}") against the global ` +
    `meta.linear.granularity ("${globalLinear.granularity}") — this PI will push to Linear differently ` +
    `from the rest of the roadmap. Re-run with yes_linear_override: true to confirm the override, ` +
    `or drop linear.granularity from the PI to inherit the global. (Nothing was written.)`
  );
}

// ── status / priority mapping ─────────────────────────────────────────────────
// roadmap tier <-> Linear priority int (0=None, 1=Urgent, 2=High, 3=Medium, 4=Low).
export const PRIORITY_TO_LINEAR = { P0: 1, P1: 2, P2: 3, P3: 4 };
export const LINEAR_TO_PRIORITY = { 1: "P0", 2: "P1", 3: "P2", 4: "P3" };
export const priorityToLinear = (p) => (p && PRIORITY_TO_LINEAR[p.tier]) || 0;

// roadmap status -> Linear workflow-state TYPE (types are stable across teams; names aren't).
// blocked/paused/gated stay "started" on push — the roadmap remains the richer truth.
const STATUS_TYPE_MAP = {
  scheduled: "backlog", optionality: "backlog", next: "unstarted",
  active: "started", blocked: "started", paused: "started", gated: "started",
  complete: "completed",
};
// backlog item status -> state type. promoted items are skipped (the sprint carries them).
const ITEM_TYPE_MAP = { open: "backlog", in_progress: "started", done: "completed", dropped: "canceled" };

// teamStates: [{ id, name, type, position }] sorted by position (IO layer sorts).
export function resolvePushState(status, cfg, teamStates, typeMap = STATUS_TYPE_MAP) {
  const name = cfg.status_map[status];
  if (name) {
    const s = teamStates.find((x) => x.name === name);
    if (!s) {
      throw new Error(`meta.linear.status_map maps "${status}" to "${name}", which is not a workflow state of team ${cfg.team} (available: ${teamStates.map((x) => x.name).join(", ")})`);
    }
    return s;
  }
  const type = typeMap[status] || "backlog";
  const s = teamStates.find((x) => x.type === type);
  if (!s) throw new Error(`team ${cfg.team} has no workflow state of type "${type}"`);
  return s;
}
export const resolveItemPushState = (status, cfg, teamStates) => resolvePushState(status, cfg, teamStates, ITEM_TYPE_MAP);

// Linear state TYPE -> roadmap status, for pull DELTAS (deliberately lossy in reverse;
// canceled maps to "dropped" for items and is flagged for slices by the proposal builder).
export function pullStatusFor(stateType) {
  return ({ backlog: "scheduled", unstarted: "next", started: "active", completed: "complete", canceled: "canceled" })[stateType] || null;
}

// ── issue descriptions (the no-duplication contract) ──────────────────────────
// target: { type: "slice"|"backlog", key }. Never copies read-order/prompt — the footer
// links agents and humans back to the canonical render instead.
export function machineFooter(target, docsUrl) {
  const pickup = target.type === "slice" ? `/slice ${target.key}` : `roadmap grab ${target.key}`;
  const doc = target.type === "slice" ? "SLICES.md" : "BACKLOG.md";
  const link = docsUrl ? `${docsUrl}/docs/${doc}#${target.key}` : `docs/${doc}#${target.key}`;
  return `---\nroadmap: ${target.type}=${target.key} · pick up: ${pickup}\n${link}`;
}

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();

export function issueDescription(node, cfg, { docsUrl = null, target } = {}) {
  const tgt = target || { type: "slice", key: node.invoke };
  const footer = machineFooter(tgt, docsUrl);
  if (cfg.verbosity === "title") return footer;
  const lines = [];
  if (node.what && node.what !== node.title) lines.push(oneLine(node.what));
  if (node.gate) lines.push(`Gate: ${node.gate === "default" ? "default gate" : oneLine(node.gate)}`);
  if (node.estSessions != null) lines.push(`Est: ~${node.estSessions} session(s)`);
  if (cfg.verbosity === "full") {
    if (node.priority && (node.priority.tier || node.priority.reason)) {
      lines.push(`Priority: ${[node.priority.tier, node.priority.weight != null ? `weight ${node.priority.weight}` : null].filter(Boolean).join(" · ")}${node.priority.reason ? ` — ${oneLine(node.priority.reason)}` : ""}`);
    }
    if (node.source) {
      const src = node.source.linear
        ? `Linear ${node.source.linear.team}${node.source.linear.project ? `/${node.source.linear.project}` : ""} (${node.source.linear.issue})`
        : node.source.slice ? `slice ${node.source.slice}` : null;
      if (src) lines.push(`Source: ${src}`);
    }
  }
  return (lines.length ? lines.join("\n") + "\n\n" : "") + footer;
}

// ── push plan (diff-based, idempotent) ────────────────────────────────────────
// existing: the fetched Linear snapshot — { issues: { [identifier]: { id, title, description,
// priority, stateId } }, projects: { [projectId]: { id, name } } }. Ops reference projects
// symbolically (projectRef = pi id); the executor resolves refs after creating projects.
export function buildPushPlan({ graph, backlog, cfg, teamStates, existing, docsUrl = null }) {
  const ops = [];
  const model = flatten(graph);

  for (const pi of graph.pis || []) {
    const gran = effectiveGranularity(cfg, pi);
    const projId = pi.linear && pi.linear.project;
    if (!projId) {
      ops.push({ op: "createProject", payload: { name: pi.title }, projectRef: pi.id,
        writeBack: { kind: "pi", pi: pi.id, field: "project" } });
    } else if (existing.projects[projId] && existing.projects[projId].name !== pi.title) {
      ops.push({ op: "updateProject", id: projId, payload: { name: pi.title } });
    }
    if (gran === "pis") continue;   // projects only — no issue leaks for this PI

    for (const node of model.nodes.filter((n) => n.piId === pi.id)) {
      // create only not-done work (issues for finished history are noise); always update mapped.
      if (!node.linear && isDone(node.status)) continue;
      pushIssueOp(node, { type: "slice", key: node.invoke }, node.status, resolvePushState, pi.id);
    }
  }

  if (cfg.granularity === "slices+backlog" && backlog) {
    for (const it of backlog.items || []) {
      if (it.status === "promoted") continue;   // the promoted sprint carries it
      if (!it.linear && (it.status === "done" || it.status === "dropped")) continue;
      const node = { invoke: it.id, title: it.title, what: it.title, gate: it.gate || null,
        estSessions: it.est_sessions ?? null, priority: it.priority || null, source: it.source || null,
        linear: it.linear || null };
      pushIssueOp(node, { type: "backlog", key: it.id }, it.status, resolveItemPushState, null);
    }
  }
  return { ops };

  function pushIssueOp(node, target, status, resolver, projectRef) {
    const state = resolver(status, cfg, teamStates);
    const projection = {
      title: node.title,
      description: issueDescription(node, cfg, { docsUrl, target }),
      priority: priorityToLinear(node.priority),
      stateId: state.id,
    };
    if (!node.linear) {
      ops.push({ op: "createIssue", payload: projection, projectRef,
        writeBack: target.type === "slice" ? { kind: "sprint", invoke: target.key } : { kind: "item", id: target.key } });
      return;
    }
    const cur = existing.issues[node.linear];
    if (!cur) return;   // mapped but not in snapshot (deleted in Linear?) — leave for the human
    const changed = {};
    for (const k of ["title", "description", "priority", "stateId"]) {
      if (projection[k] !== cur[k]) changed[k] = projection[k];
    }
    if (Object.keys(changed).length) ops.push({ op: "updateIssue", id: cur.id, identifier: node.linear, payload: changed });
  }
}

// ── pull proposals (never mutations) ──────────────────────────────────────────
// inbound: [{ identifier, title, priority, state: { type, name }, team, project }] — mapped-
// issue edits AND watch-source issues, both fetched since the cursor by the IO layer.
// Returns { newItems: [backlog_add args], deltas: [{kind, key, field, from, to, note?}] }.
export function buildPullProposals({ cfg, inbound, graph, backlog }) {
  const model = flatten(graph);
  const byIdentifier = new Map();
  for (const n of model.nodes) if (n.linear) byIdentifier.set(n.linear, { kind: "slice", key: n.invoke, status: n.status, priority: n.priority });
  for (const it of (backlog && backlog.items) || []) if (it.linear) byIdentifier.set(it.linear, { kind: "item", key: it.id, status: it.status, priority: it.priority });

  const newItems = [];
  const deltas = [];
  const seen = new Set();
  for (const iss of inbound || []) {
    if (seen.has(iss.identifier)) continue;   // same issue can arrive via two fetch windows
    seen.add(iss.identifier);
    const known = byIdentifier.get(iss.identifier);
    if (known) {
      const to = pullStatusFor(iss.state && iss.state.type);
      if (to === "canceled") {
        if (known.kind === "item") { if (known.status !== "dropped") deltas.push({ kind: known.kind, key: known.key, field: "status", from: known.status, to: "dropped" }); }
        else deltas.push({ kind: known.kind, key: known.key, field: "status", from: known.status, to: null, note: `canceled in Linear — no roadmap equivalent; decide by hand` });
      } else if (to && to !== known.status && !(known.kind === "item" && to === "active" && known.status === "in_progress")) {
        deltas.push({ kind: known.kind, key: known.key, field: "status", from: known.status, to: known.kind === "item" && to === "active" ? "in_progress" : to });
      }
      const tier = LINEAR_TO_PRIORITY[iss.priority] || null;
      const curTier = (known.priority && known.priority.tier) || null;
      if (tier !== curTier) deltas.push({ kind: known.kind, key: known.key, field: "priority.tier", from: curTier, to: tier });
      continue;
    }
    // Unknown issue from a watch source → proposed backlog capture. Stable id = the
    // lowercased identifier, which is also the dedupe key across machines/cursor loss.
    const watch = cfg.watch.find((w) => w.team === iss.team && (!w.project || w.project === iss.project));
    if (!watch) continue;   // an edit on a non-watched, non-mapped issue — not ours
    const tier = LINEAR_TO_PRIORITY[iss.priority] || null;
    newItems.push({
      id: iss.identifier.toLowerCase(),
      title: iss.title,
      kind: watch.kind,
      linear: iss.identifier,
      ...(tier ? { priority: { tier } } : watch.priority ? { priority: watch.priority } : {}),
      source: { linear: { team: iss.team, ...(iss.project ? { project: iss.project } : {}), issue: iss.identifier } },
    });
  }
  return { newItems, deltas };
}
