# DELTA: Make Roadmap Cloud-Agent-Provider-Agnostic and Add Codex Cloud

This is an additive architectural delta to the Gauntlet Loop mission you are already implementing.

Do **not** restart the work.

Do **not** discard architecture or code already produced unless this delta reveals that it is incorrectly coupled to Claude Routines.

First inspect:

- the implementation work already completed,
- current uncommitted changes,
- the architectural plan you formed,
- any roadmap slices you created for this initiative,

and incorporate this delta into that work.

The original Gauntlet requirements remain authoritative.

This delta changes one major assumption:

> Claude Code Routines must not be the architectural definition of a cloud worker.

They should become one implementation of a more general remote-agent dispatch model.

I want Roadmap to support:

- Claude Code cloud Routines,
- Codex Cloud,
- mixed-provider Gauntlet runs,
- and future cloud-agent providers without rearchitecting the conductor.

The updated conceptual division is:

```text
ROADMAP / MCP
    =
provider-neutral senses, actuators, identities, invariants

CLOUD AGENT PROVIDER
    =
disposable remote labor environment

GITHUB
    =
durable shared artifact / rendezvous point

LONG-LIVED LEAD
    =
judgment, orchestration, synthesis
```

The Gauntlet should not fundamentally know or care whether a worker was Claude or Codex.

---

# 1. Updated target architecture

The intended architecture is now:

```text
                         LOCAL MACHINE

                +--------------------------+
                |     LONG-LIVED LEAD      |
                |                          |
                | Omnara / Claude / Codex  |
                | or another MCP client    |
                |                          |
                | owns intent + judgment   |
                +------------+-------------+
                             |
                         roadmap MCP
                             |
                  +----------+----------+
                  |                     |
                  v                     v

          PROVIDER-NEUTRAL        GITHUB SENSORS
             DISPATCH                  |
                  |                    |
      +-----------+-----------+        |
      |                       |        |
      v                       v        |
 CLAUDE ROUTINE          CODEX CLOUD   |
      |                       |        |
      | remote worker         | remote worker
      |                       | isolated repo
      +-----------+-----------+        |
                  |                    |
                  +--------+-----------+
                           |
                           v

                         GITHUB

                   PR / commits / SHA
                   checks / comments
                   reviews / markers

                           |
                           v

                     LONG-LIVED LEAD

               PASS / REVISE / ESCALATE
```

There should be no assumption in Gauntlet core logic equivalent to:

```text
cloud worker == Claude Routine
```

Instead:

```text
cloud worker == dispatch provider
```

with provider-specific adapters beneath the common contract.

---

# 2. Research Codex Cloud before implementing the adapter

Do not rely solely on the factual assumptions in this prompt.

The Codex Cloud CLI surface is evolving.

Before implementing the provider, research the **current official OpenAI Codex documentation** and inspect the actual locally installed Codex CLI.

At minimum inspect current documentation for:

- Codex Cloud,
- Codex Cloud environments,
- Codex CLI developer commands,
- `codex cloud`,
- `codex cloud exec`,
- `codex cloud list`,
- `codex apply`,
- Codex model availability,
- Codex authentication,
- Codex GitHub integration,
- Codex code review,
- Codex pricing / ChatGPT-authenticated versus API-key-authenticated behavior.

Also inspect actual installed behavior with non-destructive commands such as conceptually:

```text
codex --version
codex cloud --help
codex cloud exec --help
codex cloud list --help
```

and any appropriate authentication/status commands supported by the installed version.

Do not scrape or depend on undocumented internals if the official CLI provides the required seam.

Record any discrepancy between:

- official documentation,
- installed CLI behavior,
- assumptions in this prompt.

Prefer current observed official behavior.

---

# 3. Important current Codex Cloud characteristics to verify

At the time this delta was written, the relevant Codex Cloud model appears to be approximately:

```text
roadmap
   |
   | codex cloud exec
   v
OpenAI-managed cloud environment
   |
   +-- create/resume isolated container
   +-- checkout configured GitHub repository
   +-- checkout selected branch / commit context
   +-- run environment setup
   +-- agent edits/tests in cloud
   +-- retain a cloud task identity/result
```

The important architectural property is:

> Repo-intensive work occurs in Codex's cloud environment, not in another local Roadmap worktree.

This is essential.

The reason I want Codex Cloud support is specifically that Roadmap may conduct a large Gauntlet matrix with many simultaneous independent agents.

The local machine cannot reasonably carry dozens of active repository worktrees and full development environments.

Do **not** implement Codex support by secretly spawning:

```text
codex exec
```

against dozens of local worktrees.

That defeats the purpose.

Local `codex exec` can remain a possible future/local provider if useful, but it is **not** the provider being requested here.

The requested provider is remote Codex Cloud execution.

---

# 4. Current Codex CLI automation seam

At the time of writing, the CLI exposes a direct cloud submission mechanism conceptually similar to:

```text
codex cloud exec \
    --env <ENV_ID> \
    "<task instructions>"
```

and supports multiple attempts.

It also exposes machine-readable recent-task inspection conceptually similar to:

```text
codex cloud list --json
```

with task information including concepts such as:

```text
id
url
title
status
updated_at
environment_id
environment_label
summary
is_review
attempt_total
```

Verify the exact current schema.

Do not hard-code this prompt's memory of the fields if the CLI has changed.

The provider adapter should normalize Codex-specific status into Roadmap's provider-neutral representation.

---

# 5. Codex Cloud is an experimental integration surface

Treat this carefully.

At the time of writing, the CLI's `codex cloud` command is documented as experimental.

Therefore:

- isolate Codex CLI invocation in one provider adapter,
- isolate output parsing,
- do not scatter CLI-specific assumptions through dispatch core,
- do not make Gauntlet state depend on incidental CLI prose,
- add fixtures around observed machine-readable output,
- fail clearly when a Codex CLI version changes incompatibly,
- prefer explicit capability detection over optimistic guessing.

An upstream CLI change should ideally require changing:

```text
codex-cloud-provider.mjs
```

or equivalent,

not:

```text
gauntlet-core
PR watcher
MCP core
graph
plan
five skills
```

---

# 6. Introduce a real cloud dispatch provider abstraction

