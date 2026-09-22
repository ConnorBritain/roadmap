// The GauntletArtifact contract (core). Every implementation registers this suite; it drives the
// backend ONLY through the canonical interface plus a small fixture the implementation supplies to
// stand in for the outside world (a worker publishing an artifact, a head moving, a comment edited).
//
//   makeFixture() -> {
//     artifact,                                   // the adapter under test
//     publish({ body, head }) -> ref,             // a worker publishes an artifact at `head` (ref = what fetch() takes)
//     advance(ref, head),                         // the artifact's head moves to `head` (a new commit/version)
//     editComment(ref, url),                      // someone alters a posted comment in place
//     lineage: { base, head, unrelated },         // three ids: head descends from base; unrelated does not
//     cleanup?(),
//   }
import { createHash } from "node:crypto";
import { assertGauntletArtifact, isActorIdentity, commentWasEdited } from "@connorbritain/roadmap-core/gauntlet-artifact.mjs";
import {
  freezeQualityBar, parseGauntletPrMarkers, parseFrozenBarBlock, renderCriticMarker, renderGauntletVerdictAck,
  reconstructVerdictAcksFromComments, isVerdictStale,
} from "@connorbritain/roadmap-core/gauntlet-core.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function gauntletArtifactContract(name, makeFixture, { test, eq, ok }) {
  const runFor = (fx) => {
    const frozen = freezeQualityBar({ subjectType: "slice", key: "auth-login", graph: { meta: { default_gate: "npm test" } },
      node: { invoke: "auth-login", title: "Login", gate: "npm test", what: "login flow" }, baseSha: fx.lineage.base });
    const run = { run_id: "gnt_auth_login_contract_000001", subject_type: "slice", subject_key: "auth-login",
      base_sha: fx.lineage.base, base_ref: "main", lead_actor: null, bar_sha256: frozen.sha256, frozen_bar: frozen.canonical,
      frozen_bar_markdown: frozen.markdown, max_rounds: 2, critic_tier: null, repair_tier: null, launches: [] };
    return { run, frozen };
  };

  test(`${name} GauntletArtifact: implements the canonical surface and a bounded actor identity`, async () => {
    const fx = makeFixture();
    try {
      const a = assertGauntletArtifact(fx.artifact);
      const actor = await a.actor();
      ok(isActorIdentity(actor), `actor() returns one bounded identity token (got ${JSON.stringify(actor)})`);
    } finally { fx.cleanup && fx.cleanup(); }
  });

  test(`${name} GauntletArtifact: freeze → publish → fetch round-trips the frozen bar digest and head() is content-addressed`, async () => {
    const fx = makeFixture();
    try {
      const a = assertGauntletArtifact(fx.artifact);
      const { run, frozen } = runFor(fx);
      run.lead_actor = await a.actor();
      const { barSha256, packet } = a.freeze({ run, frozenBar: frozen });
      eq(barSha256, frozen.sha256, "freeze reports the bar digest");
      const ref = await fx.publish({ body: packet, head: fx.lineage.head });   // the packet already carries the subject line
      const artifact = await a.fetch({ number: ref });
      ok(artifact && artifact.body.includes(packet), "the published artifact carries the packet");
      const marker = parseGauntletPrMarkers(artifact.body);
      eq(marker.barSha256, frozen.sha256, "marker digest survives the backend");
      ok(parseFrozenBarBlock(artifact.body), "the bar block is recoverable from the artifact");
      eq(a.head(artifact), fx.lineage.head, "head() is the exact published version identity");
      await fx.advance(ref, fx.lineage.unrelated);
      const moved = await a.fetch({ number: ref });
      ok(a.head(moved) !== a.head(artifact), "head() changes when content changes");
      ok(isVerdictStale({ head: fx.lineage.head }, a.head(moved)), "a verdict for the old head is stale on the new one");
    } finally { fx.cleanup && fx.cleanup(); }
  });

  test(`${name} GauntletArtifact: comment() is immutable-detectable and ack() binds body + locator digests idempotently`, async () => {
    const fx = makeFixture();
    try {
      const a = assertGauntletArtifact(fx.artifact);
      const { run, frozen } = runFor(fx);
      run.lead_actor = await a.actor();
      const { packet } = a.freeze({ run, frozenBar: frozen });
      const ref = await fx.publish({ body: packet, head: fx.lineage.head });
      const nonce = "c".repeat(32);
      const verdict = renderCriticMarker({ run, criticRole: "critic", round: 1, head: fx.lineage.head, nonce, verdict: "PASS" }) + "\n\nVERDICT RATIONALE: fine.";
      await a.comment({ number: ref }, verdict);
      let artifact = await a.fetch({ number: ref });
      const posted = artifact.comments.find((c) => c.body === verdict);
      ok(posted && typeof posted.url === "string" && posted.url.includes("#"), "the comment has a stable anchored locator");
      ok(!commentWasEdited(posted), "a fresh comment is not edited");
      const ackBody = renderGauntletVerdictAck({ run, comment: posted });
      await a.ack({ number: ref }, ackBody);
      await a.ack({ number: ref }, ackBody);   // a retry must not create a second distinct acknowledgment
      artifact = await a.fetch({ number: ref });
      const acks = reconstructVerdictAcksFromComments({ run, comments: artifact.comments });
      eq(acks.length, 1, "duplicate ack posts collapse to one protocol acknowledgment");
      eq(acks[0].commentSha256, sha256(verdict.replace(/\r\n?/g, "\n")), "ack binds the exact body digest");
      eq(acks[0].commentUrlSha256, sha256(posted.url.trim()), "ack binds the exact locator digest");
      await fx.editComment(ref, posted.url);
      artifact = await a.fetch({ number: ref });
      ok(commentWasEdited(artifact.comments.find((c) => c.url === posted.url)), "an in-place edit is detectable, so the ack fails closed");
    } finally { fx.cleanup && fx.cleanup(); }
  });

  test(`${name} GauntletArtifact: claim() elects exactly one of two callers; readClaim/listClaims/claimRef agree; lineage checks`, async () => {
    const fx = makeFixture();
    try {
      const a = assertGauntletArtifact(fx.artifact);
      const runId = "gnt_auth_login_contract_000002";
      const key = `${runId}:critic:1:${fx.lineage.head}:critic`;
      const safety = await a.assertClaimSafety(key, runId);
      ok(typeof safety.unsafe === "boolean", "claim safety is reported explicitly");
      const first = await a.claim(key, fx.lineage.head, runId);
      const second = await a.claim(key, fx.lineage.head, runId);
      eq([first.claimed, second.claimed], [true, false], "create-if-absent election: exactly one winner");
      eq(first.ref, a.claimRef(key, runId), "claimRef is deterministic and matches the created ref");
      const read = await a.readClaim(key, runId);
      eq(read && read.sha, fx.lineage.head, "readClaim returns the claimed head");
      ok((await a.listClaims(runId)).some((c) => c.ref === first.ref && c.kind === "critic"), "listClaims includes the claim with its kind");
      eq(await a.readClaim(`${runId}:repair:1:${fx.lineage.head}`, runId), null, "an unclaimed key reads as null");
      ok(await a.descendsFrom(fx.lineage.base, fx.lineage.head), "head descends from base");
      ok(!(await a.descendsFrom(fx.lineage.base, fx.lineage.unrelated)), "an unrelated head does not");
      const words = a.workerFetchInstructions({ number: 1 }, fx.lineage.head);
      ok(typeof words.label === "string" && typeof words.fetch === "string" && words.fetch.includes(fx.lineage.head), "worker fetch wording names the exact head");
    } finally { fx.cleanup && fx.cleanup(); }
  });
}
