// packages/cli tests — the work-profile loader: the single meta.profile read, the merged
// registries from both real executor packages, and the CLI / validate / MCP surfaces under a
// general-profile roadmap that declares no touches (zero edits needed to an engineering file).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, eq, ok, throws } from "../../core/test/harness.mjs";
import { profileNameOf, loadProfile, assertProfile, CORE_COMMANDS, CORE_SKILLS, PROFILES, DEFAULT_PROFILE } from "@connorbritain/roadmap-cli/profile.mjs";
import { classify } from "@connorbritain/roadmap-core/cli-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..", "..", "scripts");

const GENERAL = `meta:
  schema_version: 1
  program: handbook
  profile: general
pis:
  - id: onboarding
    title: Onboarding handbook
    status: active
    sprints:
      - id: s1
        title: Draft the first-week guide
        status: next
        invoke: onboarding-week1
        est_sessions: 2
        what: Write docs/week1.md
        gate:
          - Every section has an owner named
          - Reviewed by one person outside the team
      - id: s2
        title: Review it
        status: scheduled
        invoke: onboarding-review
        deps: [s1]
        est_sessions: 1
        what: Read docs/week1.md end to end
`;
const ENGINEERING = `meta:
  schema_version: 1
  program: T
  default_gate: npm test
pis:
  - id: auth
    title: Auth
    status: active
    sprints:
      - { id: s1, title: Login, status: next, invoke: auth-login, what: build login }
      - { id: s2, title: Sessions, status: next, invoke: auth-sessions, what: tokens, touches: [src/session.ts] }
`;

