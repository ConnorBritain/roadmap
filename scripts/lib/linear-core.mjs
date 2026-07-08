// roadmap — Linear brain (PURE). Config normalization, zero-network state detection, the
// PI-override ack, status/priority mapping, issue-description building, and the diff-based
// push plan + pull proposals. NO network, NO fs: scripts/linear.mjs does the IO and injects
// snapshots. Shapes are tracker-neutral where possible so a later jira.mjs reuses the diff
// engine — Linear-specific names live in the payloads this module emits and the IO layer.

import { flatten, isDone, HELD_STATUSES } from "./graph.mjs";
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
    estimate_max: raw.estimate_max != null ? raw.estimate_max : 5,   // Linear estimate scale max (linear=5, extended=7)
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
      if (raw.estimate_max != null && !(Number.isInteger(raw.estimate_max) && raw.estimate_max >= 1)) errors.push("meta.linear.estimate_max must be an integer >= 1 (the Linear estimate scale max; default 5)");
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
      // The forcing function: a slice bigger than the estimate scale can't map to one estimate point
      // and is too big to fan out as a single agent session — surface it here (where you'd split it)
      // rather than silently clamping it on the board. Only when Linear's configured (cfg present).
      if (cfg && !isDone(sp.status) && typeof sp.est_sessions === "number" && Math.round(sp.est_sessions) > cfg.estimate_max) {
        warnings.push(`${pi.id}/${sp.id}: est_sessions ${sp.est_sessions} exceeds estimate_max ${cfg.estimate_max} — too big to fan out as one slice; split it (its Linear estimate clamps to ${cfg.estimate_max})`);
      }
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
// Only `active` maps to "started" (In Progress) so the board's In-Progress count means real,
// live work. Held statuses (blocked/paused/gated) are NOT being worked → "unstarted" (Todo),
// distinguished from plain `next` by a status:<held> label so the "Held on human" view filters.
const STATUS_TYPE_MAP = {
  scheduled: "backlog", optionality: "backlog", next: "unstarted",
  active: "started", blocked: "unstarted", paused: "unstarted", gated: "unstarted",
  complete: "completed",
};
// Held roadmap statuses (blocked/paused/gated) carry a status:<s> label on their issue.
// HELD_STATUSES is re-exported from graph.mjs — the single source of truth for the set.
export { HELD_STATUSES };
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
  // Linear normalizes a bare URL to "[url](<url>)" on store; emit that exact form (same reason
  // as the "---\n\n" rule in issueDescription) so the description round-trips instead of
  // re-pushing every issue each sync. Relative paths (no docsUrl) aren't auto-linked → stay bare.
  const rendered = docsUrl ? `[${link}](<${link}>)` : link;
  return `roadmap: ${target.type}=${target.key} · pick up: ${pickup}\n${rendered}`;
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
  // est_sessions is NOT written here — it rides the issue's native `estimate` field (see buildPushPlan),
  // so it stays sortable/roll-up-able on the board instead of being unsearchable prose.
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
  return [
    MARKER_LABEL,
    ...(node.track ? [`track:${node.track}`] : []),
    ...(HELD_STATUSES.includes(node.status) ? [`status:${node.status}`] : []),   // held distinction on the board
  ];
}

// Linear's ProjectCreateInput field limits (live-verified: name 80, description 255). Exceeding
// either is a hard "Argument Validation Error", so we clip at the projection layer — the SAME
// clipped value is used on create AND in the drift diff, so a clipped project stays idempotent
// (the full text lives in the canonical roadmap.yaml regardless). "…" is one char.
export const LINEAR_PROJECT_NAME_MAX = 80;
export const LINEAR_PROJECT_DESC_MAX = 255;
const clip = (s, max) => (s.length > max ? s.slice(0, max - 3) + "..." : s);

// Project name = the PI's HEADLINE. Roadmap titles are often authored "Headline — subhead
// explanation"; the subhead is context, not a name, and makes the board tacky. Take the part
// before the first em/en-dash separator (falling back to the whole title), then clip.
export function projectName(pi) {
  const headline = String(pi.title).split(/\s+[—–]\s+/)[0].trim() || String(pi.title);
  return clip(headline, LINEAR_PROJECT_NAME_MAX);
}

