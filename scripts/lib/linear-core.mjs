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

// The ONE canonical status sentence — every surface (CLI status, MCP, the session-start
// hook, runSync's errors) prints this, so the wording can't drift across four files.
export function linearStatusLine(state) {
  if (!state.configured) return "Linear: not configured — add meta.linear or run 'roadmap linear setup --team <KEY>'.";
  if (!state.authed) return `Linear: configured (team ${state.cfg.team}) but unauthed — set LINEAR_API_KEY ('roadmap linear auth' explains).`;
  return `Linear: wired (team ${state.cfg.team} · granularity ${state.cfg.granularity} · pull ${state.cfg.pull} · last sync ${state.lastSync || "never"}).`;
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
  return `roadmap: ${target.type}=${target.key} · pick up: ${pickup}\n${link}`;
}

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();

export function issueDescription(node, cfg, { docsUrl = null, target } = {}) {
  const tgt = target || { type: "slice", key: node.invoke };
  const footer = machineFooter(tgt, docsUrl);
  // Live-verified: Linear normalizes stored markdown to "---\n\n" after a horizontal rule —
  // our canonical form must BE that normalized form or the exact-string diff updates every
  // issue on every sync. Footer-only descriptions skip the rule entirely.
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
  return (lines.length ? lines.join("\n") + "\n\n---\n\n" : "") + footer;
}

// ── labels + project enrichment ───────────────────────────────────────────────
// Every synced issue carries the marker label (distinguishes roadmap-managed issues from
// hand-made ones); backlog items add kind:<kind>, sprints add track:<lane> when tracked.
// Tier is NOT a label — Linear's native priority already carries it (no duplication).
export const MARKER_LABEL = "roadmap";
export const KIND_LABELS = ["bug", "chore", "followup", "urgent", "idea"].map((k) => `kind:${k}`);

export function desiredLabels(target, node) {
  if (target.type === "backlog") return [MARKER_LABEL, ...(node.kind ? [`kind:${node.kind}`] : [])];
  return [MARKER_LABEL, ...(node.track ? [`track:${node.track}`] : [])];
}

// Linear's ProjectCreateInput field limits (live-verified: name 80, description 255). Exceeding
// either is a hard "Argument Validation Error", so we clip at the projection layer — the SAME
// clipped value is used on create AND in the drift diff, so a clipped project stays idempotent
// (the full text lives in the canonical roadmap.yaml regardless). "…" is one char.
export const LINEAR_PROJECT_NAME_MAX = 80;
export const LINEAR_PROJECT_DESC_MAX = 255;
const clip = (s, max) => (s.length > max ? s.slice(0, max - 3) + "..." : s);

export function projectName(pi) {
  return clip(pi.title, LINEAR_PROJECT_NAME_MAX);
}

// PI theme + exit criteria — the only strategic context a Linear-side viewer gets.
export function projectDescription(pi) {
  const desc = [pi.theme || null, pi.exit_criteria ? `Exit: ${oneLine(pi.exit_criteria)}` : null]
    .filter(Boolean).join("\n\n");
  return clip(desc, LINEAR_PROJECT_DESC_MAX);
}

// ── provisioning (the "Linear as the board" layer) ───────────────────────────
// Standard views. The filter hints are HUMAN instructions — customViewCreate's input shape
// is UNVERIFIED against a live workspace, so provision attempts each and degrades to the
// manual checklist below on the first rejection.
export const STANDARD_VIEWS = [
  { name: "Ready wave", hint: "issues in unstarted states, label roadmap, sorted by priority — what fanout/dispatch launches next" },
  { name: "In flight", hint: "issues in started states, label roadmap — the live wave" },
  { name: "Held on human", hint: "label roadmap in started states that aren't moving — review by hand against SLICES.md's held-on-human list" },
  { name: "Backlog triage", hint: "backlog-state issues labeled kind:* — the /prioritize queue" },
  { name: "Recently shipped", hint: "completed in the last 14 days, label roadmap" },
];

export function provisionPlan({ graph, teamLabels }) {
  const have = new Set(Object.keys(teamLabels || {}));
  const tracks = new Set(flatten(graph).nodes.map((n) => n.track).filter(Boolean));
  const wanted = [MARKER_LABEL, ...KIND_LABELS, ...[...tracks].sort().map((t) => `track:${t}`)];
  return {
    createLabels: wanted.filter((n) => !have.has(n)),
    existingLabels: wanted.filter((n) => have.has(n)),
    views: STANDARD_VIEWS,
  };
}

