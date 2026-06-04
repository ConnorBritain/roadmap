#!/usr/bin/env node
// slice-roadmap — graph-brain test suite.
// Zero-dependency runner. Each test states WHY it matters (what breaks if it regresses),
// because this brain schedules concurrent sessions that commit/push — a wrong wave is a
// real-world collision, not a cosmetic bug. Run: node scripts/test/run.mjs  (or npm test).

import {
  flatten, detectCycle, computeWaves, execPlan, sessionsRemaining, resolveGate, isDone, readyNodes,
} from "../lib/graph.mjs";
import { nodeWeight, recommendConcurrency } from "../lib/recommend.mjs";
import { synthesizeBrief, branchFor, worktreeFor, baseRefOf, baseBranchOf, remoteOf, launchPrompt } from "../lib/brief.mjs";
import { route, classify, buildArgs, findRepoRoot, missingRoadmapHelp, expandShort, REL } from "../lib/cli-core.mjs";
import { launchDecision } from "../lib/fanout-core.mjs";
import { terminalChoices, moveSelection, parseCap, buildFanArgs, autoOutName } from "../lib/wizard-core.mjs";
import { TOOLS, addSprint, setStatus, setFields, prune, validateDocOrThrow, readValidate } from "../lib/mcp-core.mjs";
import { diffPrStates, matchesRoadmapBranches, checksOf } from "../lib/pr-watch-core.mjs";
import { findUnrecordedMerges, reconcileNudge } from "../lib/sync-core.mjs";
import { parseDocument } from "yaml";
import { join, resolve } from "node:path";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || "not equal"} — got ${a}, expected ${b}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "expected truthy"); }
function throws(fn, match, msg) {
  try { fn(); } catch (e) {
    if (match && !e.message.includes(match)) throw new Error(`${msg}: wrong error "${e.message}" (wanted "${match}")`);
    return;
  }
  throw new Error(msg || "expected a throw");
}

const sp = (id, o = {}) => ({ id, title: id, invoke: o.invoke || id, status: o.status || "next", ...o });

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

// ── concurrency recommender ─────────────────────────────────────────────────
const recoGraph = {
  meta: { default_gate: "dotnet test", branch_convention: "{pi}/{sprint}", worktree_root: "/home/c" },
  pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { status: "active", gate: "default", touches: ["x.cs"] }),       // heavy (dotnet test)
    sp("s2", { status: "active", gate: "docs only", touches: ["docs/y.md"] }),// light (docs)
    sp("s3", { status: "active", gate: "dotnet build" }),                     // medium (a build, not a test run)
    sp("s4", { status: "next", weight: "light", gate: "default" }),           // explicit override
  ]}],
};
const recoModel = flatten(recoGraph);
const recoReady = readyNodes(recoModel);

// WHY: weight classification drives the resource budget; a docs slice mis-tagged heavy
// would shrink the recommended cap for no reason, and a dotnet-test slice tagged light
// would over-subscribe RAM and thrash the machine.
test("nodeWeight classifies by gate + touches, with explicit override winning", () => {
  const byId = (id) => recoModel.nodes.find((n) => n.id === id);
  eq(nodeWeight(byId("s1"), recoGraph), "heavy", "dotnet-test gate → heavy");
  eq(nodeWeight(byId("s2"), recoGraph), "light", "docs-only touches → light");
  eq(nodeWeight(byId("s3"), recoGraph), "medium", "build gate → medium");
  eq(nodeWeight(byId("s4"), recoGraph), "light", "explicit weight override wins");
});

// WHY: the whole feature is "don't over-subscribe the machine OR the human." Each ceiling
// must actually bind when it's the smallest — a recommender that ignores tiny RAM would
// thrash; one that ignores the review ceiling would bury the user in PRs.
test("recommendConcurrency takes the MIN ceiling and reports which binds", () => {
  // Tiny RAM → RAM binds.
  const tiny = recommendConcurrency(recoReady, recoGraph, { sys: { cores: 64, totalGb: 8, freeGb: 8, platform: "linux" } });
  ok(tiny.binding.why.startsWith("RAM"), `expected RAM-bound, got ${tiny.binding.why}`);
  ok(tiny.recommended >= 1, "at least 1");
  // Big machine, few slices → work binds (only ~4 ready).
  const big = recommendConcurrency(recoReady, recoGraph, { sys: { cores: 64, totalGb: 256, freeGb: 256, platform: "linux" }, reviewCeiling: 50 });
  ok(big.binding.why.startsWith("work"), `expected work-bound, got ${big.binding.why}`);
  eq(big.recommended, recoReady.length, "work cap = ready count");
  // Big machine, lots of work → the review ceiling protects the human.
  const reviewBound = recommendConcurrency(recoReady, recoGraph, { sys: { cores: 64, totalGb: 256, freeGb: 256, platform: "linux" }, reviewCeiling: 2 });
  eq(reviewBound.recommended, 2, "review ceiling binds");
});

