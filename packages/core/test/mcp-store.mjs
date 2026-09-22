// packages/core tests — mcp-store. Moved verbatim from scripts/test/run.mjs (core-extract slice).
// Runs when imported; the shared harness counts every test in one summary.
import { test, eq, ok, throws, sp } from "./harness.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKLOG_TOOLS, addItem, performPromotion, validateBacklogDocOrThrow } from "@connorbritain/roadmap-core/backlog-core.mjs";
import { parseAssignments } from "@connorbritain/roadmap-core/cli-core.mjs";
import { buildPushPlan, issueDescription, normalizeLinearConfig } from "@connorbritain/roadmap-core/linear-core.mjs";
import { TOOLS, addSprint, bulkSet, prune, readValidate, serialize, setFields, setStatus, validateDocOrThrow } from "@connorbritain/roadmap-core/mcp-core.mjs";
import { mutateBacklog, mutateBoth, mutateRoadmap } from "@connorbritain/roadmap-core/store.mjs";
import { parseDocument } from "yaml";

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

// WHY: promoting a mapped item must TRANSFER its Linear issue to the sprint — leaving it
// on the item orphans an open issue on the board and double-maps the identifier.
test("performPromotion transfers the item's Linear issue to the sprint", () => {
  const rDoc = parseDocument(`meta:\n  schema_version: 1\n  program: T\npis:\n  - id: auth\n    title: Auth\n    status: active\n    sprints:\n      - { id: s1, title: Old, status: complete, invoke: old }\n`);
  const bDoc = parseDocument(`meta:\n  schema_version: 1\nitems:\n  - { id: fix-z, title: Fix Z, kind: bug, status: open, linear: PID-42 }\n`);
  performPromotion(rDoc, bDoc, { id: "fix-z", pi: "auth" });
  const sprint = rDoc.toJS().pis[0].sprints[1];
  eq(sprint.linear, "PID-42", "issue identifier rides onto the sprint");
  const item = bDoc.toJS().items[0];
  eq(item.linear, undefined, "item releases the mapping");
  eq(item.promoted_to, "auth/s2", "back-link intact");
  validateDocOrThrow(rDoc); validateBacklogDocOrThrow(bDoc);
});