// Linear rewrites bare URLs and domain-shaped tokens ("Fly.io", "install.rs") to the markdown
// auto-link form "[X](<...>)" on store, so an exact-string diff of a description/content never
// converges and re-pushes every sync. Collapse that form back to its text on BOTH sides before
// comparing — matching Linear's fuzzy heuristic token-by-token is a dead end, this sidesteps it.
export const normalizeLinearMarkdown = (s) =>
  String(s || "").replace(/\[([^\]]*)\]\(<[^>]*>\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

const firstSentence = (s) => {
  const t = oneLine(s);
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
};

// Project SUBTITLE (Linear's short `description`, hard-capped at 255 and truncated with "…" in the
// UI). Keep it to one crisp essence line — the exit's first sentence beats the bare theme word.
export function projectDescription(pi) {
  const subhead = projectName(pi) !== clip(String(pi.title), LINEAR_PROJECT_NAME_MAX)
    ? String(pi.title).split(/\s+[—–]\s+/).slice(1).join(" — ").trim() : "";
  const line = (pi.exit_criteria ? firstSentence(pi.exit_criteria) : "") || subhead || pi.theme || "";
  return clip(line, LINEAR_PROJECT_DESC_MAX);
}

// Project BODY (Linear's rich `content`, effectively unbounded) — the full strategic context the
// 255-char subtitle can't hold. This is where the whole exit criteria + theme + deps live.
export function projectContent(pi) {
  const nameIsSplit = projectName(pi) !== clip(String(pi.title), LINEAR_PROJECT_NAME_MAX);
  const blocks = [
    nameIsSplit ? `**${String(pi.title)}**` : null,
    pi.theme ? `**Theme:** ${oneLine(pi.theme)}` : null,
    pi.exit_criteria ? `**Exit criteria**\n${String(pi.exit_criteria).trim()}` : null,
    pi.estimate_weeks ? `**Estimate:** ${oneLine(pi.estimate_weeks)}` : null,
    Array.isArray(pi.deps) && pi.deps.length ? `**Depends on:** ${pi.deps.join(", ")}` : null,
  ].filter(Boolean);
  return blocks.join("\n\n");
}

// Deterministic project color + icon BY INITIATIVE, so a Linear viewer reads grouping from the
// visual (every "Copilot" project shares a hue) instead of Linear's random per-project assignment.
// Indexed by the initiative's first-seen position → distinct for up to PALETTE-length initiatives.
const PROJECT_COLORS = ["#5e6ad2", "#26b5ce", "#4cb782", "#f2c94c", "#f2994a", "#eb5757", "#bb87fc", "#95a2b3", "#db6e9a", "#82b536"];
const PROJECT_ICONS = ["Rocket", "Settings", "Beaker", "Bot", "Satellite", "Shield", "Compass", "Package", "Link", "Bolt"];
export const projectColorFor = (idx) => (idx < 0 || idx == null ? null : PROJECT_COLORS[idx % PROJECT_COLORS.length]);
export const projectIconFor = (idx) => (idx < 0 || idx == null ? null : PROJECT_ICONS[idx % PROJECT_ICONS.length]);

// ── initiatives (the grouping tier above projects) ───────────────────────────
// A PI declares its initiative via `pi.initiative` (a display name). Sync ensures each distinct
// initiative exists in Linear and each mapped PI's project is attached to it — turning a flat
// wall of 50 projects into a handful of navigable strategic groups. PURE: returns the distinct
// initiative names + the pi→initiative assignments. The IO layer (linear.mjs syncInitiatives)
// creates + attaches, behind graceful degradation (initiativeCreate is not yet live-verified).
export function initiativePlan(graph) {
  const names = new Set();
  const assignments = [];
  for (const pi of graph.pis || []) {
    if (!pi.initiative) continue;
    names.add(pi.initiative);
    assignments.push({ pi: pi.id, initiative: pi.initiative });
  }
  return { initiatives: [...names], assignments };
}

// ── provisioning (the "Linear as the board" layer) ───────────────────────────
// Standard views. The filter hints are HUMAN instructions — customViewCreate's input shape
// is UNVERIFIED against a live workspace, so provision attempts each and degrades to the
// manual checklist below on the first rejection.
export const STANDARD_VIEWS = [
  { name: "Ready wave", hint: "unstarted (Todo) issues labeled roadmap, EXCLUDING status:* (held), sorted by priority — what fanout/dispatch launches next" },
  { name: "In flight", hint: "started (In Progress) issues labeled roadmap — genuinely active work only" },
  { name: "Held on human", hint: "issues labeled status:gated (or status:blocked / status:paused) — held, not being worked" },
  { name: "Backlog triage", hint: "backlog-state issues labeled kind:* — the /prioritize queue" },
  { name: "Recently shipped", hint: "completed in the last 14 days, labeled roadmap" },
];

// Per-track lane views are generated from the tracks actually present in the graph.
function trackViews(graph) {
  const tracks = [...new Set(flatten(graph).nodes.map((n) => n.track).filter(Boolean))].sort();
  return tracks.map((t) => ({ name: `Track ${t}`, hint: `issues labeled track:${t} — the ${t} fanout lane` }));
}

export function provisionPlan({ graph, teamLabels }) {
  const have = new Set(Object.keys(teamLabels || {}));
  const nodes = flatten(graph).nodes;
  const tracks = new Set(nodes.map((n) => n.track).filter(Boolean));
  const heldPresent = HELD_STATUSES.filter((s) => nodes.some((n) => n.status === s));
  const wanted = [
    MARKER_LABEL, ...KIND_LABELS,
    ...[...tracks].sort().map((t) => `track:${t}`),
    ...heldPresent.map((s) => `status:${s}`),
  ];
  return {
    createLabels: wanted.filter((n) => !have.has(n)),
    existingLabels: wanted.filter((n) => have.has(n)),
    views: [...STANDARD_VIEWS, ...trackViews(graph)],
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
  const initiativeOrder = initiativePlan(graph).initiatives;   // first-seen order → stable color/icon index

  for (const pi of graph.pis || []) {
    const gran = effectiveGranularity(cfg, pi);
    const projId = pi.linear && pi.linear.project;
    const piNodes = model.nodes.filter((n) => n.piId === pi.id);
    // A PI earns a project only if it has PROJECTABLE work — a slice that will get an issue
    // (not-done, or already mapped) — or granularity is 'pis' (the project is the deliverable).
    // Without this, a fully-shipped PI creates a bare 0-issue project (46% of pidgeon's board).
    const hasWork = gran === "pis" || piNodes.some((n) => n.linear || !isDone(n.status));
    const name = projectName(pi);
    const desc = projectDescription(pi);
    const content = projectContent(pi);
    const iIdx = pi.initiative ? initiativeOrder.indexOf(pi.initiative) : -1;
    const color = projectColorFor(iIdx);
    const icon = projectIconFor(iIdx);
    const priority = pi.priority ? priorityToLinear(pi.priority) : null;   // null → leave Linear's (No priority)
    const targetDate = pi.target_date || null;
    const desired = {   // the full projection; create takes it whole, update diffs field-by-field
      name,
      ...(desc ? { description: desc } : {}),
      ...(content ? { content } : {}),
      ...(color ? { color } : {}),
      ...(icon ? { icon } : {}),
      ...(priority != null ? { priority } : {}),
      ...(targetDate ? { targetDate } : {}),
    };
    if (!projId) {
      if (hasWork) ops.push({ op: "createProject", payload: desired, projectRef: pi.id,
        writeBack: { kind: "pi", pi: pi.id, field: "project" } });
    } else if (existing.projects[projId]) {   // already mapped → keep it in sync (never orphan)
      const cur = existing.projects[projId];
      const changed = {};
      if (cur.name !== name) changed.name = name;
      if ((cur.description || "") !== desc) changed.description = desc;
      // content compares under markdown-normalization (Linear auto-links URLs/domains on store)
      if (content && normalizeLinearMarkdown(cur.content || "") !== normalizeLinearMarkdown(content)) changed.content = content;
      if (color && (cur.color || "") !== color) changed.color = color;
      if (icon && (cur.icon || "") !== icon) changed.icon = icon;
      if (priority != null && (cur.priority || 0) !== priority) changed.priority = priority;
      if (targetDate && (cur.targetDate || null) !== targetDate) changed.targetDate = targetDate;
      if (Object.keys(changed).length) ops.push({ op: "updateProject", id: projId, payload: changed });
    }
    if (gran === "pis") continue;   // projects only — no issue leaks for this PI

    for (const node of piNodes) {
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
    // est_sessions → native estimate: rounded to an integer, clamped to the scale max so an oversize
    // slice never pushes an out-of-scale value (validate warns to split it). 0/null → unestimated (no
    // field), never a pushed 0 (which needs the team's allow-zero setting). Use the "linear" scale.
    const points = node.estSessions != null ? Math.min(Math.round(node.estSessions), cfg.estimate_max) : 0;
    const projection = {
      title: node.title,
      description: issueDescription(node, cfg, { docsUrl, target }),
      priority: priorityToLinear(node.priority),
      stateId: state.id,
      labelIds,
      ...(points > 0 ? { estimate: points } : {}),
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
      // description compares under markdown-normalization (Linear auto-links URLs/domains on store)
      const same = k === "description"
        ? normalizeLinearMarkdown(projection[k]) === normalizeLinearMarkdown(cur[k])
        : projection[k] === cur[k];
      if (!same) changed[k] = projection[k];
    }
    // labels compare as SETS (order-insensitive — Linear returns them in its own order)
    if (labelIds.length && labelIds.join(",") !== [...(cur.labelIds || [])].sort().join(",")) {
      changed.labelIds = labelIds;
    }
    // estimate: only when we have a positive value that differs. A removed est_sessions leaving a
    // stale estimate is acceptable (never clear to 0 — that needs the team's allow-zero setting).
    if (points > 0 && (cur.estimate || 0) !== points) changed.estimate = points;
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
