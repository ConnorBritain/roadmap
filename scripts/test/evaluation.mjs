import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { stringify, parse } from "yaml";
import { validateEvaluationPacket, packetDigest } from "../lib/evaluation-packet.mjs";
import { inspectEvaluationPatch } from "../lib/evaluation-io.mjs";
import { buildEvaluationRun, assertEvaluationDiffPaths, sealableWave } from "../lib/evaluation-core.mjs";
import { runEvaluation } from "../evaluate.mjs";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const assignment = { id: "packet-one", wave: "wave-one", prompt: "Inspect a source file" };
function fixture(sha = "a".repeat(40)) {
  const run = buildEvaluationRun({ runId: "test-evidence", baseSha: sha, environmentId: "env-not-used", assignments: [assignment] });
  const data = { version: 1, packet: { run_id: run.run_id, assignment: assignment.id, base_sha: sha,
    captured_at: "2026-09-05T10:00:00Z", artifacts: [] },
  evidence: [{ id: "E1", type: "source_code", claim: "The fixture exports a constant", boundary: "source",
    captured_at: "2026-09-05T10:00:00Z", limitations: [], references: [{ path: "src/example.js", sha }] }] };
  return { run, data, files: { "REPORT.md": "# Inspection\nThe source exports a constant. [[evidence:E1]]\n", "evidence.yaml": stringify(data) } };
}
function validate({ run, data, files }, options = {}) {
  return validateEvaluationPacket({ run, assignment, files: { ...files, "evidence.yaml": stringify(data) }, now: NOW,
    source: () => ({ mode: "100644", type: "blob", line_count: 1 }), ...options });
}
function code(result, wanted) { assert.equal(result.ok, false); assert.ok(result.errors.some((e) => e.code === wanted), JSON.stringify(result.errors)); }

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return r.stdout;
}
async function repository() {
  const root = mkdtempSync(join(tmpdir(), "roadmap-admission-test-"));
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true }); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), stringify({ meta: { schema_version: 1, program: "test",
    dispatch: { providers: { codex: { environment_id: "env-not-used" } } } }, pis: [] }));
  writeFileSync(join(root, "src", "example.js"), "export const example = 1;\n");
  writeFileSync(join(root, "assignments.yaml"), stringify([assignment]));
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "fixture@example.test"]); git(root, ["config", "user.name", "Fixture"]);
  git(root, ["add", "."]); git(root, ["commit", "-qm", "source"]);
  const sha = git(root, ["rev-parse", "HEAD"]).trim();
  const f = fixture(sha);
  await runEvaluation(root, ["init", "--run", f.run.run_id, "--base-sha", sha, "--assignments", join(root, "assignments.yaml")]);
  const dir = `${f.run.artifact_root}/${f.run.run_id}`;
  const manifestPath = join(root, dir, "RUN.yaml");
  const manifest = parse(readFileSync(manifestPath, "utf8"));
  manifest.assignments[0].receipt = { external_id: "task-fixture", provider: "codex" };
  writeFileSync(manifestPath, stringify(manifest));
  git(root, ["add", "."]); git(root, ["commit", "-qm", "run"]);
  const packetDir = `${dir}/inbox/${assignment.id}`;
  const patch = (files) => Object.entries(files).map(([name, content]) => {
    const path = `${packetDir}/${name}`;
    const lines = content.replace(/\n$/, "").split("\n");
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => "+" + line).join("\n")}\n`;
  }).join("");
  return { root, f, manifestPath, packetDir, patch };
}

export { repository as evaluationRepositoryFixture };

export function registerEvaluationTests(test) {
  test("evidence admission accepts source-backed identity and linked claims without asserting truth", () => {
    const f = fixture(); const result = validate(f);
    assert.equal(result.ok, true); assert.equal(result.counts.records, 1);
    assert.equal(result.digest, packetDigest(f.files));
  });
  for (const [name, mutate, expected] of [
    ["wrong SHA", (f) => { f.data.packet.base_sha = "b".repeat(40); }, "identity_mismatch"],
    ["wrong assignment", (f) => { f.data.packet.assignment = "someone-else"; }, "identity_mismatch"],
    ["duplicate IDs", (f) => { f.data.evidence.push(structuredClone(f.data.evidence[0])); }, "duplicate_evidence_id"],
    ["unsupported version", (f) => { f.data.version = 9; }, "unsupported_packet_version"],
    ["invented future capture", (f) => { f.data.evidence[0].captured_at = "2099-01-01T00:00:00Z"; }, "invalid_timestamp"],
    ["missing limitations", (f) => { delete f.data.evidence[0].limitations; }, "limitations_required"],
    ["missing references", (f) => { f.data.evidence[0].references = []; }, "references_required"],
    ["missing report", (f) => { delete f.files["REPORT.md"]; }, "required_file_missing"],
    ["unlinked record", (f) => { f.files["REPORT.md"] = "No citations"; }, "uncited_evidence"],
    ["invented citation", (f) => { f.files["REPORT.md"] += " [[evidence:UNKNOWN]]"; }, "unknown_report_evidence_id"],
    ["extra artifact", (f) => { f.files["anything.txt"] = "not declared"; }, "undeclared_artifact"],
    ["missing attachment", (f) => { f.data.packet.artifacts = ["evidence/missing.txt"]; }, "declared_artifact_missing"],
    ["source traversal", (f) => { f.data.evidence[0].references[0].path = "../secret"; }, "invalid_source_identity"],
    ["unapproved live evidence", (f) => { f.data.evidence[0].boundary = "deployed"; }, "deployed_evidence_not_allowed"],
    ["invented rendering", (f) => { f.data.evidence[0].type = "rendered_ui"; }, "rendered_evidence_requires_image"],
    ["test lacks result", (f) => { f.data.evidence[0].type = "test"; }, "test_execution_record_required"],
  ]) test(`evidence admission refuses ${name}`, () => { const f = fixture(); mutate(f); code(validate(f), expected); });
  test("evidence YAML duplicate keys and aliases fail without echoing content", () => {
    const f = fixture();
    for (const yaml of ["version: 1\nversion: 2\n", "packet: &a {x: 1}\nevidence: [*a]\n"]) {
      const result = validateEvaluationPacket({ run: f.run, assignment, files: { ...f.files, "evidence.yaml": yaml } });
      code(result, "invalid_yaml");
    }
  });
  test("evidence admission reports secret detection without exposing credential values", () => {
    const f = fixture(); const secret = "ghp_" + "x".repeat(40);
    f.files["REPORT.md"] += secret; f.data.evidence[0].claim += secret;
    const result = validate(f);
    code(result, "prohibited_data"); assert.ok(!JSON.stringify(result).includes(secret));
  });
  test("obvious structured patient-data fixtures are rejected without echoing values", () => {
    const f = fixture();
    const record = JSON.stringify({ patient_name: "SYNTHETIC PERSON", medical_record_number: "SYNTHETIC-00001" });
    f.files["REPORT.md"] += record;
    const result = validate(f); code(result, "prohibited_data");
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC PERSON"));
  });
  test("unquoted YAML patient fields fail admission without echoing values", () => {
    for (const record of ["patient_name: SYNTHETIC PERSON", "medical_record_number: SYNTHETIC-00001", "patient_email: synthetic@example.test"]) {
      const f = fixture(); f.files["REPORT.md"] += "\n" + record + "\n";
      const result = validate(f); code(result, "prohibited_data");
      assert.ok(!JSON.stringify(result).includes(record));
    }
  });
  test("evidence source must be a regular frozen-tree file with valid line bounds", () => {
    for (const found of [null, { type: "tree", mode: "040000" }, { type: "blob", mode: "120000" }]) {
      code(validate(fixture(), { source: () => found }), "source_not_regular_file_at_baseline");
    }
    const f = fixture(); Object.assign(f.data.evidence[0].references[0], { line_start: 1, line_end: 20 });
    code(validate(f), "invalid_source_range");
  });
  test("evidence test status distinguishes unexecuted checks from successful execution", () => {
    const f = fixture(); f.data.evidence[0].type = "test";
    f.data.evidence[0].test = { command: "npm test", status: "not_run", result: "Dependencies unavailable" };
    assert.ok(validate(f).ok);
    f.data.evidence[0].test.exit_code = 0; code(validate(f), "unexecuted_test_has_exit_code");
    f.data.evidence[0].test.status = "failed"; code(validate(f), "test_exit_code_mismatch");
  });
  test("evaluation patch paths reject traversal, malformed headers, symlinks and executable modes", () => {
    for (const diff of [
      "diff --git a/docs/audits/dimensional-coherence-matrix/test-evidence/inbox/packet-one/../../escape b/docs/audits/dimensional-coherence-matrix/test-evidence/inbox/packet-one/../../escape",
      "diff --git \"a/quoted\" \"b/quoted\"",
      "diff --git a/x b/x\nnew file mode 120000",
    ]) assert.throws(() => assertEvaluationDiffPaths({ runId: "test-evidence", assignmentId: "packet-one", diff }));
  });
  test("evaluation collection preview is read-only and applies exactly its validated patch", async () => {
    const r = await repository();
    try {
      const before = readFileSync(r.manifestPath, "utf8"); const diff = r.patch(r.f.files);
      const options = { cloudDiff: () => diff };
      const args = ["collect", "--run", r.f.run.run_id, "--assignment", assignment.id];
      const preview = await runEvaluation(r.root, args, options);
      assert.ok(preview.ok); assert.equal(preview.applied, false);
      assert.equal(readFileSync(r.manifestPath, "utf8"), before);
      assert.equal(existsSync(join(r.root, r.packetDir, "REPORT.md")), false);
      const applied = await runEvaluation(r.root, [...args, "--apply"], options);
      assert.ok(applied.ok && applied.applied);
      assert.equal(applied.digest, preview.digest);
      const manifest = parse(readFileSync(r.manifestPath, "utf8"));
      assert.equal(manifest.assignments[0].collection.packet_digest, preview.digest);
      assert.equal(manifest.assignments[0].admission, null);
      const after = readFileSync(r.manifestPath, "utf8");
      const check = await runEvaluation(r.root, ["validate", "--run", r.f.run.run_id, "--assignment", assignment.id]);
      assert.ok(check.ok); assert.equal(readFileSync(r.manifestPath, "utf8"), after);
      assert.throws(() => sealableWave(manifest, "wave-one"), /unaccepted/);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("invalid cloud packet cannot change files or mark collection successful", async () => {
    const r = await repository();
    try {
      const before = readFileSync(r.manifestPath, "utf8");
      const result = await runEvaluation(r.root, ["collect", "--run", r.f.run.run_id, "--assignment", assignment.id, "--apply"],
        { cloudDiff: () => r.patch({ "anything.txt": "nothing\n" }) });
      assert.equal(result.ok, false); assert.equal(result.applied, false);
      assert.equal(readFileSync(r.manifestPath, "utf8"), before);
      assert.equal(existsSync(join(r.root, r.packetDir, "anything.txt")), false);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("collection rejects local conflicts and symlink ancestors without changing the manifest", async () => {
    const r = await repository();
    try {
      mkdirSync(join(r.root, r.packetDir), { recursive: true });
      writeFileSync(join(r.root, r.packetDir, "REPORT.md"), "user work");
      assert.throws(() => inspectEvaluationPatch(r.root, { run: r.f.run, assignment, diff: r.patch(r.f.files) }), /local changes/);
      rmSync(join(r.root, r.packetDir), { recursive: true });
      symlinkSync(join(r.root, "src"), join(r.root, r.packetDir), "dir");
      assert.throws(() => inspectEvaluationPatch(r.root, { run: r.f.run, assignment, diff: r.patch(r.f.files) }), /symbolic-link/);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("evaluation migration preserves original bytes and never carries forward historical sealing", async () => {
    const r = await repository();
    try {
      const old = parse(readFileSync(r.manifestPath, "utf8")); old.version = 2; old.sealed_waves = ["wave-one"];
      old.assignments[0].collected_at = "2026-08-16T00:00:00Z";
      const original = "# historical record\n" + stringify(old); writeFileSync(r.manifestPath, original);
      const preview = await runEvaluation(r.root, ["migrate", "--run", old.run_id]);
      assert.equal(preview.applied, false); assert.equal(readFileSync(r.manifestPath, "utf8"), original);
      const result = await runEvaluation(r.root, ["migrate", "--run", old.run_id, "--confirm"]);
      assert.equal(readFileSync(result.backup, "utf8"), original);
      const migrated = parse(readFileSync(r.manifestPath, "utf8"));
      assert.deepEqual(migrated.sealed_waves, []); assert.equal(migrated.assignments[0].collected_at, null);
      assert.equal(migrated.assignments[0].receipt.external_id, "task-fixture");
      assert.throws(() => sealableWave(migrated, "wave-one"), /unaccepted/);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
  test("legacy and merely collected evaluations never satisfy sealing", () => {
    const f = fixture(); f.run.assignments[0].collected_at = new Date().toISOString();
    assert.throws(() => sealableWave(f.run, "wave-one"), /unaccepted/);
    f.run.version = 2; assert.throws(() => sealableWave(f.run, "wave-one"), /legacy/);
  });
}
