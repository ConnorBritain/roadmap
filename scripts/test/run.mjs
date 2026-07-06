#!/usr/bin/env node
// roadmap — graph-brain test suite.
// Zero-dependency runner. Each test states WHY it matters (what breaks if it regresses),
// because this brain schedules concurrent sessions that commit/push — a wrong wave is a
// real-world collision, not a cosmetic bug. Run: node scripts/test/run.mjs  (or npm test).

import {
  flatten, detectCycle, computeWaves, execPlan, sessionsRemaining, resolveGate, isDone, readyNodes,
} from "../lib/graph.mjs";
import { nodeWeight, recommendConcurrency, probeDisk } from "../lib/recommend.mjs";
import { synthesizeBrief, branchFor, worktreeFor, baseRefOf, baseBranchOf, remoteOf, launchPrompt, agentCmdFor, DEFAULT_AGENT_CMD } from "../lib/brief.mjs";
import { route, classify, buildArgs, findRepoRoot, missingRoadmapHelp, expandShort, REL } from "../lib/cli-core.mjs";
import { launchDecision } from "../lib/fanout-core.mjs";
import { terminalChoices, moveSelection, parseCap, buildFanArgs, autoOutName } from "../lib/wizard-core.mjs";
import { TOOLS, addSprint, setStatus, setFields, bulkSet, prune, validateDocOrThrow, readValidate, serialize } from "../lib/mcp-core.mjs";
import { parseAssignments } from "../lib/cli-core.mjs";
import { diffPrStates, matchesRoadmapBranches, checksOf } from "../lib/pr-watch-core.mjs";
import { findUnrecordedMerges, reconcileNudge, underParallelizedWarnings } from "../lib/sync-core.mjs";
import {
  validateExecution, suggestedConcurrency, executionDirectiveLines, normalizeExecution,
  teamSize, filterByTrack, dirClusters, EXEC_MODES, EXEC_ROLES,
} from "../lib/execution.mjs";
import { renderMarkdown } from "../lib/render-core.mjs";
import { comparePriority, validatePriority, tierBadge, TIERS } from "../lib/priority.mjs";
import {
  validateBacklog, addItem, setItemFields, validateBacklogDocOrThrow, sortByPriority,
  openCount, renderBacklogMarkdown, backlogItemToNode, pickNext, BACKLOG_TOOLS, readBacklogList,
  performPromotion,
} from "../lib/backlog-core.mjs";
import { validateGraph } from "../lib/validate-core.mjs";
import { mutateRoadmap, mutateBacklog, mutateBoth } from "../lib/store.mjs";
import {
  normalizeLinearConfig, effectiveGranularity, linearState, checkPiOverrideAck,
  resolvePushState, pullStatusFor, priorityToLinear, LINEAR_TO_PRIORITY,
  issueDescription, machineFooter, buildPushPlan, buildPullProposals, validateLinearConfig,
} from "../lib/linear-core.mjs";
import { addPi } from "../lib/mcp-core.mjs";
import { runSync, readCursor } from "../linear.mjs";
import { parseDocument } from "yaml";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let passed = 0, failed = 0;
const pending = [];   // async tests settle before the summary (see the await at the bottom)
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // an async test that threw would otherwise count as a vacuous pass — await it
      pending.push(r.then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (e) => { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); },
      ));
      return;
    }
    passed++; console.log(`  ✓ ${name}`);
  }
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
  ok(reconcileNudge(found).includes("auth-sessions") && /set_status|sync/.test(reconcileNudge(found)), "nudge names the slice + the action");
  eq(reconcileNudge([]), "", "silent when nothing is unrecorded");
});

// ── serializer fidelity (diff-minimal mutations) ────────────────────────────
// WHY: mutations write via serialize(); if it pads flow collections or re-wraps long scalars, every
// edit churns the whole hand-authored roadmap and the diff becomes unreviewable. It must keep
// comments, leave long scalars on one line, and not pad flow collections.
test("serialize keeps comments, leaves long scalars unwrapped, and does not pad flow collections", () => {
  const long = "x".repeat(120);
  const doc = parseDocument(`# header\nk:\n  seq: ["#1", "#2"]   # inline\n  long: ${long}\n`);
  const out = serialize(doc);
  ok(out.includes("# header") && out.includes("# inline"), "comments preserved");
  ok(out.includes('["#1", "#2"]') && !out.includes('[ "#1"'), "flow seq stays unpadded");
  ok(out.includes(long), "120-char scalar not wrapped");
  // idempotent: re-serializing its own output is a no-op (so post-normalize mutations are clean)
  eq(serialize(parseDocument(out)), out, "serialize is idempotent");
});

// ── execution strategy hint: validation ─────────────────────────────────────
// WHY: the whole point is to let an author DECLARE staffing; a typo'd mode/role or an
// impossible count must be caught at validate time, not discovered when a launched session
// reads a nonsense directive. Enum + type + bounds are the contract.
test("validateExecution rejects a bad mode, a bad role, and non-positive ints", () => {
  ok(validateExecution({ mode: "swarm" }, "a/s1").errors.some((e) => /mode "swarm" invalid/.test(e)), "bad mode");
  ok(validateExecution({ team: [{ role: "wizard" }] }, "a/s1").errors.some((e) => /role "wizard" invalid/.test(e)), "bad role");
  ok(validateExecution({ concurrency: 0 }, "a/s1").errors.some((e) => /concurrency must be an integer/.test(e)), "concurrency 0");
  ok(validateExecution({ concurrency: 2.5 }, "a/s1").errors.some((e) => /concurrency must be an integer/.test(e)), "non-int concurrency");
  ok(validateExecution({ team: [{ role: "implementer", count: 0 }] }, "a/s1").errors.some((e) => /count must be an integer/.test(e)), "count 0");
  eq(EXEC_MODES, ["solo", "subagents", "dynamic-workflow", "agent-team"], "mode vocabulary");
  eq(EXEC_ROLES, ["verifier", "implementer", "reviewer", "researcher", "integrator"], "role vocabulary");
});

// WHY: min_concurrency is a FLOOR; if it could exceed the suggested live count the directive
// would demand more workers than the slice ever wants — an incoherent instruction.
test("validateExecution enforces min_concurrency ≤ concurrency", () => {
  ok(validateExecution({ concurrency: 3, min_concurrency: 5 }, "a/s1").errors.some((e) => /min_concurrency.*≤ concurrency/.test(e)), "floor above cap → error");
  eq(validateExecution({ concurrency: 5, min_concurrency: 4 }, "a/s1").errors.length, 0, "floor ≤ cap → ok");
});

// WHY: a team whose head-count disagrees with concurrency means one of the two numbers is wrong;
// the launched session can't tell which, so we refuse the ambiguity rather than mis-staff.
test("validateExecution flags team head-count inconsistent with concurrency, accepts a consistent one", () => {
  const bad = validateExecution({ concurrency: 5, team: [{ role: "implementer", count: 2 }, { role: "reviewer" }] }, "a/s1");
  ok(bad.errors.some((e) => /head-count \(3\) is inconsistent with concurrency \(5\)/.test(e)), "3 != 5 → error");
  const good = validateExecution({ concurrency: 5, team: [{ role: "verifier" }, { role: "implementer", count: 3 }, { role: "reviewer" }] }, "a/s1");
  eq(good.errors.length, 0, "1+3+1 == 5 → ok");
  // team WITHOUT a concurrency: no consistency check (nothing to be inconsistent with)
  eq(validateExecution({ team: [{ role: "implementer", count: 4 }] }, "a/s1").errors.length, 0, "team alone → no consistency error");
});

// WHY: backward compatibility is non-negotiable — a slice that omits the block (every existing
// roadmap) must validate with ZERO new errors, or this feature breaks every consuming repo.
test("validateExecution + validateGraph are no-ops when execution is absent (backward-compat)", () => {
  eq(validateExecution(undefined, "a/s1"), { errors: [], warnings: [] }, "absent → clean");
  eq(validateExecution(null, "a/s1"), { errors: [], warnings: [] }, "null → clean");
  const g = { meta: { schema_version: 1, program: "T" }, pis: [{ id: "a", title: "A", status: "active",
    sprints: [sp("s1", { status: "active", est_sessions: 1 })] }] };
  eq(validateGraph(g).errors.length, 0, "no execution block → graph validates");
});