// ── kickoff brief ───────────────────────────────────────────────────────────
// WHY: a launched session "just starts" from this brief; if it omits the gate, the
// branch, or the DO-NOT-MERGE rule, an autonomous worker could merge its own PR or
// skip verification — the exact failures the handoff contract exists to prevent.
test("synthesizeBrief carries gate, branch, read-order, and DO-NOT-MERGE", () => {
  const briefGraph = {
    meta: { default_gate: "GATECMD", branch_convention: "{pi}/{sprint}", worktree_root: "/home/c" },
    pis: [{ id: "pi", title: "PI", status: "active", sprints: [
      sp("s1", { status: "active", gate: "default", invoke: "demo", read_order: ["read X first"], resume_action: "do the thing" }),
    ]}],
  };
  const m = flatten(briefGraph);
  const node = m.nodes[0];
  eq(branchFor(node, briefGraph), "pi/s1", "branch convention");
  eq(worktreeFor(node, briefGraph), "/home/c/pi-s1", "worktree path");
  const b = synthesizeBrief(node, briefGraph);
  ok(/GATECMD/.test(b), "brief includes resolved gate");
  ok(/pi\/s1/.test(b), "brief includes branch");
  ok(/read X first/.test(b), "brief includes read-order");
  ok(/do the thing/.test(b), "brief includes next action");
  ok(/NOT.{0,4}merge/i.test(b), "brief forbids merging");
});

// WHY: an inline/path kickoff_brief must pass through untouched — the author opted out
// of synthesis on purpose; silently regenerating would discard their custom brief.
test("synthesizeBrief passes through an explicit kickoff_brief", () => {
  const g = { meta: {}, pis: [{ id: "pi", title: "P", status: "active", sprints: [
    sp("s1", { status: "active", invoke: "x", kickoff_brief: "CUSTOM BRIEF" }),
  ]}]};
  eq(synthesizeBrief(flatten(g).nodes[0], g), "CUSTOM BRIEF", "explicit brief passthrough");
});

// ── generalization: multi-ecosystem classification + meta overrides ──────────
// WHY: the plugin is global — it must classify Rust/Python/Go/etc. work, not just
// .NET/JS. A Cargo or pytest suite mis-classified as light would over-subscribe RAM
// on a non-.NET repo and thrash it.
test("nodeWeight recognizes non-.NET runners (cargo/pytest/go)", () => {
  const g = { meta: {}, pis: [{ id: "r", title: "R", status: "active", sprints: [
    sp("a", { gate: "cargo test --all", touches: ["src/lib.rs"] }),
    sp("b", { gate: "pytest -q", touches: ["app.py"] }),
    sp("c", { gate: "go build ./...", touches: ["main.go"] }),
    sp("d", { gate: "cd gui && vitest run", touches: ["x.ts"] }),
  ]}]};
  const m = flatten(g);
  eq(nodeWeight(m.nodes[0], g), "heavy", "cargo test → heavy");
  eq(nodeWeight(m.nodes[1], g), "heavy", "pytest → heavy");
  eq(nodeWeight(m.nodes[2], g), "medium", "go build → medium");
  eq(nodeWeight(m.nodes[3], g), "heavy", "vitest run (a full test-suite run) → heavy");
});

// WHY: the popular stacks (Java via Maven, C/C++ via CMake) must size correctly out of
// the box; a 'mvn verify' mis-read as light over-subscribes RAM, and a 'cmake --build'
// dismissed as free under-uses the machine. (Guards the classifier's breadth claim.)
test("nodeWeight sizes Maven (heavy) and CMake (medium) runners", () => {
  const g = { meta: {}, pis: [{ id: "j", title: "J", status: "active", sprints: [
    sp("a", { gate: "mvn verify", touches: ["src/Main.java"] }),
    sp("b", { gate: "cmake --build build", touches: ["src/main.cpp"] }),
  ]}]};
  const m = flatten(g);
  eq(nodeWeight(m.nodes[0], g), "heavy", "mvn verify → heavy");
  eq(nodeWeight(m.nodes[1], g), "medium", "cmake --build → medium");
});

