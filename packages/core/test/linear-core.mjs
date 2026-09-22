// packages/core tests — linear-core. Moved verbatim from scripts/test/run.mjs (core-extract slice).
// Runs when imported; the shared harness counts every test in one summary.
import { test, eq, ok, throws, sp } from "./harness.mjs";
import { L_CFG, L_STATES } from "./fixtures.mjs";
import { electionPlan, outOfCycle } from "@connorbritain/roadmap-core/cycle-core.mjs";
import { flatten } from "@connorbritain/roadmap-core/graph.mjs";
import { buildPushPlan, checkPiOverrideAck, cyclePlan, effectiveVerbosity, issueDescription, normalizeLinearConfig, normalizeTitle, projectSubtitleRaw, provisionPlan, resolveProjectStatus, resolvePushState, staleKeys, validateLinearConfig, withinHistory } from "@connorbritain/roadmap-core/linear-core.mjs";
import { addPi, addPlate, addSprint, removePlate, setPlate } from "@connorbritain/roadmap-core/mcp-core.mjs";
import { plateDrainKeys, platedKeys, setPlateDoc, validatePlate } from "@connorbritain/roadmap-core/plate-core.mjs";
import { parseDocument } from "yaml";

// ── linear-core: push plan ────────────────────────────────────────────────────
export const pushGraph = (over = {}) => ({
  meta: { schema_version: 1, program: "T", linear: { team: "ENG", ...over } },
  pis: [
    { id: "auth", title: "Authentication", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "Login", status: "active", invoke: "auth-login", linear: "ENG-1" },
      { id: "s2", title: "Tokens", status: "scheduled", invoke: "auth-tokens" },
      { id: "s3", title: "Old", status: "complete", invoke: "auth-old" },
    ]},
  ],
});
export const SNAP = (loginOverrides = {}) => ({
  projects: { "proj-1": { id: "proj-1", name: "Authentication" } },
  issues: { "ENG-1": { id: "uuid-1", title: "Login",
    description: issueDescription({ invoke: "auth-login", title: "Login", what: "Login", gate: "default", estSessions: null, priority: null }, L_CFG, { target: { type: "slice", key: "auth-login" } }),
    priority: 0, stateId: "st-s", projectId: "proj-1", ...loginOverrides } },
});

// WHY: a non-idempotent push spams duplicate issues/updates on every /sync — a matching
// snapshot must produce ZERO ops, and one changed field exactly one update.
test("buildPushPlan is idempotent: matching snapshot → only the missing-issue create; changed title → one update", () => {
  const cfg = normalizeLinearConfig(pushGraph().meta);
  const plan = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing: SNAP() });
  eq(plan.ops.map((o) => o.op), ["createIssue"], "only the unmapped not-done sprint creates (complete unmapped skipped, mapped unchanged)");
  eq(plan.ops[0].writeBack, { kind: "sprint", invoke: "auth-tokens" }, "create writes the id back to the sprint");
  const drifted = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing: SNAP({ title: "Login (old name)" }) });
  const upd = drifted.ops.find((o) => o.op === "updateIssue");
  eq(upd.payload, { title: "Login" }, "only the drifted field is sent");
  eq(upd.id, "uuid-1", "update targets the Linear uuid");
});

// WHY: the 2026-07-11 double-sync created every issue TWICE — run 1's PID write-back was lost, so run 2
// saw !node.linear and re-created all of them (PID-489/491-497 orphaned by hand). Adopting an unambiguous
// same-title twin instead of blindly creating is THE guard; if it regresses, a lost write-back silently
// duplicates the whole board again.
test("buildPushPlan adopts an unambiguous same-title twin instead of creating a duplicate", () => {
  const cfg = normalizeLinearConfig(pushGraph().meta);
  const existing = { ...SNAP(), byTitle: { [normalizeTitle("Tokens")]: [{ id: "uuid-tok", identifier: "PID-77" }] } };
  const plan = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing });
  ok(!plan.ops.some((o) => o.op === "createIssue"), "no duplicate create for the twinned slice");
  const adopt = plan.ops.find((o) => o.op === "adoptIssue");
  ok(adopt, "the unmapped slice adopts its existing twin");
  eq(adopt.id, "uuid-tok", "adopt targets the twin's Linear uuid");
  eq(adopt.identifier, "PID-77", "adopt carries the twin's identifier (write-back + per-op error context)");
  eq(adopt.writeBack, { kind: "sprint", invoke: "auth-tokens" }, "adopt writes the identifier back onto the slice");
  eq(adopt.payload.title, "Tokens", "adopt reconciles the twin to our projection (title/desc/state/…)");
});

// WHY: two issues share a title → we cannot know WHICH is the real twin; adopting one would hijack an
// unrelated issue. Ambiguity MUST fall back to create — the guard never guesses.
test("buildPushPlan does not adopt an ambiguous (>1) same-title cluster — falls back to create", () => {
  const cfg = normalizeLinearConfig(pushGraph().meta);
  const existing = { ...SNAP(), byTitle: { [normalizeTitle("Tokens")]: [
    { id: "uuid-a", identifier: "PID-77" }, { id: "uuid-b", identifier: "PID-78" } ] } };
  const plan = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing });
  ok(!plan.ops.some((o) => o.op === "adoptIssue"), "ambiguous cluster is never adopted");
  eq(plan.ops.map((o) => o.op), ["createIssue"], "falls back to the ordinary create");
});

// WHY: a genuinely-new slice (title matches no twin) must still create — the guard must not suppress
// legitimate creates or the board would never grow.
test("buildPushPlan still creates when no twin shares the title (regression guard)", () => {
  const cfg = normalizeLinearConfig(pushGraph().meta);
  const existing = { ...SNAP(), byTitle: { [normalizeTitle("Something else")]: [{ id: "uuid-z", identifier: "PID-99" }] } };
  const plan = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing });
  ok(!plan.ops.some((o) => o.op === "adoptIssue"), "no twin → no adopt");
  eq(plan.ops.map((o) => o.op), ["createIssue"], "ordinary create for the unmapped slice");
});