function repo(yaml) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roadmap-profile-")));
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), yaml);
  return root;
}
const run = (root, script, argv, env = {}) => spawnSync("node", [join(SCRIPTS, script), ...argv], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
const mcp = (root, msgs) => {
  const r = spawnSync("node", [join(SCRIPTS, "mcp.mjs")], { cwd: root, encoding: "utf8", input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  return r.stdout.trim().split("\n").map((l) => JSON.parse(l));
};

test("profile: profileNameOf is the single work-profile read — absent → engineering, bad values are errors, never a silent default", () => {
  eq(profileNameOf({}), "engineering", "absent → engineering");
  eq(profileNameOf(undefined), DEFAULT_PROFILE, "no meta → default");
  eq(profileNameOf({ profile: "general" }), "general", "general");
  throws(() => profileNameOf({ profile: "handbook" }), "must be one of engineering|general", "unknown value");
  throws(() => profileNameOf({ profile: 3 }), "must be one of", "non-string");
  eq(PROFILES, ["engineering", "general"], "the two profiles");
});

test("profile: loadProfile merges core with the real engineering and general packages; the registration shape is enforced", async () => {
  const eng = await loadProfile({}, { root: "/nonexistent-eng" });
  eq(eng.name, "engineering", "default package");
  eq(eng.executor.name, "worktree-session", "engineering executor");
  eq(eng.commands.plan, CORE_COMMANDS.plan, "core commands present");
  eq(eng.commands.fan, "fanout.mjs", "engineering commands added");
  ok(eng.mcp.tools.some((t) => t.name === "gauntlet_start") && eng.mcp.tools.some((t) => t.name === "dispatch"), "engineering MCP tools registered");
  ok(eng.skills.includes("fanout") && CORE_SKILLS.every((s) => eng.skills.includes(s)), "skills merged");
  ok(typeof eng.planContext.capacity === "function" && typeof eng.planContext.annotate === "function", "plan context from the executor");
  ok(eng.validators.length >= 1 && typeof eng.artifacts["github-pr"] === "function", "validators + github-pr artifact");
  const gen = await loadProfile({ profile: "general" }, { root: "/nonexistent-gen" });
  eq([gen.name, gen.executor, gen.commands.fan, gen.mcp.tools.length], ["general", null, undefined, 0], "general: core only until the exec-general slice");
  eq(await gen.mcp.call("gauntlet_start", {}), undefined, "general answers no engineering tool");
  ok(gen.commands.plan && gen.commands.validate && gen.commands.backlog, "core commands under general");
  eq(await loadProfile({}, { root: "/nonexistent-eng" }), eng, "cached per profile + root");
  throws(() => assertProfile({ name: "x" }), "is missing", "shape enforced");
  const fake = await loadProfile({ profile: "general" }, { root: "/fake", importImpl: async () => ({ profile: async () => ({ executor: null, artifacts: {}, validators: [], commands: { conduct: "conduct.mjs" }, mcp: { tools: [], call: async () => undefined }, skills: ["conduct"], planContext: {} }) }) });
  eq([fake.commands.conduct, fake.skills.at(-1)], ["conduct.mjs", "conduct"], "an injected package registers through the same merge");
});

test("profile: classify uses the merged command map — an engineering command under general is 'unavailable', not 'unknown'", async () => {
  const gen = await loadProfile({ profile: "general" }, { root: "/nonexistent-gen2" });
  eq(classify("plan", gen.commands).kind, "run", "core command runs");
  eq(classify("fan", gen.commands).kind, "unavailable", "engineering command is unavailable under general");
  eq(classify("bogus", gen.commands).kind, "unknown", "unknown stays unknown");
  eq(classify("fan").kind, "run", "no map → the historical full map");
});

test("profile: a general roadmap with no touches and checklist gates validates, plans, shows and answers MCP with zero edits; engineering commands refuse", () => {
  const root = repo(GENERAL);
  try {
    const v = run(root, "validate.mjs", []);
    eq(v.status, 0, `validate exits 0: ${v.stderr}`);
    ok(v.stdout.includes("0 warning(s)"), "no warnings (no touches is not an engineering concern here)");
    const p = run(root, "scheduler.mjs", []);
    eq(p.status, 0, `plan exits 0: ${p.stderr}`);
    ok(p.stdout.includes("onboarding-week1") && !p.stdout.includes("undefined") && !p.stdout.includes("git worktree add"), "plan lists the slice with no machine or worktree lines");
    const j = JSON.parse(run(root, "scheduler.mjs", ["--json"]).stdout);
    ok(j.binding.why.startsWith("default_concurrency"), "capacity is core's default under general");
    const s = run(root, "show.mjs", ["onboarding-week1"]);
    eq(s.status, 0, `show exits 0: ${s.stderr}`);
    ok(s.stdout.includes("Every section has an owner named"), "checklist gate rendered");
    const fan = run(root, "cli.mjs", ["fan", "--dry"]);
    eq(fan.status, 2, "fan refuses under general");
    ok(fan.stderr.includes("not available under the general work profile"), "and says why");
    const cli = run(root, "cli.mjs", ["validate"]);
    eq(cli.status, 0, `cli validate routes: ${cli.stderr}`);
    const [list, plan, gs] = mcp(root, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "plan", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gauntlet_start", arguments: { key: "x" } } },
    ]);
    const names = list.result.tools.map((t) => t.name);
    ok(names.includes("plan") && names.includes("backlog_add") && !names.includes("gauntlet_start") && !names.includes("dispatch"), "MCP registers core tools only under general");
    ok(plan.result.content[0].text.includes("default_concurrency"), "plan tool uses default capacity");
    ok(gs.result.isError && gs.result.content[0].text.includes("unknown tool"), "engineering tool is unknown under general");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profile: an engineering roadmap (no work profile set) keeps every command and tool; the engineering validator warns on contention-blind next slices; a bad profile fails validate", () => {
  const root = repo(ENGINEERING);
  try {
    const v = run(root, "validate.mjs", []);
    eq(v.status, 0, "valid");
    ok(v.stderr.includes("contention: 1 next slice(s) declare no touches/owns (auth-login)"), "engineering validator ran");
    const [list] = mcp(root, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const names = list.result.tools.map((t) => t.name);
    ok(names.includes("gauntlet_start") && names.includes("dispatch") && names.includes("fan_cloud") && names.includes("gauntlet_eval_seal"), "engineering tools registered");
    ok(list.result.tools.find((t) => t.name === "gauntlet_start").inputSchema.properties.model_preference, "model_preference injection preserved");
    const fan = run(root, "cli.mjs", ["fan", "--dry", "--cap", "1"]);
    eq(fan.status, 0, `fan runs: ${fan.stderr}`);
    writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), ENGINEERING.replace("program: T", "program: T\n  profile: warehouse"));
    const bad = run(root, "validate.mjs", []);
    eq(bad.status, 1, "bad profile fails");
    ok(bad.stderr.includes("must be one of engineering|general"), "naming the field");
    eq(run(root, "cli.mjs", ["plan"]).status, 2, "the CLI refuses too");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
