#!/usr/bin/env node
// roadmap dispatch <key> [--to claude-cloud|claude|codex|oz] — send a slice/backlog item to a
// CLOUD agent instead of a local worktree. The wave-scale version is `roadmap fan --cloud`.
//
// Two transports:
//   claude-cloud (RECOMMENDED) — fires a Claude Code cloud session directly via the Routines
//     API (code.claude.com/docs/en/routines). Needs NO Linear at all; runs on the CURRENTLY
//     AUTHED claude.ai account's plan limits (multi-account hot-swap via ~/.claude-routines.json
//     keyed by account email — see docs/DEPLOYMENT.md § Cloud dispatch). BETA API: the fire
//     endpoint ships under an experimental header and may change.
//   claude|codex|oz — posts an @-mention capsule comment on the mapped Linear issue. The
//     comment is live-verified; whether the mention SUMMONS an agent requires the agent's
//     integration installed in the Linear workspace (Linear's native coding sessions are
//     paid-plan-gated; the delegate-field mutation remains unverified).

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadGraph, flatten, computeWaves, coherenceEnabled } from "./lib/graph.mjs";
import { loadBacklog, roadmapPaths } from "./lib/store.mjs";
import { runSync, postDispatchComment } from "./linear.mjs";
import { linearState, linearStatusLine, machineFooter, normalizeLinearConfig } from "./lib/linear-core.mjs";
import { outOfCycle } from "./lib/cycle-core.mjs";

export const DISPATCH_AGENTS = { claude: "@Claude", codex: "@Codex", oz: "@Oz" };

// ── claude-cloud transport ────────────────────────────────────────────────────
// Resolve WHICH routine to fire (PURE — inputs injected). Precedence:
//   1. CLAUDE_ROUTINE_TRIGGER + CLAUDE_ROUTINE_TOKEN env (explicit single-account / CI override)
//   2. CLAUDE_ROUTINE_PROFILE env naming a profile in the routines file (manual pin)
//   3. the profile whose `account` matches the CURRENTLY AUTHED claude.ai account email —
//      this is the multi-account hot-swap: `claude /login` as someone else, next dispatch
//      fires on their limits, no config change.
// Within a profile: routines[<owner/repo>] wins over routines.default (routines are repo-bound).
export function resolveRoutine({ env = {}, profiles = null, accountEmail = null, repoSlug = null } = {}) {
  if (env.CLAUDE_ROUTINE_TRIGGER && env.CLAUDE_ROUTINE_TOKEN) {
    return { trigger: env.CLAUDE_ROUTINE_TRIGGER, token: env.CLAUDE_ROUTINE_TOKEN, source: "env" };
  }
  if (!profiles || !Object.keys(profiles).length) {
    throw new Error("no claude-cloud routine configured — set CLAUDE_ROUTINE_TRIGGER + CLAUDE_ROUTINE_TOKEN, or create ~/.claude-routines.json (docs/DEPLOYMENT.md § Cloud dispatch)");
  }
  let label = env.CLAUDE_ROUTINE_PROFILE || null;
  let entry = label ? profiles[label] : null;
  if (label && !entry) throw new Error(`CLAUDE_ROUTINE_PROFILE "${label}" not in the routines file (profiles: ${Object.keys(profiles).join(", ")})`);
  if (!entry) {
    if (!accountEmail) throw new Error("couldn't detect the current claude.ai account (is the Claude CLI logged in?) — set CLAUDE_ROUTINE_PROFILE to pin a profile explicitly");
    const found = Object.entries(profiles).find(([, p]) => p.account && String(p.account).toLowerCase() === accountEmail.toLowerCase());
    if (!found) throw new Error(`no routines profile matches the authed claude.ai account ${accountEmail} (profiles: ${Object.keys(profiles).join(", ")}) — add one or set CLAUDE_ROUTINE_PROFILE`);
    [label, entry] = found;
  }
  const routines = entry.routines || {};
  const r = (repoSlug && routines[repoSlug]) || routines.default;
  if (!r || !r.trigger || !r.token) {
    throw new Error(`profile "${label}" has no routine for ${repoSlug || "(unknown repo)"} and no default — add routines["${repoSlug || "owner/repo"}"] or routines.default { trigger, token }`);
  }
  return { trigger: r.trigger, token: r.token, source: `profile:${label}${repoSlug && routines[repoSlug] ? `:${repoSlug}` : ":default"}`, account: entry.account };
}

// The currently AUTHED claude.ai account email (from the CLI's own config) — the hot-swap key.
export function currentClaudeAccount(home = homedir()) {
  try {
    const j = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    return (j.oauthAccount && j.oauthAccount.emailAddress) || null;
  } catch { return null; }
}

