#!/usr/bin/env node
// roadmap linear <status|auth|setup|sync> — the ONLY file that talks to Linear's API.
// The brain is lib/linear-core.mjs (pure); this layer does GraphQL IO (global fetch,
// injectable for tests), the sync cursor, and the YAML write-backs via lib/store.mjs.
//
//   roadmap linear status [--probe] [--json]   state check (probe = one networked viewer query)
//   roadmap linear auth                        how to set LINEAR_API_KEY (never stored in files)
//   roadmap linear setup --team KEY [...]      write meta.linear (queries your teams first)
//   roadmap linear provision                   shape the workspace: labels, views, guidance texts
//   roadmap linear sync [--dry] [--push-only] [--pull-only]
//   roadmap linear post-update --pi <id> --body <text|@file>   digest → Linear project update

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, flatten } from "./lib/graph.mjs";
import { setFields } from "./lib/mcp-core.mjs";
import { addItem, setItemFields } from "./lib/backlog-core.mjs";
import { mutateRoadmap, mutateBacklog, loadBacklog, roadmapPaths } from "./lib/store.mjs";
import { plateDrainKeys, setPlateDoc } from "./lib/plate-core.mjs";
import { noteBody } from "./lib/journal-core.mjs";
import {
  normalizeLinearConfig, linearState, linearStatusLine, buildPushPlan, buildPullProposals, holdsFor,
  provisionPlan, manualViewChecklist, agentGuidanceText, dispatchGuidance, initiativePlan, initiativeStyle,
  startStampTargets, milestonePlan,
} from "./lib/linear-core.mjs";

const ENDPOINT = "https://api.linear.app/graphql";
const CURSOR_FILE = ".roadmap-linear-state.json";

// ── transport (injectable; deliberately NOT exported — every consumer goes through the
// run* operations so this stays the only file that talks to the API) ──────────────────
async function gql(query, variables, { apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },   // personal key: bare, no Bearer
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}${res.status === 401 ? " — is LINEAR_API_KEY valid?" : ""}`);
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error(`Linear API: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data;
}

// ── cursor ────────────────────────────────────────────────────────────────────
export function readCursor(root) {
  try { return JSON.parse(readFileSync(join(root, CURSOR_FILE), "utf8")); } catch { return null; }
}
function writeCursor(root, lastSync) {
  writeFileSync(join(root, CURSOR_FILE), JSON.stringify({ version: 1, lastSync }, null, 2) + "\n", "utf8");
}

// ── queries ───────────────────────────────────────────────────────────────────
async function fetchTeamBundle(teamKey, io) {
  const data = await gql(
    `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes {
       id key name
       states { nodes { id name type position } }
       labels { nodes { id name } } } } }`,
    { key: teamKey }, io);
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`no Linear team with key "${teamKey}" (check meta.linear.team)`);
  return {
    id: team.id,
    states: [...team.states.nodes].sort((a, b) => a.position - b.position),
    labels: Object.fromEntries(((team.labels && team.labels.nodes) || []).map((l) => [l.name, l.id])),
  };
}

// Project drift snapshot, keyed by the mapped project ids only (NOT all team projects). `content`
// is a heavy rich-text field — fetching it for every project inside the team bundle blows Linear's
// 10k query-complexity ceiling, so it lives here, batched small, exactly like fetchIssueSnapshot.
const mappedProjectIds = (graph) => (graph.pis || []).map((p) => p.linear && p.linear.project).filter(Boolean);
async function fetchProjectSnapshot(ids, io) {
  const projects = {};
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const q = `query { ${chunk.map((id, j) => `p${j}: project(id: "${id}") { id name description content color icon priority startDate targetDate }`).join(" ")} }`;
    const data = await gql(q, {}, io);
    chunk.forEach((_, j) => {
      const p = data[`p${j}`];
      if (p) projects[p.id] = { id: p.id, name: p.name, description: p.description || "", content: p.content || "",
        color: p.color || "", icon: p.icon || "", priority: p.priority || 0, startDate: p.startDate || null, targetDate: p.targetDate || null };
    });
  }
  return projects;
}

// Snapshot of our mapped issues, batched via aliases (identifiers are valid issue(id:) args).
async function fetchIssueSnapshot(identifiers, io) {
  const issues = {};
  for (let i = 0; i < identifiers.length; i += 50) {
    const chunk = identifiers.slice(i, i + 50);
    const q = `query { ${chunk.map((id, j) => `i${j}: issue(id: "${id}") { id identifier title description priority estimate state { id } project { id } assignee { id } labels { nodes { id } } }`).join(" ")} }`;
    const data = await gql(q, {}, io);
    chunk.forEach((_, j) => {
      const iss = data[`i${j}`];
      if (iss) issues[iss.identifier] = { id: iss.id, title: iss.title, description: iss.description || "", priority: iss.priority, estimate: iss.estimate ?? null, stateId: iss.state.id,
        projectId: iss.project ? iss.project.id : null,
        assigneeId: iss.assignee ? iss.assignee.id : null,
        labelIds: ((iss.labels && iss.labels.nodes) || []).map((l) => l.id) };
    });
  }
  return issues;
}