// ── linear-core: per-PI verbosity ─────────────────────────────────────────────
// WHY: a silently-ignored per-PI verbosity override makes the board lie about detail level —
// the user quiets a noisy PI to title (or richens an active one to full) and nothing changes.
test("per-PI verbosity overrides the global for that PI's issues only", () => {
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG", verbosity: "title" } },
    pis: [
      { id: "loud", title: "Loud", status: "active", linear: { project: "proj-1", verbosity: "brief" }, sprints: [
        { id: "s1", title: "A", status: "next", invoke: "loud-a", what: "does a thing", gate: "gate a" } ]},
      { id: "quiet", title: "Quiet", status: "active", linear: { project: "proj-2" }, sprints: [
        { id: "s1", title: "B", status: "next", invoke: "quiet-b", what: "does b", gate: "gate b" } ]},
    ]};
  const cfg = normalizeLinearConfig(g.meta);
  eq(effectiveVerbosity(cfg, g.pis[0]), "brief", "per-PI verbosity wins");
  eq(effectiveVerbosity(cfg, g.pis[1]), "title", "no override → global");
  const existing = { projects: { "proj-1": { id: "proj-1", name: "Loud" }, "proj-2": { id: "proj-2", name: "Quiet" } }, issues: {} };
  const plan = buildPushPlan({ graph: g, backlog: null, cfg, teamStates: L_STATES, existing });
  const desc = Object.fromEntries(plan.ops.filter((o) => o.op === "createIssue").map((o) => [o.writeBack.invoke, o.payload.description]));
  ok(desc["loud-a"].includes("Gate: gate a"), "overridden PI carries brief detail (what + gate)");
  ok(!desc["quiet-b"].includes("Gate"), "global-title PI stays footer-only");
});

// WHY: an unacked per-PI override is how two sessions diverge on what Linear shows — verbosity
// must gate through the SAME ack as granularity, and validate must flag the stored mismatch.
test("verbosity override is ack-gated and validate flags invalid/differing values", () => {
  const globalCfg = normalizeLinearConfig({ linear: { team: "ENG" } });   // verbosity default brief
  throws(() => checkPiOverrideAck(globalCfg, { verbosity: "title" }, false, "x"), 'overrides Linear verbosity ("title")');
  checkPiOverrideAck(globalCfg, { verbosity: "title" }, true, "x");   // acked → passes
  checkPiOverrideAck(globalCfg, { verbosity: "brief" }, false, "x");  // matches global → no ack needed
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG" } }, pis: [
    { id: "bad", title: "B", status: "active", linear: { verbosity: "loud" }, sprints: [{ id: "s1", title: "A", status: "next", invoke: "bad-a" }] },
    { id: "diff", title: "D", status: "active", linear: { verbosity: "full" }, sprints: [{ id: "s1", title: "A", status: "next", invoke: "diff-a" }] },
  ]};
  const v = validateLinearConfig(g);
  ok(v.errors.some((e) => e.includes('linear.verbosity "loud"')), "invalid per-PI verbosity is an error");
  ok(v.warnings.some((w) => w.includes("PI diff") && w.includes("verbosity")), "differing per-PI verbosity warns (override in effect)");
});

// WHY: a "." inside an abbreviation ended the derived subtitle mid-parenthetical — the one line
// humans read on the project card shipped as "…DB (incl." on a live board and read as truncation.
test("firstSentence-derived subtitle survives abbreviations (incl., e.g.) and still splits real sentences", () => {
  const pi = { id: "net", title: "Live Network", exit_criteria: "Flock deterministically seeds every node DB (incl. Bridge sidecars) on turnkey hosts. Second sentence here." };
  eq(projectSubtitleRaw(pi), "Flock deterministically seeds every node DB (incl. Bridge sidecars) on turnkey hosts.", "abbreviation does not end the sentence; the real period does");
  const eg = { id: "x", title: "X", exit_criteria: "Covers hosts (e.g. approved VMs) end to end. More detail." };
  eq(projectSubtitleRaw(eg), "Covers hosts (e.g. approved VMs) end to end.", "e.g. survives too");
  const noEnd = { id: "y", title: "Y", exit_criteria: "Ends on an abbreviation incl." };
  eq(projectSubtitleRaw(noEnd), "Ends on an abbreviation incl.", "no real sentence end → whole line, never empty");
});

// ── linear-core: horizon gate ─────────────────────────────────────────────────
// WHY: the untiered future mass is what floods the board (live: 50 of 92 issues were far-future
// backlog-state) — "near" must stop NEW scheduled/optionality issues while committed/held work
// still projects, mapped far-future issues keep updating, and the absent knob stays byte-identical.
test("horizon near: gates new far-future issues, keeps mapped ones updating, default unchanged", () => {
  const g = (horizon) => ({ meta: { schema_version: 1, program: "T", linear: { team: "ENG", ...(horizon ? { horizon } : {}) } },
    pis: [{ id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "Sched", status: "scheduled", invoke: "sched" },
      { id: "s2", title: "Opt", status: "optionality", invoke: "opt" },
      { id: "s3", title: "Next", status: "next", invoke: "nxt" },
      { id: "s4", title: "Gated", status: "gated", invoke: "gtd" },
      { id: "s5", title: "Mapped sched", status: "scheduled", invoke: "mapped", linear: "ENG-7" },
    ]}]});
  const existing = { projects: { "proj-1": { id: "proj-1", name: "P" } }, issues: {
    "ENG-7": { id: "u7", title: "OLD NAME", description: "", priority: 0, stateId: "st-b", projectId: "proj-1", labelIds: [] } } };
  const near = buildPushPlan({ graph: g("near"), backlog: null, cfg: normalizeLinearConfig(g("near").meta), teamStates: L_STATES, existing });
  const creates = near.ops.filter((o) => o.op === "createIssue").map((o) => o.writeBack.invoke).sort();
  eq(creates, ["gtd", "nxt"], "near creates only committed/held work — scheduled/optionality stay YAML-only");
  const upd = near.ops.find((o) => o.op === "updateIssue" && o.identifier === "ENG-7");
  eq(upd.payload.title, "Mapped sched", "an already-mapped far-future issue still updates (create-side gate only)");
  const all = buildPushPlan({ graph: g(null), backlog: null, cfg: normalizeLinearConfig(g(null).meta), teamStates: L_STATES, existing });
  eq(all.ops.filter((o) => o.op === "createIssue").length, 4, "absent knob (default all) → every not-done slice creates, byte-identical to before");
  const v = validateLinearConfig({ meta: { schema_version: 1, program: "T", linear: { team: "ENG", horizon: "soon" } }, pis: [] });
  ok(v.errors.some((e) => e.includes('horizon "soon"')), "invalid horizon blocks at validate");
});

