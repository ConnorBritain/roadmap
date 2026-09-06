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
decisions. Missing rejection/regression/intervention totals and monetary usage are `null`,
not invented zeroes or price estimates. Fuller explicit decision instrumentation remains a
delivery dependency. Run age is not compute duration or time-to-PASS.

## Desktop lead heartbeat

Create one 30-minute heartbeat in the existing lead task using the supported desktop
scheduling tool. Do not build cron, shell polling, or a new task per wake; `/fanout` is not a
prerequisite. The CLI cannot create a desktop scheduled task itself. The lead must establish
and verify monitoring when entering a Gauntlet; registration is not proof a wake ran.

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

Read-only Pidgeon preflight found that `evaluation branches protected` covers `roadmap-eval/**`
against deletion/force-push only. The authorization namespace `roadmap-gauntlet-locks/*` needs
creation/update/deletion/non-fast-forward protection and verified trusted-lead bypass excluding
workers. Never use unsafe claims to bypass qualification.

The dirty primary Pidgeon checkout and open PR #2257 are preserved. Live qualification,
scheduled-wake demonstration, evidence PR and closeout remain incomplete.
