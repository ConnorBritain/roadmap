import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorizationFixture } from "./authorization.mjs";
import { authorizationDigest, reserveAuthorizedLaunch } from "../lib/gauntlet-authorization.mjs";
import { evaluationReviewRun, evaluationReviewStatus, assertNextEvaluationReviewer, evaluationAdmissionTotals,
  sealEvaluationPayload, evaluationAttestation, findEvaluationAttestation } from "../lib/evaluation-review-core.mjs";
import { renderCriticMarker, renderGauntletLaunchMarker, renderGauntletVerdictAck } from "../lib/gauntlet-core.mjs";

const HEAD = "b".repeat(40), SOURCE = "a".repeat(40), NONCE = "c".repeat(32);
const TIME = "2026-09-05T10:01:00Z";
function fixture(roles = ["critic"]) {
  const state = authorizationFixture({ assignments: [{ id: "source-map" }] });
  state.authorization.required_review_roles = roles;
  state.authorization_digest = authorizationDigest(state.authorization);
  state.evidence_pr = { number: 42, url: "https://github.com/owner/repo/pull/42", base_ref: "main" };
  return { state, pr: { number: 42, url: state.evidence_pr.url, baseRefName: "main", state: "OPEN", currentHead: HEAD, comments: [], commits: [HEAD] } };
}
function comment(pr, body, author = "lead") {
  const c = { body, author, url: `${pr.url}#issuecomment-${pr.comments.length + 1}`, createdAt: TIME, updatedAt: TIME };
  pr.comments.push(c); return c;
}
function review(f, verdict, { role = "critic", round = 1, nonce = NONCE, acknowledge = true } = {}) {
  const request = { key: `critic-${role}-${round}`, role: "critic", provider: "codex", expected_head: f.pr.currentHead,
    critic_role: role, round, nonce_sha256: createHash("sha256").update(nonce).digest("hex") };
  f.state = reserveAuthorizedLaunch(f.state, request, { owner: request.key, now: "2026-09-05T10:00:00Z" }).state;
  const run = evaluationReviewRun(f.state);
  comment(f.pr, renderGauntletLaunchMarker({ run, role: "critic", criticRole: role, round, expectedHead: f.pr.currentHead, nonce }));
  const result = comment(f.pr, renderCriticMarker({ run, criticRole: role, round, head: f.pr.currentHead, nonce, verdict }) + "\nConcrete fixture evidence.", "independent-critic");
  if (acknowledge) comment(f.pr, renderGauntletVerdictAck({ run, comment: result }));
  return result;
}

