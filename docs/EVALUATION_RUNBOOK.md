# Authorized documentation evaluations

Status: implemented and fixture-tested; live Pidgeon qualification is still pending. This
runbook describes the evaluation conductor, not automatic merging or product implementation.
The shared authority/review primitives also support opt-in bounded implementation runs;
legacy implementation runs remain readable without gaining verified authorization retroactively.

## Prepare once

Use an isolated lead checkout at the intended remote baseline. Preserve unrelated dirty
checkouts. Commit a durable spec, assignment boundaries and output convention before starting.
Workers receive isolated source-only assignments and make local packet commits; the lead owns
one consolidated documentation branch and PR. See [packet schema](EVIDENCE_PACKETS.md).

Configure `meta.dispatch.providers.codex.environment_id` and optionally
`meta.dispatch.evaluation.artifact_root` through the normal roadmap mutation interface. The
environment ID is public configuration, not a credential. Cloud credentials must not be
committed or copied into run records. Verify setup, repository identity and GitHub access
without deployments, product authentication or customer data.

The authenticated lead must have a protected `roadmap-gauntlet-locks/*` namespace whose active
rules restrict creation, update and deletion and forbid force pushes. Inspect the bypass actor
list separately: only the trusted lead/service may bypass, never evaluator/critic/repair
identities. The bounded authority journal refuses the unsafe-claims development escape hatch.
See [deployment requirements](DEPLOYMENT.md).

Create assignments as a YAML sequence of `id`, `wave`, `prompt`, and optional `evidence_types`.
Each prompt defines the frozen source boundary and expected evidence; no cross-packet access.

```text
roadmap gauntlet eval init --run <new-id> --base-sha <full-source-sha> --assignments <file.yaml>
```

Create an approved policy file. Replace the deadline with an explicit UTC timestamp at most
72 hours after qualification authorization. The following is the Pidgeon qualification policy,
not a new global default for other Roadmap consumers:

```yaml
version: 1
scope:
  description: >-
    Source-only five-surface documentation evaluation. Only this run's documentation may
    change. No product changes, production authentication, deployed-system interaction,
    customer data, deployments, npm publication or merge. Synthetic documentation defects
    must be clearly labelled and separated from real product findings.
providers:
  evaluator: codex
  critic: codex
  repair: codex
model_preferences:
  lead: {model: gpt-6-astra, reasoning_effort: high}
  cloud: {model: gpt-6-astra, reasoning_effort: medium, strict: false}
required_review_roles: [critic]
verification_commands: []
limits:
  submissions: 20
  concurrency: 4
  repairs: 3
  attempts_per_submission: 1
  launch_deadline: REPLACE_WITH_EXPLICIT_FUTURE_UTC_TIMESTAMP
```

The command freezes the source, assignments, artifact root, environment and authenticated lead
alongside this policy in protected GitHub state. Inspect the policy before confirming:

```text
roadmap gauntlet eval authorize --run <id> --authorization <policy.yaml> --confirm
```

Preferred Cloud model/effort settings warn when unsupported and remain explicitly unverified.
The supported CLI currently does not expose per-task model/effort controls. Strict unsupported
requests fail before reserving capacity. A prompt or a worker's self-description is not model
verification. No local worker, API-billed execution or different provider is substituted.

## Conduct the authorized work

```text
roadmap gauntlet eval launch --run <id> --wave <wave>
roadmap gauntlet eval status --run <id>
roadmap gauntlet eval observe --run <id>
roadmap gauntlet eval collect --run <id> --assignment <assignment>
roadmap gauntlet eval collect --run <id> --assignment <assignment> --apply
```

Launch does not require repeated human approval within frozen authority. Reservations are
atomically recorded in GitHub before submission; a concurrent loser cannot spend another task.
Ambiguous responses and abandoned pre-submit reservations consume capacity until reconciled.
If the reserving conductor knows it stopped before calling the provider, it records
`not_submitted`: the submission budget stays spent, concurrency is released, and no provider
receipt is expected. That exact launch key cannot be retried. A lost conductor cannot infer
this outcome from a missing receipt, and an ambiguous submission cannot be relabelled this way.
Never recover them by deleting local files and retrying the provider. Every receipt uses its
exact task ID/URL; never associate tasks by recency.

`status` is read-only. `observe` durably records exact-task observations with deduplicated event
fingerprints. Cloud `READY` means finished artifact availability, not PR publication or PASS.
Terminal observations release concurrency but never replenish spent submission/repair budgets.
Missing tasks, unknown states and failed queries do not release slots. Once the deadline passes,
continue observation and collection but do not launch more work.

Collection preview and validation do not modify the manifest or working tree. Apply validates
the same fetched diff, uses only the allowed paths, verifies resulting bytes, and records
digests only after success. It refuses local conflicts, including ignored/assume-unchanged
packet changes. Commit each collected packet before later corrections. The supported Cloud
diff interface does not expose an authoritative worker commit SHA: worker commit identity is
recorded as **unverified**, even though the prompt requires a local commit. Never invent it.
The enforced content identity is the patch/packet digest and subsequent evidence-PR commit.

Inspect every packet and attachment for claim accuracy and redaction. Automated checks reject
known credential/session and obvious structured patient-data patterns, but do not guarantee
secrecy, perform image OCR or establish claim truth. Do not publish rejected prohibited data.

Commit and push only the authorized run documentation, then open one lead-owned PR. The tool
does not create a competing worker PR or merge anything. Attach that PR at its current head:

