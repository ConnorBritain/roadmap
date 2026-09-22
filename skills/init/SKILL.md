---
name: init
description: Bootstrap a repo's roadmap graph (docs/roadmap/roadmap.yaml) when none exists — a PM-style interview that warm-starts from any existing roadmap docs, then writes the YAML and renders SLICES.md. Use to onboard a new repo to roadmap.
argument-hint: "[--cold]"
allowed-tools: Read, Write, Glob, Grep, Bash(roadmap validate:*), Bash(roadmap render:*), Bash(roadmap:*), Bash(node:*), Bash(git log:*)
---

You bootstrap `docs/roadmap/roadmap.yaml` through an interview. This is interactive — stay in the main loop; ask, don't guess.

1. **If a roadmap already exists**, say so and suggest `/sync` instead. Stop unless the user wants to re-bootstrap.
2. **Warm-start (default).** Detect existing roadmap material — a tracker, `docs/sprints/**`, a STATUS doc, `git log`. If found, invoke the **roadmap-bootstrapper** agent to draft a `roadmap.yaml` from them, then run a *confirmation* interview that mainly fills the gaps: `est_sessions` per open sprint, the `deps` edges (confirm each inferred one — data-dep vs sequencing), `touches` for shared-file sprints, and `gated_on` for human-gated steps.
3. **Cold-start (`--cold` or no material).** First ask the **work profile**: is this a code repository worked through branches, PRs and a test gate (`engineering`, the default — omit `meta.profile`), or documents / plans / handbooks reviewed by people (`general` — write `meta.profile: general`)? Then interview one dimension at a time: vision/north-star → the PIs + themes → per-PI sprints + session sizing (anchor to "a focused Claude session", not hours) → dependencies → the gate (engineering: the default verification command + per-sprint overrides; general: a checklist of criteria a reviewer confirms, per sprint) → human gates + who → cadence. Engineering only: shared-file contention (`touches`), concurrency appetite, terminal and worktree root. General only: each sprint's `artifact` path (the deliverable). Also offer to set `meta.links` (narrative/status/tracker docs) so SLICES.md cross-links them.
4. **Write** `docs/roadmap/roadmap.yaml` (schema: see the plugin's `schema/roadmap.schema.json`), then **`roadmap validate`** and **`roadmap render`**. Print the initial `roadmap plan` as a sanity check. Launch nothing.

`est_sessions`, statuses, and `deps` are the author's calls — propose, confirm, don't invent. Keep `invoke` keys short, stable, and unique. Composition ratio: a PI under ~3 slices is usually a slice wearing a PI's coat — fold it into a sibling or grow it; offer `meta.discipline.pi_min_slices: 3` so `roadmap validate` keeps watching.
