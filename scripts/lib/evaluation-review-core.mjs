// Evaluation reuses the implementation Gauntlet's exact-head launch/ack
// protocol. Packet source identity remains separate from the reviewed PR head.
import { createHash } from "node:crypto";
import { authorizationDigest, assertAuthorizationState } from "./gauntlet-authorization.mjs";
import { deriveCriticResults, reconstructLaunchesFromComments, gauntletLaunchKey } from "./gauntlet-core.mjs";
import { evaluationDirectory } from "./evaluation-core.mjs";
import { safePacketPath, prohibitedDataFindings } from "./evaluation-packet.mjs";

export function evaluationReviewRun(state) {
  assertAuthorizationState(state);
  const a = state.authorization;
  if (!state.evidence_pr) throw new Error("attach the lead-owned evidence PR before review");
  const bar = [
    "# Documentation evaluation quality bar",
    `Frozen authority: ${state.authorization_digest}`,
    `Frozen product-source SHA: ${a.source_sha}. This is NOT the evidence PR head.`,
    a.scope.description,
    "Only the authorized run documentation may change. No product changes, deployments, production authentication or customer-data access.",
    "Expected packets must have attributable decisions bound to their exact digests. Missing evidence remains unresolved. Check REPORT.md claims against version 1 evidence.yaml and frozen source independently; schema validity is not truth.",
    "Verify report links, limitations, executed versus unexecuted tests, source versus deployed observations, declared attachments, redaction and preserved prior revisions. Do not infer a PASS from collection timestamps.",
    "Synthetic qualification defects must be explicitly labelled and separate from genuine product findings.",
    `Required independent reviewer roles (sequential): ${a.required_review_roles.join(", ")}.`,
    `Only these verification commands are approved: ${JSON.stringify(a.verification_commands)}. Do not run other tests, builds or install scripts. Read-only source inspection is allowed.`,
    "Do not read builder/evaluator conversation transcripts or rely on worker self-assessments. Do not change files, push, merge, repair, publish packages or launch additional agents.",
  ].join("\n\n");
  return { run_id: a.run_id, subject_type: "slice", subject_key: `eval-${a.run_id}`,
    base_sha: a.source_sha, base_ref: state.evidence_pr.base_ref, lead_actor: a.lead_actor,
    max_rounds: a.limits.repairs, critic_tier: null, repair_tier: null,
    frozen_bar_markdown: bar, bar_sha256: createHash("sha256").update(bar).digest("hex"), launches: [] };
}

export function evaluationReviewStatus(state, pr) {
  const run = evaluationReviewRun(state);
  if (pr.number !== state.evidence_pr.number || pr.url !== state.evidence_pr.url || pr.baseRefName !== state.evidence_pr.base_ref) {
    throw new Error("evidence PR identity or base branch changed");
  }
  const attestations = reconstructLaunchesFromComments({ run, comments: pr.comments || [] });
  const missingAttestations = [];
  for (const reservation of state.reservations.filter((r) => r.role === "critic")) {
    const request = reservation.request;
    const attestation = attestations.find((launch) => launch.role === "critic" && launch.expected_head === reservation.expected_head
      && launch.critic_role === request.critic_role && launch.round === request.round && launch.nonce_sha256 === request.nonce_sha256);
    if (!attestation) { missingAttestations.push(reservation.key); continue; }
    run.launches.push({ ...attestation, key: gauntletLaunchKey({ runId: run.run_id, role: "critic", round: request.round,
      expectedHead: reservation.expected_head, criticRole: request.critic_role }), provider: reservation.provider });
  }
  const results = deriveCriticResults({ run, pr, currentHead: pr.currentHead, comments: pr.comments || [], commits: pr.commits || [], requireLaunchMatch: true });
  const roles = state.authorization.required_review_roles.map((role) => {
    const valid = results.find((r) => r.criticRole === role && r.valid);
    const candidate = results.find((r) => r.criticRole === role && r.invalidReason === "unacknowledged_result");
    const inFlight = state.reservations.find((r) => r.role === "critic" && r.expected_head === pr.currentHead && r.request.critic_role === role);
    return { role, verdict: valid?.verdict || null, acknowledged: !!valid, comment_url: (valid || candidate)?.comment.url || null,
      awaiting_ack: !!candidate, launched: !!inFlight };
  });
  const pass = missingAttestations.length === 0 && roles.every((role) => role.verdict === "PASS");
  const next = roles.find((role) => role.verdict !== "PASS");
  return { run, results, roles, pass, missing_attestations: missingAttestations,
    next_role: next?.role || null,
    state: missingAttestations.length ? "launch_attestation_missing" : roles.some((role) => role.awaiting_ack) ? "awaiting_lead_ack"
      : roles.some((role) => role.verdict === "HUMAN_REQUIRED") ? "human_required"
      : roles.some((role) => role.verdict === "REVISE") ? "needs_repair"
      : pass ? "passed_unsealed" : next?.launched ? "critic_in_flight" : "awaiting_critic" };
}

