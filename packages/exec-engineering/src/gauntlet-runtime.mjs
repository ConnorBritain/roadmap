// roadmap gauntlet runtime (engineering executor) — senses + remote-agent actuators for a conducted
// implementation → independent critic → lead-synthesized repair loop.
//
// This file owns IO only. packages/core gauntlet-core.mjs owns the protocol/state math; the
// github-pr GauntletArtifact adapter (packages/exec-engineering) owns every GitHub call;
// .roadmap-gauntlet-state.json is a minimal launch ledger, while GitHub carries the work.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { flatten, loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { loadBacklog, roadmapPaths } from "@connorbritain/roadmap-core/store.mjs";
import { githubPrArtifact, normalizingGauntletClient } from "./github-pr-artifact.mjs";
import {
  buildCriticPrompt,
  buildImplementationPrompt,
  buildRepairPrompt,
  deriveRunStatus,
  freezeQualityBar,
  gauntletProtocolDigest,
  gauntletLaunchKey,
  implementationAttemptForRunId,
  implementationRunId,
  parseFrozenBarBlock,
  parseGauntletPrMarkers,
  reconstructCancellationFromComments,
  reconstructLaunchesFromComments,
  reconstructVerdictAcksFromComments,
  renderGauntletCancellationMarker,
  renderGauntletLaunchMarker,
  renderGauntletVerdictAck,
} from "@connorbritain/roadmap-core/gauntlet-core.mjs";
import { parseRoadmapMarker } from "./pr-identity.mjs";
import { outOfCycle } from "@connorbritain/roadmap-core/cycle-core.mjs";
import { normalizeLinearConfig } from "@connorbritain/roadmap-core/linear-core.mjs";
import {
  findLedgerRun, launchReceipt, mutateGauntletLedger, readGauntletLedger,
} from "@connorbritain/roadmap-core/gauntlet-store.mjs";
import {
  currentClaudeAccount, fireRoutine as dispatchFireRoutine, loadRoutineProfiles,
  repoSlugOf, resolveRoutine,
} from "./cloud-dispatch.mjs";
import {
  diagnoseCodexCloud, launchCodexCloud, normalizeCloudProvider, observeCodexCloudTask, resolveCodexEnvironment,
} from "./cloud-agent-providers.mjs";
import { freezeImplementationAuthority, readImplementationAuthority, reserveImplementationCapacity,
  submitWithImplementationCapacity, authorizedVerificationPrompt, implementationAuthorityStore } from "@connorbritain/roadmap-core/implementation-authorization.mjs";
import { authorizationStatus, recordLaunchObservation, reconcileLaunchReceipt, continuationStatus } from "@connorbritain/roadmap-core/gauntlet-authorization.mjs";
import { mutateAuthorization, recordRunContinuation } from "@connorbritain/roadmap-core/gauntlet-authority.mjs";
import { observeAuthorizedExecution } from "./gauntlet-observation.mjs";
import { roleModelPreference, qualifyModelPreference } from "@connorbritain/roadmap-core/model-policy.mjs";
import { recordDecisionForPr, decisionReport, readDecisionFile } from "@connorbritain/roadmap-core/gauntlet-decisions.mjs";

const FULL_SHA = /^[a-f0-9]{40}$/;
const DEFAULT_MAX_ROUNDS = 3;
const TERMINAL = new Set(["passed", "human_required", "exhausted", "cancelled", "merged", "closed"]);
// The github-pr GauntletArtifact adapter lives in the engineering executor package; the runtime
// wraps whatever client it is given (real or a test fake) so every artifact is in the neutral shape.
export { githubClient, normalizeGauntletPr } from "./github-pr-artifact.mjs";
function gauntletClient(root, opts, remote = "origin") {
  return normalizingGauntletClient(opts.github || githubPrArtifact(root, { execImpl: opts.execImpl, remote }));
}

function subjectFor(root, key) {
  const graph = loadGraph(roadmapPaths(root).yaml);
  const node = flatten(graph).nodes.find((candidate) => candidate.invoke === key);
  if (node) return { type: "slice", key, graph, node, item: null, tier: node.dispatchTier || null };
  const item = ((loadBacklog(root) || {}).items || []).find((candidate) => candidate.id === key);
  if (item) return { type: "backlog", key, graph, node: null, item, tier: item.dispatch_tier || null };
  throw new Error(`no slice or backlog item "${key}"`);
}

function baseShaOf(root, graph, execImpl = spawnSync, allowLocalHead = false) {
  const meta = graph.meta || {};
  const remote = meta.remote || "origin";
  const branch = meta.base_branch || "main";
  const preferred = `${remote}/${branch}`;
  const displayPreferred = `${/^[A-Za-z0-9._-]+$/.test(remote) ? remote : "configured-remote"}/${branch}`;
  if (!allowLocalHead) {
    const fetched = execImpl("git", ["fetch", "--quiet", remote, branch], { cwd: root, encoding: "utf8" });
    if (fetched.error || fetched.status !== 0) {
      throw new Error(`cannot refresh declared baseline ${displayPreferred}; check the remote, branch, and git credentials`);
    }
  }
  for (const ref of [preferred, ...(allowLocalHead ? ["HEAD"] : [])]) {
    const r = execImpl("git", ["rev-parse", "--verify", ref], { cwd: root, encoding: "utf8" });
    const sha = r.status === 0 ? (r.stdout || "").trim().toLowerCase() : "";
    if (FULL_SHA.test(sha)) return sha;
  }
  throw new Error(`cannot resolve the declared baseline ${displayPreferred}; fetch it first${allowLocalHead ? " (local HEAD fallback also failed)" : ""}`);
}

function routineContext(root, opts, { role, tier, profile = null } = {}) {
  const env = opts.env || process.env;
  return resolveRoutine({
    env,
    profiles: opts.profiles !== undefined ? opts.profiles : loadRoutineProfiles(env),
    accountEmail: opts.accountEmail !== undefined ? opts.accountEmail : currentClaudeAccount(),
    repoSlug: opts.repoSlug !== undefined ? opts.repoSlug : repoSlugOf(root),
    tier: tier || null,
    role,
    profile,
  });
}

function gauntletProvider(metaCfg, opts, role, run = null) {
  const camel = `${role}Provider`;
  const snake = `${role}_provider`;
  const frozen = run && (run[snake] || run[camel]);
  return normalizeCloudProvider(opts[camel] || opts.provider || frozen || metaCfg[snake] || metaCfg[camel] || "claude");
}

async function launchGauntletAgent(root, opts, { graph, run, role, tier = null, profile = null, provider, prompt, branch = null } = {}) {
  const modelPolicy = qualifyModelPreference({ provider, preference: roleModelPreference(run.model_preferences || {}, role, opts.modelPreference || null) });
  if (provider === "claude") {
    const routine = routineContext(root, opts, { role, tier, profile });
    const fired = await (opts.fireRoutine || dispatchFireRoutine)(routine, prompt, opts.fetchImpl || fetch);
    if (!fired || typeof fired.claude_code_session_id !== "string" || !fired.claude_code_session_id.trim()
      || typeof fired.claude_code_session_url !== "string" || !fired.claude_code_session_url.trim()) {
      throw new Error("Claude Routine returned a malformed success payload (missing session id/url); POST outcome is ambiguous");
    }
    return {
      provider, external_id: fired.claude_code_session_id, external_url: fired.claude_code_session_url, model_policy: modelPolicy,
      provider_metadata: { routine: routine.source, tier: tier || null },
      session_id: fired.claude_code_session_id, session_url: fired.claude_code_session_url, routine: routine.source,
    };
  }
  const environmentId = run.authorization_digest ? run.environment_id
    : resolveCodexEnvironment({ meta: graph.meta || {}, override: opts.environmentId });
  if (run.authorization_digest && opts.environmentId && opts.environmentId !== environmentId) throw new Error("environment override differs from frozen implementation authorization");
  const diagnostic = diagnoseCodexCloud({ environmentId, execImpl: opts.execImpl || spawnSync });
  if (!diagnostic.ok) throw new Error(`Codex Cloud provider unavailable: ${diagnostic.reason}`);
  const receipt = launchCodexCloud({ environmentId, prompt, attempts: run.authorization_digest ? 1 : opts.attempts || 1, branch,
    model: opts.model || null, execImpl: opts.execImpl || spawnSync });
  return { ...receipt, provider, provider_metadata: receipt.provider_metadata, model_policy: modelPolicy };
}

