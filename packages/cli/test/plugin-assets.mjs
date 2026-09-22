// packages/cli tests — the plugin assets follow the profile registry: every skill directory is
// registered by core or by exactly one profile, profile-only skills say so, the SessionStart hook
// speaks the loaded profile's language, and the Stop hook stays silent under general.
import { readdirSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, eq, ok } from "../../core/test/harness.mjs";
import { CORE_SKILLS } from "@connorbritain/roadmap-cli/profile.mjs";
import { SKILLS as ENGINEERING_SKILLS } from "@connorbritain/roadmap-exec-engineering";
import { SKILLS as GENERAL_SKILLS } from "@connorbritain/roadmap-exec-general";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOKS = join(REPO, "hooks");

test("plugin assets: every skills/ directory is registered by core or exactly one profile, and profile-only skills declare their profile", () => {
  const dirs = readdirSync(join(REPO, "skills")).filter((d) => existsSync(join(REPO, "skills", d, "SKILL.md"))).sort();
  const registered = [...CORE_SKILLS, ...ENGINEERING_SKILLS, ...GENERAL_SKILLS].sort();
  eq(dirs, registered, "skills on disk == skills the registries name (no orphan, no phantom)");
  eq(new Set(registered).size, registered.length, "no skill registered twice");
  for (const s of ENGINEERING_SKILLS) ok(readFileSync(join(REPO, "skills", s, "SKILL.md"), "utf8").includes("**Profile: engineering**"), `${s} declares the engineering profile`);
  for (const s of GENERAL_SKILLS) ok(readFileSync(join(REPO, "skills", s, "SKILL.md"), "utf8").includes("**Profile: general**"), `${s} declares the general profile`);
  for (const s of CORE_SKILLS) {
    const t = readFileSync(join(REPO, "skills", s, "SKILL.md"), "utf8");
    ok(!/\*\*Profile: (engineering|general)\*\*/.test(t), `${s} is a core skill and claims no profile`);
  }
  const plugin = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8"));
  ok(plugin.description.includes("/conduct") && plugin.description.includes("/gauntlet"), "the plugin manifest names both profiles' loops");
  eq(plugin.version, JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version, "plugin version matches the package");
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  ok(readme.includes("## Work profiles") && readme.includes("/conduct") && readme.includes("/gauntlet") && readme.split("\n").length < 260, "README: concepts + profiles + install, with a pointer per profile, and short");
  for (const f of ["MIGRATION.md", "docs/REFERENCE.md", "docs/ARCHITECTURE.md", "packages/core/README.md", "packages/exec-engineering/README.md", "packages/exec-general/README.md", "packages/cli/README.md"]) ok(existsSync(join(REPO, f)), `${f} exists`);
  ok(readFileSync(join(REPO, "MIGRATION.md"), "utf8").includes("need no edits"), "MIGRATION.md states that no YAML changes are required");
  ok(!readFileSync(join(REPO, "AGENTS.md"), "utf8").includes("pure logic in [`scripts/lib`]"), "AGENTS.md points at the packages, not the shims");
});

function repo(yaml) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roadmap-hooks-")));
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), yaml);
  return root;
}
const hook = (name, root, env = {}) => spawnSync(process.execPath, [join(HOOKS, name)], { cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root }), env: { ...process.env, PATH: "/nonexistent", ...env } });
const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return ""; } };

const ENGINEERING = `meta: { schema_version: 1, program: T, default_gate: npm test }
pis:
  - id: a
    title: A
    status: active
    sprints:
      - { id: s1, title: Login, status: next, invoke: auth-login, what: login, est_sessions: 1, touches: [src/a.ts] }
`;
const GENERAL = `meta: { schema_version: 1, program: H, profile: general }
pis:
  - id: a
    title: A
    status: active
    sprints:
      - { id: s1, title: Guide, status: next, invoke: guide, what: write docs/guide.md, est_sessions: 1, gate: [Reviewed by one person] }
`;

test("hooks: SessionStart speaks the loaded profile's language and stays silent outside a roadmap; Stop is a no-op under general", () => {
  const eng = repo(ENGINEERING), gen = repo(GENERAL), none = realpathSync(mkdtempSync(join(tmpdir(), "roadmap-nohook-")));
  try {
    const e = hook("session-start.mjs", eng);
    eq(e.status, 0, `engineering hook exits 0: ${e.stderr}`);
    ok(ctxOf(e).includes("ready now") && ctxOf(e).includes("/fanout") && !ctxOf(e).includes("/conduct"), `engineering wording: ${ctxOf(e)}`);
    const g = hook("session-start.mjs", gen);
    eq(g.status, 0, `general hook exits 0: ${g.stderr}`);
    ok(ctxOf(g).includes("general profile") && ctxOf(g).includes("/conduct") && ctxOf(g).includes("/assign") && !ctxOf(g).includes("/fanout"), `general wording: ${ctxOf(g)}`);
    const n = hook("session-start.mjs", none);
    eq([n.status, n.stdout], [0, ""], "no roadmap → silent");
    const j = hook("journal-post.mjs", gen, { LINEAR_API_KEY: "x" });
    eq([j.status, j.stdout, j.stderr], [0, "", ""], "Stop hook: silent under general even with a key");
  } finally { for (const d of [eng, gen, none]) rmSync(d, { recursive: true, force: true }); }
});
