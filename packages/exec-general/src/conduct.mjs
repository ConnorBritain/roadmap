// roadmap — the general profile's conducted loop: plan → assign → independent critic → frozen-lead
// acknowledgment → lead-synthesized repair → fresh critic → reconcile, run against a git-file
// artifact by the human / doc-agent executors. The protocol (markers, digests, verdict derivation,
// staleness) is core's gauntlet-core, untouched; this module is the general-profile runtime the
// way gauntlet-runtime.mjs is the engineering one. No PR, no cloud provider, no GitHub.
//
// The local ledger (.roadmap-gauntlet-state.json) is a cache: every durable fact (packet, launch
// attestations, verdicts, acks) is a committed sidecar entry, and a run is rebuilt from the
// sidecar when the ledger is gone.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadGraph, flatten } from "@connorbritain/roadmap-core/graph.mjs";
import { loadBacklog, roadmapPaths, mutateRoadmap } from "@connorbritain/roadmap-core/store.mjs";
import { backlogItemToNode } from "@connorbritain/roadmap-core/backlog-core.mjs";
import { MUTATION_HANDLERS } from "@connorbritain/roadmap-core/mcp-core.mjs";
import { readGauntletLedger, mutateGauntletLedger, findLedgerRun, launchReceipt } from "@connorbritain/roadmap-core/gauntlet-store.mjs";
import {
  freezeQualityBar, implementationRunId, deriveRunStatus, renderCriticMarker, renderGauntletLaunchMarker,
  renderGauntletVerdictAck, reconstructVerdictAcksFromComments, reconstructLaunchesFromComments,
  buildCriticPrompt, buildRepairPrompt, gauntletLaunchKey, parseGauntletPrMarkers, parseFrozenBarBlock,
  DEFAULT_GAUNTLET_MAX_ROUNDS, GAUNTLET_VERDICTS,
} from "@connorbritain/roadmap-core/gauntlet-core.mjs";
import { gitFileArtifact } from "./git-file-artifact.mjs";
import { EXECUTORS, artifactPathFor } from "./executors.mjs";

const TERMINAL = new Set(["passed", "human_required", "exhausted", "cancelled", "merged", "closed"]);
const SHA_RE = /^[0-9a-f]{40}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const nowIso = (opts) => (opts && opts.now ? opts.now() : new Date().toISOString());

function subjectFor(root, key) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const node = flatten(graph).nodes.find((n) => n.invoke === key);
  if (node) return { type: "slice", key, node, item: null, graph, path: artifactPathFor(node) };
  const item = ((loadBacklog(root) || {}).items || []).find((i) => i.id === key);
  if (item) { const n = backlogItemToNode(item); return { type: "backlog", key, node: n, item, graph, path: artifactPathFor(n) }; }
  throw new Error(`no slice or backlog item "${key}"`);
}

function partsFor(root, opts = {}) {
  const execImpl = opts.execImpl || spawnSync;
  const artifact = opts.artifact || gitFileArtifact(root, { execImpl, now: opts.now });
  const executorName = opts.executor || "human";
  const make = EXECUTORS[executorName];
  if (!make) throw new Error(`unknown general executor "${executorName}" (human | doc-agent)`);
  const executor = opts.executorImpl || make({ root, execImpl, now: opts.now, spawnAgent: opts.spawnAgent, actor: opts.actor });
  return { artifact, executor, executorName, execImpl };
}

