#!/usr/bin/env node
// roadmap gauntlet eval — documentation-only Codex Cloud evaluation conductor.

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { loadGraph } from "./lib/graph.mjs";
import { diagnoseCodexCloud, launchCodexCloud, observeCodexCloudTask } from "./lib/cloud-agent-providers.mjs";
import {
  EVALUATION_ROOT, EVALUATION_VERSION, assignmentFor, assignmentsForWave,
  buildEvaluationPrompt, buildEvaluationRun, evaluationDirectory, normalizeAssignment,
  requiredArtifactRoot, requiredRunId, requiredSha, sealableWave, evaluationScopeSnapshot,
} from "./lib/evaluation-core.mjs";
import { applyEvaluationPatch, inspectEvaluationPatch, inspectLocalEvaluationPacket, assertNoSymlinkAncestors, evaluationCommand,
  inspectEvaluationRepairPatch, applyEvaluationRepairPatch } from "./lib/evaluation-io.mjs";
import { githubClient } from "./gauntlet.mjs";
import { freezeAuthorization, authorizationDigest, reserveAuthorizedLaunch, recordLaunchOutcome, recordLaunchNotSubmitted, recordLaunchObservation, authorizationStatus, reconcileLaunchReceipt, continuationStatus } from "./lib/gauntlet-authorization.mjs";
import { githubAuthorizationStore, mutateAuthorization, recordRunContinuation } from "./lib/gauntlet-authorization-io.mjs";
import { runEvaluationReviewAction, inspectCommittedEvaluationCorpus } from "./lib/evaluation-review-io.mjs";
import { evaluationReviewStatus, findEvaluationAttestation, sealEvaluationPayload } from "./lib/evaluation-review-core.mjs";
import { roleModelPreference, qualifyModelPreference } from "./lib/model-policy.mjs";
import { recordDecisionForPr, decisionReport, readDecisionFile } from "./lib/gauntlet-decisions.mjs";

function value(args, name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] || null; }
function flag(args, name) { return args.includes(name); }
function parseInput(text, { legacyManifest = false } = {}) {
  try {
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("oversized input");
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) throw new Error("invalid YAML");
    const parsed = doc.toJS({ maxAliasCount: legacyManifest ? 100 : 0 });
    // Older manifest writers emitted shared receipt aliases. Read bounded,
    // acyclic historical data without allowing cyclic state or alias bombs.
    if (legacyManifest) JSON.stringify(parsed);
    return parsed;
  } catch { throw new Error("invalid or oversized evaluation YAML/JSON, duplicate keys or unsupported aliases (raw input withheld)"); }
}
function configuredArtifactRoot(graph) {
  return requiredArtifactRoot(graph.meta?.dispatch?.evaluation?.artifact_root || EVALUATION_ROOT);
}
function runPath(root, runId, artifactRoot) {
  const path = `${evaluationDirectory(runId, artifactRoot)}/RUN.yaml`;
  assertNoSymlinkAncestors(root, path);
  return join(root, path);
}
function readRun(root, runId, artifactRoot) {
  const path = runPath(root, runId, artifactRoot);
  if (!existsSync(path)) throw new Error(`evaluation run manifest not found: ${path}`);
  const parsed = parseInput(readFileSync(path, "utf8"), { legacyManifest: true });
  return normalizeRunManifest(parsed, runId, artifactRoot);
}
function normalizeRunManifest(parsed, runId, artifactRoot, { recovering = false } = {}) {
  if (!parsed || typeof parsed !== "object") throw new Error("evaluation RUN.yaml is invalid");
  requiredRunId(parsed.run_id); requiredSha(parsed.base_sha);
  if (parsed.run_id !== runId) throw new Error("evaluation manifest run identity differs from requested run");
  const recordedRoot = requiredArtifactRoot(parsed.artifact_root || EVALUATION_ROOT);
  if (recordedRoot !== artifactRoot) throw new Error(`evaluation run artifact root changed from ${recordedRoot} to ${artifactRoot}; restore the original repository configuration before continuing`);
  if (recovering && (parsed.version !== EVALUATION_VERSION || !Array.isArray(parsed.assignments))) throw new Error("committed recovery manifest requires the current version and an assignments array");
  if (!Array.isArray(parsed.assignments)) parsed.assignments = [];
  if (parsed.assignments.some((assignment) => !assignment || typeof assignment !== "object" || Array.isArray(assignment))) throw new Error("evaluation manifest assignments must be objects");
  parsed.assignments = parsed.assignments.map(normalizeAssignment);
  return parsed;
}
function writeRun(root, run) {
  const path = runPath(root, run.run_id, run.artifact_root);
  mkdirSync(dirname(path), { recursive: true });
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "{}");
  if (doc.errors.length) throw new Error("invalid evaluation manifest; refusing write");
  // Receipt references may share object identity in memory; the durable input
  // contract forbids YAML aliases, so expand them deliberately on serialization.
  for (const [key, val] of Object.entries(run)) doc.set(key, doc.createNode(val, { aliasDuplicateObjects: false }));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try { writeFileSync(temporary, doc.toString(), { encoding: "utf8", flag: "wx" }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; } }
}

