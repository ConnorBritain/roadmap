// packages/exec-engineering tests — golden dry-run outputs of the launcher CLIs (fanout, grab,
// cleanup) captured before their bodies moved into worktree-session.mjs. Each fixture is the
// exact { status, stdout, stderr } of one command against a tiny repo, with the temp root
// replaced by <ROOT>. Only machine-dependent fragments (the ceiling recommendation) are masked.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, eq } from "../../core/test/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCRIPTS = join(REPO, "scripts");
const FIXTURES = join(SCRIPTS, "test", "fixtures", "launchers");

function fixtureRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roadmap-golden-")));
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), `meta:
  schema_version: 1
  program: T
  default_gate: npm test
  worktree_root: ${root}/_wt
pis:
  - id: auth
    title: Auth
    status: active
    sprints:
      - { id: s1, title: Login flow, status: next, invoke: auth-login, touches: [src/login.ts], est_sessions: 1, what: build login, prompt: "Start from the failing test." }
      - { id: s2, title: Session tokens, status: next, invoke: auth-sessions, touches: [src/session.ts], est_sessions: 2, what: tokens }
`);
  writeFileSync(join(root, "docs", "roadmap", "backlog.yaml"), `meta:
  schema_version: 1
items:
  - { id: b1, title: Fix quoting, kind: bug, status: open, prompt: "Repro then fix.", touches: [scripts/x.mjs] }
`);
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

// The recommendation depends on this machine's cores/RAM; the fixtures were captured elsewhere.
const mask = (s, root) => s.split(root).join("<ROOT>").replace(/recommended \d+, bound by [^)]+\)/g, "recommended N, bound by X)");

const CASES = [
  ...["print", "tmux", "wt", "warp", "background"].map((term) => [`fanout-${term}`, "fanout.mjs", ["--dry", "--term", term, "--cap", "2"]]),
  ...["print", "tmux", "wt"].map((term) => [`grab-${term}`, "grab.mjs", ["b1", "--dry", "--term", term]]),
  ["cleanup-dry", "cleanup.mjs", []],
];

test("launchers: fanout/grab/cleanup dry runs match their golden outputs byte for byte", () => {
  const root = fixtureRepo();
  try {
    for (const [name, script, argv] of CASES) {
      const want = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
      const r = spawnSync("node", [join(SCRIPTS, script), ...argv], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: root } });
      eq(r.status, want.status, `${name}: exit status`);
      eq(mask(r.stdout, root), mask(want.stdout, root), `${name}: stdout`);
      eq(mask(r.stderr, root), mask(want.stderr, root), `${name}: stderr`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