Inspect the current `dispatch-providers.mjs` design first.

It may already contain enough abstraction.

If so, evolve it rather than replacing it.

Conceptually Roadmap should be able to ask:

```text
launchRemoteAgent(spec)
```

without Gauntlet knowing the provider mechanics.

A dispatch specification may logically contain:

```text
subject_type
subject_key

role

provider

repository
base_ref
base_sha

run_id
round

prompt

expected_head_sha

profile / tier

provider_options
```

Do not use this exact schema blindly.

Design the smallest coherent contract based on the current repo.

The provider should return a normalized receipt along the lines of:

```text
provider

external_id
external_url

role

launched_at

status

provider_metadata
```

Again, names are illustrative.

The important abstraction is:

```text
Roadmap Dispatch Identity
        !=
Provider Execution Identity
```

A Gauntlet run owns Roadmap identity.

Each cloud provider gives Roadmap an external execution receipt.

---

# 7. Providers should advertise capabilities

Do not pretend Claude Routines and Codex Cloud have identical features.

That will create false abstractions.

Instead, represent meaningful provider capabilities.

Potential capability concepts include:

```text
remote_repo_checkout

select_model

select_reasoning_effort

multiple_attempts

structured_task_status

native_pr_context

native_pr_review

push_existing_pr

create_pr

custom_branch

exact_base_sha

cancel_task

retrieve_full_result

retrieve_diff
```

Do not necessarily expose all of these publicly.

But provider code should know what the provider can actually guarantee.

This matters because one provider may support:

```text
model = opus
```

while another may not currently expose per-task model selection.

One may naturally return a PR.

Another may naturally return a task/diff that requires publication.

One may support native PR review.

Another may require an ordinary cloud agent to inspect the PR.

The common abstraction should capture shared semantics without inventing false equivalence.

---

# 8. Codex Cloud model selection must not be faked

This is important.

At the time this delta was written, Codex supports the GPT-5.6 family broadly, but the official documentation says the default model for **Codex Cloud chats cannot currently be changed**.

Likewise, the documented `codex cloud exec` CLI currently exposes things like:

```text
environment
attempts
task prompt
```

but not the ordinary local:

```text
--model
```

control.

Therefore:

Do NOT implement:

```text
roadmap dispatch x --provider codex --model gpt-5.6-luna
```

and silently pretend Luna was used.

If explicit model selection is unavailable for Codex Cloud:

```text
supports(select_model) = false
```

The user should receive a truthful capability error or warning.

Examples conceptually:

```text
Codex Cloud does not currently expose per-task model selection.
Requested model "gpt-5.6-luna" cannot be guaranteed.
```

Do not silently fall back to:

- the Codex default model,
- local Codex,
- OpenAI API billing,
- Claude,
- or another provider.

Fallback between economically or behaviorally different providers must be explicit.

If this changes in a newer Codex release, design the adapter so model support can be enabled without changing Gauntlet core.

---

# 9. Preserve existing Routine tiers, but do not confuse tier with provider capability

The existing Claude dispatch system may have concepts like:

```text
dispatch_tier
routine tier
critic tier
```

Preserve backward compatibility where possible.

But do not assume:

```text
tier = model
```

or:

```text
tier semantics are portable across providers
```

A better conceptual separation is:

```text
dispatch profile
    |
    +-- provider = claude
    |      +-- routine/tier = ...
    |
    +-- provider = codex
           +-- environment = ...
           +-- attempts = ...
           +-- model selection unavailable/current-default
```

A profile can express intent.

The adapter maps that intent onto real capabilities.

If a profile requires something the provider cannot provide, fail clearly.

---

# 10. Provider choice should work for ordinary Roadmap dispatch too

This is not only a Gauntlet feature.

I want Codex to become a legitimate Roadmap dispatch provider generally.

Conceptually I should eventually be able to do something like:

```text
roadmap dispatch auth-refresh --provider codex
```

or:

```text
roadmap dispatch auth-refresh --provider claude
```

and possibly configure a repository default.

Likewise MCP `dispatch` should accept an optional provider or resolved dispatch profile.

Do not necessarily use those exact CLI flags.

Integrate with existing conventions.

Desired principle:

```text
roadmap dispatch
```

means:

> send this Roadmap work packet to a configured remote implementation provider

not:

> invoke Claude Routine specifically.

Claude can remain the default initially for compatibility.

But the semantic API should become provider-neutral.

---

# 11. Make `fan_cloud` provider-aware

Inspect current MCP `fan_cloud`.

If it currently means:

```text
fan multiple Claude Routines
```

evolve the underlying semantics toward:

```text
fan multiple remote workers
```

Possible outcomes:

- retain `fan_cloud` as the public backward-compatible name,
- add provider selection,
- later alias it to a more neutral term.

Do not churn public APIs unnecessarily.

But do not leave the implementation structurally Claude-only.

Long term, I want something conceptually like:

```text
fan_cloud([
    sliceA provider=codex,
    sliceB provider=codex,
    sliceC provider=claude
])
```

or a resolved profile producing the same result.

---

# 12. Codex environments should be repository configuration, not task identity

Codex Cloud requires a configured cloud environment.

That environment should be treated similarly to how Claude Routine configuration is mapped today:

```text
repository
    ->
Codex environment ID
```

Inspect existing configuration patterns first.

Potential concept:

```text
dispatch:
  default_provider: claude

  providers:
    claude:
      ...

    codex:
      environment_id: ...
```

or a profile-based equivalent.

Do not use this YAML literally unless it fits existing config.

Requirements:

- environment IDs must not be hard-coded throughout source,
- different repositories can map to different Codex environments,
- missing configuration must fail clearly,
- environment identity should be visible in diagnostics,
- no secrets should be written to roadmap YAML,
- provider selection should resolve deterministically.

---

# 13. Do not create local worktrees for Codex Cloud dispatch

This is an explicit acceptance criterion.

For:

```text
provider = codex_cloud
```

Roadmap should not need to:

```text
git worktree add
clone repo locally
npm install
build app locally
reserve local branch directories
```

merely to execute the worker.

The provider's defining value is remote isolated compute.

Roadmap may inspect Git/GitHub metadata locally as needed.

It should not host the worker filesystem.