```text
roadmap gauntlet eval attach --run <id> --pr <number> --expected-head <evidence-head> --confirm
roadmap gauntlet eval validate --run <id> --assignment <assignment>
roadmap gauntlet eval accept --run <id> --assignment <assignment> --packet-digest <digest> --expected-head <evidence-head> --decision accepted --reason "<lead inspection rationale>" --redaction-inspected --confirm
```

Use `--decision rejected` to preserve an explicit digest-bound rejection. Earlier decisions
remain attributable. A missing or empty evidence packet remains unresolved even if rejected;
rejection cannot fabricate coverage. Changed packet digests invalidate prior acceptance. The
source SHA never changes merely because the documentation PR acquires a new head.

## Independent review and scoped repair

```text
roadmap gauntlet eval critic --run <id> --expected-head <evidence-head>
roadmap gauntlet eval status --run <id>
roadmap gauntlet eval ack --run <id> --expected-head <evidence-head> --comment-url <exact-critic-comment-url> --confirm
```

All expected packets must be adjudicated first. The next frozen reviewer role executes
sequentially, in a fresh Cloud task. One `critic` is always mandatory. A security or other
specialist cannot substitute for another required role. Each must PASS the same current head.

If validation refuses a packet and leaves it unapplied, preserve its exact task and rejected
patch digest in lead notes. Do not weaken the frozen schema or import invalid files. An
explicit `critic --allow-incomplete` requests diagnostic review of the incomplete PR, within
the same protected limits. The critic independently identifies missing/invalid evidence;
only inspected, acknowledged REVISE findings may drive a scoped repair that creates the
missing permitted packet. PASS acknowledgment and sealing remain forbidden while any
expected evidence is unresolved. Revalidate and adjudicate repaired packets before fresh
review. The MCP equivalent is `gauntlet_eval_critic` with `allow_incomplete: true`.
Actual lead inspection precedes acknowledgment: read the exact critic artifact, independently
check material claims and reject scope creep. The shared Gauntlet protocol binds acknowledgment
to both the immutable comment body and its GitHub URL. Editing or replaying a verdict cannot
reuse an old acknowledgment.

For acknowledged REVISE, synthesize a repair packet outside the committed PR working tree so
writing the instructions does not move the reviewed head:

```yaml
version: 1
expected_head: REPLACE_WITH_EXACT_EVIDENCE_HEAD
findings:
  - id: F1
    critic_comment_url: REPLACE_WITH_ACKNOWLEDGED_REVISE_COMMENT_URL
    description: A concrete material finding accepted by the lead.
    paths:
      - REPLACE_WITH_EXACT_PERMITTED_RUN_DOCUMENT_PATH
instructions: Fix only the accepted finding and preserve the frozen source boundary.
```

```text
roadmap gauntlet eval repair --run <id> --expected-head <evidence-head> --packet <lead-repair.yaml>
roadmap gauntlet eval observe --run <id>
roadmap gauntlet eval collect-repair --run <id> --launch-key <exact-returned-key>
roadmap gauntlet eval collect-repair --run <id> --launch-key <exact-returned-key> --apply
```

Repair workers may edit only the explicit approved documentation files and must commit locally.
They cannot modify run/assignment/receipt control files, publish, push or merge. Repair
collection rejects a moved PR head and validates all packets plus allowed changed-file digests.
It does not rebase or force-apply old repairs. Commit/publish the collected repair, re-adjudicate
changed packet digests, and obtain fresh criticism and acknowledgment at the new head.

## Seal without moving the head

```text
roadmap gauntlet eval seal --run <id> --expected-head <evidence-head> --confirm
```

Sealing requires adjudicated evidence and acknowledged current-head PASS from every required
role. The seal is a lead GitHub attestation bound to authority digest, frozen source, evidence
head and corpus digest. It makes no commit. Changed content/head, removed or edited lead
attestations, or stale criticism revoke the current seal. Keep final review/seal receipts in a
durable GitHub closeout comment rather than making a bookkeeping commit that invalidates them.

## Restart and failure posture

```text
roadmap gauntlet eval recover --run <id>
roadmap gauntlet eval recover --run <id> --confirm
```

Recovery previews first and restores only a missing local manifest. If a PR exists, use an
isolated lead checkout at its exact head; committed packet history and protected receipts are
preserved. Existing files are never silently overwritten. The protected GitHub journal, not
the local YAML or gitignored cache, owns authority and spent capacity.

Local mutations use atomic manifest replacement and a per-run lock under the checkout's Git
directory, `roadmap-evaluation-locks/`. Never expire/remove a lock automatically. Verify its
recorded process/host is gone before explicit recovery. A vanished local lock does not erase
the distributed reservation.

For a lost submission response, inspect the exact task's instructions and identity first.
If that task demonstrably belongs to the reserved request, record the association:

```text
roadmap gauntlet eval reconcile --run <id> --launch-key <reserved-key> --task-id <exact-task-id> --task-url <exact-task-url> --reason "Inspected task and matched frozen assignment" --confirm
roadmap gauntlet eval observe --run <id>
```

This requires the frozen lead and a successful exact-task observation. It records an
attributable association decision, not a provider-verified prompt match. Never choose a task
by recency. The operation cannot replace a receipt, retry the submission, or reset spent
capacity. If the task cannot be identified, leave the reservation unresolved.

Legacy runs remain readable and unverified. Explicit schema migration preserves old bytes and
does not infer acceptance. Historical/already-launched unbounded runs cannot be granted a new
budget under the same identity; start a new authorized run instead.

Desktop heartbeat setup and portfolio reporting are subsequent delivery dependencies. Do not
mistake this fixture-tested conductor for completed live qualification. No scheduler, blind
repair loop, npm publication, production access or automatic merge is included here.
