# Linear sync findings — 2026-07-13

Point-in-time findings from projecting the Pidgeon Health Conform product program: five PIs, 38 slices, and 117 estimated sessions. The source roadmap intentionally uses `meta.linear.horizon: near` so the day-to-day board carries actionable work rather than every optional future slice.

## 1. `linear` does not honor the advertised input override

The root help presents `-i | --in <yaml>` as a general roadmap-path override. `roadmap linear sync --dry -i <path>` still loads the repository's canonical `docs/roadmap/roadmap.yaml`, while placing `-i` before the command routes to `plan` because leading flags default to that command.

Why it matters: an operator cannot safely preview an alternate projection policy or candidate roadmap without temporarily changing the canonical file.

Recommended correction:

- parse the input path once in the root CLI and pass it explicitly to every command;
- teach `linear.mjs` to derive the repo root, YAML path, cursor path, and write-back target from that resolved input;
- add CLI tests for `roadmap linear status|sync --in <alternate.yaml>` and for a leading global option.

## 2. Projection horizon is global, but rollout intent is often per-PI

`horizon: near` correctly suppresses new scheduled/optional issues. Already-mapped issues continue to update. The Conform program needed one deliberate full-program projection so its complete structure was visible in Linear, but switching to `horizon: all` also exposed six unrelated scheduled slices.

Why it matters: teams need to publish one approved program without turning every speculative lane into board inventory or falsely promoting all of its work into the current cycle.

Recommended correction:

- support a scoped command such as `roadmap linear sync --pi conform-product-foundation,... --include-scheduled`;
- alternatively allow a PI-level projection override while retaining the repository default;
- keep cycle assignment status-driven: publishing a scheduled issue must not imply `next` or current-cycle commitment;
- print a preflight summary grouped by PI and status before any full-horizon push.

## 3. One completed issue remains non-idempotent

After repeated successful syncs, `roadmap linear sync --dry` continues to report `updateIssue PID-475`. Running the non-dry sync applies the update, but the next dry run proposes it again. All other push operations reconcile.

Why it matters: a persistent false-positive weakens the "unchanged roadmap sends zero ops" contract and makes operators less likely to notice a real one-item delta.

Recommended correction:

- add an explain/debug mode that prints the exact field-level diff for each planned operation;
- normalize nullable/completed fields, labels, estimates, project milestones, assignee, and cycle values before comparison;
- capture PID-475's local and remote normalized payloads as a regression fixture;
- assert `sync -> dry sync` returns zero push operations for completed issues.

## 4. The local cursor needs automatic hygiene

The first live sync created `.roadmap-linear-state.json` in the repository root. The application repo did not ignore it, even though the deployment guidance treats the cursor as local state.

Recommended correction:

- have `roadmap linear setup` add the cursor path to `.gitignore` idempotently, or store it under the user's state directory;
- have `roadmap linear status` warn when the cursor is unignored;
- keep credentials and cursor state separate from committed roadmap configuration.

## Acceptance target

A high-velocity agentic cadence should support this loop without temporary canonical edits:

1. preview a named PI's full projection;
2. see the exact create/update field diffs;
3. push only that scope;
4. preserve current-cycle commitments;
5. write stable IDs back to YAML;
6. rerun dry and receive zero operations;
7. keep the cursor local and ignored automatically.