// ── linear-core: done history ─────────────────────────────────────────────────
// WHY: history is what makes a project's progress % real (completed/total inside the project) —
// "off" must stay byte-identical (no Done-issue noise for existing users), "full" must project
// shipped work as completed issues carrying the true completion date, "window" must honor
// meta.completed_window_days, and a shipped PI's project must be created AND populated.
test("history knob: off skips done work, full projects it Done with completedAt, window honors the meta knob", () => {
  const g = (history) => ({ meta: { schema_version: 1, program: "T", completed_window_days: 7, linear: { team: "ENG", ...(history ? { history } : {}) } },
    pis: [{ id: "shipped", title: "Shipped", status: "complete", sprints: [
      { id: "s1", title: "Old", status: "complete", invoke: "old", completed_on: "2026-07-01" },
      { id: "s2", title: "Ancient", status: "complete", invoke: "ancient", completed_on: "2026-06-01" },
      { id: "s3", title: "Undated", status: "complete", invoke: "undated" },
    ]}]});
  const NOW = "2026-07-05T12:00:00Z";
  const empty = { projects: {}, issues: {} };
  const mk = (history) => buildPushPlan({ graph: g(history), backlog: null, cfg: normalizeLinearConfig(g(history).meta), teamStates: L_STATES, existing: empty, now: NOW });
  // off (default): the fully-shipped PI earns neither project nor issues — byte-identical to before
  eq(mk(null).ops.length, 0, "history off → a fully-shipped PI stays off the board entirely");
  // full: project created AND populated with Done issues carrying completedAt
  const full = mk("full");
  eq(full.ops.filter((o) => o.op === "createProject").length, 1, "full → the shipped PI's project is created");
  const creates = full.ops.filter((o) => o.op === "createIssue");
  eq(creates.map((o) => o.writeBack.invoke).sort(), ["ancient", "old", "undated"], "full → every done slice projects");
  const old = creates.find((o) => o.writeBack.invoke === "old");
  eq(old.payload.stateId, "st-c", "done slice lands in the completed state");
  eq(old.payload.completedAt, "2026-07-01", "true completion date rides the create");
  ok(!("completedAt" in creates.find((o) => o.writeBack.invoke === "undated").payload), "no completed_on → no completedAt field");
  // window: 7-day meta knob — old (4 days ago) inside, ancient (34 days) and undated outside
  const win = mk("window");
  eq(win.ops.filter((o) => o.op === "createIssue").map((o) => o.writeBack.invoke), ["old"], "window honors meta.completed_window_days, undated never resurrects");
  // pin the inclusive boundary: exactly N days ago is inside; 1ms older is outside
  const wcfg = normalizeLinearConfig({ linear: { team: "ENG", history: "window" } });
  ok(withinHistory(wcfg, { completedOn: "2026-06-28T12:00:00Z" }, { completed_window_days: 7 }, NOW), "exact 7-day boundary is inside (<=)");
  ok(!withinHistory(wcfg, { completedOn: "2026-06-28T11:59:59.999Z" }, { completed_window_days: 7 }, NOW), "1ms past the boundary is outside");
  const v = validateLinearConfig({ meta: { schema_version: 1, program: "T", linear: { team: "ENG", history: "always" } }, pis: [] });
  ok(v.errors.some((e) => e.includes('history "always"')), "invalid history value blocks at validate");
});

// ── cycle-core: the election ──────────────────────────────────────────────────
// WHY: the capacity cap IS the discipline — packing past it, silently packing unpriced work, or
// proposing blocked/held work puts unstartable or unbounded commitments in the week; and the
// lock must be one validated write, not a hand-edit that skips the store's gates.
test("electionPlan: committed-first capacity, strict priority prefix, unestimated never packed, held/blocked never candidates", () => {
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG", cycles: "on" } },
    pis: [{ id: "p", title: "P", status: "active", sprints: [
      { id: "s1", title: "Committed", status: "active", invoke: "committed", est_sessions: 3 },
      { id: "s2", title: "Next up", status: "next", invoke: "nextup", est_sessions: 2 },
      { id: "s3", title: "Small P1", status: "scheduled", invoke: "small", est_sessions: 2, priority: { tier: "P1" } },
      { id: "s4", title: "Big P0", status: "scheduled", invoke: "big", est_sessions: 9, priority: { tier: "P0" } },
      { id: "s5", title: "Unpriced", status: "scheduled", invoke: "unpriced" },
      { id: "s6", title: "Gated", status: "gated", invoke: "gated", est_sessions: 1 },
      { id: "s7", title: "Blocked dep", status: "scheduled", invoke: "depped", est_sessions: 1, deps: ["s6"] },
      { id: "s8", title: "Maybe", status: "optionality", invoke: "maybe", est_sessions: 1 },
    ]}]};
  const p = electionPlan(g, { capacity: 10, staleInvokes: ["committed"] });
  eq(p.elected.map((x) => x.invoke).sort(), ["committed", "nextup"], "elected = the committed set (active+next)");
  ok(p.elected.find((x) => x.invoke === "committed").stale, "the stale flag rides the elected list — reviewed first");
  eq(p.unpricedElected, [], "all committed work is priced here — no capacity blind spot");
  const gUnpriced = { ...g, pis: [{ ...g.pis[0], sprints: [{ id: "s0", title: "Mystery", status: "active", invoke: "mystery" }, ...g.pis[0].sprints] }] };
  eq(electionPlan(gUnpriced, { capacity: 10 }).unpricedElected.map((x) => x.invoke), ["mystery"], "committed-but-unpriced work is flagged, never a silent zero in the capacity math");
  eq(p.candidates.map((x) => x.invoke), ["big", "small", "unpriced"], "candidates = READY scheduled only, priority-sorted, unpriced last (gated/dep-blocked/optionality excluded)");
  // committed 5s + big 9s would blow 10 → strict prefix stops at big; small does NOT sneak past the P0
  eq(p.packed, [], "a too-big P0 at the head blocks the prefix — the signal is split-it, not skip-it");
  eq(p.overflow.map((x) => x.invoke), ["big", "small"], "everything estimable past the prefix is overflow");
  eq(p.unestimated.map((x) => x.invoke), ["unpriced"], "unpriced work is surfaced, never silently packed");
  eq(p.estUsed, 5, "usage = committed est_sessions when nothing packs");
  const roomy = electionPlan(g, { capacity: 20 });
  eq(roomy.packed.map((x) => x.invoke), ["big", "small"], "with room, the prefix packs in priority order");
  eq(roomy.estUsed, 16, "usage counts committed + packed");
});