// WHY: a valid block is the happy path the feature exists for; if a correct full block produced
// errors the author could never declare strategy at all.
test("validateGraph accepts a full, consistent execution block", () => {
  const g = { meta: { schema_version: 1, program: "T" }, pis: [{ id: "a", title: "A", status: "active",
    sprints: [sp("s1", { status: "active", est_sessions: 1, execution: {
      mode: "agent-team", concurrency: 5, min_concurrency: 4,
      team: [{ role: "verifier" }, { role: "implementer", count: 3 }, { role: "reviewer" }],
      rationale: "16 disjoint fault-class files; verifier-first; one reviewer reconciles.",
    } })] }] };
  eq(validateGraph(g).errors.length, 0, "full valid block validates clean");
});

// WHY: a solo slice with a team is contradictory authoring; warn (don't error) so the YAML still
// loads but the author sees the mistake.
test("validateExecution warns on a solo slice that declares a team", () => {
  ok(validateExecution({ mode: "solo", team: [{ role: "implementer" }] }, "a/s1").warnings.some((w) => /solo but a team/.test(w)), "solo + team → warning");
});

// ── suggested-floor computation ──────────────────────────────────────────────
// WHY: the suggested floor is the anti-under-parallelization HINT for slices that don't pin a
// count — it must equal the number of DISJOINT top-level dir clusters (shared dirs collapse),
// capped so a sprawling slice doesn't recommend an absurd worker count.
test("suggestedConcurrency counts distinct top-level dir clusters and caps at 6", () => {
  eq(dirClusters(["src/a.ts", "src/b.ts", "docs/x.md"]).size, 2, "shared dir collapses");
  eq(suggestedConcurrency({ touches: ["src/a.ts", "src/b.ts", "docs/x.md"] }), 2, "two disjoint clusters");
  eq(suggestedConcurrency({ touches: ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6", "g/7", "h/8"] }), 6, "capped at 6");
  eq(suggestedConcurrency({ touches: [] }), null, "no files → no suggestion");
  eq(suggestedConcurrency({}), null, "no touches → null");
});

// ── imperative directive rendering (one canonical block, reused verbatim) ─────
// WHY: agents under-parallelize by gut; for an agent-team slice the directive MUST name the count
// + composition AND explicitly tell the session to invoke Agent Teams (the env var) — anything
// vaguer and the session falls back to a lone subagent.
test("executionDirectiveLines emits an imperative agent-team directive with count, composition, floor, and the Agent Teams instruction", () => {
  const lines = executionDirectiveLines({ touches: ["a/x", "b/y"], execution: {
    mode: "agent-team", concurrency: 5, min_concurrency: 4,
    team: [{ role: "verifier" }, { role: "implementer", count: 3 }, { role: "reviewer" }],
    rationale: "16 disjoint fault-class files; verifier-first; one reviewer reconciles.",
  }});
  const text = lines.join("\n");
  ok(/▶ EXECUTION: agent-team — 5 workers \(1 verifier · 3 implementers · 1 reviewer\)\./.test(text), "headline names count + composition");
  ok(/DO NOT run solo or fewer than 4\./.test(text), "states the floor imperatively");
  ok(/Invoke Agent Teams now \(set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\)/.test(text), "instructs invoking Agent Teams");
  ok(/Rationale: 16 disjoint fault-class files/.test(text), "carries the rationale");
});

// WHY: each mode steers to a DIFFERENT mechanism; a subagents slice must point at the CLAUDE.md
// hand-off, a dynamic-workflow at an in-slice pipeline, and a solo slice must say plainly "no
// fan-out" so the session doesn't spin up workers it shouldn't.
test("executionDirectiveLines wording is mode-specific for subagents, dynamic-workflow, and solo", () => {
  const subs = executionDirectiveLines({ touches: ["a/x"], execution: { mode: "subagents", concurrency: 3, min_concurrency: 2 } }).join("\n");
  ok(/Spawn 3 background subagents per CLAUDE\.md § Subagent Hand-off/.test(subs), "subagents → CLAUDE.md hand-off");
  ok(/DO NOT run solo or fewer than 2\./.test(subs), "subagents floor");
  const dyn = executionDirectiveLines({ execution: { mode: "dynamic-workflow", concurrency: 2 } }).join("\n");
  ok(/in-slice pipeline — each step gates the next/.test(dyn), "dynamic-workflow → pipeline");
  const solo = executionDirectiveLines({ execution: { mode: "solo" } }).join("\n");
  ok(/▶ EXECUTION: solo — single agent, no fan-out\./.test(solo), "solo headline");
  ok(/Do not spawn workers/.test(solo), "solo forbids fan-out");
  ok(!/DO NOT run solo or fewer/.test(solo), "solo has no floor clause");
  // no execution block → no directive at all
  eq(executionDirectiveLines({ touches: ["a/x"] }), null, "absent block → null");
});

// WHY: derived count fallbacks must be sane — a team without an explicit concurrency should report
// its head-count as the worker count, so the directive isn't blank.
test("executionDirectiveLines derives the worker count from the team when concurrency is unset", () => {
  const lines = executionDirectiveLines({ execution: { mode: "agent-team", team: [{ role: "implementer", count: 4 }, { role: "reviewer" }] } }).join("\n");
  ok(/agent-team — 5 workers/.test(lines), "team head-count = 5 used as worker count");
  eq(teamSize([{ role: "implementer", count: 4 }, { role: "reviewer" }]), 5, "teamSize sums with default 1");
});

// ── render-core: directive in SLICES.md + the byte-identical backward-compat guarantee ──
const execRenderGraph = (execution) => ({
  meta: { schema_version: 1, program: "T" },
  pis: [{ id: "a", title: "A", status: "active", sprints: [
    { id: "s1", title: "Fan", status: "active", invoke: "fan-slice", what: "do it", est_sessions: 1,
      touches: ["a/x", "b/y"], read_order: ["docs/x.md"], ...(execution ? { execution } : {}) },
  ] }],
});

// WHY: the rendered SLICES.md is the human read-out; the directive must appear AT THE TOP of the
// slice's detail entry (before What) so a session staffs before it reads anything else.
test("renderMarkdown emits the execution directive at the top of a slice's detail read-out", () => {
  const md = renderMarkdown(execRenderGraph({ mode: "agent-team", concurrency: 2, min_concurrency: 2,
    team: [{ role: "implementer" }, { role: "reviewer" }] }));
  const detail = md.slice(md.indexOf("### `fan-slice`"));
  const dirIdx = detail.indexOf("▶ EXECUTION: agent-team");
  const whatIdx = detail.indexOf("**What:**");
  ok(dirIdx >= 0, "directive rendered in the detail entry");
  ok(dirIdx < whatIdx, "directive precedes What (top of the read-out)");
  ok(/> ▶ EXECUTION/.test(detail), "rendered as a blockquote callout");
});

// WHY: THE non-negotiable. A slice with no execution block must render EXACTLY as it did before the
// feature — no stray directive, no blank lines, nothing — or every existing SLICES.md churns.
test("renderMarkdown is byte-identical (no directive) when no execution block is present", () => {
  const md = renderMarkdown(execRenderGraph(null));
  ok(!md.includes("▶ EXECUTION"), "no directive marker anywhere");
  // the detail entry goes straight from the heading to What, as before
  const detail = md.slice(md.indexOf("### `fan-slice`"));
  ok(/### `fan-slice`\n- \*\*What:\*\*/.test(detail), "heading immediately followed by What, unchanged");
});

// ── kickoff brief carries the directive verbatim ─────────────────────────────
// WHY: a fanned-out session reads ONLY its .kickoff.md; for an agent-team slice the brief must
// carry the directive verbatim, or the worker never learns to invoke Agent Teams and runs solo.
test("synthesizeBrief carries the execution directive verbatim for an agent-team slice", () => {
  const g = { meta: { schema_version: 1, program: "T", default_gate: "npm test" }, pis: [{ id: "a", title: "A", status: "active",
    sprints: [sp("s1", { status: "active", invoke: "x", touches: ["a/p", "b/q"], execution: {
      mode: "agent-team", concurrency: 4, min_concurrency: 3, team: [{ role: "implementer", count: 3 }, { role: "reviewer" }],
    } })] }] };
  const b = synthesizeBrief(flatten(g).nodes[0], g);
  ok(/## 0\. Execution strategy/.test(b), "brief has the execution section first");
  ok(/▶ EXECUTION: agent-team — 4 workers/.test(b), "directive headline present");
  ok(/Invoke Agent Teams now \(set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\)/.test(b), "Agent Teams instruction present");
  // a slice WITHOUT a block gets no execution section (brief unchanged)
  const g2 = { meta: {}, pis: [{ id: "a", title: "A", status: "active", sprints: [sp("s1", { status: "active", invoke: "y" })] }] };
  ok(!synthesizeBrief(flatten(g2).nodes[0], g2).includes("## 0. Execution strategy"), "no block → no execution section");
});

// ── fanout --track lane filter ───────────────────────────────────────────────
// WHY: the three-track partition lets a person fan out only their lane; --track must keep exactly
// the matching slices (case-insensitive) and an unset filter must be a no-op (everyone's lanes).
test("filterByTrack keeps only the matching lane and is a no-op without a track", () => {
  const wave = [
    { invoke: "a", track: "A" }, { invoke: "b", track: "B" }, { invoke: "c", track: null }, { invoke: "d", track: "a" },
  ];
  eq(filterByTrack(wave, "A").map((n) => n.invoke), ["a", "d"], "track A (case-insensitive), untracked excluded");
  eq(filterByTrack(wave, null).map((n) => n.invoke), ["a", "b", "c", "d"], "no track → full wave");
  eq(filterByTrack(wave, "Z").length, 0, "no match → empty");
});

// ── post-run guardrail: under-parallelization warning for /sync ─────────
// WHY: the guardrail closes the loop — if a slice that declared a floor and touches disjoint dirs
// actually ran with fewer live workers, /sync must say so, or the under-parallelization the
// whole feature targets goes unnoticed run after run.
test("underParallelizedWarnings flags a disjoint slice that ran below its floor, and stays quiet otherwise", () => {
  const g = { meta: {}, pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { status: "complete", invoke: "wide", touches: ["a/x", "b/y", "c/z"], execution: { min_concurrency: 4 } }),
    sp("s2", { status: "complete", invoke: "okay", touches: ["a/x", "b/y"], execution: { min_concurrency: 2 } }),
    sp("s3", { status: "complete", invoke: "single", touches: ["a/x"], execution: { min_concurrency: 4 } }),
    sp("s4", { status: "complete", invoke: "noexec", touches: ["a/x", "b/y"] }),
  ]}]};
  const warns = underParallelizedWarnings(g, [
    { invoke: "wide", workers: 2 },     // disjoint + below floor → warn
    { invoke: "okay", workers: 2 },     // met its floor → quiet
    { invoke: "single", workers: 1 },   // below floor BUT only one cluster (couldn't parallelize) → quiet
    { invoke: "noexec", workers: 1 },   // no execution block → quiet
  ]);
  eq(warns.length, 1, "only the genuinely under-parallelized slice warns");
  ok(/slice wide ran 2 workers; min_concurrency 4 — under-parallelized/.test(warns[0]), "warning names the slice, the count, and the floor");
  eq(underParallelizedWarnings(g, []), [], "no telemetry → no warnings");
});

// ── priority: comparator + validation ────────────────────────────────────────
// WHY: comparePriority returning non-zero for two absent priorities would reorder every
// existing roadmap's waves — 0-when-both-absent IS the backward-compat guarantee.
test("comparePriority orders tier before weight and returns 0 when both absent", () => {
  eq(comparePriority(null, null), 0, "both absent → 0 (falls through to existing order)");
  eq(comparePriority(undefined, null), 0, "undefined/null equivalent");
  ok(comparePriority({ tier: "P0" }, { tier: "P1", weight: 100 }) < 0, "tier beats weight");
  ok(comparePriority({ tier: "P1", weight: 80 }, { tier: "P1", weight: 20 }) < 0, "same tier: higher weight first");
  ok(comparePriority({ tier: "P3" }, { weight: 100 }) < 0, "any tier beats tierless (absent tier ranks after P3)");
  ok(comparePriority({ weight: 10 }, null) < 0, "weight-only still outranks nothing");
  eq(tierBadge({ tier: "P2", weight: 5 }), "P2", "badge is the tier");
  eq(tierBadge({ weight: 5 }), null, "no tier → no badge");
  eq(TIERS.length, 4, "P0..P3");
});

// WHY: a typo'd tier or a weight of 500 must be a validation error, not a silently
// mis-sorted roadmap; and an absent block must validate clean or every old roadmap breaks.
test("validatePriority rejects bad tier / out-of-range weight; absent is clean", () => {
  eq(validatePriority(null, "x").errors, [], "absent → clean");
  eq(validatePriority({ tier: "P1", weight: 60, reason: "why" }, "x").errors, [], "full valid block");
  ok(validatePriority({ tier: "p1" }, "x").errors[0].includes("tier"), "lowercase tier rejected");
  ok(validatePriority({ weight: 500 }, "x").errors[0].includes("weight"), "weight > 100 rejected");
  ok(validatePriority({ weight: -1 }, "x").errors[0].includes("weight"), "negative weight rejected");
  ok(validatePriority("P0", "x").errors[0].includes("mapping"), "scalar rejected");
});

// WHY: priority exists to decide who gets a scarce cap slot. A P0 losing its slot to an
// alphabetically-earlier P2 means the urgent work waits a wave; and an unprioritized graph
// must produce today's identical waves or every existing roadmap reshuffles.
test("computeWaves packs higher-priority slices first under the cap, unchanged when none set", () => {
  const g = (withPriority) => ({ pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { invoke: "aardvark", touches: ["f1"] }),
    sp("s2", { invoke: "urgent", touches: ["f2"], ...(withPriority ? { priority: { tier: "P0" } } : {}) }),
    sp("s3", { invoke: "middling", touches: ["f3"] }),
  ]}]});
  const withP = computeWaves(flatten(g(true)), 1);
  eq(withP.waves[0].map((n) => n.invoke), ["urgent"], "P0 takes the single cap slot");
  const withoutP = computeWaves(flatten(g(false)), 1);
  eq(withoutP.waves[0].map((n) => n.invoke), ["aardvark"], "no priorities → existing (status/est/alpha) order");
});

