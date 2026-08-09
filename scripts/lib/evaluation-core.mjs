// Pure policy for documentation-only, SHA-pinned evaluation runs.
// Evaluation is deliberately distinct from an implementation Gauntlet: workers
// produce isolated evidence packets; a lead chooses what to integrate and merge.

export const EVALUATION_VERSION = 2;
export const EVALUATION_ROOT = "docs/audits/dimensional-coherence-matrix";

const RUN_ID = /^[a-z0-9][a-z0-9_-]{2,79}$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const ASSIGNMENT_ID = /^[a-z0-9][a-z0-9_-]{1,79}$/;

export function requiredRunId(value) {
  const id = String(value || "").trim();
  if (!RUN_ID.test(id)) throw new Error("evaluation run id must be 3-80 lowercase letters, digits, _ or -");
  return id;
}

export function requiredSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  if (!FULL_SHA.test(sha)) throw new Error("evaluation base SHA must be a full 40-character lowercase SHA");
  return sha;
}

// Run artifacts are committed repository content, so their configured root must
// be a portable repository-relative POSIX path. Refuse paths that could escape
// the checkout rather than relying on the host path resolver after collection.
export function requiredArtifactRoot(value = EVALUATION_ROOT) {
  const root = String(value == null ? EVALUATION_ROOT : value).trim().replace(/\/+$/, "");
  if (!root || root.startsWith("/") || root.includes("\\") || root.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("evaluation artifact root must be a non-empty repository-relative POSIX path");
  }
  return root;
}

export function evaluationDirectory(runId, artifactRoot = EVALUATION_ROOT) {
  return `${requiredArtifactRoot(artifactRoot)}/${requiredRunId(runId)}`;
}

export function assignmentDirectory(runId, assignmentId, artifactRoot = EVALUATION_ROOT) {
  const id = String(assignmentId || "").trim();
  if (!ASSIGNMENT_ID.test(id)) throw new Error("evaluation assignment id must be 2-80 lowercase letters, digits, _ or -");
  return `${evaluationDirectory(runId, artifactRoot)}/inbox/${id}`;
}

export function normalizeAssignment(value = {}) {
  const id = String(value.id || "").trim();
  if (!ASSIGNMENT_ID.test(id)) throw new Error("evaluation assignment requires a valid id");
  const wave = String(value.wave || "").trim();
  if (!RUN_ID.test(wave)) throw new Error(`evaluation assignment ${id} requires a valid wave`);
  const prompt = String(value.prompt || "").trim();
  if (!prompt) throw new Error(`evaluation assignment ${id} requires a prompt`);
  return {
    id, wave, prompt,
    state: value.state || "planned",
    receipt: value.receipt || null,
    collected_at: value.collected_at || null,
  };
}

export function buildEvaluationRun({ runId, baseSha, environmentId, artifactRoot = EVALUATION_ROOT, title = "Dimensional coherence matrix", assignments = [] } = {}) {
  const normalized = assignments.map(normalizeAssignment);
  const ids = new Set();
  for (const assignment of normalized) {
    if (ids.has(assignment.id)) throw new Error(`duplicate evaluation assignment id: ${assignment.id}`);
    ids.add(assignment.id);
  }
  const environment = String(environmentId || "").trim();
  if (!environment) throw new Error("evaluation requires a Codex environment ID");
  return {
    version: EVALUATION_VERSION,
    run_id: requiredRunId(runId),
    title: String(title || "Dimensional coherence matrix").trim(),
    base_sha: requiredSha(baseSha),
    artifact_root: requiredArtifactRoot(artifactRoot),
    provider: "codex",
    environment_id: environment,
    state: "planned",
    created_at: new Date().toISOString(),
    assignments: normalized,
  };
}

export function assignmentFor(run, id) {
  const assignment = (run && Array.isArray(run.assignments) ? run.assignments : []).find((entry) => entry && entry.id === id);
  if (!assignment) throw new Error(`evaluation assignment not found: ${id}`);
  return assignment;
}

export function assignmentsForWave(run, wave) {
  const name = String(wave || "").trim();
  if (!name) throw new Error("evaluation launch requires --wave");
  const assignments = (run && Array.isArray(run.assignments) ? run.assignments : []).filter((entry) => entry && entry.wave === name);
  if (!assignments.length) throw new Error(`evaluation has no assignments in wave ${name}`);
  return assignments;
}

export function buildEvaluationPrompt({ run, assignment }) {
  const packetDir = assignmentDirectory(run.run_id, assignment.id, run.artifact_root);
  return `You are an isolated, documentation-only evaluator in the Pidgeon dimensional-coherence matrix.\n\n`
    + `Frozen source baseline: ${requiredSha(run.base_sha)}\n`
    + `Assignment: ${assignment.id} (wave ${assignment.wave})\n\n`
    + `Hard boundaries:\n`
    + `- Inspect only the checked-out repository at the frozen baseline.\n`
    + `- Do not modify product code, configuration, tests, roadmap files, generated files, or dependencies.\n`
    + `- Do not commit, push, open a PR, use secrets, authenticate to production, or submit forms.\n`
    + `- You may create files ONLY beneath ${packetDir}/.\n`
    + `- Write REPORT.md plus evidence.yaml. Include the exact base SHA, commands run, evidence IDs, limitations, and confidence.\n`
    + `- A live public-page observation must be labelled deployed evidence with URL and capture time; do not conflate it with source evidence.\n`
    + `- Do not read or rely on other evaluation packets.\n\n`
    + `Your assignment:\n${assignment.prompt}\n`;
}

// Parse only normal unified-diff headers. An unparseable patch is unsafe to
// apply because the lead cannot prove the worker stayed in its assigned inbox.
export function changedPathsFromUnifiedDiff(text) {
  const paths = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match) continue;
    if (match[1] !== match[2] || !match[1] || match[1].includes("\0")) {
      throw new Error("evaluation diff has an unsupported or ambiguous file header");
    }
    paths.push(match[1]);
  }
  if (!paths.length) throw new Error("evaluation task produced no unified diff");
  return [...new Set(paths)];
}

export function assertEvaluationDiffPaths({ runId, assignmentId, artifactRoot = EVALUATION_ROOT, diff }) {
  const prefix = `${assignmentDirectory(runId, assignmentId, artifactRoot)}/`;
  const paths = changedPathsFromUnifiedDiff(diff);
  const forbidden = paths.filter((path) => !path.startsWith(prefix));
  if (forbidden.length) throw new Error(`evaluation diff escapes assigned documentation inbox: ${forbidden.join(", ")}`);
  return paths;
}

export function sealableWave(run, wave) {
  const assignments = assignmentsForWave(run, wave);
  const missing = assignments.filter((assignment) => !assignment.collected_at).map((assignment) => assignment.id);
  if (missing.length) throw new Error(`cannot seal wave ${wave}; uncollected assignments: ${missing.join(", ")}`);
  return assignments;
}
