#!/usr/bin/env node
// roadmap gauntlet eval — documentation-only Codex Cloud evaluation conductor.

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, parseDocument } from "yaml";
import { hostname } from "node:os";
import { loadGraph } from "./lib/graph.mjs";
import { diagnoseCodexCloud, launchCodexCloud, observeCodexCloudTask } from "./lib/cloud-agent-providers.mjs";
import {
  EVALUATION_ROOT, EVALUATION_VERSION, assignmentFor, assignmentsForWave,
  buildEvaluationPrompt, buildEvaluationRun, evaluationDirectory, normalizeAssignment,
  requiredArtifactRoot, requiredRunId, requiredSha, sealableWave,
} from "./lib/evaluation-core.mjs";
import { applyEvaluationPatch, inspectEvaluationPatch, inspectLocalEvaluationPacket, assertNoSymlinkAncestors, evaluationCommand } from "./lib/evaluation-io.mjs";

function value(args, name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] || null; }
function flag(args, name) { return args.includes(name); }
function configuredArtifactRoot(graph) {
  return requiredArtifactRoot(graph.meta?.dispatch?.evaluation?.artifact_root || EVALUATION_ROOT);
}
function runPath(root, runId, artifactRoot) {
  const path = `${evaluationDirectory(runId, artifactRoot)}/RUN.yaml`;
  assertNoSymlinkAncestors(root, path);
  return join(root, path);
}
function readRun(root, runId, artifactRoot) {
  const path = runPath(root, runId, artifactRoot);
  if (!existsSync(path)) throw new Error(`evaluation run manifest not found: ${path}`);
  const parsed = parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("evaluation RUN.yaml is invalid");
  requiredRunId(parsed.run_id); requiredSha(parsed.base_sha);
  const recordedRoot = requiredArtifactRoot(parsed.artifact_root || EVALUATION_ROOT);
  if (recordedRoot !== artifactRoot) throw new Error(`evaluation run artifact root changed from ${recordedRoot} to ${artifactRoot}; restore the original repository configuration before continuing`);
  if (!Array.isArray(parsed.assignments)) parsed.assignments = [];
  parsed.assignments = parsed.assignments.map(normalizeAssignment);
  return parsed;
}
function writeRun(root, run) {
  const path = runPath(root, run.run_id, run.artifact_root);
  mkdirSync(dirname(path), { recursive: true });
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "{}");
  if (doc.errors.length) throw new Error("invalid evaluation manifest; refusing write");
  for (const [key, val] of Object.entries(run)) doc.set(key, val);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try { writeFileSync(temporary, doc.toString(), { encoding: "utf8", flag: "wx" }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; } }
}

// The lock is per run and spans inspection/application/receipt updates. Never
// auto-delete a lock: recovery requires verifying the recorded owner is gone.
async function withRunLock(root, runId, artifactRoot, action) {
  const path = runPath(root, runId, artifactRoot);
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw new Error("evaluation mutation already in progress; inspect RUN.yaml.lock owner before explicit recovery"); throw e; }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
    return await action();
  } finally { closeSync(fd); unlinkSync(lock); }
}
function gitSha(root, sha) {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`base SHA ${sha} is not available locally; fetch it before initializing the evaluation`);
}
function loadAssignments(path) {
  const parsed = parse(readFileSync(resolve(path), "utf8"));
  const values = Array.isArray(parsed) ? parsed : parsed && parsed.assignments;
  if (!Array.isArray(values)) throw new Error("assignment file must be a YAML sequence or contain assignments:");
  return values.map(normalizeAssignment);
}
function run(command, args, root) {
  return evaluationCommand(root, command, args);
}

