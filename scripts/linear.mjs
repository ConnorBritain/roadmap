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
import { loadGraph } from "./lib/graph.mjs";
import { setFields } from "./lib/mcp-core.mjs";
import { addItem, setItemFields } from "./lib/backlog-core.mjs";
import { mutateRoadmap, mutateBacklog, loadBacklog, roadmapPaths } from "./lib/store.mjs";
import {
  normalizeLinearConfig, linearState, linearStatusLine, buildPushPlan, buildPullProposals, holdsFor,
  provisionPlan, manualViewChecklist, agentGuidanceText, dispatchGuidance,
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
       labels { nodes { id name } }
       projects { nodes { id name description } } } } }`,
    { key: teamKey }, io);
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`no Linear team with key "${teamKey}" (check meta.linear.team)`);
  return {
    id: team.id,
    states: [...team.states.nodes].sort((a, b) => a.position - b.position),
    labels: Object.fromEntries(((team.labels && team.labels.nodes) || []).map((l) => [l.name, l.id])),
    projects: Object.fromEntries(team.projects.nodes.map((p) => [p.id, { id: p.id, name: p.name, description: p.description || "" }])),
  };
}

// Snapshot of our mapped issues, batched via aliases (identifiers are valid issue(id:) args).
async function fetchIssueSnapshot(identifiers, io) {
  const issues = {};
  for (let i = 0; i < identifiers.length; i += 50) {
    const chunk = identifiers.slice(i, i + 50);
    const q = `query { ${chunk.map((id, j) => `i${j}: issue(id: "${id}") { id identifier title description priority state { id } labels { nodes { id } } }`).join(" ")} }`;
    const data = await gql(q, {}, io);
    chunk.forEach((_, j) => {
      const iss = data[`i${j}`];
      if (iss) issues[iss.identifier] = { id: iss.id, title: iss.title, description: iss.description || "", priority: iss.priority, stateId: iss.state.id,
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
  const existing = { issues: await fetchIssueSnapshot(mapped, io), projects: team.projects };
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
  const pushGraph = result.applied ? loadGraph(roadmapPaths(root).yaml) : graph;
  const pushBacklog = result.applied ? loadBacklog(root) : backlog;

  // ── push ──
  if (!opts.pullOnly) {
    const { ops, missingLabels } = buildPushPlan({ graph: pushGraph, backlog: pushBacklog, cfg, teamStates: team.states, existing, docsUrl, holds, labels: team.labels });
    if (missingLabels.length) result.missingLabels = missingLabels;
    if (opts.dry) {
      result.pushPlan = ops;
    } else if (ops.length) {
      const projectIds = projectIdsByPi(pushGraph);
      const writeBacks = { pis: [], sprints: [], items: [] };
      // finally-flush: if an op throws mid-push, everything Linear already created still gets
      // its id written back — otherwise the next sync would create duplicates for those nodes.
      try {
        for (const op of ops) {
          if (op.op === "createProject") {
            const d = await gql(`mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }`,
              { input: { name: op.payload.name, teamIds: [team.id] } }, io);
            projectIds[op.projectRef] = d.projectCreate.project.id;
            writeBacks.pis.push({ pi: op.writeBack.pi, project: d.projectCreate.project.id });
          } else if (op.op === "updateProject") {
            await gql(`mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { project { id } } }`,
              { id: op.id, input: op.payload }, io);
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

  // ── cursor ── advance only when the inbox is handled (auto) or empty — in propose mode a
  // non-empty inbox stays in the window so unhandled proposals reappear rather than vanish.
  if (!opts.dry && !opts.pushOnly) {
    if (cfg.pull === "off" || cfg.pull === "auto" || inboxEmpty) { writeCursor(root, now); result.cursorAdvanced = true; }
  }
  return result;
}

// ── dispatch transport (the only-network-file rule: dispatch.mjs owns the capsule, this
// owns the wire) — resolve the issue uuid and post the @-mention comment.
export async function postDispatchComment(identifier, body, io) {
  const d = await gql(`query { issue(id: "${identifier}") { id identifier } }`, {}, io);
  if (!d.issue) throw new Error(`mapped issue ${identifier} not found in Linear (deleted?)`);
  await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
    { input: { issueId: d.issue.id, body } }, io);
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

  // Views: customViewCreate's input shape is UNVERIFIED — attempt each; first rejection
  // degrades to the manual checklist (the designed fallback, not a failure).
  for (const v of plan.views) {
    try {
      await gql(`mutation($input: CustomViewCreateInput!) { customViewCreate(input: $input) { customView { id } } }`,
        { input: { name: v.name, teamId: team.id, description: v.hint } }, io);
      result.views.push(v.name);
    } catch (e) {
      result.viewChecklist = { rejected: e.message, checklist: manualViewChecklist(plan.views.filter((x) => !result.views.includes(x.name))) };
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
      if (r.viewChecklist) {
        console.log(`customViewCreate rejected (${r.viewChecklist.rejected}) — pending live verification; manual checklist (~60s in Linear):`);
        console.log(r.viewChecklist.checklist);
      }
      console.log(`\n── Workspace agent guidance (paste into Linear's agent-guidance setting) ──\n${agentGuidanceText()}`);
      console.log(`\n── Repo dispatch guidance (paste into CLAUDE.md, AGENTS.md, or a skills.md your dispatch agents read) ──\n${dispatchGuidance()}`);
    } else if (sub === "post-update") {
      const pi = val("--pi");
      const bodyArg = val("--body");
      if (!pi || !bodyArg) { console.error("usage: roadmap linear post-update --pi <id> --body <text|@file>"); process.exit(2); }
      const graph = loadGraph(roadmapPaths(root).yaml);
      const piObj = (graph.pis || []).find((p) => p.id === pi);
      if (!piObj || !piObj.linear || !piObj.linear.project) { console.error(`✗ PI "${pi}" has no linear.project mapping — push first ('roadmap linear sync').`); process.exit(1); }
      const body = bodyArg.startsWith("@") ? readFileSync(bodyArg.slice(1), "utf8") : bodyArg;
      try {
        await gql(`mutation($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { projectUpdate { id } } }`,
          { input: { projectId: piObj.linear.project, body } }, { apiKey: process.env.LINEAR_API_KEY });
        console.log(`✓ posted a project update on ${pi}.`);
      } catch (e) {
        // Designed degradation: the mutation shape is unverified; a rejection is a skip, not a failure.
        console.log(`projectUpdateCreate rejected (${e.message}) — digest not posted; pending live verification.`);
      }
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
      console.log(r.cursorAdvanced ? `cursor advanced.` : `cursor unchanged${r.dry ? " (dry)" : " (inbox pending)"}.`);
    } else {
      console.error(`roadmap linear: unknown subcommand "${sub}" (status | auth | setup | provision | sync | post-update)`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