// WHY: the tier badge is how a human scanning SLICES.md spots the urgent slice; and a
// priority-free graph must render byte-identically or every existing SLICES.md churns.
test("renderMarkdown shows tier badges only when priority is present", () => {
  const g = (priority) => ({
    meta: { schema_version: 1, program: "T" },
    pis: [{ id: "a", title: "A", status: "active", sprints: [
      { id: "s1", title: "Fan", status: "active", invoke: "fan-slice", what: "do it", est_sessions: 1,
        ...(priority ? { priority } : {}) },
    ] }],
  });
  const md = renderMarkdown(g({ tier: "P0", weight: 80, reason: "prod is down" }));
  ok(md.includes("**[P0]** `/slice fan-slice`"), "wave-map badge");
  ok(md.includes("· **P0** |"), "status-cell badge");
  ok(md.includes("- **Priority:** P0 · weight 80 — prod is down"), "detail line with reason");
  const plain = renderMarkdown(g(null));
  ok(!plain.includes("P0") && !plain.includes("**Priority:**"), "no priority → no badge or line anywhere");
});

// WHY: the stashed prompt is the whole point of prompt-in-slice pickup — the launched session
// must see the author's words unedited; and a prompt-free slice must produce a byte-identical
// brief or every existing .kickoff.md changes under diff review.
test("synthesizeBrief embeds prompt verbatim and is unchanged without it", () => {
  const g = (prompt) => ({ meta: { schema_version: 1, program: "T", default_gate: "npm test" },
    pis: [{ id: "a", title: "A", status: "active", sprints: [sp("s1", { status: "active", invoke: "x", ...(prompt ? { prompt } : {}) })] }] });
  const withPrompt = synthesizeBrief(flatten(g("Fix the wtSafe escaping.\nAdd a run.mjs case.")).nodes[0], g("x"));
  ok(/## 0\.5 Author instructions \(verbatim\)\nFix the wtSafe escaping\.\nAdd a run\.mjs case\./.test(withPrompt), "prompt carried verbatim in its own section");
  ok(withPrompt.indexOf("## 0.5") < withPrompt.indexOf("## 1. Scope"), "prompt section precedes Scope");
  const bare = synthesizeBrief(flatten(g(null)).nodes[0], g(null));
  ok(!bare.includes("## 0.5"), "no prompt → no section (brief unchanged)");
});

// WHY: prompt/kickoff_brief/priority must be updatable through the same allow-listed mutation
// path as every other field — that's the "update the init prompt as new info comes in" feature;
// and a corrupt priority must be caught by the pre-write gate, not written to disk.
test("setFields accepts prompt/kickoff_brief/priority and the pre-write gate rejects a bad priority", () => {
  const y = `meta:\n  schema_version: 1\n  program: T\npis:\n  - id: a\n    title: A\n    status: active\n    sprints:\n      - id: s1\n        title: S\n        status: active\n        invoke: x\n`;
  const doc = parseDocument(y);
  const r = setFields(doc, { invoke: "x", fields: { prompt: "do the thing", kickoff_brief: "custom brief", priority: { tier: "P1", weight: 40 } } });
  eq(r.fields, ["prompt", "kickoff_brief", "priority"], "all three fields settable");
  validateDocOrThrow(doc); // must not throw
  setFields(doc, { invoke: "x", fields: { priority: { tier: "NOPE" } } });
  throws(() => validateDocOrThrow(doc), "priority.tier", "bad tier caught before write");
});

// ── bulk_set: all-or-nothing multi-slice edit ────────────────────────────────
// WHY: bulk edits exist to retag/reprioritize many slices at once; if update 1 lands while
// update 2's bad field throws, the roadmap is left half-edited and no error explains which half.
test("bulkSet applies every update through one gate — a bad field aborts before any write", () => {
  const y = `meta:\n  schema_version: 1\n  program: T\npis:\n  - id: a\n    title: A\n    status: active\n    sprints:\n      - { id: s1, title: S1, status: active, invoke: one }\n      - { id: s2, title: S2, status: next, invoke: two }\n`;
  const doc = parseDocument(y);
  const r = bulkSet(doc, { updates: [
    { invoke: "one", fields: { track: "A", priority: { tier: "P1" } } },
    { invoke: "two", fields: { track: "A" } },
  ]});
  eq(r.updated, ["one", "two"], "both slices updated");
  validateDocOrThrow(doc);
  // a bad field ANYWHERE in the batch throws before the caller ever reaches serialize/write
  throws(() => bulkSet(parseDocument(y), { updates: [
    { invoke: "one", fields: { track: "B" } },
    { invoke: "two", fields: { nope: 1 } },
  ]}), 'field "nope" is not settable', "bad field in update 2 throws (caller writes nothing)");
  throws(() => bulkSet(parseDocument(y), { updates: [] }), "bulk_set requires", "empty updates rejected");
});

// WHY: `roadmap set gate=npm test -- --grep x=y` must keep everything after the FIRST '='
// as the value, and @file / null must reach set_fields with their special semantics intact.
test("parseAssignments splits on the first '=', marks @file, and passes null through", () => {
  const [a, b, c] = parseAssignments(["gate=npm test -- --grep x=y", "prompt=@notes.md", "track=null"]);
  eq(a, { field: "gate", raw: "npm test -- --grep x=y" }, "value keeps embedded '='");
  eq(b, { field: "prompt", fromFile: "notes.md" }, "@path marks read-from-file");
  eq(c, { field: "track", raw: "null" }, "null passes through raw (YAML.parse → delete)");
  throws(() => parseAssignments(["notanassignment"]), "expected field=value", "missing '=' rejected");
});

// ── backlog: validation + mutations ──────────────────────────────────────────
// WHY: a duplicate id makes grab/promote act on the wrong item; a typo'd kind/status silently
// buckets work out of the open view. Both must be hard errors before write.
test("validateBacklog rejects duplicate ids and bad kind/status; a full valid item passes", () => {
  const good = { meta: { schema_version: 1 }, items: [
    { id: "fix-x", title: "Fix X", kind: "bug", status: "open",
      priority: { tier: "P1", weight: 70, reason: "breaks fanout" },
      source: { slice: "auth-sessions", date: "2026-07-06" }, refs: ["auth-sessions"],
      touches: ["src/x.ts"], est_sessions: 0.5, gate: "default", prompt: "repro then fix" },
  ]};
  eq(validateBacklog(good).errors, [], "full item validates clean");
  ok(validateBacklog({ meta: { schema_version: 1 }, items: [
    { id: "a", title: "A", kind: "bug", status: "open" }, { id: "a", title: "B", kind: "bug", status: "open" },
  ]}).errors[0].includes("duplicate"), "duplicate id rejected");
  ok(validateBacklog({ meta: { schema_version: 1 }, items: [{ id: "a", title: "A", kind: "task", status: "open" }] })
    .errors[0].includes("kind"), "bad kind rejected");
  ok(validateBacklog({ meta: { schema_version: 1 }, items: [{ id: "a", title: "A", kind: "bug", status: "started" }] })
    .errors[0].includes("status"), "bad status rejected");
  ok(validateBacklog({ meta: {}, items: [] }).errors[0].includes("schema_version"), "missing schema_version rejected");
  const w = validateBacklog({ meta: { schema_version: 1 }, items: [{ id: "a", title: "A", kind: "bug", status: "promoted" }] });
  ok(w.warnings[0].includes("promoted_to"), "promoted without back-link warns");
});

// WHY: auto-ids must never collide with existing captures (a reused id silently merges two
// items' histories), and comment preservation is the whole reason mutations use the Document API.
test("addItem auto-generates the next bN id and preserves comments; setItemFields honors the allow-list", () => {
  const y = `meta:\n  schema_version: 1\nitems:\n  # keep this comment\n  - { id: b3, title: Old, kind: chore, status: open }\n`;
  const doc = parseDocument(y);
  const r = addItem(doc, { title: "New thing", kind: "bug" });
  eq(r.added, "b4", "next free bN after b3");
  validateBacklogDocOrThrow(doc);
  ok(doc.toString().includes("# keep this comment"), "comment survives the edit");
  throws(() => addItem(doc, { title: "dup", id: "b3" }), "already exists", "explicit dup id rejected");
  const s = setItemFields(doc, { id: "b4", fields: { status: "in_progress", priority: { tier: "P0" }, prompt: "go" } });
  eq(s.fields, ["status", "priority", "prompt"], "allowed fields set");
  throws(() => setItemFields(doc, { id: "b4", fields: { id: "sneaky" } }), "not settable", "id is immutable");
  setItemFields(doc, { id: "b4", fields: { status: "nope" } });
  throws(() => validateBacklogDocOrThrow(doc), "status", "pre-write gate catches a bad status");
});

// WHY: BACKLOG.md is the human triage view — items must group by tier with untriaged last,
// or a P0 buried under untriaged noise never gets picked up.
test("renderBacklogMarkdown groups open items by tier (untriaged last) and lists closed/promoted separately", () => {
  const md = renderBacklogMarkdown({ meta: { schema_version: 1 }, items: [
    { id: "n1", title: "No tier", kind: "idea", status: "open" },
    { id: "p0", title: "Urgent", kind: "urgent", status: "open", priority: { tier: "P0", weight: 90, reason: "prod" } },
    { id: "p2", title: "Later", kind: "chore", status: "open", priority: { tier: "P2" } },
    { id: "pr", title: "Moved", kind: "followup", status: "promoted", promoted_to: "auth/s9" },
    { id: "dn", title: "Done", kind: "bug", status: "done", prs: ["#12"], completed_on: "2026-07-01" },
  ]});
  const iP0 = md.indexOf("## P0"), iP2 = md.indexOf("## P2"), iUn = md.indexOf("## Untriaged");
  ok(iP0 >= 0 && iP2 > iP0 && iUn > iP2, "tier sections in order, untriaged last");
  ok(md.includes("3 open item(s)"), "open count in the header");
  ok(md.includes("`auth/s9`"), "promoted back-link shown");
  ok(md.includes("| `dn` | Done | done | #12 | 2026-07-01 |"), "closed row with PR + date");
  ok(md.includes("_(prod)_"), "priority reason surfaces in the row");
});

// WHY: grab reuses the fanout machinery via this adapter — a wrong branch/worktree shape
// would collide a backlog session with a sprint worktree or break synthesizeBrief.
test("backlogItemToNode yields branch backlog/<id>, worktree <root>/backlog-<id>, and a brief-ready node", () => {
  const item = { id: "fix-y", title: "Fix Y", kind: "bug", status: "open", touches: ["src/y.ts"],
    prompt: "do it carefully", gate: "default", source: { note: "start from the failing test" } };
  const node = backlogItemToNode(item);
  const g = { meta: { schema_version: 1, program: "T", default_gate: "npm test", worktree_root: "/wt" } };
  eq(branchFor(node, g), "backlog/fix-y", "branch under the backlog/ namespace");
  eq(worktreeFor(node, g), "/wt/backlog-fix-y", "worktree beside the sprint worktrees");
  const brief = synthesizeBrief(node, g);
  ok(brief.includes("## 0.5 Author instructions (verbatim)\ndo it carefully"), "item prompt embedded");
  ok(brief.includes("npm test"), "default gate inherited from the roadmap");
  ok(brief.includes("start from the failing test"), "source note becomes the next action");
});

// WHY: `roadmap next` is the pickup entry point — it must pick the highest priority across
// BOTH trackers, let the roadmap win ties (planned work outranks erratic work), and return
// null (not crash) when there's nothing to do.
test("pickNext picks the highest-priority ready thing across roadmap + backlog; roadmap wins ties", () => {
  const g = { pis: [{ id: "a", title: "A", status: "active", sprints: [
    sp("s1", { invoke: "planned", priority: { tier: "P1" } }),
  ]}]};
  const backlog = (tier) => ({ meta: { schema_version: 1 }, items: [
    { id: "err", title: "Erratic", kind: "urgent", status: "open", ...(tier ? { priority: { tier } } : {}) },
  ]});
  eq(pickNext(g, backlog("P0")).type, "backlog", "P0 backlog beats P1 slice");
  eq(pickNext(g, backlog("P1")).type, "slice", "tie → roadmap wins");
  eq(pickNext(g, backlog(null)).type, "slice", "untriaged backlog loses to a prioritized slice");
  eq(pickNext(g, null).type, "slice", "no backlog file → roadmap only");
  eq(pickNext({ pis: [] }, backlog("P2")).type, "backlog", "empty roadmap → backlog");
  eq(pickNext({ pis: [] }, null), null, "nothing anywhere → null");
});

// WHY: equal-priority items must keep capture order (stable sort) or triage lists reshuffle
// on every render; and backlog_list must not explode when no backlog.yaml exists yet.
test("sortByPriority is stable for equal priorities; readBacklogList handles a missing backlog", () => {
  const items = [{ id: "first" }, { id: "second" }, { id: "third", priority: { tier: "P0" } }];
  eq(sortByPriority(items).map((i) => i.id), ["third", "first", "second"], "P0 first, capture order preserved");
  ok(readBacklogList(null).note.includes("backlog_add"), "missing file → friendly note, not a throw");
  const l = readBacklogList({ meta: { schema_version: 1 }, items: [
    { id: "a", title: "A", kind: "bug", status: "open" }, { id: "b", title: "B", kind: "bug", status: "done" },
  ]});
  eq(l.items.length, 1, "default list = open only");
  eq(openCount({ items: [{ status: "open" }, { status: "in_progress" }, { status: "done" }] }), 2, "open = open + in_progress");
});

// WHY: the SLICES.md pointer is how a roadmap reader discovers the backlog exists — but a
// backlog-free repo must render byte-identically (the render backward-compat guarantee).
test("renderMarkdown emits the backlog pointer only when opts.backlog is given", () => {
  const g = { meta: { schema_version: 1, program: "T" }, pis: [{ id: "a", title: "A", status: "active", sprints: [
    { id: "s1", title: "S", status: "active", invoke: "x", what: "w" }] }] };
  ok(renderMarkdown(g, { backlog: { open: 4 } }).includes("**Backlog:** 4 open item(s)"), "pointer with count");
  ok(!renderMarkdown(g).includes("**Backlog:**"), "no opts → no pointer line");
});

// ── promote: backlog item → roadmap sprint ────────────────────────────────────
// WHY: promote spans two files — a promoted sprint that drops the prompt/priority loses the
// author's context, and a missing back-link orphans the item's history. Both must carry.
test("performPromotion creates a scheduled sprint carrying prompt/priority/touches and back-links promoted_to", () => {
  const rDoc = parseDocument(`meta:\n  schema_version: 1\n  program: T\npis:\n  - id: auth\n    title: Auth\n    status: active\n    sprints:\n      - { id: s2, title: Old, status: complete, invoke: old }\n`);
  const bDoc = parseDocument(`meta:\n  schema_version: 1\nitems:\n  - id: fix-x\n    title: Fix X\n    kind: bug\n    status: open\n    priority: { tier: P1, weight: 70 }\n    touches: [src/x.ts]\n    est_sessions: 0.5\n    prompt: repro then fix\n`);
  const r = performPromotion(rDoc, bDoc, { id: "fix-x", pi: "auth" });
  eq(r, { promoted: "fix-x", to: "auth/s3" }, "auto sprint id = next free sN");
  validateDocOrThrow(rDoc);
  validateBacklogDocOrThrow(bDoc);
  const sp3 = rDoc.toJS().pis[0].sprints[1];
  eq(sp3.invoke, "fix-x", "item id becomes the invoke key");
  eq(sp3.status, "scheduled", "lands scheduled, not active");
  eq(sp3.prompt, "repro then fix", "prompt carries");
  eq(sp3.priority.tier, "P1", "priority carries");
  eq(sp3.touches, ["src/x.ts"], "touches carry");
  const item = bDoc.toJS().items[0];
  eq(item.status, "promoted", "item marked promoted");
  eq(item.promoted_to, "auth/s3", "back-link recorded");
});

// WHY: the item id becomes the invoke key — a collision with an existing slice would make
// /slice ambiguous; the pre-write gate must reject it so neither file is written.
test("performPromotion is rejected by the pre-write gate when the item id collides with an existing invoke", () => {
  const rDoc = parseDocument(`meta:\n  schema_version: 1\n  program: T\npis:\n  - id: auth\n    title: Auth\n    status: active\n    sprints:\n      - { id: s1, title: A, status: active, invoke: fix-x }\n`);
  const bDoc = parseDocument(`meta:\n  schema_version: 1\nitems:\n  - { id: fix-x, title: Fix X, kind: bug, status: open }\n`);
  performPromotion(rDoc, bDoc, { id: "fix-x", pi: "auth" });
  throws(() => validateDocOrThrow(rDoc), "duplicate invoke", "gate rejects the collision (mutateBoth writes nothing)");
  throws(() => performPromotion(parseDocument("meta:\n  schema_version: 1\nitems: []"), bDoc, { id: "nope", pi: "auth" }),
    "no backlog item", "unknown item rejected");
  const doneB = parseDocument(`meta:\n  schema_version: 1\nitems:\n  - { id: d1, title: D, kind: bug, status: done }\n`);
  throws(() => performPromotion(rDoc, doneB, { id: "d1", pi: "auth" }), "only open/in_progress", "closed items don't promote");
});

// WHY: the MCP registry is the agent-facing contract — every backlog tool must be listed
// with a schema or agents can't call it, and the combined registry must stay well-formed.
test("BACKLOG_TOOLS registry is well-formed and covers list/add/set/promote", () => {
  const names = BACKLOG_TOOLS.map((t) => t.name);
  eq(names, ["backlog_list", "backlog_add", "backlog_set", "backlog_promote"], "all four tools");
  for (const t of BACKLOG_TOOLS) {
    ok(t.description && t.inputSchema && t.inputSchema.type === "object", `${t.name} has description + object schema`);
  }
  const combined = [...TOOLS.map((t) => t.name), ...names];
  eq(new Set(combined).size, combined.length, "no name collisions with the roadmap tools");
  ok(combined.length >= 14, "14+ tools after the expansion");
});

// ── disk ceiling ──────────────────────────────────────────────────────────────
// WHY: a fanout that exceeds free disk fails mid-checkout with worktrees half-created.
// The ceiling must bind when it's the smallest, report cap 0 as the hard-block signal
// (while recommended stays >= 1 for the soft path), and vanish entirely when unprobeable.
test("disk is a fifth ceiling: binds when smallest, cap 0 signals hard-block, null skips it", () => {
  const bigSys = { sys: { cores: 64, totalGb: 256, freeGb: 256, platform: "linux" }, reviewCeiling: 50 };
  const bound = recommendConcurrency(recoReady, recoGraph, { ...bigSys, disk: { perWorktreeGb: 2, freeGb: 6 } });
  eq(bound.recommended, 2, "floor((6-2 reserve)/2) = 2 binds");
  ok(bound.binding.why.startsWith("disk"), "bound by disk");
  ok(/need ~2\.0GB\/worktree, 6\.0GB free/.test(bound.binding.why), "why names the numbers");
  eq(bound.disk.cap, 2, "cap surfaced for callers");
  const full = recommendConcurrency(recoReady, recoGraph, { ...bigSys, disk: { perWorktreeGb: 5, freeGb: 3 } });
  eq(full.disk.cap, 0, "cap 0 = even one worktree won't fit (the hard-block signal)");
  eq(full.recommended, 1, "recommended stays >= 1 — hard-blocking is the launcher's job");
  const skipped = recommendConcurrency(recoReady, recoGraph, { ...bigSys, disk: null });
  eq(skipped.candidates.length, 4, "no disk → four ceilings, unchanged");
  eq(skipped.disk, null, "no disk info surfaced");
});

// WHY: meta.worktree_gb is the calibration knob for repos whose gates install per-worktree —
// when set it must win over the ls-tree estimate; and probeDisk must degrade to null (never
// throw) so an unprobeable environment just loses the ceiling, not the whole plan.
test("probeDisk honors the meta.worktree_gb override and never throws", () => {
  const probed = probeDisk({ meta: { worktree_gb: 2.5 } });
  if (probed) {
    eq(probed.perWorktreeGb, 2.5, "explicit worktree_gb wins over the estimate");
    ok(probed.freeGb > 0, "free space detected");
  }
  // no-git cwd → estimate path fails → null, not a throw
  eq(probeDisk({ meta: {} }, "/nonexistent-dir-for-roadmap-test"), null, "unprobeable → null");
});

// ── store.mjs: the file-write-ordering / rollback guarantees (fs-backed) ──────
// WHY: store.mjs is the one place with data-loss blast radius — every mutating surface
// routes through it. If a thrown validation still wrote a file, or promote wrote one file
// of two, the "validate before write" contract is a lie the unit tests above can't catch.
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "roadmap-store-test-"));
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"),
    `meta:\n  schema_version: 1\n  program: T\npis:\n  - id: a\n    title: A\n    status: active\n    sprints:\n      - { id: s1, title: S, status: active, invoke: taken }\n`, "utf8");
  return root;
}

