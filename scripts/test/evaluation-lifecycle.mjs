import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { runEvaluation } from "../evaluate.mjs";
import { evaluationScopeSnapshot } from "../lib/evaluation-core.mjs";
import { authorizationFixture, memoryAuthorityStore, continuationFixtureReceipt } from "./authorization.mjs";
import { authorizationDigest } from "../lib/gauntlet-authorization.mjs";
import { evaluationReviewRun } from "../lib/evaluation-review-core.mjs";
import { renderCriticMarker } from "../lib/gauntlet-core.mjs";
import { evaluationRepositoryFixture } from "./evaluation.mjs";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function fixture() {
  const r = await evaluationRepositoryFixture();
  const collected = await runEvaluation(r.root, ["collect", "--run", r.f.run.run_id, "--assignment", "packet-one", "--apply"], { cloudDiff: () => r.patch(r.f.files) });
  git(r.root, ["add", "."]); git(r.root, ["commit", "-qm", "collected packet"]);
  const manifest = parse(readFileSync(r.manifestPath, "utf8"));
  const state = authorizationFixture(evaluationScopeSnapshot(manifest));
  state.authorization.run_id = manifest.run_id; state.authorization.source_sha = manifest.base_sha;
  state.authorization_digest = authorizationDigest(state.authorization);
  const store = memoryAuthorityStore(state);
  const pr = { number: 42, url: "https://github.com/owner/repo/pull/42", baseRefName: "main", state: "OPEN", checks: "none",
    currentHead: git(r.root, ["rev-parse", "HEAD"]), comments: [], commits: [] };
  const github = { viewerLogin: () => "lead", isAncestor: () => true, getPr: () => structuredClone(pr),
    addComment(number, body) {
      assert.equal(number, 42);
      const at = new Date().toISOString();
      pr.comments.push({ body, author: "lead", url: `${pr.url}#issuecomment-${pr.comments.length + 1}`,
        createdAt: at, updatedAt: at }); return true;
    } };
  const prompts = [];
  const opts = { authorityStore: store, github, now: "2026-09-05T10:00:00Z", diagnoseCloud: () => ({ ok: true }),
    launchCloud: ({ prompt }) => { prompts.push(prompt); return { provider: "codex", external_id: `task_${prompts.length}`,
      external_url: `https://chatgpt.com/codex/tasks/task_${prompts.length}` }; },
    observeCloud: ({ taskId }) => ({ external_id: taskId, status: "completed" }) };
  const action = (name, ...args) => runEvaluation(r.root, [name, "--run", manifest.run_id, "--expected-head", pr.currentHead, ...args], opts);
  return { ...r, manifest, state, collected, store, pr, github, prompts, opts, action };
}

