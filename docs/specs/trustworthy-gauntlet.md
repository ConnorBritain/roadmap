# Trustworthy Gauntlet execution

Status: implementation in progress. This document records the approved scope, not a claim of qualification.

Current delivery checkpoint (2026-09-06): Roadmap PRs #52–#54 contain the tested
implementation; phase-four PR #55 records live receipts. The bounded Pidgeon run
has collected and admitted all five repaired packets after independent REVISE and
lead acknowledgment. Fresh exact-head PASS and sealing are still pending. See
[the qualification receipt index](../qualification/2026-09-06-pidgeon.md) for
current evidence and limits. The implementation ledger below is chronological;
earlier preparation and pending statements describe their recorded stage, not
the current state. No merge, npm publication or full-program launch is authorized.

## Goal

Upgrade Roadmap so an authorized Codex desktop lead can conduct implementation and documentation-evaluation Gauntlets through independently reviewed PRs, with enforceable evidence admission, bounded execution, restart-safe continuation, and durable results. Prove the workflow with a documentation-only Pidgeon qualification.

The program prefers `gpt-6-astra` at `high` effort for the lead and `medium` for cloud builders, evaluators, critics, and repairs. Preserve existing consumer defaults. Preferred settings may be unsupported: explicitly report the provider-managed default as unverified rather than inventing model identity. Strict requests fail. No silent provider, local-execution, or API-billing fallback.

## Deliverables

1. Evidence admission: versioned packets, frozen-source reference validation, report/evidence links, safe declared artifacts, prohibited-data detection, read-only previews, exact validated-patch application, digest-bound lead adjudication, and non-destructive legacy migration.
2. Evaluation review/repair: one lead-owned evidence PR; independent exact-head critic, lead acknowledgment, scoped cloud packet repair, fresh review, and GitHub seal attestation bound to head and corpus digest. Reuse the main Gauntlet trust primitives. Product-source SHA and evidence-PR head remain distinct.
3. Bounded authorization: frozen scope/providers/model preferences/review roles/launch/concurrency/repair/deadline limits; reservation before submission; ambiguous submissions consume capacity; atomic local mutations and durable GitHub reservations survive retries and ledger loss. Expiry stops launches, not observation or collection.
4. Observation: implementation and evaluation portfolio JSON status, publication/admission/review/budget state, cloud completion before PR creation, durable event fingerprints, restart catch-up, and explicit observation errors. Gauntlet setup must not depend on invoking fanout.
5. Continuation: one supported 30-minute Codex desktop heartbeat for the lead. Refresh reality and take authorized actions; stay quiet on unchanged state. Pause at completion or renewed-authority gates. No embedded scheduler or blind repair loop.
6. Review/reporting: one independent critic minimum; explicitly frozen sequential specialist roles must all pass the current head; approved executable checks separate from judgments; report repairs, findings, regressions, interventions, elapsed time and trustworthy provider usage only.

The lead may launch, collect, inspect, acknowledge, repair and update the evidence PR inside the approved policy without repeated human confirmation. Inspection is mandatory: authorization is not a rubber stamp. Worker output is untrusted. Credentials, patient/customer data, raw transcripts and production operations are prohibited in qualification.

## Interfaces and compatibility

Retain existing commands; add evaluation `validate`, `accept`, `critic`, `ack`, `repair`, and explicit `migrate`, with CLI/MCP parity. Add `gauntlet status --all --json` and read-only run reporting. Unsupported versions fail closed for mutation; old runs remain inspectable and never inherit acceptance from timestamps or historical sealing. Preserve old packets and receipts during explicit migration.

Packet stages distinguish collected, validated, accepted and rejected. Validation does not establish a claim's truth. Accepted packet content is identified by digest; changes invalidate the decision. A seal requires expected packets adjudicated and an acknowledged PASS for the actual current corpus head. Derived totals must agree with individual records. No source mutation is permitted during documentation evaluation.

## Required verification

