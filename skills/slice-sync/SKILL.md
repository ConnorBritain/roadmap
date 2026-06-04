---
name: slice-sync
description: Reconcile the roadmap graph with reality (merged PRs + tracker/status) and re-render docs/SLICES.md. Run after a batch of merges. Edits docs/roadmap/roadmap.yaml statuses + regenerates the markdown; never touches code.
argument-hint: "[--since YYYY-MM-DD] [--dry-run]"
allowed-tools: Read, Edit, Bash(roadmap render:*), Bash(roadmap:*), Bash(node:*), Bash(git log:*), Bash(gh pr list:*), Bash(gh pr view:*)
---

You reconcile `docs/roadmap/roadmap.yaml` against what actually shipped, then re-render. **Touch only the YAML's status/prs fields and the generated SLICES.md** — never code, frozen dirs, or unrelated docs.

1. **Window.** Use `--since <date>` if given; else infer from the newest PR already cited in the YAML (default last ~14 days).
2. **Ground truth.** `gh pr list --state merged --search "merged:>=<date>" --json number,title,mergedAt` + `git log --since=<date> --first-parent --oneline`. Read STATUS/tracker if the repo has them (see `meta.links`).
3. **Compute deltas** per sprint: a slice whose work merged → flip its `status` to `complete` and add the PR to `prs` (cite it); a `next`/`scheduled` slice with merges against it → promote; a newly-scoped PI → propose adding it (flag for a detail entry). **Keep `invoke` keys stable** — they're the `/slice` keys.
4. **Apply** with `Edit` to the YAML, then **re-render**: `roadmap render` (regenerates SLICES.md from the YAML). With `--dry-run`, print the proposed YAML edits + PR→change mapping and stop.
5. **Report** a concise PR→change mapping. Cite a merged PR for every status flip; surface anything ambiguous rather than guessing.

This is a docs/data refresh — no test gate. If the working tree has unrelated dirty changes, note it.