// The lock is per run and spans inspection/application/receipt updates. Never
// auto-delete a lock: recovery requires verifying the recorded owner is gone.
async function withRunLock(root, runId, artifactRoot, action) {
  const path = runPath(root, runId, artifactRoot);
  mkdirSync(dirname(path), { recursive: true });
  const lockDirectory = resolve(root, evaluationCommand(root, "git", ["rev-parse", "--git-path", "roadmap-evaluation-locks"]).trim());
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const lock = join(lockDirectory, createHash("sha256").update(`${artifactRoot}/${runId}`).digest("hex") + ".lock");
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw new Error(`evaluation mutation already in progress; inspect lock owner before explicit recovery: ${lock}`); throw e; }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
    return await action();
  } finally { closeSync(fd); unlinkSync(lock); }
}
function gitSha(root, sha) {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`base SHA ${sha} is not available locally; fetch it before initializing the evaluation`);
}
function loadAssignments(path) {
  const parsed = parseInput(readFileSync(resolve(path), "utf8"));
  const values = Array.isArray(parsed) ? parsed : parsed && parsed.assignments;
  if (!Array.isArray(values)) throw new Error("assignment file must be a YAML sequence or contain assignments:");
  return values.map(normalizeAssignment);
}
function run(command, args, root) {
  return evaluationCommand(root, command, args);
}

function observeExecution(receipt, environmentId, opts) {
  try {
    const task = (opts.observeCloud || observeCodexCloudTask)({ taskId: receipt.external_id, environmentId });
    if (!task) return { external_id: receipt.external_id, state: "not_found" };
    if (task.external_id !== receipt.external_id || (task.provider_metadata?.environment_id && task.provider_metadata.environment_id !== environmentId)) {
      return { external_id: receipt.external_id, state: "observation_failed", error_code: "provider_identity_mismatch" };
    }
    // READY is the installed Cloud CLI's finished-artifact state (observed via
    // exact task status/list); it is not a PR publication or review verdict.
    const terminal = { ready: "completed", completed: "completed", failed: "failed", error: "failed", cancelled: "cancelled", canceled: "cancelled" };
    return { external_id: receipt.external_id, state: terminal[task.status] || "unresolved",
      provider_status: task.status, updated_at: task.updated_at || null };
  } catch { return { external_id: receipt.external_id, state: "observation_failed", error_code: "provider_query_failed" }; }
}

