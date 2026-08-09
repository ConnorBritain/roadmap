// Remote-agent providers are deliberately separate from dispatch-providers.mjs.
// That module adapts Git hosts for the PR duplicate lock; this module adapts
// disposable cloud workers.  GitHub remains the artifact rendezvous point.

import { spawnSync } from "node:child_process";

export const CLOUD_PROVIDER_NAMES = Object.freeze(["claude", "codex"]);

export const CLOUD_PROVIDER_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    remote_repo_checkout: true,
    select_model: true, // Routine tiers are selected in the configured Routine.
    multiple_attempts: false,
    structured_task_status: false,
    native_pr_context: false,
    native_pr_review: false,
    push_existing_pr: true,
    create_pr: true,
    custom_branch: false,
    exact_base_sha: false,
    cancel_task: false,
    retrieve_full_result: false,
    retrieve_diff: false,
  }),
  codex: Object.freeze({
    remote_repo_checkout: true,
    // The current supported cloud CLI deliberately has no per-chat model flag.
    select_model: false,
    multiple_attempts: true,
    structured_task_status: true,
    native_pr_context: true,
    native_pr_review: true,
    // A cloud task can edit remotely, but the supported CLI does not publish a
    // task to a PR unattended. `cloud apply` is a local, manual recovery path.
    push_existing_pr: false,
    create_pr: false,
    custom_branch: true,
    exact_base_sha: true,
    cancel_task: false,
    retrieve_full_result: false,
    retrieve_diff: true,
  }),
});

export function normalizeCloudProvider(value, { fallback = "claude" } = {}) {
  const raw = value == null || value === "" ? fallback : String(value).trim().toLowerCase();
  const aliases = { "claude-cloud": "claude", routine: "claude", routines: "claude", "codex-cloud": "codex" };
  const provider = aliases[raw] || raw;
  if (!CLOUD_PROVIDER_NAMES.includes(provider)) {
    throw new Error(`unknown cloud agent provider '${value}' — available: ${CLOUD_PROVIDER_NAMES.join(", ")}`);
  }
  return provider;
}

export function cloudProviderCapabilities(provider) {
  return CLOUD_PROVIDER_CAPABILITIES[normalizeCloudProvider(provider)];
}

export function resolveCodexEnvironment({ meta = {}, override = null } = {}) {
  if (override != null && String(override).trim()) return String(override).trim();
  const dispatch = meta && meta.dispatch;
  const configured = dispatch && dispatch.providers && dispatch.providers.codex
    && (dispatch.providers.codex.environment_id || dispatch.providers.codex.environment);
  if (!configured || !String(configured).trim()) {
    throw new Error("Codex Cloud provider is configured but has no environment ID — set meta.dispatch.providers.codex.environment_id (this is repository configuration, never a secret)");
  }
  return String(configured).trim();
}

function commandError(result, fallback) {
  return String((result && result.stderr) || (result && result.error && result.error.message) || fallback).trim();
}

export function diagnoseCodexCloud({ environmentId = null, execImpl = spawnSync } = {}) {
  if (!environmentId || !String(environmentId).trim()) {
    return { ok: false, provider: "codex", reason: "Codex Cloud environment ID is missing", capabilities: cloudProviderCapabilities("codex") };
  }
  const version = execImpl("codex", ["--version"], { encoding: "utf8" });
  if (version.error && version.error.code === "ENOENT") {
    return { ok: false, provider: "codex", reason: "Codex CLI is not installed (install Codex, then run 'codex login')", capabilities: cloudProviderCapabilities("codex") };
  }
  if (version.status !== 0) {
    return { ok: false, provider: "codex", reason: `Codex CLI is unavailable: ${commandError(version, `exit ${version.status}`)}`, capabilities: cloudProviderCapabilities("codex") };
  }
  const auth = execImpl("codex", ["login", "status"], { encoding: "utf8" });
  if (auth.error || auth.status !== 0) {
    return { ok: false, provider: "codex", reason: `Codex CLI is not authenticated — run 'codex login' (${commandError(auth, `exit ${auth.status}`)})`, capabilities: cloudProviderCapabilities("codex") };
  }
  return { ok: true, provider: "codex", environment_id: String(environmentId).trim(), capabilities: cloudProviderCapabilities("codex") };
}

