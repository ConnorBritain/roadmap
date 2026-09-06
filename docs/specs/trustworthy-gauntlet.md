# Trustworthy Gauntlet execution

Status: implementation in progress. This document records the approved scope, not a claim of qualification.

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
- Phases 2–5 and live qualification: not yet implemented or qualified.

Official reference: [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra), [Codex cloud CLI](https://learn.chatgpt.com/docs/developer-commands#codex-cloud), [scheduled tasks](https://learn.chatgpt.com/docs/automations). Model and host capabilities must be verified at qualification time.