// WHY: a repo with a bespoke runner must be able to teach the classifier without
// forking the plugin — otherwise "portable" is a lie for anyone off the beaten path.
test("meta.weight_patterns extends the classifier", () => {
  const g = { meta: { weight_patterns: { heavy: ["bespoke-suite"] } }, pis: [{ id: "x", title: "X", status: "active",
    sprints: [sp("a", { gate: "run bespoke-suite now", touches: ["x.foo"] })] }]};
  eq(nodeWeight(flatten(g).nodes[0], g), "heavy", "custom heavy pattern applied");
});

// WHY: an unrecognized runner that still touches code shouldn't be dismissed as free;
// floor it at medium so the recommender leaves headroom.
test("nodeWeight floors unknown-runner code work at medium, docs at light", () => {
  const g = { meta: {}, pis: [{ id: "x", title: "X", status: "active", sprints: [
    sp("a", { gate: "weirdtool ./...", touches: ["thing.zig"] }),
    sp("b", { gate: "weirdtool", touches: ["README.md"] }),
  ]}]};
  const m = flatten(g);
  eq(nodeWeight(m.nodes[0], g), "medium", "unknown runner + code touch → medium");
  eq(nodeWeight(m.nodes[1], g), "light", "docs-only → light");
});

// WHY: base branch + remote are hardcodable footguns; a repo on 'master' or a fork
// remote must get correct worktree base refs + PR bases, or every launched session
// branches off the wrong commit.
test("base branch / remote default to main/origin and honor meta overrides", () => {
  const def = { meta: {} };
  eq(baseRefOf(def), "origin/main", "default base ref");
  const over = { meta: { remote: "upstream", base_branch: "develop" } };
  eq(remoteOf(over), "upstream", "remote override");
  eq(baseBranchOf(over), "develop", "base branch override");
  eq(baseRefOf(over), "upstream/develop", "composed base ref");
});

// ── CLI dispatcher core ──────────────────────────────────────────────────────
// WHY: the `roadmap` command is the daily entry point. If routing regresses, bare
// `roadmap` stops defaulting to plan, or `roadmap --cap 3` is read as a command — the
// tool silently does the wrong thing from the shell.
test("route: bare → plan, leading flag → plan, -h → help, word → that command", () => {
  eq(route([]), { cmd: "plan", rest: [] }, "bare → plan");
  eq(route(["--cap", "3"]), { cmd: "plan", rest: ["--cap", "3"] }, "leading flag → plan + flags");
  eq(route(["-h"]), { cmd: "help", rest: [] }, "-h → help");
  eq(route(["--help"]), { cmd: "help", rest: [] }, "--help → help");
  eq(route(["fan", "--wave", "1"]), { cmd: "fan", rest: ["--wave", "1"] }, "subcommand + rest");
});

// WHY: classify decides what actually runs; a built command misrouted to 'unknown'
// breaks the CLI, and a P4 stub misrouted to 'run' would spawn a nonexistent script.
test("classify: maps built commands, flags P4 stubs, rejects unknown", () => {
  eq(classify("plan").kind, "run", "plan runs");
  eq(classify("plan").script, "scheduler.mjs", "plan → scheduler");
  eq(classify("fan").script, "fanout.mjs", "fan → fanout");
  eq(classify("validate").script, "validate.mjs", "validate → validate");
  eq(classify("sync"), { kind: "notyet", phase: "P4" }, "sync is P4");
  eq(classify("bogus").kind, "unknown", "unknown command");
  eq(classify("help").kind, "help", "help");
});

// WHY: validate.mjs takes a POSITIONAL path while the others take --in; if buildArgs
// gets this wrong, `roadmap validate` either checks nothing or errors on a stray flag.
test("buildArgs: injects the positional path only for validate-without-one", () => {
  eq(buildArgs("validate", [], "R.yaml"), ["R.yaml"], "validate w/o positional → inject");
  eq(buildArgs("validate", ["--quiet"], "R.yaml"), ["R.yaml", "--quiet"], "flags-only still injects");
  eq(buildArgs("validate", ["other.yaml"], "R.yaml"), ["other.yaml"], "explicit positional preserved");
  eq(buildArgs("plan", ["--cap", "3"], "R.yaml"), ["--cap", "3"], "non-validate passes rest through");
});

