// Protected GitHub Git objects form a compare-and-swap authority journal.
// There is no local authoritative counter and no force update or ref deletion.
import { spawnSync } from "node:child_process";
import { assertAuthorizationState, assertAuthorizationTransition, authorizationDigest } from "./gauntlet-authorization.mjs";
import { prohibitedDataFindings } from "./evaluation-packet.mjs";

const STATE_PATH = ".roadmap-gauntlet-authority.json";
const MAX_BYTES = 4 * 1024 * 1024;
export const authorizationClaimKey = (runId) => `gauntlet:authority:${runId}:v1`;

export function githubAuthorizationStore(root, { github, execImpl = spawnSync } = {}) {
  if (!github) throw new Error("authenticated GitHub adapter required");
  const call = (args, input) => execImpl("gh", args, { cwd: root, input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
  const api = (endpoint, payload) => {
    const r = call(["api", endpoint, ...(payload ? ["--method", "POST", "--input", "-"] : [])], payload ? JSON.stringify(payload) : undefined);
    if (r.error || r.status !== 0) throw new Error("GitHub authority operation failed; no launch is permitted until its protected state is reconciled");
    try { return JSON.parse(r.stdout); } catch { throw new Error("invalid GitHub authority response"); }
  };
  let slug;
  function repository() {
    if (slug) return slug;
    const result = call(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    if (result.error || result.status !== 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.stdout.trim())) throw new Error("cannot resolve authority repository");
    slug = result.stdout.trim(); return slug;
  }
  async function check(runId, state = null) {
    await github.assertAvailable();
    const protection = await github.assertClaimProtection(authorizationClaimKey(runId), runId);
    if (protection?.unsafe) throw new Error("bounded authorization refuses unsafe/unprotected claim branches");
    if (state && await github.viewerLogin() !== state.authorization.lead_actor) throw new Error("authority mutation requires the frozen lead GitHub actor");
  }
  async function read(runId) {
    await github.assertAvailable();
    const claim = await github.getLaunchClaim(authorizationClaimKey(runId), runId);
    if (!claim) return null;
    await check(runId);
    return readClaim(claim, runId);
  }
  function readClaim(claim, runId = null) {
    const commit = api(`repos/${repository()}/git/commits/${claim.sha}`);
    const tree = api(`repos/${repository()}/git/trees/${commit.tree.sha}`);
    if (tree.truncated) throw new Error("authority tree response truncated");
    const entry = tree.tree.find((entry) => entry.path === STATE_PATH);
    if (!entry || entry.mode !== "100644" || entry.type !== "blob" || entry.size > MAX_BYTES) throw new Error("invalid protected authority blob");
    const blob = api(`repos/${repository()}/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64" || blob.size > MAX_BYTES) throw new Error("unsupported authority blob encoding/size");
    const state = assertAuthorizationState(JSON.parse(Buffer.from(blob.content, "base64").toString("utf8")));
    const actualRunId = state.authorization.run_id;
    if ((runId && actualRunId !== runId) || claim.ref !== github.claimRef(authorizationClaimKey(actualRunId), actualRunId)) {
      throw new Error("protected authority run identity mismatch");
    }
    return { sha: claim.sha, tree: commit.tree.sha, state, ref: claim.ref };
  }
  async function list() {
    await github.assertAvailable();
    const refs = api(`repos/${repository()}/git/matching-refs/heads/roadmap-gauntlet-locks/`);
    if (!Array.isArray(refs)) throw new Error("invalid authority discovery response");
    const snapshots = [], failures = [];
    for (const entry of refs.filter((entry) => /^refs\/heads\/roadmap-gauntlet-locks\/[a-f0-9]{16}-authority-[a-f0-9]{64}$/.test(entry.ref || ""))) {
      try {
        const snapshot = readClaim({ ref: entry.ref, sha: entry.object?.sha });
        await check(snapshot.state.authorization.run_id);
        snapshots.push(snapshot);
      } catch { failures.push({ ref: entry.ref, error_code: "authority_unreadable_or_unprotected" }); }
    }
    return { snapshots, failures };
  }
  async function compareAndSwap(runId, expected, state) {
    assertAuthorizationState(state); await check(runId, state);
    if (state.authorization.run_id !== runId) throw new Error("authority run identity mismatch");
    if (expected) assertAuthorizationTransition(expected.state, state);
    const latest = await read(runId);
    if ((latest?.sha || null) !== (expected?.sha || null)) return { written: false, current: latest };
    const content = JSON.stringify(state);
    if (Buffer.byteLength(content) > MAX_BYTES || prohibitedDataFindings(content).length) throw new Error("authority contains oversized or detected prohibited data; refusing publication");
    const blob = api(`repos/${repository()}/git/blobs`, { content, encoding: "utf-8" });
    const parent = expected?.sha || state.authorization.source_sha;
    const parentTree = expected?.tree || api(`repos/${repository()}/git/commits/${parent}`).tree.sha;
    const tree = api(`repos/${repository()}/git/trees`, { base_tree: parentTree,
      tree: [{ path: STATE_PATH, mode: "100644", type: "blob", sha: blob.sha }] });
    const commit = api(`repos/${repository()}/git/commits`, { message: `Gauntlet authority ${runId} ${authorizationDigest(state)}`,
      tree: tree.sha, parents: [parent] });
    const ref = github.claimRef(authorizationClaimKey(runId), runId);
    const endpoint = expected ? `repos/${repository()}/git/refs/${ref.slice("refs/".length)}` : `repos/${repository()}/git/refs`;
    const payload = expected ? { sha: commit.sha, force: false } : { ref, sha: commit.sha };
    // A lost write response is reconciled by exact commit SHA, never by recency.
    const result = call(["api", endpoint, "--method", expected ? "PATCH" : "POST", "--input", "-"], JSON.stringify(payload));
    if (!result.error && result.status === 0) return { written: true, current: { sha: commit.sha, tree: tree.sha, state, ref } };
    const observed = await read(runId);
    return { written: observed?.sha === commit.sha, current: observed };
  }
  return { read, list, compareAndSwap };
}

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
