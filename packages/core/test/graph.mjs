// packages/core tests — graph. Moved verbatim from scripts/test/run.mjs (core-extract slice).
// Runs when imported; the shared harness counts every test in one summary.
import { test, eq, ok, throws, sp } from "./harness.mjs";
import { resolve } from "node:path";
import { coherenceEnabled, computeWaves, detectCycle, execPlan, flatten, resolveGate, sessionsRemaining } from "@connorbritain/roadmap-core/graph.mjs";
import { buildPlan } from "@connorbritain/roadmap-core/plan.mjs";

// ── dependency resolution ──────────────────────────────────────────────────
// WHY: a slice's deps decide when it becomes runnable. If sibling/PI/qualified
// forms don't resolve, the scheduler launches work before its prerequisites exist.
test("flatten resolves sibling, fully-qualified, and PI-id deps", () => {
  const g = { pis: [
    { id: "a", title: "A", status: "active", sprints: [
      sp("s1", { status: "complete" }),
      sp("s2", { deps: ["s1"] }),                 // sibling
      sp("s3", { deps: ["a/s1"] }),               // fully-qualified
    ]},
    { id: "b", title: "B", status: "next", sprints: [
      sp("b1", { deps: ["a"] }),                  // whole-PI dep
    ]},
  ]};
  const m = flatten(g);
  const s2 = m.nodes.find((n) => n.id === "s2");
  const s3 = m.nodes.find((n) => n.id === "s3");
  const b1 = m.nodes.find((n) => n.id === "b1");
  eq(s2.deps, ["a/s1"], "sibling dep");
  eq(s3.deps, ["a/s1"], "qualified dep");
  eq(b1.piDeps, ["a"], "PI dep");
});

// WHY: invoke keys are the /slice launch keys; a duplicate means two slices answer
// the same command and the fanout launches the wrong worktree.
test("flatten rejects duplicate invoke keys", () => {
  const g = { pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { invoke: "dup" }), sp("s2", { invoke: "dup" }),
  ]}]};
  throws(() => flatten(g), "duplicate invoke", "should reject dup invoke");
});

// WHY: a typo'd dep that silently resolves to nothing would let a gated/unbuilt
// prerequisite be treated as satisfied. Unresolved deps must be a hard error.
test("flatten rejects an unresolvable dep", () => {
  const g = { pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { deps: ["nope"] }),
  ]}]};
  throws(() => flatten(g), "matches no", "should reject unknown dep");
});

// ── cycle detection ─────────────────────────────────────────────────────────
// WHY: a dependency cycle is un-runnable; without detection the scheduler would
// loop or silently drop the cycle, hiding a broken roadmap.
test("detectCycle finds a 2-node cycle and clears an acyclic graph", () => {
  const cyclic = flatten({ pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { deps: ["s2"] }), sp("s2", { deps: ["s1"] }),
  ]}]});
  ok(detectCycle(cyclic), "should detect cycle");
  const acyclic = flatten({ pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", {}), sp("s2", { deps: ["s1"] }),
  ]}]});
  eq(detectCycle(acyclic), null, "acyclic should be null");
});

// WHY: computeWaves must refuse to plan a cyclic graph rather than emit a bogus order.
test("computeWaves throws on a cycle", () => {
  const m = flatten({ pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { deps: ["s2"] }), sp("s2", { deps: ["s1"] }),
  ]}]});
  throws(() => computeWaves(m, 3), "cycle", "should throw on cycle");
});

// ── wave scheduling ─────────────────────────────────────────────────────────
// WHY: two sprints that write the same file MUST NOT run in the same wave, or the
// parallel sessions corrupt each other's checkout — the core two-wave invariant.
test("computeWaves defers shared-file contention to a later wave", () => {
  const m = flatten({ pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { status: "active", est_sessions: 1, touches: ["F.cs"] }),
    sp("s2", { status: "active", est_sessions: 1, touches: ["F.cs"] }),
  ]}]});
  const { waves } = computeWaves(m, 3);
  eq(waves.length, 2, "shared file → 2 waves");
  eq(waves[0].length, 1, "one per wave");
});

// WHY: disjoint, independent slices should fan out together up to the cap — that's
// the whole point of the tool; under-parallelizing wastes the user's concurrency.
test("computeWaves runs disjoint slices together and respects the cap", () => {
  const mk = (id) => sp(id, { status: "active", est_sessions: 1, touches: [`${id}.cs`] });
  const m = flatten({ pis: [{ id: "a", title: "A", status: "active", sprints: [mk("s1"), mk("s2"), mk("s3")] }]});
  eq(computeWaves(m, 3).waves[0].length, 3, "cap 3 → all 3 in wave 1");
  eq(computeWaves(m, 2).waves[0].length, 2, "cap 2 → 2 in wave 1");
});