// WHY: upward discovery is what lets you run `roadmap` from any subdir; if it stops
// walking or never terminates, the CLI fails at repo root or hangs.
test("findRepoRoot walks up to the dir holding the roadmap, else null", () => {
  const target = resolve("/a/b");                       // resolve() to match findRepoRoot's own resolve (drive-correct on Windows)
  const exists = (p) => p === join(target, ...REL);
  eq(findRepoRoot(resolve("/a/b/c/d"), exists), target, "found by walking up");
  eq(findRepoRoot(resolve("/x/y"), () => false), null, "none anywhere → null (terminates at fs root)");
});

// WHY: the not-found path is a teaching moment, not a dead end — it must name WHERE the
// file goes and how to start one, or a new user is stuck. (The user asked for this.)
test("missingRoadmapHelp names the path, the cwd, and a starter", () => {
  const h = missingRoadmapHelp("/some/where");
  ok(h.includes(REL.join("/")), "names docs/roadmap/roadmap.yaml");
  ok(h.includes("/some/where"), "echoes the cwd it searched from");
  ok(/repo-root/.test(h), "says it goes at the repo root");
  ok(/schema_version/.test(h), "includes a starter snippet");
});

// ── fanout launch decision ───────────────────────────────────────────────────
// WHY: launch is the DEFAULT (low-risk interactive); the only dangerous mode (headless
// autonomous commit/push/PR) must stay behind a double-ack. If this regresses, a bare
// `roadmap fan` could fire autonomous workers, or --dry could accidentally spawn.
test("launchDecision: launch by default, --dry/--out preview, autonomous double-acked", () => {
  eq(launchDecision({}), { spawn: true, mode: "interactive" }, "bare → launch interactive");
  eq(launchDecision({ dry: true }).spawn, false, "--dry → no spawn");
  eq(launchDecision({ out: "x.sh" }).spawn, false, "--out → no spawn (wrote script)");
  eq(launchDecision({ autonomous: true }), { spawn: false, mode: "autonomous-needs-ack" }, "autonomous w/o ack → held");
  eq(launchDecision({ autonomous: true, okAutonomous: true }), { spawn: true, mode: "autonomous" }, "autonomous + ack → launch");
});

// ── short flags + self-contained worker prompt ──────────────────────────────
// WHY: `-w 1 -c 2 -t warp` must expand to the long flags the scripts understand, and
// positionals/long flags must pass through untouched, or the CLI silently drops options.
test("expandShort maps single-letter flags and leaves the rest alone", () => {
  eq(expandShort(["-w", "1", "-c", "2", "-t", "warp"]), ["--wave", "1", "--cap", "2", "--term", "warp"], "short → long");
  eq(expandShort(["--wave", "1", "auth-sessions"]), ["--wave", "1", "auth-sessions"], "long + positional untouched");
  eq(expandShort(["-r", "-f"]), ["--remove", "--force"], "cleanup shorts");
  eq(expandShort(["-lc", "-wm", "acceptEdits"]), ["--lead-claude", "--worker-mode", "acceptEdits"], "multi-letter aliases");
});

// WHY: spawned worker sessions don't have the /slice skill (plugin not installed; worktrees
// don't carry gitignored skills). The prompt MUST be self-contained — read the kickoff brief —
// or every worker errors 'Unknown command: /slice' and does nothing. (Regression guard.)
test("launchPrompt is self-contained, steers to plan-then-wait, and is wt-safe", () => {
  const p = launchPrompt({ invoke: "x" });
  ok(/\.kickoff\.md/.test(p), "references the kickoff brief");
  ok(!/\/slice/.test(p), "does NOT depend on the /slice command");
  ok(/NOT.{0,4}merge/i.test(p), "still forbids merging");
  ok(/plan/i.test(p) && /approv/i.test(p), "steers to present a plan and wait for approval");
  ok(!p.includes(";"), "no ';' — it's wt's tab delimiter and would spawn bogus tabs");
});

