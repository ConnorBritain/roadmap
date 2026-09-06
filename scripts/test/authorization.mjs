import assert from "node:assert/strict";
import { freezeAuthorization, authorizationStatus, reserveAuthorizedLaunch, recordLaunchOutcome,
  recordLaunchObservation, recordLaunchNotSubmitted, assertAuthorizationState, assertAuthorizationTransition, authorizationDigest, reconcileLaunchReceipt, recordContinuation, continuationStatus } from "../lib/gauntlet-authorization.mjs";
import { mutateAuthorization } from "../lib/gauntlet-authorization-io.mjs";
import { submitWithImplementationCapacity } from "../lib/implementation-authorization.mjs";

const NOW = "2026-09-05T10:00:00Z";
const HEAD = "a".repeat(40);
export function continuationFixtureReceipt(at = NOW, status = "ACTIVE") {
  return { version: 1, kind: "codex_desktop_heartbeat", interval_minutes: 30, automation_id: "fixture-heartbeat",
    target_thread_id: "11111111-1111-1111-1111-111111111111", status, observed_at: at,
    receipt: { automationId: "fixture-heartbeat", status } };
}
export function authorizationFixture(snapshot = { fixture: true }) {
  const state = freezeAuthorization({ version: 1, run_id: "authorized-fixture", mode: "evaluation", source_sha: HEAD, lead_actor: "lead",
    scope: { description: "Read fixture source and write isolated documentation packets only.", snapshot },
    providers: { evaluator: "codex", critic: "codex", repair: "codex" }, required_review_roles: ["critic"],
    verification_commands: [], model_preferences: { lead: { model: "gpt-6-astra", reasoning_effort: "high" },
      cloud: { model: "gpt-6-astra", reasoning_effort: "medium" } },
    limits: { submissions: 3, concurrency: 2, repairs: 1, attempts_per_submission: 1, launch_deadline: "2026-09-08T10:00:00Z" },
  }, { now: NOW });
  return recordContinuation(state, continuationFixtureReceipt(), { actor: "lead", confirm: true, now: NOW });
}
export function memoryAuthorityStore(initial) {
  let revision = initial ? { sha: "0", state: structuredClone(initial), ref: "protected-fixture" } : null;
  return {
    async read() { return structuredClone(revision); },
    async compareAndSwap(runId, expected, state) {
      if ((expected?.sha || null) !== (revision?.sha || null)) return { written: false, current: structuredClone(revision) };
      if (revision) assert.equal(state.authorization_digest, revision.state.authorization_digest);
      revision = { sha: String(Number(revision?.sha || 0) + 1), state: structuredClone(state), ref: "protected-fixture" };
      return { written: true, current: structuredClone(revision) };
    },
  };
}
function request(key = "worker-one", role = "evaluator") { return { key, role, provider: "codex", expected_head: HEAD, prompt_digest: "b".repeat(64) }; }
function receipt(id = "task_fixture") { return { provider: "codex", external_id: id, external_url: `https://chatgpt.com/codex/tasks/${id}` }; }
function reserve(state, key, role) { return reserveAuthorizedLaunch(state, request(key, role), { owner: key, now: NOW }).state; }

