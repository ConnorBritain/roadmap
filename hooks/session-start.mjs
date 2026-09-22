#!/usr/bin/env node
// SessionStart hook: if the repo at cwd has docs/roadmap/roadmap.yaml, inject the current
// ready wave as context. Degrades SILENTLY (emits nothing) when there's no roadmap or deps
// are missing — it must never break or slow a session in a non-roadmap repo.
//
// Profile-aware through the loader (the only meta.profile reader): the reconcile nudge and the
// closing hint are what the loaded profile registers (`nudge`, `sessionHint`) — merged PRs +
// /fanout under engineering, conducted runs + /conduct under general. Core facts (ready wave,
// held work, backlog, Linear) are the same under both. This hook imports no executor package.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

function emit(ctx) {
  if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }));
  process.exit(0);
}

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
const start = resolve(input.cwd || process.env.CODEX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());

// Walk up to the repo's roadmap.
let root = null;
for (let dir = start; ;) {
  if (existsSync(join(dir, "docs", "roadmap", "roadmap.yaml"))) { root = dir; break; }
  const up = dirname(dir);
  if (up === dir) break;
  dir = up;
}
if (!root) emit("");   // no roadmap here — stay silent

try {
  const graph = await import("@connorbritain/roadmap-core/graph.mjs");
  const g = graph.loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  const model = graph.flatten(g);
  const cap = (g.meta && g.meta.default_concurrency) || 3;
  const { waves, held } = graph.computeWaves(model, cap, { coherence: graph.coherenceEnabled(g.meta) });
  const ready = (waves[0] || []).map((n) => n.invoke);
  const onHuman = held.onHuman.map((n) => n.invoke);

  // The work profile (guarded: an unloadable profile → engineering wording, no nudge).
  let profile = null;
  try {
    const { loadProfile } = await import("@connorbritain/roadmap-cli/profile.mjs");
    profile = await loadProfile(g.meta, { root });
  } catch { /* fall through */ }
  const general = profile && profile.name === "general";

  // Reconcile detection comes from the profile (engineering: merged PRs whose slices are still
  // open, gh-guarded; general: conducted runs that passed but are still open). Deterministic
  // here; the agent does the judgment + the status flip.
  let nudge = "";
  try { nudge = profile ? String((await profile.nudge(g)) || "") : ""; } catch { /* skip the nudge */ }

  // Backlog open-count (guarded: absent/unparseable backlog → silent).
  let backlogNote = "";
  try {
    if (existsSync(join(root, "docs", "roadmap", "backlog.yaml"))) {
      const store = await import("@connorbritain/roadmap-core/store.mjs");
      const bl = await import("@connorbritain/roadmap-core/backlog-core.mjs");
      const n = bl.openCount(store.loadBacklog(root));
      if (n > 0) backlogNote = ` Backlog: ${n} open (see /backlog or docs/BACKLOG.md).`;
    }
  } catch { /* skip */ }

  // Linear one-liner (guarded, ZERO network: config presence + env key only).
  let linearNote = "";
  try {
    const lc = await import("@connorbritain/roadmap-core/linear-core.mjs");
    const st = lc.linearState({ meta: g.meta, env: process.env });
    if (st.configured) linearNote = ` ${lc.linearStatusLine(st)}`;
  } catch { /* skip */ }

  if (!ready.length && !onHuman.length && !nudge && !backlogNote && !linearNote) emit("");

  let ctx = `roadmap (${(g.pis || []).length} PIs${general ? ", general profile" : ""}): ready now (cap ${cap}) — ${ready.join(", ") || "none"}.`;
  if (onHuman.length) ctx += ` Held on a human: ${onHuman.join(", ")}.`;
  if (nudge) ctx += ` ⟳ ${nudge}`;
  ctx += backlogNote;
  ctx += linearNote;
  ctx += ` ${profile ? profile.sessionHint : "Use /slice <name> to orient, or 'roadmap plan' for the full wave map."}`;
  emit(ctx);
} catch {
  emit("");   // missing deps / parse error → silent; never break the session
}
