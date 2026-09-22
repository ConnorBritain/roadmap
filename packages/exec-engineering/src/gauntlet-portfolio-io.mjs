// Read-only portfolio assembly (engineering runtime). Durable GitHub identity, not task recency, is
// the discovery key. A partial observation is reported, never treated as idle.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { readGauntletLedger } from "@connorbritain/roadmap-core/gauntlet-store.mjs";
import { parseGauntletPrMarkers } from "@connorbritain/roadmap-core/gauntlet-core.mjs";
import { requiredArtifactRoot, EVALUATION_ROOT, evaluationScopeSnapshot } from "@connorbritain/roadmap-core/evaluation-core.mjs";
import { githubAuthorizationStore } from "./github-authority-store.mjs";
import { githubClient, runGauntletStatus } from "./gauntlet-runtime.mjs";
import { runEvaluation } from "./evaluate-runtime.mjs";
import { authorizationReport, evaluationSafeActions } from "@connorbritain/roadmap-core/gauntlet-portfolio-core.mjs";
import { REL } from "@connorbritain/roadmap-core/cli-core.mjs";

export async function runGauntletPortfolio(root, opts = {}) {
  const failures = [], records = new Map(), graph = loadGraph(join(root, ...REL));
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
        const status = await runGauntletStatus(root, record.run_id, { ...opts, github });
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