// WHY: outOfCycle is the dispatch/fan lock's whole decision — a false positive blocks legitimate
// work, a false negative lets the cycle leak; cycles off must never lock anything (opt-in).
test("outOfCycle: locks only non-committed statuses, only when cycles are on", () => {
  const on = normalizeLinearConfig({ linear: { team: "ENG", cycles: "on" } });
  const off = normalizeLinearConfig({ linear: { team: "ENG" } });
  ok(outOfCycle(on, "scheduled") && outOfCycle(on, "gated") && outOfCycle(on, "complete"), "non-committed statuses lock when on");
  ok(!outOfCycle(on, "active") && !outOfCycle(on, "next"), "the committed set never locks");
  ok(!outOfCycle(off, "scheduled") && !outOfCycle(null, "scheduled"), "cycles off (or no Linear) → never locks");
});

// ── linear-core: staleness ────────────────────────────────────────────────────
// WHY: a stale flag that flaps (our own push resetting the clock), flags unknown-activity work,
// or sticks after a fresh note trains the human to ignore it — the one failure an advisory
// indicator can't afford. Basis is journal activity; add/remove rides the ordinary label set-diff.
test("staleKeys: journal-silence basis, committed-only scope, unknown never flags; label rides the set-diff", () => {
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG", stale_days: 3 } },
    pis: [{ id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "A", status: "active", invoke: "a", linear: "ENG-1" },      // silent 5 days → stale
      { id: "s2", title: "B", status: "next", invoke: "b", linear: "ENG-2" },        // fresh note → not stale
      { id: "s3", title: "C", status: "scheduled", invoke: "c", linear: "ENG-3" },   // not committed → never stale
      { id: "s4", title: "D", status: "active", invoke: "d", linear: "ENG-4" },      // unknown activity → never stale
    ]}]};
  const cfg = normalizeLinearConfig(g.meta);
  const NOW = "2026-07-09T12:00:00Z";
  const activity = { "ENG-1": "2026-07-04T11:00:00Z", "ENG-2": "2026-07-09T09:00:00Z", "ENG-3": "2026-06-01T00:00:00Z" };
  eq([...staleKeys({ graph: g, cfg, activity, now: NOW })], ["a"], "silent committed work flags; fresh, uncommitted, unknown don't");
  eq(staleKeys({ graph: g, cfg: normalizeLinearConfig({ linear: { team: "ENG" } }), activity, now: NOW }).size, 0, "no stale_days → feature off");
  const labels = { roadmap: "l-r", stale: "l-s" };
  const oneSlice = { ...g, pis: [{ ...g.pis[0], sprints: [g.pis[0].sprints[0]] }] };
  const existing = { projects: { "proj-1": { id: "proj-1", name: "P" } }, issues: {
    "ENG-1": { id: "u1", title: "A", description: "x", priority: 0, stateId: "st-s", projectId: "proj-1", labelIds: ["l-r"] } } };
  const flagged = buildPushPlan({ graph: oneSlice, backlog: null, cfg, teamStates: L_STATES, existing, labels, stale: new Set(["a"]) });
  eq(flagged.ops.find((o) => o.op === "updateIssue").payload.labelIds, ["l-r", "l-s"], "flagging adds the stale label via the set-diff");
  const relabeled = { ...existing, issues: { "ENG-1": { ...existing.issues["ENG-1"], labelIds: ["l-r", "l-s"] } } };
  const cleared = buildPushPlan({ graph: oneSlice, backlog: null, cfg, teamStates: L_STATES, existing: relabeled, labels, stale: new Set() });
  eq(cleared.ops.find((o) => o.op === "updateIssue").payload.labelIds, ["l-r"], "unflagging drops it the same way");
  const pp = provisionPlan({ graph: g, teamLabels: {}, cfg });
  ok(pp.createLabels.includes("stale") && pp.views.some((v) => v.name === "Stale"), "stale label + view provisioned when stale_days set");
  const v = validateLinearConfig({ meta: { schema_version: 1, program: "T", linear: { team: "ENG", stale_days: 0 } }, pis: [] });
  ok(v.errors.some((e) => e.includes("stale_days")), "stale_days 0 rejected — a bad knob must not silently disable the guardrail");
});

// ── linear-core: cycles ───────────────────────────────────────────────────────
// WHY: the active cycle IS the elected weekly batch — if assignment oscillates, clears a human's
// future-cycle parking, or lets demotions linger, the cycle chart lies and "this week" silently
// re-inflates; and with no active cycle the sync must never guess one.
test("cyclePlan assigns active/next on drift, clears only current-cycle demotions, spares future parking", () => {
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG", cycles: "on" } },
    pis: [{ id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "A", status: "active", invoke: "a", linear: "ENG-1" },      // uncycled → assign
      { id: "s2", title: "B", status: "next", invoke: "b", linear: "ENG-2" },        // already in → no-op
      { id: "s3", title: "C", status: "scheduled", invoke: "c", linear: "ENG-3" },   // demoted, in current → clear
      { id: "s4", title: "D", status: "scheduled", invoke: "d", linear: "ENG-4" },   // parked in FUTURE cycle → untouched
      { id: "s5", title: "E", status: "complete", invoke: "e", linear: "ENG-5" },    // done → never a candidate
      { id: "s6", title: "F", status: "next", invoke: "f" },                          // unmapped → not a candidate
    ]}]};
  const issues = { "ENG-1": { id: "u1", cycleId: null }, "ENG-2": { id: "u2", cycleId: "cyc-1" },
    "ENG-3": { id: "u3", cycleId: "cyc-1" }, "ENG-4": { id: "u4", cycleId: "cyc-2" }, "ENG-5": { id: "u5", cycleId: "cyc-1" } };
  const plan = cyclePlan({ graph: g, activeCycleId: "cyc-1", issues });
  eq(plan.assign.map((x) => x.invoke), ["a"], "only the drifted active/next issue assigns");
  eq(plan.clear.map((x) => x.invoke), ["c"], "only the current-cycle demotion clears — future parking and done work untouched");
  eq(cyclePlan({ graph: g, activeCycleId: null, issues }), { assign: [], clear: [] }, "no active cycle → nothing");
  ok(provisionPlan({ graph: g, teamLabels: {}, cfg: normalizeLinearConfig(g.meta) }).views.some((v) => v.name === "This cycle"), "cycles on → This cycle view offered");
  ok(!provisionPlan({ graph: g, teamLabels: {}, cfg: normalizeLinearConfig({ linear: { team: "ENG" } }) }).views.some((v) => v.name === "This cycle"), "cycles off → view not offered");
  const v = validateLinearConfig({ meta: { schema_version: 1, program: "T", linear: { team: "ENG", cycles: "weekly" } }, pis: [] });
  ok(v.errors.some((e) => e.includes('cycles "weekly"')), "invalid cycles value blocks at validate");
  const vc = validateLinearConfig({ meta: { schema_version: 1, program: "T", linear: { team: "ENG", cycle_capacity: 0 } }, pis: [] });
  ok(vc.errors.some((e) => e.includes("cycle_capacity")), "cycle_capacity 0 rejected — a bad knob must not silently disable the cap");
});