export function manualViewChecklist(views = STANDARD_VIEWS) {
  return views.map((v) => `  □ New view "${v.name}" — ${v.hint}`).join("\n");
}

// Workspace-level guidance (paste into Linear's agent-guidance setting).
export function agentGuidanceText(cfg) {
  return [
    `This workspace is managed by the roadmap tool. Issues labeled "${MARKER_LABEL}" are PROJECTIONS`,
    `of a repo's canonical docs/roadmap/roadmap.yaml + backlog.yaml — the YAML is the source of`,
    `truth; edit status/priority here and the repo's /sync proposes it back. Each managed issue's`,
    `description ends with a machine footer (roadmap: slice=<key> · pick up: ...) that names the`,
    `slice and the pickup command. kind:* labels bucket backlog captures; track:* labels are fanout`,
    `lanes; Linear priority IS the roadmap tier (Urgent=P0 … Low=P3).`,
  ].join("\n");
}

// The repo-side dispatch contract — paste into CLAUDE.md / AGENTS.md / skills.md so any
// agent delegated a Linear issue (Claude Code coding session, Codex, Oz, …) self-orients.
export function dispatchGuidance() {
  return [
    "## Working a roadmap-dispatched Linear issue",
    "1. Read the issue's roadmap footer (`roadmap: slice=<key>` or `backlog=<key>`) — it is the machine contract.",
    "2. Open docs/SLICES.md#<key> and the slice's entry (including its `prompt`) in docs/roadmap/roadmap.yaml. The YAML is canonical; the Linear issue is a projection.",
    "3. Honor the slice's verification gate before committing.",
    "4. Open a PR whose DESCRIPTION includes the exact line `roadmap: slice=<key>` (or `backlog=<key>`) — that marker is how /sync reconciles cloud PRs, whose branch names don't follow the repo convention. NEVER merge — the lead merges.",
    "5. Leftovers go to the BACKLOG ONLY (`roadmap backlog add \"<title>\" -k followup --slice <key>`, or a **Leftovers** heading in the PR body). Never add sprints or PIs; skip speculative ideas (YAGNI applies to captures too).",
  ].join("\n");
}

