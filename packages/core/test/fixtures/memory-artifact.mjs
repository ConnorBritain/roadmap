// An in-memory GauntletArtifact — the reference implementation the contract is validated against.
// No backend at all: artifacts, comments, claims and lineage live in plain objects. It exists so the
// contract test can be trusted before any real adapter registers, and as the seed for exec-general's
// doc stub. It is NOT a production backend: nothing here is durable.
import { renderGauntletPrMarkers } from "@connorbritain/roadmap-core/gauntlet-core.mjs";

export function memoryGauntletArtifact({ actor = "memory-lead", lineage = {} } = {}) {
  const artifacts = new Map();   // number -> artifact
  const claims = new Map();      // ref -> { ref, sha, kind }
  const parents = new Map(Object.entries(lineage.parents || {}));   // child -> parent
  let next = 1;
  const descends = (ancestor, head) => {
    for (let cur = head, guard = 0; cur && guard < 1000; cur = parents.get(cur), guard++) if (cur === ancestor) return true;
    return false;
  };
  const kindOf = (key) => key.startsWith("gauntlet:authority:") ? "authority" : key.startsWith("gauntlet:implementation:") ? "implementation"
    : key.startsWith("gauntlet:tombstone:") ? "tombstone" : key.startsWith("gauntlet:cancellation:") ? "cancellation"
    : key.includes(":critic:") ? "critic" : key.includes(":repair:") ? "repair" : "other";
  const now = () => new Date().toISOString();
  const adapter = {
    kind: "doc",
    supportsProtectedAuthority: false,
    assertAvailable() { return true; },
    actor() { return actor; },
    freeze({ run, frozenBar }) { return { barSha256: run.bar_sha256, packet: renderGauntletPrMarkers({ run, subjectType: run.subject_type, key: run.subject_key, qualityBar: frozenBar }) }; },
    head(artifact) { return (artifact && artifact.currentHead) || null; },
    fetch(ref) {
      const number = ref && typeof ref === "object" ? ref.number : ref;
      const a = artifacts.get(Number(number));
      return a ? structuredClone(a) : null;
    },
    comment(ref, body) {
      const a = artifacts.get(Number(ref && typeof ref === "object" ? ref.number : ref));
      if (!a) throw new Error("no such artifact");
      const ts = now();
      a.comments.push({ body, author: actor, createdAt: ts, updatedAt: ts, edited: false, url: `${a.url}#comment-${a.comments.length + 1}` });
      return true;
    },
    ack(ref, body) { return adapter.comment(ref, body); },
    descendsFrom(ancestor, head) { return descends(ancestor, head); },
    claimRef(key, runId) { return `refs/memory/${runId}/${kindOf(key)}/${Buffer.from(key).toString("hex").slice(0, 32)}`; },
    assertClaimSafety(key, runId) { return { unsafe: false, ref: adapter.claimRef(key, runId), rules: ["memory"] }; },
    claim(key, head, runId) {
      const ref = adapter.claimRef(key, runId);
      if (claims.has(ref)) return { claimed: false, ref };
      claims.set(ref, { ref, sha: head, kind: kindOf(key), runId });
      return { claimed: true, ref };
    },
    readClaim(key, runId) { const c = claims.get(adapter.claimRef(key, runId)); return c ? { ref: c.ref, sha: c.sha } : null; },
    listClaims(runId) { return [...claims.values()].filter((c) => c.runId === runId).map(({ ref, sha, kind }) => ({ ref, sha, kind })); },
    workerFetchInstructions(artifact, head) {
      return { label: `document #${artifact && artifact.number}`, fetch: `Open document #${artifact && artifact.number} at version ${head} and confirm that version id exactly.` };
    },
    // fixture-side world simulation (not part of the interface)
    _publish({ body, head }) {
      const number = next++;
      const ts = now();
      artifacts.set(number, { id: String(number), number, url: `memory://artifact/${number}`, title: `artifact ${number}`, body, state: "OPEN",
        draft: false, mergeable: "clean", headRef: `doc/${number}`, baseRef: "main", currentHead: head, checks: "none",
        comments: [], commits: [head], createdAt: ts, updatedAt: ts });
      return number;
    },
    _advance(number, head) { const a = artifacts.get(Number(number)); a.commits.push(head); a.currentHead = head; a.updatedAt = now(); },
    _editComment(number, url) { const c = artifacts.get(Number(number)).comments.find((x) => x.url === url); c.body += " (edited)"; c.edited = true; c.updatedAt = new Date(Date.now() + 1000).toISOString(); },
  };
  return adapter;
}

// The fixture shape gauntletArtifactContract expects.
export function memoryArtifactFixture() {
  const base = "a".repeat(40), head = "b".repeat(40), unrelated = "c".repeat(40);
  const artifact = memoryGauntletArtifact({ lineage: { parents: { [head]: base } } });
  return {
    artifact,
    publish: (args) => artifact._publish(args),
    advance: (ref, h) => artifact._advance(ref, h),
    editComment: (ref, url) => artifact._editComment(ref, url),
    lineage: { base, head, unrelated },
  };
}
