import assert from "node:assert/strict";
import { rmSync, unlinkSync, existsSync } from "node:fs";
import { authorizationFixture, memoryAuthorityStore } from "./authorization.mjs";
import { evaluationRepositoryFixture } from "./evaluation.mjs";
import { evaluationScopeSnapshot } from "../lib/evaluation-core.mjs";
import { authorizationDigest } from "../lib/gauntlet-authorization.mjs";
import { runGauntletPortfolio, authorizationReport, evaluationSafeActions } from "../lib/gauntlet-portfolio.mjs";

export function registerPortfolioTests(test) {
  test("portfolio recovers protected evaluation identity without writing a missing local manifest", async () => {
    const r = await evaluationRepositoryFixture();
    try {
      const state = authorizationFixture(evaluationScopeSnapshot(r.f.run));
      state.authorization.run_id = r.f.run.run_id; state.authorization.source_sha = r.f.run.base_sha;
      state.authorization_digest = authorizationDigest(state.authorization);
      const store = memoryAuthorityStore(state);
      store.list = async () => ({ snapshots: [await store.read()], failures: [] });
      unlinkSync(r.manifestPath);
      const status = await runGauntletPortfolio(r.root, { authorityStore: store, github: { listGauntletPrs: () => ({ prs: [] }) } });
      assert.equal(status.read_only, true); assert.equal(status.observation_complete, true);
      assert.equal(status.runs.length, 1); assert.equal(status.runs[0].run_id, r.f.run.run_id);
      assert.equal(status.runs[0].local_recovery_needed, true);
      assert.equal(status.runs[0].limits.submissions_used, 0);
      assert.equal(existsSync(r.manifestPath), false);
      store.list = async () => { throw new Error("offline"); };
      const failed = await runGauntletPortfolio(r.root, { authorityStore: store, github: { listGauntletPrs: () => ({ prs: [], possibly_truncated: true }) } });
      assert.equal(failed.observation_complete, false); assert.equal(failed.discovery_failures.length, 2);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("portfolio reports unknown costs and counters honestly and never recommends expired launches", () => {
    const report = authorizationReport(authorizationFixture(), { now: Date.parse("2026-09-05T10:01:00Z") });
    assert.equal(report.elapsed_seconds, 60); assert.equal(report.monetary_usage.amount, null);
    assert.equal(report.rejected_findings, null); assert.equal(report.regressions, null);
    const actions = evaluationSafeActions({ authority_status: "protected", limits: { ambiguous: [], launch_window_open: false,
      submissions_remaining: 4, concurrency_remaining: 2, repairs_remaining: 1 }, corpus: { totals: { unresolved: 0 } }, review: { state: "awaiting_critic" } });
    assert.ok(!actions.includes("launch_next_required_critic")); assert.ok(actions.includes("no_new_launches_without_new_authority"));
    assert.deepEqual(evaluationSafeActions({ authority_status: "observation_failed" }), ["restore_authority_observation"]);
  });
}