Add tests ensuring a Codex cloud dispatch does not enter local fanout/worktree creation paths.

---

# 14. Codex task identity must be captured robustly

This is important for massive parallelism.

Never implement Codex reconciliation as:

```text
launch task
sleep
codex cloud list
take most recent task
```

That fails immediately under concurrency.

If thirty critics launch simultaneously, "latest task" has no meaning.

When `codex cloud exec` is invoked, determine from actual current behavior how to obtain the exact new task identity.

Prefer, in order:

1. explicit machine-readable task ID returned by the command, if available;
2. a stable task URL containing a task ID, if officially supported and reliably parseable;
3. another documented exact correlation mechanism.

If the current CLI does not expose an unambiguous task identifier from submission, investigate before inventing a heuristic.

Do **not** ship a race-prone `latest task` association.

This is a hard concurrency requirement.

Every Roadmap dispatch receipt must bind to exactly one Codex cloud task.

---

# 15. `codex cloud list --json` should become a sensor, not the database

Once a task ID is known, Roadmap may use the Codex CLI's machine-readable task listing to observe states.

But the Codex service should not become Roadmap's canonical execution database.

The run ledger should retain the minimal external receipt:

```text
provider=codex
external_task_id=...
external_url=...
environment_id=...
```

and Codex can be queried for current status.

GitHub should still be the durable work-artifact reality whenever work has become a PR.

If the Codex task disappears from the short recent-task listing, Roadmap should not lose its Gauntlet history.

---

# 16. Pagination matters

The current Codex cloud task list may return only a bounded number of tasks per request.

A Gauntlet can easily exceed that.

Do not write logic that assumes:

```text
all active tasks fit in the first 20 results
```

If status lookup depends on list pagination:

- follow cursors correctly,
- stop when the exact task is found,
- avoid unbounded scanning,
- cache safely if useful,
- test with more tasks than one page.

Massive parallelism is a target use case, not an edge case.

---

# 17. Multiple attempts are not the same as multiple independent critics

Codex Cloud may support a provider feature equivalent to:

```text
--attempts 1-4
```

Treat that as provider-specific best-of-N execution.

Do **not** automatically equate:

```text
attempts=3
```

with:

```text
three independent Gauntlet critics
```

unless the provider exposes all attempts as separately inspectable independent verdicts.

For Gauntlet epistemic independence, prefer:

```text
critic dispatch A
critic dispatch B
critic dispatch C
```

with:

```text
three task IDs
three fresh contexts
three attributable outputs
```

rather than one opaque best-of-three task.

`attempts` may still be useful for implementation quality or another role.

But do not destroy critic independence by hiding it inside provider selection behavior.

---

# 18. Fresh Codex critic = new cloud task

For Gauntlet criticism, never continue the implementation Codex chat and ask:

```text
now review your own work
```

That violates the entire Gauntlet principle.

Even if implementation used Codex:

```text
implementation_task = codex task A
critic_task         = codex task B
```

The critic should have a new task identity and fresh conversation context.

Cloud environment caching is an implementation detail.

Conversational independence is the invariant.

The critic receives only:

- frozen bar,
- PR/artifact,
- exact head SHA,
- repository context,
- review rubric,
- observable evidence.

Not the implementation chat transcript.

---

# 19. Mixed-provider Gauntlets are a first-class goal

This is one of the biggest reasons to generalize now.

These should all be conceptually valid:

```text
Claude implementation
    ->
Codex critic
    ->
Claude repair
    ->
Codex critic
```

```text
Codex implementation
    ->
Claude critic
    ->
Codex repair
    ->
Claude critic
```

```text
Codex implementation
    ->
Codex critic in a fresh task
    ->
Codex repair in a fresh task
```

```text
Claude implementation
    ->
Claude critic in a fresh Routine
```

The Gauntlet state machine must not care.

Each execution record should carry:

```text
provider
external execution ID
role
round
reviewed/expected SHA
```

The critic protocol and stale-SHA rules remain identical.

This also creates useful future epistemic diversity:

A high-risk change could intentionally use a critic from a different model/provider than the builder.

Make that possible without making it mandatory.

---

# 20. Separate provider from role

Do not create concepts such as:

```text
ClaudeImplementationWorker
ClaudeCriticWorker
CodexImplementationWorker
CodexCriticWorker
```

throughout the core.

The axes are:

```text
ROLE
implementation
critic
repair
...

PROVIDER
claude
codex
...
```

A dispatch is their product:

```text
role=critic
provider=codex
```

The role determines the task contract.

The provider determines how the disposable worker is launched.

That distinction is fundamental.

---

# 21. Generalize Gauntlet provider selection

The Gauntlet should support provider selection at the run/profile level.

Conceptually something like:

```text
gauntlet_start(
    key,
    implementation_provider?,
    critic_provider?,
    repair_provider?
)
```

may be appropriate.

But do not necessarily expose three knobs if profiles fit Roadmap better.

Another possible concept:

```text
gauntlet_profile = "codex"
```

or:

```text
gauntlet_profile = "mixed-adversarial"
```

that resolves to:

```text
implementation -> codex
critic         -> claude
repair         -> codex
```

The exact UX is yours.

Requirements:

- sensible default,
- explicit override,
- provider recorded per launched worker,
- resumable after restart,
- status displays provider,
- no provider ambiguity.

---

# 22. Investigate Codex's GitHub-native transport

Codex has an additional integration path that may be extremely useful for Gauntlet.

Research the current official behavior of GitHub-triggered Codex cloud tasks.

In particular investigate:

```text
@codex review
```

one-off focused review instructions,

and arbitrary:

```text
@codex <instruction>
```

on an existing pull request.

At the time this delta was written, Codex documentation indicated that:

- a PR comment can request a Codex review,
- a review can receive one-off focus instructions,
- arbitrary `@codex` PR instructions can start a cloud chat with that PR as context,
- Codex can sometimes push a requested fix back to that PR branch when permissions permit.

Verify all of this.

This creates the possibility that Codex provider execution has two transports:

```text
CODEX PROVIDER

1. cloud_cli
   codex cloud exec ...

2. github_pr
   GitHub comment / native Codex integration
```

Do not introduce both unless they provide real value.