async function fetchInbound(cfg, since, io) {
  const sources = [{ team: cfg.team, project: null }, ...cfg.watch];
  const out = [];
  for (const src of sources) {
    const filter = { team: { key: { eq: src.team } }, ...(since ? { updatedAt: { gt: since } } : {}), ...(src.project ? { project: { name: { eq: src.project } } } : {}) };
    // ponytail: 100 issues per source per sync — cursor-windowed, so backpressure self-heals next run.
    const data = await gql(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 100) { nodes {
         identifier title priority updatedAt state { name type } team { key } project { name } } } }`,
      { filter }, io);
    for (const n of data.issues.nodes) {
      out.push({ identifier: n.identifier, title: n.title, priority: n.priority,
        state: n.state, team: n.team.key, project: n.project ? n.project.name : null, updatedAt: n.updatedAt });
    }
  }
  return out;
}

// ── the one sync implementation (CLI + MCP both call this) ───────────────────
export async function runSync(root, opts = {}) {
  const env = opts.env || process.env;
  const graph = loadGraph(roadmapPaths(root).yaml);
  const cfg = normalizeLinearConfig(graph.meta || {});
  const state = linearState({ meta: graph.meta, env, cursor: readCursor(root) });
  if (!state.configured) throw new Error("Linear isn't configured for this roadmap — add meta.linear or run 'roadmap linear setup --team <KEY>'");
  if (!state.authed) throw new Error("Linear is configured but LINEAR_API_KEY isn't set ('roadmap linear auth' explains)");
  const io = { apiKey: env.LINEAR_API_KEY, fetchImpl: opts.fetchImpl || fetch };
  const now = opts.now || new Date().toISOString();

  const backlog = loadBacklog(root);
  const team = await fetchTeamBundle(cfg.team, io);
  const mapped = collectIdentifiers(graph, backlog);
  const existing = { issues: await fetchIssueSnapshot(mapped, io), projects: await fetchProjectSnapshot(mappedProjectIds(graph), io) };
  const docsUrl = repoDocsUrl(root, graph);

  const result = { pushed: [], proposals: null, cursorAdvanced: false, dry: !!opts.dry };

  // ── pull FIRST (live-verified ordering): inbound is read before any push executes, so a
  // human's Linear edit can never be clobbered by the projection while it's still an open
  // proposal — push holds those fields until the proposal is resolved. In auto mode the
  // deltas apply to the YAML here, so the subsequent push naturally agrees with them.
  let holds = new Set();
  let inboxEmpty = true;
  if (!opts.pushOnly && cfg.pull !== "off") {
    const inbound = await fetchInbound(cfg, state.lastSync, io);
    const proposals = buildPullProposals({ cfg, inbound, graph, backlog });
    result.proposals = proposals;
    inboxEmpty = !proposals.newItems.length && !proposals.deltas.length;
    if (!opts.dry && cfg.pull === "auto") {
      for (const item of proposals.newItems) mutateBacklog(root, (doc) => addItem(doc, item), { createIfMissing: true });
      for (const d of proposals.deltas) {
        if (d.to == null) continue;   // canceled-slice flags stay human decisions even on auto
        const fields = d.field === "status" ? { status: d.to } : { priority: { ...(currentPriority(root, d) || {}), tier: d.to } };
        if (d.kind === "slice") mutateRoadmap(root, (doc) => setFields(doc, { invoke: d.key, fields }));
        else mutateBacklog(root, (doc) => setItemFields(doc, { id: d.key, fields }));
      }
      result.applied = proposals;
    } else {
      holds = holdsFor(proposals.deltas);
    }
  }
  // Re-read after auto-apply so the push plan reflects the accepted inbound edits.
  let pushGraph = result.applied ? loadGraph(roadmapPaths(root).yaml) : graph;
  const pushBacklog = result.applied ? loadBacklog(root) : backlog;

  // ── auto-stamp project start dates ── a PI that's active without an explicit start_date gets one (the
  // sync date ≈ when it was picked up), so the Linear roadmap timeline has a start. Explicit wins; stamped
  // once then stable. Write-back BEFORE the push so the new startDate projects this run.
  const toStamp = opts.dry ? [] : startStampTargets(pushGraph);   // pure decision (linear-core); IO write below
  if (toStamp.length) {
    const today = now.slice(0, 10);
    mutateRoadmap(root, (doc) => {
      const pis = doc.toJS().pis || [];
      for (const id of toStamp) { const idx = pis.findIndex((p) => p.id === id); if (idx >= 0) doc.setIn(["pis", idx, "start_date"], today); }
      return { startStamped: toStamp.length };
    });
    pushGraph = loadGraph(roadmapPaths(root).yaml);
    result.startStamped = toStamp;
  }

  // ── plate auto-drain (complete-only) ── a finished slice leaves My Issues. Write-back BEFORE the push
  // so the projection unassigns it. Skipped on dry runs (no writes) and when the feature is off.
  if (!opts.dry && Array.isArray(pushGraph.meta && pushGraph.meta.plate) && pushGraph.meta.plate.length) {
    const drop = plateDrainKeys(pushGraph, pushBacklog);
    if (drop.length) {
      const keep = pushGraph.meta.plate.filter((k) => !drop.includes(k));
      mutateRoadmap(root, (doc) => { setPlateDoc(doc, keep); return { plateDrained: drop.length }; });
      pushGraph = loadGraph(roadmapPaths(root).yaml);
      result.plateDrained = drop;
    }
  }
  // viewer id — only when the plate feature is on; a fetch failure just disables the assignee projection.
  let viewerId = null;
  if (pushGraph.meta && pushGraph.meta.plate != null) {
    try { viewerId = (await gql(`query { viewer { id } }`, {}, io)).viewer.id; } catch { /* no viewer → no assignee ops */ }
  }

  // ── push ──
  if (!opts.pullOnly) {
    const { ops, missingLabels, unmatchedPlate } = buildPushPlan({ graph: pushGraph, backlog: pushBacklog, cfg, teamStates: team.states, existing, docsUrl, holds, labels: team.labels, viewerId });
    if (missingLabels.length) result.missingLabels = missingLabels;
    if (unmatchedPlate && unmatchedPlate.length) result.unmatchedPlate = unmatchedPlate;
    if (opts.dry) {
      result.pushPlan = ops;
    } else if (ops.length) {
      const projectIds = projectIdsByPi(pushGraph);
      const writeBacks = { pis: [], sprints: [], items: [] };
      // Icon names are a fixed Linear set we can't introspect without write-probing the board; a bad
      // palette entry would abort the whole push. Retry once without `icon` so it degrades to "no
      // icon" (color still groups) instead of failing the sync. Only icon needs this — every other
      // field is a validated shape.
      const isIconErr = (e) => /icon|argument validation/i.test(e.message || "");
      const stripIcon = (p) => { const { icon, ...rest } = p; return rest; };
      // finally-flush: if an op throws mid-push, everything Linear already created still gets
      // its id written back — otherwise the next sync would create duplicates for those nodes.
      try {
        for (const op of ops) {
          if (op.op === "createProject") {
            const mk = (payload) => gql(`mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }`,
              { input: { ...payload, teamIds: [team.id] } }, io);   // spread: dropping fields here caused live churn (description)
            let d;
            try { d = await mk(op.payload); }
            catch (e) { if (op.payload.icon && isIconErr(e)) d = await mk(stripIcon(op.payload)); else throw e; }
            projectIds[op.projectRef] = d.projectCreate.project.id;
            writeBacks.pis.push({ pi: op.writeBack.pi, project: d.projectCreate.project.id });
          } else if (op.op === "updateProject") {
            const mk = (payload) => gql(`mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { project { id } } }`,
              { id: op.id, input: payload }, io);
            try { await mk(op.payload); }
            catch (e) { if (op.payload.icon && isIconErr(e)) await mk(stripIcon(op.payload)); else throw e; }
          } else if (op.op === "createIssue") {
            const input = { teamId: team.id, ...op.payload, ...(op.projectRef && projectIds[op.projectRef] ? { projectId: projectIds[op.projectRef] } : {}) };
            const d = await gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
              { input }, io);
            const identifier = d.issueCreate.issue.identifier;
            if (op.writeBack.kind === "sprint") writeBacks.sprints.push({ invoke: op.writeBack.invoke, identifier });
            else writeBacks.items.push({ id: op.writeBack.id, identifier });
          } else if (op.op === "updateIssue") {
            await gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { id } } }`,
              { id: op.id, input: op.payload }, io);
          }
          result.pushed.push(`${op.op}${op.identifier ? ` ${op.identifier}` : op.writeBack ? ` ${op.writeBack.invoke || op.writeBack.id || op.writeBack.pi}` : ""}`);
        }
      } finally {
        // one write-back batch per file, through the store's validated path
        if (writeBacks.pis.length || writeBacks.sprints.length) {
          mutateRoadmap(root, (doc) => {
            for (const wb of writeBacks.pis) {
              const idx = doc.toJS().pis.findIndex((p) => p.id === wb.pi);
              doc.setIn(["pis", idx, "linear", "project"], wb.project);
            }
            for (const wb of writeBacks.sprints) setFields(doc, { invoke: wb.invoke, fields: { linear: wb.identifier } });
            return { writeBack: writeBacks.pis.length + writeBacks.sprints.length };
          });
        }
        if (writeBacks.items.length) {
          mutateBacklog(root, (doc) => {
            for (const wb of writeBacks.items) setItemFields(doc, { id: wb.id, fields: { linear: wb.identifier } });
            return { writeBack: writeBacks.items.length };
          });
        }
      }
    }
  }

  // ── initiatives ── group projects under their declared Linear initiatives. Runs AFTER the
  // push write-backs so the project ids exist. Best-effort + graceful: a failure (the
  // initiative API is not yet live-verified) records a note and never fails the sync.
  if (!opts.dry && !opts.pullOnly) {
    try { const ir = await syncInitiatives(root, io); if (ir.initiatives.length) result.initiatives = ir; }
    catch (e) { result.initiativesError = e.message; }
    // milestones run AFTER initiatives (both post-push): the project ids exist and issues are mapped.
    try { const mr = await syncMilestones(root, io); if (mr.milestones.length) result.milestones = mr; }
    catch (e) { result.milestonesError = e.message; }
  }

  // ── cursor ── advance only when the inbox is handled (auto) or empty — in propose mode a
  // non-empty inbox stays in the window so unhandled proposals reappear rather than vanish.
  if (!opts.dry && !opts.pushOnly) {
    if (cfg.pull === "off" || cfg.pull === "auto" || inboxEmpty) { writeCursor(root, now); result.cursorAdvanced = true; }
  }
  return result;
}