// ── interactive console core ──────────────────────────────────────────────────
// WHY: bare `roadmap` opens the wizard, but `roadmap go` must force it (e.g. when a shell shim
// hides the TTY); if it doesn't route to wizard.mjs the explicit escape hatch is dead.
test("classify routes the interactive wizard commands", () => {
  eq(classify("go").script, "wizard.mjs", "go → wizard");
  eq(classify("wizard").script, "wizard.mjs", "wizard → wizard");
});

// WHY: the wizard's default terminal must match the platform or the very first Enter launches the
// wrong adapter (wt on Windows, tmux elsewhere); the other adapters must still be offered.
test("terminalChoices puts the platform default first and offers all adapters", () => {
  eq(terminalChoices("win32")[0], "wt", "windows → wt first");
  eq(terminalChoices("linux")[0], "tmux", "linux → tmux first");
  eq(terminalChoices("darwin")[0], "tmux", "mac → tmux first");
  const win = terminalChoices("win32");
  ok(win.includes("warp") && win.includes("print") && win.includes("background"), "all adapters offered");
});

// WHY: arrow navigation must wrap, or the user hits a dead end at a list edge and thinks the UI froze.
test("moveSelection wraps at both ends and ignores unrelated keys", () => {
  eq(moveSelection(0, "up", 3), 2, "up from top wraps to bottom");
  eq(moveSelection(2, "down", 3), 0, "down from bottom wraps to top");
  eq(moveSelection(1, "down", 3), 2, "down moves");
  eq(moveSelection(1, "x", 3), 1, "unrelated key → no move");
});

// WHY: the cap field feeds the scheduler; a blank must take the recommended default, and garbage
// or out-of-range input must be rejected — not silently coerced into a thrashing or no-op cap.
test("parseCap defaults on blank and rejects non-numeric / out-of-range", () => {
  eq(parseCap("", { min: 1, max: 5, def: 3 }), { value: 3 }, "blank → default");
  eq(parseCap("2", { min: 1, max: 5, def: 3 }), { value: 2 }, "valid");
  ok(parseCap("9", { min: 1, max: 5, def: 3 }).error, "above max → error");
  ok(parseCap("0", { min: 1, max: 5, def: 3 }).error, "below min → error");
  ok(parseCap("abc", { min: 1, max: 5, def: 3 }).error, "non-numeric → error");
});

// WHY: the wizard's choices must translate to the EXACT fanout flags, or "Preview" would launch for
// real, "Save" wouldn't write a script, and the lead/term/cap/wave selections would be dropped.
test("buildFanArgs maps each action + the lead toggle to fanout flags", () => {
  eq(buildFanArgs({ term: "wt", cap: 2, wave: 1, lead: false, mode: "launch" }),
    ["--term", "wt", "--cap", "2", "--wave", "1"], "launch → no extra flag");
  eq(buildFanArgs({ term: "tmux", cap: 3, wave: 2, lead: true, mode: "dry" }),
    ["--term", "tmux", "--cap", "3", "--wave", "2", "--lead-claude", "--dry"], "lead + preview");
  eq(buildFanArgs({ term: "wt", cap: 1, wave: 1, lead: false, mode: "save", outName: "wave1.ps1" }),
    ["--term", "wt", "--cap", "1", "--wave", "1", "--out", "wave1.ps1"], "save → --out");
});

// WHY: a saved script must carry the right extension for the shell it targets, or running a .sh in
// PowerShell (or a .ps1 in bash) silently fails.
test("autoOutName picks ps1 for wt/warp and sh otherwise", () => {
  eq(autoOutName("wt", 1), "wave1.ps1", "wt → ps1");
  eq(autoOutName("warp", 2), "wave2.ps1", "warp → ps1");
  eq(autoOutName("tmux", 3), "wave3.sh", "tmux → sh");
  eq(autoOutName("print", 1), "wave1.sh", "print → sh");
});

// ── MCP brain: tool registry + comment-preserving mutations + integrity gate ────
const MCP_FIX = `meta:
  schema_version: 1
  program: TEST
  default_gate: npm test
pis:
  - id: auth          # the auth epic
    title: Auth
    status: active
    sprints:
      - id: s1
        title: Login
        status: complete
        invoke: auth-login
        prs: ["#1"]
      - id: s2
        title: Sessions
        status: active
        invoke: auth-sessions
        deps: [s1]
`;