export function loadRoutineProfiles(env = process.env, home = homedir()) {
  const p = env.CLAUDE_ROUTINES_FILE || join(home, ".claude-routines.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// owner/repo from the git remote — routines are repo-bound, so this keys the per-repo lookup.
export function repoSlugOf(root) {
  try {
    const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
    const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout || "");
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

// Fire the routine (BETA endpoint — experimental header, shapes may change).
// `trigger` accepts either the bare trig_… id OR the full endpoint URL exactly as
// claude.ai's API-trigger modal shows it (the modal displays a URL, never a labeled id).
export function routineEndpoint(trigger) {
  if (/^https?:\/\//.test(trigger)) {
    const t = trigger.replace(/\/+$/, "");
    return t.endsWith("/fire") ? t : `${t}/fire`;
  }
  return `https://api.anthropic.com/v1/claude_code/routines/${trigger}/fire`;
}

export async function fireRoutine(routine, text, fetchImpl = fetch) {
  const res = await fetchImpl(routineEndpoint(routine.trigger), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${routine.token}`,
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const hint = res.status === 401 ? " — routine token invalid/expired (re-create the API trigger)"
      : res.status === 404 ? " — trigger id wrong, routine deleted, or the beta shape changed" : "";
    throw new Error(`routine fire HTTP ${res.status}${hint} (beta API — check code.claude.com/docs/en/routines)`);
  }
  return await res.json();   // { claude_code_session_id, claude_code_session_url }
}

export async function runDispatch(root, key, opts = {}) {
  const env = opts.env || process.env;
  const to = (opts.to || "claude-cloud").toLowerCase();
  const io = { apiKey: env.LINEAR_API_KEY, fetchImpl: opts.fetchImpl || fetch };

  const find = () => {
    const graph = loadGraph(roadmapPaths(root).yaml);
    const node = flatten(graph).nodes.find((n) => n.invoke === key);
    if (node) return { type: "slice", identifier: node.linear, graph, status: node.status };
    const item = ((loadBacklog(root) || {}).items || []).find((i) => i.id === key);
    if (item) return { type: "backlog", identifier: item.linear, graph };
    return null;
  };

  let found = find();
  if (!found) throw new Error(`no slice or backlog item "${key}"`);

  // Cycle lock (slices only — backlog is erratic work by design, grab stays unguarded): with
  // cycles on, out-of-cycle work doesn't dispatch. --force is the logged escape hatch; the
  // launch surfaces as scope change on Linear's cycle graph either way.
  if (found.type === "slice" && !opts.force && outOfCycle(normalizeLinearConfig(found.graph.meta || {}), found.status)) {
    throw new Error(`'${key}' is out of the current cycle (status ${found.status}) — elect it first ('roadmap cycle plan', then 'roadmap cycle lock --promote ${key}'), or re-run with --force to override the cycle lock.`);
  }

  // ── claude-cloud: fire a Claude Code cloud session directly (NO Linear required) ──
  if (to === "claude-cloud") {
    const routine = resolveRoutine({
      env,
      profiles: opts.profiles !== undefined ? opts.profiles : loadRoutineProfiles(env),
      accountEmail: opts.accountEmail !== undefined ? opts.accountEmail : currentClaudeAccount(),
      repoSlug: opts.repoSlug !== undefined ? opts.repoSlug : repoSlugOf(root),
    });
    const text = [
      machineFooter({ type: found.type, key }, null),
      "",
      "This is a roadmap cloud dispatch. The repo is cloned for you. Open docs/SLICES.md#" + key +
      " and the entry (including its prompt) in docs/roadmap/roadmap.yaml — the YAML is canonical." +
      " Honor the verification gate before committing, then open a PR whose DESCRIPTION includes the exact line" +
      ` 'roadmap: ${found.type}=${key}' (that line is how the roadmap reconciles cloud PRs). NEVER merge.` +
      " Leftovers go to the BACKLOG ONLY — never new sprints or PIs (YAGNI applies to captures).",
    ].join("\n");
    const fired = await fireRoutine(routine, text, opts.fetchImpl || fetch);
    const result = { dispatched: key, transport: "claude-cloud", routine: routine.source,
      sessionId: fired.claude_code_session_id, sessionUrl: fired.claude_code_session_url };
    // Board loop: when the node is Linear-mapped and we're authed, link the session on the
    // issue. Best-effort — a failure here never fails the dispatch.
    if (found.identifier && linearState({ meta: found.graph.meta, env }).authed) {
      try {
        await postDispatchComment(found.identifier, `Claude Code cloud session started for \`${key}\`: ${result.sessionUrl}`, io);
        result.linearComment = found.identifier;
      } catch { /* board link is a bonus, not a dependency */ }
    }
    return result;
  }

  const agent = DISPATCH_AGENTS[to];
  if (!agent) throw new Error(`unknown dispatch target "${opts.to}" (claude-cloud | ${Object.keys(DISPATCH_AGENTS).join(" | ")})`);
  const state = linearState({ meta: found.graph.meta, env });
  if (!state.configured || !state.authed) throw new Error(linearStatusLine(state));

  let pushed = false;
  if (!found.identifier) {
    await runSync(root, { pushOnly: true, env, fetchImpl: opts.fetchImpl });
    pushed = true;
    found = find();
    if (!found.identifier) {
      throw new Error(`push didn't map "${key}" to a Linear issue — check meta.linear.granularity (and per-PI overrides) covers it.`);
    }
  }

  const body = [
    `${agent} please work this issue.`,
    "",
    machineFooter({ type: found.type, key }, null),
    "",
    `Follow the repo's dispatch guidance (CLAUDE.md/AGENTS.md — 'Working a roadmap-dispatched Linear issue'). In short: the repo's docs/roadmap YAML is canonical, honor the slice's gate, open a PR whose description includes the line 'roadmap: ${found.type}=${key}', never merge, leftovers to the backlog only.`,
  ].join("\n");

  try {
    await postDispatchComment(found.identifier, body, io);
  } catch (e) {
    throw new Error(`dispatch failed — tried: push-map (${pushed ? "pushed" : "already mapped"} → ${found.identifier}), commentCreate on ${found.identifier} (${e.message}). Delegate-field mutation not attempted (unverified).`);
  }
  return { dispatched: key, identifier: found.identifier, agent, pushed };
}

