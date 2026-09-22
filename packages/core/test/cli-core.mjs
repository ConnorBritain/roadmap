// packages/core tests — cli-core. Moved verbatim from scripts/test/run.mjs (core-extract slice).
// Runs when imported; the shared harness counts every test in one summary.
import { test, eq, ok, throws, sp } from "./harness.mjs";
import { join, resolve } from "node:path";
import { REL, buildArgs, classify, findRepoRoot, missingRoadmapHelp, route } from "@connorbritain/roadmap-core/cli-core.mjs";

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
  eq(route(["gauntlet", "eval", "init", "--run", "matrix-2026-08"]),
    { cmd: "gauntlet-eval", rest: ["init", "--run", "matrix-2026-08"] }, "evaluation route preserves its action");
});

// WHY: classify decides what actually runs; a built command misrouted to 'unknown'
// breaks the CLI, and a P4 stub misrouted to 'run' would spawn a nonexistent script.
test("classify: maps built commands, flags P4 stubs, rejects unknown", () => {
  eq(classify("plan").kind, "run", "plan runs");
  eq(classify("plan").script, "scheduler.mjs", "plan → scheduler");
  eq(classify("fan").script, "fanout.mjs", "fan → fanout");
  eq(classify("gauntlet-eval").script, "evaluate.mjs", "gauntlet eval → evaluation conductor");
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
