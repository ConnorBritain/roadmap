// packages/exec-engineering tests — the two engineering Executors on the core contract, the
// engineering scoper, and the pure pieces of the worktree-session module (planning, renderers,
// pruning) driven with injected probes so nothing touches the real machine, git, or gh.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, eq, ok } from "../../core/test/harness.mjs";
import { executorContract } from "../../core/test/contracts/executor.mjs";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { worktreeSessionExecutor, planWave, launchSettings, renderWaveScript, renderSingleScript, waveLaunchDecision, pruneWorktrees, planGrab, withBom } from "@connorbritain/roadmap-exec-engineering/worktree-session.mjs";
import { cloudDispatchExecutor, planCloudWave } from "@connorbritain/roadmap-exec-engineering/cloud-dispatch.mjs";
import { candidateTouches, engineeringScope } from "@connorbritain/roadmap-exec-engineering/scoper.mjs";

const SYS = { cores: 8, totalGb: 32, freeGb: 20, platform: "linux" };
const YAML = (root) => `meta:
  schema_version: 1
  program: T
  default_gate: npm test
  worktree_root: ${root}/_wt
  links: { narrative: ROADMAP.md }
pis:
  - id: auth
    title: Auth
    status: active
    sprints:
      - { id: s1, title: Login flow, status: next, invoke: auth-login, touches: [src/login.ts], est_sessions: 1, what: build login in src/login.ts, prompt: "Start from the failing test." }
      - { id: s2, title: Session tokens, status: next, invoke: auth-sessions, touches: [src/session.ts], est_sessions: 2, what: tokens }
`;

function repoFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roadmap-exec-")));
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), YAML(root));
  writeFileSync(join(root, "ROADMAP.md"), "# T\n");
  const graph = loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  const slice = graph.pis[0].sprints[0];
  Object.assign(slice, { piId: "auth", invoke: "auth-login" });
  return { root, graph, slice, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A fake git/gh: worktree listing is empty, branches are unmerged, nothing is dirty.
const fakeExec = (cmd, args) => {
  if (cmd === "git" && args[0] === "ls-files") return { status: 0, stdout: "src/login.ts\nsrc/session.ts\nREADME.md\n", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

executorContract("worktree-session", () => {
  const fx = repoFixture();
  return { ...fx, executor: worktreeSessionExecutor({ root: fx.root, disk: null, reviewDebt: 0, execImpl: fakeExec, files: ["src/login.ts"], platform: "linux", localConfig: { version: 1, assistants: {} } }) };
}, { test, eq, ok });

executorContract("cloud-dispatch", () => {
  const fx = repoFixture();
  return { ...fx, executor: cloudDispatchExecutor({ root: fx.root, listOpenPrs: () => [], execImpl: fakeExec, files: ["src/login.ts"] }) };
}, { test, eq, ok });

test("worktree-session: a dry launch renders the single-target script and the receipt names branch + worktree; status reads worktrees back", async () => {
  const fx = repoFixture();
  try {
    const x = worktreeSessionExecutor({ root: fx.root, disk: null, reviewDebt: 0, execImpl: fakeExec, platform: "linux", localConfig: { version: 1, assistants: {} } });
    const ctx = { root: fx.root, graph: fx.graph, meta: fx.graph.meta };
    const r = await x.launch(fx.slice, { dry: true, term: "tmux" }, ctx);
    eq(r.artifactRef, "auth/s1", "receipt carries the branch");
    eq(r.worktree, `${fx.root}/_wt/auth-s1`, "and the worktree path");
    ok(r.script.startsWith("#!/usr/bin/env bash\n# roadmap launch — auth-login, terminal=tmux"), "tmux single-target script");
    ok(r.script.includes(`git worktree add "${fx.root}/_wt/auth-s1" -b "auth/s1" origin/main`), "worktree add line");
    const st = await x.status(fx.slice, ctx);
    eq(st.state, "idle", "no worktree yet → idle");
    const cap = await x.capacity(fx.graph, ctx);
    ok(cap.candidates.some((c) => /^work/.test(c.why)) && cap.candidates.some((c) => /^review/.test(c.why)), "engineering ceilings present");
    const ann = await x.annotate(fx.slice, fx.graph, ctx);
    eq([ann.branch, ann.worktree], ["auth/s1", `${fx.root}/_wt/auth-s1`], "annotate adds branch + worktree");
    ok(typeof ann.prompt === "string" && ann.weight, "and prompt + weight");
    const sc = await x.scope(fx.graph.pis[0].sprints[1], ctx);
    ok(!("touches" in sc.fields), "declared touches are respected");
    eq(sc.fields.read_order, ["ROADMAP.md"], "read order from meta.links (ROADMAP.md exists in the fixture)");
  } finally { fx.cleanup(); }
});

test("worktree-session: status/receipts reflect a checked-out worktree (running vs done) from injected git output", async () => {
  const fx = repoFixture();
  try {
    const porcelain = `worktree ${fx.root}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${fx.root}/_wt/auth-s1\nHEAD def\nbranch refs/heads/auth/s1\n`;
    // external-state's worktrees() uses the real spawnSync; drive it through a real git repo instead.
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: fx.root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: fx.root });
    spawnSync("git", ["remote", "add", "origin", fx.root], { cwd: fx.root });
    spawnSync("git", ["fetch", "-q", "origin"], { cwd: fx.root });
    mkdirSync(join(fx.root, "_wt"), { recursive: true });
    spawnSync("git", ["worktree", "add", "-q", join(fx.root, "_wt", "auth-s1"), "-b", "auth/s1", "origin/main"], { cwd: fx.root });
    const x = worktreeSessionExecutor({ root: fx.root, disk: null, reviewDebt: 0, platform: "linux", localConfig: { version: 1, assistants: {} } });
    const ctx = { root: fx.root, graph: fx.graph, meta: fx.graph.meta };
    const st = await x.status(fx.slice, ctx);
    eq(st.state, "done", "a branch at origin/main counts as merged → done");
    eq(st.receipts[0].key, "worktree-session:auth-login:auth/s1", "receipt key is executor:slice:branch");
    const again = await x.launch(fx.slice, { dry: true }, ctx);
    eq(again.key, st.receipts[0].key, "launch is idempotent on an existing worktree");
    ok(porcelain.includes("auth/s1"), "(porcelain sample used for the prune test below)");
    const prune = pruneWorktrees(fx.root, { remove: false, meta: fx.graph.meta });
    eq(prune.plan.length, 1, "prune sees the fanout worktree only");
    ok(prune.lines[1].includes("[merged, clean]  → would remove"), "dry plan names the action");
    const c = await x.cleanup({}, ctx);
    eq([c.dry, c.removed, c.kept], [true, [], [join(fx.root, "_wt", "auth-s1")]], "cleanup dry keeps it");
    const rm = await x.cleanup({ remove: true }, ctx);
    eq(rm.removed, [join(fx.root, "_wt", "auth-s1")], "cleanup --remove prunes the merged, clean worktree");
    eq((await x.status(fx.slice, ctx)).state, "idle", "and the slice is idle again");
  } finally { fx.cleanup(); }
});

test("worktree-session: planWave caps by injected ceilings, hard-blocks on disk, honours --track; renderers are pure per terminal", () => {
  const fx = repoFixture();
  try {
    const base = { root: fx.root, sys: SYS, disk: null, reviewDebt: 0 };
    const p = planWave(fx.graph, { ...base, cap: 1 });
    eq(p.wave.map((n) => n.invoke), ["auth-login"], "cap 1 → one slice in wave 1");
    eq(p.waves.length, 2, "two waves");
    const auto = planWave(fx.graph, base);
    eq(auto.cap, auto.rec.recommended, "no cap → the recommendation");
    const blocked = planWave(fx.graph, { ...base, disk: { perWorktreeGb: 5, freeGb: 3 } });
    eq(blocked.blocked, "disk", "not even one worktree fits → blocked");
    ok(blocked.lines[0].startsWith("✗ not enough disk"), "with the refusal lines");
    const tracked = planWave(fx.graph, { ...base, cap: 2, track: "nope" });
    eq([tracked.fullWave.length, tracked.wave.length], [2, 0], "track filter empties the wave but keeps the full one");
    const s = launchSettings(fx.graph, { root: fx.root, platform: "linux", localConfig: { version: 1, assistants: {} } });
    eq([s.term, s.workerMode, s.profile.name], ["tmux", "plan", "manual"], "defaults: tmux, plan, manual profile");
    const win = launchSettings(fx.graph, { root: fx.root, platform: "win32", localConfig: { version: 1, assistants: {} } });
    eq(win.term, "wt", "Windows defaults to Windows Terminal");
    const full = planWave(fx.graph, { ...base, cap: 2 });
    for (const term of ["tmux", "wt", "warp", "print", "background"]) {
      const out = renderWaveScript(full, { ...s, term });
      ok(out.includes("auth-s1") && out.includes("auth-s2"), `${term}: both worktrees`);
    }
    ok(renderWaveScript(full, { ...s, term: "tmux" }).includes("tmux new-session -d -s roadmap"), "tmux session");
    ok(renderWaveScript(full, { ...s, term: "warp" }).includes("warp://tab_config/roadmap-wave1"), "warp deeplink");
    ok(withBom("wt", "x").charCodeAt(0) === 0xfeff && withBom("tmux", "x") === "x", "BOM only for PowerShell terminals");
    eq(waveLaunchDecision(s, { dry: true }).mode, "dry", "dry never spawns");
    eq(waveLaunchDecision(s, { requestedLaunch: true }).mode, "manual", "manual profile never spawns even with --launch");
    eq(waveLaunchDecision({ ...s, autonomous: true, profile: { name: "claude", launch: true, autonomous: true, command: "claude {prompt}" } }, { requestedLaunch: true }).mode, "autonomous-needs-ack", "autonomous needs the double ack");
    const single = renderSingleScript(fx.slice, fx.graph, { ...s, term: "print" }, { header: "# hdr" });
    ok(single.startsWith("# hdr\n") && single.includes("# --- .kickoff.md ---"), "print single script embeds the brief");
  } finally { fx.cleanup(); }
});

test("worktree-session: planGrab refuses unknown/closed items and renders the backlog worktree", () => {
  const fx = repoFixture();
  try {
    const backlog = { items: [{ id: "b1", title: "Fix quoting", kind: "bug", status: "open", prompt: "Repro then fix." }, { id: "b2", title: "Done", kind: "chore", status: "done" }] };
    const o = { backlog, dry: true, platform: "linux", localConfig: { version: 1, assistants: {} } };
    ok(planGrab(fx.root, fx.graph, "zz", o).error.includes('no backlog item "zz"'), "unknown item");
    ok(planGrab(fx.root, fx.graph, "b2", o).error.includes("is done"), "closed item");
    eq(planGrab(fx.root, fx.graph, "b1", { ...o, backlog: null }).error.split(" — ")[0], "✗ no docs/roadmap/backlog.yaml", "no backlog");
    const g = planGrab(fx.root, fx.graph, "b1", { ...o, term: "print" });
    eq([g.br, g.wt], ["backlog/b1", `${fx.root}/_wt/backlog-b1`], "backlog branch + worktree");
    ok(g.script.startsWith("# roadmap grab — b1 (bug)\n"), "grab header");
    const blocked = planGrab(fx.root, fx.graph, "b1", { ...o, dry: false, disk: { perWorktreeGb: 5, freeGb: 3 } });
    ok(blocked.error.startsWith("✗ not enough disk"), "disk hard-block when not dry");
  } finally { fx.cleanup(); }
});

test("cloud-dispatch: planCloudWave caps by the review ceiling; the executor's capacity has no machine ceiling and status reads marker PRs", async () => {
  const fx = repoFixture();
  try {
    const w = planCloudWave(fx.graph, { reviewCeiling: 1 });
    eq([w.cap, w.wave.length, w.waves.length], [1, 1, 2], "review ceiling caps the cloud wave");
    eq(planCloudWave(fx.graph, { cap: 2 }).wave.length, 2, "explicit cap wins");
    const prs = [{ number: 7, url: "https://x/pr/7", body: "roadmap: slice=auth-login", createdAt: "2026-01-01T00:00:00Z" }];
    const x = cloudDispatchExecutor({ root: fx.root, listOpenPrs: () => prs });
    const ctx = { root: fx.root, graph: fx.graph, meta: fx.graph.meta };
    const cap = await x.capacity(fx.graph, ctx);
    ok(cap.candidates.every((c) => !/^(CPU|RAM|disk)/.test(c.why)), "no CPU/RAM/disk ceilings in the cloud");
    eq(cap.recommended, 2, "bound by the two ready slices");
    const st = await x.status(fx.slice, ctx);
    eq([st.state, st.artifactRef, st.receipts[0].url], ["awaiting_artifact", "#7", "https://x/pr/7"], "an open marker PR is the receipt");
    const r = await x.launch(fx.slice, { dry: false }, ctx);
    eq(r.key, "cloud-dispatch:auth-login:claude", "launch is idempotent on an open marker PR (nothing fired)");
    eq((await x.status(fx.graph.pis[0].sprints[1], ctx)).state, "idle", "no PR → idle");
    eq((await x.annotate(fx.slice, fx.graph, ctx)).marker, "roadmap: slice=auth-login", "annotate carries the marker line");
    const dry = await x.launch(fx.graph.pis[0].sprints[1], { dry: true }, ctx);
    eq([dry.dry, dry.provider], [true, "claude"], "dry launch resolves nothing and fires nothing");
  } finally { fx.cleanup(); }
});

test("scoper: candidateTouches ranks tracked files by shared words; engineeringScope layers touches on the generic proposal", () => {
  const files = ["src/auth/login.ts", "src/auth/session.ts", "docs/login-flow.md", "assets/login.png", "node_modules/x/login.js"];
  const node = { invoke: "auth-login", title: "Login flow", what: "build the login screen", status: "next" };
  eq(candidateTouches(node, files), ["docs/login-flow.md", "src/auth/login.ts"], "word matches, images and node_modules skipped");
  eq(candidateTouches({ invoke: "x", title: "the and for" }, files), [], "stop words alone match nothing");
  const r = engineeringScope(node, { meta: { default_gate: "npm test" } }, { root: "/nonexistent", files });
  eq(r.fields.touches, ["docs/login-flow.md", "src/auth/login.ts"], "touches proposed");
  eq(r.fields.gate, "default", "generic proposals kept");
  ok(r.rationale.some((l) => l.startsWith("touches:")), "with a rationale line");
  const none = engineeringScope({ invoke: "y", title: "zzz", touches: [] }, { meta: {} }, { root: "/nonexistent", files });
  ok(!("touches" in none.fields) && none.rationale.some((l) => l.includes("no tracked file")), "no match → says so, proposes nothing");
  const declared = engineeringScope({ invoke: "y", title: "Login", touches: ["a.ts"] }, { meta: {} }, { root: "/nonexistent", files });
  ok(!("touches" in declared.fields), "declared touches respected");
});