// Conduct a cloud fanout of one ready wave — the worktree-free, disk-free fanout that lets a
// local session orchestrate cloud workers. PREVIEW unless opts.confirm (firing spends plan
// usage + opens PRs). Cloud has no machine ceiling, so the cap defaults to the review ceiling
// (a human still merges) — mirrors `fan --cloud`. opts.dispatch is forwarded to each
// runDispatch (transport injection for tests).
export async function runFanCloud(root, opts = {}) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const cap = opts.cap || 5;
  const { waves } = computeWaves(flatten(graph), cap, { coherence: coherenceEnabled(graph.meta) });
  const waveIdx = opts.wave || 1;
  let wave = waves[waveIdx - 1] || [];
  // Cycle lock at wave scale: out-of-cycle slices drop from the launch selection (reported,
  // never silent — a silent cap reads as "covered everything"). opts.all includes them anyway.
  // computeWaves itself stays untouched: the wave math is shared planning, the lock is a launch gate.
  const cfg = normalizeLinearConfig(graph.meta || {});
  let excluded = [];
  if (!opts.all) {
    excluded = wave.filter((n) => outOfCycle(cfg, n.status)).map((n) => n.invoke);
    if (excluded.length) wave = wave.filter((n) => !outOfCycle(cfg, n.status));
  }
  const slices = wave.map((n) => n.invoke);
  if (!opts.confirm) {
    return { preview: true, wave: waveIdx, cap, slices,
      ...(excluded.length ? { excludedOutOfCycle: excluded } : {}),
      note: `${slices.length} slice(s) would each fire a cloud session on the authed claude.ai account and open a PR.${excluded.length ? ` ${excluded.length} out-of-cycle slice(s) excluded (${excluded.join(", ")}) — elect them or pass all=true.` : ""} Re-call with confirm=true to fire.` };
  }
  const results = [];
  for (const invoke of slices) {
    // force: the fan-level filter above IS the cycle gate (and opts.all is an explicit human
    // include) — re-guarding per dispatch would veto what the wave already admitted.
    try { const r = await runDispatch(root, invoke, { ...(opts.dispatch || {}), force: true }); results.push({ slice: invoke, ok: true, sessionUrl: r.sessionUrl }); }
    catch (e) { results.push({ slice: invoke, ok: false, error: e.message }); }
  }
  return { fired: results.filter((r) => r.ok).length, of: slices.length, wave: waveIdx, ...(excluded.length ? { excludedOutOfCycle: excluded } : {}), results };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const key = args.find((a) => !a.startsWith("-"));
  if (!key) {
    console.error(`usage: roadmap dispatch <slice-invoke|backlog-id> [--to claude-cloud|${Object.keys(DISPATCH_AGENTS).join("|")}]   (default claude-cloud)`);
    process.exit(2);
  }
  try {
    const r = await runDispatch(process.cwd(), key, { to: val("--to"), force: args.includes("--force") });
    if (r.transport === "claude-cloud") {
      console.log(`dispatched ${r.dispatched} → Claude Code cloud session (${r.routine}).`);
      console.log(`session: ${r.sessionUrl}`);
      if (r.linearComment) console.log(`board:   session link commented on ${r.linearComment}`);
      console.log(`(beta Routines API — if shapes change, check code.claude.com/docs/en/routines)`);
    } else {
      console.log(`dispatched ${r.dispatched} → ${r.identifier} via ${r.agent} @-mention comment.`);
      console.log(`VERIFY the agent picked it up. Live-tested finding: the comment posts fine, but summoning requires the agent's`);
      console.log(`integration to be INSTALLED in the Linear workspace (Linear's native coding sessions are paid-plan-gated);`);
      console.log(`without it there is nothing to summon. If installed and nothing happens, delegate by hand — the capsule`);
      console.log(`comment is already on the issue to orient the agent.`);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
