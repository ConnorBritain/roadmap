// roadmap — portfolio reporting (PURE, core): attributable authorization reports and the safe-action
// derivation for evaluation runs. Discovery/IO lives with the engineering runtime
// (packages/exec-engineering/src/gauntlet-portfolio-io.mjs).
import { authorizationStatus } from "./gauntlet-authorization.mjs";
import { decisionReport } from "./gauntlet-decisions.mjs";

export function authorizationReport(state, { now = Date.now() } = {}) {
  const limits = authorizationStatus(state, { now });
  const findings = new Set(state.reservations.flatMap((r) => (r.request.accepted_findings || [])
    .map((finding) => `${finding.critic_comment_url}:${finding.id}`)));
  const decisions = decisionReport(state), kinds = new Set(decisions.records.map((event) => event.decision.kind));
  return { limits, submissions: state.reservations.length, repairs: limits.repairs_used,
    elapsed_seconds: Math.max(0, Math.floor((now - Date.parse(state.authorization.created_at)) / 1000)),
    accepted_repair_findings: findings.size,
    accepted_findings: kinds.has("finding") ? decisions.accepted_findings : null,
    rejected_findings: kinds.has("finding") ? decisions.rejected_findings : null,
    regressions: kinds.has("regression") ? decisions.regressions : null,
    human_interventions: kinds.has("human_intervention") ? decisions.human_interventions : null,
    decision_report: decisions,
    reporting_limitations: ["Decision counts cover attributable lead records only, not unobserved findings or interventions; missing record categories are unknown, not zero.",
      "Elapsed time is run age, not provider compute time or time-to-PASS."],
    monetary_usage: { amount: null, currency: null, verification: "unavailable", reason: "No trustworthy provider monetary usage is attached to these receipts." } };
}

export function evaluationSafeActions(result) {
  const actions = ["observe"];
  if (result.authority_status === "observation_failed") return ["restore_authority_observation"];
  if (result.authority_status !== "protected") return ["inspect_unverified_run"];
  if (result.limits?.ambiguous.length) actions.push("inspect_exact_unresolved_receipts");
  if ((result.executions || []).some((execution) => execution.observation?.state === "completed")) actions.push("preview_uncollected_artifacts");
  if (result.corpus?.state === "observation_failed") actions.push("inspect_exact_evidence_pr_checkout");
  if (result.review?.sealed) return ["closeout_without_changing_sealed_head"];
  if (!result.publication) actions.push("prepare_lead_evidence_pr");
  if (result.corpus?.totals?.unresolved) actions.push("inspect_and_adjudicate_packets");
  if (result.review?.state === "awaiting_lead_ack") actions.push("inspect_critic_before_acknowledgment");
  if (result.review?.pass && result.corpus?.totals?.unresolved === 0) actions.push("inspect_before_sealing");
  if (!result.limits?.continuation?.launch_ready) actions.push("establish_or_refresh_desktop_heartbeat");
  const canLaunch = result.limits?.continuation?.launch_ready && result.limits.launch_window_open && result.limits.submissions_remaining > 0 && result.limits.concurrency_remaining > 0;
  if (canLaunch && result.review?.state === "awaiting_critic" && result.corpus?.totals?.unresolved === 0) actions.push("launch_next_required_critic");
  if (canLaunch && result.review?.state === "needs_repair" && result.limits.repairs_remaining > 0) actions.push("synthesize_scoped_repair_packet");
  if (!result.limits?.launch_window_open || result.limits.submissions_remaining === 0) actions.push("no_new_launches_without_new_authority");
  return actions;
}