// WHY: a slice must wait for its dependency to (optimistically) complete; launching
// a dependent early is exactly the failure deps exist to prevent.
test("computeWaves orders a dependent after its dep", () => {
  const m = flatten({ pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { status: "active", est_sessions: 1, touches: ["x.cs"] }),
    sp("s2", { status: "active", est_sessions: 1, deps: ["s1"], touches: ["y.cs"] }),
  ]}]});
  const { waves } = computeWaves(m, 5);
  eq(waves[0].map((n) => n.id), ["s1"], "s1 first");
  eq(waves[1].map((n) => n.id), ["s2"], "s2 second");
});

// WHY: a human-gated step (signing prereqs, live payment smoke) must never be
// auto-launched; it belongs in held-on-human, and its downstream cone stays parked.
test("computeWaves holds gated_on nodes and never schedules them", () => {
  const m = flatten({ pis: [{ id: "a", title: "A", status: "gated", sprints: [
    sp("s0", { status: "gated", gated_on: "Connor", est_sessions: 0 }),
    sp("s1", { status: "scheduled", est_sessions: 1, deps: ["s0"], touches: ["z.cs"] }),
  ]}]});
  const { waves, held } = computeWaves(m, 3);
  eq(waves.length, 0, "nothing runnable");
  eq(held.onHuman.map((n) => n.id), ["s0"], "s0 held on human");
  eq(held.blocked.map((n) => n.id), ["s1"], "s1 blocked behind the gate");
});

// ── derived views ───────────────────────────────────────────────────────────
// WHY: the exec-plan line is the human-facing parallelization recommendation; it
// must reflect REMAINING work (exclude done) and group independent sprints as parallel.
test("execPlan shows remaining work with parallel grouping", () => {
  const pi = { sprints: [
    sp("s1", { status: "complete" }),
    sp("s2", { status: "active", deps: ["s1"] }),
    sp("s3", { status: "next" }),
    sp("s4", { status: "next", deps: ["s2", "s3"] }),
  ]};
  // remaining = s2,s3,s4; s2&s3 are level 0 (s2's only dep s1 is done/excluded), s4 after both
  eq(execPlan(pi), "(S2 ∥ S3)→S4", "remaining exec plan");
});

// WHY: "sessions remaining" is the at-a-glance PI burn-down; it must sum only the
// not-done sprints or the user can't gauge what's left.
test("sessionsRemaining sums only not-complete sprints", () => {
  const pi = { sprints: [
    sp("s1", { status: "complete", est_sessions: 5 }),
    sp("s2", { status: "active", est_sessions: 3 }),
    sp("s3", { status: "next", est_sessions: 2 }),
  ]};
  eq(sessionsRemaining(pi), 5, "3+2, s1 excluded");
});

// WHY: a sprint's gate is the acceptance bar the autonomous session must pass; the
// {{default}} token must interpolate the program-wide gate, not leak literally.
test("resolveGate interpolates {{default}} and passes plain strings", () => {
  const graph = { meta: { default_gate: "BUILD" } };
  eq(resolveGate({ gate: "default" }, graph), "BUILD", "default → meta gate");
  eq(resolveGate({ gate: "{{default}}\nPLUS x" }, graph), "BUILD\nPLUS x", "interpolated");
  eq(resolveGate({ gate: "custom only" }, graph), "custom only", "plain passthrough");
});

// ── wave-packing coherence ────────────────────────────────────────────────────
// WHY: a capped wave that takes one slice from each of N PIs leaves every PI half-open —
// coherence must prefer finishing started PIs, but NEVER outrank a declared priority
// (a P0 in a fresh PI still wins), and single-PI graphs must be untouched.
test("computeWaves coherence: started/closest-to-done PIs win equal-priority cap slots; priority still outranks; opt-out restores old order", () => {
  const g = (opts = {}) => ({ meta: opts.meta || {}, pis: [
    { id: "started", title: "S", status: "active", sprints: [
      { id: "s1", title: "done", status: "complete", invoke: "started-done" },
      { id: "s2", title: "next", status: "next", invoke: "started-next", touches: ["f1"] },
    ]},
    { id: "fresh", title: "F", status: "next", sprints: [
      { id: "s1", title: "aaa", status: "next", invoke: "aaa-fresh", touches: ["f2"], ...(opts.freshPriority ? { priority: { tier: "P0" } } : {}) },
    ]},
  ]});
  // equal priority: the started PI's slice beats the alphabetically-earlier fresh one
  const m1 = flatten(g());
  eq(computeWaves(m1, 1).waves[0].map((n) => n.invoke), ["started-next"], "started PI wins the single slot");
  // declared priority overrides coherence — no overweighting
  const m2 = flatten(g({ freshPriority: true }));
  eq(computeWaves(m2, 1).waves[0].map((n) => n.invoke), ["aaa-fresh"], "P0 in a fresh PI still wins");
  // opt-out restores the old status/est/alpha order
  eq(computeWaves(m1, 1, { coherence: false }).waves[0].map((n) => n.invoke), ["aaa-fresh"], "coherence:false → alphabetical again");
  eq(coherenceEnabled({}), true, "default on");
  eq(coherenceEnabled({ discipline: { coherence: false } }), false, "meta opt-out");
});