test("mutateRoadmap leaves roadmap.yaml byte-identical when the mutation or gate throws", () => {
  const root = tempRepo();
  const yamlPath = join(root, "docs", "roadmap", "roadmap.yaml");
  const before = readFileSync(yamlPath, "utf8");
  throws(() => mutateRoadmap(root, () => { throw new Error("boom"); }), "boom", "fn throw propagates");
  eq(readFileSync(yamlPath, "utf8"), before, "fn throw → file untouched");
  throws(() => mutateRoadmap(root, (doc) => setFields(doc, { invoke: "taken", fields: { priority: { tier: "NOPE" } } })),
    "priority.tier", "pre-write gate throw propagates");
  eq(readFileSync(yamlPath, "utf8"), before, "gate throw → file untouched, no SLICES rendered");
  ok(!existsSync(join(root, "docs", "SLICES.md")), "no SLICES.md written on failure");
  rmSync(root, { recursive: true, force: true });
});

test("mutateBoth writes NEITHER file when the second validation throws (promote collision)", () => {
  const root = tempRepo();
  const rPath = join(root, "docs", "roadmap", "roadmap.yaml");
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  // an item whose id collides with the existing invoke "taken" → roadmap gate rejects
  writeFileSync(bPath, `meta:\n  schema_version: 1\nitems:\n  - { id: taken, title: Collides, kind: bug, status: open }\n`, "utf8");
  const rBefore = readFileSync(rPath, "utf8");
  const bBefore = readFileSync(bPath, "utf8");
  throws(() => mutateBoth(root, (rDoc, bDoc) => performPromotion(rDoc, bDoc, { id: "taken", pi: "a" })),
    "duplicate invoke", "collision rejected");
  eq(readFileSync(rPath, "utf8"), rBefore, "roadmap.yaml untouched");
  eq(readFileSync(bPath, "utf8"), bBefore, "backlog.yaml untouched (validated-both-before-either held)");
  // and the success path writes both + both renders
  const r = mutateBoth(root, (rDoc, bDoc) => {
    addItem(bDoc, { title: "ok item", id: "okid", kind: "chore" });
    return performPromotion(rDoc, bDoc, { id: "okid", pi: "a" });
  });
  eq(r.to, "a/s2", "promoted into the next free sprint id");
  ok(readFileSync(rPath, "utf8").includes("okid"), "roadmap gained the sprint");
  ok(existsSync(join(root, "docs", "BACKLOG.md")) && existsSync(join(root, "docs", "SLICES.md")), "both views rendered");
  rmSync(root, { recursive: true, force: true });
});