But investigate them before assuming all Codex work must go through `cloud exec`.

---

# 23. The GitHub-native Codex path may be especially valuable for critics and repairs

Once a Gauntlet PR already exists:

```text
PR #182 @ abc123
```

Codex's native PR context may be a better execution seam than creating a generic repository task.

Potential critic flow:

```text
Roadmap
   |
create exact critic request against PR #182 @ abc123
   |
Codex cloud review/task
   |
GitHub review/comment
   |
Roadmap parses result
```

Potential repair flow:

```text
Roadmap
   |
create exact repair instruction against PR #182
expected head=abc123
   |
Codex cloud task
   |
push fix to existing PR branch
   |
new head=def456
```

This aligns well with Gauntlet because:

- GitHub remains the rendezvous point,
- repair targets the existing PR,
- worker compute remains remote,
- local worktrees are unnecessary.

But do not assume Codex's standard code-review format satisfies our custom Gauntlet critic contract.

Investigate.

---

# 24. Native Codex Code Review is not automatically equivalent to a Gauntlet critic

This distinction matters.

A standard Codex code review may have its own:

- severity policy,
- output schema,
- scope,
- rules,
- prioritization.

Our Gauntlet critic has a stronger custom contract:

```text
frozen external bar
exact reviewed SHA
PASS / REVISE / HUMAN_REQUIRED
bar checks
evidence
must fix
should fix
uncertainty
```

Therefore:

Do not simply replace:

```text
gauntlet critic
```

with:

```text
@codex review
```

and call the feature complete.

Determine whether Codex's GitHub review can reliably carry:

- the frozen bar,
- one-off critic instructions,
- exact SHA attribution,
- sufficient structured evidence,
- our verdict semantics.

If not, use a custom Codex cloud task for Gauntlet criticism.

Native Code Review can remain:

- an additional sensor,
- a specialized reviewer,
- or a provider transport where appropriate.

Gauntlet semantics belong to Roadmap, not Codex.

---

# 25. Codex repair on an existing PR looks particularly promising

Research and, if safe, test the flow where Codex receives PR-context instructions and pushes changes back to the existing PR branch.

If reliable, this may be an excellent implementation for:

```text
provider=codex
role=repair
```

The Roadmap repair dispatch should still contain:

```text
run_id
round
PR number
expected head SHA
frozen bar
lead-synthesized repair packet
```

The worker instruction must explicitly require:

```text
Before changing anything:

1. determine the current PR head,
2. compare it to expected_head_sha,
3. if they differ:
      make no changes
      report INVALID_OR_STALE
```

Roadmap should independently verify the same condition before triggering the worker.

Defense in depth.

---

# 26. Initial Codex implementation publication is a key question to resolve

Do not gloss over this.

Claude Routines currently fit the Roadmap contract because the worker can:

```text
implement
commit
push
open PR
```

Codex Cloud may have a different publication model.

At the time of this delta, Codex Cloud clearly supports performing changes remotely and its UI can turn cloud work into a PR, but determine what is currently available **programmatically** from Roadmap.

Research:

1. Can `codex cloud exec` be instructed to autonomously push/open a PR through the connected GitHub integration?

2. Is there an official CLI command/API for publishing a completed cloud task directly to a GitHub PR?

3. Can GitHub issue-triggered Codex tasks produce PRs in a machine-orchestratable way?

4. Is there another official unattended Codex Cloud publication seam?

Do not assume.

Demonstrate it.

---

# 27. Do not solve Codex publication by silently applying cloud diffs locally

The Codex CLI may support something conceptually like:

```text
codex apply <TASK_ID>
```

which applies a cloud-task diff to the local repository.

That is useful interactively.

It is **not** the primary architecture I want for Roadmap Gauntlet execution.

Do not turn this into:

```text
30 cloud tasks
      |
30 codex apply operations
      |
30 local worktrees
```

That recreates the local-volume problem.

For the requested design:

```text
cloud implementation
    ->
cloud/GitHub publication
```

is preferred.

`codex apply` may be useful as:

- manual recovery,
- debugging,
- an explicit fallback,

but not the normal massively parallel execution path.

---

# 28. If fully unattended Codex implementation publication is currently impossible, say so architecturally

Do not fake support.

If current Codex Cloud automation supports:

```text
remote task execution
```

but does not yet expose a reliable unattended:

```text
task -> PR
```

transition through the available interface, represent that limitation truthfully.

A Codex execution could then reach a state conceptually like:

```text
completed_unpublished
```

or:

```text
awaiting_artifact_publication
```

rather than pretending the Roadmap slice has a PR.

Then:

- Claude may remain the default implementation provider temporarily,
- Codex may still be fully usable for critics/repairs,
- the provider adapter will already be ready when upstream publication support becomes scriptable.

Prefer an honest partial capability over a brittle automation hack.

However, investigate the GitHub-native Codex path carefully before concluding this limitation exists.

---

# 29. Provider-neutral task state

Do not put Claude session terminology into the generic run model.

Instead of:

```text
implementation_session
critic_sessions
repair_sessions
```

consider generic execution concepts like:

```text
implementation_execution
critic_executions
repair_executions
```

Each execution can carry:

```text
provider
external_id
external_url
status
launched_at
completed_at
metadata
```

Provider-specific metadata may include:

Claude:

```text
routine
session_id
session_url
tier
```

Codex:

```text
task_id
task_url
environment_id
attempt_total
```

Do not over-normalize provider-specific details.

But generic code should not require knowing their names.

---

# 30. Update Gauntlet run identity accordingly

The existing Gauntlet run design remains.

But worker records should now be provider-neutral.

Conceptually:

```text
run_id
subject_type
subject_key

base_sha

pr_number
pr_url

round

current_head_sha

state

executions:
  - id
  - role
  - provider
  - provider_execution_id
  - provider_url
  - round
  - expected_head
  - status

latest_valid_critic_verdict
```

Again: design minimally.

Do not create a giant event store.

The goal is only enough information to:

- avoid duplicates,
- reconstruct in-flight work,
- query external providers,
- understand which provider owns which execution.

---

# 31. Provider must be part of idempotency

Existing idempotency rules need one additional dimension.

For example, a critic launch lock may logically be:

```text
run_id
head_sha
critic_role
provider
```

