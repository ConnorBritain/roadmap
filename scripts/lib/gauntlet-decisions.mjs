// Reporting records are attributable lead judgments, not admission, review
// acknowledgments, repair authorization or proof of the underlying claim.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertAuthorizationState, authorizationDigest } from "./gauntlet-authorization.mjs";
import { mutateAuthorization } from "./gauntlet-authorization-io.mjs";
import { prohibitedDataFindings } from "./evaluation-packet.mjs";

const OUTCOMES = { finding: ["accepted", "rejected"], regression: ["observed", "cleared"], human_intervention: ["occurred"] };
const hash = (text) => createHash("sha256").update(text).digest("hex");

export function readDecisionFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("oversized decision");
    return JSON.parse(text);
  } catch { throw new Error("cannot read valid bounded decision JSON (raw input withheld)"); }
}

export function recordLeadDecision(state, input, { actor, confirm, now = new Date().toISOString() } = {}) {
  assertAuthorizationState(state);
  if (actor !== state.authorization.lead_actor || confirm !== true) throw new Error("decision record requires explicit frozen-lead inspection");
  if (input?.version !== 1 || !/^[A-Za-z0-9_-]{1,120}$/.test(input.id || "")
    || !OUTCOMES[input.kind]?.includes(input.outcome) || !/^[a-f0-9]{40}$/.test(input.head || "")
    || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 4000
    || !/^[a-f0-9]{64}$/.test(input.reference_digest || "") || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+#issuecomment-\d+$/.test(input.reference_url || "")
    || !Number.isFinite(Date.parse(now))) throw new Error("invalid versioned decision record, exact-head reference or outcome");
  const decision = { version: 1, id: input.id, kind: input.kind, outcome: input.outcome, head: input.head,
    reason: input.reason.trim(), reference_url: input.reference_url, reference_digest: input.reference_digest,
    supersedes: input.supersedes || null, actor, verification: "lead_reported" };
  if (prohibitedDataFindings(JSON.stringify(decision)).length) throw new Error("decision contains detected prohibited data; refusing publication");
  const fingerprint = authorizationDigest({ kind: "lead_decision", decision });
  if (state.events.some((event) => event.fingerprint === fingerprint)) return state;
  const earlier = [...state.events].reverse().find((event) => event.kind === "lead_decision"
    && event.decision.kind === decision.kind && event.decision.id === decision.id);
  if ((earlier?.fingerprint || null) !== decision.supersedes) throw new Error("decision correction must explicitly supersede the latest attributable revision");
  const next = structuredClone(state);
  next.events.push({ kind: "lead_decision", fingerprint, decision, observed_at: now });
  return next;
}

export function decisionReport(state) {
  const latest = new Map(), history = state.events.filter((event) => event.kind === "lead_decision");
  for (const event of history) latest.set(`${event.decision.kind}:${event.decision.id}`, event);
  const records = [...latest.values()], count = (kind, outcome) => records.filter((event) => event.decision.kind === kind && event.decision.outcome === outcome).length;
  return { verification: "lead_reported", coverage: "recorded_decisions_only", revisions: history.length,
    accepted_findings: count("finding", "accepted"), rejected_findings: count("finding", "rejected"),
    regressions: count("regression", "observed"), cleared_regressions: count("regression", "cleared"),
    human_interventions: count("human_intervention", "occurred"), records };
}

export async function recordDecisionForPr({ store, runId, github, prNumber, expectedHead, input, confirm, now }) {
  const snapshot = await store.read(runId);
  if (!snapshot) throw new Error("decision recording requires protected run authorization");
  const actor = await github.viewerLogin();
  if (actor !== snapshot.state.authorization.lead_actor || confirm !== true) throw new Error("decision requires frozen-lead inspection");
  const pr = await github.getPr(prNumber);
  if (pr.state !== "OPEN" || pr.currentHead !== expectedHead || input?.head !== expectedHead) throw new Error("decision must reference the exact current open PR head");
  const comment = pr.comments.find((comment) => comment.url === input.reference_url);
  if (!comment || !comment.url.startsWith(`${pr.url}#issuecomment-`) || comment.includesCreatedEdit
    || Date.parse(comment.updatedAt || "") > Date.parse(comment.createdAt || "")) throw new Error("decision requires an immutable comment on this PR");
  const record = { ...input, reference_digest: hash(comment.body) };
  const refreshed = await github.getPr(prNumber);
  const current = refreshed.comments.find((candidate) => candidate.url === comment.url);
  if (refreshed.state !== "OPEN" || refreshed.currentHead !== expectedHead || !current || hash(current.body) !== record.reference_digest
    || current.includesCreatedEdit || Date.parse(current.updatedAt || "") > Date.parse(current.createdAt || "")) throw new Error("decision reference changed during inspection");
  const result = await mutateAuthorization(store, runId, (state) => ({ state: recordLeadDecision(state, record, { actor, confirm, now }) }));
  return { action: "decision", run_id: runId, reporting_only: true, report: decisionReport(result.state) };
}
