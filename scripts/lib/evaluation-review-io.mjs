// Lead actuators for one consolidated evidence PR. No merge/publish-package API.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assignmentDirectory, evaluationDirectory } from "./evaluation-core.mjs";
import { inspectLocalEvaluationPacket, evaluationCommand, evaluationFilesAtCommit, frozenSourceLookup } from "./evaluation-io.mjs";
import { prohibitedDataFindings, validateEvaluationPacket } from "./evaluation-packet.mjs";
import { authorizationDigest, reserveAuthorizedLaunch, recordLaunchOutcome, recordLaunchNotSubmitted, authorizationStatus, continuationStatus } from "./gauntlet-authorization.mjs";
import { mutateAuthorization } from "./gauntlet-authorization-io.mjs";
import { evaluationReviewRun, evaluationReviewStatus, assertNextEvaluationReviewer, evaluationAttestation,
  findEvaluationAttestation, evaluationAdmissionTotals, sealEvaluationPayload } from "./evaluation-review-core.mjs";
import { validateEvaluationRepairPacket } from "./evaluation-review-core.mjs";
import { buildCriticPrompt, renderGauntletLaunchMarker, renderGauntletVerdictAck } from "./gauntlet-core.mjs";
import { diagnoseCodexCloud, launchCodexCloud } from "./cloud-agent-providers.mjs";
import { roleModelPreference, qualifyModelPreference } from "./model-policy.mjs";

const HASH = /^[a-f0-9]{64}$/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
function assertHead(pr, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected || "") || pr?.currentHead !== expected || pr.state !== "OPEN") {
    throw new Error("evaluation mutation requires the exact current open evidence PR head");
  }
}
export function inspectCommittedEvaluationCorpus(root, manifest, state, pr) {
  const head = evaluationCommand(root, "git", ["rev-parse", "HEAD"]).trim();
  if (head !== pr.currentHead) throw new Error("lead checkout must be at the exact evidence PR head before admission/review");
  const directory = evaluationDirectory(manifest.run_id, manifest.artifact_root);
  const changed = evaluationCommand(root, "git", ["diff", "--name-only", "-z", manifest.base_sha, head]).split("\0").filter(Boolean);
  if (changed.some((path) => !path.startsWith(directory + "/"))) throw new Error("evidence PR changes files outside the authorized documentation run");
  const tree = evaluationFilesAtCommit(root, head, directory);
  // A clean work tree for each packet prevents a local-only digest from being
  // accepted as GitHub content. Control-file cache updates are not evidence.
  const packets = manifest.assignments.map((assignment) => {
    const path = assignmentDirectory(manifest.run_id, assignment.id, manifest.artifact_root);
    if (evaluationCommand(root, "git", ["--literal-pathspecs", "status", "--porcelain", "--untracked-files=all", "--", path]).trim()) {
      throw new Error("packet has uncommitted changes; commit and publish it before adjudication or review");
    }
    const prefix = `inbox/${assignment.id}/`;
    const files = Object.fromEntries(Object.entries(tree).filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => [path.slice(prefix.length), bytes]));
    const committed = validateEvaluationPacket({ run: manifest, assignment, files, source: frozenSourceLookup(root) });
    const local = inspectLocalEvaluationPacket(root, { run: manifest, assignment });
    if (local.digest !== committed.digest) throw new Error("local packet bytes differ from the committed PR, including ignored/assume-unchanged files");
    return { assignment: assignment.id, collected: !!assignment.collection, ...committed };
  });
  // Only still-authentic, immutable lead comments make a durable decision
  // admissible. A protected cache record cannot resurrect a deleted comment.
  const admissions = (state.admissions || []).filter((record) => {
    const comment = findEvaluationAttestation(pr.comments,
      "admission", record.payload, state.authorization.lead_actor, pr.url);
    return comment?.url === record.comment_url && sha256(comment.body) === record.comment_digest;
  });
  return { packets, ...evaluationAdmissionTotals({ ...state, admissions }, packets) };
}