Think carefully about whether provider belongs in equivalence.

If I explicitly ask for:

```text
one Claude critic
one Codex critic
```

those must be allowed concurrently.

If I accidentally call:

```text
Codex critic
Codex critic
```

twice for the same run/head/role,

the default should remain idempotent unless explicit replicas were requested.

Design a clean identity such as:

```text
critic_slot
```

or:

```text
replica
```

if necessary.

Do not solve this by making every retry look unique.

---

# 32. Replicated critics should become possible

Longer term, the Gauntlet should support:

```text
PR @ xyz
   |
   +-- critic 1 / Codex
   +-- critic 2 / Codex
   +-- critic 3 / Claude
```

This is especially relevant to massively parallel evaluation work.

The lead can then synthesize:

```text
agreement
disagreement
confidence
```

Do not make multi-critic replication the ordinary V1 default unless it is already easy.

But provider abstraction should not make it impossible.

An explicit critic instance must have stable identity.

---

# 33. Do not let provider parallelism contaminate critic independence

Roadmap may launch many Codex cloud tasks at once.

That is good.

But ensure no accidental shared prompt state exists.

Each atomic critic should get its own task payload.

Do not create one Codex chat and then ask it to spawn or continue all thirty critiques if the objective is independent judgment.

For Gauntlet evaluation:

```text
parallelism
+
fresh context
+
independent task identity
```

is the goal.

Not merely:

```text
one agent internally parallelized.
```

---

# 34. Authentication model

Research actual current Codex authentication behavior.

The desired personal setup is:

```text
local Roadmap process
        |
installed Codex CLI
        |
ChatGPT-authenticated Codex account
        |
Codex Cloud
```

Roadmap should inherit/use Codex's supported authenticated CLI state.

Do not:

- extract OAuth tokens,
- copy Codex credentials into Roadmap state,
- store ChatGPT auth in roadmap YAML,
- log bearer tokens,
- invent a parallel authentication implementation.

The provider should invoke the supported Codex client.

If Codex is:

- missing,
- logged out,
- unauthorized for cloud,
- missing repository access,

surface a diagnostic with a useful remediation message.

---

# 35. API-key Codex and ChatGPT Codex are not interchangeable

Research this explicitly.

At the time of writing, OpenAI distinguishes:

```text
Codex authenticated through ChatGPT
```

from:

```text
Codex authenticated with API key
```

for cloud-backed product features.

Roadmap should not assume that setting:

```text
OPENAI_API_KEY
```

means Codex Cloud is available.

Provider diagnostics should test the actual capability required.

This matters because I want Codex Cloud in part to leverage the Codex/ChatGPT subscription execution model rather than accidentally converting these jobs into API-billed local/SDK tasks.

Do not silently cross that boundary.

---

# 36. Keep OpenAI API execution separate from Codex Cloud

A future provider could be:

```text
openai_responses
```

using GPT-5.6 Luna directly.

That could be valuable for cheap evidence-only critics.

But that is a **different provider**.

Do not implement:

```text
provider=codex
```

and then secretly call:

```text
POST /v1/responses
```

because Codex Cloud launch failed.

Those have different:

- billing,
- runtime,
- repository access,
- isolation,
- authentication,
- tool behavior.

Model them honestly.

Potential future provider taxonomy:

```text
claude_routine

codex_cloud

codex_local

openai_api
```

V1 only needs what is justified.

The immediate request is:

```text
claude_routine
codex_cloud
```

---

# 37. Security around shelling out to Codex

If the provider uses the Codex CLI from Node:

Do not construct unsafe shell strings.

Prefer an argument-array process invocation such as the equivalent of:

```text
execFile / spawn
```

rather than:

```text
exec("codex cloud exec --env " + userInput + " " + prompt)
```

The payload may contain:

- quotes,
- shell syntax,
- newlines,
- markdown,
- user-controlled roadmap text.

It must not become shell execution.

Use the current repo's injectable IO/process patterns.

Make command construction pure/testable where possible.

---

# 38. Large prompt transport

A Gauntlet critic prompt may be substantial.

Investigate the practical limits of:

```text
codex cloud exec ... QUERY
```

when the query contains a frozen bar and structured instructions.

Do not carelessly create OS argument-length problems.

If the CLI supports stdin or an appropriate documented input mechanism, prefer it where beneficial.

If not, design the prompt compactly and test realistic payload sizes.

Do not invent undocumented flags.

---

# 39. Environment setup and internet access are provider concerns

Codex Cloud environments may define:

- dependencies,
- setup scripts,
- environment variables,
- internet access,
- runtime versions.

Roadmap should not duplicate this environment provisioning system.

Roadmap's job is to resolve:

```text
repository -> codex environment
```

and dispatch.

If the environment is invalid, report infrastructure failure.

Do not make Roadmap install dependencies into Codex containers itself.

Likewise, do not assume arbitrary internet access is available during agent execution.

The task should rely on repository-local evidence unless the configured environment explicitly supports more.

---

# 40. GitHub remains the provider-neutral rendezvous point

This requirement from the original mission becomes even more important.

Do not let the architecture become:

```text
Claude result lives in GitHub
Codex result lives only in Codex
```

for completed implementation work.

Once a worker has produced implementation intended for the shared Gauntlet:

the durable artifact should converge on GitHub.

Ideally:

```text
implementation
    -> PR

critic
    -> review/comment tied to SHA

repair
    -> new commits on same PR
```

Provider sessions/tasks remain execution receipts.

They are not the shared reality.

---

# 41. Provider execution output should not become required semantic memory

A future lead should not need to read:

- Claude transcript,
- Codex cloud transcript,

to know what happened.

The provider receipt answers:

```text
where did this work run?
what is its status?
```

GitHub answers:

```text
what artifact exists?
what changed?
what SHA was reviewed?
what verdict was published?
```

Roadmap answers:

```text
which run/role/round does this belong to?
```

Keep those concerns separate.

---

# 42. Codex-specific status should appear in normal Roadmap observability

Example human status:

```text
auth-refresh
run: gnt_auth_01
PR: #182 @ def456
round: 2 / 3
state: awaiting critic

implementation:
  provider: codex
  task: 8f3...
  status: complete

critic #1:
  provider: claude
  reviewed: abc123
  verdict: REVISE

repair #1:
  provider: codex
  expected: abc123
  task: 9a1...
  status: complete
  produced: def456

critic #2:
  provider: codex
  task: 7b8...
  status: running
```

Keep actual CLI output concise.

Structured MCP output can contain richer provider metadata.

---

# 43. Provider-level diagnostics

Consider a small pure/read-only capability that helps the lead diagnose dispatch readiness.

Not necessarily a new public command.

Conceptually:

```text
providerStatus("codex")
```

may establish:

```text
CLI installed
authenticated
cloud available
environment configured
repository mapping valid
model selection unsupported
```

This should not mutate anything.

A failed Gauntlet launch should explain:

```text
Infrastructure failure:
Codex Cloud provider configured, but environment ID is missing.
```

rather than:

```text
spawn failed code 1
```

---

# 44. Provider failure is not implementation failure

Extend the original infrastructure distinction.

Examples of Codex provider failures:

```text
Codex CLI missing

Codex CLI logged out

cloud feature unavailable

environment ID invalid

repository not authorized

task submission failed

task disappeared / failed

CLI output incompatible

GitHub Codex integration lacks branch push permission
```

These must result in:

```text
INFRASTRUCTURE_FAILURE
```

or an appropriate provider failure state.

Do not tell the lead:

```text
implementation failed acceptance
```

when the agent never actually ran.

---

# 45. Provider fallback must be intentional

Suppose:

```text
critic provider = codex
```

and Codex Cloud is unavailable.

Do not automatically fire Claude instead.

The lead may want provider diversity for a reason.

Return:

```text
requested provider unavailable
```

and let the lead decide whether to:

- retry,
- switch providers,
- defer,
- escalate.

The long-lived lead remains executive function.

---

# 46. Preserve SHA pinning across providers

Every original SHA rule still applies.

Provider neutrality must not weaken concurrency control.

Codex critic:

```text
expected review head = abc123
```

Claude critic:

```text
expected review head = abc123
```

same invariant.

Codex repair:

```text
expected branch head = abc123
```

Claude repair:

```text
expected branch head = abc123
```

same invariant.

The provider adapter merely transports the assignment.

The lead/runtime validates the artifact.

---

# 47. Codex GitHub review attribution

If you use Codex's native GitHub Code Review path, investigate exactly how GitHub represents:

- review author,
- reviewed commit SHA,
- review ID,
- timestamps,
- associated task identity if exposed.

Do not infer current-head validity merely because a Codex review is the newest comment.

Prefer GitHub's actual review commit/SHA metadata where possible.

Correlate the review request with:

```text
run
round
requested head
critic identity
```

If Codex's native review cannot be deterministically associated with the correct Gauntlet critic dispatch, do not use it as the canonical verdict transport.

---

# 48. Gauntlet markers remain provider-neutral

Do not create separate protocols such as:

```text
roadmap-claude-gauntlet
roadmap-codex-gauntlet
```

The GitHub protocol should remain:

```text
roadmap-gauntlet
```

Provider may appear as optional metadata:

```text
provider=codex
```

but run identity must not depend on it.

A PR created by Claude should be criticizable by Codex.

A PR created by Codex should be repairable by Claude.

That is a fundamental acceptance criterion.

---

# 49. Critic result protocol remains Roadmap-owned

Even when Codex provides the critic, the verdict vocabulary remains:

```text
PASS
REVISE
HUMAN_REQUIRED
INVALID_OR_STALE
```

Do not create:

```text
ClaudeVerdict
CodexVerdict
```

Provider-native output must be normalized into Roadmap's critic result protocol.

Preserve original requirements around:

- must_fix,
- should_fix,
- evidence,
- uncertainty,
- tests,
- architecture,
- reviewed SHA.

---

# 50. Consider provider diversity as an optional Gauntlet technique

Do not make this automatic everywhere.

But teach the Gauntlet skill that independent provider/model families can sometimes increase critic independence.

Example:

```text
builder: Codex
critic: Claude
```

or:

```text
builder: Claude
critic: Codex
```

may reduce shared contextual/model bias.

For high-risk work the lead may deliberately request heterogeneous critics.

This is an orchestration judgment.

Roadmap should permit it, not decide it.

---

# 51. The suite-evaluation / massively parallel use case is an important design test

One concrete future Gauntlet I want Roadmap to support is not merely coding implementation.

Imagine evaluating five applications across:

```text
5 applications
x
6 coherence dimensions
```

with thirty independent critics, plus:

```text
6 horizontal critics
10 pairwise critics
workflow critics
adversarial meta-critics
```

Many of these agents need a real repository and possibly runnable artifacts.

The desired topology is:

```text
LOCAL LEAD
    |
    +-- Codex Cloud task 01
    +-- Codex Cloud task 02
    +-- Codex Cloud task 03
    +-- ...
    +-- Codex Cloud task 60
```

not:

```text
LOCAL LEAD
    |
    +-- local worktree 01
    +-- local worktree 02
    ...
    +-- local worktree 60
```

You do **not** need to build the complete evaluation matrix feature in this initiative.

But use it as an architectural stress test.

Ask:

> Would this dispatch architecture survive sixty independent remote tasks without confusing identity, exhausting local worktrees, or depending on “most recent task” heuristics?

If not, fix the abstraction now.

---

# 52. Provider concurrency limits should be policy, not identity

Different providers may have different practical concurrency or usage limits.

Do not bake arbitrary:

```text
Codex max 5
Claude max 10
```

values into Gauntlet core unless they are real externally required constraints.

If throttling becomes necessary, it belongs in provider/configuration policy.

The Gauntlet run graph should conceptually permit large parallelism.

The dispatcher decides how much can safely be submitted at once.

---

# 53. Preserve cost visibility without pretending cost models are identical

Claude and Codex may consume usage differently.

Do not create fake cross-provider cost precision.

But record enough metadata that future Roadmap functionality could answer:

```text
which provider ran this?
which profile/tier?
how many attempts?
```

If the provider exposes usage data, retain useful structured receipts.

Do not build a billing engine in this initiative.

---

# 54. Update the MCP contract

Review the actual MCP tools.

