// roadmap — the engineering profile's MCP tools: cloud dispatch, the Gauntlet actuators, and the
// documentation-only evaluation family. The profile loader appends ENGINEERING_TOOLS to the core
// tool list and routes their calls through callEngineeringTool; the server itself stays profile-blind.
import { runDispatch, runFanCloud } from "./cloud-dispatch.mjs";
import { runGauntletPortfolio } from "./gauntlet-portfolio-io.mjs";
import { runGauntletStart, runGauntletStatus, runGauntletObserve, runGauntletContinuation, runGauntletReconcile, runGauntletDecision, runGauntletAcknowledge, runGauntletCritic, runGauntletRepair, runGauntletCancel } from "./gauntlet-runtime.mjs";
import { runEvaluation } from "./evaluate-runtime.mjs";

// Cloud dispatch conducts remote agents without consuming local worktrees. Claude
// Routines can publish PRs; Codex Cloud records a task receipt and may await
// artifact publication because its supported CLI has no unattended task→PR call.
const CLOUD_TOOLS = [
  { name: "dispatch", description: "Launch one remote cloud agent for a slice or backlog item. provider=claude (default) fires a Routine; provider=codex submits an exact Codex Cloud task receipt in the configured repository environment. Neither consumes a local worktree. Codex currently cannot be claimed as an unattended task→PR transport, so its result may be awaiting artifact publication.",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string", description: "slice invoke key or backlog id" }, provider: { enum: ["claude", "codex"] }, attempts: { type: "integer", minimum: 1, maximum: 4, description: "Codex Cloud best-of-N attempts; not independent critics" }, force: { type: "boolean", description: "override the cycle lock for this one dispatch (out-of-cycle work; surfaces as scope change)" } } } },
  { name: "fan_cloud", description: "Preview or conduct a provider-aware cloud fanout of a ready wave without local worktrees. provider=claude opens Routine sessions; provider=codex creates distinct remote task receipts. DEFAULT is a preview; pass confirm=true to submit.",
    inputSchema: { type: "object", properties: {
      wave: { type: "integer", minimum: 1, description: "which ready wave (default 1)" },
      cap: { type: "integer", minimum: 1, description: "max slices in the wave (default the review ceiling, 5 — machine limits don't apply to cloud)" },
      confirm: { type: "boolean", description: "false/absent = preview only; true = actually fire the cloud sessions" },
      all: { type: "boolean", description: "include out-of-cycle slices in the wave (explicit override of the cycle lock)" },
      provider: { enum: ["claude", "codex"] }, attempts: { type: "integer", minimum: 1, maximum: 4 } } } },
];

// Conducted cloud work: deterministic senses/actuators only. The lead model remains the
// executive function that judges critic materiality, synthesizes repairs, and decides stops.
const GAUNTLET_TOOLS = [
  { name: "gauntlet_continuation", description: "After inspecting the supported desktop scheduling tool result, record the exact heartbeat ID, target lead task and ACTIVE/PAUSED status in protected authorization. Requires a fresh observation. This is lead-attested registration, not verified proof a scheduled wake ran. Paused or stale registration blocks new bounded launches, not observation or collection.",
    inputSchema: { type: "object", required: ["run", "record", "confirm"], properties: { run: { type: "string" }, record: { type: "object" }, confirm: { const: true } } } },
  { name: "gauntlet_decision", description: "Record a lead-inspected finding decision, regression or human intervention against an immutable comment on the exact implementation PR head. Reporting only: does not accept packets, acknowledge critics, authorize repairs or prove a claim. Corrections must name the superseded record fingerprint.",
    inputSchema: { type: "object", required: ["run", "expected_head", "record", "confirm"], properties: { run: { type: "string" }, expected_head: { type: "string" }, record: { type: "object" }, confirm: { const: true } } } },
  { name: "gauntlet_reconcile", description: "After frozen-lead inspection, associate an exact observable Codex task ID/URL with an unresolved protected implementation launch. Records the lead reason, cannot replace receipts or replenish budgets, and never launches or guesses by recency.",
    inputSchema: { type: "object", required: ["run", "launch_key", "task_id", "task_url", "reason", "confirm"], properties: {
      run: { type: "string" }, launch_key: { type: "string" }, task_id: { type: "string" }, task_url: { type: "string" }, reason: { type: "string" }, confirm: { const: true } } } },
  { name: "gauntlet_observe", description: "Refresh exact provider receipts for a bounded implementation run into protected accounting. Releases concurrency on terminal provider observations but never replenishes spent submissions. Failed queries remain explicit and cannot authorize retries.",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string" } } } },
  { name: "gauntlet_start", description: "Freeze the current quality bar, create a run, and launch one provider-selected implementation execution. GitHub remains the durable artifact; the local ledger records generic provider receipts. Codex implementation may await artifact publication rather than claiming a PR.",
    inputSchema: { type: "object", required: ["key"], properties: {
      key: { type: "string", description: "slice invoke key or backlog id" },
      max_rounds: { type: "integer", minimum: 0, maximum: 20, description: "maximum repair launches (default meta.gauntlet.max_rounds or 3)" },
      bar: { type: "string", description: "additional immutable acceptance criteria/references appended to the roadmap-derived bar" },
      authorization: { type: "object", description: "Approved bounded policy: required_review_roles, verification_commands, model_preferences, limits (submissions, concurrency, repairs, attempts_per_submission=1, launch_deadline). Scope, actor and providers are frozen from this launch." },
      model_preference: { type: "object", description: "Explicit recorded model/reasoning_effort/strict override for this submission" },
      continuation_record: { type: "object", description: "Optional fresh inspected desktop heartbeat receipt; otherwise a new bounded run returns a monitoring handoff before submission" },
      confirm_continuation: { type: "boolean", description: "Explicit lead inspection of the supplied desktop continuation receipt" },
      implementation_tier: { type: "string" }, critic_tier: { type: "string" }, repair_tier: { type: "string" },
      implementation_provider: { enum: ["claude", "codex"] }, critic_provider: { enum: ["claude", "codex"] }, repair_provider: { enum: ["claude", "codex"] },
      force: { type: "boolean", description: "explicitly override the roadmap cycle lock for this run" },
      critic_profile: { type: "string", description: "optional machine-local Routine profile label for critics" } } } },
  { name: "gauntlet_status", description: "Reconstruct a Gauntlet run from the local launch ledger plus GitHub PR/body/head/checks/comments and protected claim refs. Strictly read-only, including when exposing a different winning protocol to a distributed loser. Reports stale or unacknowledged worker verdicts as non-authoritative, detects claim/attestation and repair-history gaps, and returns the safe next actuator(s).",
    inputSchema: { type: "object", anyOf: [{ required: ["run"] }, { required: ["all"], properties: { all: { const: true } } }], properties: {
      run: { type: "string", description: "run id or roadmap subject key" }, all: { type: "boolean", description: "Read implementation and evaluation portfolio, including protected runs after local ledger loss. Reports partial discovery explicitly." } } } },
  { name: "gauntlet_ack", description: "After the frozen lead independently inspects one exact critic comment from gauntlet_status, post a lead-authored acknowledgment bound to both its immutable body digest and exact GitHub comment-URL digest. A worker verdict cannot drive PASS/REVISE until acknowledged. Requires the exact comment URL and explicit confirmation.",
    inputSchema: { type: "object", required: ["run", "comment_url", "confirm"], properties: {
      run: { type: "string" }, comment_url: { type: "string", minLength: 1 }, confirm: { const: true } } } },
  { name: "gauntlet_critic", description: "Fire one fresh-context independent critic for an exact open PR head. Refuses when the expected SHA is stale, checks are unstable/failing, or the same run/head/critic role is already launched. The critic receives the frozen bar and artifact—not builder reasoning—and posts a structured SHA-pinned GitHub candidate verdict that remains non-authoritative until frozen-lead acknowledgment.",
    inputSchema: { type: "object", required: ["run", "expected_head"], properties: {
      run: { type: "string" }, expected_head: { type: "string", pattern: "^[a-f0-9]{40}$" },
      critic_role: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "one selected critic role for this run/head; defaults to critic" },
      tier: { type: "string" }, profile: { type: "string" }, provider: { enum: ["claude", "codex"] },
      confirm_recovered_bar: { type: "boolean", description: "after ledgerless recovery or discovery of a different distributed-election winner, explicitly attest as that packet's frozen lead that its bar still matches lead/human intent before local adoption and re-criticism" },
      force_checks: { type: "boolean", description: "explicitly review despite pending/failing checks; SHA safety is never bypassed" } } } },
  { name: "gauntlet_repair", description: "Fire a fresh repair Routine against the existing PR at an exact expected head, using a lead-synthesized repair packet. Requires a frozen-lead-acknowledged current-head REVISE verdict, refuses duplicates/stale heads/exhausted rounds, and never creates or merges a competing PR.",
    inputSchema: { type: "object", required: ["run", "expected_head", "packet"], properties: {
      run: { type: "string" }, expected_head: { type: "string", pattern: "^[a-f0-9]{40}$" },
      packet: { type: "string", minLength: 1, maxLength: 50000 }, tier: { type: "string" }, profile: { type: "string" }, provider: { enum: ["claude", "codex"] } } } },
  { name: "gauntlet_cancel", description: "Explicitly abandon a stuck or ambiguous Gauntlet run while preserving all launch receipts. Human confirmation and a reason are required. A protected pre-PR tombstone prevents delayed-PR resurrection after ledger loss; the detailed reason remains local until a PR comment exists. An existing GitHub PR is never closed or deleted.",
    inputSchema: { type: "object", required: ["run", "reason", "confirm"], properties: {
      run: { type: "string" }, reason: { type: "string", minLength: 1, maxLength: 2000 }, confirm: { const: true } } } },
];

const EVALUATION_TOOLS = [
  { name: "gauntlet_eval_continuation", description: "Record a fresh inspected supported-desktop heartbeat receipt for this bounded evaluation. The fixed lead task and automation ID must match; PAUSED or stale state blocks new launches. Registration does not prove a scheduled wake or provider model. Does not start its own scheduler.",
    inputSchema: { type: "object", required: ["run", "record", "confirm"], properties: { run: { type: "string" }, record: { type: "object" }, confirm: { const: true } } } },
  { name: "gauntlet_eval_decision", description: "Append an inspected lead reporting decision for a finding, regression or human intervention on the exact evidence PR head. Binds an immutable comment digest and preserves attributable corrections. Does not replace packet admission, critic acknowledgment, scoped repair approval or sealing.",
    inputSchema: { type: "object", required: ["run", "expected_head", "record", "confirm"], properties: { run: { type: "string" }, expected_head: { type: "string" }, record: { type: "object" }, confirm: { const: true } } } },
  { name: "gauntlet_eval_launch", description: "Launch the specified frozen evaluation wave using protected authorization and durable capacity reservations. Exactly one attempt per submission; duplicate or ambiguous reservations never cause a blind resubmission. Does not authorize new scope.",
    inputSchema: { type: "object", required: ["run", "wave"], properties: { run: { type: "string" }, wave: { type: "string" } } } },
  { name: "gauntlet_eval_reconcile", description: "After the frozen lead inspects an exact cloud task and verifies its association with an unresolved launch, bind its exact ID/URL to the protected reservation. Records an attributable reason and observes that same task. Never guesses by recency, replaces an existing receipt or replenishes spent submissions.",
    inputSchema: { type: "object", required: ["run", "launch_key", "task_id", "task_url", "reason", "confirm"], properties: {
      run: { type: "string" }, launch_key: { type: "string" }, task_id: { type: "string" }, task_url: { type: "string" }, reason: { type: "string" }, confirm: { const: true } } } },
  { name: "gauntlet_eval_authorize", description: "Freeze the human-approved evaluation scope, providers, role preferences, reviews and launch/concurrency/repair/deadline ceilings in protected GitHub state. Requires an approved policy file and confirmation. Existing authority cannot be replaced and lost local state cannot replenish budgets.",
    inputSchema: { type: "object", required: ["run", "authorization", "confirm"], properties: { run: { type: "string" }, authorization: { type: "string" }, confirm: { const: true } } } },
  { name: "gauntlet_eval_attach", description: "Bind the single lead-owned evidence PR to an authorized run at an exact expected head. Refuses product changes or a competing evidence PR. Does not create or merge a PR.",
    inputSchema: { type: "object", required: ["run", "pr", "expected_head", "confirm"], properties: { run: { type: "string" }, pr: { type: "integer", minimum: 1 }, expected_head: { type: "string" }, confirm: { const: true } } } },
  { name: "gauntlet_eval_accept", description: "After the lead inspects claims and attachments for truth and redaction, record an authenticated GitHub accepted/rejected decision bound to the exact packet digest. Acceptance requires valid committed content at the current evidence PR head. A rejection does not turn missing evidence into resolved coverage.",
    inputSchema: { type: "object", required: ["run", "assignment", "packet_digest", "expected_head", "decision", "reason", "redaction_inspected", "confirm"], properties: {
      run: { type: "string" }, assignment: { type: "string" }, packet_digest: { type: "string" }, expected_head: { type: "string" },
      decision: { enum: ["accepted", "rejected"] }, reason: { type: "string" }, redaction_inspected: { const: true }, confirm: { const: true } } } },
  { name: "gauntlet_eval_critic", description: "Launch the next required independent corpus critic within frozen authority. Requires all expected packets adjudicated unless allow_incomplete explicitly requests diagnostic review; unresolved evidence cannot receive acknowledged PASS or seal. Requires an exact evidence PR head, stable checks and available durable capacity. Required roles run sequentially. No fallback.",
    inputSchema: { type: "object", required: ["run", "expected_head"], properties: { run: { type: "string" }, expected_head: { type: "string" }, critic_role: { type: "string" }, allow_incomplete: { type: "boolean", description: "Explicitly review missing/invalid evidence to obtain independent findings for acknowledged scoped repair; never bypass admission or sealing." } } } },
  { name: "gauntlet_eval_repair", description: "Launch a fresh documentation-only repair worker using a versioned lead-synthesized packet file. Every finding must name an acknowledged current-head REVISE comment and explicit permitted documentation paths. Reserves frozen submission/concurrency/repair capacity. The worker commits locally; only the lead publishes.",
    inputSchema: { type: "object", required: ["run", "expected_head", "packet"], properties: { run: { type: "string" }, expected_head: { type: "string" }, packet: { type: "string", description: "Path to the inspected lead repair YAML/JSON packet" } } } },
  { name: "gauntlet_eval_collect_repair", description: "Preview an exact repair receipt diff against its frozen expected head and lead-approved file list, validating all packets. apply=true applies that exact patch and invalidates changed packet admissions by digest. Refuses moved heads or local conflicts; never rebases or force-pushes a repair.",
    inputSchema: { type: "object", required: ["run", "launch_key"], properties: { run: { type: "string" }, launch_key: { type: "string" }, apply: { type: "boolean" } } } },
  { name: "gauntlet_eval_ack", description: "After real lead inspection, acknowledge one immutable exact-head critic comment using the shared Gauntlet body-and-URL digest protocol. Authorization does not permit rubber-stamping. Refuses stale or changed criticism.",
    inputSchema: { type: "object", required: ["run", "expected_head", "comment_url", "confirm"], properties: { run: { type: "string" }, expected_head: { type: "string" }, comment_url: { type: "string" }, confirm: { const: true } } } },
  { name: "gauntlet_eval_seal", description: "Post a lead GitHub seal attestation for an adjudicated corpus with every mandatory reviewer acknowledged PASS on the current evidence PR head. No file commit moves the sealed head. Later content/head changes invalidate sealing. Never merges.",
    inputSchema: { type: "object", required: ["run", "expected_head", "confirm"], properties: { run: { type: "string" }, expected_head: { type: "string" }, confirm: { const: true } } } },
  { name: "gauntlet_eval_observe", description: "Refresh exact cloud receipts into the protected authorization journal. Terminal observations release concurrency, not spent submissions. Failed queries, missing tasks and ambiguous submissions remain unresolved; durable fingerprints deduplicate unchanged observations across restarts.",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string" } } } },
  { name: "gauntlet_eval_status", description: "Read-only evaluation view of exact provider receipts, publication, admission, review, seal and remaining authorization limits. Explicitly reports observation failures and legacy verification gaps.",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string" } } } },
  { name: "gauntlet_eval_recover", description: "Preview restart recovery from protected GitHub scope, reservations and exact receipts. confirm=true restores only a missing local manifest, preserving committed history when a PR exists. Never resets budgets, silently adopts changed scope or overwrites local files.",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string" }, confirm: { type: "boolean" } } } },
  { name: "gauntlet_eval_validate", description: "Read-only validation of a local versioned evidence packet against its frozen source Git tree. Checks identity, evidence links, artifacts and detected prohibited data. Does not accept claims, attest redaction, launch agents or seal a run.",
    inputSchema: { type: "object", required: ["run", "assignment"], properties: { run: { type: "string" }, assignment: { type: "string" } } } },
  { name: "gauntlet_eval_collect", description: "Inspect an exact Codex task's packet patch. Defaults to read-only preview. apply=true revalidates then applies only that same patch, refusing dirty packet files or unsafe artifacts. A validated packet is not yet lead-accepted. Never launches a replacement worker.",
    inputSchema: { type: "object", required: ["run", "assignment"], properties: { run: { type: "string" }, assignment: { type: "string" }, apply: { type: "boolean" } } } },
  { name: "gauntlet_eval_migrate", description: "Preview explicit legacy evidence-run migration. confirm=true preserves the original manifest and packets but removes inferred sealing/acceptance. Historical receipts remain attributable and unverified; nothing is launched.",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string" }, confirm: { type: "boolean" } } } },
];

for (const tool of [...GAUNTLET_TOOLS, ...EVALUATION_TOOLS]) {
  if (!["gauntlet_start", "gauntlet_critic", "gauntlet_repair", "gauntlet_eval_launch", "gauntlet_eval_critic", "gauntlet_eval_repair"].includes(tool.name)) continue;
  tool.inputSchema.properties.model_preference = { type: "object", additionalProperties: false,
    description: "Explicit recorded model/effort override. Unsupported preferences warn; strict requests fail, without fallback.",
    properties: { model: { type: "string" }, reasoning_effort: { type: "string" }, strict: { type: "boolean" } } };
}

export const ENGINEERING_TOOLS = [...CLOUD_TOOLS, ...GAUNTLET_TOOLS, ...EVALUATION_TOOLS];

// Returns undefined when `name` is not an engineering tool (the server then tries the next group).
export function callEngineeringTool(name, args, { root }) {
  const repoRoot = () => root;
  if (EVALUATION_TOOLS.some((tool) => tool.name === name)) {
    const action = name.slice("gauntlet_eval_".length).replaceAll("_", "-");
    const argv = [action, "--run", args.run];
    for (const name of ["assignment", "authorization", "pr", "expected_head", "decision", "packet_digest", "reason", "comment_url", "critic_role", "packet", "launch_key", "task_id", "task_url", "wave"]) {
      if (args[name] != null) argv.push(`--${name.replaceAll("_", "-")}`, String(args[name]));
    }
    if (args.apply === true) argv.push("--apply");
    if (args.confirm === true) argv.push("--confirm");
    if (args.redaction_inspected === true) argv.push("--redaction-inspected");
    if (args.allow_incomplete === true) argv.push("--allow-incomplete");
    return runEvaluation(repoRoot(), argv, { modelPreference: args.model_preference || null, decisionRecord: args.record || null, continuationRecord: args.record || null });
  }
  if (name === "dispatch") {
    // async; runDispatch fires the routine (or the Linear @-mention) and returns the session/comment.
    return runDispatch(repoRoot(), args.key, { force: !!args.force, provider: args.provider, attempts: args.attempts });
  }
  if (name === "fan_cloud") {
    // preview unless confirm=true; runFanCloud loops runDispatch over the ready wave.
    return runFanCloud(repoRoot(), args || {});
  }
  if (name === "gauntlet_start") {
    return runGauntletStart(repoRoot(), args.key, {
      maxRounds: args.max_rounds, additionalBar: args.bar,
      implementationTier: args.implementation_tier, criticTier: args.critic_tier,
      repairTier: args.repair_tier, implementationProvider: args.implementation_provider,
      criticProvider: args.critic_provider, repairProvider: args.repair_provider,
      criticProfile: args.critic_profile, force: !!args.force,
      authorizationPolicy: args.authorization, modelPreference: args.model_preference,
      continuationRecord: args.continuation_record, confirmContinuation: args.confirm_continuation === true,
    });
  }
  if (name === "gauntlet_status") return args.all === true ? runGauntletPortfolio(repoRoot(), {}) : runGauntletStatus(repoRoot(), args.run, {});
  if (name === "gauntlet_observe") return runGauntletObserve(repoRoot(), args.run);
  if (name === "gauntlet_continuation") return runGauntletContinuation(repoRoot(), args.run, { record: args.record, confirm: args.confirm === true });
  if (name === "gauntlet_decision") return runGauntletDecision(repoRoot(), args.run, { expectedHead: args.expected_head, record: args.record, confirm: args.confirm === true });
  if (name === "gauntlet_reconcile") return runGauntletReconcile(repoRoot(), args.run, { launchKey: args.launch_key,
    taskId: args.task_id, taskUrl: args.task_url, reason: args.reason, confirm: args.confirm === true });
  if (name === "gauntlet_ack") return runGauntletAcknowledge(repoRoot(), args.run,
    { commentUrl: args.comment_url, confirm: args.confirm === true });
  if (name === "gauntlet_critic") {
    return runGauntletCritic(repoRoot(), args.run, {
      expectedHead: args.expected_head,
      criticRole: args.critic_role, tier: args.tier, profile: args.profile, provider: args.provider, forceChecks: !!args.force_checks,
      modelPreference: args.model_preference,
      confirmRecoveredBar: !!args.confirm_recovered_bar,
    });
  }
  if (name === "gauntlet_repair") {
    return runGauntletRepair(repoRoot(), args.run, {
      expectedHead: args.expected_head, packet: args.packet, tier: args.tier, profile: args.profile, provider: args.provider,
      modelPreference: args.model_preference,
    });
  }
  if (name === "gauntlet_cancel") return runGauntletCancel(repoRoot(), args.run, { reason: args.reason, confirm: args.confirm === true });
  return undefined;
}