// ── linear-core: PI status → project status ──────────────────────────────────
// Mirrors the live workspace inventory (organization.projectStatuses): stock has NO paused type.
const P_STATUSES = [
  { id: "ps-b", name: "Backlog", type: "backlog", position: 0 },
  { id: "ps-p", name: "Planned", type: "planned", position: 1 },
  { id: "ps-s", name: "In Progress", type: "started", position: 2 },
  { id: "ps-c", name: "Completed", type: "completed", position: 3 },
  { id: "ps-x", name: "Canceled", type: "canceled", position: 4 },
];

// WHY: every project reading "Backlog" regardless of PI status makes the initiative rollup — the
// first screen a human reads — lie about what's shipped vs in flight (live board: 64/64 stuck).
test("resolveProjectStatus maps PI status to project-status TYPE, held falls back past a missing paused", () => {
  eq(resolveProjectStatus("complete", P_STATUSES).id, "ps-c", "complete → completed");
  eq(resolveProjectStatus("active", P_STATUSES).id, "ps-s", "active → started");
  eq(resolveProjectStatus("next", P_STATUSES).id, "ps-p", "next → planned");
  eq(resolveProjectStatus("scheduled", P_STATUSES).id, "ps-b", "scheduled → backlog");
  eq(resolveProjectStatus("optionality", P_STATUSES).id, "ps-b", "optionality → backlog");
  eq(resolveProjectStatus("gated", P_STATUSES).id, "ps-p", "held → planned when the workspace has no paused type");
  const withPaused = [...P_STATUSES, { id: "ps-z", name: "Paused", type: "paused", position: 5 }];
  eq(resolveProjectStatus("gated", withPaused).id, "ps-z", "held → paused when the workspace declares it");
  eq(resolveProjectStatus("active", null), null, "null inventory → null (status projection off)");
});

// WHY: a workspace whose inventory misses every type in a chain can't be silently skipped — the
// push would keep "correcting" nothing forever; fail naming what exists, mirroring resolvePushState.
test("resolveProjectStatus throws listing the available statuses when no chain type exists", () => {
  const weird = [{ id: "ps-only", name: "Odd", type: "triage", position: 0 }];
  throws(() => resolveProjectStatus("complete", weird), "no project status of type completed");
  throws(() => resolveProjectStatus("complete", weird), "Odd:triage");
});

// WHY: statusId must diff like every other project field or every sync spams projectUpdate on
// all 64 projects; and with a null inventory the plan must be byte-identical to the pre-feature
// tool so a degraded fetch (or an old test fixture) changes nothing.
test("buildPushPlan projects statusId: drift → one update, match → zero ops, null inventory → absent", () => {
  const cfg = normalizeLinearConfig(pushGraph().meta);
  const snapAt = (statusId) => {
    const s = SNAP();
    s.projects["proj-1"] = { ...s.projects["proj-1"], statusId };
    return s;
  };
  // active PI whose project sits in backlog status → exactly one updateProject carrying only statusId
  const drift = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing: snapAt("ps-b"), projectStatuses: P_STATUSES });
  const upd = drift.ops.find((o) => o.op === "updateProject");
  eq(upd.payload, { statusId: "ps-s" }, "only the drifted statusId is sent (active → started)");
  // matching status → no project op at all
  const match = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing: snapAt("ps-s"), projectStatuses: P_STATUSES });
  eq(match.ops.filter((o) => o.op === "updateProject").length, 0, "matching statusId → zero project updates");
  // null inventory (degraded fetch) → plan identical to the pre-feature shape: no statusId anywhere
  const off = buildPushPlan({ graph: pushGraph(), backlog: null, cfg, teamStates: L_STATES, existing: snapAt("ps-b"), projectStatuses: null });
  eq(off.ops.filter((o) => o.op === "updateProject").length, 0, "null inventory → no status correction attempted");
  // a new project carries its statusId on create
  const g = pushGraph(); delete g.pis[0].linear;
  const create = buildPushPlan({ graph: g, backlog: null, cfg, teamStates: L_STATES, existing: { projects: {}, issues: {} }, projectStatuses: P_STATUSES });
  eq(create.ops.find((o) => o.op === "createProject").payload.statusId, "ps-s", "create includes the mapped statusId");
});

// WHY: est_sessions is the roadmap's own estimate; as prose in the description it was unsortable and
// couldn't roll up on the board. It must ride the native `estimate` field — rounded to an integer,
// clamped to estimate_max so an oversize slice can't push an out-of-scale value, and 0/null left
// unestimated (never a pushed 0, which needs the team's allow-zero setting).
test("buildPushPlan pushes est_sessions as native estimate: rounded, clamped, zero-skipped, idempotent", () => {
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG" } },   // estimate_max defaults to 5
    pis: [{ id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "Small", status: "next", invoke: "small", est_sessions: 1.5 },   // → round → 2
      { id: "s2", title: "Huge", status: "next", invoke: "huge", est_sessions: 16 },        // → clamp → 5
      { id: "s3", title: "Zero", status: "next", invoke: "zero", est_sessions: 0 },          // → unestimated
    ]}]};
  const cfg = normalizeLinearConfig(g.meta);
  const existing = { projects: { "proj-1": { id: "proj-1", name: "P" } }, issues: {} };
  const plan = buildPushPlan({ graph: g, backlog: null, cfg, teamStates: L_STATES, existing, labels: {} });
  const est = Object.fromEntries(plan.ops.filter((o) => o.op === "createIssue").map((o) => [o.writeBack.invoke, o.payload.estimate]));
  eq(est.small, 2, "1.5 sessions rounds to 2 points");
  eq(est.huge, 5, "16 sessions clamps to estimate_max (5) — validate warns to split it");
  ok(!("estimate" in plan.ops.find((o) => o.writeBack.invoke === "zero").payload), "0 sessions → no estimate field (unestimated, not a pushed 0)");
  // idempotent: a mapped issue whose Linear estimate already equals the pushed value → no update
  const g2 = { meta: g.meta, pis: [{ id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
    { id: "s1", title: "Small", status: "next", invoke: "small", est_sessions: 2, linear: "ENG-9" } ]}]};
  const node = { invoke: "small", title: "Small", what: "Small", gate: "default" };   // flatten defaults gate → match it
  const cur = { projects: { "proj-1": { id: "proj-1", name: "P" } }, issues: { "ENG-9": {
    id: "u9", title: "Small", description: issueDescription(node, cfg, { target: { type: "slice", key: "small" } }),
    priority: 0, estimate: 2, stateId: "st-u", projectId: "proj-1", labelIds: [] } } };
  const noop = buildPushPlan({ graph: g2, backlog: null, cfg, teamStates: L_STATES, existing: cur, labels: {} });
  eq(noop.ops.filter((o) => o.op === "updateIssue").length, 0, "matching estimate → zero updates");
  // drifted estimate → exactly one update carrying ONLY estimate
  const cur3 = JSON.parse(JSON.stringify(cur)); cur3.issues["ENG-9"].estimate = 4;
  const drift = buildPushPlan({ graph: g2, backlog: null, cfg, teamStates: L_STATES, existing: cur3, labels: {} });
  eq(drift.ops.find((o) => o.op === "updateIssue").payload, { estimate: 2 }, "only the drifted estimate is sent");
  // a mapped issue that LOST its est_sessions keeps its stale Linear estimate — the points>0 guard
  // must NOT emit an update to clear it to 0 (which would churn AND needs the team's allow-zero setting)
  const g4 = { meta: g.meta, pis: [{ id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
    { id: "s1", title: "Small", status: "next", invoke: "small", linear: "ENG-9" } ]}]};   // no est_sessions
  const cur4 = JSON.parse(JSON.stringify(cur)); cur4.issues["ENG-9"].estimate = 3;
  const removed = buildPushPlan({ graph: g4, backlog: null, cfg, teamStates: L_STATES, existing: cur4, labels: {} });
  eq(removed.ops.filter((o) => o.op === "updateIssue").length, 0, "removed est_sessions → no update (stale estimate tolerated, never cleared)");
});