At minimum, ordinary dispatch and Gauntlet dispatch should become provider-aware.

Conceptually:

```text
dispatch
  key
  provider?
  profile?
```

```text
fan_cloud
  keys
  provider/profile?
```

```text
gauntlet_start
  key
  provider/profile options?
```

```text
gauntlet_critic
  run_id
  provider?
  critic_role?
```

```text
gauntlet_repair
  run_id
  expected_head
  provider?
  repair_packet
```

Do not blindly add all these fields if a cleaner profile resolution mechanism already exists.

But the lead must be able to intentionally request Codex.

---

# 55. Update CLI behavior

Desired human experience, approximately:

```text
roadmap dispatch auth-refresh --provider codex
```

returns something concise such as:

```text
Dispatched auth-refresh
provider: codex
environment: roadmap
task: <id>
url: <url>
```

Later:

```text
roadmap gauntlet status auth-refresh
```

should show provider-aware state.

Keep the command surface consistent with existing Roadmap style.

---

# 56. Backward compatibility

Existing commands and configuration should continue working where reasonable.

A user with only Claude Routines configured should not be forced to configure Codex.

Possible default migration:

```text
existing behavior
    =>
provider implicitly claude
```

Then Codex becomes opt-in.

Do not rename every Claude-oriented config key immediately merely for aesthetic purity if that creates needless migration risk.

Introduce the provider seam first.

Deprecate old names later if warranted.

---

# 57. Tests for the Codex provider

Add pure/injected tests around at least:

### Command construction

Given:

```text
environment
prompt
attempt count
```

construct the correct Codex CLI invocation without shell injection.

### Exact identity capture

One launch produces one exact external task identity.

### Parallel launches

Several simultaneous launch receipts do not cross-associate.

### Machine-readable status

Normalize Codex task status correctly.

### Pagination

Find exact task beyond first task-list page.

### Missing CLI

Fail clearly.

### Authentication failure

Classify infrastructure failure.

### Missing environment

Fail before launch.

### Unsupported model request

Do not silently accept:

```text
model=luna
```

when Cloud cannot guarantee it.

### Duplicate dispatch

Idempotent retry does not create a second task.

### No local worktree

Codex Cloud launch does not invoke local fanout/worktree creation.

### Mixed providers

One run can contain Claude and Codex executions.

### Restart

Provider task receipts survive/reconstruct after lead restart.

---

# 58. Tests for GitHub-native Codex integration if adopted

If you use the GitHub transport, test:

### Exact PR

Request targets the intended PR.

### Exact head

Review/repair is pinned to the expected head.

### Stale head

If the PR moves before execution, the result cannot pass the new head.

### Review correlation

A Codex review is associated with the correct Gauntlet critic request.

### Concurrent reviews

Two different critic roles do not steal each other's results.

### Repair branch

Codex repair updates the intended existing PR, not a new competing PR.

### Permission failure

Lack of push permission becomes infrastructure failure.

### User comments

An unrelated human `@codex` comment must not be mistaken for Roadmap's Gauntlet worker.

---

# 59. End-to-end Codex Cloud verification

Do not call this complete based solely on mocked CLI output.

Using a safe repository/environment where appropriate, demonstrate as much of the real lifecycle as the current Codex interfaces permit.

At minimum:

```text
Roadmap
  ->
Codex Cloud dispatch
  ->
remote cloud task identity
  ->
remote repository work
  ->
task completion/status observation
```

Demonstrate multiple simultaneous cloud tasks.

Confirm that they do **not** create corresponding local Roadmap worktrees.

Then test the GitHub bridge.

Ideal full path:

```text
roadmap dispatch --provider codex
    ->
Codex cloud implementation
    ->
PR
    ->
gauntlet critic --provider codex/claude
    ->
REVISE
    ->
gauntlet repair --provider codex
    ->
same PR receives new head
    ->
old verdict stale
    ->
new critic
    ->
PASS
```

If the initial Codex:

```text
cloud task -> automated PR
```

transition is not presently exposed programmatically, demonstrate the strongest real path available and document the exact upstream gap.

Do not pretend.

---

# 60. Update the Gauntlet skill

`skills/gauntlet/SKILL.md` should no longer teach:

```text
fire Claude Routine
```

as the conceptual action.

Teach:

```text
dispatch fresh remote implementation worker
```

Then explain provider selection.

For example:

```text
1. determine work role
2. resolve provider/profile
3. verify provider capability
4. dispatch
5. record execution receipt
6. observe GitHub/provider status
7. validate resulting artifact
```

For critics:

```text
always dispatch fresh execution

do not resume implementation execution

provider may differ from implementation provider
```

For repairs:

```text
target current PR
pin expected SHA
provider must support the required mutation path
```

---

# 61. Update docs from "Routines" to "remote agents" where conceptually appropriate

Review:

```text
docs/RHYTHM.md
docs/DEPLOYMENT.md
README
AGENTS.md
CLAUDE.md
skills/fanout/SKILL.md
skills/sync/SKILL.md
```

Do not erase useful Claude-specific setup instructions.

Instead distinguish:

```text
CONCEPT:
remote dispatch provider

IMPLEMENTATIONS:
Claude Routines
Codex Cloud
```

A new agent entering the repo should understand that Roadmap's orchestration architecture is provider-neutral.

---

# 62. AGENTS.md matters particularly for Codex

Codex Cloud consumes repository guidance such as `AGENTS.md`.

Review whether the existing file gives a disposable Codex cloud worker enough information to:

- understand Roadmap conventions,
- run relevant tests,
- avoid merging,
- respect scope boundaries,
- understand PR markers,
- understand Gauntlet worker protocol.

Do not stuff dynamic Gauntlet state into AGENTS.md.

Dynamic task instructions belong in the dispatch payload.

AGENTS.md should contain stable repository-wide behavior.

---

# 63. Do not turn Codex-native automation into the executive function

The same original principle applies.

Codex has native:

- GitHub review triggers,
- cloud chats,
- automatic reviews,
- other automations.

Useful.

But the desired Gauntlet is not:

```text
Codex sees PR
  -> reviews automatically
  -> fixes automatically
  -> reviews automatically
  -> ...
```

The lead remains causal center.