function headSha(root, execImpl) {
  const r = execImpl("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const sha = r.status === 0 ? String(r.stdout).trim() : "";
  if (!SHA_RE.test(sha)) throw new Error("the repository has no commit yet — commit the roadmap before conducting");
  return sha;
}

// Rebuild a run from its committed sidecar packet (ledger lost). Launch attestations posted by the
// frozen lead are recovered as receipts, so acknowledged verdicts stay authoritative.
function reconstructRun(adapter, idOrKey) {
  const art = adapter.fetch({ runId: idOrKey }) || adapter.fetch({ subject: { type: "slice", key: idOrKey } }) || adapter.fetch({ subject: { type: "backlog", key: idOrKey } });
  if (!art) return null;
  const marker = parseGauntletPrMarkers(art.body);
  const bar = parseFrozenBarBlock(art.body);
  if (!marker || !bar) return null;
  const run = { run_id: marker.runId, subject_type: marker.subjectType, subject_key: marker.key, base_sha: marker.baseSha,
    base_ref: art.baseRef, lead_actor: adapter.actor(), bar_sha256: marker.barSha256, frozen_bar_markdown: bar.markdown || bar,
    max_rounds: DEFAULT_GAUNTLET_MAX_ROUNDS, artifact: art.path, artifact_kind: "git-file", reconstructed: true, launches: [] };
  run.launches = reconstructLaunchesFromComments({ run, comments: art.comments });
  run.recovered_bar_confirmed_at = run.recovered_bar_confirmed_at || null;
  return run;
}

export function observe(root, idOrKey, opts = {}) {
  const parts = partsFor(root, opts);
  const ledger = readGauntletLedger(root);
  let run = findLedgerRun(ledger, idOrKey);
  if (!run) run = reconstructRun(parts.artifact, idOrKey);
  if (!run) throw new Error(`no conducted run "${idOrKey}" in the ledger or the committed sidecars`);
  const art = parts.artifact.fetch({ number: run.artifact });
  const status = deriveRunStatus({ run, pr: art, comments: art ? art.comments : [], commits: art ? art.commits : [] });
  return { ...parts, run, artifact: art, status, ledgerHit: !!findLedgerRun(ledger, idOrKey) };
}

export function conductStatus(root, idOrKey, opts = {}) {
  const o = observe(root, idOrKey, opts);
  return { runId: o.run.run_id, subject: { type: o.run.subject_type, key: o.run.subject_key }, artifact: o.run.artifact,
    head: o.artifact ? o.artifact.currentHead : null, state: o.status.state, round: o.status.round, maxRounds: o.status.maxRounds,
    repairsUsed: o.status.repairsUsed, safeActions: o.status.safeActions, reconstructed: !o.ledgerHit,
    criticResults: o.status.criticResults.map((r) => ({ verdict: r.verdict, head: r.head, round: r.round, criticRole: r.criticRole, valid: r.valid, invalidReason: r.invalidReason, url: r.comment && r.comment.url })),
    launches: (o.run.launches || []).map((l) => ({ role: l.role, round: l.round, status: l.status, expected_head: l.expected_head, brief: l.brief || null })) };
}

export async function conductStart(root, key, opts = {}) {
  const subject = subjectFor(root, key);
  const { artifact, executor, executorName, execImpl } = partsFor(root, opts);
  artifact.assertAvailable();
  const ledger = readGauntletLedger(root);
  const previous = findLedgerRun(ledger, key);
  if (previous && !TERMINAL.has(previous.last_state)) return { duplicate: true, runId: previous.run_id, state: previous.last_state, message: `active run already exists for ${key}` };
  const baseSha = headSha(root, execImpl);
  const frozen = freezeQualityBar({ subjectType: subject.type, key, node: subject.node, item: subject.item, graph: subject.graph, baseSha, additionalBar: opts.additionalBar || null });
  const attempt = 1 + Object.values(ledger.runs).filter((r) => r && r.subject_key === key && r.base_sha === baseSha).length;
  const runId = implementationRunId({ subjectType: subject.type, key, baseSha, attempt });
  const metaCfg = (subject.graph.meta && subject.graph.meta.gauntlet) || {};
  const maxRounds = opts.maxRounds != null ? Number(opts.maxRounds) : (metaCfg.max_rounds != null ? metaCfg.max_rounds : DEFAULT_GAUNTLET_MAX_ROUNDS);
  const leadActor = artifact.actor();
  const createdAt = nowIso(opts);
  const run = { run_id: runId, subject_type: subject.type, subject_key: key, base_sha: baseSha,
    base_ref: (subject.graph.meta && subject.graph.meta.base_branch) || "main", lead_actor: leadActor,
    bar_sha256: frozen.sha256, frozen_bar: frozen.canonical, frozen_bar_markdown: frozen.markdown, max_rounds: maxRounds,
    artifact: subject.path, artifact_kind: "git-file", executor: executorName, created_at: createdAt, updated_at: createdAt,
    last_state: "awaiting_pr", launches: [] };
  const { packet } = artifact.freeze({ run, frozenBar: frozen });
  if (opts.dry) {
    const receipt = await executor.launch(subject.node, { role: "work", assignee: opts.assignee, dry: true }, { root, graph: subject.graph });
    return { dry: true, runId, artifact: subject.path, packet, receipt, state: "awaiting_pr" };
  }
  const claim = artifact.claim(`gauntlet:implementation:${subject.type}:${key}:${baseSha}:attempt:${attempt}`, baseSha, runId);
  if (!claim.claimed) throw new Error(`another conductor already claimed ${key} at ${baseSha} (${claim.ref}); inspect before retrying`);
  const packetCommit = artifact.publishPacket(subject.path, packet);
  const receipt = await executor.launch(subject.node, { role: "work", assignee: opts.assignee }, { root, graph: subject.graph });
  run.launches.push({ key: `${runId}:implementation`, role: "implementation", provider: executorName, status: "launched",
    receipt_key: receipt.key, brief: receipt.brief || null, created_at: createdAt });
  mutateGauntletLedger(root, (l) => { l.runs[runId] = run; });
  return { runId, artifact: subject.path, packetCommit, receipt, state: "awaiting_pr", claim: claim.ref };
}

function updateLaunch(root, runId, key, patch) {
  mutateGauntletLedger(root, (l) => {
    const run = l.runs[runId];
    if (!run) throw new Error(`run ${runId} disappeared from the ledger`);
    const launch = [...(run.launches || [])].reverse().find((c) => c.key === key);
    if (!launch) throw new Error(`launch ${key} disappeared from ${runId}`);
    Object.assign(launch, patch);
    run.updated_at = patch.updated_at || new Date().toISOString();
  });
}
function persistState(root, run, state) {
  mutateGauntletLedger(root, (l) => {
    if (!l.runs[run.run_id]) l.runs[run.run_id] = { ...run, launches: [...(run.launches || [])] };
    l.runs[run.run_id].last_state = state;
    l.runs[run.run_id].updated_at = new Date().toISOString();
  });
}

export async function conductCritic(root, idOrKey, opts = {}) {
  const o = observe(root, idOrKey, opts);
  const { run, artifact: art, status, artifact: _a, executor } = o;
  const adapter = o.artifact === art ? partsFor(root, opts).artifact : null;
  const expectedHead = String(opts.expectedHead || "").trim();
  if (!SHA_RE.test(expectedHead)) throw new Error("critic requires expectedHead: the exact 40-hex commit that last touched the artifact (from conduct status)");
  if (!art || !art.currentHead) throw new Error(`run ${run.run_id} has no committed artifact yet (${run.artifact}); the worker commits it first`);
  if (art.currentHead !== expectedHead) throw new Error(`stale critic assignment: expected ${expectedHead}, ${run.artifact} is now ${art.currentHead}`);
  const criticRole = opts.criticRole || status.nextRequiredRole || "critic";
  const round = Number(status.round);
  const existing = launchReceipt(run, { role: "critic", round, expectedHead, criticRole });
  if (existing) return { duplicate: true, runId: run.run_id, launch: existing };   // idempotent before any state gate
  if (status.state !== "awaiting_critic") throw new Error(`run ${run.run_id} is ${status.state}; a critic launch is not currently safe`);
  const nonce = opts.nonce || randomBytes(16).toString("hex");
  const prompt = buildCriticPrompt({ run, pr: art, prNumber: art.number, expectedHead, round, criticRole, nonce, artifactWording: adapter.workerFetchInstructions(art, expectedHead) });
  const launchKey = gauntletLaunchKey({ runId: run.run_id, role: "critic", round, expectedHead, criticRole });
  if (opts.dry) return { dry: true, runId: run.run_id, round, expectedHead, criticRole, nonce, prompt };
  const createdAt = nowIso(opts);
  const record = { key: launchKey, role: "critic", provider: run.executor || "human", critic_role: criticRole, round, attempt: 1, nonce,
    expected_head: expectedHead, status: "firing", created_at: createdAt };
  persistState(root, run, "critic_in_flight");
  mutateGauntletLedger(root, (l) => { l.runs[run.run_id].launches.push(record); });
  const claim = adapter.claim(`${launchKey}:attempt:1`, expectedHead, run.run_id);
  if (!claim.claimed) { updateLaunch(root, run.run_id, launchKey, { status: "duplicate_remote", claim_ref: claim.ref }); return { duplicate: true, remote: true, runId: run.run_id, round, expectedHead }; }
  updateLaunch(root, run.run_id, launchKey, { status: "claimed", claim_ref: claim.ref });
  adapter.comment({ number: run.artifact }, renderGauntletLaunchMarker({ run, role: "critic", criticRole, round, attempt: 1, expectedHead, nonce }));
  const node = subjectFor(root, run.subject_key).node;
  const receipt = await executor.launch(node, { role: "critic", round, prompt, assignee: opts.assignee }, { root, graph: loadGraph(roadmapPaths(root).yaml) });
  updateLaunch(root, run.run_id, launchKey, { status: "launched", receipt_key: receipt.key, brief: receipt.brief || null, updated_at: nowIso(opts) });
  return { runId: run.run_id, round, expectedHead, criticRole, nonce, brief: receipt.brief || null, receipt };
}

// The critic (a person, or the doc-agent's session) posts its verdict. The nonce comes from the
// lead's own launch receipt for this head + round, so only a launched critic can produce a valid one.
export function conductVerdict(root, idOrKey, opts = {}) {
  const o = observe(root, idOrKey, opts);
  const { run, artifact: art, status } = o;
  const verdict = opts.verdict;
  if (!GAUNTLET_VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${GAUNTLET_VERDICTS.join("|")}`);
  if (!art || !art.currentHead) throw new Error("no committed artifact to judge");
  const head = opts.expectedHead || art.currentHead;
  const criticRole = opts.criticRole || "critic";
  const launch = launchReceipt(run, { role: "critic", round: Number(status.round), expectedHead: head, criticRole });
  if (!launch || !launch.nonce) throw new Error(`no launched critic for ${run.run_id} round ${status.round} at ${head}; run conduct critic first`);
  const rationale = String(opts.rationale || "").trim();
  if (!rationale) throw new Error("a verdict needs a rationale (VERDICT RATIONALE)");
  const body = `${renderCriticMarker({ run, criticRole, round: Number(status.round), head, nonce: launch.nonce, verdict })}\n\nVERDICT RATIONALE: ${rationale}${opts.mustFix ? `\n\nMUST FIX:\n${opts.mustFix}` : ""}`;
  o.artifact && partsFor(root, opts).artifact.comment({ number: run.artifact }, body);
  const after = partsFor(root, opts).artifact.fetch({ number: run.artifact });
  const posted = after.comments.find((c) => c.body === body);
  updateLaunch(root, run.run_id, launch.key, { status: "completed", updated_at: nowIso(opts) });
  const state = deriveRunStatus({ run: findLedgerRun(readGauntletLedger(root), run.run_id) || run, pr: after, comments: after.comments, commits: after.commits }).state;
  persistState(root, run, state);
  return { runId: run.run_id, verdict, head, round: Number(status.round), commentUrl: posted ? posted.url : null, state };
}

export function conductAck(root, idOrKey, opts = {}) {
  if (!opts.confirm) throw new Error("ack requires explicit confirm=true after the lead has inspected the critic's evidence");
  const commentUrl = String(opts.commentUrl || "").trim();
  if (!commentUrl) throw new Error("ack requires the exact critic comment locator from conduct status");
  const o = observe(root, idOrKey, opts);
  const { run, artifact: art, status } = o;
  if (!art) throw new Error(`run ${run.run_id} has no artifact with a critic result to acknowledge`);
  const candidate = status.criticResults.find((r) => r.comment && r.comment.url === commentUrl);
  if (!candidate) throw new Error(`critic comment ${commentUrl} is not associated with run ${run.run_id}`);
  if (candidate.invalidReason !== "unacknowledged_result") {
    if (candidate.acknowledged) return { duplicate: true, runId: run.run_id, commentUrl, verdict: candidate.verdict, head: candidate.head, acknowledged: true };
    throw new Error(`critic comment ${commentUrl} is not safe to acknowledge (${candidate.invalidReason || "invalid"})`);
  }
  const source = art.comments.find((c) => c.url === commentUrl);
  if (!source) throw new Error(`critic comment ${commentUrl} disappeared before acknowledgment`);
  const adapter = partsFor(root, opts).artifact;
  if (adapter.actor() !== run.lead_actor) throw new Error(`only the frozen lead (${run.lead_actor}) may acknowledge; you are ${adapter.actor()}`);
  const already = reconstructVerdictAcksFromComments({ run, comments: art.comments })
    .find((a) => a.commentSha256 === candidate.commentSha256 && a.commentUrlSha256 === candidate.commentUrlSha256 && a.verdict === candidate.verdict);
  if (already) return { duplicate: true, runId: run.run_id, commentUrl, verdict: candidate.verdict, head: candidate.head, acknowledged: true };
  adapter.ack({ number: run.artifact }, renderGauntletVerdictAck({ run, comment: source }));
  const after = adapter.fetch({ number: run.artifact });
  const state = deriveRunStatus({ run, pr: after, comments: after.comments, commits: after.commits }).state;
  persistState(root, run, state);
  return { runId: run.run_id, commentUrl, verdict: candidate.verdict, head: candidate.head, acknowledged: true, state };
}

export async function conductRepair(root, idOrKey, opts = {}) {
  const o = observe(root, idOrKey, opts);
  const { run, artifact: art, status, executor } = o;
  const adapter = partsFor(root, opts).artifact;
  const expectedHead = String(opts.expectedHead || "").trim();
  if (!SHA_RE.test(expectedHead)) throw new Error("repair requires expectedHead (the exact artifact commit the acknowledged REVISE judged)");
  const packet = String(opts.packet || "").trim();
  if (!packet) throw new Error("repair requires the lead-synthesized packet");
  if (!art || art.currentHead !== expectedHead) throw new Error(`stale repair assignment: expected ${expectedHead}, ${run.artifact} is now ${art && art.currentHead}`);
  const round = Number(status.round);
  const existing = launchReceipt(run, { role: "repair", round, expectedHead });
  if (existing) return { duplicate: true, runId: run.run_id, launch: existing };
  if (status.state !== "needs_repair") throw new Error(`run ${run.run_id} is ${status.state}; a repair launch is not currently safe`);
  const packetSha256 = sha256(packet);
  const prompt = buildRepairPrompt({ run, pr: art, prNumber: art.number, branch: art.headRef || run.base_ref || "main", expectedHead, round, packet, artifactWording: adapter.workerFetchInstructions(art, expectedHead) });
  const launchKey = gauntletLaunchKey({ runId: run.run_id, role: "repair", round, expectedHead });
  if (opts.dry) return { dry: true, runId: run.run_id, round, expectedHead, packetSha256, prompt };
  const createdAt = nowIso(opts);
  const record = { key: launchKey, role: "repair", provider: run.executor || "human", round, attempt: 1, expected_head: expectedHead, packet_sha256: packetSha256, status: "firing", created_at: createdAt };
  persistState(root, run, "repair_in_flight");
  mutateGauntletLedger(root, (l) => { l.runs[run.run_id].launches.push(record); });
  const claim = adapter.claim(`${launchKey}:attempt:1`, expectedHead, run.run_id);
  if (!claim.claimed) { updateLaunch(root, run.run_id, launchKey, { status: "duplicate_remote", claim_ref: claim.ref }); return { duplicate: true, remote: true, runId: run.run_id, round, expectedHead }; }
  updateLaunch(root, run.run_id, launchKey, { status: "claimed", claim_ref: claim.ref });
  adapter.comment({ number: run.artifact }, renderGauntletLaunchMarker({ run, role: "repair", round, attempt: 1, expectedHead, packetSha256 }));
  const node = subjectFor(root, run.subject_key).node;
  const receipt = await executor.launch(node, { role: "repair", round, prompt, assignee: opts.assignee }, { root, graph: loadGraph(roadmapPaths(root).yaml) });
  updateLaunch(root, run.run_id, launchKey, { status: "launched", receipt_key: receipt.key, brief: receipt.brief || null, updated_at: nowIso(opts) });
  return { runId: run.run_id, round, expectedHead, packetSha256, brief: receipt.brief || null, receipt };
}

// The general "sync": every run whose artifact carries an acknowledged PASS on its current head
// proposes its slice complete; apply=true writes the status through the store (comments kept).
export function conductReconcile(root, opts = {}) {
  const ledger = readGauntletLedger(root);
  const graph = loadGraph(roadmapPaths(root).yaml);
  const nodes = flatten(graph).nodes;
  const proposals = [];
  for (const run of Object.values(ledger.runs)) {
    if (!run || run.artifact_kind !== "git-file") continue;
    let state;
    try { state = observe(root, run.run_id, opts).status.state; } catch (e) { proposals.push({ runId: run.run_id, key: run.subject_key, error: e.message }); continue; }
    const node = nodes.find((n) => n.invoke === run.subject_key);
    const done = node && ["complete", "done"].includes(node.status);
    proposals.push({ runId: run.run_id, key: run.subject_key, type: run.subject_type, state, artifact: run.artifact,
      proposal: state === "passed" && node && !done ? "complete" : null });
  }
  const applied = [];
  if (opts.apply) {
    const toApply = proposals.filter((p) => p.proposal === "complete");
    if (toApply.length) {
      mutateRoadmap(root, (doc) => { for (const p of toApply) MUTATION_HANDLERS.set_status(doc, { invoke: p.key, status: "complete", completed_on: new Date().toISOString().slice(0, 10) }); });
      for (const p of toApply) { applied.push(p.key); persistState(root, { run_id: p.runId }, "passed"); }
    }
  }
  return { proposals, applied };
}
