import { observeCodexCloudTask } from "./cloud-agent-providers.mjs";

export function observeAuthorizedExecution(receipt, environmentId, opts = {}) {
  if (receipt.provider !== "codex") return { external_id: receipt.external_id, state: "observation_failed", error_code: "unsupported_observation_provider" };
  try {
    const task = (opts.observeCloud || observeCodexCloudTask)({ taskId: receipt.external_id, environmentId, execImpl: opts.execImpl });
    if (!task) return { external_id: receipt.external_id, state: "not_found" };
    if (task.external_id !== receipt.external_id || (task.provider_metadata?.environment_id && task.provider_metadata.environment_id !== environmentId)) {
      return { external_id: receipt.external_id, state: "observation_failed", error_code: "provider_identity_mismatch" };
    }
    // Cloud READY means finished artifact availability, not publication or PASS.
    const terminal = { ready: "completed", completed: "completed", failed: "failed", error: "failed", cancelled: "cancelled", canceled: "cancelled" };
    return { external_id: receipt.external_id, state: terminal[task.status] || "unresolved", provider_status: task.status, updated_at: task.updated_at || null };
  } catch { return { external_id: receipt.external_id, state: "observation_failed", error_code: "provider_query_failed" }; }
}
