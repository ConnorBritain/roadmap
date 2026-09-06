# Bounded execution and desktop continuation

Roadmap supplies exact observations, durable reservations, admission checks and review
actuators. The lead inspects criticism and synthesizes repairs. Nothing merges automatically.

## Implementation authorization

Start a new bounded implementation run with an approved JSON policy:

```text
roadmap gauntlet start <slice> --authorization-file <approved-policy.json> --max-rounds 3 --implementation-provider codex --critic-provider codex --repair-provider codex
```

The policy has the same `required_review_roles`, `verification_commands`, `model_preferences`
and `limits` fields as the [evaluation policy](EVALUATION_RUNBOOK.md). Its repair limit must
match `--max-rounds`. Roadmap freezes the roadmap-derived bar, source SHA, lead GitHub actor,
providers and Cloud environment in protected authorization before submission.

Existing calls without a policy remain compatible but are `legacy_unverified` for bounded
authorization. Do not use them to claim this program's bounded qualification. Existing
protected policy cannot be replaced by omitting the flag, deleting the local ledger,
changing providers, or restarting before PR publication.

Every bounded launch reserves capacity before submission. Ambiguity retains capacity.
Terminal observations release concurrency, not spent submissions or repair counts.

```text
roadmap gauntlet observe <run>
roadmap gauntlet status <run> --json
roadmap gauntlet status --all --json
```

If a submission response was lost, inspect the exact cloud task and establish that its
instructions match the reserved request. Then use:

```text
roadmap gauntlet reconcile <run> --launch-key <reserved-key> --task-id <exact-task-id> --task-url <exact-task-url> --reason "Inspected exact task and frozen request" --confirm
```

This works before publication and after local-ledger loss. It requires an observable exact
Codex task, records the frozen lead's association decision, and cannot replace a receipt,
launch another worker, or replenish spent budget. It is not provider-verified prompt identity.
If the task cannot be identified, leave the reservation unresolved. Unsupported provider
observation remains explicit rather than being inferred from task recency or a worker report.

Portfolio status discovers implementation PRs, local evaluation manifests and protected
authority branches. Partial discovery is explicit; legacy PR search warns at its 100-result
limit. Review comments can be observed from another checkout, but admission/seal verification
requires the exact evidence-PR checkout. Missing access is an observation gap, not PASS.

A formal run requires a fresh `critic`. Frozen specialist roles execute sequentially and all
must pass the current head. A later head restarts all roles. Executable checks remain separate
from agent judgments; workers may run only frozen approved verification commands.

## Honest model policy and reporting

The qualification requests `gpt-6-astra` high for the lead and medium for cloud roles. This is
an operating experiment, not a claim of optimality. Existing consumer defaults are unchanged
unless configured.

Optional `meta.gauntlet.model_preferences` and bounded policy accept `lead`, `cloud`,
`implementation`, `evaluator`, `critic`, and `repair`. Values contain `model`,
`reasoning_effort`, and optional `strict`; role-specific fields override the cloud fallback.
Launch actions accept explicit recorded `--model` and `--reasoning-effort` overrides.
`--strict-model` requires transport enforcement.

Requested values, transport support and provider-reported actual values are separate receipt
fields. The supported Cloud CLI cannot enforce per-task model/effort settings: preferences
warn and proceed, strict requests fail. Routine tiers also do not verify actual model identity.
Neither worker self-description nor prompt text verifies a model. No local/API/provider
fallback occurs.

Reporting includes submissions, run age, repairs, known accepted repair findings and packet
decisions. Run age is not compute duration or time-to-PASS. Missing monetary usage is `null`,
not an invented token-price estimate.

### Attributable decision metrics

Both execution modes can append inspected lead reporting records to protected GitHub state:

```text
roadmap gauntlet decision <run> --expected-head <sha> --record-file <decision.json> --confirm
roadmap gauntlet eval decision --run <run> --expected-head <sha> --record-file <decision.json> --confirm
```

The corresponding MCP tools accept the record object directly. A version 1 record contains
`id`, `kind`, `outcome`, `head`, `reference_url`, and `reason`. Reference an immutable comment
on the run's current open PR; Roadmap computes its body digest rather than trusting a supplied
digest. Supported combinations are `finding: accepted|rejected`,
`regression: observed|cleared`, and `human_intervention: occurred`.

A correction must set `supersedes` to the latest same-kind/ID record fingerprint returned in
status. Earlier revisions remain attributable; retries do not duplicate records. This makes
reported counts useful without silently erasing earlier judgments.

These are explicitly `lead_reported`, with `recorded_decisions_only` coverage. Counts do not
claim that unrecorded events never happened; missing metric categories remain `null` in the
portfolio summary. Decision records are reporting only: they do not accept evidence packets,
acknowledge criticism, approve repairs, seal a corpus, or prove an underlying claim.

## Desktop lead heartbeat

Create one 30-minute heartbeat in the existing lead task using the supported desktop
scheduling tool. Do not build cron, shell polling, or a new task per wake; `/fanout` is not a
prerequisite. The CLI cannot create a desktop scheduled task itself. The lead must establish
and verify monitoring when entering a Gauntlet; registration is not proof a wake ran.

