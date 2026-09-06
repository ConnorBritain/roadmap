// Read-only portfolio assembly. Durable GitHub identity, not task recency, is
// the discovery key. A partial observation is reported, never treated as idle.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadGraph } from "./graph.mjs";
import { readGauntletLedger } from "./gauntlet-store.mjs";
import { parseGauntletPrMarkers } from "./gauntlet-core.mjs";
import { requiredArtifactRoot, EVALUATION_ROOT, evaluationScopeSnapshot } from "./evaluation-core.mjs";
import { githubAuthorizationStore } from "./gauntlet-authorization-io.mjs";
import { authorizationStatus } from "./gauntlet-authorization.mjs";
import { githubClient, runGauntletStatus } from "../gauntlet.mjs";
import { runEvaluation } from "../evaluate.mjs";

export function authorizationReport(state, { now = Date.now() } = {}) {
  const limits = authorizationStatus(state, { now });
  const findings = new Set(state.reservations.flatMap((r) => (r.request.accepted_findings || [])
    .map((finding) => `${finding.critic_comment_url}:${finding.id}`)));
  return { limits, submissions: state.reservations.length, repairs: limits.repairs_used,
    elapsed_seconds: Math.max(0, Math.floor((now - Date.parse(state.authorization.created_at)) / 1000)),
    accepted_repair_findings: findings.size,
    rejected_findings: null, regressions: null, human_interventions: null,
    reporting_limitations: ["Finding rejection, regression and human-intervention totals are unknown unless explicitly recorded; absence is not zero.",
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
  const canLaunch = result.limits?.launch_window_open && result.limits.submissions_remaining > 0 && result.limits.concurrency_remaining > 0;
  if (canLaunch && result.review?.state === "awaiting_critic" && result.corpus?.totals?.unresolved === 0) actions.push("launch_next_required_critic");
  if (canLaunch && result.review?.state === "needs_repair" && result.limits.repairs_remaining > 0) actions.push("synthesize_scoped_repair_packet");
  if (!result.limits?.launch_window_open || result.limits.submissions_remaining === 0) actions.push("no_new_launches_without_new_authority");
  return actions;
}

export async function runGauntletPortfolio(root, opts = {}) {
  const failures = [], records = new Map(), graph = loadGraph(join(root, "docs/roadmap/roadmap.yaml"));
  const github = opts.github || githubClient(root, { execImpl: opts.execImpl, remote: graph.meta?.remote || "origin" });
  const store = opts.authorityStore || githubAuthorizationStore(root, { github, execImpl: opts.execImpl });
  const add = (id, mode, details = {}) => {
    const earlier = records.get(id);
    if (earlier && earlier.mode !== mode) { failures.push({ run_id: id, error_code: "conflicting_run_mode" }); return; }
    records.set(id, { ...earlier, run_id: id, mode, ...details });
  };
  try { for (const run of Object.values(readGauntletLedger(root).runs)) add(run.run_id, "implementation"); }
  catch { failures.push({ source: "local_implementation_ledger", error_code: "unreadable" }); }
  const artifactRoot = requiredArtifactRoot(graph.meta?.dispatch?.evaluation?.artifact_root || EVALUATION_ROOT);
  try {
    for (const entry of existsSync(join(root, artifactRoot)) ? readdirSync(join(root, artifactRoot), { withFileTypes: true }) : []) {
      if (entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{2,159}$/.test(entry.name) && existsSync(join(root, artifactRoot, entry.name, "RUN.yaml"))) {
        add(entry.name, "evaluation", { local_manifest: true });
      }
    }
  } catch { failures.push({ source: "evaluation_manifests", error_code: "unreadable" }); }
  try {
    const discovery = await store.list();
    failures.push(...discovery.failures);
    for (const snapshot of discovery.snapshots) add(snapshot.state.authorization.run_id, snapshot.state.authorization.mode, { authority: snapshot });
  } catch { failures.push({ source: "protected_authority_discovery", error_code: "observation_failed" }); }
  try {
    const discovery = await github.listGauntletPrs();
    if (discovery.possibly_truncated) failures.push({ source: "legacy_pr_discovery", error_code: "possibly_truncated_at_100" });
    for (const pr of discovery.prs) {
      const marker = parseGauntletPrMarkers(pr.body || "");
      if (marker) add(marker.runId, "implementation");
    }
  } catch { failures.push({ source: "legacy_pr_discovery", error_code: "observation_failed" }); }
  const runs = [];
  for (const record of records.values()) {
    try {
      if (record.mode === "evaluation") {
        const snapshot = record.authority?.state.authorization.scope.snapshot;
        const readOnlyManifest = !record.local_manifest && snapshot ? { ...evaluationScopeSnapshot(snapshot),
          created_at: record.authority.state.authorization.created_at, state: "protected_recovery_available" } : undefined;
        const status = await runEvaluation(root, ["status", "--run", record.run_id], { ...opts, github, authorityStore: store, readOnlyManifest });
        runs.push({ mode: "evaluation", ...status, safe_actions: evaluationSafeActions(status),
          report: record.authority ? authorizationReport(record.authority.state) : null,
          local_recovery_needed: !record.local_manifest });
      } else {
        const status = await runGauntletStatus(root, record.run_id, { ...opts, all: false, github });
        runs.push({ mode: "implementation", ...status, run_id: record.run_id,
          authority_status: record.authority ? "protected" : "legacy_unverified",
          report: record.authority ? authorizationReport(record.authority.state) : null });
      }
    } catch { runs.push({ run_id: record.run_id, mode: record.mode, state: "observation_failed", safe_actions: ["restore_exact_run_observation"] }); }
  }
  return { version: 1, observed_at: new Date().toISOString(), read_only: true, observation_complete: failures.length === 0
    && !runs.some((run) => run.state === "observation_failed" || run.authority_status === "observation_failed"
      || run.review?.state === "observation_failed" || run.corpus?.state === "observation_failed"
      || (run.executions || []).some((execution) => ["observation_failed", "not_found"].includes(execution.observation?.state))),
    discovery_failures: failures, runs };
}