export function registerEvaluationReviewTests(test) {
  test("evaluation uses frozen product SHA independently of evidence PR head", () => {
    const f = fixture(); const run = evaluationReviewRun(f.state);
    assert.equal(run.base_sha, SOURCE); assert.notEqual(run.base_sha, f.pr.currentHead);
    assert.ok(run.frozen_bar_markdown.includes("NOT the evidence PR head"));
    assert.equal(evaluationReviewStatus(f.state, f.pr).state, "awaiting_critic");
  });
  test("evaluation REVISE needs exact lead acknowledgment; fresh head requires fresh PASS", () => {
    const f = fixture();
    const result = review(f, "REVISE", { acknowledge: false });
    assert.equal(evaluationReviewStatus(f.state, f.pr).state, "awaiting_lead_ack");
    comment(f.pr, renderGauntletVerdictAck({ run: evaluationReviewRun(f.state), comment: result }));
    assert.equal(evaluationReviewStatus(f.state, f.pr).state, "needs_repair");
    f.pr.currentHead = "d".repeat(40); f.pr.commits.push(f.pr.currentHead);
    assert.equal(evaluationReviewStatus(f.state, f.pr).state, "awaiting_critic");
    review(f, "PASS", { round: 2, nonce: "e".repeat(32) });
    assert.equal(evaluationReviewStatus(f.state, f.pr).pass, true);
    f.pr.currentHead = "f".repeat(40);
    assert.equal(evaluationReviewStatus(f.state, f.pr).pass, false);
  });
  test("specialist reviewers are sequential and cannot substitute for independent critic", () => {
    const f = fixture(["critic", "security"]);
    assert.throws(() => assertNextEvaluationReviewer(evaluationReviewStatus(f.state, f.pr), "security"), /not the next/);
    review(f, "PASS");
    const status = evaluationReviewStatus(f.state, f.pr);
    assert.equal(status.pass, false); assert.equal(status.next_role, "security");
    assertNextEvaluationReviewer(status, "security");
    review(f, "PASS", { role: "security", nonce: "d".repeat(32) });
    assert.equal(evaluationReviewStatus(f.state, f.pr).pass, true);
  });
  test("edited or replayed critic evidence cannot reuse an earlier acknowledgment", () => {
    const f = fixture(); const result = review(f, "PASS");
    assert.equal(evaluationReviewStatus(f.state, f.pr).pass, true);
    assert.equal(evaluationReviewStatus(f.state, f.pr, { corpusDigest: "f".repeat(64) }).pass, false,
      "a head-bound PASS does not cover a changed admission corpus");
    result.body += "\nChanged claim";
    assert.equal(evaluationReviewStatus(f.state, f.pr).pass, false);
    result.updatedAt = "2026-09-05T10:02:00Z";
    assert.ok(evaluationReviewStatus(f.state, f.pr).results.some((r) => r.invalidReason === "edited_result"));
  });
  test("evaluation cannot trust a critic without its protected reservation and lead launch attestation", () => {
    const f = fixture(); review(f, "PASS");
    f.pr.comments.shift();
    assert.equal(evaluationReviewStatus(f.state, f.pr).pass, false);
    assert.equal(evaluationReviewStatus(f.state, f.pr).state, "launch_attestation_missing");
  });
  test("admission totals are derived and changed/missing packets remain unresolved", () => {
    const f = fixture(); const digest = "0".repeat(64);
    f.state.admissions = [{ assignment: "source-map", packet_digest: digest, decision: "accepted" }];
    const admitted = evaluationAdmissionTotals(f.state, [{ assignment: "source-map", digest, ok: true, collected: true }]);
    assert.equal(admitted.totals.accepted, 1);
    assert.equal(evaluationAdmissionTotals(f.state, []).totals.unresolved, 1);
    assert.equal(evaluationAdmissionTotals(f.state, [{ assignment: "source-map", digest: "1".repeat(64), ok: true }]).totals.accepted, 0);
    assert.equal(evaluationAdmissionTotals(f.state, [{ assignment: "source-map", digest, ok: false }]).totals.accepted, 0);
  });
  test("sealing requires adjudicated corpus and all acknowledged current-head PASS verdicts", () => {
    const f = fixture(); const digest = "0".repeat(64);
    f.state.admissions = [{ assignment: "source-map", packet_digest: digest, decision: "accepted" }];
    const admitted = evaluationAdmissionTotals(f.state, [{ assignment: "source-map", digest, ok: true }]);
    assert.throws(() => sealEvaluationPayload(f.state, f.pr, admitted, evaluationReviewStatus(f.state, f.pr)), /seal requires/);
    review(f, "PASS");
    const payload = sealEvaluationPayload(f.state, f.pr, admitted, evaluationReviewStatus(f.state, f.pr));
    assert.equal(payload.evidence_head, HEAD); assert.equal(payload.source_sha, SOURCE);
    const seal = comment(f.pr, evaluationAttestation("seal", payload));
    assert.equal(findEvaluationAttestation(f.pr.comments, "seal", payload, "lead", f.pr.url), seal);
    assert.equal(findEvaluationAttestation(f.pr.comments, "seal", { ...payload, evidence_head: "d".repeat(40) }, "lead", f.pr.url), null);
    assert.equal(findEvaluationAttestation(f.pr.comments, "seal", payload, "worker", f.pr.url), null);
    seal.updatedAt = "2026-09-05T10:02:00Z";
    assert.equal(findEvaluationAttestation(f.pr.comments, "seal", payload, "lead", f.pr.url), null);
  });
}