New bounded authorizations freeze a 30-minute cadence and a 60-minute freshness bound.
Implementation `start` and evaluation `launch` return `awaiting_continuation` without
submitting a worker when no fresh ACTIVE receipt is recorded. Observation, collection and
adjudication remain available while monitoring is paused or stale. Legacy runs are readable
but do not acquire verified continuation retroactively.

After inspecting the supported desktop tool result, prepare a receipt record:

```json
{
  "version": 1,
  "kind": "codex_desktop_heartbeat",
  "interval_minutes": 30,
  "automation_id": "YOUR-AUTOMATION-ID",
  "target_thread_id": "YOUR-EXISTING-LEAD-TASK-UUID",
  "status": "ACTIVE",
  "observed_at": "CURRENT-ISO-TIMESTAMP",
  "receipt": { "automationId": "YOUR-AUTOMATION-ID", "status": "ACTIVE" }
}
```

Replace placeholders with observed values, not intended settings. `receipt` contains the
tool-returned automation identity and status; only its digest is persisted, never credentials
or a raw transcript. The observation must be within five minutes when recorded. Use:

```sh
roadmap gauntlet continuation RUN --receipt-file desktop-receipt.json --confirm
roadmap gauntlet eval continuation --run RUN --receipt-file desktop-receipt.json --confirm
```

These are alternatives for implementation and evaluation respectively. Matching MCP tools
are `gauntlet_continuation` and `gauntlet_eval_continuation`. A bounded implementation start
may also supply `--continuation-file desktop-receipt.json --confirm-continuation`. Otherwise,
record the receipt and retry the same frozen run; do not create a new run to bypass the gate.
Each wake should inspect the desktop schedule and refresh its receipt before further launches.
Record PAUSED when pausing. The automation and target task cannot silently change within a run.

The protected record is explicitly **lead-attested**, not independently queried or verified
by the CLI. It establishes the inspected scheduling handoff, not proof that the host will stay
online or a future wake will execute. Status always leaves `wake_verified` false for registration;
the live qualification must retain separate evidence of an actual scheduled wake.

Before launch, record automation ID, target task, state, cadence and model-verification status
in qualification notes. Test a wake and retain its receipt. The heartbeat must:

1. Read frozen policy and current GitHub/provider reality. Reconcile exact receipts with
   `observe` and read `status --all --json`; never associate tasks by recency.
2. Take only authorized next actions. Inspect packet truth/redaction and exact critic artifacts
   before admission/acknowledgment. Synthesize scoped repairs; never rubber-stamp.
3. Stop new launches at the deadline/ceiling; continue collecting existing work.
4. Stay quiet on unchanged/non-actionable state. Notify completion, actionable failure or
   required input. Pause at completion or when renewed authority is required.

Keep the host powered on, desktop app running and checkout accessible. Offline time is not
unattended progress. See [Scheduled tasks](https://learn.chatgpt.com/docs/automations).

## Program qualification status

On 2026-09-06 the desktop tool registered `trustworthy-gauntlet-lead-continuation` on lead task
`019fe38d-cc08-7111-817c-16243fa451c1`, with a 30-minute cadence. No scheduled wake or live
Pidgeon PASS is claimed. It inherits lead task settings; actual model/effort has not been
independently verified.

The heartbeat was subsequently paused pending the human decision on the lock-branch bypass
policy. Resume it through the supported desktop tool after that authority is settled; do not
interpret a paused schedule as active monitoring.

Read-only Pidgeon preflight found that `evaluation branches protected` covers `roadmap-eval/**`
against deletion/force-push only. The authorization namespace `roadmap-gauntlet-locks/*` needs
creation/update/deletion/non-fast-forward protection and verified trusted-lead bypass excluding
workers. Never use unsafe claims to bypass qualification.

The dirty primary Pidgeon checkout and open PR #2257 are preserved. Live qualification,
scheduled-wake demonstration, evidence PR and closeout remain incomplete.

### Subsequent approval and scheduled wake

The owner approved the narrow protection policy. Pidgeon ruleset 22385299 now protects
`refs/heads/roadmap-gauntlet-locks/*` with creation/update/deletion/non-fast-forward rules
and repository-administrator bypass only; no worker App bypass was added. Effective matching
was checked read-only. This is configuration verification, not a destructive worker test.
The existing desktop heartbeat was resumed through the supported scheduling tool.

The lead received an actual scheduled wake at `2026-09-06T12:51:54.747Z` for
`trustworthy-gauntlet-lead-continuation` and resumed the PR #53 review fixes. This demonstrates
scheduled task continuation, not a Cloud completion event, a verified model setting or a live
qualification PASS. The frozen Pidgeon source is `363e147bb75833f1c279aad76e20673e2865d0ed`;
the isolated lead run is `dcm-qualification-2026-09-06`. Live submissions and their restart
recovery still require qualification after the corrected candidate passes its checks.