test("mutateBacklog createIfMissing bootstraps a block-style backlog.yaml and the SLICES pointer", () => {
  const root = tempRepo();
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  throws(() => mutateBacklog(root, (doc) => addItem(doc, { title: "x" })), "no docs/roadmap/backlog.yaml",
    "without createIfMissing a missing file is an error, not a silent create");
  const r = mutateBacklog(root, (doc) => addItem(doc, { title: "first capture", kind: "bug" }), { createIfMissing: true });
  eq(r.added, "b1", "auto-id from an empty file");
  const src = readFileSync(bPath, "utf8");
  ok(/items:\n  - id: b1/.test(src), "block style from birth (not flow)");
  ok(readFileSync(join(root, "docs", "SLICES.md"), "utf8").includes("**Backlog:** 1 open item(s)"),
    "backlog mutation refreshes the SLICES.md open-count pointer");
  rmSync(root, { recursive: true, force: true });
});

// ── meta.agent_cmd launch template ────────────────────────────────────────────
// WHY: the default template MUST reproduce today's claude command byte-for-byte, or every
// existing roadmap's fanout launches change under people's feet; and a custom template must
// substitute both tokens or a codex user launches with a literal "{prompt}".
test("agentCmdFor default byte-equals the current claude command; custom template substitutes both tokens", () => {
  const bare = { meta: {} };
  eq(agentCmdFor(bare, { prompt: "do the thing", mode: "plan" }),
    `claude --permission-mode plan "do the thing"`, "default, double-quoted (bash/wt sites)");
  eq(agentCmdFor(bare, { prompt: "do the thing", mode: "acceptEdits", quote: "'" }),
    `claude --permission-mode acceptEdits 'do the thing'`, "default, single-quoted (pwsh sites)");
  eq(agentCmdFor({ meta: {} }, { prompt: "p", mode: "plan" }), DEFAULT_AGENT_CMD.replace("{mode}", "plan").replace("{prompt}", '"p"'), "exported default is the template in use");
  const codex = { meta: { agent_cmd: "codex exec --sandbox {mode} {prompt}" } };
  eq(agentCmdFor(codex, { prompt: "go", mode: "plan", quote: "'" }),
    `codex exec --sandbox plan 'go'`, "custom agent template substitutes mode + quoted prompt");
});