// WHY: a slice bigger than the estimate scale can't map to one estimate point and is too big to fan
// out as one session — validate must surface it (where you'd split it), not let it clamp silently.
test("validate warns on a slice whose est_sessions exceeds estimate_max", () => {
  const over = { meta: { schema_version: 1, program: "T", linear: { team: "ENG" } },
    pis: [{ id: "p", title: "P", status: "active", sprints: [
      { id: "s1", title: "Big", status: "next", invoke: "big", est_sessions: 16 },
      { id: "s2", title: "Done big", status: "complete", invoke: "donebig", est_sessions: 16 },   // done → no warning
    ]}]};
  const w = validateLinearConfig(over).warnings.filter((m) => m.includes("estimate_max"));
  eq(w.length, 1, "exactly one oversize warning — the not-done slice only");
  ok(w[0].includes("p/s1") && w[0].includes("split"), "names the slice and says split it");
  // no meta.linear → no estimate concept → no warning even for a 16
  const noLinear = { meta: { schema_version: 1, program: "T" }, pis: over.pis };
  eq(validateLinearConfig(noLinear).warnings.filter((m) => m.includes("estimate_max")).length, 0, "no Linear config → no oversize warning");
});

// ── the plate (My Issues hopper) ──────────────────────────────────────────────
// WHY: the plate must be a CURATED subset (signal), never everything, and "what I'm actively working"
// is always on it. Off without meta.plate (backward-compat). Explicit ∪ active ∪ in_progress.
test("platedKeys: off without meta.plate; else explicit ∪ active slices ∪ in_progress items", () => {
  const pis = [{ id: "p", title: "P", status: "active", sprints: [
    { id: "s1", title: "A", status: "active", invoke: "a" },
    { id: "s2", title: "B", status: "next", invoke: "b" },
    { id: "s3", title: "C", status: "complete", invoke: "c" } ]}];
  eq(platedKeys({ meta: { schema_version: 1 }, pis }, null), null, "no meta.plate → feature off (null)");
  const bl = { items: [{ id: "x", status: "in_progress" }, { id: "y", status: "open" }] };
  eq([...platedKeys({ meta: { schema_version: 1, plate: ["b", "z"] }, pis }, bl)].sort(), ["a", "b", "x", "z"],
    "explicit(b,z) ∪ active(a) ∪ in_progress(x); complete/next/open never auto-added");
});

// WHY: 'complete only' is the chosen drain breakpoint — a merged slice leaves the hopper, a blocked one
// STAYS (visible reminder). Draining the wrong status silently loses your batch.
test("plateDrainKeys: complete-only — drains finished explicit entries, keeps blocked/active", () => {
  const g = { meta: { plate: ["a", "b", "c", "x", "ghost"] }, pis: [{ id: "p", title: "P", status: "active", sprints: [
    { id: "s1", title: "A", status: "complete", invoke: "a" },
    { id: "s2", title: "B", status: "blocked", invoke: "b" },
    { id: "s3", title: "C", status: "active", invoke: "c" } ]}]};
  eq(plateDrainKeys(g, { items: [{ id: "x", status: "done" }] }).sort(), ["a", "x"],
    "complete slice + done item drain; blocked & active stay; unknown key left alone");
});

// WHY: a malformed meta.plate silently mis-projects My Issues; structure must error and an over-cap list
// must warn — the whole point is a signal-rich hopper.
test("validatePlate: structural errors + the plate_max signal cap", () => {
  eq(validatePlate({ meta: {} }, 7).errors.length, 0, "absent → clean");
  ok(validatePlate({ meta: { plate: "nope" } }, 7).errors[0].includes("must be a list"), "non-array errors");
  ok(validatePlate({ meta: { plate: [1, "ok"] } }, 7).errors.some((e) => e.includes("must be strings")), "non-string entry errors");
  ok(validatePlate({ meta: { plate: ["a", "b", "c"] } }, 2).warnings[0].includes("plate_max"), "over cap warns");
});

// WHY: meta.plate grows and must stay human-readable — a flow seq [a, b] is the exact unreadability the
// block-style store guarantees elsewhere.
test("setPlateDoc writes meta.plate as a block sequence", () => {
  const doc = parseDocument("meta:\n  schema_version: 1\npis: []\n");
  setPlateDoc(doc, ["a", "b"]);
  const out = String(doc);
  ok(/plate:\n\s+- a\n\s+- b/.test(out), "block seq under meta.plate");
  ok(!out.includes("[a, b]"), "not a flow seq");
});