// Ensure each declared initiative exists in Linear, carries its meta.initiatives icon/color, and each
// mapped PI's project is attached. UNVERIFIED API (initiativeCreate/Update/ToProjectCreate) — the caller
// catches and degrades. Idempotent: skips existing initiatives, re-applies style only on drift (the fetch
// reads current icon/color back), and skips already-attached projects.
export async function syncInitiatives(root, io) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const plan = initiativePlan(graph);
  if (!plan.initiatives.length) return { initiatives: [] };
  const data = await gql(`query { initiatives(first: 250) { nodes { id name icon color projects { nodes { id } } } } }`, {}, io);
  const byName = new Map((data.initiatives.nodes || []).map((i) => [i.name, i]));
  // icon/color are newly-exercised initiative input — degrade like project icons do: a bad name or an
  // unsupported field drops the initiative to unstyled instead of aborting the whole initiative sync.
  const isStyleErr = (e) => /icon|color|argument validation/i.test(e.message || "");
  const created = [], styled = [];
  for (const name of plan.initiatives) {
    const style = initiativeStyle(graph.meta, name);
    if (!byName.has(name)) {
      const full = { name, ...(style.icon ? { icon: style.icon } : {}), ...(style.color ? { color: style.color } : {}) };
      const mk = (input) => gql(`mutation($input: InitiativeCreateInput!) { initiativeCreate(input: $input) { initiative { id name } } }`, { input }, io);
      let d;
      try { d = await mk(full); if (full.icon || full.color) styled.push(name); }
      catch (e) { if ((full.icon || full.color) && isStyleErr(e)) d = await mk({ name }); else throw e; }
      byName.set(name, { ...d.initiativeCreate.initiative, projects: { nodes: [] } });
      created.push(name);
      continue;
    }
    // existing → apply declared style only when it drifts (idempotent via the fetched icon/color)
    const cur = byName.get(name);
    const patch = {};
    if (style.icon && cur.icon !== style.icon) patch.icon = style.icon;
    if (style.color && (cur.color || "") !== style.color) patch.color = style.color;
    if (Object.keys(patch).length) {
      try {
        await gql(`mutation($id: String!, $input: InitiativeUpdateInput!) { initiativeUpdate(id: $id, input: $input) { initiative { id } } }`, { id: cur.id, input: patch }, io);
        styled.push(name);
      } catch (e) { if (!isStyleErr(e)) throw e; }   // best-effort: unsupported update → leave unstyled
    }
  }
  const attached = [];
  for (const a of plan.assignments) {
    const pi = (graph.pis || []).find((p) => p.id === a.pi);
    const projectId = pi && pi.linear && pi.linear.project;
    if (!projectId) continue;   // PI has no project (empty/skipped) — nothing to group
    const init = byName.get(a.initiative);
    if (((init.projects && init.projects.nodes) || []).some((p) => p.id === projectId)) continue;   // already attached
    await gql(`mutation($input: InitiativeToProjectCreateInput!) { initiativeToProjectCreate(input: $input) { success } }`, { input: { initiativeId: init.id, projectId } }, io);
    (init.projects || (init.projects = { nodes: [] })).nodes.push({ id: projectId });   // local dedupe within this run
    attached.push(`${a.pi} → ${a.initiative}`);
  }
  return { initiatives: plan.initiatives, created, styled, attached };
}