// WHY: the registry is the contract Claude sees; a tool missing a name/description/inputSchema
// is invisible or uncallable, so the whole MCP surface must stay well-formed.
test("TOOLS registry is well-formed and includes the key read + mutate tools", () => {
  ok(Array.isArray(TOOLS) && TOOLS.length >= 9, "at least 9 tools");
  ok(TOOLS.every((t) => t.name && t.description && t.inputSchema && t.inputSchema.type === "object"), "each tool well-formed");
  for (const n of ["plan", "show", "validate", "add_sprint", "set_status", "prune"]) {
    ok(TOOLS.some((t) => t.name === n), `tool ${n} present`);
  }
});

// WHY: the entire reason to mutate via the Document API (not YAML.parse + re-dump) is to keep the
// human's comments. If add_sprint drops them, the roadmap's authored context is silently destroyed.
test("add_sprint appends the node AND preserves existing comments", () => {
  const doc = parseDocument(MCP_FIX);
  addSprint(doc, { pi: "auth", id: "s3", title: "Logout", invoke: "auth-logout", status: "next", deps: ["s2"] });
  const out = doc.toString();
  ok(out.includes("# the auth epic"), "inline comment survived the edit");
  ok(/invoke: auth-logout/.test(out), "new sprint serialized");
  const g = validateDocOrThrow(doc);
  eq(g.pis[0].sprints.length, 3, "three sprints now");
});

// WHY: the write gate exists so a bad edit never lands. A duplicate invoke key would make two
// slices answer the same /slice command; it must be rejected before the file is written.
test("validateDocOrThrow rejects a duplicate invoke key", () => {
  const doc = parseDocument(MCP_FIX);
  addSprint(doc, { pi: "auth", id: "s3", title: "Dup", invoke: "auth-login" });
  throws(() => validateDocOrThrow(doc), "corrupt", "duplicate invoke must be rejected");
});

// WHY: a cyclic dependency is un-runnable; an edit that introduces one must be refused, not written
// and discovered later when the scheduler chokes.
test("validateDocOrThrow rejects an edit that forms a dependency cycle", () => {
  const doc = parseDocument(MCP_FIX);
  setFields(doc, { invoke: "auth-login", fields: { deps: ["s2"] } }); // s1->s2 while s2->s1
  throws(() => validateDocOrThrow(doc), "cycle", "cycle must be rejected");
});

// WHY: set_status is the merge-time workhorse (flip to complete, record the PR). It must write all
// three fields, or the Recently-completed view and sessions-remaining rollup go wrong.
test("set_status records status + prs + completed_on", () => {
  const doc = parseDocument(MCP_FIX);
  setStatus(doc, { invoke: "auth-sessions", status: "complete", prs: ["#9"], completed_on: "2026-06-04" });
  const sp = doc.toJS().pis[0].sprints.find((s) => s.invoke === "auth-sessions");
  eq(sp.status, "complete", "status set");
  eq(sp.prs, ["#9"], "prs set");
  eq(sp.completed_on, "2026-06-04", "completed_on set");
});

// WHY: pruning is how the roadmap stays legible over time; scope='completed' must drop finished,
// undepended slices (and leave live ones), so the graph shrinks safely.
test("prune scope=completed removes finished slices and keeps live ones", () => {
  const doc = parseDocument(`meta: {schema_version: 1, program: T}
pis:
  - id: p
    title: P
    status: active
    sprints:
      - {id: s1, title: Done, status: complete, invoke: p-done, prs: ["#1"]}
      - {id: s2, title: Live, status: active, invoke: p-active}
`);
  const r = prune(doc, { scope: "completed" });
  eq(r.pruned, ["p-done"], "reported the pruned slice");
  const g = validateDocOrThrow(doc);
  ok(!g.pis[0].sprints.some((s) => s.invoke === "p-done"), "completed slice gone");
  ok(g.pis[0].sprints.some((s) => s.invoke === "p-active"), "live slice kept");
});

// WHY: the validate read tool is the agent's pre-flight; a clean roadmap must report ok=true so an
// agent can trust it before launching, and a real error must surface as ok=false.
test("readValidate reports ok on a clean graph", () => {
  const r = readValidate(parseDocument(MCP_FIX).toJS());
  ok(r.ok === true, "clean fixture validates");
  eq(r.errors.length, 0, "no errors");
});

