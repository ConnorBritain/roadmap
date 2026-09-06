# Evidence packet contract, version 1

An evaluator creates one local commit containing `REPORT.md`, `evidence.yaml`, and any explicitly
declared supporting files beneath its assigned `evidence/` directory. It neither pushes nor
opens a PR. The lead validates, inspects, integrates, and publishes one consolidated evidence PR.

The containing `RUN.yaml` uses version 3. Packet and manifest versions are independent.
The frozen `base_sha` identifies product source, not the later evidence PR head. Copy the exact
run and assignment identities from the launch prompt; do not infer them from directory names.

```yaml
version: 1
packet:
  run_id: example-evaluation
  assignment: source-map
  base_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # replace with frozen source SHA
  captured_at: '2026-09-05T10:00:00Z'
  artifacts: []
evidence:
  - id: E1
    type: source_code
    claim: The source exports a named constant.
    boundary: source
    captured_at: '2026-09-05T10:00:00Z'
    limitations: [Source inspection does not establish deployed behavior.]
    references:
      - path: src/example.js
        sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        line_start: 1
        line_end: 1
```

The report cites this record as `[[evidence:E1]]`. Every record must be cited, every citation
must resolve, and IDs must be unique within the packet. Cross-packet claims belong in the
lead's synthesis, not an isolated evaluator's report. Use timezone-qualified ISO timestamps;
future timestamps beyond five minutes of clock skew are refused.

## Evidence kinds and boundaries

Allowed types: `source_code`, `test`, `documentation`, `rendered_ui`, `history`, `other`.
Assignments may restrict `evidence_types` further. Every record requires a nonempty claim,
timestamp, references and a `limitations` sequence (an empty sequence is explicit, not omitted).
Source observations require at least one exact-SHA source path. Optional line ranges must both
be provided and fit a regular file in that Git tree. URLs must use HTTPS without embedded
credentials. URL syntax and tree provenance do not establish the truth of a claim.

Deployed observations require `boundary: deployed`, an HTTPS reference, and explicit run policy
permission for its hostname. Source-only runs refuse them. Merely linking a public document
does not establish deployed-system observation or authorize interacting with that system.

Test evidence additionally requires:

```yaml
test:
  command: npm test
  status: not_run
  result: Dependencies were unavailable; no test execution occurred.
```

`status` is `passed`, `failed`, `not_run`, or `blocked`. Executed tests require integer
`exit_code` (zero for passed, nonzero for failed). Unexecuted tests must not have an exit code.
Validation records these assertions; it never executes a worker-supplied command or verifies
that a claimed execution actually happened. The lead must inspect supporting records.

`rendered_ui` additionally requires a nonempty record-level `artifacts` sequence identifying
declared PNG/JPEG/WebP evidence. A source observation is not a rendered screenshot.

## Supporting artifacts and safety

Declare every supporting file in `packet.artifacts`, for example `evidence/logs/check.txt`.
Allowed extensions are `.md`, `.txt`, `.log`, `.json`, `.yaml`, `.yml`, `.png`, `.jpg`, `.jpeg`,
and `.webp`. No other packet files are admitted. Total packet limit: 16 MiB; individual text
limit: 2 MiB. Only regular, non-executable files are accepted. Symlinks, special files, unsafe
paths, renames/copies, duplicate YAML keys and YAML aliases are refused.

Never include credentials, session cookies, patient/customer data or raw private transcripts.
The scanner rejects detected credential patterns; it is not a secrecy guarantee and does not
OCR images or prove that prose contains no prohibited personal data. The lead must inspect
every attachment and redact before acceptance/publication. Validation diagnostics intentionally
omit worker-authored claims and references.

## Collection and legacy data

`eval collect` previews without changing the manifest or checkout. It uses a disposable Git
index (Git may cache blob objects); it does not create a worker worktree. `--apply` revalidates
the same fetched patch, checks local conflicts, applies exactly those bytes and records packet
and patch SHA-256 digests only after verifying the resulting files. A failed apply never marks
collection successful. Commit a collected packet before applying a later correction; history
and receipts preserve attribution rather than silently replacing prior findings.

`eval validate` independently checks local packet content. Validation is not lead acceptance,
critic review, permission to publish, or a seal. Legacy runs remain unverified even if old
`collected_at` or `sealed_waves` fields exist. Explicit migration preserves the original manifest
and packet files and never converts those fields into acceptance decisions.
