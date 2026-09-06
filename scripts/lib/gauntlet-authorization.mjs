// Shared, pure authorization and launch accounting for both Gauntlet modes.
// The durable store must compare-and-swap the WHOLE state before submission.
import { createHash } from "node:crypto";
import { roleModelPreference } from "./model-policy.mjs";
import { prohibitedDataFindings } from "./evaluation-packet.mjs";

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9][a-z0-9_-]{2,159}$/;
const ROLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTIVE = new Set(["reserved", "submitted", "ambiguous"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ROLES = new Set(["implementation", "evaluator", "critic", "repair"]);
const PROVIDERS = new Set(["codex", "claude"]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const json = JSON.stringify(value);
  if (json === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("authorization contains non-JSON data");
  return json;
}
export function authorizationDigest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function required(condition, message) { if (!condition) throw new Error(`Gauntlet authorization: ${message}`); }
function text(value, max = 50000) { return typeof value === "string" && !!value.trim() && value.length <= max; }
function date(value) { return typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)); }

export function freezeAuthorization(input, { now = new Date().toISOString() } = {}) {
  const a = structuredClone(input);
  required(a?.version === 1, "unsupported version");
  required(ID.test(a.run_id || ""), "invalid run identity");
  required(["implementation", "evaluation"].includes(a.mode), "invalid execution mode");
  required(SHA.test(a.source_sha || ""), "full source SHA required");
  required(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(a.lead_actor || ""), "frozen GitHub lead required");
  required(text(a.scope?.description), "explicit approved scope required");
  required(a.scope?.snapshot && typeof a.scope.snapshot === "object", "immutable launch snapshot required");
  required(Array.isArray(a.required_review_roles) && a.required_review_roles.length > 0
    && a.required_review_roles.includes("critic") && a.required_review_roles.every((role) => ROLE.test(role))
    && new Set(a.required_review_roles).size === a.required_review_roles.length, "one critic and unique required reviewer roles required");
  required(a.providers && typeof a.providers === "object" && !Array.isArray(a.providers), "explicit role providers required");
  for (const role of [a.mode === "evaluation" ? "evaluator" : "implementation", "critic", "repair"]) {
    required(PROVIDERS.has(a.providers[role]), `unsupported or missing ${role} provider`);
  }
  required(Array.isArray(a.verification_commands) && a.verification_commands.every((command) => text(command, 4000)), "approved verification command list required (empty is allowed)");
  const l = a.limits || {};
  required(Number.isInteger(l.submissions) && l.submissions > 0 && l.submissions <= 1000, "submission ceiling must be 1–1000");
  required(Number.isInteger(l.concurrency) && l.concurrency > 0 && l.concurrency <= l.submissions, "invalid concurrency ceiling");
  required(Number.isInteger(l.repairs) && l.repairs >= 0 && l.repairs <= 20, "repair ceiling must be 0–20");
  required(l.attempts_per_submission === 1, "exactly one provider attempt per submission required");
  required(date(now) && date(l.launch_deadline) && Date.parse(l.launch_deadline) > Date.parse(now), "future launch deadline required");
  a.model_preferences ??= {};
  required(typeof a.model_preferences === "object" && !Array.isArray(a.model_preferences), "model preferences must be a mapping");
  roleModelPreference(a.model_preferences, "lead");
  a.created_at = now;
  return { version: 1, authorization: a, authorization_digest: authorizationDigest(a), reservations: [], events: [] };
}

export function assertAuthorizationState(state) {
  required(state?.version === 1 && state.authorization_digest === authorizationDigest(state.authorization), "immutable policy digest mismatch");
  required(Array.isArray(state.reservations) && Array.isArray(state.events), "invalid durable accounting");
  const keys = new Set();
  for (const r of state.reservations) {
    required(text(r.key, 512) && !keys.has(r.key), "duplicate or invalid reservation identity"); keys.add(r.key);
    required([...ACTIVE, ...TERMINAL].includes(r.state), "invalid reservation state");
    required(ROLES.has(r.role) && state.authorization.providers[r.role] === r.provider, "reservation provider drift");
    required(SHA.test(r.expected_head || "") && text(r.owner, 128), "reservation head/owner required");
    required(r.request_digest === authorizationDigest(r.request), "reservation request digest mismatch");
  }
  required(state.reservations.length <= state.authorization.limits.submissions, "submission ceiling exceeded");
  required(state.reservations.filter((r) => ACTIVE.has(r.state)).length <= state.authorization.limits.concurrency, "concurrency ceiling exceeded");
  required(state.reservations.filter((r) => r.role === "repair").length <= state.authorization.limits.repairs, "repair ceiling exceeded");
  return state;
}

export function authorizationStatus(state, { now = Date.now() } = {}) {
  assertAuthorizationState(state);
  const { limits } = state.authorization;
  const used = state.reservations.length;
  const active = state.reservations.filter((r) => ACTIVE.has(r.state)).length;
  const repairs = state.reservations.filter((r) => r.role === "repair").length;
  return { submissions_used: used, submissions_remaining: limits.submissions - used,
    active, concurrency_remaining: limits.concurrency - active, repairs_used: repairs, repairs_remaining: limits.repairs - repairs,
    launch_deadline: limits.launch_deadline, launch_window_open: now < Date.parse(limits.launch_deadline),
    ambiguous: state.reservations.filter((r) => r.state === "ambiguous" || (r.state === "reserved" && !r.receipt)).map((r) => r.key) };
}

export function assertAuthorizationTransition(previous, next) {
  assertAuthorizationState(previous); assertAuthorizationState(next);
  required(previous.authorization_digest === next.authorization_digest, "cannot replace frozen policy");
  required(next.reservations.length >= previous.reservations.length && next.reservations.length <= previous.reservations.length + 1,
    "reservations are append-only, one new slot per transaction");
  for (const [i, prior] of previous.reservations.entries()) {
    const current = next.reservations[i];
    for (const key of ["key", "role", "provider", "expected_head", "request_digest", "owner", "reserved_at"]) {
      required(current[key] === prior[key], "reservation identity is immutable");
    }
    if (prior.receipt) required(authorizationDigest(current.receipt) === authorizationDigest(prior.receipt), "receipt cannot be removed or replaced");
    if (TERMINAL.has(prior.state)) required(current.state === prior.state, "terminal reservations cannot be reset");
    if (prior.state === "submitted") required(current.state === "submitted" || TERMINAL.has(current.state), "submitted reservations cannot be reset");
  }
  required(next.events.length >= previous.events.length && previous.events.every((event, i) => authorizationDigest(event) === authorizationDigest(next.events[i])),
    "observation history is append-only");
  if (previous.evidence_pr) required(authorizationDigest(previous.evidence_pr) === authorizationDigest(next.evidence_pr), "the lead-owned evidence PR cannot be replaced");
  for (const field of ["admissions", "seals"]) {
    const earlier = previous[field] || [], later = next[field] || [];
    required(Array.isArray(later) && later.length >= earlier.length && earlier.every((record, i) => authorizationDigest(record) === authorizationDigest(later[i])),
      `${field} history is append-only`);
  }
  return next;
}

export function reserveAuthorizedLaunch(state, request, { owner, now = new Date().toISOString() } = {}) {
  assertAuthorizationState(state);
  required(text(owner, 128) && date(now), "reservation owner and timestamp required");
  const { key, role, provider, expected_head } = request;
  required(text(key, 512) && ROLES.has(role) && SHA.test(expected_head || ""), "invalid launch identity");
  required(state.authorization.providers[role] === provider, "provider differs from frozen role authorization");
  const digest = authorizationDigest(request);
  const prior = state.reservations.find((r) => r.key === key);
  if (prior) {
    required(prior.request_digest === digest, "same launch identity has a different request; inspect the winner, do not replace it");
    return { state, reservation: prior, reserved: false };
  }
  required(role !== "repair" || !state.reservations.some((r) => r.role === "repair" && r.expected_head === expected_head && ACTIVE.has(r.state)),
    "a repair for this head is already reserved or in flight");
  const limits = authorizationStatus(state, { now: Date.parse(now) });
  required(limits.launch_window_open, "launch deadline passed; observation and collection remain allowed");
  required(limits.submissions_remaining > 0, "submission ceiling exhausted");
  required(limits.concurrency_remaining > 0, "concurrency ceiling reached; reconcile existing reservations first");
  required(role !== "repair" || limits.repairs_remaining > 0, "repair ceiling exhausted");
  const reservation = { key, role, provider, expected_head, request: structuredClone(request), request_digest: digest,
    owner, state: "reserved", reserved_at: now, receipt: null };
  const next = structuredClone(state); next.reservations.push(reservation);
  return { state: next, reservation, reserved: true };
}

export function recordLaunchOutcome(state, key, { owner, receipt = null, ambiguous = false, now = new Date().toISOString() }) {
  assertAuthorizationState(state);
  const next = structuredClone(state); const r = next.reservations.find((entry) => entry.key === key);
  required(r && r.owner === owner, "only the reserving conductor may record its submission outcome");
  if (r.receipt) {
    required(receipt && authorizationDigest(r.receipt) === authorizationDigest(receipt), "receipt identity cannot be replaced");
    return state;
  }
  required(["reserved", "ambiguous"].includes(r.state), "reservation is no longer awaiting a receipt");
  required(date(now), "outcome timestamp required");
  if (receipt) {
    required(receipt.provider === r.provider && text(receipt.external_id, 256) && text(receipt.external_url, 2000), "exact provider receipt required");
    if (r.provider === "codex") {
      required(/^task_[A-Za-z0-9_-]+$/.test(receipt.external_id), "exact Codex task ID required");
      required(receipt.external_url === `https://chatgpt.com/codex/tasks/${receipt.external_id}`
        || receipt.external_url === `https://chatgpt.com/codex/cloud/tasks/${receipt.external_id}`, "Codex receipt URL must bind exact task ID");
    }
    r.receipt = structuredClone(receipt); r.state = "submitted";
  } else { required(ambiguous === true, "missing receipt is ambiguous, not retryable"); r.state = "ambiguous"; }
  r.updated_at = now;
  return next;
}

export function recordLaunchObservation(state, key, observation, { now = new Date().toISOString() } = {}) {
  assertAuthorizationState(state);
  const next = structuredClone(state); const r = next.reservations.find((entry) => entry.key === key);
  required(r?.receipt && observation.external_id === r.receipt.external_id, "observation must match exact recorded task");
  required(date(now), "observation timestamp required");
  // An absent task, unknown state or failed query never releases a slot.
  const fingerprint = authorizationDigest({ key, observation });
  if (next.events.some((event) => event.fingerprint === fingerprint)) return state;
  next.events.push({ fingerprint, key, observation: structuredClone(observation), observed_at: now });
  r.observation = structuredClone(observation); r.observed_at = now;
  // Delayed/conflicting provider snapshots are evidence, not permission to
  // rewrite terminal accounting or consume/release capacity a second time.
  if (TERMINAL.has(observation.state) && !TERMINAL.has(r.state)) r.state = observation.state;
  return next;
}

// Recovery is a new, attributable lead decision, not possession of a stale
// process-owner token. The caller must independently inspect the exact task.
export function reconcileLaunchReceipt(state, key, { actor, receipt, observation, reason, confirm,
  now = new Date().toISOString() } = {}) {
  assertAuthorizationState(state);
  required(actor === state.authorization.lead_actor && confirm === true, "receipt reconciliation requires explicit frozen-lead inspection");
  required(text(reason, 4000) && !prohibitedDataFindings(reason).length, "safe receipt-association reason required");
  const r = state.reservations.find((entry) => entry.key === key);
  required(r && (!r.receipt || authorizationDigest(r.receipt) === authorizationDigest(receipt)), "cannot replace a recorded receipt");
  required(observation?.external_id === receipt?.external_id
    && ["completed", "failed", "cancelled", "unresolved"].includes(observation.state), "exact task must be observable before receipt reconciliation");
  let next = recordLaunchOutcome(state, key, { owner: r.owner, receipt, now });
  const association = { kind: "lead_receipt_association", key, actor, receipt_digest: authorizationDigest(receipt), reason: reason.trim() };
  const fingerprint = authorizationDigest(association);
  if (!next.events.some((event) => event.fingerprint === fingerprint)) {
    next = structuredClone(next);
    next.events.push({ ...association, fingerprint, observed_at: now });
  }
  return recordLaunchObservation(next, key, observation, { now });
}