// ── PR-watch monitor brain ──────────────────────────────────────────────────
const pr = (o) => ({
  number: o.n, title: o.t || "T", headRefName: o.b || "auth/s1",
  state: o.state || "OPEN", isDraft: !!o.draft, mergeStateStatus: o.merge || "CLEAN", checks: o.checks || "none",
});

// WHY: the monitor's whole value is telling the lead the moment a PR is actionable. If a newly
// opened, check-green PR isn't surfaced as "ready to merge", the lead is back to polling by hand.
test("diffPrStates announces a new ready PR and a draft->ready transition", () => {
  const newReady = diffPrStates({}, { 1: pr({ n: 1 }) });
  eq(newReady.length, 1, "one event for the new PR");
  ok(/ready to merge/.test(newReady[0].message), "phrased as ready to merge");
  const promoted = diffPrStates({ 1: pr({ n: 1, draft: true }) }, { 1: pr({ n: 1, draft: false }) });
  eq(promoted.length, 1, "draft->ready emits");
  ok(/ready to merge/.test(promoted[0].message), "ready message");
});

// WHY: noise kills a notifier. If an unchanged poll re-emits, the lead learns to ignore the
// channel; only genuine phase changes (here, open->merged) may speak.
test("diffPrStates is silent on no change and speaks on open->merged", () => {
  const same = { 1: pr({ n: 1 }) };
  eq(diffPrStates(same, same).length, 0, "no change, no event");
  const merged = diffPrStates({ 1: pr({ n: 1 }) }, { 1: pr({ n: 1, state: "MERGED" }) });
  eq(merged.length, 1, "merge emits");
  ok(/merged/.test(merged[0].message), "merged message");
});

// WHY: prPhase keys off the reduced `checks` value, so a wrong rollup->enum mapping would announce
// a PR with a failing or still-running check as "ready to merge" and mislead the lead into a bad merge.
test("checksOf reduces a statusCheckRollup to none/passing/pending/failing", () => {
  eq(checksOf({ statusCheckRollup: [] }), "none", "no checks -> none");
  eq(checksOf({ statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }] }), "passing", "all green -> passing");
  eq(checksOf({ statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }] }), "pending", "any in-progress -> pending");
  eq(checksOf({ statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }] }), "failing", "any failure -> failing");
});

// WHY: the lead must hear about ITS wave, not every PR in the repo. A branch outside the roadmap's
// fanout naming must be filtered out, or the channel fills with unrelated noise.
test("matchesRoadmapBranches keeps roadmap fanout branches and drops the rest", () => {
  const g = { meta: {}, pis: [{ id: "auth", title: "A", status: "active", sprints: [sp("s1", { invoke: "auth-login" })] }] };
  ok(matchesRoadmapBranches("auth/s1", g), "a roadmap branch matches");
  ok(!matchesRoadmapBranches("dependabot/npm/x", g), "an unrelated branch is dropped");
});

// ── reconcile detection (the agentic-sync trigger) ──────────────────────────
// WHY: a merged PR that isn't recorded leaves the roadmap stale (a slice shows open after it
// shipped). Detection must flag exactly the open slices whose branch merged, never re-flag a
// done slice (churn) or one without a merged PR (false positive that erodes trust in the nudge).
test("findUnrecordedMerges flags only open slices whose fanout branch merged", () => {
  const g = { meta: {}, pis: [{ id: "auth", title: "A", status: "active", sprints: [
    sp("s1", { status: "complete", invoke: "auth-login" }),
    sp("s2", { status: "active", invoke: "auth-sessions" }),
    sp("s3", { status: "active", invoke: "auth-logout" }),
  ]}]};
  const merged = [{ number: 42, headRefName: "auth/s2" }, { number: 7, headRefName: "auth/s1" }];
  const found = findUnrecordedMerges(g, merged);
  eq(found.map((u) => u.invoke), ["auth-sessions"], "only the open + merged slice (s1 done, s3 no PR)");
  eq(found[0].pr, 42, "carries the PR number");
  ok(reconcileNudge(found).includes("auth-sessions") && /set_status|slice-sync/.test(reconcileNudge(found)), "nudge names the slice + the action");
  eq(reconcileNudge([]), "", "silent when nothing is unrecorded");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