- Malformed/missing YAML/files, duplicate IDs, wrong identity/SHA, unsafe paths/modes/symlinks, unsupported evidence and prohibited-data fixtures fail admission.
- Preview/validation are read-only; failed apply does not mark collection; only the exact validated diff is applied and conflicts are refused.
- Unaccepted or changed artifacts cannot seal; changed heads invalidate reviews and sealing.
- Duplicate calls, concurrent leads, lost submission responses, restarts and ledger loss do not duplicate work or replenish budgets.
- Implementation and evaluation demonstrate REVISE -> acknowledgment -> scoped repair -> fresh PASS; specialist verdicts cannot substitute for each other.
- Preferred/strict model settings and unknown actual settings are honest; existing consumer defaults remain compatible.
- Known-defective and clean fixtures exercise critic misses/false alarms without contaminating real findings.
- Run npm tests, roadmap validation against fixtures, and packed-package CLI/MCP smoke tests.

## Live qualification

Use an isolated lead checkout from current Pidgeon remote main; preserve the dirty primary checkout and PR #2257. Use a new run under `docs/gauntlets/cross-app-coherence/evaluation/runs/`, source-only assignments for the five canonical surfaces, one consolidated lead-published documentation PR, and exact cloud receipts. No per-worker local worktrees. Keep labelled synthetic repair fixtures separate from real product findings.

Limits: 20 cloud submissions, four concurrent workers, three repair rounds, a 72-hour launch window, one provider attempt per submission. Demonstrate a scheduled wake-up and restart recovery without manual worker-text shuttling. Budget exhaustion or infrastructure failure means incomplete qualification, never PASS.

Completion requires review-ready Roadmap PRs, passing tests, a live qualified workflow, an acknowledged current-head PASS on the unmerged Pidgeon documentation PR, and a durable closeout recording evidence, limitations, model-verification status, receipts and human decisions. Merge, npm publication, production actions, full-program launch, Omnara qualification, broad historical cleanup and new execution providers are excluded.

## Implementation ledger