export function assertNextEvaluationReviewer(status, role) {
  if (status.state !== "awaiting_critic" || role !== status.next_role) {
    throw new Error(`reviewer ${role} is not the next authorized independent role (${status.state}; next ${status.next_role || "none"})`);
  }
}

export function evaluationAttestation(kind, payload) {
  if (!["admission", "seal", "publication"].includes(kind)) throw new Error("unsupported evaluation attestation");
  return `<!-- roadmap-evaluation-${kind}:v1\n${JSON.stringify(payload)}\n-->`;
}

export function findEvaluationAttestation(comments, kind, payload, leadActor, prUrl) {
  const body = evaluationAttestation(kind, payload);
  return (comments || []).find((comment) => comment.body === body && (comment.author?.login || comment.author) === leadActor
    && typeof comment.url === "string" && comment.url.startsWith(`${prUrl}#issuecomment-`)
    && !comment.includesCreatedEdit && !(Date.parse(comment.updatedAt || "") > Date.parse(comment.createdAt || ""))) || null;
}

export function evaluationAdmissionTotals(state, packets) {
  const decisions = state.admissions || [];
  const totals = { expected: state.authorization.scope.snapshot.assignments.length, collected: 0, validated: 0, accepted: 0, rejected: 0, unresolved: 0 };
  const records = state.authorization.scope.snapshot.assignments.map((assignment) => {
    const packet = packets.find((packet) => packet.assignment === assignment.id);
    const decision = [...decisions].reverse().find((d) => d.assignment === assignment.id && d.packet_digest === packet?.digest);
    if (packet?.collected) totals.collected++;
    if (packet?.ok) totals.validated++;
    const status = decision?.decision === "accepted" && packet?.ok ? "accepted"
      : decision?.decision === "rejected" && packet?.digest && (packet.evidence_present ?? packet.ok) ? "rejected" : "unresolved";
    totals[status]++;
    return { assignment: assignment.id, digest: packet?.digest || null, status, decision: decision || null };
  });
  return { totals, records, corpus_digest: authorizationDigest(records.map(({ assignment, digest, status }) => ({ assignment, digest, status }))) };
}

export function sealEvaluationPayload(state, pr, admission, review) {
  if (admission.totals.unresolved || !admission.totals.expected || !review.pass || pr.state !== "OPEN") {
    throw new Error("seal requires every expected packet adjudicated and all required reviewers acknowledged PASS at the open PR head");
  }
  return { run_id: state.authorization.run_id, authority_digest: state.authorization_digest,
    source_sha: state.authorization.source_sha, evidence_head: pr.currentHead, corpus_digest: admission.corpus_digest };
}

export function validateEvaluationRepairPacket(packet, { state, pr, review }) {
  if (review.state !== "needs_repair" || packet?.version !== 1 || packet.expected_head !== pr.currentHead
    || !Array.isArray(packet.findings) || !packet.findings.length || typeof packet.instructions !== "string" || !packet.instructions.trim()) {
    throw new Error("repair requires a versioned lead packet and acknowledged current-head REVISE findings");
  }
  const serialized = JSON.stringify(packet);
  if (serialized.length > 50000 || prohibitedDataFindings(serialized).length) throw new Error("repair packet is oversized or contains detected prohibited data");
  const prefix = evaluationDirectory(state.authorization.run_id, state.authorization.scope.snapshot.artifact_root) + "/";
  const ids = new Set(), paths = new Set(), findings = [];
  for (const finding of packet.findings) {
    const critic = review.results.find((result) => result.valid && result.verdict === "REVISE" && result.comment.url === finding.critic_comment_url);
    if (!critic || typeof finding.id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(finding.id) || ids.has(finding.id)
      || typeof finding.description !== "string" || !finding.description.trim() || !Array.isArray(finding.paths) || !finding.paths.length) {
      throw new Error("every repair finding needs a unique ID, lead description, exact acknowledged critic URL and explicit paths");
    }
    ids.add(finding.id);
    for (const path of finding.paths) {
      if (!safePacketPath(path) || !path.startsWith(prefix) || !/\.(md|ya?ml|json|txt|log|png|jpe?g|webp)$/i.test(path)
        || /\/(?:RUN\.yaml|LEGACY_RUN[^/]*|ASSIGNMENTS\.yaml|RECEIPTS\.yaml)$/.test(path)) {
        throw new Error("repair paths must be explicit permitted run documentation, not product or conductor control files");
      }
      paths.add(path);
    }
    findings.push({ id: finding.id, critic_comment_url: finding.critic_comment_url, critic_comment_digest: critic.commentSha256 });
  }
  return { digest: authorizationDigest(packet), paths: [...paths].sort(), findings };
}