Roadmap explicitly requests the next specialist after evaluating current reality.

Native provider triggers are actuators, not executive logic.

---

# 64. Provider-native automatic review should not accidentally double-launch critics

If Codex automatic GitHub review is enabled for the repository, a newly opened Gauntlet PR may receive a review without Roadmap asking for one.

Do not accidentally interpret that as the formal Gauntlet critic unless it satisfies the run's critic contract.

Likewise, if Roadmap explicitly launches a Codex critic, do not also trigger a duplicate native review unintentionally.

Investigate this interaction.

Provider background automation is external state.

Treat it deliberately.

---

# 65. Preserve the nervous-system principle

The final architecture should now be understood as:

```text
Roadmap knows:

- what work exists,
- which provider should execute it,
- what provider task was launched,
- what external task identity came back,
- what artifact appeared,
- what PR/head is current,
- which SHA was reviewed,
- whether a result is stale,
- what specialist can safely launch next.

Roadmap does NOT know:

- how to make product judgments,
- which critic complaint is philosophically correct,
- whether an aesthetic tradeoff is worth taking,
- whether another iteration has enough value.
```

That remains the lead model's job.

---

# 66. Updated final design principle

The original principle becomes:

> Roadmap should not become the intelligence. It should become a provider-neutral nervous system for distributed agent work.

The lead supplies judgment.

Cloud providers supply disposable execution.

Claude Routines are one source of labor.

Codex Cloud is another source of labor.

Independent critics supply adversarial pressure.

GitHub supplies durable shared reality.

The Gauntlet Loop supplies the quality-control structure.

No provider should become synonymous with the architecture.

---

# 67. Updated definition of done

In addition to all original Gauntlet criteria, I will consider this delta successful when:

### General dispatch

I can conceptually request:

```text
roadmap dispatch <key> --provider codex
```

and Roadmap launches a real remote Codex Cloud task against the correctly configured repository environment without creating a local worker worktree.

### Receipt

Roadmap stores/returns an exact Codex task identity and URL.

### Observation

Roadmap can later determine the status of that exact task without relying on "latest task" heuristics.

### Concurrency

Several Codex cloud tasks can run simultaneously without cross-association.

### Provider-neutral core

Existing Claude dispatch continues working through the same higher-level dispatch semantics.

### Gauntlet

A Gauntlet worker role can choose Codex as provider.

### Mixed provider

A Claude-produced PR can be reviewed or repaired by Codex, and a Codex-produced artifact can be reviewed by Claude.

### Fresh criticism

A Codex critic is a fresh cloud task, not continuation of its implementation task.

### SHA correctness

Codex criticism/repair follows exactly the same stale-head rules as Claude.

### GitHub convergence

Completed implementation work ultimately converges on the same GitHub PR/commit/review reality regardless of provider.

### No local scale bottleneck

Mass parallel Codex dispatch does not require matching local worktrees or dependency installations.

### Honest capabilities

Roadmap never claims Codex Cloud used an explicitly requested model if the provider cannot currently control the cloud model.

### No billing sleight of hand

Codex Cloud failure does not silently fall back to an API-billed OpenAI implementation.

### Restartability

A new lead can reconstruct a mixed Claude/Codex Gauntlet run using Roadmap state, provider receipts, and GitHub.

---

# 68. Work this delta into the implementation now

Do not treat this as a separate future initiative if the current Gauntlet architecture is still being built.

This is the ideal moment to establish the provider seam.

Review what you have already implemented.

Specifically look for Claude coupling such as:

```text
routine_session
routine_url
routine tier
fireRoutine(...)
Claude-specific status names
Routine assumptions inside gauntlet-core
```

Determine which of these are legitimately provider-specific and which should become generic.

Refactor only where necessary.

Do not perform abstraction for abstraction's sake.

The goal is not a perfect generic agent framework.

The goal is:

```text
Roadmap can conduct the same Gauntlet
using Claude Routines,
Codex Cloud,
or both,
without changing Gauntlet semantics.
```

---

# 69. Report back with the architectural delta before blindly coding it

After inspecting your current implementation, explicitly tell me:

1. Where the existing design is already provider-neutral.

2. Where it is currently coupled to Claude Routines.

3. What minimal abstraction changes are required.

4. How Codex Cloud submission will work.

5. How exact Codex task IDs will be captured under concurrency.

6. How Codex task status will be observed.

7. How repository → Codex environment mapping will work.

8. Whether fully unattended Codex implementation → PR publication is currently possible through the supported interfaces you verified.

9. Whether Codex's GitHub-native PR transport should be used for:
   - critic,
   - repair,
   - implementation,
   - or none of the above.

10. How model-selection limitations will be represented honestly.

11. How mixed-provider Gauntlet runs will be represented.

12. What tests prove Codex Cloud does not consume local worktree volume.

Then integrate the work into the existing roadmap/Gauntlet implementation plan and continue implementation.

Do not ask me to re-explain the original mission.

Treat this as an amendment to it.

---

## Final acceptance scenario

The architecture should ultimately support a lead doing this:

```text
Lead:
Conduct next wave.

Roadmap:
A -> implementation via Codex Cloud
B -> implementation via Claude Routine
C -> implementation via Codex Cloud
```

Later:

```text
A:
Codex implementation complete
PR #201 @ aaa111

Lead:
Criticize A with Claude.

B:
Claude implementation complete
PR #202 @ bbb222

Lead:
Criticize B with Codex.

C:
Codex task still running.
```

Then:

```text
A critic:
Claude -> REVISE @ aaa111

A repair:
Codex -> same PR -> aaa222

B critic:
Codex -> PASS @ bbb222

C:
implementation PR appears @ ccc111
```

Then:

```text
A old verdict @ aaa111
=> stale against aaa222

A new critic:
fresh Codex or Claude task @ aaa222

B:
PASS

C:
critic dispatched independently
```

At no point should the lead care about provider mechanics beyond:

```text
provider capability
provider availability
provider receipt
```

At no point should sixty remote Codex workers imply sixty local worktrees.

At no point should a provider's private transcript become required state.

At no point should provider-specific limitations be hidden.

The architecture should make this statement true:

> Roadmap conducts the loop. GitHub holds the artifact. Providers perform the labor.

Build toward that.