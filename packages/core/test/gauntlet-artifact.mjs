// packages/core tests — the GauntletArtifact contract run against the in-memory reference
// implementation, plus the interface helpers.
import { test, eq, ok, throws } from "./harness.mjs";
import { asGauntletArtifact, assertGauntletArtifact, normalizeArtifact, normalizeComment, commentWasEdited, isActorIdentity, GAUNTLET_ARTIFACT_METHODS } from "@connorbritain/roadmap-core/gauntlet-artifact.mjs";
import { gauntletArtifactContract } from "./contracts/gauntlet-artifact.mjs";
import { memoryArtifactFixture } from "./fixtures/memory-artifact.mjs";

test("gauntlet-artifact: asGauntletArtifact maps legacy client names onto the canonical surface both ways", async () => {
  const legacy = { viewerLogin: async () => "lead", getPr: (n) => ({ number: n, currentHead: "x".repeat(40) }), addComment: () => true, isAncestor: () => true,
    claimLaunch: () => ({ claimed: true, ref: "r" }), getLaunchClaim: () => null, listRunClaims: () => [], assertClaimProtection: () => ({ unsafe: false }) };
  const a = asGauntletArtifact(legacy);
  eq(await a.actor(), "lead", "actor ← viewerLogin");
  eq(a.fetch(7).number, 7, "fetch ← getPr");
  ok(a.comment() === true && a.ack() === true && a.descendsFrom() === true && a.claim().claimed === true, "comment/ack/descendsFrom/claim mapped");
  eq(a.head({ currentHead: "h" }), "h", "head() defaults to currentHead");
  ok(typeof a.workerFetchInstructions({ number: 1 }, "h").fetch === "string", "generic worker wording when the backend has none");
  const canonical = asGauntletArtifact({ kind: "doc", actor: () => "me", fetch: () => null });
  eq(await canonical.viewerLogin(), "me", "viewerLogin ← actor (legacy callers keep working)");
  eq(asGauntletArtifact(canonical), canonical, "wrapping is idempotent");
  throws(() => asGauntletArtifact(null), "adapter is required", "null client refused");
});

test("gauntlet-artifact: assertGauntletArtifact names every missing method and refuses unknown kinds", () => {
  throws(() => assertGauntletArtifact({ kind: "github-pr", actor: () => "x" }), "is missing:", "missing methods listed");
  const full = Object.fromEntries(GAUNTLET_ARTIFACT_METHODS.map((m) => [m, () => null]));
  throws(() => assertGauntletArtifact({ ...full, kind: "svn" }), "kind must be one of", "unknown backend kind refused");
  ok(assertGauntletArtifact({ ...full, kind: "git-file" }), "a complete adapter passes");
});

test("gauntlet-artifact: normalizeArtifact/normalizeComment fill the neutral shape; commentWasEdited fails closed", () => {
  const a = normalizeArtifact({ number: 3, comments: [{ body: "b", author: { login: "who" }, createdAt: "2026-01-01T00:00:00Z" }], commits: [{ oid: "o" }, "p", null] });
  eq([a.id, a.state, a.draft, a.mergeable, a.checks, a.comments[0].author, a.comments[0].edited, a.commits], ["3", "OPEN", false, "unknown", "none", "who", false, ["o", "p"]], "defaults + coercions");
  ok(commentWasEdited(null) && commentWasEdited({ edited: true }) && commentWasEdited({ createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }), "missing, flagged, or later-updated → edited");
  ok(!commentWasEdited(normalizeComment({ body: "x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })), "same timestamps → not edited");
  ok(isActorIdentity("octocat") && isActorIdentity("lead@example.org") && !isActorIdentity("two words") && !isActorIdentity(""), "actor identity is one bounded token");
});

gauntletArtifactContract("memory (reference)", memoryArtifactFixture, { test, eq, ok });
