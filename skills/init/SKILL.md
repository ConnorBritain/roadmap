---
name: init
description: Bootstrap a repo's roadmap graph (docs/roadmap/roadmap.yaml) when none exists — a PM-style interview that warm-starts from any existing roadmap docs, then writes the YAML and renders SLICES.md. Use to onboard a new repo to roadmap.
argument-hint: "[--cold]"
allowed-tools: Read, Write, Glob, Grep, Bash(roadmap validate:*), Bash(roadmap render:*), Bash(roadmap:*), Bash(node:*), Bash(git log:*)
---

You bootstrap `docs/roadmap/roadmap.yaml` through an interview. This is interactive — stay in the main loop; ask, don't guess.

1. **If a roadmap already exists**, say so and suggest `/sync` instead. Stop unless the user wants to re-bootstrap.
2. **Warm-start (default).** Detect existing roadmap material — a tracker, `docs/sprints/**`, a STATUS doc, `git log`. If found, invoke the **roadmap-bootstrapper** agent to draft a `roadmap.yaml` from them, then run a *confirmation* interview that mainly fills the gaps: `est_sessions` per open sprint, the `deps` edges (confirm each inferred one — data-dep vs sequencing), `touches` for shared-file sprints, and `gated_on` for human-gated steps.
3. **Cold-start (`--cold` or no material).** Interview from scratch, one dimension at a time: vision/north-star → the PIs + themes → per-PI sprints + session sizing (anchor to "a focused Claude session", not hours) → dependencies → shared-file contention (`touches`) → human gates + who → the default verification gate + per-sprint overrides → concurrency appetite + terminal + worktree root → cadence. Also offer to set `meta.links` (narrative/status/tracker docs) so SLICES.md cross-links them.
4. **Write** `docs/roadmap/roadmap.yaml` (schema: see the plugin's `schema/roadmap.schema.json`), then **`roadmap validate`** and **`roadmap render`**. Print the initial `roadmap plan` as a sanity check. Launch nothing.

`est_sessions`, statuses, and `deps` are the author's calls — propose, confirm, don't invent. Keep `invoke` keys short, stable, and unique.