// WHY: the transferred issue must MORPH on the next sync — slice-form description, kind
// label dropped, and attached to the PI's project — or the board shows a stale backlog card.
test("buildPushPlan morphs a transferred issue: description + labels + projectId in one update", () => {
  const g = {
    meta: { schema_version: 1, program: "T", linear: { team: "ENG" } },
    pis: [{ id: "auth", title: "Authentication", status: "active", linear: { project: "proj-1" }, sprints: [
      { id: "s2", title: "Fix Z", status: "scheduled", invoke: "fix-z", linear: "PID-42" },
    ]}],
  };
  const cfg = normalizeLinearConfig(g.meta);
  const itemForm = { // the issue as it looked while it was a backlog item
    id: "uuid-42", title: "Fix Z", priority: 0, stateId: "st-b", projectId: null, labelIds: ["l-mark", "l-kindbug"],
    description: issueDescription({ invoke: "fix-z", title: "Fix Z", what: "Fix Z", kind: "bug" }, cfg, { target: { type: "backlog", key: "fix-z" } }),
  };
  const morphStates = [
    { id: "st-b", name: "Backlog", type: "backlog", position: 0 },
    { id: "st-s", name: "In Progress", type: "started", position: 1 },
    { id: "st-c", name: "Done", type: "completed", position: 2 },
  ];
  const plan = buildPushPlan({ graph: g, backlog: null, cfg, teamStates: morphStates,
    existing: { projects: { "proj-1": { id: "proj-1", name: "Authentication", description: "" } }, issues: { "PID-42": itemForm } },
    labels: { roadmap: "l-mark", "kind:bug": "l-kindbug" } });
  const upd = plan.ops.find((o) => o.op === "updateIssue");
  ok(upd, "one morph update");
  ok(upd.payload.description.includes("roadmap: slice=fix-z"), "description morphs to slice form");
  eq(upd.payload.labelIds, ["l-mark"], "kind label dropped, marker kept");
  eq(upd.payload.projectId, "proj-1", "attached to the PI's project");
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

// ── store.mjs: the file-write-ordering / rollback guarantees (fs-backed) ──────
// WHY: store.mjs is the one place with data-loss blast radius — every mutating surface
// routes through it. If a thrown validation still wrote a file, or promote wrote one file
// of two, the "validate before write" contract is a lie the unit tests above can't catch.
export function tempRepo() {
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

// WHY: appending onto a damaged backlog compounds the damage — the new entry
// lands after a stub that will absorb IT on the next merge. The gate must
// refuse the mutation with the specific findings so the caller can fix or
// acknowledge.
test("mutateBacklog refuses to append onto a backlog carrying collision damage", () => {
  const root = tempRepo();
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  const damaged = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: real\n    kind: bug\n    status: open\n  - id: b2\n  - id: b3\n    title: neighbour\n    kind: bug\n    status: open\n`;
  writeFileSync(bPath, damaged, "utf8");
  const originalSrc = readFileSync(bPath, "utf8");
  let caught = null;
  try {
    mutateBacklog(root, (doc) => addItem(doc, { title: "new" }));
  } catch (e) {
    caught = e;
  }
  ok(caught, "the mutation threw");
  eq(caught.code, "DAMAGED_BACKLOG", "the refusal carries a stable code");
  ok(caught.findings.some((f) => f.code === "STUB_ENTRY" && f.id === "b2"),
    "the finding attributes the damage to the specific stub id");
  eq(readFileSync(bPath, "utf8"), originalSrc,
    "a refused mutation leaves the file byte-identical (no partial write)");
  rmSync(root, { recursive: true, force: true });
});

// WHY: the ONE legitimate case for bypassing the audit is a REPAIR mutation
// — the caller wants to read the damaged file so they can fix it. The audit
// gate must let them through; the parsed-object validator downstream still
// catches whatever the mutation didn't repair, so the escape doesn't lower
// the overall correctness bar.
test("mutateBacklog appends anyway when acknowledgeDamage:true (used for repair mutations)", () => {
  const root = tempRepo();
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  // A MALFORMED_ID sits at the audit gate — INFO for the audit, but the
  // gating check is disabled by acknowledgeDamage. In practice the caller
  // uses this to append onto a file that also carries harder damage the
  // mutation itself is repairing; that case belongs to the repair-tool tests
  // (not here), because at THIS layer the parsed-object validator would
  // rightly refuse an unfixed structural break.
  const withInfoOnly = `meta:\n  schema_version: 1\nitems:\n  - id: fix-x\n    title: legal custom slug\n    kind: bug\n    status: open\n`;
  writeFileSync(bPath, withInfoOnly, "utf8");
  const r = mutateBacklog(root, (doc) => addItem(doc, { title: "under acknowledge", kind: "bug" }), { acknowledgeDamage: true });
  ok(r.added, "the mutation succeeded past the audit — parsed-object validator then runs as usual");
  rmSync(root, { recursive: true, force: true });
});

// WHY: environment override is the CI-safe escape hatch — a repair script or
// data migration should not have to thread `acknowledgeDamage: true` through
// every downstream helper.
test("mutateBacklog honors ROADMAP_ACKNOWLEDGE_DAMAGE=1 in the environment", () => {
  const root = tempRepo();
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  // Real gating shape: a duplicate id. Without the env override the audit
  // refuses; with it, the mutation proceeds and the parsed-object validator
  // catches the same duplicate downstream (which is the correct final gate).
  const damaged = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: one\n    kind: bug\n    status: open\n  - id: b1\n    title: two\n    kind: bug\n    status: open\n`;
  writeFileSync(bPath, damaged, "utf8");
  const prev = process.env.ROADMAP_ACKNOWLEDGE_DAMAGE;
  process.env.ROADMAP_ACKNOWLEDGE_DAMAGE = "1";
  try {
    throws(
      () => mutateBacklog(root, (doc) => addItem(doc, { title: "via env", kind: "bug" })),
      "duplicate backlog id",
      "the env override bypasses the audit but the parsed-object validator still refuses (correctness gate is not lowered)",
    );
  } finally {
    if (prev == null) delete process.env.ROADMAP_ACKNOWLEDGE_DAMAGE;
    else process.env.ROADMAP_ACKNOWLEDGE_DAMAGE = prev;
  }
  // Same fixture WITHOUT the env override: refuses at the audit with a much
  // better line-attributed message, before ever reaching yaml.parseDocument.
  let refusal = null;
  try {
    mutateBacklog(root, (doc) => addItem(doc, { title: "no env", kind: "bug" }));
  } catch (e) {
    refusal = e;
  }
  eq(refusal && refusal.code, "DAMAGED_BACKLOG", "without the env override, the audit gate names the shape");
  rmSync(root, { recursive: true, force: true });
});

// WHY: createIfMissing bootstraps an EMPTY_BACKLOG that is by construction
// clean — it must not trip the gate (which would make the very first capture
// impossible on a repo that adopts the backlog).
test("mutateBacklog createIfMissing skips the damage gate on the empty bootstrap", () => {
  const root = tempRepo();
  // No backlog.yaml exists yet.
  const r = mutateBacklog(root, (doc) => addItem(doc, { title: "first ever", kind: "bug" }), { createIfMissing: true });
  eq(r.added, "b1", "clean bootstrap");
  rmSync(root, { recursive: true, force: true });
});

// WHY: MALFORMED_ID is INFO (custom slugs are legal); the gate must not
// refuse a mutation onto a backlog that carries them, or every repo using
// non-bNNN ids would be dead-locked.
test("mutateBacklog does NOT gate on MALFORMED_ID findings alone (custom slugs are legal)", () => {
  const root = tempRepo();
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  writeFileSync(bPath, `meta:\n  schema_version: 1\nitems:\n  - id: fix-x\n    title: a custom slug\n    kind: bug\n    status: open\n`, "utf8");
  const r = mutateBacklog(root, (doc) => addItem(doc, { title: "add on top", kind: "bug" }));
  ok(r.added, "the mutation succeeded despite a MALFORMED_ID finding");
  rmSync(root, { recursive: true, force: true });
});

// WHY: adopting the audit shouldn't lock a repo out of its own backlog. If
// a repo pins its pre-existing damage in meta.audit.known_damage, the gate
// respects that pin and lets `roadmap backlog add` work. New damage
// (signatures not in the baseline) still refuses — the tolerance is
// specific, not blanket.
test("mutateBacklog respects meta.audit.known_damage — a pinned finding lets the audit gate pass (object validator remains final)", () => {
  const root = tempRepo();
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  // The pin authorizes the AUDIT layer to skip STUB_ENTRY:b2. Without the
  // pin, the audit refuses first with a DamagedBacklogError. With it, the
  // audit passes and the parsed-object validator runs — which then throws
  // its own specific error (b2 missing title). That is BY DESIGN: the pin
  // grandfathers the audit's tolerance, NOT the object validator's; the
  // final correctness gate is not lowered.
  writeFileSync(bPath,
    `meta:\n  schema_version: 1\n  audit:\n    known_damage:\n      - STUB_ENTRY:b2\nitems:\n  - id: b1\n    title: real\n    kind: bug\n    status: open\n  - id: b2\n`,
    "utf8");
  let caught = null;
  try {
    mutateBacklog(root, (doc) => addItem(doc, { title: "captured", kind: "bug" }));
  } catch (e) { caught = e; }
  ok(caught, "the mutation refused — but at the object validator, not the audit");
  ok(!(caught.code === "DAMAGED_BACKLOG"),
    "specifically NOT a DamagedBacklogError — the audit passed thanks to the pin");
  ok(caught.message.includes("title required") || caught.message.includes("b2"),
    "the refusal now comes from validateBacklogDocOrThrow, which sees the same b2 missing its title");
  rmSync(root, { recursive: true, force: true });
});

// WHY: the pin is SPECIFIC — pinning STUB_ENTRY:b2 must not implicitly
// tolerate STUB_ENTRY:b9 or DUPLICATE_ID:b2. A repo adopts the audit for
// the SPECIFIC damage it's grandfathering; new damage of ANY shape still
// refuses.
test("mutateBacklog still refuses on NEW damage even when other damage is pinned", () => {
  const root = tempRepo();
  const bPath = join(root, "docs", "roadmap", "backlog.yaml");
  // Pin a specific DUPLICATE_ID:b1, but the file ALSO carries a fresh
  // DUPLICATE_ID:b9 the pin doesn't cover. The refusal must name the
  // unpinned signature specifically — pinning one shape must not silently
  // tolerate every shape.
  writeFileSync(bPath,
    `meta:\n  schema_version: 1\n  audit:\n    known_damage:\n      - DUPLICATE_ID:b1\nitems:\n  - id: b1\n    title: first\n    kind: bug\n    status: open\n  - id: b1\n    title: duped-known\n    kind: chore\n    status: open\n  - id: b9\n    title: nine\n    kind: bug\n    status: open\n  - id: b9\n    title: duped-unknown\n    kind: chore\n    status: open\n`,
    "utf8");
  let caught = null;
  try {
    mutateBacklog(root, (doc) => addItem(doc, { title: "should refuse", kind: "bug" }));
  } catch (e) { caught = e; }
  ok(caught, "the mutation was refused");
  ok(caught.findings.some((f) => f.id === "b9" && f.code === "DUPLICATE_ID"),
    "the refusal names the UNPINNED duplicate (b9), not the pinned one (b1)");
  ok(!caught.findings.some((f) => f.id === "b1"),
    "the pinned duplicate is NOT in the active findings — the pin worked for that specific signature");
  rmSync(root, { recursive: true, force: true });
});
