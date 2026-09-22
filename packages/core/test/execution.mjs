// packages/core tests — execution. Moved verbatim from scripts/test/run.mjs (core-extract slice).
// Runs when imported; the shared harness counts every test in one summary.
import { test, eq, ok, throws, sp } from "./harness.mjs";
import { join } from "node:path";
import { EXEC_MODES, EXEC_ROLES, dirClusters, executionDirectiveLines, filterByTrack, suggestedConcurrency, teamSize, validateExecution } from "@connorbritain/roadmap-core/execution.mjs";
import { renderMarkdown } from "@connorbritain/roadmap-core/render-core.mjs";
import { validateGraph } from "@connorbritain/roadmap-core/validate-core.mjs";

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