export function buildCodexCloudExecArgs({ environmentId, prompt, attempts = 1, branch = null, model = null } = {}) {
  if (!environmentId || !String(environmentId).trim()) throw new Error("Codex Cloud launch requires an environment ID");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Codex Cloud launch requires a non-empty prompt");
  if (model != null && String(model).trim()) {
    throw new Error("Codex Cloud does not support per-task model selection; remove the model request or choose a provider with select_model capability");
  }
  const count = Number(attempts);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("Codex Cloud attempts must be an integer from 1 to 4");
  const args = ["cloud", "exec", "--env", String(environmentId).trim(), "--attempts", String(count)];
  if (branch != null && String(branch).trim()) args.push("--branch", String(branch).trim());
  args.push(prompt);
  return args;
}

// `codex cloud exec` currently emits a task URL as text, not JSON. Accept one
// and only one URL and derive the ID from its final path component. This is a
// submission receipt, not a reconciliation heuristic: a launch whose output is
// ambiguous is deliberately unsafe to retry.
export function parseCodexCloudSubmission(text) {
  const urls = String(text || "").match(/https?:\/\/[^\s)>\]]+/g) || [];
  const unique = [...new Set(urls.map((url) => url.replace(/[.,;:]+$/, "")))];
  if (unique.length !== 1) {
    throw new Error("Codex Cloud submission did not return exactly one task URL; task identity is ambiguous and Roadmap will not associate it with a recent task");
  }
  let parsed;
  try { parsed = new URL(unique[0]); } catch { throw new Error("Codex Cloud submission returned an invalid task URL"); }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const id = parts.at(-1);
  if (!id || !/^[A-Za-z0-9_-]{4,}$/.test(id)) {
    throw new Error("Codex Cloud task URL does not contain a recognizable exact task ID");
  }
  return { provider: "codex", external_id: id, external_url: parsed.toString(), status: "submitted" };
}

export function launchCodexCloud({ environmentId, prompt, attempts = 1, branch = null, model = null, execImpl = spawnSync } = {}) {
  const args = buildCodexCloudExecArgs({ environmentId, prompt, attempts, branch, model });
  const result = execImpl("codex", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Codex Cloud task submission failed: ${commandError(result, `exit ${result.status}`)}`);
  }
  const receipt = parseCodexCloudSubmission(`${result.stdout || ""}\n${result.stderr || ""}`);
  return {
    ...receipt,
    launched_at: new Date().toISOString(),
    provider_metadata: { environment_id: String(environmentId).trim(), attempt_total: Number(attempts) },
  };
}

export function normalizeCodexTask(task) {
  if (!task || typeof task.id !== "string" || !task.id.trim()) return null;
  return {
    provider: "codex",
    external_id: task.id,
    external_url: typeof task.url === "string" ? task.url : null,
    status: typeof task.status === "string" ? task.status.toLowerCase() : "unknown",
    updated_at: task.updated_at || null,
    provider_metadata: {
      environment_id: task.environment_id || null,
      environment_label: task.environment_label || null,
      attempt_total: Number.isInteger(task.attempt_total) ? task.attempt_total : null,
      is_review: task.is_review === true,
    },
  };
}

export function observeCodexCloudTask({ taskId, environmentId = null, execImpl = spawnSync, maxPages = 100 } = {}) {
  if (!taskId || !String(taskId).trim()) throw new Error("Codex Cloud observation requires an exact task ID");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer");
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const args = ["cloud", "list", "--json", "--limit", "20"];
    if (environmentId) args.push("--env", String(environmentId));
    if (cursor) args.push("--cursor", cursor);
    const result = execImpl("codex", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Codex Cloud task observation failed: ${commandError(result, `exit ${result.status}`)}`);
    let payload;
    try { payload = JSON.parse(result.stdout || "{}"); }
    catch (e) { throw new Error(`Codex Cloud task list returned invalid JSON: ${e.message}`); }
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : null;
    if (!tasks) throw new Error("Codex Cloud task list JSON is missing its tasks array");
    const found = tasks.find((task) => task && task.id === taskId);
    if (found) return normalizeCodexTask(found);
    cursor = typeof payload.cursor === "string" && payload.cursor ? payload.cursor : null;
    if (!cursor) return null;
  }
  throw new Error(`Codex Cloud task ${taskId} was not found before the configured pagination limit (${maxPages} pages)`);
}