// WHY: among two started PIs, the one closer to done should close first — otherwise the
// scheduler keeps N PIs perpetually at 80%.
test("computeWaves coherence: closest-to-done started PI outranks a bigger started PI", () => {
  const g = { meta: {}, pis: [
    { id: "big", title: "B", status: "active", sprints: [
      { id: "s1", title: "d", status: "complete", invoke: "big-done" },
      { id: "s2", title: "a", status: "next", invoke: "aaa-big", touches: ["f1"] },
      { id: "s3", title: "b", status: "next", invoke: "bbb-big", touches: ["f2"] },
      { id: "s4", title: "c", status: "next", invoke: "ccc-big", touches: ["f3"] },
    ]},
    { id: "small", title: "S", status: "active", sprints: [
      { id: "s1", title: "d", status: "complete", invoke: "small-done" },
      { id: "s2", title: "z", status: "next", invoke: "zzz-small", touches: ["f4"] },
    ]},
  ]};
  eq(computeWaves(flatten(g), 1).waves[0].map((n) => n.invoke), ["zzz-small"], "one-remaining PI closes before the three-remaining PI");
});

// WHY: the plan's closes annotation is the coherence read-out — a wave that finishes a PI
// must say so, and one that doesn't must not.
test("buildPlan waveCloses names the PIs a wave finishes", () => {
  const g = { meta: { schema_version: 1, program: "T" }, pis: [
    { id: "a", title: "A", status: "active", sprints: [
      { id: "s1", title: "d", status: "complete", invoke: "a-done" },
      { id: "s2", title: "last", status: "next", invoke: "a-last", touches: ["f1"], est_sessions: 1 },
    ]},
    { id: "b", title: "B", status: "active", sprints: [
      { id: "s1", title: "one", status: "next", invoke: "b-one", touches: ["f2"], est_sessions: 1 },
      { id: "s2", title: "two", status: "next", invoke: "b-two", touches: ["f2"], est_sessions: 1 },  // same file → later wave
    ]},
  ]};
  const plan = buildPlan(g, { cap: 3, disk: null, reviewDebt: 0 });
  eq(plan.waveCloses[0], ["a"], "wave 1 closes PI a (b still has contended work)");
  ok(plan.waveCloses[plan.waves.length - 1].includes("b"), "the final wave closes b");
});

// WHY: the command-lane sort primitive is unit-tested in computeWaves, but `plan` only honors it if
// buildPlan threads meta+today into computeWaves — the wiring that connects the feature to the actual
// command. Without it an active command lane silently boosts nothing (the exact gap this closes).
test("buildPlan honors an active command_lane: the lane slice floats above a higher-priority non-lane slice", () => {
  const g = (command_lane) => ({
    meta: { schema_version: 1, program: "T", ...(command_lane ? { command_lane } : {}) },
    pis: [
      { id: "a", title: "A", status: "active", sprints: [
        { id: "s1", title: "hi", status: "active", invoke: "a-hi", priority: { tier: "P0" }, touches: ["f1"], est_sessions: 1 } ] },
      { id: "b", title: "B", status: "active", sprints: [
        { id: "s1", title: "lane", status: "active", invoke: "b-lane", priority: { tier: "P3" }, touches: ["f2"], est_sessions: 1 } ] },
    ],
  });
  const lane = { objective: "ship b", until: "2026-12-31", slices: ["b-lane"] };
  const active = buildPlan(g(lane), { cap: 3, disk: null, reviewDebt: 0, today: "2026-07-13" });
  eq(active.waves[0][0].invoke, "b-lane", "active lane floats its slice above the P0 non-lane slice");
  const expired = buildPlan(g(lane), { cap: 3, disk: null, reviewDebt: 0, today: "2027-01-01" });
  eq(expired.waves[0][0].invoke, "a-hi", "past `until` → priority wins again (lane released)");
  const none = buildPlan(g(null), { cap: 3, disk: null, reviewDebt: 0, today: "2026-07-13" });
  eq(none.waves[0][0].invoke, "a-hi", "no command_lane → unchanged (P0 first)");
});
