# Trustworthy Gauntlet delivery acceptance map

This maps the approved plan to implementation, executable checks and live evidence.
Automated tests use injected transports unless explicitly identified as live. A
passing fixture is not a claim that every provider or operating system was tested.
The [Pidgeon receipt index](2026-09-06-pidgeon.md) carries the final live outcome.

## Plan requirements and evidence

| Approved requirement | Implementation / inspected verification |
| --- | --- |
| Durable specification and four dependency-ordered deliveries | `docs/specs/trustworthy-gauntlet.md`; PRs #52 → #53 → #54 → #55. Review fixes in later stacked PRs are required; earlier PRs alone are not the complete candidate. |
| PR #51 packet commit instruction; reusable prompts | `buildEvaluationPrompt` in `scripts/lib/evaluation-core.mjs` requires local commits, uses run identity rather than Pidgeon-specific prose, and exposes frozen type limits. Authoritative worker commit SHA remains unavailable; exact diff/packet digests enforce content identity. |
| Versioned report/evidence and declared supporting files | `evaluation-packet.mjs`, `EVIDENCE_PACKETS.md`; tests in `scripts/test/evaluation.mjs` cover missing files, schema version, identity/SHA, IDs, timestamps, limitations, references, citations and declared artifacts. |
| Executed/unexecuted and source/deployed distinction | Packet boundary and test-result validation; malformed/unapproved deployed and inconsistent exit-code fixtures fail. Live product checks are explicitly unexecuted. |
| Frozen-tree provenance, not truth certification | Source resolver validates Git object mode and line bounds. Lead digest-bound admissions and independent critic inspect claims; path existence never asserts truth. |
| Safe paths/modes, undeclared files, prohibited data and human redaction | `evaluation-io.mjs` and packet validator reject traversal, symbolic links, invalid modes and undeclared files. Credential and synthetic patient-field regressions include multiline/blank-line cases without echoing values. No OCR or secrecy guarantee. Live attachments are empty; lead inspection is recorded. |
| Read-only preview/validation, exact patch application, conflicts and failed apply | Collection tests assert unchanged manifest/absent files on preview and failed apply, matching preview/application digests, conflict and symlink refusal. Live invalid Loft patch was not applied; scoped repair preview/application digests match. |
| Separate collected/validated/accepted/rejected states and attributable corrections | `evaluationAdmissionTotals`, immutable lead admission comments and protected journal; tests reject changed/missing packet acceptance. Live earlier rejections remain attributable and all five current digests are accepted. |
| Evaluation CLI/MCP validate, accept, critic, ack and repair; one lead PR | `scripts/evaluate.mjs`, `scripts/mcp.mjs`, `evaluation-review-io.mjs`. Installed CLI/MCP admission parity smoke and full lifecycle fixtures pass. Pidgeon #2270 is the sole lead-owned evidence PR; workers did not publish competing PRs. |
| Independent exact-head review, actual lead acknowledgment, scoped repair | Shared `gauntlet-core.mjs` trust protocol; evaluation and implementation lifecycle tests cover REVISE → acknowledgment → repair → fresh PASS. Stale, edited, replayed or unlaunched verdicts fail. Live REVISE and fresh PASS are separate Cloud tasks, with lead source inspection. |
| Separate source SHA and evidence head; current-head/corpus seal | `evaluation-review-core.mjs`; tests invalidate changed-head, changed-admission, missing/edited attestation and unacknowledged seals. Final live seal/ack links are in the receipt index, not a bookkeeping commit changing the reviewed head. |
| Legacy readable but unverified; explicit nondestructive migration | Migration fixture preserves byte-exact historical manifest backup, packets and receipts, clears inherited sealing/acceptance and tests read-only preview. Recovery validates committed manifests before adoption. |
| Frozen scope/providers/preferences/review roles/checks and execution ceilings | `gauntlet-authorization.mjs`; validation rejects missing independent critic, invalid caps and multiple attempts. Implementation start and evaluation authorization freeze policy in protected GitHub state. Live limits are 20/4/3/72h with one attempt. |
| Reserve before submit, ambiguity, concurrent conductors and lost responses | Shared GitHub compare-and-swap journal; tests exercise competing jobs, independent ledgers, lost CAS/submission responses, missing manifests and explicit receipt reconciliation. Budgets cannot be refunded by restart; unknown observations do not release slots. |
| Deadline stops launches, not collection; atomic local mutations | Local evaluation lock plus protected compare-and-swap transitions; deadline-crossing tests cover evaluator, critic and repair, including function clocks after reservation. Known pre-provider stops remain spent and cannot impersonate ambiguous outcomes. |
| Portfolio JSON, provider/publication/admission/review/limits/safe actions | `gauntlet-portfolio.mjs`, `gauntlet status --all --json`; fixtures verify missing-local discovery is read-only and partial observation/costs remain explicit. A CLI subprocess regression and installed smoke cover circular-import initialization and real-path entrypoint handling, which imported-library tests did not detect. Exact-task observation is separate from publication and PASS. |
| Restart catch-up, durable observation fingerprints and entrypoint monitoring | Protected observations and receipt reconciliation; bounded implementation/evaluation entrypoints return monitoring handoff without submission when absent/stale/paused. Tests cover no duplicate events or replenished budget. Live missing-manifest recovery preserved identities and deadline. |
| One supported 30-minute desktop heartbeat, actual wake and pause | `GAUNTLET_CONTINUATION.md`; actual same-task scheduled wakes advanced collection, separately from registration. The supported desktop automation is paused at closeout. No separate scheduler, blind repair or auto-merge loop was added. |
| Honest model defaults, capability diagnostics, strict requests and overrides | `model-policy.mjs`, CLI/MCP launch surfaces and `scripts/test/model-policy.mjs`; defaults preserved, Astra high/medium policy separate, unsupported preferences warn, strict fails before submission, overrides recorded, actuals remain unverified without provider evidence. No local/API/provider fallback. |
| Required sequential specialist roles and approved executable checks | Implementation and evaluation reviewer-role tests require every role to PASS current head and reject substitution. Frozen command list is separate from agent judgments; live list is empty. Ordinary dispatch remains available without a Gauntlet PASS. |
| Read-only metrics with honest unknowns | `gauntlet-decisions.mjs`, portfolio reporting and tests bind correction history to immutable comments and current head. Submissions, elapsed run age, repairs and recorded findings are reported; absent regressions/interventions/costs are not inferred zero or estimated. |
| Defective and clean controls expose misses/false alarms | Full lifecycle fixtures plus labelled live count control and clean control. First critic detected the defect and did not flag the clean control; scoped repair changed only the defective report. This non-blinded single control is workflow evidence, not a critic-accuracy benchmark. |
| Automated, applicable roadmap and installed package verification | Admission/seal candidate `2fec236` passed 447 tests; final delivery includes portfolio CLI and sealed-state regressions with 448 tests passing. `npm run validate -- scripts/test/fixtures/admission/roadmap.yaml` passes; `npm run test:packed -- <candidate.tgz>` executes installed CLI/MCP and verifies shipped instructions. No root roadmap exists, so the fixture is the applicable target. |
| Isolated five-surface live qualification, durable result and exclusions | New source-only run at frozen remote-main baseline; exact eight Cloud receipts; one repair; five accepted packets/80 records; independent PASS and final attestations. Dirty primary Pidgeon checkout and existing #2257 preserved. No merge, npm publication, production interaction or full-program launch. |

## Interpretation and remaining human decisions

The delivered stack qualifies this bounded documentation workflow, not Pidgeon
runtime behavior, product release readiness, all-provider performance, an optimal
model allocation, or an exhaustive security audit. Actual Cloud model/effort,
authoritative worker commit SHA and monetary usage are unavailable and remain
explicitly unverified. Implementation review/repair has automated lifecycle
coverage; the live qualification deliberately exercises documentation evaluation.

Human review/merge of the four-PR stack and the evidence PR, any npm release,
expanded runtime/deployed checks and the full program are subsequent decisions.
PR #51's instruction is incorporated; closing that historical PR or cleaning up
other branches is not part of this delivery.