// Mapped issues' current milestone, batched (identifier → { id: uuid, milestoneId }) — like fetchIssueSnapshot.
async function fetchIssueMilestones(identifiers, io) {
  const out = {};
  for (let i = 0; i < identifiers.length; i += 50) {
    const chunk = identifiers.slice(i, i + 50);
    const q = `query { ${chunk.map((id, j) => `i${j}: issue(id: "${id}") { id identifier projectMilestone { id } }`).join(" ")} }`;
    const data = await gql(q, {}, io);
    chunk.forEach((_, j) => { const iss = data[`i${j}`]; if (iss) out[iss.identifier] = { id: iss.id, milestoneId: iss.projectMilestone ? iss.projectMilestone.id : null }; });
  }
  return out;
}

// Ensure each PI's declared milestones (sp.milestone) exist on its Linear project and each mapped issue is
// attached to its milestone. Mirrors syncInitiatives one level down (issues within a project). UNVERIFIED
// API (projectMilestoneCreate) — the caller catches and degrades. Idempotent: skips existing milestones by
// name, and re-attaches an issue only when its projectMilestoneId drifts from the target.
export async function syncMilestones(root, io) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const plan = milestonePlan(graph);
  if (!plan.pis.length) return { milestones: [] };
  const milestones = [], created = [], attached = [];
  for (const p of plan.pis) {
    const pi = (graph.pis || []).find((x) => x.id === p.pi);
    const projectId = pi && pi.linear && pi.linear.project;
    if (!projectId) continue;   // PI has no project — nothing to attach milestones to
    const data = await gql(`query { project(id: "${projectId}") { projectMilestones { nodes { id name } } } }`, {}, io);
    const byName = new Map(((data.project && data.project.projectMilestones && data.project.projectMilestones.nodes) || []).map((m) => [m.name, m.id]));
    for (const name of p.milestones) {
      milestones.push(`${p.pi}/${name}`);
      if (byName.has(name)) continue;
      // sortOrder = current milestone count (append after existing), NOT the plan-local index — else a
      // milestone added between two existing ones on a later run would collide with an existing sortOrder.
      const d = await gql(`mutation($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { projectMilestone { id } } }`,
        { input: { projectId, name, sortOrder: byName.size } }, io);
      byName.set(name, d.projectMilestoneCreate.projectMilestone.id);
      created.push(`${p.pi}/${name}`);
    }
    const mapped = p.slices.filter((s) => s.linear);
    if (!mapped.length) continue;
    const cur = await fetchIssueMilestones(mapped.map((s) => s.linear), io);
    for (const s of mapped) {
      const targetId = byName.get(s.milestone);
      const c = cur[s.linear];
      if (!c || !targetId || c.milestoneId === targetId) continue;   // unmapped-in-snapshot or already attached
      await gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { id } } }`,
        { id: c.id, input: { projectMilestoneId: targetId } }, io);
      attached.push(`${s.invoke} → ${s.milestone}`);
    }
  }
  return { milestones, created, attached };
}

// ── dispatch transport (the only-network-file rule: dispatch.mjs owns the capsule, this
// owns the wire) — resolve the issue uuid and post the @-mention comment.
export async function postDispatchComment(identifier, body, io) {
  const d = await gql(`query { issue(id: "${identifier}") { id identifier } }`, {}, io);
  if (!d.issue) throw new Error(`mapped issue ${identifier} not found in Linear (deleted?)`);
  await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
    { input: { issueId: d.issue.id, body } }, io);
}

// ── the journal (progress notes on the mapped issue) ──────────────────────────
// A slice invoke key / backlog id → its mapped Linear issue identifier (null when unmapped). Mirrors
// runDispatch's resolver; used by note/notes so an agent can journal against the work it's picking up.
function resolveMapped(graph, root, key) {
  const node = flatten(graph).nodes.find((n) => n.invoke === key);
  if (node) return { identifier: node.linear };
  const it = ((loadBacklog(root) || {}).items || []).find((i) => i.id === key);
  if (it) return { identifier: it.linear };
  return null;
}
// Load the graph + build the API io, gating on the SAME configured+authed check runSync/runProvision use
// (one auth-state source, one error wording). Returns { graph, io }.
function journalContext(root, opts) {
  const env = opts.env || process.env;
  const graph = loadGraph(roadmapPaths(root).yaml);
  const st = linearState({ meta: graph.meta, env });
  if (!st.configured || !st.authed) throw new Error(linearStatusLine(st));
  return { graph, io: { apiKey: env.LINEAR_API_KEY, fetchImpl: opts.fetchImpl || fetch } };
}

// Post a progress note to a slice/backlog item's mapped issue. Reuses postDispatchComment's transport.
// Unknown key → error; a known-but-UNMAPPED slice → soft-skip (best-effort; matches the auto-hook, and
// keeps journaling frictionless for a worker whose slice just isn't on the tracker).
export async function runNote(root, key, { kind, text }, opts = {}) {
  const { graph, io } = journalContext(root, opts);
  const m = resolveMapped(graph, root, key);
  if (!m) throw new Error(`no slice or backlog item "${key}"`);
  if (!m.identifier) return { key, skipped: "unmapped" };
  await postDispatchComment(m.identifier, noteBody({ kind, text }), io);
  return { key, identifier: m.identifier };
}

// Read the mapped issue's comment stream (chronological), so a resuming agent sees where it left off.
export async function runNotes(root, key, opts = {}) {
  const { graph, io } = journalContext(root, opts);
  const m = resolveMapped(graph, root, key);
  if (!m) throw new Error(`no slice or backlog item "${key}"`);
  if (!m.identifier) return { key, skipped: "unmapped", notes: [] };
  const d = await gql(`query { issue(id: "${m.identifier}") { comments(first: 50) { nodes { body createdAt user { name } } } } }`, {}, io);
  const nodes = (d.issue && d.issue.comments && d.issue.comments.nodes) || [];
  return { identifier: m.identifier, notes: nodes.map((n) => ({ author: n.user ? n.user.name : "?", createdAt: n.createdAt, body: n.body })) };
}

// PI digest → a Linear project update (the "where this bet stands" rollup). Degradation-guarded: the
// projectUpdateCreate shape is unverified, so a rejection is a skip, not a failure.
export async function runProjectUpdate(root, pi, body, opts = {}) {
  const { graph, io } = journalContext(root, opts);
  const piObj = (graph.pis || []).find((p) => p.id === pi);
  if (!piObj || !piObj.linear || !piObj.linear.project) throw new Error(`PI "${pi}" has no linear.project mapping — push first ('roadmap linear sync')`);
  try {
    await gql(`mutation($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { projectUpdate { id } } }`,
      { input: { projectId: piObj.linear.project, body } }, io);
    return { pi, posted: true };
  } catch (e) {
    return { pi, posted: false, error: e.message };
  }
}

// ── provision: shape the workspace (idempotent) ───────────────────────────────
export async function runProvision(root, opts = {}) {
  const env = opts.env || process.env;
  const graph = loadGraph(roadmapPaths(root).yaml);
  const state = linearState({ meta: graph.meta, env });
  if (!state.configured || !state.authed) throw new Error(linearStatusLine(state));
  const io = { apiKey: env.LINEAR_API_KEY, fetchImpl: opts.fetchImpl || fetch };
  const team = await fetchTeamBundle(state.cfg.team, io);

  const plan = provisionPlan({ graph, teamLabels: team.labels });
  const result = { labelsCreated: [], labelsExisting: plan.existingLabels, views: [], viewChecklist: null };

  for (const name of plan.createLabels) {
    try {
      await gql(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name } } }`,
        { input: { name, teamId: team.id } }, io);
      result.labelsCreated.push(name);
    } catch (e) {
      if (/already exists|duplicate/i.test(e.message)) result.labelsExisting.push(name);   // creation race
      else throw e;
    }
  }

  // Views (live-verified mutation). Idempotency: skip names that already exist — a re-run
  // must not duplicate the board (live-caught failure mode). Any rejection degrades to the
  // manual checklist (the designed fallback, not a failure).
  let existingViews = new Set();
  try {
    const vd = await gql(`query { customViews(first: 100) { nodes { id name } } }`, {}, io);
    existingViews = new Set(vd.customViews.nodes.map((v) => v.name));
  } catch { /* view listing unavailable → fall through to create-and-let-it-ride */ }
  for (const v of plan.views) {
    if (existingViews.has(v.name)) { result.viewsExisting = [...(result.viewsExisting || []), v.name]; continue; }
    try {
      await gql(`mutation($input: CustomViewCreateInput!) { customViewCreate(input: $input) { customView { id } } }`,
        { input: { name: v.name, teamId: team.id, description: v.hint } }, io);
      result.views.push(v.name);
    } catch (e) {
      result.viewChecklist = { rejected: e.message, checklist: manualViewChecklist(plan.views.filter((x) => !result.views.includes(x.name) && !existingViews.has(x.name))) };
      break;
    }
  }
  return result;
}

