# The Gauntlet operating model

Roadmap execution is a conducted loop:

```text
plan -> implementation -> independent critic -> frozen-lead acknowledgment -> lead synthesis
     -> repair -> fresh critic -> frozen-lead acknowledgment -> PASS -> merge -> reconcile
```

The loop is deliberately not an automatic workflow engine. The local, long-lived lead owns
intent and judgment. Fresh cloud agents (Claude Routines or Codex Cloud) do implementation,
criticism, and repair. GitHub holds
the durable work artifact. Roadmap supplies the sensors, actuators, identities, and safety checks
that let the lead conduct the work.

The design adapts Matt Shumer's [Gauntlet Loop](https://somethingbig.ai/gauntlet-loop) and
[Claude-of-Duty prompt](https://github.com/mshumer/Claude-of-Duty/blob/main/prompt.md): hold the
bar outside the builder, inspect artifacts, and iterate with fresh evaluators. Karpathy's
[autoresearch](https://github.com/karpathy/autoresearch) reinforces the stable evaluator and
bounded experimental loop; [llm-council](https://github.com/karpathy/llm-council) reinforces
independent judgments followed by a separate lead synthesis. Roadmap turns those cognitive
patterns into explicit PR identity, SHA-pinned evidence, idempotent actuators, and stop rules.

For meaningful roadmap work, use a Gauntlet run instead of treating one cloud dispatch as a
finished execution. `dispatch` and `fan_cloud` remain useful low-level actuators and escape
hatches.

## The division of responsibility

| Layer | Owns |
|---|---|
| **Roadmap YAML** | Planned intent: subjects, dependencies, scope, gates, and priorities. It does not become a run log. |
| **Local lead** | The frozen quality bar, critic synthesis, repair packet, stop/continue decisions, merge decision, and human escalation. |
| **Roadmap runtime** | Run identity, exact markers, provider receipts, duplicate protection, expected-SHA checks, and reconstruction. It is the nervous system, not the executive. |
| **Cloud providers** | Disposable implementation, independent criticism, and narrowly directed repair labor. |
| **GitHub** | Durable shared reality: the PR, commits, current head SHA, checks, run markers, frozen bar, lead launch/cancellation events, atomic launch-claim refs, and critic verdict comments. |
| **Local ledger** | A restartable launch ledger/cache at `.roadmap-gauntlet-state.json`; useful for the pre-PR launch window, but never the authority over GitHub. |

V1 is intentionally GitHub-first. A repository without a usable GitHub remote and authenticated
`gh` CLI cannot conduct a Gauntlet run; use the lower-level provider-neutral dispatch surfaces
instead. Linear remains an optional projection and intake surface, not the Gauntlet rendezvous
point.

## Conducting one run

The preferred in-session surface is the `/gauntlet <slice-or-backlog-key>` skill. A lead can use
the same primitives directly through the `graph` MCP server:

- `gauntlet_start` freezes the bar, creates a run, records its launch receipt, and fires a fresh
  implementation worker.
- `gauntlet_status` is read-only. It reconstructs the run from the ledger plus current GitHub
  reality and reports the PR, head, checks, in-flight work, valid/stale verdicts, round, and safe
  next actions.
- `gauntlet_critic` fires one fresh independent critic against the exact current PR head.
- `gauntlet_ack` records that the frozen lead inspected and accepted one exact, immutable critic
  comment as input. It spends no Routine call and is required before a verdict can drive state.
- `gauntlet_repair` fires a fresh repair worker against an exact expected head and the
  lead-synthesized repair packet. The worker updates the existing PR branch.
- `gauntlet_cancel` is the explicit, human-confirmed escape hatch for a stuck or ambiguous
  launch. It preserves receipts and does not close or delete the PR. When a PR exists, the
  cancellation is a durable lead-authored GitHub event. Before a PR exists, it creates a protected
  shared tombstone claim so a delayed PR cannot resurrect the run after local-ledger loss; the
  detailed human reason remains local until a PR comment can carry it.

The CLI equivalents are:

```bash
roadmap gauntlet start <key> [--implementation-provider claude|codex] [--critic-provider claude|codex] [--repair-provider claude|codex] [--bar-file <path>] [--max-rounds <0..20>] [--force]
roadmap gauntlet status <run-id-or-key>
roadmap gauntlet critic <run-id-or-key> --expected-head <full-40-char-sha> [--provider claude|codex] [--critic-role <slug>]
roadmap gauntlet ack <run-id-or-key> --comment-url <exact-github-comment-url> --confirm
roadmap gauntlet repair <run-id-or-key> --expected-head <full-40-char-sha> --packet-file <path> [--provider claude|codex]
roadmap gauntlet cancel <run-id-or-key> --reason <text> --confirm
```

Use the command help for transport-specific optional flags. The behavioral contract is the same
on CLI and MCP. CLI critic/repair calls require `pr.currentHead` from
`roadmap gauntlet status <run-or-key> --json`; do not use an abbreviated display SHA.

The full cognitive procedure is:

1. Inspect the selected roadmap/backlog subject and the relevant repository context.
2. Freeze the external quality bar before any implementation launch.
3. Confirm the start. It consumes Routine usage and is expected to produce a real branch and PR.
4. Observe with `gauntlet_status` until the implementation PR and a reviewable head exist.
5. Consider the relevant CI/check state; distinguish infrastructure failure from an
   implementation failure.
6. Launch one independent critic for the exact current head. V1 conducts one selected critic
   role at a time; a specialist role can be selected without weakening the one-result-per-launch
   protocol.
7. Inspect the candidate critic evidence, then acknowledge it. Accept a verdict only when its run
   identity, nonce, immutable body digest, exact GitHub comment-URL digest, reviewed SHA, and
   lead-authored acknowledgment match the intended run and current PR head.
8. If the acknowledged verdict is `REVISE`, synthesize a small repair packet. Deduplicate findings, reject
   scope growth and contradictory advice, and state which frozen-bar failures must change.
9. Launch repair against the expected head. The repair worker must update the same PR and abort
   if the head has moved.
10. Observe the new head and launch a fresh critic. Never reuse the builder as its own grader.
    Return to step 7 and inspect and acknowledge this new verdict; acknowledgment never carries
    forward from an earlier SHA or round.
11. Stop at an acknowledged current-head `PASS`, human judgment, the repair ceiling,
   non-convergence, diminishing returns, or infrastructure failure.
12. Merge only after the normal lead/human merge decision, then run `/sync` to reconcile the
   canonical roadmap and optional projections.

There is no `critic says revise -> repair everything` shortcut. Critic output is advisory and
untrusted; the lead's repair packet is authoritative.

## Frozen quality bar

`gauntlet_start` snapshots the acceptance conditions that exist before the builder works. The bar
is assembled from the selected subject, its resolved gate, prompt/kickoff constraints, the base
SHA, and explicit immutable instructions supplied by the lead. It should be concrete enough for
a fresh critic to answer from observable evidence: required behavior, architectural invariants,
tests, compatibility, security, performance, and any references that actually matter.

The frozen bar is recorded in both places needed for safe recovery:

- the local ledger retains the canonical launch snapshot and receipt;
- the implementation PR body carries the run identity and frozen bar so GitHub is independently
  auditable and another session or machine authenticated as the frozen GitHub lead can resume.

An implementation or repair worker may report test evidence, but it may not edit the bar or
self-certify against it. If product intent legitimately changes, the lead explicitly starts a new
run or revises the scope outside the active run. Silent goalpost movement invalidates the loop.

Before any implementation PR exists, conductors that observe the same attempt history derive the
same run identity from subject + frozen base SHA + attempt number and race for one deterministic
GitHub ref. A conductor with less local history can briefly report a different pending run ID, but
protected earlier claims and the eventual marked PR make the shared attempt discoverable. Only a
create-if-absent winner fires an implementation Routine. This closes the cross-machine launch
window without pretending that local attempt ledgers are shared consensus state. If conductors
proposed different bars, actors, tiers, or ceilings, a loser that never fired discards its
candidate packet when the winning marked PR appears. It exposes that winner packet read-only and
requires the authenticated frozen lead to inspect and confirm it before launching a fresh critic.

## GitHub protocol and exact-SHA verdicts

An implementation PR carries both the canonical roadmap subject marker and a Gauntlet run marker,
plus its frozen bar. Repair workers push commits to that same PR. Critics publish a structured,
human-readable PR comment containing at least:

- run identity and critic role;
- repair/critic round;
- the exact full head SHA reviewed;
- one of the canonical verdicts;
- evidence-based bar checks and findings.

The runtime emits the canonical PR header and bar block; workers should copy it exactly rather
than hand-inventing a near match:

```text
roadmap: slice=<subject-key>
roadmap-gauntlet: run=<run-id>
roadmap-gauntlet-role: implementation
roadmap-gauntlet-base: <full-40-char-base-sha>
roadmap-gauntlet-base-ref: <runtime-encoded-base-branch>
roadmap-gauntlet-lead: <authenticated-github-login>
roadmap-gauntlet-bar: sha256=<64-char-bar-digest>
roadmap-gauntlet-max-rounds: <0..20>
roadmap-gauntlet-critic-tier: <none|runtime-encoded-tier>
roadmap-gauntlet-repair-tier: <none|runtime-encoded-tier>

<!-- roadmap-gauntlet-bar:start -->
<frozen quality bar Markdown>
<!-- roadmap-gauntlet-bar:end -->
```

Base-ref and tier values are base64url-encoded by the runtime so existing Routine keys and branch
names round-trip without delimiter ambiguity. Copy the emitted packet verbatim; do not hand-encode
or simplify it.

A critic comment begins with this exact machine block, followed by bounded human-readable
evidence:

```text
<!-- roadmap-gauntlet
version=1
run=<run-id>
role=critic
critic_role=<lowercase-role-slug>
round=<positive-integer>
head=<full-40-char-reviewed-head>
nonce=<32-char-lowercase-hex-launch-capability>
verdict=<PASS|REVISE|HUMAN_REQUIRED|INVALID_OR_STALE>
-->
```

Immediately before a critic or repair Routine is fired, the lead posts a separate
`roadmap-gauntlet-launch` comment through its authenticated GitHub account. It commits the run,
full immutable protocol digest (subject, base SHA/ref, lead, bar, round ceiling, and tiers), role,
round, exact head, and a hash of the private critic nonce (or repair packet). The nonce itself
reaches only the fresh critic until its result is published. This durable precommit lets another
machine authenticate historical rounds instead of merely trusting a well-shaped verdict comment.
Each precommit also carries a monotonic attempt number, so duplicate `INVALID_OR_STALE` comments
cannot make two conductors choose different retry locks.

Before posting that precommit, the conductor verifies that the current `gh` identity is the
frozen lead and atomically creates a deterministic Git ref under
`refs/heads/roadmap-gauntlet-locks/`. GitHub's create-if-absent operation elects exactly one conductor
even when two machines race with independent local ledgers. These small refs are durable protocol
receipts. Configure an active ruleset for `roadmap-gauntlet-locks/*` that restricts branch
creation, updates, and deletion to the trusted lead/service bypass identity and blocks
non-fast-forward updates. Routine worker identities must not have the bypass. The runtime checks
that all four rule types apply to each exact prospective claim before creating it. Operators must
verify bypass membership in GitHub because the effective-rules response does not expose it;
`ROADMAP_GAUNTLET_UNSAFE_CLAIMS=1` is an explicit, unsafe test-only escape hatch. Do not delete
receipt branches for an active or recoverable run.

PR-backed cancellation uses the same trust boundary: an exact `roadmap-gauntlet-cancel` comment,
authored by the frozen lead and bound to the full immutable protocol digest. Its reason is encoded
inside the machine header and also shown as non-executable human text. On GitHub-only recovery,
launch and cancellation events are authoritative only while the current authenticated `gh`
identity matches the frozen lead recorded by the run.
Before a PR exists, cancellation instead creates a separately typed protected tombstone ref at
the frozen base SHA. The tombstone preserves the terminal decision across machines, while the
full human reason remains in the local ledger/portal evidence until a PR exists.

Normal PR prose may change without changing identity. Critic verdict comments themselves are
immutable protocol events: an edited comment is rejected, because an old placeholder must not be
rewritten after a real critic reveals its nonce. The frozen lead must inspect the candidate and
post a separate `roadmap-gauntlet-verdict-ack` comment committing its exact body digest and GitHub
comment-URL digest, run, role, round, SHA, nonce hash, verdict, and protocol digest. The pair—not
a self-declared worker marker—drives state. Deleting or altering either side makes the result
unacknowledged and fail-closed. A correction requires a fresh conducted attempt. Duplicate or
malformed marker blocks are not accepted as valid protocol.

Canonical verdicts are:

| Verdict | Meaning |
|---|---|
| `PASS` | This exact head meets the frozen bar. It is eligible for the lead's merge decision. |
| `REVISE` | This exact head has material, actionable failures against the bar. |
| `HUMAN_REQUIRED` | The bar cannot resolve a product, policy, architecture, risk, taste, or destructive-action decision. |
| `INVALID_OR_STALE` | The review cannot be safely applied to the intended run/head. |

Verdict comments are observations, not authority. Roadmap validates their protocol fields and PR
association, returns their bounded human evidence to the MCP/CLI status consumer as explicitly
untrusted text, and leaves the lead to validate their substance. Never execute shell text copied
from a comment.

The PR head SHA is an optimistic-concurrency token:

```text
critic.reviewed_head != pull_request.current_head
    => stale verdict
    => never PASS this head and never repair it blindly from that verdict
```

The same rule protects repair. `gauntlet_repair` is pinned to an expected head; if GitHub has
moved, the assignment is stale and must abort rather than force-push or overwrite newer work.
Status also verifies that the current head descends from every accepted repair launch's expected
head, so a later force-push cannot erase an earlier repaired lineage and still appear healthy.

## State, recovery, and idempotency

`.roadmap-gauntlet-state.json` is a gitignored, machine-local launch ledger/cache. It records the
minimum needed to close the blind window before a PR appears: run identity, subject, frozen bar,
launch receipts, expected head/round launch keys, and cached associations. It must never contain
Routine tokens or cloud-session transcripts.

GitHub remains durable reality. `gauntlet_status` refreshes the PR, target branch, base ancestry,
current head, checks, launch precommits, verdict acknowledgments, critic comments, and distributed
claim refs and derives the state; it does not trust a cached `passed` flag. It verifies launch
claims and lead attestations bidirectionally, including the claimed SHA; either half surviving
alone is an infrastructure failure, not permission to relaunch. Deleting the local
ledger and moving to another machine reconstructs the same round, repair count, and terminal
verdict from the PR packet plus lead-authored launch attestations and verdict acknowledgments. A
PR-backed cancellation reconstructs its terminal state and reason from its lead comment and claim
ref. If the claim exists but the comment was deleted, status reports infrastructure failure rather
than silently reviving the run. A valid claim-backed cancellation may deliberately terminate an
otherwise unrecoverable launch-attestation or repair-history failure while preserving that prior
failure as diagnostic evidence.
The resuming conductor must authenticate as the frozen GitHub lead; another identity receives
only the safe action to authenticate correctly, never merge/launch/cancel authority.

Older or incomplete PRs without launch attestations recover fail-closed: their historical
verdicts are advisory, the bar must be inspected against current roadmap/user intent, and a fresh
critic requires `--confirm-recovered-bar` (MCP: `confirm_recovered_bar: true`). Confirmation is not
a rubber stamp; check the recovered bar, base, stop ceiling, and tiers first. After confirmation
the snapshot is immutable again, and a fresh nonce-bound critic restores authoritative state.

Agent calls are retry-prone, so launches are idempotency-guarded:

- one active initial implementation launch per run;
- one equivalent critic launch per run + head + critic role;
- one equivalent repair launch per run + expected head + repair round;
- duplicate or retried critic comments do not create a second valid verdict.

The local ledger lock serializes processes on one machine. Deterministic GitHub launch-claim refs
provide the distributed create-if-absent election across machines. A loser returns a duplicate
without spending a Routine call. If a ref POST response is lost, the runtime reads the exact ref
back before deciding; an unreconciled result remains ambiguous and non-retryable.
Authenticated lead launch attestations observed on GitHub are upserted into a local ledger before
an actuator mutates or retries them, so another machine's `INVALID_OR_STALE` attempt can converge
without losing its durable attempt number.

A timeout, connection loss, or malformed success response after a Routine POST is
`launch_ambiguous`, not proof that nothing ran. The receipt and GitHub precommit block automatic
retry; wait for the PR/result, reconcile the Routine portal, or use explicit `gauntlet_cancel`
with a reason. Cancellation never erases evidence, and an open subject PR continues to block a
competing start. With a PR, cancellation is durable on GitHub and restart-safe. Without a PR, the
protected tombstone is the shared terminal signal; the local reason and the human's Routine-portal
reconciliation remain the detailed evidence for abandoning the blind-window launch.

Ledger writes use `.roadmap-gauntlet-state.lock`. If a process crashes while holding it, first
confirm no Gauntlet command is active, inspect the recorded PID/host/time, then remove the lock
file manually. The runtime deliberately never auto-deletes a possibly live replacement lock.

`gauntlet_status` is always read-only. A missing/ambiguous association, changed head, closed PR,
or failed GitHub lookup is surfaced rather than guessed.

## Cloud-agent providers

The Gauntlet protocol is provider-neutral: every launch records a `provider`, an exact external
execution ID/URL, status, and provider metadata in the local launch ledger. The PR, full SHA,
frozen bar, GitHub claims, and verdict protocol remain provider-neutral and authoritative.

- `claude` is the compatible default. Routine tiers remain provider-specific configuration.
- `codex` submits `codex cloud exec --env <environment-id>` through an argument array, accepts only
  the single task URL returned by that command as its receipt, and observes the stored task ID via
  paginated `codex cloud list --json`. It never associates a launch with a “latest” task.
- Codex Cloud has no supported per-task model selector; a model request fails instead of silently
  changing quality. Its `--attempts` option is best-of-N, not multiple independent critics.
- Codex runs its worker remotely; Roadmap does not create local worktrees or apply task diffs as
  the normal operating path. The supported CLI has no unattended task-to-PR publication command,
  so Codex implementation receipts honestly remain `awaiting_artifact_publication` until a PR
  exists. `codex cloud apply` is manual recovery, not Gauntlet fanout architecture.
- GitHub-native `@codex review` and `@codex fix …` are useful human-triggered PR-context paths
  when configured and permitted, but Roadmap does not call them as an exact machine receipt API.

Repository configuration is secret-free; environment identity is not task identity:

```yaml
meta:
  dispatch:
    default_provider: claude
    providers:
      codex:
        environment_id: env_roadmap
  gauntlet:
    implementation_provider: codex
    critic_provider: claude
    repair_provider: codex
```

Every role can be overridden at the CLI/MCP launch surface. No provider fallback occurs: a missing
CLI, login, configured environment, unsupported model request, or ambiguous submission receipt is
an infrastructure failure for the requested provider, not an instruction to fire another one.

## Roles and Routine resolution

Create generic API-triggered Claude Code Routines whose saved prompts define their role:

- `implementation`: implement the frozen bar, verify, commit, push, open a marked PR, never merge;
- `critic`: independently inspect the artifact and evidence, then comment a verdict for the exact
  head; do not consume the builder's private reasoning;
- `repair`: verify the expected head, apply only the lead's packet to the existing branch, verify,
  and push; never merge and never open a competing PR by default.

In each profile's `routines` map, role-aware keys are:

```text
<owner/repo>#<role>
default#<role>

<owner/repo>#<role>#<tier>
default#<role>#<tier>
```

Role-aware selection preserves the existing repository/tier/default compatibility fallbacks:

- without a tier: `<repo>#<role>` -> `default#<role>` -> `<repo>` -> `default`;
- with a tier: `<repo>#<role>#<tier>` -> `default#<role>#<tier>` -> `<repo>#<tier>` ->
  `default#<tier>`.

As before, an explicitly requested tier never falls back to an untiered Routine. A missing strong
critic tier is an actionable configuration error, not permission to silently downgrade reviewer
quality. Profile selection itself remains: explicit trigger/token environment override, then
`CLAUDE_ROUTINE_PROFILE`, then the profile matching the currently authenticated Claude account.
For a Gauntlet role or requested tier, a generic environment override must also declare the
matching `CLAUDE_ROUTINE_ROLE` and, when tiered, `CLAUDE_ROUTINE_TIER`; otherwise it fails rather
than silently routing an independent critic to an unknown Routine.

Example:

```json
{
  "connor": {
    "account": "connor@example.com",
    "routines": {
      "default": { "trigger": "trig_impl", "token": "..." },
      "default#critic": { "trigger": "trig_critic", "token": "..." },
      "acme/webapp#repair": { "trigger": "trig_repair", "token": "..." },
      "acme/webapp#critic#fable": { "trigger": "trig_fable", "token": "..." }
    }
  }
}
```

Keep this file outside repositories (normally `~/.claude-routines.json`, overridable with
`CLAUDE_ROUTINES_FILE`) and protect it as a credential store.

Repository-wide policy is optional and secret-free:

```yaml
meta:
  gauntlet:
    max_rounds: 3
    critic_tier: fable            # requires a matching role+tier Routine key
    # implementation_tier: economy
    # repair_tier: economy
```

`max_rounds` counts repair launches and may be `0..20`; omitting it uses three. Explicit start or
actuator arguments take precedence. A subject's existing `dispatch_tier` takes precedence over
the repository's implementation/repair tier, while the critic tier stays independently
configurable so builder cost selection does not silently choose reviewer strength.

## Stop and safety rules

The default is one independent critic at a time and at most **three repair rounds**. The lead may
choose a lower limit or explicitly configure a different ceiling when starting the run. Reaching
the ceiling does not turn the last implementation into a pass.

Stop and explain when:

- an acknowledged `PASS` applies to the current head;
- a product or risk decision requires a human;
- three repairs have been attempted without convergence (by default);
- repeated review yields only low-value preference churn and the observable bar is already met;
- the same material failure survives repairs;
- GitHub, the Routine transport, branch/PR state, or test infrastructure prevents trustworthy
  progress.

No worker or roadmap command auto-merges. Do not blindly repair every complaint. Do not let
implementation/repair workers create PIs or sprints; discoveries go to the backlog discipline.
Credentials, production operations, destructive changes, irreversible migrations, strategic
scope, and ambiguous product choices retain their existing human approval boundaries.

## Waves

Fanout and Gauntlet are separate dimensions. A roadmap wave answers which independent slices may
run concurrently. A Gauntlet answers how one slice converges:

```text
wave:       A             B             C
            |             |             |
run:   implement     repair #1      critic #2
            |             |             |
         critic         critic      inspect/ACK -> PASS
            |             |
       inspect/ACK   inspect/ACK
```

A lead may conduct several runs concurrently, but each event is associated by run identity and
exact head. Start conservatively in V1: one critic per run, inspect `gauntlet_status` before every
actuation, and do not build a blind automatic loop. The lead remains in the causal center.
