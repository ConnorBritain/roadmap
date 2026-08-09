#!/usr/bin/env node
// roadmap gauntlet eval — documentation-only Codex Cloud evaluation conductor.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { loadGraph } from "./lib/graph.mjs";
import { diagnoseCodexCloud, launchCodexCloud, observeCodexCloudTask } from "./lib/cloud-agent-providers.mjs";
import {
  EVALUATION_ROOT, assertEvaluationDiffPaths, assignmentFor, assignmentsForWave,
  buildEvaluationPrompt, buildEvaluationRun, evaluationDirectory, normalizeAssignment,
  requiredRunId, requiredSha, sealableWave,
} from "./lib/evaluation-core.mjs";

function value(args, name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] || null; }
function flag(args, name) { return args.includes(name); }
function runPath(root, runId) { return join(root, evaluationDirectory(runId), "RUN.yaml"); }
function readRun(root, runId) {
  const path = runPath(root, runId);
  if (!existsSync(path)) throw new Error(`evaluation run manifest not found: ${path}`);
  const parsed = parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("evaluation RUN.yaml is invalid");
  requiredRunId(parsed.run_id); requiredSha(parsed.base_sha);
  if (!Array.isArray(parsed.assignments)) parsed.assignments = [];
  parsed.assignments = parsed.assignments.map(normalizeAssignment);
  return parsed;
}
function writeRun(root, run) {
  const path = runPath(root, run.run_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(run), "utf8");
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
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || "").trim() || result.error?.message || `exit ${result.status}`}`);
  return result.stdout || "";
}

export async function runEvaluation(root, args) {
  const action = args.shift() || "status";
  if (action === "init") {
    const runId = requiredRunId(value(args, "--run"));
    const baseSha = requiredSha(value(args, "--base-sha"));
    gitSha(root, baseSha);
    const graph = loadGraph(root);
    const environmentId = value(args, "--environment-id") || graph.meta?.dispatch?.providers?.codex?.environment_id;
    const assignmentsFile = value(args, "--assignments");
    const manifest = buildEvaluationRun({ runId, baseSha, environmentId, title: value(args, "--title") || undefined,
      assignments: assignmentsFile ? loadAssignments(assignmentsFile) : [] });
    if (existsSync(runPath(root, runId))) throw new Error(`evaluation run already exists: ${runId}`);
    writeRun(root, manifest);
    const base = join(root, evaluationDirectory(runId));
    mkdirSync(join(base, "inbox"), { recursive: true });
    writeFileSync(join(base, "README.md"), `# ${manifest.title}\n\nFrozen base: \`${baseSha}\`. This is a documentation-only evaluation corpus.\n`, "utf8");
    return { action, runId, path: evaluationDirectory(runId), assignments: manifest.assignments.length };
  }
  const runId = requiredRunId(value(args, "--run") || args.find((arg) => !arg.startsWith("-")));
  const manifest = readRun(root, runId);
  if (action === "status") {
    const assignments = manifest.assignments.map((assignment) => ({ ...assignment, provider_status: assignment.receipt
      ? observeCodexCloudTask({ taskId: assignment.receipt.external_id, environmentId: manifest.environment_id })?.status || "not_found" : "not_launched" }));
    return { run_id: runId, base_sha: manifest.base_sha, state: manifest.state, assignments };
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
    const diff = run("codex", ["cloud", "diff", assignment.receipt.external_id], root);
    const paths = assertEvaluationDiffPaths({ runId, assignmentId: id, diff });
    if (flag(args, "--apply")) run("codex", ["cloud", "apply", assignment.receipt.external_id], root);
    assignment.collected_at = new Date().toISOString(); assignment.state = flag(args, "--apply") ? "applied" : "validated";
    writeRun(root, manifest);
    return { action, run_id: runId, assignment: id, paths, applied: flag(args, "--apply") };
  }
  if (action === "seal") {
    if (!flag(args, "--confirm")) throw new Error("evaluation seal requires --confirm");
    const wave = value(args, "--wave"); sealableWave(manifest, wave);
    manifest.sealed_waves = [...new Set([...(manifest.sealed_waves || []), wave])];
    manifest.updated_at = new Date().toISOString(); writeRun(root, manifest);
    return { action, run_id: runId, wave, sealed_waves: manifest.sealed_waves };
  }
  throw new Error(`unknown evaluation action: ${action}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  try { console.log(JSON.stringify(await runEvaluation(process.cwd(), process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`roadmap gauntlet eval: ${error.message}`); process.exit(1); }
}