function collectIdentifiers(graph, backlog) {
  const ids = [];
  for (const pi of graph.pis || []) for (const sp of pi.sprints || []) if (sp.linear) ids.push(sp.linear);
  for (const it of (backlog && backlog.items) || []) if (it.linear) ids.push(it.linear);
  return ids;
}
function projectIdsByPi(graph) {
  const out = {};
  for (const pi of graph.pis || []) if (pi.linear && pi.linear.project) out[pi.id] = pi.linear.project;
  return out;
}
function currentPriority(root, d) {
  if (d.kind === "slice") {
    for (const pi of loadGraph(roadmapPaths(root).yaml).pis || []) for (const sp of pi.sprints || []) if (sp.invoke === d.key) return sp.priority;
  } else {
    const bl = loadBacklog(root);
    for (const it of (bl && bl.items) || []) if (it.id === d.key) return it.priority;
  }
  return null;
}
// https://github.com/<owner>/<repo>/blob/<base_branch> — the docs-link base for issue
// footers. Unknown/non-GitHub remote → null → footers fall back to the relative path.
export function repoDocsUrl(root, graph) {
  try {
    const r = spawnSync("git", ["remote", "get-url", (graph.meta && graph.meta.remote) || "origin"], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) return null;
    const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout);
    if (!m) return null;
    return `https://github.com/${m[1]}/${m[2]}/blob/${(graph.meta && graph.meta.base_branch) || "main"}`;
  } catch { return null; }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : "status";
  const has = (n) => args.includes(n);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const root = process.cwd();

  try {
    if (sub === "status") {
      const graph = loadGraph(roadmapPaths(root).yaml);
      const st = linearState({ meta: graph.meta, env: process.env, cursor: readCursor(root) });
      if (has("--json")) { console.log(JSON.stringify({ configured: st.configured, authed: st.authed, lastSync: st.lastSync })); process.exit(0); }
      if (!st.configured) { console.log("Linear: not configured (add meta.linear or 'roadmap linear setup --team <KEY>')."); process.exit(0); }
      if (!st.authed) { console.log(`Linear: configured (team ${st.cfg.team}) but unauthed — set LINEAR_API_KEY ('roadmap linear auth' explains).`); process.exit(0); }
      console.log(`Linear: wired (team ${st.cfg.team} · granularity ${st.cfg.granularity} · pull ${st.cfg.pull} · last sync ${st.lastSync || "never"}).`);
      if (has("--probe")) {
        const d = await gql(`query { viewer { name email } }`, {}, { apiKey: process.env.LINEAR_API_KEY });
        console.log(`  probe ok — authed as ${d.viewer.name}`);
      }
    } else if (sub === "auth") {
      console.log([
        "Linear auth uses a personal API key in the LINEAR_API_KEY env var — never stored in any file.",
        "  1. Linear → Settings → Security & access → Personal API keys → create one.",
        "  2. PowerShell:  [Environment]::SetEnvironmentVariable('LINEAR_API_KEY','<key>','User')",
        "     bash/zsh:    echo 'export LINEAR_API_KEY=<key>' >> ~/.bashrc",
        "  3. New shell, then: roadmap linear status --probe",
      ].join("\n"));
    } else if (sub === "setup") {
      const key = process.env.LINEAR_API_KEY;
      if (!key) { console.error("✗ setup needs auth first — 'roadmap linear auth' explains."); process.exit(1); }
      const teamKey = val("--team");
      if (!teamKey) {
        const d = await gql(`query { teams(first: 50) { nodes { key name } } }`, {}, { apiKey: key });
        console.log("Your Linear teams:");
        for (const t of d.teams.nodes) console.log(`  ${t.key}  ${t.name}`);
        console.log(`\nPick the push target: roadmap linear setup --team <KEY> [--granularity pis|slices|slices+backlog] [--pull off|propose|auto]`);
        process.exit(0);
      }
      await fetchTeamBundle(teamKey, { apiKey: key });   // validates the key exists before writing
      const cfg = { team: teamKey, granularity: val("--granularity") || "slices", pull: val("--pull") || "propose" };
      mutateRoadmap(root, (doc) => { doc.setIn(["meta", "linear"], doc.createNode(cfg)); return { setup: teamKey }; });
      console.log(`✓ meta.linear written (team ${teamKey}, granularity ${cfg.granularity}, pull ${cfg.pull}).`);
      console.log(`  Add to .gitignore: ${CURSOR_FILE}`);
      console.log(`  Optional: branch_convention: "{pi}/{linear}-{sprint}" makes Linear auto-link fanout PRs.`);
      console.log(`  Then: roadmap linear sync --dry`);
    } else if (sub === "provision") {
      const r = await runProvision(root);
      console.log(`labels: ${r.labelsCreated.length ? `created ${r.labelsCreated.join(", ")}` : "all present"}${r.labelsExisting.length ? ` (existing: ${r.labelsExisting.join(", ")})` : ""}`);
      if (r.views.length) console.log(`views created: ${r.views.join(", ")}`);
      if (r.viewsExisting && r.viewsExisting.length) console.log(`views already present: ${r.viewsExisting.join(", ")}`);
      if (r.viewChecklist) {
        console.log(`customViewCreate rejected (${r.viewChecklist.rejected}) — pending live verification; manual checklist (~60s in Linear):`);
        console.log(r.viewChecklist.checklist);
      }
      console.log(`\n── Workspace agent guidance (paste into Linear's agent-guidance setting) ──\n${agentGuidanceText()}`);
      console.log(`\n── Repo dispatch guidance (paste into CLAUDE.md, AGENTS.md, or a skills.md your dispatch agents read) ──\n${dispatchGuidance()}`);
    } else if (sub === "note") {
      const rest = args.slice(1);
      const positional = [];
      for (let i = 0; i < rest.length; i++) { if (rest[i] === "--kind") { i++; continue; } if (!rest[i].startsWith("-")) positional.push(rest[i]); }
      const [key, text] = positional;
      if (!key || !text) { console.error(`usage: roadmap linear note <slice-or-id> "<text>" [--kind progress|blocker|done]`); process.exit(2); }
      const r = await runNote(root, key, { kind: val("--kind"), text }, {});
      console.log(r.skipped ? `- ${key} isn't tracker-mapped yet — note skipped (run 'roadmap linear sync' to map it).` : `✓ note posted to ${r.identifier} (${key}).`);
    } else if (sub === "notes") {
      const key = args.slice(1).find((a) => !a.startsWith("-"));
      if (!key) { console.error("usage: roadmap linear notes <slice-or-id>"); process.exit(2); }
      const r = await runNotes(root, key, {});
      if (r.skipped) { console.log(`${key} isn't tracker-mapped yet — no notes ('roadmap linear sync' to map it).`); process.exit(0); }
      console.log(`Notes on ${r.identifier} (${key}) — ${r.notes.length}:`);
      if (!r.notes.length) console.log("  (none yet)");
      for (const n of r.notes) console.log(`  • ${n.createdAt ? n.createdAt.slice(0, 16).replace("T", " ") : "?"} ${n.author}: ${n.body.replace(/\s+/g, " ").trim().slice(0, 160)}`);
    } else if (sub === "post-update") {
      const pi = val("--pi");
      const bodyArg = val("--body");
      if (!pi || !bodyArg) { console.error("usage: roadmap linear post-update --pi <id> --body <text|@file>"); process.exit(2); }
      const body = bodyArg.startsWith("@") ? readFileSync(bodyArg.slice(1), "utf8") : bodyArg;
      const r = await runProjectUpdate(root, pi, body, {});
      console.log(r.posted ? `✓ posted a project update on ${pi}.` : `projectUpdateCreate rejected (${r.error}) — digest not posted; pending live verification.`);
    } else if (sub === "sync") {
      const r = await runSync(root, { dry: has("--dry"), pushOnly: has("--push-only"), pullOnly: has("--pull-only") });
      if (r.pushPlan) {
        console.log(`push plan (${r.pushPlan.length} op(s), dry):`);
        for (const op of r.pushPlan) console.log(`  ${op.op}  ${op.identifier || (op.writeBack && (op.writeBack.invoke || op.writeBack.id || op.writeBack.pi)) || ""}${op.payload && op.payload.title ? ` — ${op.payload.title}` : ""}`);
      } else if (r.pushed.length) {
        console.log(`pushed ${r.pushed.length} op(s): ${r.pushed.join(", ")}`);
      } else {
        console.log("push: nothing to do (in sync).");
      }
      if (r.proposals) {
        const { newItems, deltas } = r.proposals;
        if (!newItems.length && !deltas.length) console.log("pull: inbox empty.");
        else if (r.applied) console.log(`pull (auto): captured ${newItems.length} item(s), applied ${deltas.filter((d) => d.to != null).length} delta(s).`);
        else {
          console.log(`pull inbox (${newItems.length} new, ${deltas.length} delta(s)) — proposals only, nothing applied:`);
          for (const it of newItems) console.log(`  + ${it.id} (${it.kind}${it.priority ? ` · ${it.priority.tier}` : ""}) — ${it.title}   [from ${it.source.linear.team}${it.source.linear.project ? `/${it.source.linear.project}` : ""}]`);
          for (const d of deltas) console.log(`  ~ ${d.kind} ${d.key}: ${d.field} ${d.from} → ${d.to ?? `(${d.note})`}`);
          console.log(`  Apply keeps via /sync (it walks this inbox), backlog_add/set tools, or 'roadmap backlog add/set'.`);
        }
      }
      if (r.missingLabels && r.missingLabels.length) {
        console.log(`labels missing in team: ${r.missingLabels.join(", ")} — run 'roadmap linear provision' to create them.`);
      }
      if (r.initiatives) console.log(`initiatives: ${r.initiatives.initiatives.length} grouped${r.initiatives.created.length ? ` (created ${r.initiatives.created.join(", ")})` : ""}${r.initiatives.styled && r.initiatives.styled.length ? ` · styled ${r.initiatives.styled.length}` : ""}${r.initiatives.attached.length ? ` · attached ${r.initiatives.attached.length} project(s)` : ""}`);
      if (r.initiativesError) console.log(`initiatives skipped: ${r.initiativesError} — pending live verification of the initiative API.`);
      if (r.milestones) console.log(`milestones: ${r.milestones.milestones.length} across projects${r.milestones.created.length ? ` (created ${r.milestones.created.length})` : ""}${r.milestones.attached.length ? ` · attached ${r.milestones.attached.length} issue(s)` : ""}`);
      if (r.milestonesError) console.log(`milestones skipped: ${r.milestonesError} — pending live verification of the projectMilestone API.`);
      if (r.startStamped && r.startStamped.length) console.log(`start dates: stamped ${r.startStamped.length} active PI(s) (${r.startStamped.join(", ")}) — the Linear timeline now has a start.`);
      if (r.plateDrained && r.plateDrained.length) console.log(`plate: drained ${r.plateDrained.length} completed (${r.plateDrained.join(", ")}) — off My Issues.`);
      if (r.unmatchedPlate && r.unmatchedPlate.length) console.log(`plate: ${r.unmatchedPlate.join(", ")} match no slice/backlog item — typo in meta.plate? ('roadmap plate' lists it).`);
      console.log(r.cursorAdvanced ? `cursor advanced.` : `cursor unchanged${r.dry ? " (dry)" : " (inbox pending)"}.`);
    } else {
      console.error(`roadmap linear: unknown subcommand "${sub}" (status | auth | setup | provision | sync | note | notes | post-update)`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