// ── linear-core: detection + config + backward compat ────────────────────────
const L_STATES = [
  { id: "st-b", name: "Backlog", type: "backlog", position: 0 },
  { id: "st-u", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-s", name: "In Progress", type: "started", position: 2 },
  { id: "st-s2", name: "Blocked", type: "started", position: 3 },
  { id: "st-c", name: "Done", type: "completed", position: 4 },
  { id: "st-x", name: "Canceled", type: "canceled", position: 5 },
];
const L_CFG = normalizeLinearConfig({ linear: { team: "ENG" } });

// WHY: a repo without meta.linear must behave byte-identically to v0.2 — a Linear feature
// that leaks into unconfigured repos (a probe, a branch change, a render diff) breaks everyone.
test("linear off by default: no config → null, unauthed state, branchFor untouched without the token", () => {
  eq(normalizeLinearConfig({}), null, "no meta.linear → null (all behavior off)");
  eq(normalizeLinearConfig({ linear: { granularity: "pis" } }), null, "teamless block → still off");
  const st = linearState({ meta: {}, env: {} });
  eq([st.configured, st.authed, st.lastSync], [false, false, null], "unconfigured + unauthed");
  const wired = linearState({ meta: { linear: { team: "ENG" } }, env: { LINEAR_API_KEY: "k" }, cursor: { lastSync: "2026-07-01" } });
  eq([wired.configured, wired.authed, wired.lastSync], [true, true, "2026-07-01"], "wired state");
  // a node WITH a linear id but a convention WITHOUT the token → branch byte-identical
  const g = { meta: {} };
  eq(branchFor({ piId: "a", id: "s1", linear: "ABC-123" }, g), "a/s1", "no {linear} token → unchanged");
});

// WHY: a wrong state mapping silently mis-files work on the team's board — the type
// defaults must hold, a name override must win, and an unresolvable name must fail loudly
// naming what IS available (not push to a random state).
test("resolvePushState maps by type, honors status_map by name, and errors naming available states", () => {
  eq(resolvePushState("scheduled", L_CFG, L_STATES).id, "st-b", "scheduled → backlog type");
  eq(resolvePushState("active", L_CFG, L_STATES).id, "st-s", "active → first started state");
  eq(resolvePushState("blocked", L_CFG, L_STATES).id, "st-s", "blocked stays started (roadmap is the richer truth)");
  eq(resolvePushState("complete", L_CFG, L_STATES).id, "st-c", "complete → completed");
  const mapped = normalizeLinearConfig({ linear: { team: "ENG", status_map: { blocked: "Blocked" } } });
  eq(resolvePushState("blocked", mapped, L_STATES).id, "st-s2", "status_map name override wins");
  const bad = normalizeLinearConfig({ linear: { team: "ENG", status_map: { active: "Doing" } } });
  throws(() => resolvePushState("active", bad, L_STATES), "available: Backlog, Todo", "unresolvable name lists the real states");
  eq(pullStatusFor("unstarted"), "next", "pull inverse");
  eq(priorityToLinear({ tier: "P0" }), 1, "P0 → Urgent(1)");
  eq(priorityToLinear(null), 0, "no priority → 0");
  eq(LINEAR_TO_PRIORITY[4], "P3", "Low(4) → P3");
});

// WHY: the footer is the machine contract any agent dispatched from Linear parses to
// orient; and copying read-order/prompt into Linear is exactly the duplication this
// integration promises not to create.
test("issueDescription: verbosity levers, footer always last, prompt/read-order never leak", () => {
  const node = { invoke: "auth-sessions", title: "Session tokens", what: "Wire JWT refresh",
    gate: "default", estSessions: 3, priority: { tier: "P1", weight: 60, reason: "launch blocker" },
    prompt: "SECRET-INSTRUCTIONS", readOrder: ["docs/auth.md"], linear: null };
  const brief = issueDescription(node, L_CFG, { docsUrl: "https://github.com/x/y/blob/main" });
  ok(brief.endsWith(machineFooter({ type: "slice", key: "auth-sessions" }, "https://github.com/x/y/blob/main")), "footer last");
  ok(brief.includes("Wire JWT refresh") && brief.includes("Est: ~3"), "brief carries what + est");
  ok(!brief.includes("SECRET-INSTRUCTIONS") && !brief.includes("docs/auth.md"), "prompt/read-order never leak");
  ok(!brief.includes("launch blocker"), "brief verbosity omits the priority reason");
  const titleOnly = issueDescription(node, normalizeLinearConfig({ linear: { team: "ENG", verbosity: "title" } }), {});
  eq(titleOnly, machineFooter({ type: "slice", key: "auth-sessions" }, null), "title verbosity = footer only");
  const full = issueDescription(node, normalizeLinearConfig({ linear: { team: "ENG", verbosity: "full" } }), {});
  ok(full.includes("P1 · weight 60 — launch blocker"), "full verbosity carries the priority reason");
  ok(machineFooter({ type: "backlog", key: "b7" }, null).includes("roadmap grab b7"), "backlog footer says grab");
});

// ── linear-core: push plan ────────────────────────────────────────────────────
const pushGraph = (over = {}) => ({
  meta: { schema_version: 1, program: "T", linear: { team: "ENG", ...over } },
  pis: [
    { id: "auth", title: "Authentication", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s1", title: "Login", status: "active", invoke: "auth-login", linear: "ENG-1" },
      { id: "s2", title: "Tokens", status: "scheduled", invoke: "auth-tokens" },
      { id: "s3", title: "Old", status: "complete", invoke: "auth-old" },
    ]},
  ],
});
const SNAP = (loginOverrides = {}) => ({
  projects: { "proj-1": { id: "proj-1", name: "Authentication" } },
  issues: { "ENG-1": { id: "uuid-1", title: "Login",
    description: issueDescription({ invoke: "auth-login", title: "Login", what: "Login", gate: "default", estSessions: null, priority: null }, L_CFG, { target: { type: "slice", key: "auth-login" } }),
    priority: 0, stateId: "st-s", ...loginOverrides } },
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

// ── linear-core: pull proposals ───────────────────────────────────────────────
// WHY: pull must not re-import the same issue forever (double captures) and inbound edits
// must be PROPOSALS, never silent mutations — the human confirms what enters the graph.
test("buildPullProposals dedupes known identifiers, captures watch issues with source demarcation, proposes deltas", () => {
  const cfg = normalizeLinearConfig({ linear: { team: "ENG", pull: "propose",
    watch: [{ team: "PUB", project: "Submit an issue", kind: "bug", priority: { tier: "P3" } }] } });
  const graph = pushGraph();
  const backlog = { meta: { schema_version: 1 }, items: [{ id: "pub-9", title: "Known", kind: "bug", status: "open", linear: "PUB-9" }] };
  const inbound = [
    { identifier: "PUB-9", title: "Known", priority: 0, state: { type: "backlog" }, team: "PUB", project: "Submit an issue" },   // known item, state backlog→scheduled? (item: no delta for open)
    { identifier: "PUB-42", title: "Crash on empty config", priority: 1, state: { type: "backlog" }, team: "PUB", project: "Submit an issue" },
    { identifier: "PUB-43", title: "Watched but off-project", priority: 0, state: { type: "backlog" }, team: "PUB", project: "Other" },
    { identifier: "ENG-1", title: "Login", priority: 2, state: { type: "completed" }, team: "ENG", project: null },
  ];
  const { newItems, deltas } = buildPullProposals({ cfg, inbound, graph, backlog });
  eq(newItems.length, 1, "known + off-watch identifiers skipped; one genuine capture");
  const it = newItems[0];
  eq(it.id, "pub-42", "stable id = lowercased identifier (the cross-machine dedupe key)");
  eq(it.source.linear, { team: "PUB", project: "Submit an issue", issue: "PUB-42" }, "origin demarcation carried");
  eq(it.priority, { tier: "P0" }, "the issue's own Urgent(1) outranks the watch default P3");
  eq(it.kind, "bug", "watch default kind applied");
  const statusDelta = deltas.find((d) => d.key === "auth-login" && d.field === "status");
  eq([statusDelta.from, statusDelta.to], ["active", "complete"], "mapped-issue completion is a PROPOSAL, not a mutation");
  const priDelta = deltas.find((d) => d.key === "auth-login" && d.field === "priority.tier");
  eq([priDelta.from, priDelta.to], [null, "P1"], "priority edit proposed");
});

// WHY: validate is the only net for hand-edited YAML — bad enums and non-string ids must
// error, and a stored PI override must at least warn so the mismatch is never invisible.
test("validateLinearConfig: enum/team errors, PI-mismatch warning, non-string sprint linear", () => {
  ok(validateLinearConfig({ meta: {}, pis: [] }).errors.length === 0, "absent → clean");
  ok(validateLinearConfig({ meta: { linear: { granularity: "slices" } }, pis: [] }).errors[0].includes("team is required"), "teamless errors");
  ok(validateLinearConfig({ meta: { linear: { team: "E", pull: "always" } }, pis: [] }).errors[0].includes("pull"), "bad enum errors");
  ok(validateLinearConfig({ meta: { linear: { team: "E", watch: [{ project: "X" }] } }, pis: [] }).errors[0].includes("needs a team"), "watch without team errors");
  const g = { meta: { linear: { team: "E", granularity: "slices" } }, pis: [
    { id: "p", title: "P", status: "active", linear: { granularity: "pis" }, sprints: [{ id: "s1", title: "S", status: "active", invoke: "x", linear: 123 }] },
  ]};
  const r = validateLinearConfig(g);
  ok(r.warnings.some((w) => w.includes("per-PI override in effect")), "stored mismatch warns");
  ok(r.errors.some((e) => e.includes("must be a string issue identifier")), "non-string sprint linear errors");
});

// WHY: a malformed {linear} branch breaks worktree creation mid-fanout — the token must
// produce a Linear-autolinkable branch with an id and degrade cleanly without one.
test("branchFor {linear} token: autolinkable with an id, clean without", () => {
  const g = { meta: { branch_convention: "{pi}/{linear}-{sprint}" } };
  eq(branchFor({ piId: "platform", id: "s1", linear: "ABC-123" }, g), "platform/abc-123-s1", "id lowercased into the branch");
  eq(branchFor({ piId: "platform", id: "s1", linear: null }, g), "platform/s1", "no id → no residue");
});

// ── linear.mjs: mocked-transport sync (never hits the network) ────────────────
function linearRepo() {
  const root = mkdtempSync(join(tmpdir(), "roadmap-linear-test-"));
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"),
    `meta:\n  schema_version: 1\n  program: T\n  linear:\n    team: ENG\n    pull: propose\n    watch:\n      - { team: PUB, project: Submit an issue, kind: bug, priority: {tier: P3} }\npis:\n  - id: auth\n    title: Authentication\n    status: active\n    sprints:\n      - { id: s1, title: Login, status: active, invoke: auth-login }\n`, "utf8");
  return root;
}
function fakeLinear({ failOn = null } = {}) {
  const calls = [];
  let created = 0;
  const fetchImpl = async (url, { body }) => {
    const { query, variables } = JSON.parse(body);
    calls.push({ query, variables });
    const respond = (data) => ({ ok: true, json: async () => ({ data }) });
    if (query.includes("teams(filter")) return respond({ teams: { nodes: [{ id: "team-1", key: "ENG", name: "Eng",
      states: { nodes: [
        { id: "st-b", name: "Backlog", type: "backlog", position: 0 },
        { id: "st-s", name: "In Progress", type: "started", position: 1 },
        { id: "st-c", name: "Done", type: "completed", position: 2 },
      ] },
      projects: { nodes: [] } }] } });
    if (query.includes("issue(id:")) {   // snapshot aliases — nothing exists in Linear yet
      const data = {};
      (query.match(/i\d+:/g) || []).forEach((_, j) => { data[`i${j}`] = null; });
      return respond(data);
    }
    if (query.includes("projectCreate")) return respond({ projectCreate: { project: { id: "proj-new" } } });
    if (query.includes("issueCreate")) {
      if (failOn === "issueCreate") throw new Error("simulated transport failure");
      created += 1;
      return respond({ issueCreate: { issue: { id: `uuid-${created}`, identifier: `ENG-${100 + created}` } } });
    }
    if (query.includes("issueUpdate")) return respond({ issueUpdate: { issue: { id: "x" } } });
    if (query.includes("issues(filter")) {
      const team = variables.filter.team.key.eq;
      return respond({ issues: { nodes: team === "PUB" ? [
        { identifier: "PUB-42", title: "Crash on empty config", priority: 1, updatedAt: "2026-07-06T00:00:00Z",
          state: { name: "Backlog", type: "backlog" }, team: { key: "PUB" }, project: { name: "Submit an issue" } },
      ] : [] } });
    }
    throw new Error(`fake transport: unexpected query ${query.slice(0, 60)}`);
  };
  return { fetchImpl, calls };
}

// WHY: this is the end-to-end contract — a sync must create the missing project+issue, write
// the ids back INTO the YAML (the mapping's source of truth), surface inbound work as
// proposals without mutating anything, hold the cursor while proposals are unhandled, and
// be a no-op on the second run (idempotency is what makes /sync safe to run repeatedly).
test("runSync (mocked transport): pushes, writes ids back, proposes inbound, idempotent second run", async () => {
  const root = linearRepo();
  const fake = fakeLinear();
  const r1 = await runSync(root, { fetchImpl: fake.fetchImpl, env: { LINEAR_API_KEY: "k" }, now: "2026-07-06T12:00:00Z" });
  const yaml = readFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), "utf8");
  ok(yaml.includes("project: proj-new"), "PI project id written back");
  ok(yaml.includes("linear: ENG-101"), "issue identifier written back onto the sprint");
  eq(r1.proposals.newItems.length, 1, "inbound PUB issue proposed");
  eq(r1.proposals.newItems[0].source.linear.team, "PUB", "source demarcation carried");
  ok(!existsSync(join(root, "docs", "roadmap", "backlog.yaml")), "propose mode captured NOTHING (no silent mutation)");
  eq(r1.cursorAdvanced, false, "cursor held while the inbox is unhandled");
  eq(readCursor(root), null, "no cursor file yet");
  const r2 = await runSync(root, { fetchImpl: fake.fetchImpl, env: { LINEAR_API_KEY: "k" }, now: "2026-07-06T13:00:00Z" });
  eq(r2.pushed, [], "second run pushes nothing (idempotent)");
  rmSync(root, { recursive: true, force: true });
});