export function registerAuthorizationTests(test) {
  test("known pre-submit outcomes cannot erase ambiguity, reset budgets or originate from provider observations", () => {
    const reserved = reserve(authorizationFixture(), "one");
    const stopped = recordLaunchNotSubmitted(reserved, "one", { owner: "one", now: NOW });
    assertAuthorizationTransition(reserved, stopped);
    assert.equal(reserveAuthorizedLaunch(stopped, request("one"), { owner: "other", now: NOW }).reserved, false);
    assert.equal(authorizationStatus(stopped).submissions_used, 1);
    const ambiguous = recordLaunchOutcome(reserved, "one", { owner: "one", ambiguous: true, now: NOW });
    assert.throws(() => recordLaunchNotSubmitted(ambiguous, "one", { owner: "one", now: NOW }));
    assert.throws(() => assertAuthorizationTransition(ambiguous, stopped));
    const submitted = recordLaunchOutcome(reserved, "one", { owner: "one", receipt: receipt(), now: NOW });
    const observed = recordLaunchObservation(submitted, "one", { external_id: "task_fixture", state: "not_submitted" }, { now: NOW });
    assert.equal(observed.reservations[0].state, "submitted");
  });
  test("pausing after reservation prevents provider submission without replenishing capacity or blocking observation", async () => {
    const reserved = reserve(authorizationFixture(), "one");
    const store = memoryAuthorityStore(recordContinuation(reserved, continuationFixtureReceipt(NOW, "PAUSED"),
      { actor: "lead", confirm: true, now: NOW }));
    let submissions = 0;
    await assert.rejects(() => submitWithImplementationCapacity({ store, runId: reserved.authorization.run_id,
      key: "one", owner: "one", reserved: true }, async () => { submissions++; return receipt(); },
    { now: Date.parse(NOW) }), /before provider submission/);
    assert.equal(submissions, 0);
    const afterPause = (await store.read()).state;
    assert.equal(authorizationStatus(afterPause).submissions_used, 1);
    assert.equal(afterPause.reservations[0].state, "not_submitted");
    assert.equal(authorizationStatus(afterPause).active, 0);
    assertAuthorizationTransition(reserved, afterPause);
    assert.throws(() => reconcileLaunchReceipt(afterPause, "one", { actor: "lead", receipt: receipt(),
      observation: { external_id: "task_fixture", state: "completed" }, reason: "Inspected exact fixture receipt",
      confirm: true, now: NOW }), /no longer awaiting/);
    const submitted = recordLaunchOutcome(reserved, "one", { owner: "one", receipt: receipt(), now: NOW });
    const paused = recordContinuation(submitted, continuationFixtureReceipt(NOW, "PAUSED"), { actor: "lead", confirm: true, now: NOW });
    assert.equal(recordLaunchObservation(paused, "one", { external_id: "task_fixture", state: "completed" }, { now: NOW }).reservations[0].state, "completed");
  });
  test("bounded launches require a fresh active desktop handoff, without treating registration as a verified wake", () => {
    const state = authorizationFixture(); delete state.continuation_records;
    assert.equal(continuationStatus(state).state, "setup_required");
    assert.throws(() => reserve(state, "one"), /heartbeat/);
    const registered = recordContinuation(state, continuationFixtureReceipt(), { actor: "lead", confirm: true, now: NOW });
    assert.equal(continuationStatus(registered, { now: Date.parse(NOW) }).launch_ready, true);
    assert.equal(continuationStatus(registered, { now: Date.parse(NOW) }).wake_verified, false);
    assert.equal(reserve(registered, "one").reservations.length, 1);
    assert.throws(() => reserveAuthorizedLaunch(registered, request("one"), { owner: "one", now: "2026-09-05T11:01:00Z" }), /heartbeat/);
    const paused = recordContinuation(registered, continuationFixtureReceipt(NOW, "PAUSED"), { actor: "lead", confirm: true, now: NOW });
    assertAuthorizationTransition(registered, paused); assert.equal(paused.continuation_records.length, 2);
    assert.throws(() => reserve(paused, "one"), /heartbeat/);
    assert.throws(() => recordContinuation(state, continuationFixtureReceipt(), { actor: "worker", confirm: true, now: NOW }), /frozen lead/);
    assert.throws(() => recordContinuation(registered, { ...continuationFixtureReceipt(), target_thread_id: "22222222-2222-2222-2222-222222222222" }, { actor: "lead", confirm: true, now: NOW }), /silently replace/);
  });
  test("explicit receipt recovery is lead-attributable, exact, idempotent and does not reset budgets", () => {
    const initial = reserve(authorizationFixture(), "one");
    const args = { actor: "lead", receipt: receipt(), observation: { external_id: "task_fixture", state: "completed" },
      reason: "Inspected exact task instructions and frozen assignment identity", confirm: true, now: NOW };
    assert.throws(() => reconcileLaunchReceipt(initial, "one", { ...args, actor: "worker" }), /frozen-lead/);
    assert.throws(() => reconcileLaunchReceipt(initial, "one", { ...args, observation: { external_id: "task_fixture", state: "not_found" } }), /observable/);
    const recovered = reconcileLaunchReceipt(initial, "one", args);
    assertAuthorizationTransition(initial, recovered);
    assert.equal(recovered.reservations[0].state, "completed");
    assert.equal(authorizationStatus(recovered).submissions_remaining, 2);
    assert.equal(recovered.events[0].kind, "lead_receipt_association");
    assert.equal(authorizationDigest(reconcileLaunchReceipt(recovered, "one", args)), authorizationDigest(recovered));
    assert.throws(() => reconcileLaunchReceipt(recovered, "one", { ...args, receipt: receipt("task_other") }), /replace/);
    const delayed = recordLaunchObservation(recovered, "one", { external_id: "task_fixture", state: "failed" }, { now: NOW });
    assertAuthorizationTransition(recovered, delayed);
    assert.equal(delayed.reservations[0].state, "completed");
    assert.equal(delayed.reservations[0].observation.state, "failed");
  });
  test("authorization freezes role defaults, approved checks and exact scope without changing consumer defaults", () => {
    const state = authorizationFixture();
    assert.equal(state.authorization.model_preferences.lead.reasoning_effort, "high");
    assert.equal(state.authorization.model_preferences.cloud.reasoning_effort, "medium");
    assert.deepEqual(state.authorization.verification_commands, []);
    assert.equal(authorizationStatus(state, { now: Date.parse(NOW) }).submissions_remaining, 3);
    const altered = structuredClone(state); altered.authorization.limits.submissions = 500;
    assert.throws(() => assertAuthorizationState(altered), /digest mismatch/);
  });
  test("authorization refuses missing independent critic, invalid limits and multiple provider attempts", () => {
    for (const change of [
      (a) => { a.required_review_roles = []; }, (a) => { a.required_review_roles = ["security"]; },
      (a) => { a.required_review_roles = ["critic", "critic"]; }, (a) => { a.limits.concurrency = 0; },
      (a) => { a.limits.attempts_per_submission = 2; }, (a) => { a.limits.launch_deadline = NOW; },
      (a) => { a.providers.evaluator = "local"; },
    ]) {
      const a = authorizationFixture().authorization; change(a);
      assert.throws(() => freezeAuthorization(a, { now: NOW }));
    }
  });
  test("authorization duplicates cannot spend again or replace the winning request", () => {
    const initial = authorizationFixture(); const one = reserve(initial, "one");
    const duplicate = reserveAuthorizedLaunch(one, request("one"), { owner: "other", now: NOW });
    assert.equal(duplicate.reserved, false); assert.equal(one.reservations.length, 1);
    assert.equal(initial.reservations.length, 0);
    assert.throws(() => reserveAuthorizedLaunch(one, { ...request("one"), expected_head: "c".repeat(40) }, { owner: "other", now: NOW }), /different request/);
    assert.throws(() => reserveAuthorizedLaunch(one, { ...request("two"), provider: "claude" }, { owner: "two", now: NOW }), /provider differs/);
  });
  test("ambiguous submission consumes concurrency until exact receipt and terminal observation", () => {
    let state = reserve(authorizationFixture(), "one");
    state = recordLaunchOutcome(state, "one", { owner: "one", ambiguous: true, now: NOW });
    state = reserve(state, "two");
    assert.throws(() => reserve(state, "three"), /concurrency/);
    assert.throws(() => recordLaunchOutcome(state, "one", { owner: "other", receipt: receipt(), now: NOW }), /reserving conductor/);
    state = recordLaunchOutcome(state, "one", { owner: "one", receipt: receipt(), now: NOW });
    assert.throws(() => recordLaunchObservation(state, "one", { external_id: "task_other", state: "completed" }, { now: NOW }), /exact recorded task/);
    state = recordLaunchObservation(state, "one", { external_id: "task_fixture", state: "observation_failed" }, { now: NOW });
    assert.throws(() => reserve(state, "three"), /concurrency/);
    state = recordLaunchObservation(state, "one", { external_id: "task_fixture", state: "completed" }, { now: NOW });
    state = reserve(state, "three");
    assert.equal(authorizationStatus(state).submissions_remaining, 0);
    assert.throws(() => reserve(state, "four"), /submission ceiling/);
  });
  test("deadline stops launches but not observation, and observation fingerprints survive restart", () => {
    let state = reserve(authorizationFixture(), "one");
    state = recordLaunchOutcome(state, "one", { owner: "one", receipt: receipt(), now: NOW });
    const late = "2026-09-09T10:00:00Z";
    assert.throws(() => reserveAuthorizedLaunch(state, request("two"), { owner: "two", now: late }), /deadline/);
    const observation = { external_id: "task_fixture", state: "completed" };
    state = recordLaunchObservation(state, "one", observation, { now: late });
    const restored = JSON.parse(JSON.stringify(state));
    assert.strictEqual(recordLaunchObservation(restored, "one", observation, { now: late }), restored);
    assert.equal(restored.events.length, 1);
  });
  test("repair reservations have a separate frozen ceiling and no replacement receipts", () => {
    let state = reserve(authorizationFixture(), "repair-one", "repair");
    state = recordLaunchOutcome(state, "repair-one", { owner: "repair-one", receipt: receipt(), now: NOW });
    state = recordLaunchObservation(state, "repair-one", { external_id: "task_fixture", state: "completed" }, { now: NOW });
    assert.throws(() => reserve(state, "repair-two", "repair"), /repair ceiling/);
    assert.throws(() => recordLaunchOutcome(state, "repair-one", { owner: "repair-one", receipt: receipt("task_changed"), now: NOW }), /cannot be replaced/);
  });
  test("two conductors atomically elect one submission even with independent local ledgers", async () => {
    const store = memoryAuthorityStore(authorizationFixture());
    const winners = await Promise.all(["lead-one", "lead-two"].map((owner) => mutateAuthorization(store, "authorized-fixture",
      (state) => reserveAuthorizedLaunch(state, request("same-job"), { owner, now: NOW }))));
    assert.equal(winners.filter((result) => result.reserved).length, 1);
    const restored = await store.read();
    assert.equal(restored.state.reservations.length, 1);
    assert.equal(authorizationStatus(restored.state).submissions_remaining, 2);
    const retry = await mutateAuthorization(store, "authorized-fixture", (state) => reserveAuthorizedLaunch(state,
      request("same-job"), { owner: "lead-after-restart", now: NOW }));
    assert.equal(retry.reserved, false);
  });
  test("different concurrent jobs cannot overrun the shared concurrency ceiling", async () => {
    const store = memoryAuthorityStore(authorizationFixture());
    const results = await Promise.allSettled(["one", "two", "three"].map((owner) => mutateAuthorization(store, "authorized-fixture",
      (state) => reserveAuthorizedLaunch(state, request(owner), { owner, now: NOW }))));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal((await store.read()).state.reservations.length, 2);
  });
  test("a lost CAS response cannot cause duplicate submission after restart", async () => {
    const original = memoryAuthorityStore(authorizationFixture()); let lose = true;
    const store = { ...original, async compareAndSwap(...args) {
      const result = await original.compareAndSwap(...args);
      if (lose) { lose = false; throw new Error("network response lost"); }
      return result;
    } };
    await assert.rejects(() => mutateAuthorization(store, "authorized-fixture", (state) => reserveAuthorizedLaunch(state,
      request("one"), { owner: "first", now: NOW })), /lost/);
    const resumed = await mutateAuthorization(store, "authorized-fixture", (state) => reserveAuthorizedLaunch(state,
      request("one"), { owner: "resumed", now: NOW }));
    assert.equal(resumed.reserved, false); assert.equal(resumed.reservation.owner, "first");
    assert.equal(authorizationStatus(resumed.state).submissions_remaining, 2);
  });
  test("canonical authority hashes do not depend on YAML mapping insertion order", () => {
    assert.equal(authorizationDigest({ a: 1, b: { d: 4, c: 3 } }), authorizationDigest({ b: { c: 3, d: 4 }, a: 1 }));
  });
  test("a valid policy digest cannot hide removed reservations or rewritten receipts/history", () => {
    let state = reserve(authorizationFixture(), "one");
    state = recordLaunchOutcome(state, "one", { owner: "one", receipt: receipt(), now: NOW });
    state = recordLaunchObservation(state, "one", { external_id: "task_fixture", state: "completed" }, { now: NOW });
    for (const change of [
      (s) => { s.reservations = []; }, (s) => { s.events = []; }, (s) => { s.reservations[0].owner = "other"; },
      (s) => { s.reservations[0].receipt = null; }, (s) => { s.reservations[0].state = "reserved"; },
    ]) { const next = structuredClone(state); change(next); assert.throws(() => assertAuthorizationTransition(state, next)); }
  });
}
