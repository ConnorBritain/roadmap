// packages/exec-general tests — the git-file GauntletArtifact on the core contract (real temp git
// repos), both general Executors on the core Executor contract, and the exit test of the slice:
// a general-profile roadmap with no `touches` and a checklist gate round-trips validate / plan /
// render / conduct start → critic → verdict → ack → repair → fresh critic → PASS → reconcile
// against a markdown artifact, with zero edits to the file the user wrote, and survives ledger loss.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, eq, ok, throws } from "../../core/test/harness.mjs";
import { gauntletArtifactContract } from "../../core/test/contracts/gauntlet-artifact.mjs";
import { executorContract } from "../../core/test/contracts/executor.mjs";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { validateGraph } from "@connorbritain/roadmap-core/validate-core.mjs";
import { GAUNTLET_STATE_FILE } from "@connorbritain/roadmap-core/gauntlet-store.mjs";
import { gitFileArtifact, artifactNumberOf } from "@connorbritain/roadmap-exec-general/git-file-artifact.mjs";
import { humanExecutor, docAgentExecutor, renderAssignmentBrief, checklistOf, parseReceipt } from "@connorbritain/roadmap-exec-general/executors.mjs";
import { conductStart, conductStatus, conductCritic, conductVerdict, conductAck, conductRepair, conductReconcile } from "@connorbritain/roadmap-exec-general/conduct.mjs";
import { generalValidators } from "@connorbritain/roadmap-exec-general/validate-general.mjs";
import { loadProfile } from "@connorbritain/roadmap-cli/profile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..", "..", "scripts");
const git = (root, ...a) => { const r = spawnSync("git", a, { cwd: root, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
const commitAll = (root, msg) => { git(root, "add", "-A"); git(root, "commit", "-q", "-m", msg); return git(root, "rev-parse", "HEAD"); };

function gitRepo(prefix = "roadmap-general-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "lead@example.com");
  git(root, "config", "user.name", "Lead");
  return root;
}
const write = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

// ── GauntletArtifact contract ────────────────────────────────────────────────
gauntletArtifactContract("git-file", () => {
  const root = gitRepo();
  write(root, "README.md", "# repo\n");
  const base = commitAll(root, "init");
  write(root, "docs/guide.md", "# Guide v1\n");
  const head = commitAll(root, "guide v1");
  // An unrelated history: an orphan commit that also carries the doc.
  git(root, "checkout", "-q", "--orphan", "alt");
  git(root, "rm", "-rfq", ".");
  write(root, "docs/guide.md", "# Guide v2 (unrelated)\n");
  const unrelated = commitAll(root, "guide v2 on an unrelated line");
  git(root, "checkout", "-q", "main");
  const artifact = gitFileArtifact(root);
  return {
    artifact,
    publish: ({ body }) => { artifact.publishPacket("docs/guide.md", body); return "docs/guide.md"; },
    advance: (ref, sha) => { git(root, "reset", "-q", "--hard", sha); },
    editComment: (ref, url) => {
      const cf = join(root, artifact.commentsFile(ref));
      const lines = readFileSync(cf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const id = Number(url.split("#comment-")[1]);
      for (const e of lines) if (e.id === id) e.body += " (edited)";
      writeFileSync(cf, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    },
    lineage: { base, head, unrelated },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}, { test, eq, ok });

// ── Executor contract (both) ─────────────────────────────────────────────────
const GENERAL_YAML = `# The handbook roadmap — hand-written comment that must survive every mutation.
meta:
  schema_version: 1
  program: handbook
  profile: general
  default_concurrency: 2
  links: { narrative: ROADMAP.md }
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
        what: Write the first-week guide at docs/week1.md
        artifact: docs/week1.md
        read_order: [ROADMAP.md]
        gate:
          - Every section names an owner
          - Reviewed by one person outside the team
      - id: s2
        title: Review it
        status: scheduled
        invoke: onboarding-review
        deps: [s1]
        est_sessions: 1
        what: Read docs/week1.md end to end
`;
function generalRepo() {
  const root = gitRepo();
  write(root, "docs/roadmap/roadmap.yaml", GENERAL_YAML);
  write(root, "ROADMAP.md", "# Handbook\n");
  commitAll(root, "roadmap");
  const graph = loadGraph(join(root, "docs", "roadmap", "roadmap.yaml"));
  const slice = { ...graph.pis[0].sprints[0], piId: "onboarding", readOrder: ["ROADMAP.md"] };
  return { root, graph, slice, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
executorContract("human", () => { const fx = generalRepo(); return { ...fx, executor: humanExecutor({ root: fx.root }) }; }, { test, eq, ok });
executorContract("doc-agent", () => { const fx = generalRepo(); return { ...fx, executor: docAgentExecutor({ root: fx.root, spawnAgent: () => ({ status: 0 }) }) }; }, { test, eq, ok });

test("general executors: launch writes a durable brief with the checklist + artifact; receipts re-read from disk; status tracks the artifact; cleanup dry by default", async () => {
  const fx = generalRepo();
  try {
    const ctx = { root: fx.root, graph: fx.graph };
    const h = humanExecutor({ root: fx.root });
    const r = await h.launch(fx.slice, { assignee: "pat@example.com" }, ctx);
    eq([r.executor, r.actor, r.artifactRef, r.brief], ["human", "pat@example.com", "docs/week1.md", ".roadmap/assignments/onboarding-week1.md"], "receipt");
    const text = readFileSync(join(fx.root, r.brief), "utf8");
    ok(text.includes("- [ ] Every section names an owner") && text.includes("`docs/week1.md`") && text.includes("1. ROADMAP.md"), "brief carries checklist, artifact, read order");
    eq(parseReceipt(text).key, "human:onboarding-week1:work", "the brief header is the receipt");
    const again = await h.launch(fx.slice, { assignee: "someone-else" }, ctx);
    eq([again.key, again.actor, again.existing], [r.key, "pat@example.com", true], "idempotent per key: the first assignment stands");
    eq((await h.status(fx.slice, ctx)).state, "assigned", "assigned, no artifact yet");
    write(fx.root, "docs/week1.md", "# Week 1\n");
    eq((await h.status(fx.slice, ctx)).state, "running", "drafted, uncommitted");
    const sha = commitAll(fx.root, "week1 draft");
    const st = await h.status(fx.slice, ctx);
    eq([st.state, st.head], ["done", sha], "committed → the executor's job is done; the conductor judges");
    eq((await h.receipts(fx.slice, ctx)).map((x) => x.key), [r.key], "receipts read back from the brief files");
    eq((await h.annotate(fx.slice, fx.graph, ctx)).assignee, "pat@example.com", "annotate names the assignee");
    const cap = await h.capacity(fx.graph, ctx);
    eq([cap.recommended, cap.sys, cap.disk], [1, null, null], "review capacity bound by 1 ready slice; no machine ceilings");
    ok(cap.candidates.some((c) => c.why.startsWith("review — 2 concurrent")), "meta.default_concurrency is the review ceiling");
    const dry = await h.cleanup({}, ctx);
    eq([dry.dry, dry.removed], [true, []], "cleanup dry keeps the brief (slice not done)");
    const d = docAgentExecutor({ root: fx.root, spawnAgent: (root, cmd) => ({ status: 0, cmd }) });
    const dr = await d.launch(fx.slice, { role: "critic", round: 1, prompt: "Judge it." }, ctx);
    ok(dr.command.includes("claude --permission-mode plan") && dr.command.includes(".roadmap/assignments/onboarding-week1.critic-r1.md"), "doc-agent starts the configured assistant against the brief");
    ok(readFileSync(join(fx.root, dr.brief), "utf8").includes("## critic brief\n\nJudge it."), "role brief embeds the prompt verbatim");
    eq(checklistOf({ gate: "npm test" }, { meta: {} }), ["run: npm test"], "a command gate becomes a run: line");
    ok(renderAssignmentBrief(fx.slice, fx.graph, { role: "work", executor: "human", actor: null, started_at: "t", artifactRef: "x.md" }).includes("**Assignee:** unassigned"), "brief renders without an assignee");
  } finally { fx.cleanup(); }
});

test("general validators: checklist gates + artifact clashes; core rejects a malformed gate", () => {
  const g = loadGraph(join(generalRepo().root, "docs", "roadmap", "roadmap.yaml"));
  for (const v of generalValidators) eq(v(g).errors, [], `${v.name} clean`);
  const clash = structuredClone(g); clash.pis[0].sprints[1].artifact = "docs/week1.md"; clash.pis[0].sprints[1].status = "next";
  ok(generalValidators[1](clash).errors[0].includes("all name docs/week1.md"), "two open slices on one artifact");
  const bare = structuredClone(g); delete bare.pis[0].sprints[0].gate;
  ok(generalValidators[0](bare).warnings[0].startsWith("gate: 1 next slice(s)"), "no gate and no default → warn");
  const bad = structuredClone(g); bad.pis[0].sprints[0].gate = [""];
  ok(validateGraph(bad).errors.some((e) => e.includes("gate must be a string or a non-empty list")), "core rejects an empty checklist item");
  const esc = structuredClone(g); esc.pis[0].sprints[0].artifact = "../outside.md";
  ok(validateGraph(esc).errors.some((e) => e.includes("artifact must be a repository-relative path")), "core rejects an escaping artifact path");
});

// ── the exit test ────────────────────────────────────────────────────────────
test("general round-trip: validate → plan → render → conduct start/critic/verdict/ack/repair/critic/PASS → reconcile on a markdown artifact; ledger loss survives", async () => {
  const fx = generalRepo();
  const root = fx.root;
  const run = (script, argv) => spawnSync("node", [join(SCRIPTS, script), ...argv], { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  try {
    const before = readFileSync(join(root, "docs/roadmap/roadmap.yaml"), "utf8");
    const v = run("validate.mjs", []);
    eq(v.status, 0, `validate: ${v.stderr}`);
    ok(v.stdout.includes("0 warning(s)"), "no warnings for a touches-free general roadmap");
    const plan = JSON.parse(run("scheduler.mjs", ["--json"]).stdout);
    eq(plan.waves[0][0].artifact, "docs/week1.md", "plan annotates the artifact path");
    ok(/^(review|work) —/.test(plan.binding.why) && plan.candidates.every((c) => !/^(CPU|RAM|disk)/.test(c.why)), "capacity is review/work-bound, no machine ceilings");
    eq(run("render.mjs", []).status, 0, "render");
    const slices = readFileSync(join(root, "docs/SLICES.md"), "utf8");
    ok(slices.includes("checklist — Every section names an owner; Reviewed by one person outside the team") && slices.includes("**Artifact:** `docs/week1.md`"), "SLICES.md renders the checklist gate and artifact");
    const prof = await loadProfile(loadGraph(join(root, "docs/roadmap/roadmap.yaml")).meta, { root });
    eq([prof.name, prof.executor.name, prof.commands.conduct, prof.commands.assign], ["general", "human", "conduct.mjs", "assign.mjs"], "general profile registered");
    ok(prof.mcp.tools.some((t) => t.name === "conduct_start") && prof.skills.includes("conduct"), "general MCP tools + skills");

    // start: freeze the bar into the sidecar, claim, assign
    const started = await conductStart(root, "onboarding-week1", { executor: "human", assignee: "pat@example.com" });
    ok(started.runId.startsWith("gnt_onboarding_week1_") && existsSync(join(root, ".roadmap/gauntlet/docs_week1.md/packet.md")), "packet committed to the sidecar");
    eq(started.state, "awaiting_pr", "no artifact yet");
    eq(conductStatus(root, "onboarding-week1").state, "awaiting_pr", "status by slice key");
    const dup = await conductStart(root, "onboarding-week1", {});
    eq(dup.duplicate, true, "a second start is refused while the run is live");
    throws(() => { /* sync guard */ if (existsSync(join(root, GAUNTLET_STATE_FILE))) throw new Error("ledger present"); }, "ledger present", "the ledger cache exists");

    // the worker delivers
    write(root, "docs/week1.md", "# Week 1\n\n## Setup\nOwner: TBD\n");
    const h1 = commitAll(root, "week1 draft");
    let st = conductStatus(root, started.runId);
    eq([st.state, st.head, st.round], ["awaiting_critic", h1, 1], "a committed artifact awaits its critic");

    // critic round 1 → REVISE
    await (async () => { try { await conductCritic(root, started.runId, { expectedHead: "f".repeat(40) }); ok(false, "stale head refused"); } catch (e) { ok(e.message.includes("stale critic assignment"), "stale head refused"); } })();
    const c1 = await conductCritic(root, started.runId, { expectedHead: h1, assignee: "sam@example.com" });
    eq([c1.round, c1.expectedHead, c1.brief], [1, h1, ".roadmap/assignments/onboarding-week1.critic-r1.md"], "critic launched with a brief");
    ok(readFileSync(join(root, c1.brief), "utf8").includes(`git log -1 --format=%H HEAD -- docs/week1.md`), "critic brief tells the worker how to fetch the exact head");
    eq(conductStatus(root, started.runId).state, "critic_in_flight", "critic in flight");
    const dupC = await conductCritic(root, started.runId, { expectedHead: h1 });
    eq(dupC.duplicate, true, "critic launch is idempotent");
    const v1 = conductVerdict(root, started.runId, { verdict: "REVISE", rationale: "Setup has no owner.", mustFix: "- Name the Setup owner" });
    eq(v1.state, "awaiting_lead_ack", "an unacknowledged verdict drives nothing");
    ok(v1.commentUrl && v1.commentUrl.startsWith("git-file://docs/week1.md#comment-"), "verdict has a locator");
    await (async () => { try { await conductRepair(root, started.runId, { expectedHead: h1, packet: "x" }); ok(false); } catch (e) { ok(e.message.includes("is awaiting_lead_ack"), "repair refused before ack"); } })();
    const a1 = conductAck(root, started.runId, { commentUrl: v1.commentUrl, confirm: true });
    eq([a1.verdict, a1.state], ["REVISE", "needs_repair"], "ack makes the REVISE authoritative");
    eq(conductAck(root, started.runId, { commentUrl: v1.commentUrl, confirm: true }).duplicate, true, "ack is idempotent");

    // repair
    const r1 = await conductRepair(root, started.runId, { expectedHead: h1, packet: "Name the Setup owner (Pat)." });
    eq([r1.round, r1.brief], [1, ".roadmap/assignments/onboarding-week1.repair-r1.md"], "repair launched");
    ok(readFileSync(join(root, r1.brief), "utf8").includes("Name the Setup owner (Pat)."), "repair brief carries the packet");
    eq(conductStatus(root, started.runId).state, "repair_in_flight", "repair in flight");
    write(root, "docs/week1.md", "# Week 1\n\n## Setup\nOwner: Pat\n");
    const h2 = commitAll(root, "week1: name the owner");
    st = conductStatus(root, started.runId);
    eq([st.state, st.head, st.round, st.repairsUsed], ["awaiting_critic", h2, 2, 1], "the repaired head awaits a fresh critic in round 2");

    // critic round 2 → PASS → ack → passed
    const c2 = await conductCritic(root, started.runId, { expectedHead: h2 });
    eq(c2.round, 2, "round 2 critic");
    const v2 = conductVerdict(root, started.runId, { verdict: "PASS", rationale: "Owner named; reviewed." });
    const a2 = conductAck(root, started.runId, { commentUrl: v2.commentUrl, confirm: true });
    eq(a2.state, "passed", "acknowledged PASS on the current head");

    // reconcile (the general sync) → slice complete, comments preserved
    const rec = conductReconcile(root, {});
    eq(rec.proposals[0].proposal, "complete", "reconcile proposes completion");
    const applied = conductReconcile(root, { apply: true });
    eq(applied.applied, ["onboarding-week1"], "applied");
    const after = readFileSync(join(root, "docs/roadmap/roadmap.yaml"), "utf8");
    ok(after.startsWith("# The handbook roadmap — hand-written comment"), "YAML comment preserved through the mutation");
    ok(after.includes("status: complete") && after.includes("gate:\n          - Every section names an owner"), "status flipped; the checklist gate is untouched");
    ok(before !== after && before.replace("status: next", "status: complete").split("\n").length <= after.split("\n").length, "only the slice's status (+ completed_on) changed");
    eq(conductStatus(root, started.runId).state, "passed", "run stays passed after reconcile");

    // ledger loss: the committed sidecar rebuilds the run and its attested launches
    rmSync(join(root, GAUNTLET_STATE_FILE));
    const rebuilt = conductStatus(root, started.runId);
    eq([rebuilt.reconstructed, rebuilt.state, rebuilt.head], [true, "passed", h2], "run reconstructed from the sidecar; acknowledged PASS still authoritative");
    const keys = (await humanExecutor({ root }).receipts(fx.slice, { root })).map((r) => r.key).sort();
    eq(keys, ["human:onboarding-week1:critic:r1", "human:onboarding-week1:critic:r2", "human:onboarding-week1:repair:r1", "human:onboarding-week1:work"], "executor receipts survive ledger loss: the briefs are files");

    // the CLI surfaces route under the general profile
    const cs = run("cli.mjs", ["conduct", "status", started.runId]);
    eq(cs.status, 0, `cli conduct status: ${cs.stderr}`);
    ok(JSON.parse(cs.stdout).state === "passed", "conduct status via the CLI");
    const asg = run("cli.mjs", ["assign", "onboarding-review", "--to", "kim@example.com", "--dry"]);
    eq(asg.status, 0, `assign --dry: ${asg.stderr}`);
    ok(asg.stdout.includes("# Assignment — onboarding-review") && !existsSync(join(root, ".roadmap/assignments/onboarding-review.md")), "assign --dry previews and writes nothing");
  } finally { fx.cleanup(); }
});

test("git-file: artifact numbers are stable and fetch resolves by path, number, run id and subject", () => {
  const root = gitRepo();
  try {
    write(root, "docs/a.md", "a\n"); commitAll(root, "a");
    const art = gitFileArtifact(root);
    const n = artifactNumberOf("docs/a.md");
    ok(Number.isInteger(n) && n > 0 && n === artifactNumberOf("docs/a.md"), "stable positive number");
    eq(art.fetch({ number: "docs/a.md" }).number, n, "fetch by path");
    eq(art.fetch({ path: "docs/nope.md" }), null, "unknown path → null");
    ok(art.fetch("docs/a.md").commits.length === 1 && art.fetch("docs/a.md").body === "", "no packet yet: empty body, one commit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
