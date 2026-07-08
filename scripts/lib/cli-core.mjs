// roadmap CLI — pure core (no side effects on import, so it's unit-testable).
// cli.mjs wires these to process.argv / spawn / process.exit.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REL = ["docs", "roadmap", "roadmap.yaml"];
const MAP = { plan: "scheduler.mjs", render: "render.mjs", fan: "fanout.mjs", fanout: "fanout.mjs", validate: "validate.mjs", show: "show.mjs", cleanup: "cleanup.mjs", wizard: "wizard.mjs", go: "wizard.mjs", mcp: "mcp.mjs", watch: "watch-prs.mjs", set: "set.mjs", backlog: "backlog.mjs", grab: "grab.mjs", promote: "promote.mjs", next: "next.mjs", linear: "linear.mjs", review: "review.mjs", dispatch: "dispatch.mjs", plate: "plate.mjs" };
const NOT_YET = { sync: "P4", init: "P4" };

// Walk up from `start` to the first dir containing docs/roadmap/roadmap.yaml; null if none.
// `exists` is injectable for testing.
export function findRepoRoot(start, exists = existsSync) {
  let dir = resolve(start);
  for (;;) {
    if (exists(join(dir, ...REL))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Parse argv (already sliced past node + script) into { cmd, rest }.
// Bare → plan; a leading flag → plan with those flags; -h/--help → help.
export function route(argv) {
  if (argv.length === 0) return { cmd: "plan", rest: [] };
  if (argv[0].startsWith("-")) {
    if (argv[0] === "-h" || argv[0] === "--help") return { cmd: "help", rest: [] };
    return { cmd: "plan", rest: argv };
  }
  return { cmd: argv[0], rest: argv.slice(1) };
}

// Classify a command into an action the wrapper acts on.
export function classify(cmd) {
  if (cmd === "help") return { kind: "help" };
  if (NOT_YET[cmd]) return { kind: "notyet", phase: NOT_YET[cmd] };
  if (MAP[cmd]) return { kind: "run", script: MAP[cmd] };
  return { kind: "unknown" };
}

// validate.mjs takes a positional path; the others take relative defaults from repo root.
export function buildArgs(cmd, rest, relPath = join(...REL)) {
  if (cmd === "validate" && !rest.some((a) => !a.startsWith("-"))) return [relPath, ...rest];
  return rest;
}

// Split `field=value` CLI assignments (roadmap set / backlog set). Splits on the FIRST '='
// (values may contain '='). `@path` marks read-value-from-file (multiline prompts/briefs);
// everything else is YAML-parsed by the caller, so `null` deletes per set_fields semantics.
export function parseAssignments(args) {
  return args.map((a) => {
    const i = a.indexOf("=");
    if (i <= 0) throw new Error(`expected field=value, got "${a}"`);
    const field = a.slice(0, i), raw = a.slice(i + 1);
    return raw.startsWith("@") ? { field, fromFile: raw.slice(1) } : { field, raw };
  });
}

// Single-letter flag aliases, expanded to their long form before the target script sees them.
const SHORT = {
  "-w": "--wave", "-c": "--cap", "-t": "--term", "-o": "--out", "-i": "--in",
  "-d": "--dry", "-j": "--json", "-a": "--autonomous", "-y": "--yes-spawn-autonomous",
  "-f": "--force", "-s": "--stdout", "-l": "--lane", "-r": "--remove",
  "-lc": "--lead-claude", "-wm": "--worker-mode",
};
export function expandShort(args) {
  return args.map((a) => SHORT[a] || a);
}

// Friendly guidance when no roadmap.yaml is found — say WHERE it goes + how to start one,
// instead of a terse error. Shown for any command (incl. bare `roadmap`).
export function missingRoadmapHelp(cwd) {
  const rel = REL.join("/");
  return [
    `roadmap: couldn't find ${rel} at or above`,
    `  ${cwd}`,
    ``,
    `The CLI walks UP from your current directory looking for the roadmap graph,`,
    `so run it from anywhere inside a repo whose root has:`,
    `  <repo-root>/${rel}`,
    ``,
    `Don't have one yet? A minimal starter:`,
    `  meta:`,
    `    schema_version: 1`,
    `    program: MYPROJ`,
    `  pis:`,
    `    - id: first`,
    `      title: First initiative`,
    `      status: active`,
    `      sprints:`,
    `        - { id: s1, title: First sprint, status: next, invoke: first-s1, est_sessions: 1 }`,
    ``,
    `Save that to ${rel}, then 'roadmap validate' and 'roadmap render'.`,
    `(A guided 'roadmap init' interview lands in P4.)`,
  ].join("\n");
}