export async function runEvaluation(root, args, opts = {}) {
  args = [...args];
  const action = args.shift() || "status";
  const graph = loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  const artifactRoot = configuredArtifactRoot(graph);
  const runIdForLock = requiredRunId(value(args, "--run") || args.find((arg) => !arg.startsWith("-")));
  const mutating = ["init", "launch", "accept", "repair", "critic", "ack", "seal"].includes(action)
    || (action === "collect" && flag(args, "--apply")) || (action === "migrate" && flag(args, "--confirm"));
  if (mutating && !opts.locked) return withRunLock(root, runIdForLock, artifactRoot,
    () => runEvaluation(root, [action, ...args], { ...opts, locked: true }));
  if (action === "init") {
    const runId = requiredRunId(value(args, "--run"));
    const baseSha = requiredSha(value(args, "--base-sha"));
    gitSha(root, baseSha);
    const environmentId = value(args, "--environment-id") || graph.meta?.dispatch?.providers?.codex?.environment_id;
    const assignmentsFile = value(args, "--assignments");
    const manifest = buildEvaluationRun({ runId, baseSha, environmentId, title: value(args, "--title") || "Evidence evaluation",
      artifactRoot, assignments: assignmentsFile ? loadAssignments(assignmentsFile) : [] });
    if (existsSync(runPath(root, runId, artifactRoot))) throw new Error(`evaluation run already exists: ${runId}`);
    writeRun(root, manifest);
    const base = join(root, evaluationDirectory(runId, artifactRoot));
    mkdirSync(join(base, "inbox"), { recursive: true });
    writeFileSync(join(base, "README.md"), `# ${manifest.title}\n\nFrozen base: \`${baseSha}\`. This is a documentation-only evaluation corpus.\n`, "utf8");
    return { action, runId, path: evaluationDirectory(runId, artifactRoot), assignments: manifest.assignments.length };
  }
  const runId = requiredRunId(value(args, "--run") || args.find((arg) => !arg.startsWith("-")));
  const manifest = readRun(root, runId, artifactRoot);
  if (action === "migrate") {
    if (manifest.version === EVALUATION_VERSION) return { action, run_id: runId, migrated: false, reason: "already_current" };
    if (![1, 2].includes(manifest.version)) throw new Error("unsupported legacy evaluation version");
    const original = readFileSync(runPath(root, runId, artifactRoot), "utf8");
    if (!flag(args, "--confirm")) return { action, run_id: runId, from_version: manifest.version, to_version: EVALUATION_VERSION, applied: false };
    const backup = join(root, evaluationDirectory(runId, artifactRoot), `LEGACY_RUN.v${manifest.version}.yaml`);
    assertNoSymlinkAncestors(root, `${evaluationDirectory(runId, artifactRoot)}/LEGACY_RUN.v${manifest.version}.yaml`);
    if (existsSync(backup) && readFileSync(backup, "utf8") !== original) throw new Error("legacy migration backup already exists with different content; preserve it and inspect before retrying");
    if (!existsSync(backup)) writeFileSync(backup, original, { encoding: "utf8", flag: "wx" });
    manifest.legacy = { version: manifest.version, sealed_waves: manifest.sealed_waves || [], verification: "unverified" };
    manifest.version = EVALUATION_VERSION; manifest.state = "legacy_unverified"; manifest.sealed_waves = [];
    manifest.evidence_policy = { allow_deployed: false, public_hosts: [] };
    for (const assignment of manifest.assignments) {
      assignment.history = [...(assignment.history || []), { legacy: true, state: assignment.state, collected_at: assignment.collected_at,
        collection: assignment.collection || null, admission: assignment.admission || null }];
      assignment.state = "legacy_unverified"; assignment.collected_at = null;
      assignment.collection = null; assignment.admission = null;
    }
    writeRun(root, manifest);
    return { action, run_id: runId, migrated: true, verification: "unverified", backup };
  }
  if (action === "status") {
    const assignments = manifest.assignments.map((assignment) => ({ ...assignment, provider_status: assignment.receipt
      ? observeCodexCloudTask({ taskId: assignment.receipt.external_id, environmentId: manifest.environment_id })?.status || "not_found" : "not_launched" }));
    return { run_id: runId, base_sha: manifest.base_sha, version: manifest.version,
      verification: manifest.version === EVALUATION_VERSION ? "requires_admission" : "legacy_unverified", state: manifest.state, assignments };
  }
  if (manifest.version !== EVALUATION_VERSION) throw new Error("legacy evaluation is unverified; use eval migrate --run <id> --confirm before mutation or admission");
  if (action === "validate") {
    const assignment = assignmentFor(manifest, value(args, "--assignment"));
    return { action, run_id: runId, assignment: assignment.id,
      ...inspectLocalEvaluationPacket(root, { run: manifest, assignment }) };
  }
  if (action === "launch") {
    if (!flag(args, "--confirm")) throw new Error("evaluation launch requires --confirm");
    const wave = value(args, "--wave");
    const diagnostic = diagnoseCodexCloud({ environmentId: manifest.environment_id });
    if (!diagnostic.ok) throw new Error(`Codex Cloud provider unavailable: ${diagnostic.reason}`);
    const launched = [];
    for (const assignment of assignmentsForWave(manifest, wave)) {
      if (assignment.receipt) { launched.push({ id: assignment.id, skipped: true, receipt: assignment.receipt }); continue; }
      const receipt = launchCodexCloud({ environmentId: manifest.environment_id, branch: manifest.base_sha, prompt: buildEvaluationPrompt({ run: manifest, assignment }) });
      assignment.receipt = receipt; assignment.state = "launched"; launched.push({ id: assignment.id, receipt });
      writeRun(root, manifest); // durable receipt after every exact submission
    }
    manifest.state = "running"; writeRun(root, manifest);
    return { action, run_id: runId, wave, launched };
  }
  if (action === "collect") {
    const id = value(args, "--assignment");
    const assignment = assignmentFor(manifest, id);
    if (!assignment.receipt) throw new Error(`assignment ${id} has not been launched`);
    const diff = (opts.cloudDiff || ((taskId) => run("codex", ["cloud", "diff", taskId], root)))(assignment.receipt.external_id);
    const apply = flag(args, "--apply");
    const result = (apply ? applyEvaluationPatch : inspectEvaluationPatch)(root, { run: manifest, assignment, diff });
    if (apply && result.ok) {
      if (assignment.collection) assignment.history = [...(assignment.history || []), { collection: assignment.collection, admission: assignment.admission || null }];
      assignment.collected_at = new Date().toISOString(); assignment.state = "validated";
      assignment.collection = { packet_digest: result.digest, patch_digest: result.patch_digest, at: assignment.collected_at,
        counts: result.counts, receipt: assignment.receipt };
      assignment.admission = null;
      writeRun(root, manifest);
    }
    return { action, run_id: runId, assignment: id, ...result, applied: apply && result.ok };
  }
  if (action === "seal") {
    if (!flag(args, "--confirm")) throw new Error("evaluation seal requires --confirm");
    const wave = value(args, "--wave"); sealableWave(manifest, wave);
    throw new Error("sealing requires an authenticated GitHub current-head PASS and corpus attestation; collection timestamps are not acceptance");
  }
  throw new Error(`unknown evaluation action: ${action}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  try {
    const result = await runEvaluation(process.cwd(), process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  }
  catch (error) { console.error(`roadmap gauntlet eval: ${error.message}`); process.exit(1); }
}