// ── push plan (diff-based, idempotent) ────────────────────────────────────────
// existing: the fetched Linear snapshot — { issues: { [identifier]: { id, title, description,
// priority, stateId } }, projects: { [projectId]: { id, name } } }. Ops reference projects
// symbolically (projectRef = pi id); the executor resolves refs after creating projects.
// holds: Set of "IDENTIFIER:field" (field = projection key: priority | stateId) for issues
// with an OPEN inbound proposal — push skips those fields so a human's Linear edit is never
// clobbered while the proposal is unresolved (live-verified failure mode).
// labels: name→id from the team bundle (fresh each sync, no YAML caching). Unresolvable
// names are dropped from payloads and reported once via missingLabels (fix = provision).
export function buildPushPlan({ graph, backlog, cfg, teamStates, existing, docsUrl = null, holds = new Set(), labels = {} }) {
  const ops = [];
  const missing = new Set();
  const model = flatten(graph);

  for (const pi of graph.pis || []) {
    const gran = effectiveGranularity(cfg, pi);
    const projId = pi.linear && pi.linear.project;
    const desc = projectDescription(pi);
    const name = projectName(pi);
    if (!projId) {
      ops.push({ op: "createProject", payload: { name, ...(desc ? { description: desc } : {}) }, projectRef: pi.id,
        writeBack: { kind: "pi", pi: pi.id, field: "project" } });
    } else if (existing.projects[projId]) {
      const cur = existing.projects[projId];
      const changed = {};
      if (cur.name !== name) changed.name = name;
      if ((cur.description || "") !== desc) changed.description = desc;
      if (Object.keys(changed).length) ops.push({ op: "updateProject", id: projId, payload: changed });
    }
    if (gran === "pis") continue;   // projects only — no issue leaks for this PI

    for (const node of model.nodes.filter((n) => n.piId === pi.id)) {
      // create only not-done work (issues for finished history are noise); always update mapped.
      if (!node.linear && isDone(node.status)) continue;
      pushIssueOp(node, { type: "slice", key: node.invoke }, node.status, resolvePushState, pi.id, projId || null);
    }
  }

  if (cfg.granularity === "slices+backlog" && backlog) {
    for (const it of backlog.items || []) {
      if (it.status === "promoted") continue;   // the promoted sprint carries it
      if (!it.linear && (it.status === "done" || it.status === "dropped")) continue;
      const node = { invoke: it.id, title: it.title, what: it.title, gate: it.gate || null,
        estSessions: it.est_sessions ?? null, priority: it.priority || null, source: it.source || null,
        kind: it.kind, linear: it.linear || null };
      pushIssueOp(node, { type: "backlog", key: it.id }, it.status, resolveItemPushState, null);
    }
  }
  return { ops, missingLabels: [...missing].sort() };

  function labelIdsFor(target, node) {
    const ids = [];
    for (const name of desiredLabels(target, node)) {
      if (labels[name]) ids.push(labels[name]);
      else missing.add(name);
    }
    return ids.sort();
  }

  function pushIssueOp(node, target, status, resolver, projectRef, projectId = null) {
    const state = resolver(status, cfg, teamStates);
    const labelIds = labelIdsFor(target, node);
    const projection = {
      title: node.title,
      description: issueDescription(node, cfg, { docsUrl, target }),
      priority: priorityToLinear(node.priority),
      stateId: state.id,
      labelIds,
    };
    if (!node.linear) {
      const payload = { ...projection };
      if (!labelIds.length) delete payload.labelIds;
      ops.push({ op: "createIssue", payload, projectRef,
        writeBack: target.type === "slice" ? { kind: "sprint", invoke: target.key } : { kind: "item", id: target.key } });
      return;
    }
    const cur = existing.issues[node.linear];
    if (!cur) return;   // mapped but not in snapshot (deleted in Linear?) — leave for the human
    const changed = {};
    for (const k of ["title", "description", "priority", "stateId"]) {
      if (holds.has(`${node.linear}:${k}`)) continue;   // pending inbound proposal owns this field
      if (projection[k] !== cur[k]) changed[k] = projection[k];
    }
    // labels compare as SETS (order-insensitive — Linear returns them in its own order)
    if (labelIds.length && labelIds.join(",") !== [...(cur.labelIds || [])].sort().join(",")) {
      changed.labelIds = labelIds;
    }
    // project attach — how a transferred issue (backlog item promoted to a sprint) moves
    // into its PI's project. Only when the project id is already known (post first push).
    if (projectId && cur.projectId !== projectId) changed.projectId = projectId;
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
      // Only propose a status delta when Linear's state TYPE differs from the type WE would
      // push for the node's CURRENT roadmap status. Several roadmap statuses collapse to one
      // Linear type on push (gated/blocked/paused → "started"; scheduled/optionality →
      // "backlog"), so reading that type back is the round-trip echo of our own push — not a
      // human move — and proposing it would spam false gated→active / optionality→scheduled
      // deltas on every sync of a large roadmap. A genuine human move lands in a DIFFERENT type.
      const pushedType = (known.kind === "item" ? ITEM_TYPE_MAP : STATUS_TYPE_MAP)[known.status];
      const inboundType = iss.state && iss.state.type;
      if (inboundType && inboundType !== pushedType) {
        const to = pullStatusFor(inboundType);
        if (to === "canceled") {
          if (known.kind === "item") { if (known.status !== "dropped") deltas.push({ kind: known.kind, key: known.key, identifier: iss.identifier, field: "status", from: known.status, to: "dropped" }); }
          else deltas.push({ kind: known.kind, key: known.key, identifier: iss.identifier, field: "status", from: known.status, to: null, note: `canceled in Linear — no roadmap equivalent; decide by hand` });
        } else if (to && to !== known.status && !(known.kind === "item" && to === "active" && known.status === "in_progress")) {
          deltas.push({ kind: known.kind, key: known.key, identifier: iss.identifier, field: "status", from: known.status, to: known.kind === "item" && to === "active" ? "in_progress" : to });
        }
      }
      const tier = LINEAR_TO_PRIORITY[iss.priority] || null;
      const curTier = (known.priority && known.priority.tier) || null;
      if (tier !== curTier) deltas.push({ kind: known.kind, key: known.key, identifier: iss.identifier, field: "priority.tier", from: curTier, to: tier });
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

// The push-side field holds for a set of pending deltas (see buildPushPlan's `holds`).
export function holdsFor(deltas) {
  const map = { status: "stateId", "priority.tier": "priority" };
  return new Set((deltas || []).filter((d) => d.to != null && d.identifier).map((d) => `${d.identifier}:${map[d.field] || d.field}`));
}