// WHY: a transport failure mid-push must not lose the ids Linear already assigned (or the
// next sync duplicates those issues), and must not advance the cursor (or inbound work in
// that window vanishes forever).
test("runSync flushes write-backs on a mid-push throw and leaves the cursor untouched", async () => {
  const root = linearRepo();
  const fake = fakeLinear({ failOn: "issueCreate" });
  let threw = false;
  try { await runSync(root, { fetchImpl: fake.fetchImpl, env: { LINEAR_API_KEY: "k" } }); }
  catch (e) { threw = true; ok(e.message.includes("simulated transport failure"), "the transport error surfaces"); }
  ok(threw, "sync propagated the failure");
  const yaml = readFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), "utf8");
  ok(yaml.includes("project: proj-new"), "the project created BEFORE the failure kept its write-back");
  ok(!yaml.includes("ENG-10"), "the failed issue wrote nothing back");
  eq(readCursor(root), null, "cursor untouched on failure");
  rmSync(root, { recursive: true, force: true });
});

// WHY: unconfigured/unauthed must be actionable errors, not stack traces — these are the
// messages the /sync skill and a bare CLI user act on.
test("runSync errors are the setup-guidance contract", async () => {
  const root = tempRepo();   // no meta.linear
  await runSync(root, { env: {} }).then(() => { throw new Error("should have thrown"); },
    (e) => ok(e.message.includes("roadmap linear setup"), "unconfigured names the fix"));
  const lroot = linearRepo();
  await runSync(lroot, { env: {} }).then(() => { throw new Error("should have thrown"); },
    (e) => ok(e.message.includes("LINEAR_API_KEY"), "unauthed names the env var"));
  rmSync(root, { recursive: true, force: true });
  rmSync(lroot, { recursive: true, force: true });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