function nowIso(opts) {
  const value = opts.now ? opts.now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function cancellationClaimKey(run) {
  return `gauntlet:cancellation:${run.run_id}:${gauntletProtocolDigest(run)}`;
}

function cancellationTombstoneClaimKey(run) {
  return `gauntlet:tombstone:${run.run_id}:${gauntletProtocolDigest(run)}`;
}

function recoveredBarConfirmationRequired(run) {
  return !!(run && run.reconstructed
    && ((run.launches || []).length === 0 || run.recovery_requires_bar_confirmation === true)
    && !run.recovered_bar_confirmed_at);
}

function launchProofOf(launch) {
  return (launch && (launch.nonce_sha256 || launch.nonceSha256))
    || (launch && launch.nonce ? createHash("sha256").update(launch.nonce).digest("hex") : null)
    || (launch && (launch.packet_sha256 || launch.packetSha256)) || "none";
}

function launchIdentityOf(launch) {
  return `${launch && launch.key}:${Number((launch && launch.attempt) || 1)}:${launchProofOf(launch)}`;
}

// Keep existing Claude claim names stable so old PR attestations and protected
// refs remain reconstructable. Other providers occupy a distinct claim slot.
function providerClaimKey(launchKey, provider, attempt) {
  return provider === "claude" ? `${launchKey}:attempt:${attempt}` : `${launchKey}:provider:${provider}:attempt:${attempt}`;
}

async function assertFrozenLeadActor(github, run) {
  if (!github.actor) throw new Error("GitHub client cannot verify the frozen lead actor");
  const actor = await github.actor();
  if (actor !== run.lead_actor) {
    throw new Error(`authenticated GitHub actor ${actor || "unknown"} does not match frozen Gauntlet lead ${run.lead_actor}; use that identity or begin an explicit new run`);
  }
}

async function assertClaimProtection(github, claimKey, runId) {
  // Injected clients in pure/integration tests may omit the deployment probe.
  // The production GitHub client always provides it and refuses unsafe rules.
  if (github.assertClaimSafety) await github.assertClaimSafety(claimKey, runId);
}

async function claimDurableCancellation(github, run, claimKey) {
  await assertFrozenLeadActor(github, run);
  await assertClaimProtection(github, claimKey, run.run_id);
  if (!github.claim) throw new Error("GitHub client cannot durably claim a Gauntlet cancellation");
  let claim;
  try { claim = await github.claim(claimKey, run.base_sha, run.run_id); }
  catch (e) { throw new Error(`cancellation claim outcome is ambiguous; no local cancellation was recorded: ${e.message}`); }
  return claim;
}

async function recordDurableCancellation(github, pr, run, reason) {
  const claim = await claimDurableCancellation(github, run, cancellationClaimKey(run));
  await github.comment(pr.number, renderGauntletCancellationMarker({ run, reason }));
  return claim;
}

function updateLaunch(root, runId, keyOrLaunch, patch) {
  return mutateGauntletLedger(root, (ledger) => {
    const run = ledger.runs[runId];
    if (!run) throw new Error(`Gauntlet run ${runId} disappeared from the local ledger`);
    const identity = typeof keyOrLaunch === "string" ? null : launchIdentityOf(keyOrLaunch);
    const launch = [...(run.launches || [])].reverse().find((candidate) => identity
      ? launchIdentityOf(candidate) === identity
      : candidate.key === keyOrLaunch);
    const display = typeof keyOrLaunch === "string" ? keyOrLaunch : identity;
    if (!launch) throw new Error(`Gauntlet launch receipt ${display} disappeared from ${runId}`);
    Object.assign(launch, patch);
    run.updated_at = patch.updated_at || new Date().toISOString();
    if (patch.status === "ambiguous" || patch.status === "failed") run.last_state = "launch_ambiguous";
    else if (patch.status === "aborted_stale") run.last_state = "awaiting_critic";
    return launch;
  });
}

function publicLaunch(launch) {
    if (!launch) return null;
    const { nonce: _secret, ...safe } = launch;
    return safe;
}

function publicRun(run) {
  return {
    runId: run.run_id,
    subjectType: run.subject_type,
    subjectKey: run.subject_key,
    baseSha: run.base_sha,
    baseRef: run.base_ref,
    leadActor: run.lead_actor,
    maxRounds: run.max_rounds,
    barSha256: run.bar_sha256,
    criticTier: run.critic_tier || null,
    repairTier: run.repair_tier || null,
    implementationProvider: run.implementation_provider || "claude",
    criticProvider: run.critic_provider || "claude",
    repairProvider: run.repair_provider || "claude",
    frozenBar: run.frozen_bar_markdown,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    implementationExecution: publicLaunch((run.launches || []).find((l) => l.role === "implementation") || null),
    criticExecutions: (run.launches || []).filter((l) => l.role === "critic").map(publicLaunch),
    repairExecutions: (run.launches || []).filter((l) => l.role === "repair").map(publicLaunch),
    // Compatibility aliases for existing MCP consumers; generic execution keys
    // are the authoritative names for new callers.
    implementationSession: publicLaunch((run.launches || []).find((l) => l.role === "implementation") || null),
    criticSessions: (run.launches || []).filter((l) => l.role === "critic").map(publicLaunch),
    repairSessions: (run.launches || []).filter((l) => l.role === "repair").map(publicLaunch),
    reconstructed: !!run.reconstructed,
    authorizationDigest: run.authorization_digest || null,
    requiredReviewRoles: run.required_review_roles || ["critic"],
    modelPreferences: run.model_preferences || {},
    recoveredBarConfirmedAt: run.recovered_bar_confirmed_at || null,
    recoveryActorMismatch: run.recovery_actor_mismatch || null,
    cancelledAt: run.cancelled_at || null,
    cancelReason: run.cancel_reason || null,
    cancellationCommentUrl: run.cancellation_comment_url || null,
    cancelledViaGithub: !!run.cancelled_via_github,
  };
}

// Provider observation enriches a status response only. The ledger keeps the
// submission receipt, GitHub keeps the artifact protocol, and this sensor never
// mutates either one or turns a provider outage into an implementation verdict.
function observeProviderExecutions(run, opts = {}) {
  const launches = (run.launches || []).map((launch) => ({ ...launch }));
  for (const launch of launches) {
    if (launch.provider !== "codex" || !launch.external_id) continue;
    try {
      const task = observeCodexCloudTask({
        taskId: launch.external_id,
        environmentId: launch.provider_metadata && launch.provider_metadata.environment_id,
        execImpl: opts.execImpl || spawnSync,
      });
      launch.provider_status = task ? task.status : "not_found";
      launch.provider_observed_at = task ? task.updated_at : null;
      launch.provider_observation_error = null;
    } catch (e) {
      launch.provider_observation_error = e.message;
    }
  }
  return { ...run, launches };
}

function reconstructRunFromPr(pr) {
  const marker = parseGauntletPrMarkers(pr && pr.body);
  const subject = parseRoadmapMarker(pr && pr.body);
  if (!marker || !subject) throw new Error(`PR #${pr.number} lacks a complete Gauntlet + roadmap identity protocol`);
  const frozen = parseFrozenBarBlock(pr.body || "");
  const run = {
    run_id: marker.runId,
    subject_type: subject.type,
    subject_key: subject.key,
    base_sha: marker.baseSha,
    base_ref: marker.baseRef,
    lead_actor: marker.leadActor,
    bar_sha256: marker.barSha256,
    frozen_bar: null,
    frozen_bar_markdown: frozen && (frozen.markdown || frozen.frozenBarMarkdown || frozen),
    max_rounds: marker.maxRounds,
    critic_tier: marker.criticTier,
    critic_profile: null,
    repair_tier: marker.repairTier,
    launches: [],
    created_at: pr.createdAt,
    updated_at: pr.updatedAt || pr.createdAt,
    last_state: "reconstructed",
    reconstructed: true,
  };
  run.launches = reconstructLaunchesFromComments({ run, comments: pr.comments || [] });
  return run;
}

async function observeGauntlet(root, idOrKey, opts = {}) {
  const ledger = readGauntletLedger(root);
  let run = findLedgerRun(ledger, idOrKey);
  let remote = "origin";
  try { remote = (loadGraph(roadmapPaths(root).yaml).meta || {}).remote || remote; } catch { /* reconstruction can proceed from an explicit fake/client */ }
  const github = gauntletClient(root, opts, remote);
  github.assertAvailable();
  let pr = null;
  if (run) pr = await github.findPrByRun(run.run_id);
  else if (String(idOrKey).startsWith("gnt_")) pr = await github.findPrByRun(idOrKey);
  else {
    const subject = subjectFor(root, idOrKey);
    pr = await github.findPrBySubject(subject.type, subject.key);
  }
  if (!run && pr) run = reconstructRunFromPr(pr);
  if (!run && String(idOrKey).startsWith("gnt_")) {
    const durable = await implementationAuthorityStore(root, github, opts)?.read(idOrKey);
    if (durable?.state.authorization.mode === "implementation") {
      run = structuredClone(durable.state.authorization.scope.snapshot.run);
      run.authorization_digest = durable.state.authorization_digest;
      run.launches = durable.state.reservations.map((reservation) => ({ ...reservation.request,
        key: reservation.request.key.replace(/:attempt:\d+$/, ""),
        nonce_sha256: reservation.request.nonce_sha256,
        status: reservation.state === "not_submitted" ? "not_submitted" : reservation.receipt ? "launched" : "ambiguous",
        external_id: reservation.receipt?.external_id, external_url: reservation.receipt?.external_url,
        provider_metadata: reservation.receipt?.provider_metadata, model_policy: reservation.request.model_policy,
      }));
    }
  }
  if (!run) throw new Error(`no Gauntlet run found for "${idOrKey}" in the local ledger or GitHub`);
  let recoveryActorMismatch = null;
  let cancellationRecordMissing = null;
  let cancellationClaimMissing = null;
  let launchAttestationFailure = null;
  let repairHistoryFailure = null;
  let baseAncestryFailure = null;
  let runClaims = [];
  if (pr) {
    const marker = parseGauntletPrMarkers(pr.body || "");
    if (!marker || marker.runId !== run.run_id) throw new Error(`PR #${pr.number} does not belong to run ${run.run_id}`);
    const immutable = [
      ["subject type", marker.subjectType, run.subject_type],
      ["subject key", marker.key, run.subject_key],
      ["base SHA", marker.baseSha, run.base_sha],
      ["base ref", marker.baseRef, run.base_ref],
      ["lead actor", marker.leadActor, run.lead_actor],
      ["frozen bar digest", marker.barSha256, run.bar_sha256],
      ["max rounds", marker.maxRounds, run.max_rounds],
      ["critic tier", marker.criticTier, run.critic_tier || null],
      ["repair tier", marker.repairTier, run.repair_tier || null],
    ];
    const drift = immutable.filter(([, actual, expected]) => actual !== expected);
    if (drift.length) {
      const implementationReceipts = (run.launches || []).filter((launch) => launch.role === "implementation");
      const lostDistributedElection = !run.reconstructed && implementationReceipts.length > 0
        && implementationReceipts.every((launch) => ["duplicate_remote", "superseded_remote"]
          .includes(String(launch.status || "").toLowerCase()));
      if (!lostDistributedElection) {
        throw new Error(`PR #${pr.number} changed frozen Gauntlet protocol for ${run.run_id}: ${drift.map(([name]) => name).join(", ")}`);
      }
      // This machine never fired the implementation worker. Its pre-election
      // candidate packet lost to another protected claimant, so discard that
      // candidate and recover the winning PR packet fail-closed. The frozen
      // lead must authenticate and explicitly inspect/confirm it before a
      // critic can be launched.
      const recoveredWinner = reconstructRunFromPr(pr);
      run = { ...recoveredWinner,
        launches: [...implementationReceipts, ...(recoveredWinner.launches || [])],
        reconstructed: true,
        recovery_requires_bar_confirmation: true,
        remote_protocol_adopted: true };
    }
    if (pr.baseRef !== run.base_ref) {
      throw new Error(`PR #${pr.number} targets ${pr.baseRef || "an unknown base"}, not frozen base branch ${run.base_ref}`);
    }
    if (!github.descendsFrom) {
      baseAncestryFailure = `PR #${pr.number} head ${pr.currentHead || "unknown"} cannot be proven to descend from frozen base ${run.base_sha}`;
    } else {
      try {
        if (!(await github.descendsFrom(run.base_sha, pr.currentHead))) {
          baseAncestryFailure = `PR #${pr.number} head ${pr.currentHead || "unknown"} does not descend from frozen base ${run.base_sha}`;
        }
      } catch (e) {
        baseAncestryFailure = `PR #${pr.number} base ancestry could not be verified: ${e.message}`;
      }
    }
    // Another conductor may have won the distributed ref claim. Pull its
    // lead-authored precommit into every read-only view so an existing stale
    // ledger and a ledgerless recovery converge on the same GitHub events.
    const durableLaunches = reconstructLaunchesFromComments({ run, comments: pr.comments || [] });
    const durableAttempts = new Set(durableLaunches.map((launch) => `${launch.key}:${launch.attempt || 1}`));
    const localLaunches = (run.launches || []).map((launch) => ["duplicate_remote", "missing_attestation"].includes(launch.status)
      && durableAttempts.has(`${launch.key}:${launch.attempt || 1}`)
      ? { ...launch, status: "superseded_remote" }
      : launch);
    const localIdentities = new Set(localLaunches.map((launch) => [
      launch.key, launchProofOf(launch),
    ].join(":")));
    run = { ...run, launches: [...localLaunches, ...durableLaunches.filter((launch) => {
      const identity = [launch.key, launchProofOf(launch)].join(":");
      return !localIdentities.has(identity);
    })] };
    const repairHeads = [...new Set(run.launches.filter((launch) => launch.role === "repair"
      && !["preflight_failed", "aborted_stale", "duplicate_remote", "superseded_remote", "cancelled"]
        .includes(String(launch.status || "").toLowerCase()))
      .map((launch) => launch.expected_head)
      .filter((head) => FULL_SHA.test(head || "")))];
    // Base ancestry is the stronger prerequisite. If it already failed, do
    // not let a secondary repair comparison mask that diagnostic. Otherwise
    // compare failures are themselves recoverable infrastructure state so an
    // explicit durable cancellation can still be reconstructed or recorded.
    if (!baseAncestryFailure) for (const repairHead of repairHeads) {
      if (!github.descendsFrom) {
        repairHistoryFailure = `PR #${pr.number} repair ancestry from ${repairHead} cannot be proven`;
        break;
      }
      try {
        if (!(await github.descendsFrom(repairHead, pr.currentHead))) {
          repairHistoryFailure = `PR #${pr.number} head ${pr.currentHead} does not descend from repair expected head ${repairHead}; possible force-push/history rewrite`;
          break;
        }
      } catch (e) {
        repairHistoryFailure = `PR #${pr.number} repair ancestry from ${repairHead} could not be verified: ${e.message}`;
        break;
      }
    }
    if (github.listClaims) runClaims = await github.listClaims(run.run_id);
    if (github.listClaims && github.claimRef) {
      const launchClaims = runClaims.filter((claim) => ["critic", "repair"].includes(claim.kind));
      const expected = new Map(durableLaunches.map((launch) => {
        const key = `${launch.key}:attempt:${launch.attempt || 1}`;
        return [github.claimRef(key, run.run_id), launch];
      }));
      const claimByRef = new Map(launchClaims.map((claim) => [claim.ref, claim]));
      const orphanClaim = launchClaims.find((claim) => !expected.has(claim.ref));
      const orphanAttestation = [...expected.entries()].find(([ref]) => !claimByRef.has(ref));
      const movedClaim = [...expected.entries()].find(([ref, launch]) => {
        const claim = claimByRef.get(ref);
        return claim && claim.sha !== launch.expected_head;
      });
      if (orphanClaim) {
        launchAttestationFailure = `launch claim ${orphanClaim.ref} exists without its lead-authored PR attestation`;
      } else if (orphanAttestation) {
        launchAttestationFailure = `lead launch attestation exists without protected claim ${orphanAttestation[0]}`;
      } else if (movedClaim) {
        launchAttestationFailure = `launch claim ${movedClaim[0]} no longer points at its attested head`;
      }
    }
    // Apply a remote cancellation transiently even when a local ledger exists.
    // Status remains a read-only sensor; the cancel actuator may cache it later.
    const remoteCancellation = reconstructCancellationFromComments({ run, comments: pr.comments || [] });
    const expectedTombstoneRef = github.claimRef
      ? github.claimRef(cancellationTombstoneClaimKey(run), run.run_id)
      : null;
    const cancellationTombstone = expectedTombstoneRef
      ? runClaims.find((claim) => claim.kind === "tombstone" && claim.ref === expectedTombstoneRef) || null
      : null;
    let cancellationClaim = null;
    if (github.readClaim) {
      cancellationClaim = await github.readClaim(cancellationClaimKey(run), run.run_id);
    }
    if (cancellationClaim && remoteCancellation) {
      if (cancellationClaim.sha !== run.base_sha) {
        cancellationClaimMissing = { ref: cancellationClaim.ref, reason: "cancellation claim points at the wrong base SHA" };
      } else {
        Object.assign(run, remoteCancellation);
      }
    } else if (cancellationClaim && !remoteCancellation) {
      cancellationRecordMissing = cancellationClaim;
    } else if (remoteCancellation && !cancellationClaim) {
      cancellationClaimMissing = { ref: null, reason: "lead-authored cancellation comment has no protected claim" };
    } else if (cancellationTombstone) {
      if (cancellationTombstone.sha !== run.base_sha) {
        cancellationClaimMissing = { ref: cancellationTombstone.ref,
          reason: "pre-PR cancellation tombstone points at the wrong base SHA" };
      } else {
        Object.assign(run, { cancelled: true, cancel_reason: "Cancelled before the implementation PR appeared.",
          cancelled_via_github: true, cancellation_tombstone_ref: cancellationTombstone.ref });
      }
    }
  }
  if (run.reconstructed && ((run.launches || []).length > 0 || run.cancelled_via_github)) {
    let actor = null;
    try { actor = github.actor ? await github.actor() : null; } catch { actor = null; }
    if (actor !== run.lead_actor) {
      recoveryActorMismatch = { expected: run.lead_actor, actual: actor };
      // The PR body is builder-authored. Durable lead events become a trust
      // anchor only for a session authenticated as their frozen lead.
      run = { ...run, launches: [], recovery_actor_mismatch: recoveryActorMismatch };
      if (run.cancelled_via_github) {
        delete run.cancelled;
        delete run.cancelled_at;
        delete run.cancel_reason;
        delete run.cancellation_comment_url;
        delete run.cancellation_tombstone_ref;
        delete run.cancelled_via_github;
      }
    }
  }
  const authority = await readImplementationAuthority(root, run, github, opts);
  const status = deriveRunStatus({ run, pr, comments: pr ? pr.comments : [], commits: pr ? pr.commits : [] });
  if (recoveryActorMismatch) {
    status.safeActions = ["authenticate_frozen_lead"];
    status.canLaunchCritic = false;
    status.canLaunchRepair = false;
    status.canMerge = false;
    status.terminal = false;
    status.recoveryActorMismatch = recoveryActorMismatch;
  }
  const effectiveBaseAncestryFailure = run.cancelled_via_github ? null : baseAncestryFailure;
  const effectiveLaunchAttestationFailure = run.cancelled_via_github ? null : launchAttestationFailure;
  const effectiveRepairHistoryFailure = run.cancelled_via_github ? null : repairHistoryFailure;
  const protocolFailure = effectiveBaseAncestryFailure || effectiveRepairHistoryFailure || effectiveLaunchAttestationFailure
    || (cancellationRecordMissing && `cancellation claim ${cancellationRecordMissing.ref} exists but its lead-authored PR record is missing`)
    || (cancellationClaimMissing && cancellationClaimMissing.reason);
  if (protocolFailure && !recoveryActorMismatch && String(pr && pr.state).toUpperCase() === "OPEN") {
    status.state = "infrastructure_failure";
    status.safeActions = effectiveBaseAncestryFailure || effectiveRepairHistoryFailure
      ? ["restore_pr_history", "cancel_run"]
      : effectiveLaunchAttestationFailure
      ? ["reconcile_launch_attestation", "cancel_run"]
      : ["restore_cancellation_record"];
    status.canLaunchCritic = false;
    status.canLaunchRepair = false;
    status.canMerge = false;
    status.terminal = false;
    status.infrastructureFailure = protocolFailure;
    if (effectiveBaseAncestryFailure) status.baseAncestryFailure = effectiveBaseAncestryFailure;
    if (effectiveRepairHistoryFailure) status.repairHistoryFailure = effectiveRepairHistoryFailure;
    if (effectiveLaunchAttestationFailure) status.launchAttestationFailure = effectiveLaunchAttestationFailure;
    if (cancellationRecordMissing) status.cancellationRecordMissing = cancellationRecordMissing;
    if (cancellationClaimMissing) status.cancellationClaimMissing = cancellationClaimMissing;
  }
  if (run.cancelled_via_github && launchAttestationFailure) {
    status.priorLaunchAttestationFailure = launchAttestationFailure;
  }
  if (run.cancelled_via_github && repairHistoryFailure) {
    status.priorRepairHistoryFailure = repairHistoryFailure;
  }
  if (run.cancelled_via_github && baseAncestryFailure) {
    status.priorBaseAncestryFailure = baseAncestryFailure;
  }
  return { ledger, run, pr, status, github, authority };
}

function persistReconstructedRun(root, run) {
  const recoveredLaunches = (run.launches || []).filter((launch) => launch.recovered_from_github === true);
  if (!run.reconstructed && !recoveredLaunches.length && !run.recovered_bar_confirmed_at) return;
  mutateGauntletLedger(root, (ledger) => {
    const existing = ledger.runs[run.run_id];
    // A distributed loser never fired the implementation worker; once the
    // winner's marked PR appears, replace the losing candidate packet with the
    // explicitly confirmed winner protocol. This is an actuator-time write,
    // never a status side effect.
    if (!existing || run.remote_protocol_adopted) {
      ledger.runs[run.run_id] = { ...run, reconstructed: true,
        launches: [...(run.launches || [])] };
      return ledger.runs[run.run_id];
    }
    // Authenticated lead launch comments are GitHub receipts. Upsert them into
    // every local ledger, not only ledgerless reconstructions, before any
    // actuator tries to mutate a recovered retry.
    const seen = new Set((existing.launches || []).map(launchIdentityOf));
    for (const launch of recoveredLaunches) {
      const key = launchIdentityOf(launch);
      if (!seen.has(key)) {
        (existing.launches || (existing.launches = [])).push({ ...launch });
        seen.add(key);
      }
    }
    if (run.recovered_bar_confirmed_at) existing.recovered_bar_confirmed_at = run.recovered_bar_confirmed_at;
    return existing;
  });
}

export async function runGauntletStart(root, key, opts = {}) {
  const subject = subjectFor(root, key);
  if (subject.type === "slice" && !opts.force
    && outOfCycle(normalizeLinearConfig(subject.graph.meta || {}), subject.node.status)) {
    throw new Error(`'${key}' is out of the current cycle (status ${subject.node.status}) — elect it first ('roadmap cycle plan', then 'roadmap cycle lock --promote ${key}'), or re-run with force=true to override the cycle lock.`);
  }
  const github = gauntletClient(root, opts, (subject.graph.meta || {}).remote || "origin");
  github.assertAvailable();

  // Refresh the latest run from GitHub before deciding it blocks a new start. Status itself
  // remains read-only; the following ledger mutation records the observed terminal state.
  const ledger = readGauntletLedger(root);
  const previous = findLedgerRun(ledger, key);
  let previousState = previous && previous.last_state;
  if (previous) {
    try { previousState = (await observeGauntlet(root, previous.run_id, { ...opts, github })).status.state; }
    catch { /* the local receipt still protects the blind window */ }
    if (!TERMINAL.has(previousState)) {
      return { duplicate: true, runId: previous.run_id, state: previousState, message: `active Gauntlet run already exists for ${key}` };
    }
  }

  // The local ledger closes the pre-PR blind window, but it may be absent after a
  // machine/session change. GitHub is durable reality: never fire another initial
  // implementer while any open exact-marker roadmap PR already owns this subject, including a
  // lower-level one-shot dispatch that has not yet adopted the Gauntlet packet.
  const existingPr = github.findOpenPrBySubject
    ? await github.findOpenPrBySubject(subject.type, key)
    : await github.findPrBySubject(subject.type, key);
  if (existingPr && existingPr.state === "OPEN") {
    const marker = parseGauntletPrMarkers(existingPr.body || "");
    const existing = marker ? reconstructRunFromPr(existingPr) : null;
    const existingStatus = existing ? deriveRunStatus({
      run: existing, pr: existingPr, comments: existingPr.comments, commits: existingPr.commits,
    }) : { state: "existing_pr" };
    return {
      duplicate: true,
      runId: existing && existing.run_id,
      state: existingStatus.state,
      prNumber: existingPr.number,
      message: `open roadmap PR #${existingPr.number} already exists for ${key}`,
    };
  }
  // A fresh machine may have no local ledger for an earlier, closed unmerged
  // attempt at this same baseline. Learn its deterministic ordinal from the
  // newest marked subject PR so a legitimate retry does not race the old
  // protected attempt-1 claim forever.
  const latestSubjectPr = !existingPr && github.findPrBySubject
    ? await github.findPrBySubject(subject.type, key)
    : null;

  const metaCfg = (subject.graph.meta && subject.graph.meta.gauntlet) || {};
  const baseRef = (subject.graph.meta && subject.graph.meta.base_branch) || "main";
  const baseSha = baseShaOf(root, subject.graph, opts.execImpl || spawnSync, !!opts.allowLocalBase);
  const frozen = freezeQualityBar({
    subjectType: subject.type, key, node: subject.node, item: subject.item,
    graph: subject.graph, baseSha, additionalBar: opts.additionalBar || null,
  });
  const maxRounds = opts.maxRounds != null ? Number(opts.maxRounds)
    : (metaCfg.max_rounds != null ? metaCfg.max_rounds : DEFAULT_MAX_ROUNDS);
  if (!Number.isInteger(maxRounds) || maxRounds < 0 || maxRounds > 20) throw new Error("maxRounds must be an integer from 0 to 20");
  const localAttemptFloor = Math.max(0, ...Object.values(ledger.runs).filter((candidate) => candidate
    && candidate.subject_type === subject.type && candidate.subject_key === key
    && candidate.base_sha === baseSha
    && (candidate.launches || []).some((launch) => launch.role === "implementation"))
    .map((candidate) => implementationAttemptForRunId({ subjectType: subject.type, key, baseSha,
      runId: candidate.run_id }) || 0));
  const latestMarker = latestSubjectPr && parseGauntletPrMarkers(latestSubjectPr.body || "");
  const remoteAttemptFloor = latestMarker && latestMarker.subjectType === subject.type
    && latestMarker.key === key && latestMarker.baseSha === baseSha
    ? (implementationAttemptForRunId({ subjectType: subject.type, key, baseSha,
      runId: latestMarker.runId }) || 0)
    : 0;
  const implementationAttempt = Math.max(localAttemptFloor, remoteAttemptFloor) + 1;
  const runId = implementationRunId({ subjectType: subject.type, key, baseSha, attempt: implementationAttempt });
  const implementationClaimKey = `gauntlet:implementation:${subject.type}:${key}:${baseSha}:attempt:${implementationAttempt}`;
  const implementationTier = opts.implementationTier || subject.tier || metaCfg.implementation_tier || null;
  const criticTier = opts.criticTier || metaCfg.critic_tier || null;
  const repairTier = opts.repairTier || subject.tier || metaCfg.repair_tier || null;
  const implementationProvider = gauntletProvider(metaCfg, opts, "implementation");
  const criticProvider = gauntletProvider(metaCfg, opts, "critic");
  const repairProvider = gauntletProvider(metaCfg, opts, "repair");
  const leadActor = await github.actor();
  try {
    if (!github.claim) throw new Error("GitHub client cannot atomically claim a Gauntlet launch");
    await assertClaimProtection(github, implementationClaimKey, runId);
  } catch (e) {
    throw new Error(`implementation claim-protection preflight failed; no local reservation, GitHub lock, or Routine was created and retry is safe after configuration: ${e.message}`);
  }
  const createdAt = nowIso(opts);
  const run = {
    run_id: runId,
    subject_type: subject.type,
    subject_key: key,
    base_sha: baseSha,
    base_ref: baseRef,
    lead_actor: leadActor,
    bar_sha256: frozen.sha256,
    frozen_bar: frozen.canonical,
    frozen_bar_markdown: frozen.markdown,
    max_rounds: maxRounds,
    implementation_tier: implementationTier,
    implementation_provider: implementationProvider,
    critic_tier: criticTier,
    critic_profile: opts.criticProfile || null,
    critic_provider: criticProvider,
    repair_tier: repairTier,
    repair_provider: repairProvider,
    model_preferences: opts.authorizationPolicy?.model_preferences || metaCfg.model_preferences || {},
    ...(opts.authorizationPolicy && [implementationProvider, criticProvider, repairProvider].includes("codex")
      ? { environment_id: resolveCodexEnvironment({ meta: subject.graph.meta || {}, override: opts.environmentId }) } : {}),
    launches: [],
    created_at: createdAt,
    updated_at: createdAt,
    last_state: "awaiting_pr",
  };
  if (opts.authorizationPolicy) await freezeImplementationAuthority(root, run, opts.authorizationPolicy, github, opts);
  const authorized = await readImplementationAuthority(root, run, github, opts);
  if (authorized.snapshot) {
    if (opts.continuationRecord) {
      await recordRunContinuation({ store: authorized.store, runId, github, record: opts.continuationRecord, confirm: opts.confirmContinuation, now: nowIso(opts) });
      authorized.snapshot = await authorized.store.read(runId);
    }
    const continuation = continuationStatus(authorized.snapshot.state, { now: Date.parse(nowIso(opts)) });
    if (!continuation.launch_ready) return { runId, subject: key, state: "awaiting_continuation", launched: false, continuation,
      authorizationDigest: authorized.snapshot.state.authorization_digest };
  }
  const prompt = authorizedVerificationPrompt(run, buildImplementationPrompt({ run, frozenBar: frozen, subject: subject.node || subject.item }));
  const launchKey = gauntletLaunchKey({ runId, role: "implementation", round: 0, expectedHead: baseSha, provider: implementationProvider });

  const capacity = await reserveImplementationCapacity(root, run, { key: launchKey, role: "implementation", provider: implementationProvider,
    expected_head: baseSha, round: 0, prompt_digest: createHash("sha256").update(prompt).digest("hex") }, github, opts);
  if (capacity && !capacity.reserved) return { duplicate: true, runId, state: capacity.reservation.state, reservation: capacity.reservation };

  const reservation = mutateGauntletLedger(root, (next) => {
    const active = findLedgerRun(next, key, { activeOnly: true });
    if (active && active.run_id !== (previous && previous.run_id)) return { duplicate: active };
    if (previous && next.runs[previous.run_id]) next.runs[previous.run_id].last_state = previousState;
    if (next.runs[runId]) return { duplicate: next.runs[runId] };
    run.launches.push({ key: launchKey, role: "implementation", provider: implementationProvider, round: 0, attempt: implementationAttempt,
      expected_head: baseSha, status: "firing", created_at: createdAt });
    next.runs[runId] = run;
    return { duplicate: null };
  });
  if (reservation.duplicate) return { duplicate: true, runId: reservation.duplicate.run_id, state: reservation.duplicate.last_state };

  let claim;
  try {
    claim = await github.claim(implementationClaimKey, baseSha, runId);
  } catch (e) {
    updateLaunch(root, runId, launchKey, { status: "ambiguous", maybe_claimed: true, error: e.message, updated_at: nowIso(opts) });
    throw new Error(`implementation launch lock outcome is ambiguous; no Routine was fired, but retry is unsafe until the GitHub lock is reconciled: ${e.message}`);
  }
  if (!claim.claimed) {
    updateLaunch(root, runId, launchKey, { status: "duplicate_remote", claim_ref: claim.ref, updated_at: nowIso(opts) });
    return { duplicate: true, remote: true, runId, state: "awaiting_pr",
      message: `another conductor owns implementation attempt ${implementationAttempt} for ${key}` };
  }
  updateLaunch(root, runId, launchKey, { status: "claimed", claim_ref: claim.ref, updated_at: nowIso(opts) });

  try {
    const receipt = await submitWithImplementationCapacity(capacity, () => launchGauntletAgent(root, opts, { graph: subject.graph, run, role: "implementation",
      tier: implementationTier, profile: opts.implementationProfile || null, provider: implementationProvider,
      prompt, branch: capacity ? baseSha : baseRef }), { now: Date.parse(nowIso(opts)) });
    const awaitingPublication = implementationProvider === "codex";
    updateLaunch(root, runId, launchKey, {
      status: awaitingPublication ? "awaiting_artifact_publication" : "launched", provider: implementationProvider,
      external_id: receipt.external_id, external_url: receipt.external_url, provider_metadata: receipt.provider_metadata,
      model_policy: receipt.model_policy || null,
      ...(receipt.session_id ? { session_id: receipt.session_id, session_url: receipt.session_url, routine: receipt.routine } : {}),
      updated_at: nowIso(opts),
    });
    return { runId, subject: key, state: awaitingPublication ? "awaiting_artifact_publication" : "awaiting_pr", barSha256: frozen.sha256,
      provider: implementationProvider, externalId: receipt.external_id, externalUrl: receipt.external_url, modelPolicy: receipt.model_policy || null,
      ...(receipt.session_id ? { sessionId: receipt.session_id, sessionUrl: receipt.session_url, routine: receipt.routine } : {}) };
  } catch (e) {
    updateLaunch(root, runId, launchKey, { status: "ambiguous", maybe_accepted: true, error: e.message, updated_at: nowIso(opts) });
    throw new Error(`Gauntlet implementation launch outcome is ambiguous for ${runId}; do not retry until a human reconciles the provider receipt/PR: ${e.message}`);
  }
}

// One run only. The portfolio view (`status --all`) is runGauntletPortfolio in
// gauntlet-portfolio-io.mjs, wired by the CLI and MCP layers so the two modules never import each other.
export async function runGauntletStatus(root, idOrKey, opts = {}) {
  const observed = await observeGauntlet(root, idOrKey, opts);
  const { pr, status } = observed;
  const run = observeProviderExecutions(observed.run, opts);
  const limits = observed.authority.snapshot ? authorizationStatus(observed.authority.snapshot.state, { now: Date.parse(nowIso(opts)) }) : null;
  if (limits && (!limits.launch_window_open || !limits.continuation.launch_ready || limits.submissions_remaining === 0 || limits.concurrency_remaining === 0)) {
    status.safeActions = [...status.safeActions.filter((action) => !["launch_critic", "launch_repair"].includes(action)), "observe_existing_work"];
    status.canLaunchCritic = false; status.canLaunchRepair = false;
  }
  return {
    ...status,
    authority_status: observed.authority.snapshot ? "protected" : "legacy_unverified",
    limits,
    decision_report: observed.authority.snapshot ? decisionReport(observed.authority.snapshot.state) : null,
    executions: (observed.authority.snapshot?.state.reservations || []).map((reservation) => ({ key: reservation.key, role: reservation.role,
      receipt: reservation.receipt, state: reservation.state, model_policy: reservation.request.model_policy,
      observation: reservation.receipt ? observeAuthorizedExecution(reservation.receipt, reservation.request.environment_id, opts)
        : { state: reservation.state === "not_submitted" ? "not_submitted" : "reserved_without_receipt" } })),
    run: publicRun(run),
    pr: pr ? { number: pr.number, url: pr.url, title: pr.title, state: pr.state,
      headRefName: pr.headRefName, currentHead: pr.currentHead, checks: pr.checks } : null,
  };
}

export async function runGauntletObserve(root, idOrKey, opts = {}) {
  const { run, github, authority } = await observeGauntlet(root, idOrKey, opts);
  if (!authority.snapshot) throw new Error("legacy implementation has no protected launch accounting to observe");
  await assertFrozenLeadActor(github, run);
  const observations = [];
  for (const reservation of authority.snapshot.state.reservations) {
    if (!reservation.receipt) { observations.push({ key: reservation.key, state: reservation.state === "not_submitted" ? "not_submitted" : "reserved_without_receipt" }); continue; }
    const observation = observeAuthorizedExecution(reservation.receipt, reservation.request.environment_id, opts);
    await mutateAuthorization(authority.store, run.run_id, (state) => ({ state: recordLaunchObservation(state, reservation.key, observation) }));
    observations.push({ key: reservation.key, ...observation });
  }
  return { run_id: run.run_id, observations, limits: authorizationStatus((await authority.store.read(run.run_id)).state) };
}

export async function runGauntletContinuation(root, idOrKey, opts = {}) {
  const { run, github, authority } = await observeGauntlet(root, idOrKey, opts);
  if (!authority.snapshot) throw new Error("continuation receipt requires protected implementation authorization");
  return recordRunContinuation({ store: authority.store, runId: run.run_id, github, record: opts.record, confirm: opts.confirm, now: nowIso(opts) });
}

export async function runGauntletReconcile(root, idOrKey, opts = {}) {
  const { run, github, authority } = await observeGauntlet(root, idOrKey, opts);
  if (!authority.snapshot) throw new Error("receipt reconciliation requires protected implementation authorization");
  await assertFrozenLeadActor(github, run);
  const reservation = authority.snapshot.state.reservations.find((entry) => entry.key === opts.launchKey);
  if (!reservation || reservation.provider !== "codex") throw new Error("reconciliation requires an exact Codex reservation; unsupported providers remain unresolved");
  if (!/^task_[A-Za-z0-9_-]+$/.test(opts.taskId || "") || ![
    `https://chatgpt.com/codex/tasks/${opts.taskId}`, `https://chatgpt.com/codex/cloud/tasks/${opts.taskId}`,
  ].includes(opts.taskUrl)) throw new Error("supply the inspected exact task ID and matching URL, never a recent-task guess");
  const receipt = reservation.receipt || { provider: "codex", external_id: opts.taskId, external_url: opts.taskUrl,
    model_policy: reservation.request.model_policy || null };
  if (receipt.external_id !== opts.taskId || receipt.external_url !== opts.taskUrl) throw new Error("cannot replace a recorded receipt");
  const logicalKey = reservation.key.replace(/:attempt:\d+$/, "");
  const attempt = Number(/:attempt:(\d+)$/.exec(reservation.key)?.[1] || 1);
  const cached = (run.launches || []).find((launch) => launch.key === logicalKey && Number(launch.attempt || 1) === attempt);
  if (cached?.external_id && cached.external_id !== receipt.external_id) throw new Error("local and protected receipts conflict; inspect without silently replacing either");
  const observation = observeAuthorizedExecution(receipt, reservation.request.environment_id, opts);
  const result = await mutateAuthorization(authority.store, run.run_id, (state) => ({ state: reconcileLaunchReceipt(state, reservation.key, {
    actor: run.lead_actor, receipt, observation, reason: opts.reason, confirm: opts.confirm === true, now: nowIso(opts),
  }) }));
  if (cached && readGauntletLedger(root).runs[run.run_id]) {
    updateLaunch(root, run.run_id, cached, { status: "launched", provider: "codex", external_id: receipt.external_id,
      external_url: receipt.external_url, model_policy: receipt.model_policy, updated_at: nowIso(opts) });
  }
  return { run_id: run.run_id, launch_key: reservation.key, receipt, observation,
    limits: authorizationStatus(result.state, { now: Date.parse(nowIso(opts)) }) };
}

export async function runGauntletDecision(root, idOrKey, opts = {}) {
  const { run, pr, github, authority } = await observeGauntlet(root, idOrKey, opts);
  if (!pr || !authority.snapshot) throw new Error("decision requires a bounded implementation run with its existing PR");
  return recordDecisionForPr({ store: authority.store, runId: run.run_id, github, prNumber: pr.number,
    expectedHead: opts.expectedHead, input: opts.record, confirm: opts.confirm, now: nowIso(opts) });
}

export async function runGauntletAcknowledge(root, idOrKey, opts = {}) {
  if (!opts.confirm) throw new Error("ack requires explicit confirm=true after the lead has inspected the critic evidence");
  const commentUrl = String(opts.commentUrl || "").trim();
  if (!commentUrl) throw new Error("ack requires the exact critic comment URL returned by gauntlet status");
  const observed = await observeGauntlet(root, idOrKey, opts);
  const { run, pr, status, github } = observed;
  if (!pr) throw new Error(`run ${run.run_id} has no implementation PR with a critic result to acknowledge`);
  const candidate = status.criticResults.find((result) => result.comment && result.comment.url === commentUrl);
  if (!candidate) throw new Error(`critic comment ${commentUrl} is not associated with run ${run.run_id}`);
  if (candidate.invalidReason !== "unacknowledged_result") {
    if (candidate.acknowledged) return { duplicate: true, runId: run.run_id, commentUrl,
      verdict: candidate.verdict, head: candidate.head, acknowledged: true };
    throw new Error(`critic comment ${commentUrl} is not safe to acknowledge (${candidate.invalidReason || "invalid"})`);
  }
  const source = (pr.comments || []).find((comment) => comment.url === commentUrl);
  if (!source) throw new Error(`critic comment ${commentUrl} disappeared before acknowledgment`);
  await assertFrozenLeadActor(github, run);
  const existing = reconstructVerdictAcksFromComments({ run, comments: pr.comments || [] })
    .find((ack) => ack.commentSha256 === candidate.commentSha256
      && ack.commentUrlSha256 === candidate.commentUrlSha256 && ack.verdict === candidate.verdict);
  if (existing) return { duplicate: true, runId: run.run_id, commentUrl,
    verdict: candidate.verdict, head: candidate.head, acknowledged: true };
  await github.comment(pr.number, renderGauntletVerdictAck({ run, comment: source }));
  return { runId: run.run_id, commentUrl, verdict: candidate.verdict,
    head: candidate.head, acknowledged: true };
}

export async function runGauntletCancel(root, idOrKey, opts = {}) {
  if (!opts.confirm) throw new Error("cancel requires explicit confirm=true; it abandons in-flight Routine work but does not delete receipts or close a PR");
  const reason = String(opts.reason || "").trim();
  if (!reason) throw new Error("cancel requires a non-empty human reason");
  if (reason.length > 2000) throw new Error("cancel reason is too large (max 2,000 characters)");
  const observed = await observeGauntlet(root, idOrKey, opts);
  const { pr, github } = observed;
  const run = observed.run;
  await assertFrozenLeadActor(github, run);
  // An explicit cancellation may terminate an unconfirmed recovered winner,
  // but it must not silently adopt that protocol into a losing/empty ledger.
  // The protected claim/comment is sufficient durable authority; a later
  // status reconstructs it from GitHub without a sensor-side write.
  const mayCacheRecoveredProtocol = !recoveredBarConfirmationRequired(run);
  if (mayCacheRecoveredProtocol) persistReconstructedRun(root, run);
  if (run.cancelled_at || run.cancelledAt) {
    const existingReason = run.cancel_reason || run.cancelReason || reason;
    if (!run.cancelled_via_github) {
      const claim = pr
        ? await recordDurableCancellation(github, pr, run, existingReason)
        : await claimDurableCancellation(github, run, cancellationTombstoneClaimKey(run));
      mutateGauntletLedger(root, (next) => {
        const local = next.runs[run.run_id];
        if (!local) throw new Error(`Gauntlet run ${run.run_id} disappeared while recording durable cancellation`);
        local.cancelled_via_github = true;
        if (pr) local.cancellation_claim_ref = claim.ref;
        else local.cancellation_tombstone_ref = claim.ref;
        local.updated_at = nowIso(opts);
      });
      return { runId: run.run_id, state: "cancelled", cancelledAt: run.cancelled_at || run.cancelledAt,
        reason: existingReason, duplicate: true, durable: true, durableized: true };
    }
    return { runId: run.run_id, state: "cancelled", cancelledAt: run.cancelled_at || run.cancelledAt,
      reason: existingReason, duplicate: true,
      durable: !!run.cancelled_via_github };
  }
  const cancelledAt = nowIso(opts);
  let durable = false;
  let cancellationClaim = null;
  if (pr) {
    cancellationClaim = await recordDurableCancellation(github, pr, run, reason);
    durable = true;
  } else {
    cancellationClaim = await claimDurableCancellation(github, run, cancellationTombstoneClaimKey(run));
    durable = true;
  }
  if (mayCacheRecoveredProtocol) mutateGauntletLedger(root, (next) => {
    const local = next.runs[run.run_id];
    if (!local) throw new Error(`Gauntlet run ${run.run_id} disappeared before cancellation`);
    local.cancelled_at = cancelledAt;
    local.cancel_reason = reason;
    local.cancelled_via_github = durable;
    if (cancellationClaim && pr) local.cancellation_claim_ref = cancellationClaim.ref;
    if (cancellationClaim && !pr) local.cancellation_tombstone_ref = cancellationClaim.ref;
    local.last_state = "cancelled";
    local.updated_at = cancelledAt;
  });
  return { runId: run.run_id, state: "cancelled", cancelledAt, reason, durable,
    localCached: mayCacheRecoveredProtocol };
}

function validateExpectedHead(expectedHead) {
  const normalized = String(expectedHead || "").toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new Error("expectedHead must be the full 40-character lowercase PR head SHA from gauntlet status");
  return normalized;
}

export async function runGauntletCritic(root, idOrKey, opts = {}) {
  const expectedHead = validateExpectedHead(opts.expectedHead);
  const observed = await observeGauntlet(root, idOrKey, opts);
  const { run, pr, status, github } = observed;
  const graph = loadGraph(roadmapPaths(root).yaml);
  const provider = gauntletProvider((graph.meta && graph.meta.gauntlet) || {}, opts, "critic", run);
  if (!pr || pr.state !== "OPEN") throw new Error(`run ${run.run_id} has no open implementation PR to criticize`);
  if (pr.currentHead !== expectedHead) throw new Error(`stale critic assignment: expected ${expectedHead}, PR #${pr.number} is now ${pr.currentHead}`);
  // Authenticate before a recovered-bar confirmation or any ledger write. A
  // wrong actor must not be able to seed confirmation state for the real lead.
  try {
    await assertFrozenLeadActor(github, run);
  } catch (e) {
    throw new Error(`critic lead-identity preflight failed before any recovered-bar confirmation or ledger write; no GitHub launch lock was claimed and retry is safe: ${e.message}`);
  }
  const needsRecoveredBarConfirmation = recoveredBarConfirmationRequired(run);
  if (needsRecoveredBarConfirmation && !opts.confirmRecoveredBar) {
    throw new Error("GitHub recovery cannot authenticate the builder-authored frozen bar; inspect it against current intent, then explicitly pass confirmRecoveredBar=true before launching a fresh critic");
  }
  if (needsRecoveredBarConfirmation && opts.confirmRecoveredBar) {
    run.recovered_bar_confirmed_at = nowIso(opts);
  }
  if (["awaiting_checks", "checks_failing"].includes(status.state) && !opts.forceChecks) {
    throw new Error(`PR #${pr.number} is ${status.state.replaceAll("_", " ")} at ${expectedHead}; wait for stable checks or pass forceChecks=true explicitly`);
  }
  const criticRole = opts.criticRole || status.nextRequiredRole || "critic";
  const round = Number(status.round || ((status.repairsUsed || 0) + 1));
  const completedInvalidResults = status.criticResults.filter((result) => result.launchMatched
    && result.head === expectedHead && result.round === round
    && result.criticRole === criticRole && result.invalidReason === "invalid_or_stale_verdict");
  const completedInvalidAttempts = completedInvalidResults
    .map((result) => Number(result.launch && result.launch.attempt) || 1);
  const attempt = Math.max(0, ...completedInvalidAttempts) + 1;
  // Normalize transient observation first so duplicate/state checks stay
  // read-only. Attempts intentionally share a logical launch key; the
  // nonce/proof plus attempt number is their durable receipt identity.
  for (const result of completedInvalidResults) {
    if (!result.launch) continue;
    result.launch.status = "invalid_result";
  }
  const existing = launchReceipt(run, { role: "critic", round, expectedHead, criticRole, provider });
  if (existing) {
    // An authenticated idempotent actuator is also the safe persistence point
    // for an attested GitHub reconstruction. This freezes the recovered packet
    // locally even when no new Routine spend is necessary.
    persistReconstructedRun(root, run);
    return { duplicate: true, runId: run.run_id, launch: publicLaunch(existing) };
  }
  if (run.authorization_digest && criticRole !== status.nextRequiredRole) throw new Error("critic must be the next frozen required role; specialist roles cannot substitute for one another");
  if (status.state !== "awaiting_critic"
    && !(opts.forceChecks && ["awaiting_checks", "checks_failing"].includes(status.state))) {
    throw new Error(`run ${run.run_id} is ${status.state}; a critic launch is not currently safe`);
  }
  persistReconstructedRun(root, run);
  // Only after the actuator is known to be safe, retire every matching local
  // receipt independently before reserving the next attempt.
  for (const result of completedInvalidResults) {
    if (!result.launch) continue;
    updateLaunch(root, run.run_id, result.launch, { status: "invalid_result", updated_at: nowIso(opts) });
  }
  const tier = opts.tier || run.critic_tier || null;
  const profile = opts.profile || run.critic_profile || null;
  const nonce = opts.nonce || randomBytes(16).toString("hex");
  const prompt = authorizedVerificationPrompt(run, buildCriticPrompt({ run, pr, expectedHead, round, criticRole, nonce, artifactWording: github.workerFetchInstructions(pr, expectedHead) }));
  const launchKey = gauntletLaunchKey({ runId: run.run_id, role: "critic", round, expectedHead, criticRole, provider });
  const createdAt = nowIso(opts);
  const launchRecord = { key: launchKey, role: "critic", provider, critic_role: criticRole, round, attempt, nonce,
    expected_head: expectedHead, status: "firing", created_at: createdAt };
  const reservation = mutateGauntletLedger(root, (ledger) => {
    const local = ledger.runs[run.run_id];
    const duplicate = launchReceipt(local, { role: "critic", round, expectedHead, criticRole, provider });
    if (duplicate) return duplicate;
    local.launches.push(launchRecord);
    local.updated_at = createdAt;
    local.last_state = "critic_in_flight";
    return null;
  });
  if (reservation) return { duplicate: true, runId: run.run_id, launch: publicLaunch(reservation) };

  // Optimistic concurrency recheck after reservation, immediately before spending a launch.
  let current;
  try { current = await github.fetch(pr.number); }
  catch (e) {
    updateLaunch(root, run.run_id, launchRecord, { status: "preflight_failed", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`critic preflight could not refresh PR #${pr.number}; no Routine was fired and retry is safe: ${e.message}`);
  }
  if (!current) {
    updateLaunch(root, run.run_id, launchRecord, { status: "preflight_failed", error: "PR lookup returned no result", updated_at: nowIso(opts) });
    throw new Error(`critic preflight could not refresh PR #${pr.number}; no Routine was fired and retry is safe`);
  }
  if (current.currentHead !== expectedHead) {
    updateLaunch(root, run.run_id, launchRecord, { status: "aborted_stale", error: `PR head changed to ${current.currentHead}`, updated_at: nowIso(opts) });
    throw new Error(`stale critic assignment: PR #${pr.number} changed from ${expectedHead} to ${current.currentHead} before launch`);
  }
  try {
    await assertFrozenLeadActor(github, run);
  } catch (e) {
    updateLaunch(root, run.run_id, launchRecord, { status: "preflight_failed", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`critic lead-identity preflight failed; no GitHub launch lock was claimed and retry is safe: ${e.message}`);
  }
  try {
    if (!github.claim) throw new Error("GitHub client cannot atomically claim a Gauntlet launch");
    await assertClaimProtection(github, providerClaimKey(launchKey, provider, attempt), run.run_id);
  } catch (e) {
    updateLaunch(root, run.run_id, launchRecord, { status: "preflight_failed", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`critic claim-protection preflight failed; no GitHub lock or Routine was created and retry is safe after configuration: ${e.message}`);
  }
  let capacity;
  try {
    capacity = await reserveImplementationCapacity(root, run, { key: `${launchKey}:attempt:${attempt}`, role: "critic", provider,
      expected_head: expectedHead, round, critic_role: criticRole, nonce_sha256: createHash("sha256").update(nonce).digest("hex") }, github, opts);
  } catch (e) { updateLaunch(root, run.run_id, launchRecord, { status: "preflight_failed", updated_at: nowIso(opts) }); throw e; }
  if (capacity && !capacity.reserved) {
    updateLaunch(root, run.run_id, launchRecord, { status: "ambiguous", updated_at: nowIso(opts) });
    return { duplicate: true, runId: run.run_id, reservation: capacity.reservation };
  }
  let claim;
  try {
    claim = await github.claim(providerClaimKey(launchKey, provider, attempt), expectedHead, run.run_id);
  } catch (e) {
    updateLaunch(root, run.run_id, launchRecord, { status: "ambiguous", maybe_claimed: true, error: e.message, updated_at: nowIso(opts) });
    throw new Error(`critic launch lock outcome is ambiguous; no Routine was fired, but retry is unsafe until the GitHub lock is reconciled: ${e.message}`);
  }
  if (!claim.claimed) {
    updateLaunch(root, run.run_id, launchRecord, { status: "duplicate_remote", claim_ref: claim.ref, updated_at: nowIso(opts) });
    return { duplicate: true, remote: true, runId: run.run_id, role: criticRole, round, expectedHead };
  }
  updateLaunch(root, run.run_id, launchRecord, { status: "claimed", claim_ref: claim.ref, updated_at: nowIso(opts) });
  try {
    await github.comment(pr.number, renderGauntletLaunchMarker({
      run, role: "critic", criticRole, round, attempt, expectedHead, nonce,
    }));
  } catch (e) {
    updateLaunch(root, run.run_id, launchRecord, { status: "ambiguous", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`critic launch attestation could not be recorded on PR #${pr.number}; the GitHub lock was claimed, so retry is unsafe: ${e.message}`);
  }
  try {
    const receipt = await submitWithImplementationCapacity(capacity, () => launchGauntletAgent(root, opts, { graph, run, role: "critic", tier, profile, provider,
      prompt, branch: capacity ? expectedHead : pr.headRefName || null }), { now: Date.parse(nowIso(opts)) });
    updateLaunch(root, run.run_id, launchRecord, { status: "launched", provider, external_id: receipt.external_id,
      external_url: receipt.external_url, provider_metadata: receipt.provider_metadata,
      model_policy: receipt.model_policy || null,
      ...(receipt.session_id ? { session_id: receipt.session_id, session_url: receipt.session_url, routine: receipt.routine } : {}),
      updated_at: nowIso(opts) });
    return { runId: run.run_id, role: criticRole, round, expectedHead, provider,
      externalId: receipt.external_id, externalUrl: receipt.external_url, modelPolicy: receipt.model_policy || null,
      ...(receipt.session_id ? { sessionId: receipt.session_id, sessionUrl: receipt.session_url, routine: receipt.routine } : {}) };
  } catch (e) {
    updateLaunch(root, run.run_id, launchRecord, { status: "ambiguous", maybe_accepted: true, error: e.message, updated_at: nowIso(opts) });
    throw new Error(`Gauntlet critic launch outcome is ambiguous; the durable GitHub attestation prevents a duplicate. Wait for a result or resolve explicitly: ${e.message}`);
  }
}

export async function runGauntletRepair(root, idOrKey, opts = {}) {
  const expectedHead = validateExpectedHead(opts.expectedHead);
  const packet = String(opts.packet || "").trim();
  if (!packet) throw new Error("repair requires a non-empty lead-synthesized packet");
  if (packet.length > 50000) throw new Error("repair packet is too large (max 50,000 characters); synthesize material findings only");
  const observed = await observeGauntlet(root, idOrKey, opts);
  const { run, pr, status, github } = observed;
  const graph = loadGraph(roadmapPaths(root).yaml);
  const provider = gauntletProvider((graph.meta && graph.meta.gauntlet) || {}, opts, "repair", run);
  if (!pr || pr.state !== "OPEN") throw new Error(`run ${run.run_id} has no open implementation PR to repair`);
  if (pr.currentHead !== expectedHead) throw new Error(`stale repair assignment: expected ${expectedHead}, PR #${pr.number} is now ${pr.currentHead}`);
  await assertFrozenLeadActor(github, run);
  if (status.state !== "needs_repair" || !status.latestValidCritic || status.latestValidCritic.verdict !== "REVISE") {
    throw new Error(`run ${run.run_id} is ${status.state}; repair requires a current-head REVISE verdict and lead synthesis`);
  }
  persistReconstructedRun(root, run);
  const round = Number(status.repairsUsed || 0) + 1;
  const attempt = 1;
  if (round > run.max_rounds) throw new Error(`run ${run.run_id} exhausted its ${run.max_rounds} repair round(s)`);
  const existing = launchReceipt(run, { role: "repair", round, expectedHead, criticRole: null, provider });
  if (existing) return { duplicate: true, runId: run.run_id, launch: publicLaunch(existing) };
  const tier = opts.tier || run.repair_tier || null;
  const packetSha256 = createHash("sha256").update(packet).digest("hex");
  const prompt = authorizedVerificationPrompt(run, buildRepairPrompt({ run, pr, expectedHead, round, packet, packetSha256, artifactWording: github.workerFetchInstructions(pr, expectedHead) }));
  const launchKey = gauntletLaunchKey({ runId: run.run_id, role: "repair", round, expectedHead, provider });
  const createdAt = nowIso(opts);
  const reservation = mutateGauntletLedger(root, (ledger) => {
    const local = ledger.runs[run.run_id];
    const duplicate = launchReceipt(local, { role: "repair", round, expectedHead, criticRole: null, provider });
    if (duplicate) return duplicate;
    local.launches.push({ key: launchKey, role: "repair", provider, round, attempt, expected_head: expectedHead,
      packet_sha256: packetSha256, status: "firing", created_at: createdAt });
    local.updated_at = createdAt;
    local.last_state = "repair_in_flight";
    return null;
  });
  if (reservation) return { duplicate: true, runId: run.run_id, launch: reservation };

  let current;
  try { current = await github.fetch(pr.number); }
  catch (e) {
    updateLaunch(root, run.run_id, launchKey, { status: "preflight_failed", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`repair preflight could not refresh PR #${pr.number}; no Routine was fired and retry is safe: ${e.message}`);
  }
  if (!current) {
    updateLaunch(root, run.run_id, launchKey, { status: "preflight_failed", error: "PR lookup returned no result", updated_at: nowIso(opts) });
    throw new Error(`repair preflight could not refresh PR #${pr.number}; no Routine was fired and retry is safe`);
  }
  if (current.currentHead !== expectedHead) {
    updateLaunch(root, run.run_id, launchKey, { status: "aborted_stale", error: `PR head changed to ${current.currentHead}`, updated_at: nowIso(opts) });
    throw new Error(`stale repair assignment: PR #${pr.number} changed from ${expectedHead} to ${current.currentHead} before launch`);
  }
  try {
    await assertFrozenLeadActor(github, run);
  } catch (e) {
    updateLaunch(root, run.run_id, launchKey, { status: "preflight_failed", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`repair lead-identity preflight failed; no GitHub launch lock was claimed and retry is safe: ${e.message}`);
  }
  try {
    if (!github.claim) throw new Error("GitHub client cannot atomically claim a Gauntlet launch");
    await assertClaimProtection(github, providerClaimKey(launchKey, provider, attempt), run.run_id);
  } catch (e) {
    updateLaunch(root, run.run_id, launchKey, { status: "preflight_failed", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`repair claim-protection preflight failed; no GitHub lock or Routine was created and retry is safe after configuration: ${e.message}`);
  }
  let capacity;
  try {
    capacity = await reserveImplementationCapacity(root, run, { key: launchKey, role: "repair", provider,
      expected_head: expectedHead, round, packet_sha256: packetSha256 }, github, opts);
  } catch (e) { updateLaunch(root, run.run_id, launchKey, { status: "preflight_failed", updated_at: nowIso(opts) }); throw e; }
  if (capacity && !capacity.reserved) {
    updateLaunch(root, run.run_id, launchKey, { status: "ambiguous", updated_at: nowIso(opts) });
    return { duplicate: true, runId: run.run_id, reservation: capacity.reservation };
  }
  let claim;
  try {
    claim = await github.claim(providerClaimKey(launchKey, provider, attempt), expectedHead, run.run_id);
  } catch (e) {
    updateLaunch(root, run.run_id, launchKey, { status: "ambiguous", maybe_claimed: true, error: e.message, updated_at: nowIso(opts) });
    throw new Error(`repair launch lock outcome is ambiguous; no Routine was fired, but retry is unsafe until the GitHub lock is reconciled: ${e.message}`);
  }
  if (!claim.claimed) {
    updateLaunch(root, run.run_id, launchKey, { status: "duplicate_remote", claim_ref: claim.ref, updated_at: nowIso(opts) });
    return { duplicate: true, remote: true, runId: run.run_id, round, expectedHead };
  }
  updateLaunch(root, run.run_id, launchKey, { status: "claimed", claim_ref: claim.ref, updated_at: nowIso(opts) });
  try {
    await github.comment(pr.number, renderGauntletLaunchMarker({
      run, role: "repair", round, attempt, expectedHead, packetSha256,
    }));
  } catch (e) {
    updateLaunch(root, run.run_id, launchKey, { status: "ambiguous", error: e.message, updated_at: nowIso(opts) });
    throw new Error(`repair launch attestation could not be recorded on PR #${pr.number}; the GitHub lock was claimed, so retry is unsafe: ${e.message}`);
  }
  try {
    const receipt = await submitWithImplementationCapacity(capacity, () => launchGauntletAgent(root, opts, { graph, run, role: "repair", tier,
      profile: opts.profile || null, provider, prompt, branch: capacity ? expectedHead : pr.headRefName || null }), { now: Date.parse(nowIso(opts)) });
    updateLaunch(root, run.run_id, launchKey, { status: "launched", provider, external_id: receipt.external_id,
      external_url: receipt.external_url, provider_metadata: receipt.provider_metadata,
      model_policy: receipt.model_policy || null,
      ...(receipt.session_id ? { session_id: receipt.session_id, session_url: receipt.session_url, routine: receipt.routine } : {}),
      updated_at: nowIso(opts) });
    return { runId: run.run_id, round, expectedHead, packetSha256, provider,
      externalId: receipt.external_id, externalUrl: receipt.external_url, modelPolicy: receipt.model_policy || null,
      ...(receipt.session_id ? { sessionId: receipt.session_id, sessionUrl: receipt.session_url, routine: receipt.routine } : {}) };
  } catch (e) {
    updateLaunch(root, run.run_id, launchKey, { status: "ambiguous", maybe_accepted: true, error: e.message, updated_at: nowIso(opts) });
    throw new Error(`Gauntlet repair launch outcome is ambiguous; the durable GitHub attestation prevents a duplicate. Wait for a new head or resolve explicitly: ${e.message}`);
  }
}

export function formatGauntletStatus(result) {
  const head = result.currentHead || (result.pr && result.pr.currentHead);
  const latest = result.latestValidCritic;
  const runId = result.run && result.run.runId;
  const candidate = (result.criticResults || []).find((item) => item.invalidReason === "unacknowledged_result");
  const actionGuidance = {
    launch_critic: `roadmap gauntlet critic ${runId} --expected-head ${head}`,
    acknowledge_verdict: candidate && candidate.comment && candidate.comment.url
      ? `inspect ${candidate.comment.url}, then: roadmap gauntlet ack ${runId} --comment-url ${candidate.comment.url} --confirm`
      : `inspect the candidate URL in --json status, then: roadmap gauntlet ack ${runId} --comment-url <exact-url> --confirm`,
    launch_repair: `write the lead packet, then: roadmap gauntlet repair ${runId} --expected-head ${head} --packet-file <path>`,
    merge: `lead/human: inspect and merge PR #${result.pr && result.pr.number} only at ${head}`,
    confirm_recovered_bar: `inspect the recovered bar, then: roadmap gauntlet critic ${runId} --expected-head ${head} --confirm-recovered-bar`,
    authenticate_frozen_lead: `authenticate gh as ${result.run && result.run.leadActor}, then rerun status`,
    restore_pr_history: `restore the PR ancestry or preserve evidence and cancel: roadmap gauntlet cancel ${runId} --reason <text> --confirm`,
    reconcile_launch_attestation: `reconcile the protected claim and lead comment, or cancel: roadmap gauntlet cancel ${runId} --reason <text> --confirm`,
    restore_cancellation_record: "restore the exact cancellation claim/comment pair; do not relaunch",
    cancel_run: `roadmap gauntlet cancel ${runId} --reason <text> --confirm`,
  };
  const safeNext = (result.safeActions || []).map((action) => actionGuidance[action] || action).join("; ");
  // Provider observations are operational facts, not verdicts. Keep the
  // compact CLI view honest about a vanished/failed task while preserving the
  // Gauntlet's GitHub/SHA-derived quality state as the source of truth.
  const executionLine = (label, execution) => {
    if (!execution) return null;
    const provider = execution.provider || "claude";
    const id = execution.external_id || execution.session_id || null;
    const observed = execution.provider_status;
    const issue = execution.provider_observation_error;
    if (!observed && !issue) return `${label}: ${provider}${id ? ` (${id})` : ""}`;
    return `${label}: ${provider}${id ? ` (${id})` : ""} — ${issue ? `provider issue: ${issue}` : `provider status: ${observed}`}`;
  };
  const executionLines = [
    executionLine("implementation", result.run && result.run.implementationExecution),
    ...(result.run && result.run.criticExecutions || []).map((execution, index) => executionLine(`critic ${index + 1}`, execution)),
    ...(result.run && result.run.repairExecutions || []).map((execution, index) => executionLine(`repair ${index + 1}`, execution)),
  ].filter(Boolean);
  return [
    `${result.run.subjectKey}`,
    `run: ${result.run.runId}`,
    `PR: ${result.pr ? `#${result.pr.number} @ ${(head || "unknown").slice(0, 12)}` : "awaiting implementation PR"}`,
    `critic round: ${result.round || 1}`,
    `repairs: ${result.repairsUsed || 0} / ${result.maxRounds ?? result.run.maxRounds}`,
    `state: ${result.state}`,
    latest ? `critic: ${latest.verdict} @ ${latest.reviewedHead || latest.head || "unknown"}` : "critic: none valid for current head",
    ...executionLines,
    safeNext ? `safe next: ${safeNext}` : "safe next: lead/human judgment",
  ].join("\n");
}

export function formatGauntletLaunchResult(result, role) {
  if (!result.duplicate) {
    return `${role} round ${result.round} launched via ${result.provider || "claude"} for ${result.expectedHead}: ${result.externalUrl || result.sessionUrl}`;
  }
  if (result.remote) {
    return `${role} round ${result.round} for ${result.expectedHead} is owned by another conductor; no duplicate Routine or provider launch was fired.`;
  }
  return `${role} already launched: ${result.launch?.session_url || result.launch?.key || "existing launch"}`;
}

