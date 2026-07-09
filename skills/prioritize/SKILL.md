---
name: prioritize
description: Convergent triage of ready roadmap slices + open backlog items — walk them tier by tier (P0–P3), force a reason for every placement, weigh items by their source (roadmap vs backlog vs inbound Linear team), then write the result in one atomic bulk edit. Use after /imagine, after a batch of captures, or whenever "what's actually next" feels contested.
argument-hint: "[optional scope, e.g. 'backlog only' or 'the auth PI']"
allowed-tools: Read, Bash(roadmap backlog:*), Bash(roadmap plan:*), Bash(roadmap next:*), Bash(roadmap:*), Bash(node:*)
---

You converge the user's priorities into the graph. The output is `priority: { tier, weight, reason }` fields — the **reason is the point**: it's what agents and future-you read to know why this ranks here.

1. **Gather.** `ready_wave` (MCP) or `roadmap plan` for ready slices; `backlog_list` (or `roadmap backlog`) for open items. Build one combined list showing per entry: name · current tier/weight (or Untriaged) · est · **source** — for a slice its PI, for a backlog item its `source` line (`from slice X` / `from Linear PUB/Submit-an-issue` / manual). Source is how origin-weighting becomes explicit: an item that arrived from a public-intake Linear team is not automatically as urgent as one a maintainer filed — but the user decides that, not you.

2. **Walk the tiers, P0 → P3.** For each tier, show the current occupants and candidates. Rules of the walk:
   - **Force the reason.** No placement without a one-line why, in the user's words. That line becomes `priority.reason`.
   - **Same-tier collisions get the forced question, verbatim:** *"These two can't both be P{n} — which ships first, and why?"* The loser drops a tier or takes a lower weight; the answer becomes both reasons.
   - **Weights inside a tier** only when ordering matters (three or more in a tier, or the user volunteers a ranking). Otherwise omit weight — YAGNI applies to precision.
   - **Untriaged is a valid outcome** for genuinely undecided items; don't manufacture priorities to empty the bucket.
   - Challenge stale reasons: if an existing `reason` no longer holds ("launch blocker" for a launched feature), surface it.

3. **Play back the before/after tier table** (entry · old → new tier/weight · reason). Get a yes.

4. **Write atomically.** All roadmap slice changes in **one `bulk_set`** call ({ updates: [{invoke, fields: {priority}}...] }); backlog items via `backlog_set` per item (or `roadmap backlog set <id> priority='{...}'`). Never hand-edit the YAML for this — the tools carry the validation gate.

5. **Report** the new order: `roadmap next` to show what now leads, plus the tier table. If Linear is wired, note the tier changes will project as Linear priorities (P0→Urgent … P3→Low) on the next sync.

6. **Offer to load the plate** (only when `meta.plate` exists / Linear is wired). Once the order is set, propose the handful you'll *actually work now* as the batch via the **`plate_set`** MCP tool (`{ keys: [<invoke>…] }`) — or `roadmap plate set <invoke> …`. This projects to Linear's **My Issues** on the next sync (assignee = you). Keep it under `plate_max` — the plate is a hopper for the current batch, not the whole P0/P1 list; active work auto-shows and completed slices auto-drain regardless. Set only what the user confirms is "on my plate now" — intentional, not automatic.

Never set a priority the user didn't confirm, and never delete a reason without replacing it — an unexplained tier is worse than an untriaged item.

If `roadmap validate` surfaces a composition warning (PIs under `meta.discipline.pi_min_slices`), mention it during the walk — a one-slice PI competing for a tier is usually a slice that belongs inside a sibling PI, and triage is the natural moment to fold it.