export async function runEvaluation(root, args, opts = {}) {
  const now = () => (typeof opts.now === "function" ? opts.now() : opts.now) || new Date().toISOString();
  args = [...args];
  const modelPreference = value(args, "--model") || value(args, "--reasoning-effort") || flag(args, "--strict-model")
    ? { ...(value(args, "--model") ? { model: value(args, "--model") } : {}),
      ...(value(args, "--reasoning-effort") ? { reasoning_effort: value(args, "--reasoning-effort") } : {}),
      ...(flag(args, "--strict-model") ? { strict: true } : {}) } : opts.modelPreference || null;
  opts = { ...opts, modelPreference };
  const action = args.shift() || "status";
  const graph = loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  const artifactRoot = configuredArtifactRoot(graph);
  const runIdForLock = requiredRunId(value(args, "--run") || args.find((arg) => !arg.startsWith("-")));
  const mutating = ["init", "launch", "accept", "repair", "critic", "ack", "seal", "authorize", "observe", "attach", "reconcile", "decision", "continuation"].includes(action)
    || (["collect", "collect-repair"].includes(action) && flag(args, "--apply")) || (["migrate", "recover"].includes(action) && flag(args, "--confirm"));
  if (mutating && !opts.locked) return withRunLock(root, runIdForLock, artifactRoot,
    () => runEvaluation(root, [action, ...args], { ...opts, locked: true }));
  if (action === "init") {
    const runId = requiredRunId(value(args, "--run"));
    const baseSha = requiredSha(value(args, "--base-sha"));
    gitSha(root, baseSha);
    const environmentId = value(args, "--environment-id") || graph.meta?.dispatch?.providers?.codex?.environment_id;
    const assignmentsFile = value(args, "--assignments");
    const manifest = buildEvaluationRun({ runId, baseSha, environmentId, title: value(args, "--title") || "Evidence evaluation",
      artifactRoot, assignments: assignmentsFile ? loadAssignments(assignmentsFile) : [] });
    if (existsSync(runPath(root, runId, artifactRoot))) throw new Error(`evaluation run already exists: ${runId}`);
    writeRun(root, manifest);
    const base = join(root, evaluationDirectory(runId, artifactRoot));
    mkdirSync(join(base, "inbox"), { recursive: true });
    writeFileSync(join(base, "README.md"), `# ${manifest.title}\n\nFrozen base: \`${baseSha}\`. This is a documentation-only evaluation corpus.\n`, "utf8");
    return { action, runId, path: evaluationDirectory(runId, artifactRoot), assignments: manifest.assignments.length };
  }
  const runId = requiredRunId(value(args, "--run") || args.find((arg) => !arg.startsWith("-")));
  if (action === "recover") {
    const github = opts.github || githubClient(root);
    const store = opts.authorityStore || githubAuthorizationStore(root, { github });
    const snapshot = await store.read(runId);
    if (!snapshot) throw new Error("no protected authorization exists for this run; recovery cannot invent one");
    if (snapshot.state.authorization.mode !== "evaluation" || snapshot.state.authorization.scope.snapshot.artifact_root !== artifactRoot) {
      throw new Error("protected run mode or artifact root differs from current repository configuration");
    }
    if (!flag(args, "--confirm")) return { action, run_id: runId, applied: false, authorization_digest: snapshot.state.authorization_digest,
      evidence_pr: snapshot.state.evidence_pr || null, limits: authorizationStatus(snapshot.state) };
    if (await github.viewerLogin() !== snapshot.state.authorization.lead_actor) throw new Error("recovery requires the frozen lead GitHub identity");
    if (existsSync(runPath(root, runId, artifactRoot))) throw new Error("a local manifest already exists; recovery will not overwrite it");
    let recovered = { ...snapshot.state.authorization.scope.snapshot, created_at: snapshot.state.authorization.created_at,
      state: "recovered", assignments: snapshot.state.authorization.scope.snapshot.assignments.map(normalizeAssignment) };
    if (snapshot.state.evidence_pr) {
      const pr = await github.getPr(snapshot.state.evidence_pr.number);
      const head = evaluationCommand(root, "git", ["rev-parse", "HEAD"]).trim();
      if (head !== pr.currentHead) throw new Error("checkout the exact evidence PR head in an isolated lead checkout before manifest recovery");
      const prior = normalizeRunManifest(parseInput(evaluationCommand(root, "git", ["show", `${head}:${evaluationDirectory(runId, artifactRoot)}/RUN.yaml`]), { legacyManifest: true }), runId, artifactRoot, { recovering: true });
      if (authorizationDigest(evaluationScopeSnapshot(prior)) !== authorizationDigest(snapshot.state.authorization.scope.snapshot)) throw new Error("committed manifest differs from protected scope");
      recovered = prior;
    }
    for (const assignment of recovered.assignments) {
      const reservation = snapshot.state.reservations.find((r) => r.request.assignment === assignment.id);
      if (reservation?.receipt) assignment.receipt = reservation.receipt;
    }
    recovered.authorization = { digest: snapshot.state.authorization_digest, ref: snapshot.ref, lead_actor: snapshot.state.authorization.lead_actor };
    writeRun(root, recovered);
    return { action, run_id: runId, applied: true, authorization: recovered.authorization, limits: authorizationStatus(snapshot.state) };
  }
  // Portfolio reads can use the protected snapshot after local-ledger loss.
  // No actuator may use this shortcut or silently restore a local manifest.
  const manifest = action === "status" && opts.readOnlyManifest
    ? opts.readOnlyManifest : readRun(root, runId, artifactRoot);
  if (action === "migrate") {
    if (manifest.version === EVALUATION_VERSION) return { action, run_id: runId, migrated: false, reason: "already_current" };
    if (![1, 2].includes(manifest.version)) throw new Error("unsupported legacy evaluation version");
    const original = readFileSync(runPath(root, runId, artifactRoot), "utf8");
    if (!flag(args, "--confirm")) return { action, run_id: runId, from_version: manifest.version, to_version: EVALUATION_VERSION, applied: false };
    const backup = join(root, evaluationDirectory(runId, artifactRoot), `LEGACY_RUN.v${manifest.version}.yaml`);
    assertNoSymlinkAncestors(root, `${evaluationDirectory(runId, artifactRoot)}/LEGACY_RUN.v${manifest.version}.yaml`);
    if (existsSync(backup) && readFileSync(backup, "utf8") !== original) throw new Error("legacy migration backup already exists with different content; preserve it and inspect before retrying");
    if (!existsSync(backup)) writeFileSync(backup, original, { encoding: "utf8", flag: "wx" });
    manifest.legacy = { version: manifest.version, sealed_waves: manifest.sealed_waves || [], verification: "unverified" };
    manifest.version = EVALUATION_VERSION; manifest.state = "legacy_unverified"; manifest.sealed_waves = [];
    manifest.evidence_policy = { allow_deployed: false, public_hosts: [] };
    for (const assignment of manifest.assignments) {
      assignment.history = [...(assignment.history || []), { legacy: true, state: assignment.state, collected_at: assignment.collected_at,
        collection: assignment.collection || null, admission: assignment.admission || null }];
      assignment.state = "legacy_unverified"; assignment.collected_at = null;
      assignment.collection = null; assignment.admission = null;
    }
    writeRun(root, manifest);
    return { action, run_id: runId, migrated: true, verification: "unverified", backup };
  }
  if (action === "status") {
    let authority = null;
    let authorityStatus = manifest.version === EVALUATION_VERSION ? "not_authorized" : "legacy_unverified";
    if (manifest.version === EVALUATION_VERSION) {
      try {
        authority = await (opts.authorityStore || githubAuthorizationStore(root, { github: opts.github || githubClient(root) })).read(runId);
        if (authority) authorityStatus = "protected";
      } catch { authorityStatus = "observation_failed"; }
    }
    const assignments = manifest.assignments.map((assignment) => {
      const durable = authority?.state.reservations.find((r) => r.request.assignment === assignment.id);
      const receipt = durable?.receipt || assignment.receipt;
      return { ...assignment, receipt, provider_observation: receipt
        ? observeExecution(receipt, manifest.environment_id, opts) : { state: durable?.state === "not_submitted" ? "not_submitted" : durable ? "reserved_without_receipt" : "not_launched" } };
    });
    let review = null, corpus = null, publication = null;
    if (authority?.state.evidence_pr) {
      try {
        const pr = await (opts.github || githubClient(root)).getPr(authority.state.evidence_pr.number);
        publication = { ...authority.state.evidence_pr, current_head: pr.currentHead, state: pr.state };
        review = evaluationReviewStatus(authority.state, pr);
        try { corpus = inspectCommittedEvaluationCorpus(root, manifest, authority.state, pr); }
        catch { corpus = { state: "observation_failed", error_code: "exact_evidence_checkout_unavailable" }; }
        if (corpus.corpus_digest) review = evaluationReviewStatus(authority.state, pr, { corpusDigest: corpus.corpus_digest });
        let seal = null;
        if (review.pass && corpus.totals && !corpus.totals.unresolved && pr.state === "OPEN") {
          const payload = sealEvaluationPayload(authority.state, pr, corpus, review);
          seal = findEvaluationAttestation(pr.comments, "seal", payload, authority.state.authorization.lead_actor, pr.url);
        }
        review = { ...review, sealed: !!seal, seal_url: seal?.url || null };
      } catch { review = { state: "observation_failed", sealed: false, error_code: "evidence_pr_or_corpus_unavailable" }; }
    }
    return { run_id: runId, base_sha: manifest.base_sha, version: manifest.version,
      verification: manifest.version === EVALUATION_VERSION ? "requires_admission" : "legacy_unverified", state: manifest.state, assignments,
      authority_status: authorityStatus, limits: authority ? authorizationStatus(authority.state) : null, publication, corpus, review,
      decision_report: authority ? decisionReport(authority.state) : null,
      executions: (authority?.state.reservations || []).map((reservation) => ({ key: reservation.key, role: reservation.role,
        receipt: reservation.receipt, state: reservation.state, model_policy: reservation.request.model_policy || null,
        observation: reservation.receipt ? observeExecution(reservation.receipt, manifest.environment_id, opts)
          : { state: reservation.state === "not_submitted" ? "not_submitted" : "reserved_without_receipt" } })) };
  }
  if (manifest.version !== EVALUATION_VERSION) throw new Error("legacy evaluation is unverified; use eval migrate --run <id> --confirm before mutation or admission");
  const authorityStore = () => opts.authorityStore || githubAuthorizationStore(root, { github: opts.github || githubClient(root) });
  const verifyAuthority = async (state) => {
    if (authorizationDigest(state.authorization.scope.snapshot) !== authorizationDigest(evaluationScopeSnapshot(manifest))) {
      throw new Error("local evaluation scope differs from protected authorization; restore it, do not silently adopt or relaunch");
    }
    const actor = await (opts.github || githubClient(root)).viewerLogin();
    if (actor !== state.authorization.lead_actor) throw new Error("evaluation actuator requires the frozen lead GitHub actor");
  };
  if (action === "decision") {
    const store = authorityStore(), snapshot = await store.read(runId);
    if (!snapshot?.state.evidence_pr) throw new Error("decision needs protected authorization and the lead-owned evidence PR");
    await verifyAuthority(snapshot.state);
    return recordDecisionForPr({ store, runId, github: opts.github || githubClient(root), prNumber: snapshot.state.evidence_pr.number,
      expectedHead: value(args, "--expected-head"), input: opts.decisionRecord || readDecisionFile(value(args, "--record-file")),
      confirm: flag(args, "--confirm"), now: now() });
  }
  if (action === "continuation") {
    const store = authorityStore(), snapshot = await store.read(runId);
    if (!snapshot) throw new Error("continuation requires protected evaluation authorization");
    await verifyAuthority(snapshot.state);
    return recordRunContinuation({ store, runId, github: opts.github || githubClient(root),
      record: opts.continuationRecord || readDecisionFile(value(args, "--receipt-file")), confirm: flag(args, "--confirm"), now: now() });
  }
  if (["attach", "accept", "critic", "ack", "seal", "repair"].includes(action)) {
    const store = authorityStore(); const snapshot = await store.read(runId);
    if (!snapshot) throw new Error("evaluation review requires protected authorization");
    await verifyAuthority(snapshot.state);
    return runEvaluationReviewAction(root, action, { manifest, store, github: opts.github || githubClient(root),
      expectedHead: value(args, "--expected-head"), prNumber: Number(value(args, "--pr")), assignmentId: value(args, "--assignment"),
      decision: value(args, "--decision") || "accepted", packetDigest: value(args, "--packet-digest"), reason: value(args, "--reason"),
      redactionInspected: flag(args, "--redaction-inspected"), commentUrl: value(args, "--comment-url"), criticRole: value(args, "--critic-role"),
      allowIncomplete: flag(args, "--allow-incomplete"),
      repairPacket: action === "repair" && value(args, "--packet") ? parseInput(readFileSync(resolve(value(args, "--packet")), "utf8")) : null,
      confirm: flag(args, "--confirm"), opts });
  }
  if (action === "collect-repair") {
    const snapshot = await authorityStore().read(runId);
    if (!snapshot) throw new Error("repair collection requires protected authorization");
    await verifyAuthority(snapshot.state);
    const reservation = snapshot.state.reservations.find((r) => r.key === value(args, "--launch-key") && r.role === "repair");
    if (!reservation?.receipt) throw new Error("repair collection needs an exact durably recorded receipt");
    const pr = await (opts.github || githubClient(root)).getPr(snapshot.state.evidence_pr.number);
    if (pr.state !== "OPEN" || pr.currentHead !== reservation.expected_head) throw new Error("repair evidence PR head moved before collection");
    const diff = (opts.cloudDiff || ((id) => run("codex", ["cloud", "diff", id], root)))(reservation.receipt.external_id);
    const apply = flag(args, "--apply");
    const result = (apply ? applyEvaluationRepairPatch : inspectEvaluationRepairPatch)(root, { run: manifest, reservation, diff });
    if (apply && result.ok) {
      for (const packet of result.packets) {
        const assignment = assignmentFor(manifest, packet.assignment);
        if (assignment.collection?.packet_digest === packet.digest) continue;
        assignment.history = [...(assignment.history || []), { collection: assignment.collection || null, admission: assignment.admission || null }];
        assignment.collected_at = new Date().toISOString(); assignment.state = "validated"; assignment.admission = null;
        assignment.collection = { packet_digest: packet.digest, patch_digest: result.patch_digest, at: assignment.collected_at,
          receipt: reservation.receipt, repair_launch_key: reservation.key, counts: packet.counts };
      }
      manifest.repair_collections = [...(manifest.repair_collections || []), { launch_key: reservation.key, patch_digest: result.patch_digest }];
      writeRun(root, manifest);
    }
    return { action, run_id: runId, launch_key: reservation.key, ...result, applied: apply && result.ok };
  }
  if (action === "authorize") {
    const file = value(args, "--authorization");
    if (!file || !flag(args, "--confirm")) throw new Error("authorize requires --authorization <policy.yaml> --confirm for the approved scope and limits");
    const github = opts.github || githubClient(root);
    const store = authorityStore();
    const prior = await store.read(runId);
    if (!prior && (manifest.legacy || manifest.assignments.some((assignment) => assignment.receipt))) {
      throw new Error("historical or already-launched runs cannot receive a fresh launch budget; preserve their receipts and create a new authorized run");
    }
    const policy = parseInput(readFileSync(resolve(file), "utf8"));
    const initial = freezeAuthorization({ ...policy, version: 1, run_id: runId, mode: "evaluation", source_sha: manifest.base_sha,
      lead_actor: await github.viewerLogin(), scope: { description: policy?.scope?.description,
        snapshot: evaluationScopeSnapshot(manifest) } }, { now: prior?.state.authorization.created_at || now() });
    if (initial.authorization.providers.evaluator !== "codex") throw new Error("this evaluation transport supports Codex Cloud evaluators only; no provider substitution was made");
    const result = prior ? { written: false, current: prior } : await store.compareAndSwap(runId, null, initial);
    if (!result.current || result.current.state.authorization_digest !== initial.authorization_digest) {
      throw new Error("a different protected authorization already owns this run; inspect it without replacing its authority or budgets");
    }
    manifest.authorization = { digest: initial.authorization_digest, ref: result.current.ref, lead_actor: initial.authorization.lead_actor };
    writeRun(root, manifest);
    return { action, run_id: runId, authorization: manifest.authorization, duplicate: !result.written, limits: authorizationStatus(result.current.state),
      continuation: continuationStatus(result.current.state, { now: Date.parse(now()) }) };
  }
  if (action === "observe") {
    const store = authorityStore();
    const prior = await store.read(runId);
    if (!prior) throw new Error("no protected evaluation authority to reconcile");
    await verifyAuthority(prior.state);
    const observations = [];
    let cacheChanged = false;
    for (const reservation of prior.state.reservations) {
      if (!reservation.receipt) { observations.push({ key: reservation.key, state: reservation.state === "not_submitted" ? "not_submitted" : "reserved_without_receipt" }); continue; }
      if (reservation.provider !== "codex") { observations.push({ key: reservation.key, state: "observation_failed", error_code: "unsupported_observation_provider" }); continue; }
      const observation = observeExecution(reservation.receipt, manifest.environment_id, opts);
      await mutateAuthorization(store, runId, (state) => ({ state: recordLaunchObservation(state, reservation.key, observation) }));
      observations.push({ key: reservation.key, ...observation });
      const assignment = manifest.assignments.find((a) => a.id === reservation.request.assignment);
      if (assignment && authorizationDigest(assignment.receipt) !== authorizationDigest(reservation.receipt)) {
        assignment.receipt = reservation.receipt; cacheChanged = true;
      }
    }
    if (cacheChanged) writeRun(root, manifest);
    return { action, run_id: runId, observations, limits: authorizationStatus((await store.read(runId)).state) };
  }
  if (action === "reconcile") {
    const store = authorityStore(), snapshot = await store.read(runId);
    if (!snapshot) throw new Error("receipt reconciliation requires protected authorization");
    await verifyAuthority(snapshot.state);
    const key = value(args, "--launch-key");
    const reservation = snapshot.state.reservations.find((entry) => entry.key === key);
    if (!reservation || reservation.provider !== "codex") throw new Error("reconciliation requires an exact Codex reservation");
    const id = value(args, "--task-id"), url = value(args, "--task-url");
    if (!/^task_[A-Za-z0-9_-]+$/.test(id || "") || ![`https://chatgpt.com/codex/tasks/${id}`, `https://chatgpt.com/codex/cloud/tasks/${id}`].includes(url)) {
      throw new Error("supply the exact inspected task ID and matching task URL, never a recent-task guess");
    }
    const receipt = reservation.receipt || { provider: "codex", external_id: id, external_url: url,
      model_policy: reservation.request.model_policy || null };
    if (receipt.external_id !== id || receipt.external_url !== url) throw new Error("cannot replace a recorded receipt");
    const observation = observeExecution(receipt, manifest.environment_id, opts);
    const result = await mutateAuthorization(store, runId, (state) => ({ state: reconcileLaunchReceipt(state, key, {
      actor: snapshot.state.authorization.lead_actor, receipt, observation, reason: value(args, "--reason"),
      confirm: flag(args, "--confirm"), now: now(),
    }) }));
    return { action, run_id: runId, launch_key: key, receipt, observation, limits: authorizationStatus(result.state) };
  }
  if (action === "validate") {
    const assignment = assignmentFor(manifest, value(args, "--assignment"));
    return { action, run_id: runId, assignment: assignment.id,
      ...inspectLocalEvaluationPacket(root, { run: manifest, assignment }) };
  }
  if (action === "launch") {
    // Approval is frozen once in GitHub, not repeatedly requested per launch.
    const store = authorityStore();
    const authorized = await store.read(runId);
    if (!authorized) throw new Error("evaluation requires protected authorization before launch; use eval authorize");
    await verifyAuthority(authorized.state);
    const continuation = continuationStatus(authorized.state, { now: Date.parse(now()) });
    if (!continuation.launch_ready) return { action, run_id: runId, state: "awaiting_continuation", launched: [], continuation };
    const modelPolicy = qualifyModelPreference({ provider: "codex", preference: roleModelPreference(authorized.state.authorization.model_preferences, "evaluator", opts.modelPreference) });
    const wave = value(args, "--wave");
    const diagnostic = (opts.diagnoseCloud || diagnoseCodexCloud)({ environmentId: manifest.environment_id });
    if (!diagnostic.ok) throw new Error(`Codex Cloud provider unavailable: ${diagnostic.reason}`);
    const launched = [];
    for (const assignment of assignmentsForWave(manifest, wave)) {
      const prompt = buildEvaluationPrompt({ run: manifest, assignment })
        + `\nFrozen authorized verification commands: ${JSON.stringify(authorized.state.authorization.verification_commands)}. Do not run other tests, builds or installers. Read-only source inspection and the required local packet commit are allowed.\n`;
      const owner = randomUUID();
      const key = `evaluation:${runId}:assignment:${assignment.id}`;
      const reservation = await mutateAuthorization(store, runId, (state) => reserveAuthorizedLaunch(state, {
        key, role: "evaluator", provider: "codex", expected_head: manifest.base_sha, assignment: assignment.id,
        environment_id: manifest.environment_id, prompt_digest: authorizationDigest(prompt),
        model_policy: modelPolicy,
      }, { owner, now: now() }));
      if (!reservation.reserved) {
        assignment.receipt = reservation.reservation.receipt;
        assignment.state = reservation.reservation.state;
        launched.push({ id: assignment.id, skipped: true, state: assignment.state, receipt: assignment.receipt });
        writeRun(root, manifest); continue;
      }
      let submissionAttempted = false;
      try {
        const currentAuthority = (await store.read(runId)).state;
        if (!continuationStatus(currentAuthority, { now: Date.parse(now()) }).launch_ready) throw new Error("desktop continuation paused or expired before submission");
        if (!authorizationStatus(currentAuthority, { now: Date.parse(now()) }).launch_window_open) {
          throw new Error("launch deadline passed after reservation");
        }
        submissionAttempted = true;
        const launchedReceipt = await (opts.launchCloud || launchCodexCloud)({ environmentId: manifest.environment_id,
          branch: manifest.base_sha, attempts: 1, prompt });
        const receipt = { ...launchedReceipt, model_policy: modelPolicy };
        // Persist exact receipt remotely BEFORE updating the local cache. A
        // restart must not need this checkout to know that a slot was spent.
        await mutateAuthorization(store, runId, (state) => ({ state: recordLaunchOutcome(state, key, { owner, receipt }) }));
        assignment.receipt = receipt; assignment.state = "launched"; launched.push({ id: assignment.id, receipt });
        writeRun(root, manifest);
      } catch {
        try { await mutateAuthorization(store, runId, (state) => ({ state: submissionAttempted
          ? recordLaunchOutcome(state, key, { owner, ambiguous: true }) : recordLaunchNotSubmitted(state, key, { owner }) })); }
        catch { /* The durable reservation itself still consumes capacity. */ }
        if (!submissionAttempted) throw new Error(`evaluation launch ${key} stopped before provider submission; its spent reservation is retained. No provider receipt exists to reconcile`);
        throw new Error(`evaluation submission ${key} is unresolved; its protected reservation consumes capacity. Reconcile the exact receipt; do not retry the provider submission`);
      }
    }
    manifest.state = "running"; writeRun(root, manifest);
    return { action, run_id: runId, wave, launched, model_policy: modelPolicy };
  }
  if (action === "collect") {
    const id = value(args, "--assignment");
    const assignment = assignmentFor(manifest, id);
    if (!assignment.receipt) throw new Error(`assignment ${id} has not been launched`);
    const diff = (opts.cloudDiff || ((taskId) => run("codex", ["cloud", "diff", taskId], root)))(assignment.receipt.external_id);
    const apply = flag(args, "--apply");
    const result = (apply ? applyEvaluationPatch : inspectEvaluationPatch)(root, { run: manifest, assignment, diff });
    if (apply && result.ok) {
      if (assignment.collection) assignment.history = [...(assignment.history || []), { collection: assignment.collection, admission: assignment.admission || null }];
      assignment.collected_at = new Date().toISOString(); assignment.state = "validated";
      assignment.collection = { packet_digest: result.digest, patch_digest: result.patch_digest, at: assignment.collected_at,
        counts: result.counts, receipt: assignment.receipt,
        worker_revision: { sha: null, verification: "unverified", reason: "supported Codex Cloud diff transport does not expose an authoritative worker commit SHA" } };
      assignment.admission = null;
      writeRun(root, manifest);
    }
    return { action, run_id: runId, assignment: id, ...result, applied: apply && result.ok };
  }
  throw new Error(`unknown evaluation action: ${action}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  try {
    const result = await runEvaluation(process.cwd(), process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  }
  catch (error) { console.error(`roadmap gauntlet eval: ${error.message}`); process.exit(1); }
}