async function postAttestation(github, pr, kind, payload, lead) {
  const existing = findEvaluationAttestation(pr.comments, kind, payload, lead, pr.url);
  if (existing) return existing;
  await github.addComment(pr.number, evaluationAttestation(kind, payload));
  const current = await github.getPr(pr.number);
  const found = findEvaluationAttestation(current.comments, kind, payload, lead, pr.url);
  if (!found) throw new Error("lead GitHub attestation could not be verified; do not infer successful admission");
  return found;
}

export async function runEvaluationReviewAction(root, action, { manifest, store, github, expectedHead,
  prNumber, assignmentId, decision = "accepted", packetDigest, reason, redactionInspected = false,
  commentUrl, criticRole, repairPacket, confirm = false, opts = {} } = {}) {
  let snapshot = await store.read(manifest.run_id);
  if (!snapshot) throw new Error("evaluation review requires protected authorization");
  let state = snapshot.state;
  const lead = state.authorization.lead_actor;
  if (await github.viewerLogin() !== lead) throw new Error("evaluation action requires the frozen lead identity");
  if (action === "attach") {
    if (!confirm || !Number.isInteger(prNumber) || prNumber <= 0) throw new Error("attach requires the lead evidence PR number and explicit confirmation");
    const pr = await github.getPr(prNumber); assertHead(pr, expectedHead);
    if (!(await github.isAncestor(manifest.base_sha, pr.currentHead))) throw new Error("evidence PR must descend from the frozen product source");
    inspectCommittedEvaluationCorpus(root, manifest, state, pr);
    const publication = { number: pr.number, url: pr.url, base_ref: pr.baseRefName };
    await mutateAuthorization(store, manifest.run_id, (current) => {
      if (current.evidence_pr) {
        if (authorizationDigest(current.evidence_pr) !== authorizationDigest(publication)) throw new Error("this run already owns a different evidence PR");
        return { state: current };
      }
      return { state: { ...current, evidence_pr: publication } };
    });
    await postAttestation(github, pr, "publication", { run_id: manifest.run_id, authority_digest: state.authorization_digest,
      source_sha: manifest.base_sha, ...publication }, lead);
    return { action, run_id: manifest.run_id, pr: publication };
  }
  if (!state.evidence_pr) throw new Error("attach the single lead-owned evidence PR before adjudication/review");
  let pr = await github.getPr(state.evidence_pr.number); assertHead(pr, expectedHead);
  if (!(await github.isAncestor(manifest.base_sha, pr.currentHead))) throw new Error("evidence PR source ancestry is invalid");
  if (action === "accept") {
    if (!confirm || !redactionInspected || !["accepted", "rejected"].includes(decision) || !HASH.test(packetDigest || "")
      || typeof reason !== "string" || !reason.trim() || reason.length > 4000 || prohibitedDataFindings(reason).length) {
      throw new Error("adjudication requires explicit inspection/redaction confirmation, exact packet digest, accepted/rejected decision and a safe reason");
    }
    if (!manifest.assignments.some((a) => a.id === assignmentId)) throw new Error("unknown adjudication assignment");
    const corpus = inspectCommittedEvaluationCorpus(root, manifest, state, pr);
    const packet = corpus.packets.find((p) => p.assignment === assignmentId);
    if (packet?.digest !== packetDigest) throw new Error("adjudication digest must match the current committed packet, including rejections");
    if (decision === "accepted" && (!packet?.ok || packet.digest !== packetDigest)) throw new Error("accepted digest must match a valid packet committed at the evidence PR head");
    const payload = { run_id: manifest.run_id, authority_digest: state.authorization_digest, source_sha: manifest.base_sha,
      assignment: assignmentId, packet_digest: packetDigest, decision, reason: reason.trim(), redaction_inspected: true };
    pr = await github.getPr(pr.number); assertHead(pr, expectedHead);
    const attestation = await postAttestation(github, pr, "admission", payload, lead);
    const updated = await mutateAuthorization(store, manifest.run_id, (current) => {
      if ((current.admissions || []).some((record) => authorizationDigest(record.payload) === authorizationDigest(payload))) return { state: current };
      return { state: { ...current, admissions: [...(current.admissions || []), {
        assignment: assignmentId, packet_digest: packetDigest, decision, payload,
        comment_url: attestation.url, comment_digest: sha256(attestation.body), lead_actor: lead,
      }] } };
    });
    return { action, run_id: manifest.run_id, assignment: assignmentId, decision, packet_digest: packetDigest,
      comment_url: attestation.url, corpus: inspectCommittedEvaluationCorpus(root, manifest, updated.state, await github.getPr(pr.number)) };
  }
  const corpus = inspectCommittedEvaluationCorpus(root, manifest, state, pr);
  const review = evaluationReviewStatus(state, pr, { corpusDigest: corpus.corpus_digest });
  if (action === "repair") {
    const packet = validateEvaluationRepairPacket(repairPacket, { state, pr, review });
    if (state.authorization.providers.repair !== "codex") throw new Error("evaluation repair transport currently supports Codex Cloud only; no fallback was made");
    const modelPolicy = qualifyModelPreference({ provider: "codex", preference: roleModelPreference(state.authorization.model_preferences, "repair", opts.modelPreference) });
    const diagnostic = (opts.diagnoseCloud || diagnoseCodexCloud)({ environmentId: manifest.environment_id });
    if (!diagnostic.ok) throw new Error("Codex Cloud repair is unavailable; no submission reserved");
    const round = state.reservations.filter((r) => r.role === "repair").length + 1;
    const owner = randomUUID();
    const key = `evaluation:${manifest.run_id}:repair:${expectedHead}:${round}`;
    const reserved = await mutateAuthorization(store, manifest.run_id, (current) => reserveAuthorizedLaunch(current, {
      key, role: "repair", provider: "codex", expected_head: expectedHead, round, packet_digest: packet.digest,
      allowed_paths: packet.paths, accepted_findings: packet.findings, environment_id: manifest.environment_id,
      model_policy: modelPolicy,
    }, { owner, now: opts.now || new Date().toISOString() }));
    if (!reserved.reserved) return { action, duplicate: true, reservation: reserved.reservation };
    let submissionAttempted = false;
    try {
      pr = await github.getPr(pr.number); assertHead(pr, expectedHead);
      const currentReview = evaluationReviewStatus((await store.read(manifest.run_id)).state, pr, { corpusDigest: corpus.corpus_digest });
      validateEvaluationRepairPacket(repairPacket, { state, pr, review: currentReview });
      await github.addComment(pr.number, renderGauntletLaunchMarker({ run: review.run, role: "repair", round, expectedHead, packetSha256: packet.digest }));
      const prompt = `You are a fresh documentation-only REPAIR worker for evaluation ${manifest.run_id}.\n`
        + `Evidence PR: #${pr.number}; exact expected evidence head: ${expectedHead}. Frozen product source: ${manifest.base_sha}. These SHAs have different meanings.\n`
        + `First verify the current PR head using gh. If it differs, stop without changes. Only repair the lead-accepted findings below. Do not implement product changes or expand scope.\n`
        + `The ONLY writable files are:\n${packet.paths.map((path) => `- ${path}`).join("\n")}\n`
        + `Do not change run/assignment/receipt control files. Preserve attributable earlier packet revisions in Git history. Any changed packet must still satisfy version 1 evidence.yaml, REPORT.md links and frozen source references.\n`
        + `No production authentication, deployed-system interaction, customer data, credentials in artifacts, deployments or package publication. Do not run tests/builds/installers except these approved verification commands: ${JSON.stringify(state.authorization.verification_commands)}.\n`
        + `Do not push, open a PR, merge or post a verdict. The lead owns publication. Make a local Git commit containing only permitted paths so cloud diff includes the repair. Report the commit and tests actually run; distinguish checks not run.\n`
        + `Lead-synthesized repair packet (digest ${packet.digest}):\n${JSON.stringify(repairPacket, null, 2)}`;
      const currentAuthority = (await store.read(manifest.run_id)).state, now = Date.parse(opts.now || new Date().toISOString());
      if (!authorizationStatus(currentAuthority, { now }).launch_window_open || !continuationStatus(currentAuthority, { now }).launch_ready) throw new Error("launch window or desktop continuation expired");
      submissionAttempted = true;
      const receipt = { ...await (opts.launchCloud || launchCodexCloud)({ environmentId: manifest.environment_id, branch: expectedHead, attempts: 1, prompt }), model_policy: modelPolicy };
      await mutateAuthorization(store, manifest.run_id, (current) => ({ state: recordLaunchOutcome(current, key, { owner, receipt }) }));
      return { action, run_id: manifest.run_id, round, head: expectedHead, launch_key: key, allowed_paths: packet.paths, receipt, model_policy: modelPolicy };
    } catch {
      try { await mutateAuthorization(store, manifest.run_id, (current) => ({ state: submissionAttempted
        ? recordLaunchOutcome(current, key, { owner, ambiguous: true }) : recordLaunchNotSubmitted(current, key, { owner }) })); } catch { /* reservation remains occupied */ }
      if (!submissionAttempted) throw new Error("repair stopped before provider submission; spent reservation retained, no provider receipt exists to reconcile");
      throw new Error("repair reservation is unresolved; inspect its exact receipt before any further submission");
    }
  }
  if (action === "ack") {
    if (!confirm || !commentUrl) throw new Error("ack requires explicit lead inspection and the exact critic comment URL");
    const candidate = review.results.find((r) => r.comment.url === commentUrl);
    if (candidate?.valid) return { action, duplicate: true, comment_url: commentUrl, verdict: candidate.verdict };
    if (candidate?.invalidReason !== "unacknowledged_result") throw new Error("critic artifact is not safe to acknowledge at this head");
    pr = await github.getPr(pr.number); assertHead(pr, expectedHead);
    const refreshed = evaluationReviewStatus(state, pr, { corpusDigest: corpus.corpus_digest }).results.find((r) => r.comment.url === commentUrl);
    if (refreshed?.commentSha256 !== candidate.commentSha256 || refreshed?.invalidReason !== "unacknowledged_result") throw new Error("critic artifact changed during acknowledgment");
    await github.addComment(pr.number, renderGauntletVerdictAck({ run: review.run, comment: pr.comments.find((c) => c.url === commentUrl) }));
    const current = await github.getPr(pr.number); assertHead(current, expectedHead);
    if (!evaluationReviewStatus(state, current, { corpusDigest: corpus.corpus_digest }).results.some((r) => r.comment.url === commentUrl && r.acknowledged)) throw new Error("lead acknowledgment could not be verified");
    return { action, run_id: manifest.run_id, comment_url: commentUrl, verdict: candidate.verdict, head: expectedHead };
  }
  if (action === "critic") {
    if (corpus.totals.unresolved) throw new Error("adjudicate every expected packet before independent corpus review");
    const role = criticRole || review.next_role;
    assertNextEvaluationReviewer(review, role);
    if (!["none", "passing"].includes(pr.checks)) throw new Error("evidence PR checks are not stable/passing");
    if (state.authorization.providers.critic !== "codex") throw new Error("evaluation critic transport currently supports Codex Cloud only; no fallback was made");
    const modelPolicy = qualifyModelPreference({ provider: "codex", preference: roleModelPreference(state.authorization.model_preferences, "critic", opts.modelPreference) });
    const diagnostic = (opts.diagnoseCloud || diagnoseCodexCloud)({ environmentId: manifest.environment_id });
    if (!diagnostic.ok) throw new Error("Codex Cloud critic is unavailable; no submission reserved");
    const round = state.reservations.filter((r) => r.role === "repair").length + 1;
    const nonce = randomBytes(16).toString("hex"), owner = randomUUID();
    const key = `evaluation:${manifest.run_id}:critic:${role}:${expectedHead}:${round}:${corpus.corpus_digest}`;
    const reserved = await mutateAuthorization(store, manifest.run_id, (current) => reserveAuthorizedLaunch(current, {
      key, role: "critic", provider: "codex", expected_head: expectedHead, critic_role: role, round, nonce_sha256: sha256(nonce), corpus_digest: corpus.corpus_digest,
      model_policy: modelPolicy,
    }, { owner, now: opts.now || new Date().toISOString() }));
    if (!reserved.reserved) return { action, duplicate: true, reservation: reserved.reservation };
    let submissionAttempted = false;
    try {
      pr = await github.getPr(pr.number); assertHead(pr, expectedHead);
      await github.addComment(pr.number, renderGauntletLaunchMarker({ run: review.run, role: "critic", criticRole: role, round, expectedHead, nonce }));
      const prompt = buildCriticPrompt({ run: review.run, pr, expectedHead, criticRole: role, round, nonce })
        + `\n\nLead-adjudicated packet digest register (verify against actual committed files):\n${JSON.stringify(corpus.records.map(({ assignment, digest, status }) => ({ assignment, digest, status })), null, 2)}`;
      const currentAuthority = (await store.read(manifest.run_id)).state, now = Date.parse(opts.now || new Date().toISOString());
      if (!authorizationStatus(currentAuthority, { now }).launch_window_open || !continuationStatus(currentAuthority, { now }).launch_ready) throw new Error("launch window or desktop continuation expired");
      submissionAttempted = true;
      const receipt = { ...await (opts.launchCloud || launchCodexCloud)({ environmentId: manifest.environment_id, branch: expectedHead, attempts: 1, prompt }), model_policy: modelPolicy };
      await mutateAuthorization(store, manifest.run_id, (current) => ({ state: recordLaunchOutcome(current, key, { owner, receipt }) }));
      return { action, run_id: manifest.run_id, role, round, head: expectedHead, receipt, model_policy: modelPolicy };
    } catch {
      try { await mutateAuthorization(store, manifest.run_id, (current) => ({ state: submissionAttempted
        ? recordLaunchOutcome(current, key, { owner, ambiguous: true }) : recordLaunchNotSubmitted(current, key, { owner }) })); } catch { /* reservation remains occupied */ }
      if (!submissionAttempted) throw new Error("critic stopped before provider submission; spent reservation retained, no provider receipt exists to reconcile");
      throw new Error("critic reservation is unresolved; inspect its exact GitHub attestation/receipt before any further submission");
    }
  }
  if (action === "seal") {
    if (!confirm) throw new Error("seal requires explicit confirmation after lead inspection of all required PASS verdicts");
    const payload = sealEvaluationPayload(state, pr, corpus, review);
    pr = await github.getPr(pr.number); assertHead(pr, expectedHead);
    // Refresh comment reality as well as head; deleted acknowledgments revoke PASS.
    const refreshedCorpus = inspectCommittedEvaluationCorpus(root, manifest, state, pr);
    sealEvaluationPayload(state, pr, refreshedCorpus, evaluationReviewStatus(state, pr, { corpusDigest: refreshedCorpus.corpus_digest }));
    const attestation = await postAttestation(github, pr, "seal", payload, lead);
    await mutateAuthorization(store, manifest.run_id, (current) => {
      if ((current.seals || []).some((seal) => authorizationDigest(seal.payload) === authorizationDigest(payload))) return { state: current };
      return { state: { ...current, seals: [...(current.seals || []), { payload, comment_url: attestation.url }] } };
    });
    assertHead(await github.getPr(pr.number), expectedHead);
    return { action, sealed: true, ...payload, comment_url: attestation.url };
  }
  throw new Error(`evaluation review action not implemented: ${action}`);
}
