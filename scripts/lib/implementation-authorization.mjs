// Optional bounded execution contract for implementation Gauntlets. Legacy
// runs remain readable; they cannot acquire a fresh budget after launching.
import { randomUUID } from "node:crypto";
import { freezeAuthorization, authorizationDigest, reserveAuthorizedLaunch, recordLaunchOutcome, authorizationStatus, continuationStatus } from "./gauntlet-authorization.mjs";
import { githubAuthorizationStore, mutateAuthorization } from "./gauntlet-authorization-io.mjs";
import { gauntletProtocolDigest } from "./gauntlet-core.mjs";
import { qualifyModelPreference, roleModelPreference } from "./model-policy.mjs";

export function implementationAuthorityStore(root, github, opts = {}) {
  return opts.authorityStore || (github.supportsProtectedAuthority
    ? githubAuthorizationStore(root, { github, execImpl: opts.execImpl }) : null);
}

export async function freezeImplementationAuthority(root, run, policy, github, opts = {}) {
  const store = implementationAuthorityStore(root, github, opts);
  if (!store) throw new Error("bounded implementation requires a protected-authority-capable GitHub adapter");
  const prior = await store.read(run.run_id);
  const runSnapshot = structuredClone(run);
  if (prior) for (const field of ["created_at", "updated_at"]) runSnapshot[field] = prior.state.authorization.scope.snapshot.run[field];
  const initial = freezeAuthorization({ ...policy, version: 1, run_id: run.run_id, mode: "implementation",
    source_sha: run.base_sha, lead_actor: run.lead_actor,
    scope: { description: policy?.scope?.description || run.frozen_bar_markdown,
      snapshot: { protocol_digest: gauntletProtocolDigest(run), run: runSnapshot } },
    providers: { implementation: run.implementation_provider, critic: run.critic_provider, repair: run.repair_provider },
  }, { now: prior?.state.authorization.created_at || run.created_at });
  if (initial.authorization.limits.repairs !== run.max_rounds) throw new Error("authorized repair limit must equal frozen Gauntlet max_rounds");
  const result = prior ? { current: prior } : await store.compareAndSwap(run.run_id, null, initial);
  if (result.current?.state.authorization_digest !== initial.authorization_digest) throw new Error("a different protected policy owns this implementation run; do not replace the winning scope or budget");
  run.authorization_digest = initial.authorization_digest;
  run.required_review_roles = initial.authorization.required_review_roles;
  run.model_preferences = initial.authorization.model_preferences;
  run.verification_commands = initial.authorization.verification_commands;
  return result.current;
}

export async function readImplementationAuthority(root, run, github, opts = {}) {
  const store = implementationAuthorityStore(root, github, opts);
  const snapshot = store ? await store.read(run.run_id) : null;
  if (!snapshot && run.authorization_digest) throw new Error("bounded implementation authority is missing; no launch permitted");
  if (snapshot) {
    const a = snapshot.state.authorization;
    if (a.mode !== "implementation" || a.scope.snapshot.protocol_digest !== gauntletProtocolDigest(run)) throw new Error("protected implementation scope differs from the observed Gauntlet packet");
    run.authorization_digest = snapshot.state.authorization_digest;
    run.required_review_roles = a.required_review_roles; run.model_preferences = a.model_preferences;
    run.verification_commands = a.verification_commands;
    run.environment_id = a.scope.snapshot.run.environment_id || null;
  }
  return { store, snapshot };
}

export async function reserveImplementationCapacity(root, run, request, github, opts = {}) {
  const { store, snapshot } = await readImplementationAuthority(root, run, github, opts);
  const modelPolicy = qualifyModelPreference({ provider: request.provider,
    preference: roleModelPreference(snapshot?.state.authorization.model_preferences || run.model_preferences || {}, request.role, opts.modelPreference || null) });
  if (!snapshot) return null;
  if (await github.viewerLogin() !== snapshot.state.authorization.lead_actor) throw new Error("bounded launch requires the frozen lead");
  const owner = randomUUID(), now = opts.now ? new Date(opts.now()).toISOString() : new Date().toISOString();
  const result = await mutateAuthorization(store, run.run_id, (state) => reserveAuthorizedLaunch(state, {
    ...request, environment_id: run.environment_id || null, model_policy: modelPolicy,
  }, { owner, now }));
  return { ...result, store, owner, modelPolicy, runId: run.run_id, key: request.key };
}

export async function submitWithImplementationCapacity(reservation, submit, { now = Date.now() } = {}) {
  if (!reservation) return submit();
  if (!reservation.reserved) throw new Error("protected implementation reservation is already occupied; do not submit again");
  try {
    const state = (await reservation.store.read(reservation.runId)).state;
    if (!authorizationStatus(state, { now }).launch_window_open) throw new Error("launch window expired");
    if (!continuationStatus(state, { now }).launch_ready) throw new Error("desktop continuation paused or expired before submission");
    const receipt = { ...await submit(), model_policy: reservation.modelPolicy };
    await mutateAuthorization(reservation.store, reservation.runId, (current) => ({ state: recordLaunchOutcome(current,
      reservation.key, { owner: reservation.owner, receipt }) }));
    return receipt;
  } catch {
    try { await mutateAuthorization(reservation.store, reservation.runId, (current) => ({ state: recordLaunchOutcome(current,
      reservation.key, { owner: reservation.owner, ambiguous: true }) })); } catch { /* protected slot remains occupied */ }
    throw new Error("bounded implementation submission is unresolved; inspect the exact receipt, never retry blindly");
  }
}

export function authorizedVerificationPrompt(run, prompt) {
  if (!run.authorization_digest) return prompt;
  return prompt + `\n\nFrozen protected authorization: ${run.authorization_digest}. Only these executable verification commands are approved: ${JSON.stringify(run.verification_commands)}. Do not run other tests, builds or installers. Normal source inspection, authorized edits and the requested Git/PR publication operations remain permitted. Do not launch more agents, deploy, merge or publish packages.\n`;
}
