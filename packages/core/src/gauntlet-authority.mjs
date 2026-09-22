// roadmap — protected authority journal, the store-agnostic half (core). A store is any object with
//   read(runId) -> { sha, tree?, state, ref } | null
//   compareAndSwap(runId, expected, state) -> { written, current }
//   list?() -> { snapshots, failures }
// The github-pr adapter supplies one backed by protected Git objects; tests use an in-memory one.
// There is no local authoritative counter and no force update or ref deletion.
import { assertAuthorizationTransition, recordContinuation, continuationStatus } from "./gauntlet-authorization.mjs";

export const authorizationClaimKey = (runId) => `gauntlet:authority:${runId}:v1`;

// Retries only the local transition over refreshed durable state. Never put a
// provider submission inside transition: only the CAS winner may submit once.
export async function mutateAuthorization(store, runId, transition, { retries = 5 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const prior = await store.read(runId);
    if (!prior) throw new Error("no durable run authorization; authorize explicitly before launch");
    const result = transition(prior.state);
    if (result.state === prior.state) return { ...result, snapshot: prior };
    assertAuthorizationTransition(prior.state, result.state);
    const updated = await store.compareAndSwap(runId, prior, result.state);
    if (updated.written) return { ...result, snapshot: updated.current };
  }
  throw new Error("authority changed concurrently; no new provider submission was made by this operation");
}

// `artifact` is the GauntletArtifact (its actor() is the authenticated lead). `github` is accepted
// as a legacy alias until the runtime moves into the engineering package.
export async function recordRunContinuation({ store, runId, artifact, github, record, confirm, now = new Date().toISOString() }) {
  const adapter = artifact || github;
  const actor = await (adapter.actor ? adapter.actor() : adapter.viewerLogin());
  const result = await mutateAuthorization(store, runId, (state) => ({ state: recordContinuation(state, record, { actor, confirm, now }) }));
  return { action: "continuation", run_id: runId, continuation: continuationStatus(result.state, { now: Date.parse(now) }) };
}