// WHY: the plate assigns YOU a curated subset (assignee) + tags each with the plate label, so My Issues ==
// your batch. Feature-off must stay byte-identical (no assignee ever), even with a viewer present.
test("buildPushPlan plate: assigns viewer + plate label on create; off-plate none; feature off inert", () => {
  const g = (over) => ({ meta: { schema_version: 1, program: "T", linear: { team: "ENG" }, ...over }, pis: [
    { id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "On", status: "next", invoke: "on" },
      { id: "s2", title: "Off", status: "next", invoke: "off" } ]}]});
  const existing = { projects: { "proj-1": { id: "proj-1", name: "P" } }, issues: {} };
  const LBL = { roadmap: "l-mark", plate: "l-plate" };
  const off = buildPushPlan({ graph: g(), backlog: null, cfg: normalizeLinearConfig(g().meta), teamStates: L_STATES, existing, labels: LBL, viewerId: "me" });
  ok(off.ops.filter((o) => o.op === "createIssue").every((o) => !("assigneeId" in o.payload)), "feature off → no assignee on any issue");
  ok(off.ops.filter((o) => o.op === "createIssue").every((o) => !(o.payload.labelIds || []).includes("l-plate")), "feature off → no plate label either");
  const meta = { plate: ["on", "ghost"] };
  const on = buildPushPlan({ graph: g(meta), backlog: null, cfg: normalizeLinearConfig(g(meta).meta), teamStates: L_STATES, existing, labels: LBL, viewerId: "me" });
  const onOp = on.ops.find((o) => o.writeBack && o.writeBack.invoke === "on");
  const offOp = on.ops.find((o) => o.writeBack && o.writeBack.invoke === "off");
  eq(onOp.payload.assigneeId, "me", "plated slice → assigned to the viewer");
  ok(onOp.payload.labelIds.includes("l-plate"), "plated slice → carries the plate label");
  ok(!("assigneeId" in offOp.payload) && !offOp.payload.labelIds.includes("l-plate"), "off-plate slice → neither assignee nor plate label");
  eq(on.unmatchedPlate, ["ghost"], "an explicit key matching no slice/item is reported (typo guard)");
});

// WHY: the safety contract on UPDATE — an issue that fell off the plate is unassigned ONLY if WE plated it
// (carries the label); a hand-assignment in Linear (no label) is never disturbed.
test("buildPushPlan plate update: unassigns a fallen-off issue we labeled, spares hand-assignments", () => {
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG" }, plate: ["keep"] }, pis: [
    { id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "S", status: "next", invoke: "keep", linear: "ENG-1" },
      { id: "s2", title: "T", status: "next", invoke: "fell", linear: "ENG-2" },
      { id: "s3", title: "U", status: "next", invoke: "hand", linear: "ENG-3" } ]}]};
  const LBL = { roadmap: "l-mark", plate: "l-plate" };
  const mk = (over) => ({ id: "u", title: "x", description: "", priority: 0, stateId: "st-u", projectId: "proj-1", assigneeId: "me", labelIds: ["l-mark"], ...over });
  const existing = { projects: { "proj-1": { id: "proj-1", name: "P" } }, issues: {
    "ENG-1": mk({ labelIds: ["l-mark", "l-plate"] }),   // on the plate, already assigned+labeled → no assignee churn
    "ENG-2": mk({ labelIds: ["l-mark", "l-plate"] }),   // fell off, WE labeled it → unassign
    "ENG-3": mk({ labelIds: ["l-mark"] }),               // hand-assigned (no plate label) → untouched
  }};
  const plan = buildPushPlan({ graph: g, backlog: null, cfg: normalizeLinearConfig(g.meta), teamStates: L_STATES, existing, labels: LBL, viewerId: "me" });
  const byId = Object.fromEntries(plan.ops.filter((o) => o.op === "updateIssue").map((o) => [o.identifier, o.payload]));
  ok(!("assigneeId" in (byId["ENG-1"] || {})), "on-plate + already assigned → no assignee churn");
  eq(byId["ENG-2"].assigneeId, null, "fell off + carries our plate label → unassigned");
  ok(!("assigneeId" in (byId["ENG-3"] || {})), "hand-assignment (no plate label) → never touched");
});

// WHY: the stated safety invariant — meta.plate ON but the viewer id unknown (fetch failed) must assign
// and label NOTHING. A regression dropping the `!!viewerId` guard would silently assign issues to no one.
test("buildPushPlan plate: viewer unknown → no assignee and no plate label, even on-plate", () => {
  const g = { meta: { schema_version: 1, program: "T", linear: { team: "ENG" }, plate: ["on"] }, pis: [
    { id: "p", title: "P", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "On", status: "next", invoke: "on" } ]}]};
  const plan = buildPushPlan({ graph: g, backlog: null, cfg: normalizeLinearConfig(g.meta), teamStates: L_STATES,
    existing: { projects: { "proj-1": { id: "proj-1", name: "P" } }, issues: {} }, labels: { roadmap: "l-mark", plate: "l-plate" }, viewerId: null });
  const onOp = plan.ops.find((o) => o.writeBack && o.writeBack.invoke === "on");
  ok(!("assigneeId" in onOp.payload), "viewer unknown → no assigneeId");
  ok(!(onOp.payload.labelIds || []).includes("l-plate"), "viewer unknown → no plate label (label never lies)");
});

// WHY: the plate's safe-unassign depends on the 'plate' label existing — provision must create it when the
// feature is on, and NOT stamp a stray label on repos that don't use the plate.
test("provisionPlan includes the plate label only when meta.plate is defined", () => {
  const base = { meta: { schema_version: 1, program: "T", linear: { team: "ENG" } }, pis: [
    { id: "p", title: "P", status: "active", sprints: [{ id: "s1", title: "S", status: "active", invoke: "x" }] }] };
  ok(!provisionPlan({ graph: base, teamLabels: {} }).createLabels.includes("plate"), "no meta.plate → no plate label");
  ok(provisionPlan({ graph: { ...base, meta: { ...base.meta, plate: [] } }, teamLabels: {} }).createLabels.includes("plate"), "meta.plate present → plate label provisioned");
});

// WHY: the plate MCP tools are how a planning session (/prioritize) curates My Issues — set replaces, add
// unions (and enables the feature from absent), remove pulls off. They edit the Document like set_fields.
test("plate MCP mutations: set replaces, add unions + enables, remove filters", () => {
  const base = "meta:\n  schema_version: 1\n  program: T\npis:\n  - id: p\n    title: P\n    status: active\n    sprints:\n      - { id: s1, title: A, status: next, invoke: a }\n";
  const doc = parseDocument(base);
  eq(setPlate(doc, { keys: ["a", "b", "b"] }).keys, ["a", "b"], "set dedups + returns the new list");
  eq(doc.toJS().meta.plate, ["a", "b"], "set wrote meta.plate onto the Document");
  eq(addPlate(doc, { keys: ["b", "c"] }).keys, ["a", "b", "c"], "add unions (dedup), preserves order");
  eq(removePlate(doc, { keys: ["a"] }).keys, ["b", "c"], "remove filters the given keys");
  const fresh = parseDocument(base);
  addPlate(fresh, { keys: ["a"] });
  eq(fresh.toJS().meta.plate, ["a"], "add on a plate-less roadmap creates meta.plate (enables the feature)");
  throws(() => setPlate(doc, {}), "requires keys", "set without keys throws");
});

