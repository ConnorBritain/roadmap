import assert from "node:assert/strict";
import { recordLeadDecision, decisionReport, recordDecisionForPr } from "../lib/gauntlet-decisions.mjs";
import { authorizationFixture, memoryAuthorityStore } from "./authorization.mjs";
import { assertAuthorizationTransition } from "../lib/gauntlet-authorization.mjs";
import { authorizationReport } from "../lib/gauntlet-portfolio.mjs";

const NOW = "2026-09-05T10:01:00Z", HEAD = "b".repeat(40);
const input = () => ({ version: 1, id: "F1", kind: "finding", outcome: "accepted", head: HEAD,
  reference_url: "https://github.com/owner/repo/pull/42#issuecomment-1", reference_digest: "c".repeat(64), reason: "Inspected material source evidence" });
const opts = { actor: "lead", confirm: true, now: NOW };

export function registerDecisionTests(test) {
  test("lead decision corrections preserve history, deduplicate retries and do not authorize execution", () => {
    const initial = authorizationFixture(), accepted = recordLeadDecision(initial, input(), opts);
    assertAuthorizationTransition(initial, accepted);
    assert.strictEqual(recordLeadDecision(accepted, input(), opts), accepted);
    assert.throws(() => recordLeadDecision(accepted, { ...input(), outcome: "rejected" }, opts), /supersede/);
    const corrected = recordLeadDecision(accepted, { ...input(), outcome: "rejected", reason: "Inspected counterevidence; original claim overstates coverage",
      supersedes: accepted.events[0].fingerprint }, opts);
    assertAuthorizationTransition(accepted, corrected);
    assert.equal(corrected.events.length, 2); assert.equal(corrected.events[0].decision.outcome, "accepted");
    const report = decisionReport(corrected);
    assert.equal(report.accepted_findings, 0); assert.equal(report.rejected_findings, 1);
    assert.equal(report.coverage, "recorded_decisions_only"); assert.equal(corrected.reservations.length, 0);
    assert.equal(corrected.admissions, undefined); assert.equal(corrected.seals, undefined);
    const summary = authorizationReport(corrected);
    assert.equal(summary.rejected_findings, 1); assert.equal(summary.regressions, null);
    assert.equal(summary.monetary_usage.amount, null);
  });
  test("decision records require correct actor, inspection, safe data and typed outcomes", () => {
    const state = authorizationFixture();
    for (const bad of [{ ...opts, actor: "worker" }, { ...opts, confirm: false }]) assert.throws(() => recordLeadDecision(state, input(), bad), /inspection/);
    for (const changed of [{ outcome: "PASS" }, { head: "main" }, { reference_url: "https://example.test/claim" },
      { reason: "Authorization: Bearer ghp_" + "a".repeat(36) }]) assert.throws(() => recordLeadDecision(state, { ...input(), ...changed }, opts));
    const regression = recordLeadDecision(state, { ...input(), kind: "regression", outcome: "observed", id: "R1" }, opts);
    const intervention = recordLeadDecision(regression, { ...input(), kind: "human_intervention", outcome: "occurred", id: "H1" }, opts);
    assert.equal(decisionReport(intervention).regressions, 1); assert.equal(decisionReport(intervention).human_interventions, 1);
  });
  test("decision IO binds actual immutable comment bytes and fails closed on moved heads or edited references", async () => {
    const store = memoryAuthorityStore(authorizationFixture());
    const comment = { url: input().reference_url, body: "Actual inspected evidence", createdAt: NOW, updatedAt: NOW };
    const pr = { number: 42, url: "https://github.com/owner/repo/pull/42", currentHead: HEAD, state: "OPEN", comments: [comment] };
    const github = { viewerLogin: () => "lead", getPr: () => structuredClone(pr) };
    const args = { store, runId: "authorized-fixture", github, prNumber: 42, expectedHead: HEAD, input: input(), confirm: true, now: NOW };
    const result = await recordDecisionForPr(args);
    assert.equal(result.reporting_only, true);
    assert.notEqual(result.report.records[0].decision.reference_digest, input().reference_digest, "caller cannot invent source-comment digest");
    comment.body = "Changed after first inspection"; comment.updatedAt = "2026-09-05T11:01:00Z";
    await assert.rejects(() => recordDecisionForPr(args), /immutable/);
    comment.updatedAt = NOW; pr.currentHead = "d".repeat(40);
    await assert.rejects(() => recordDecisionForPr(args), /exact current/);
    assert.equal((await store.read()).state.events.length, 1);
  });
}