- Baseline: main/npm 0.7.2; packet-commit instructions from draft PR #51 are included in the implementation branch. Baseline tests: 355 passed.
- Phase 1 implemented: version 1 packet validation, exact-patch collection, non-destructive legacy migration, CLI/MCP admission interfaces, packet contract and installed-package smoke test. Lead acceptance remains part of phase 2, not implied by validation.
- Phase 1 verification: 382 automated tests passed; `npm run validate -- scripts/test/fixtures/admission/roadmap.yaml` passed; `npm pack` ran the suite and installed-tarball CLI/MCP admission smoke tests passed. The repository has no canonical `docs/roadmap/roadmap.yaml`, so bare `npm run validate` reports a missing file; the committed fixture is the applicable validation target.
- Phase 2 implemented for evaluation: protected GitHub compare-and-swap authority journal; append-only reservations and observation fingerprints; bounded evaluator/critic/repair launches; exact-head digest-bound lead admission; shared independent critic/ack protocol; scoped repair collection; current-head GitHub sealing; missing-manifest recovery. Existing implementation entrypoints still need bounded-authority integration.
- Model-policy foundations are present: program role preferences remain requested rather than verified actual settings; unsupported preferences warn and strict requests fail before reserving capacity. Ordinary dispatch/implementation interface wiring, override/reporting surfaces and desktop lead verification remain pending.
- Phase 2 verification is in progress. The full evaluation REVISE/ack/repair/re-admission/fresh PASS/seal path and restart/lost-response/concurrent-conductor cases run through injected transports; no new live Cloud submission has been made.
- Read-only Cloud probe (2026-09-06): the configured Pidgeon environment is reachable, and existing task `task_e_6a8135499678832b921eee1ef606fc31` reports READY. This is a prior task, not the new qualification. READY is tracked as completed artifact availability, never PASS or PR publication.
- Review limitation: the supported Cloud diff interface does not expose an authoritative worker commit SHA. Preserve the commit instruction but record its verification as unknown; integrity enforcement uses exact patch/packet digests and the evidence PR head. Never invent a remote commit receipt.
- Phase 2 delivered as stacked PR #53 after 419 passing tests and a packed CLI/MCP smoke check. No merge or publication performed.
- Phase 3 candidate: bounded implementation policy at start, protected pre-PR recovery, capacity reservations around implementation/critic/repair, required sequential reviewers, model overrides, exact provider observation, and read-only portfolio discovery. Legacy consumers remain compatible and explicitly unverified for bounded authorization.
- The 30-minute heartbeat `trustworthy-gauntlet-lead-continuation` is registered on this lead task. Registration is not a scheduled-wake or live qualification receipt. See [continuation instructions](../GAUNTLET_CONTINUATION.md).
- Pidgeon preflight: existing rules do not protect the authorization namespace. Establish a trusted-lead bypass excluding workers before any bounded qualification launch. The dirty primary checkout and PR #2257 remain untouched.
- Remaining: final phase-3 review/packed tests, complete continuation qualification and decision instrumentation, live fixtures/receipts/evidence PR/closeout. No live qualification or goal completion is claimed.
- Phase-3 checkpoint: 424 automated tests and applicable roadmap validation pass. Installed-tarball CLI/MCP smoke passes. The implementation fixture covers protected pre-PR recovery and the full REVISE/ack/repair/fresh-PASS loop; these injected fixtures are not live provider qualification.
- Before claiming complete: finish runtime monitoring handoff/receipts and verified scheduled wake; add implementation ambiguous-receipt reconciliation parity and fuller explicit decision metrics; inspect independent Roadmap review feedback; qualify the isolated Pidgeon checkout/environment and protected rules; run the bounded five-surface evaluation plus labelled synthetic repair; retain one unmerged evidence PR, current-head acknowledged PASS, restart/wake receipts and closeout. Do not treat a draft delivery PR or unknown metrics as completion.
- Follow-up checkpoint: implementation exact-receipt reconciliation now works before publication and after local-ledger loss, without a new submission or budget reset. Both modes expose attributable lead decision records with append-only corrections and recorded-only reporting for findings, regressions and human interventions. 428 automated tests pass. These reporting records do not substitute for admission or review acknowledgment.
- The desktop heartbeat is paused awaiting the user's decision about the trusted lock-branch bypass policy. No approval, live worker launch or scheduled-wake receipt is inferred from the goal's automatic continuation.
- Monitoring handoff implemented: new bounded launches require a fresh lead-attested ACTIVE desktop heartbeat receipt, with CLI/MCP parity and protected append-only history. Missing monitoring returns a setup handoff before submission; paused/stale monitoring blocks new launches without blocking observation or collection. Registration remains distinct from proof of a scheduled wake. Fixture coverage includes both execution entrypoints and missing, stale, paused, wrong-actor and changed-task receipts.
- Review follow-through: changing admission at an unchanged PR head now permits a fresh critic bound to the new corpus digest instead of leaving an obsolete critic marked in flight. The earlier PASS cannot seal the changed corpus; a distinct budgeted submission, fresh result and acknowledgment are required. The 431-test suite covers that complete transition. PR #52 review replies document the Windows launcher fix and retain authoritative worker-commit verification as an unresolved provider-interface limitation, not an inferred success.
- PR #53 follow-through in the stacked continuation candidate: normalize and validate committed recovery manifests before adoption; record known pre-provider stops as terminal `not_submitted` without refunding submission budgets or inventing receipts; detect unquoted structured patient fields without echoing values. The 436-test suite includes recovery, deadline crossing, ambiguity-preservation and prohibited-data regressions. The owner approved the narrow Pidgeon protection policy; ruleset 22385299 is configured and the resumed desktop heartbeat delivered a scheduled wake at 2026-09-06T12:51:54.747Z. These are preparation/continuation receipts, not live qualification PASS.

Official reference: [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra), [Codex cloud CLI](https://learn.chatgpt.com/docs/developer-commands#codex-cloud), [scheduled tasks](https://learn.chatgpt.com/docs/automations). Model and host capabilities must be verified at qualification time.