// WHY: granularity is the leak-control lever — 'pis' must emit NO issues, and a per-PI
// override must flip only that PI, or a public Linear team sees work it shouldn't.
test("granularity gates issue ops globally and per-PI", () => {
  const pisOnly = pushGraph({ granularity: "pis" });
  const plan = buildPushPlan({ graph: pisOnly, backlog: null, cfg: normalizeLinearConfig(pisOnly.meta), teamStates: L_STATES, existing: SNAP() });
  eq(plan.ops.filter((o) => o.op.includes("Issue")).length, 0, "pis granularity → projects only");
  const overridden = pushGraph();
  overridden.pis[0].linear.granularity = "pis";   // per-PI override on a slices-global roadmap
  const plan2 = buildPushPlan({ graph: overridden, backlog: null, cfg: normalizeLinearConfig(overridden.meta), teamStates: L_STATES, existing: SNAP() });
  eq(plan2.ops.filter((o) => o.op.includes("Issue")).length, 0, "override suppresses that PI's issues");
  const withBacklog = pushGraph({ granularity: "slices+backlog" });
  const backlog = { meta: { schema_version: 1 }, items: [
    { id: "b1", title: "Fix", kind: "bug", status: "open" },
    { id: "b2", title: "Moved", kind: "chore", status: "promoted", promoted_to: "auth/s9" },
  ]};
  const plan3 = buildPushPlan({ graph: withBacklog, backlog, cfg: normalizeLinearConfig(withBacklog.meta), teamStates: L_STATES, existing: SNAP() });
  const itemOps = plan3.ops.filter((o) => o.writeBack && o.writeBack.kind === "item");
  eq(itemOps.length, 1, "open item pushes; promoted item skipped (its sprint carries it)");
});

// WHY: Linear mints its own identifier (PID-n) AFTER creation, so the backlog number a human
// actually talks about ("look at b60") is invisible in Linear's triage view unless the title
// carries it — without the prefix, finding an item means opening issues one by one.
test("backlog items push to Linear with their id prefixed into the title, without double-prefixing", () => {
  const withBacklog = pushGraph({ granularity: "slices+backlog" });
  const backlog = { meta: { schema_version: 1 }, items: [
    { id: "b7", title: "Fix the flaky thing", kind: "bug", status: "open" },
    { id: "b8", title: "b8 · Already prefixed by a round-trip", kind: "chore", status: "open" },
  ]};
  const plan = buildPushPlan({ graph: withBacklog, backlog, cfg: normalizeLinearConfig(withBacklog.meta), teamStates: L_STATES, existing: SNAP() });
  const items = plan.ops.filter((o) => o.writeBack && o.writeBack.kind === "item");
  eq(items.find((o) => o.writeBack.id === "b7").payload.title, "b7 · Fix the flaky thing", "id lands in front of the title");
  eq(items.find((o) => o.writeBack.id === "b8").payload.title, "b8 · Already prefixed by a round-trip", "an already-prefixed title is left alone");
});

// WHY: addPi/addSprint copy args field-by-field; a field the copy-list omits is DROPPED
// SILENTLY — that is exactly how a fully-specified PI (summary, priority, initiative all
// passed by the caller) landed on the live board as a shell needing a manual repair pass.
// The `missing` list is the add-seam nudge that makes new work Linear-ready out of the box.
test("addPi/addSprint persist every add-time field and report Linear-readiness gaps", () => {
  const doc = parseDocument(`meta:\n  schema_version: 1\n  program: T\npis: []\n`);
  const r1 = addPi(doc, { id: "p1", title: "P1", status: "active", summary: "One line", priority: { tier: "P1", reason: "r" }, initiative: "Engine credibility", target_date: "2026-08-01" });
  const pi = doc.toJS().pis[0];
  eq(pi.summary, "One line", "summary persists (was silently dropped)");
  eq(pi.priority.tier, "P1", "priority persists (was silently dropped)");
  eq(pi.initiative, "Engine credibility", "initiative persists (was silently dropped)");
  eq(pi.target_date, "2026-08-01", "add-time dates persist");
  ok(!r1.missing, "fully-dialed PI reports no gaps");
  eq(addPi(doc, { id: "p2", title: "P2" }).missing, ["summary", "priority"], "shell PI reports its readiness gaps");
  const r3 = addSprint(doc, { pi: "p2", id: "s1", title: "S", invoke: "s1x", status_label: "FABLE-5 candidate — x", dispatch_tier: "fable" });
  eq(doc.toJS().pis[1].sprints[0].dispatch_tier, "fable", "newer sprint fields persist through add");
  eq(r3.missing, ["what", "gate", "est_sessions", "priority"], "bare sprint reports its gaps");
  ok(!addSprint(doc, { pi: "p2", id: "s2", title: "S2", invoke: "s2x", what: "w", gate: "g", est_sessions: 1, priority: { tier: "P2", reason: "r" } }).missing,
    "dialed sprint reports no gaps");
});

// WHY: an unacked per-PI override silently reshapes what the whole team sees in Linear;
// the ack must gate the mutation BEFORE anything is written, with the exact actionable message.
test("addPi rejects a conflicting linear override without the ack, exact message; ack or match passes", () => {
  const y = `meta:\n  schema_version: 1\n  program: T\n  linear:\n    team: ENG\npis:\n  - id: a\n    title: A\n    status: active\n    sprints:\n      - { id: s1, title: S, status: active, invoke: x }\n`;
  throws(() => addPi(parseDocument(y), { id: "platform", title: "P", linear: { granularity: "pis" } }),
    `PI "platform" overrides Linear granularity ("pis") against the global meta.linear.granularity ("slices")`,
    "conflict without ack throws the exact message");
  const doc = parseDocument(y);
  addPi(doc, { id: "platform", title: "P", linear: { granularity: "pis" }, yes_linear_override: true });
  ok(String(doc.getIn(["pis", 1, "linear", "granularity"])) === "pis", "acked override written");
  addPi(doc, { id: "match", title: "M", linear: { granularity: "slices" } });  // matches global → no ack needed
  // checkPiOverrideAck standalone: no global config → never throws
  checkPiOverrideAck(null, { granularity: "pis" }, false, "x");
});