export function registerEvaluationLifecycleTests(test) {
  test("strict unsupported evaluator settings fail before reserving or submitting", async () => {
    const r = await fixture();
    try {
      const state = structuredClone(r.state); state.authorization.model_preferences.cloud.strict = true;
      state.authorization_digest = authorizationDigest(state.authorization);
      const store = memoryAuthorityStore(state); r.opts.authorityStore = store;
      await assert.rejects(() => r.action("launch", "--wave", "wave-one"), /cannot enforce strict/);
      assert.equal((await store.read()).state.reservations.length, 0); assert.equal(r.prompts.length, 0);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  for (const ambiguous of [false, true]) test(`authorized evaluator ${ambiguous ? "ambiguous response" : "receipt"} survives manifest loss without another submission`, async () => {
    const r = await evaluationRepositoryFixture();
    try {
      const manifest = parse(readFileSync(r.manifestPath, "utf8")); manifest.assignments[0].receipt = null;
      writeFileSync(r.manifestPath, stringify(manifest));
      const policy = authorizationFixture().authorization;
      const policyFile = join(r.root, "policy.yaml"); writeFileSync(policyFile, stringify(policy));
      const store = memoryAuthorityStore(null); let submissions = 0;
      const opts = { authorityStore: store, github: { viewerLogin: () => "lead" }, now: "2026-09-05T10:00:00Z",
        diagnoseCloud: () => ({ ok: true }), launchCloud: () => {
          submissions++;
          if (ambiguous) throw new Error("provider may have accepted, response lost");
          return { provider: "codex", external_id: "task_exact", external_url: "https://chatgpt.com/codex/tasks/task_exact" };
        } };
      const action = (name, ...args) => runEvaluation(r.root, [name, "--run", manifest.run_id, ...args], opts);
      await action("authorize", "--authorization", policyFile, "--confirm");
      const handoff = await action("launch", "--wave", "wave-one");
      assert.equal(handoff.state, "awaiting_continuation"); assert.equal(submissions, 0);
      opts.continuationRecord = continuationFixtureReceipt();
      await action("continuation", "--confirm");
      if (ambiguous) await assert.rejects(() => action("launch", "--wave", "wave-one"), /unresolved/);
      else await action("launch", "--wave", "wave-one");
      assert.equal(submissions, 1);
      unlinkSync(r.manifestPath);
      assert.equal((await action("recover")).applied, false); assert.equal(existsSync(r.manifestPath), false);
      const recovered = await action("recover", "--confirm");
      assert.equal(recovered.limits.submissions_used, 1);
      assert.equal(recovered.limits.active, 1);
      const repeated = await action("launch", "--wave", "wave-one");
      assert.equal(repeated.launched[0].skipped, true); assert.equal(submissions, 1);
      await assert.rejects(() => action("recover", "--confirm"), /will not overwrite/);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("changed admission at the same head requires a fresh budgeted critic and cannot reuse the previous PASS", async () => {
    const r = await fixture();
    try {
      await r.action("attach", "--pr", "42", "--confirm");
      await r.action("accept", "--assignment", "packet-one", "--packet-digest", r.collected.digest,
        "--reason", "Inspected initial fixture", "--redaction-inspected", "--confirm");
      const head = r.pr.currentHead;
      await r.action("critic");
      const nonce = /\nnonce=([a-f0-9]{32})\n/.exec(r.prompts[0])[1];
      await r.github.addComment(42, renderCriticMarker({ run: evaluationReviewRun((await r.store.read()).state),
        round: 1, nonce, head, verdict: "PASS" }) + "\nInspected initial fixture corpus.");
      const pass = r.pr.comments.at(-1); pass.author = "independent-critic";
      await r.action("ack", "--comment-url", pass.url, "--confirm");
      await r.action("observe");
      await r.action("accept", "--assignment", "packet-one", "--packet-digest", r.collected.digest,
        "--decision", "rejected", "--reason", "Lead inspection found insufficient support", "--redaction-inspected", "--confirm");
      assert.equal(r.pr.currentHead, head);
      await assert.rejects(() => r.action("seal", "--confirm"), /seal requires/);
      const fresh = await r.action("critic");
      assert.equal(fresh.receipt.external_id, "task_2");
      const reservations = (await r.store.read()).state.reservations;
      assert.equal(reservations.length, 2);
      assert.notEqual(reservations[0].key, reservations[1].key);
      assert.notEqual(reservations[0].request.corpus_digest, reservations[1].request.corpus_digest);
      await assert.rejects(() => r.action("critic"), /not the next/);
      await assert.rejects(() => r.action("seal", "--confirm"), /seal requires/);
      const freshNonce = /\nnonce=([a-f0-9]{32})\n/.exec(r.prompts[1])[1];
      await r.github.addComment(42, renderCriticMarker({ run: evaluationReviewRun((await r.store.read()).state),
        round: 1, nonce: freshNonce, head, verdict: "PASS" }) + "\nInspected changed corpus; rejected packet is not accepted evidence.");
      const freshPass = r.pr.comments.at(-1); freshPass.author = "independent-critic";
      await assert.rejects(() => r.action("seal", "--confirm"), /seal requires/);
      await r.action("ack", "--comment-url", freshPass.url, "--confirm");
      assert.equal((await r.action("seal", "--confirm")).sealed, true);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("evaluation REVISE -> inspected ack -> exact-path cloud repair -> re-admission -> fresh PASS", async () => {
    const r = await fixture();
    try {
      await r.action("attach", "--pr", "42", "--confirm");
      await r.action("accept", "--assignment", "packet-one", "--packet-digest", r.collected.digest,
        "--reason", "Inspected initial synthetic fixture", "--redaction-inspected", "--confirm");
      await r.action("critic");
      const postVerdict = async (verdict, round, promptIndex) => {
        const state = (await r.store.read()).state;
        const nonce = /\nnonce=([a-f0-9]{32})\n/.exec(r.prompts[promptIndex])[1];
        r.github.addComment(42, renderCriticMarker({ run: evaluationReviewRun(state), round, nonce, head: r.pr.currentHead, verdict })
          + "\nSynthetic documentation fixture: explicitly state the source-only limitation in the report.");
        const candidate = r.pr.comments.at(-1); candidate.author = "independent-critic";
        return candidate;
      };
      const revise = await postVerdict("REVISE", 1, 0);
      const reportPath = `${r.packetDir}/REPORT.md`;
      const repairPacket = { version: 1, expected_head: r.pr.currentHead, findings: [{ id: "F1", critic_comment_url: revise.url,
        description: "Add the missing source-only limitation to this labelled synthetic fixture.", paths: [reportPath] }],
      instructions: "Append the explicit limitation; do not change the claim or product source." };
      const packetFile = join(r.root, "repair-request.json"); writeFileSync(packetFile, JSON.stringify(repairPacket));
      await assert.rejects(() => r.action("repair", "--packet", packetFile), /acknowledged current-head/);
      await r.action("ack", "--comment-url", revise.url, "--confirm");
      await r.action("observe");
      const repair = await r.action("repair", "--packet", packetFile);
      assert.equal(r.prompts.length, 2);
      assert.ok(r.prompts[1].includes("Do not push, open a PR"));
      await assert.rejects(() => r.action("repair", "--packet", packetFile), /already reserved/);
      const reportFile = join(r.root, reportPath), original = readFileSync(reportFile, "utf8");
      writeFileSync(reportFile, original + "\nSynthetic fixture limitation: source inspection does not establish deployed behavior.\n");
      const diff = git(r.root, ["diff", "--", reportPath]) + "\n"; writeFileSync(reportFile, original);
      r.opts.cloudDiff = () => diff;
      const before = readFileSync(r.manifestPath, "utf8");
      const preview = await r.action("collect-repair", "--launch-key", repair.launch_key);
      assert.equal(preview.applied, false); assert.equal(readFileSync(r.manifestPath, "utf8"), before);
      const applied = await r.action("collect-repair", "--launch-key", repair.launch_key, "--apply");
      assert.equal(applied.applied, true); assert.notEqual(applied.packets[0].digest, r.collected.digest);
      git(r.root, ["add", r.manifest.artifact_root]); git(r.root, ["commit", "-qm", "repair synthetic documentation fixture"]);
      r.pr.currentHead = git(r.root, ["rev-parse", "HEAD"]);
      await assert.rejects(() => r.action("critic"), /adjudicate/);
      await r.action("accept", "--assignment", "packet-one", "--packet-digest", applied.packets[0].digest,
        "--reason", "Inspected corrected fixture and source-only limitation", "--redaction-inspected", "--confirm");
      await r.action("observe");
      await r.action("critic");
      const pass = await postVerdict("PASS", 2, 2);
      await r.action("ack", "--comment-url", pass.url, "--confirm");
      assert.equal((await r.action("seal", "--confirm")).sealed, true);
      assert.equal((await r.action("status")).limits.submissions_used, 3);
      assert.equal((await r.store.read()).state.admissions.length, 2);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("evaluation CLI actions require inspected digest admission, independent review, acknowledgment and current-head sealing", async () => {
    const r = await fixture();
    try {
      await r.action("attach", "--pr", "42", "--confirm");
      await assert.rejects(() => r.action("critic"), /adjudicate/);
      await assert.rejects(() => r.action("accept", "--assignment", "packet-one", "--packet-digest", r.collected.digest,
        "--reason", "Inspected fixture", "--confirm"), /inspection/);
      const accepted = await r.action("accept", "--assignment", "packet-one", "--packet-digest", r.collected.digest,
        "--reason", "Checked frozen source and report; inspected redaction.", "--redaction-inspected", "--confirm");
      assert.equal(accepted.corpus.totals.accepted, 1);
      const critic = await r.action("critic"); assert.equal(critic.receipt.external_id, "task_1");
      assert.equal(r.prompts.length, 1);
      await assert.rejects(() => r.action("critic"), /not the next/);
      await assert.rejects(() => r.action("seal", "--confirm"), /seal requires/);
      const state = (await r.store.read()).state;
      const nonce = /\nnonce=([a-f0-9]{32})\n/.exec(r.prompts[0])[1];
      const body = renderCriticMarker({ run: evaluationReviewRun(state), round: 1, nonce, head: r.pr.currentHead, verdict: "PASS" }) + "\nInspected the source, packet and limitations.";
      r.github.addComment(42, body);
      const candidate = r.pr.comments.at(-1); candidate.author = "independent-critic";
      await assert.rejects(() => r.action("seal", "--confirm"), /seal requires/);
      await r.action("ack", "--comment-url", candidate.url, "--confirm");
      const beforeSeal = git(r.root, ["rev-parse", "HEAD"]);
      const seal = await r.action("seal", "--confirm");
      assert.equal(seal.sealed, true); assert.equal(seal.evidence_head, beforeSeal);
      assert.equal(git(r.root, ["rev-parse", "HEAD"]), beforeSeal);
      const status = await r.action("status"); assert.equal(status.review.sealed, true);
      // Cloud completion frees concurrency only after durable observation;
      // status itself is read-only and cannot replenish submission budget.
      assert.equal(status.limits.active, 1);
      await r.action("observe");
      assert.equal((await r.action("status")).limits.active, 0);
      assert.equal((await r.action("status")).limits.submissions_used, 1);
      writeFileSync(join(r.root, r.manifest.artifact_root, r.manifest.run_id, "NOTE.md"), "A later documentation revision.\n");
      git(r.root, ["add", "."]); git(r.root, ["commit", "-qm", "later corpus revision"]);
      r.pr.currentHead = git(r.root, ["rev-parse", "HEAD"]);
      assert.equal((await r.action("status")).review.sealed, false);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("evaluation acceptance cannot bless changed digests, product changes or a competing PR", async () => {
    const r = await fixture();
    try {
      await r.action("attach", "--pr", "42", "--confirm");
      await assert.rejects(() => r.action("accept", "--assignment", "packet-one", "--packet-digest", "0".repeat(64),
        "--reason", "Inspected", "--redaction-inspected", "--confirm"), /digest must match/);
      const other = { ...r.opts, github: { ...r.github, getPr: () => ({ ...structuredClone(r.pr), number: 43, url: "https://github.com/owner/repo/pull/43" }) } };
      await assert.rejects(() => runEvaluation(r.root, ["attach", "--run", r.manifest.run_id, "--pr", "43", "--expected-head", r.pr.currentHead, "--confirm"], other), /different evidence PR/);
      writeFileSync(join(r.root, "src/example.js"), "export const example = 2;\n");
      git(r.root, ["add", "."]); git(r.root, ["commit", "-qm", "forbidden product mutation"]);
      r.pr.currentHead = git(r.root, ["rev-parse", "HEAD"]);
      await assert.rejects(() => r.action("accept", "--assignment", "packet-one", "--packet-digest", r.collected.digest,
        "--reason", "Inspected", "--redaction-inspected", "--confirm"), /outside the authorized/);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
}
