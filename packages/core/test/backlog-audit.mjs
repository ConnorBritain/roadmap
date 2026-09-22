// packages/core tests — backlog-audit. Moved verbatim from scripts/test/run.mjs (core-extract slice).
// Runs when imported; the shared harness counts every test in one summary.
import { test, eq, ok, throws, sp } from "./harness.mjs";
import { AUDIT_CODES, auditBacklog, collectEntries, knownDamageOf, signatureOf } from "@connorbritain/roadmap-core/backlog-audit.mjs";
import { prune } from "@connorbritain/roadmap-core/mcp-core.mjs";

// ── backlog-audit ───────────────────────────────────────────────────────────
// Every fixture below is the reduced shape of a real corruption observed on
// docs/roadmap/backlog.yaml in a downstream repo — a union-merge of two
// concurrent captures leaves the file parseable-but-damaged (the parsed
// object looks fine while the text carries the wrong shape). The audit is
// what still answers when yaml.parse either throws OR silently normalizes
// the damage away.

// WHY: a duplicate id makes the second entry unreachable by id from every
// consumer that keys on it, and yaml.parse throws "Map keys must be unique",
// so validate would refuse the whole file with no line-level attribution
// without the audit — the audit is what names WHICH ids collided.
test("auditBacklog names duplicate ids by line", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: first\n    kind: bug\n    status: open\n  - id: b1\n    title: second\n    kind: bug\n    status: open\n`;
  const result = auditBacklog(text);
  eq(result.ok, false, "duplicate is not ok");
  eq(result.damaged, true, "duplicate is a gating failure");
  const dup = result.findings.find((f) => f.code === AUDIT_CODES.DUPLICATE_ID);
  ok(dup, "DUPLICATE_ID reported");
  eq(dup.id, "b1", "the colliding id is named");
  eq(dup.lines, [4, 8], "both lines are named so the resolver can see which body to keep");
});

// WHY: a bare `- id:` line dropped in front of another entry is the shape a
// bad merge most often produces — the id-line's own entry has no body, and
// yaml.parse accepts the shape as an item with only an id, so the parsed-
// object validator passes it. This is the failure the audit exists for.
test("auditBacklog flags stub entries with no kind/status", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n  - id: b2\n    title: real\n    kind: bug\n    status: open\n`;
  const result = auditBacklog(text);
  const stub = result.findings.find((f) => f.code === AUDIT_CODES.STUB_ENTRY);
  ok(stub, "STUB_ENTRY reported");
  eq(stub.id, "b1", "the empty stub is named");
  ok(stub.message.includes("no kind/status"), "the message names what is missing");
});

// WHY: a title-only entry (id + title, no body) is the SAME class of merge
// damage — the body was destroyed while the title survived, and the audit
// must not confuse "has a title" with "has a body".
test("auditBacklog flags a title-only entry as a stub", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: only a title\n  - id: b2\n    title: real\n    kind: bug\n    status: open\n`;
  const result = auditBacklog(text);
  const stub = result.findings.find((f) => f.code === AUDIT_CODES.STUB_ENTRY);
  ok(stub && stub.id === "b1", "title-only entry is still a stub");
  ok(stub.message.includes("[title]"), "the message names what the entry actually carried");
});

// WHY: a repeated body key inside one entry — two `title:` or two `source:` —
// is a neighbouring entry absorbed after losing its own `- id:` line. This
// is the shape that most often makes yaml.parse throw, so it must be named
// separately from DUPLICATE_ID (two entries) — they have different fixes.
test("auditBacklog flags repeated body keys inside a single entry", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: first\n    kind: bug\n    status: open\n    title: absorbed\n    kind: chore\n`;
  const result = auditBacklog(text);
  const rep = result.findings.find((f) => f.code === AUDIT_CODES.REPEATED_KEY);
  ok(rep, "REPEATED_KEY reported");
  eq(rep.id, "b1", "the swallowing entry is named");
  ok(rep.keys.includes("title") && rep.keys.includes("kind"), "the repeated keys are enumerated");
});

// WHY: a bare `key:` at the same indent as a sequence's `- ` items is the
// residue of a merge that spliced one entry's `priority.reason` into another
// entry's `refs:` list. yaml.parse throws "expected <block end>, found ?" on
// the whole file, so the audit is the only path to a line-level fix.
test("auditBacklog detects a mapping key inside a sequence (SEQUENCE_KEY_INTRUSION)", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: first\n    kind: bug\n    status: open\n    refs:\n      - docs/one.md\n      - docs/two.md\n      reason: spliced from a neighbour by a merge\n`;
  const result = auditBacklog(text);
  const intrusion = result.findings.find((f) => f.code === AUDIT_CODES.SEQUENCE_KEY_INTRUSION);
  ok(intrusion, "SEQUENCE_KEY_INTRUSION reported");
  eq(intrusion.id, "b1", "the owning entry is named");
  ok(intrusion.message.includes("refs"), "the owning sequence is named");
});

// WHY: a non-bNNN id is INFO, not a hazard — custom slugs are legal per the
// schema. Surfacing them helps a reader who is reasoning about the next-free
// id space, but they must not gate a write (would break `roadmap validate`
// on any repo that uses custom slugs at all).
test("auditBacklog reports MALFORMED_ID as INFO, not as a gating failure", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: fix-x\n    title: a custom slug\n    kind: bug\n    status: open\n`;
  const result = auditBacklog(text);
  eq(result.ok, false, "the finding is still surfaced");
  eq(result.damaged, false, "but it does not gate — custom slugs are legal");
  const mal = result.findings.find((f) => f.code === AUDIT_CODES.MALFORMED_ID);
  ok(mal, "MALFORMED_ID reported");
});

// WHY: a well-formed backlog must audit clean — the whole point of a gating
// check is that healthy files pass silently, so a false-positive would train
// callers to ignore it.
test("auditBacklog passes clean on a well-formed backlog", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: one\n    kind: bug\n    status: open\n  - id: b2\n    title: two\n    kind: chore\n    status: open\n`;
  const result = auditBacklog(text);
  eq(result.ok, true, "clean file → ok:true");
  eq(result.damaged, false, "clean file → damaged:false");
  eq(result.findings, [], "clean file → no findings");
  eq(result.entryCount, 2, "entry count matches");
});

// WHY: collectEntries is the base primitive; a caller that wants only the id
// list (id allocation) reaches this one, not the whole audit. It must count
// entries in the raw text (not in a parsed object that could have dropped a
// duplicate), and it must return each entry's line number for attribution.
test("collectEntries returns each id-line with its line number in the raw text", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: one\n    kind: bug\n    status: open\n  - id: b2\n    title: two\n    kind: bug\n    status: open\n`;
  const entries = collectEntries(text);
  eq(entries.length, 2, "both entries collected");
  eq(entries[0].id, "b1");
  eq(entries[0].line, 4, "first id on line 4");
  eq(entries[1].id, "b2");
  eq(entries[1].line, 8, "second id on line 8");
});

// WHY: the audit is a pure text function — passing a non-string is a caller
// bug that should throw immediately, not silently return ok:true.
test("auditBacklog throws on a non-string input", () => {
  throws(() => auditBacklog(null), "text must be a string", "null throws");
  throws(() => auditBacklog(undefined), "text must be a string", "undefined throws");
  throws(() => auditBacklog({ items: [] }), "text must be a string", "parsed object throws");
});

// WHY: a repo that adopts the audit while carrying pre-existing damage needs
// a way to grandfather that damage in — otherwise they can't use `roadmap
// backlog add` at all until every stub is repaired. The baseline pins by
// STABLE signature (CODE:id), not line number, so ordinary appends don't
// invalidate it.
test("auditBacklog grandfathers findings whose signature appears in knownDamage", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: real\n    kind: bug\n    status: open\n  - id: b2\n`;
  const strict = auditBacklog(text);
  eq(strict.damaged, true, "without a baseline, the stub is a gating hazard");

  const gentle = auditBacklog(text, { knownDamage: ["STUB_ENTRY:b2"] });
  eq(gentle.damaged, false, "with the signature grandfathered, the file audits clean-enough to mutate");
  eq(gentle.findings.length, 0, "the grandfathered finding is removed from active findings");
  eq(gentle.grandfathered.length, 1, "but it is still surfaced for visibility (grandfathered, not silenced)");
  eq(gentle.grandfathered[0].id, "b2", "the specific entry is reported");
});

// WHY: a baseline that outlives the damage it describes silently loses the
// ability to catch a NEW instance of that signature — the guard's whole
// point is repair, not perpetual tolerance. `staleKnown` names the pins to
// prune the moment the underlying damage is fixed.
test("auditBacklog reports stale known_damage entries so the baseline can be pruned", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: real\n    kind: bug\n    status: open\n`;
  const result = auditBacklog(text, { knownDamage: ["STUB_ENTRY:b99", "DUPLICATE_ID:b7"] });
  eq(result.staleKnown, ["STUB_ENTRY:b99", "DUPLICATE_ID:b7"], "both pins are stale — the file carries neither");
  eq(result.damaged, false, "the file itself is clean");
});

// WHY: knownDamage that isn't an array (malformed config) must not crash the
// audit — a caller who wrote `known_damage: STUB_ENTRY:b2` (a scalar) or
// left the key null gets treated as "no baseline" and the audit runs strict.
test("auditBacklog treats a non-array knownDamage as an empty baseline (safe strict)", () => {
  const text = `meta:\n  schema_version: 1\nitems:\n  - id: b1\n    title: real\n    kind: bug\n    status: open\n  - id: b2\n`;
  const nullish = auditBacklog(text, { knownDamage: null });
  eq(nullish.damaged, true, "null baseline → strict");
  const scalar = auditBacklog(text, { knownDamage: "STUB_ENTRY:b2" });
  eq(scalar.damaged, true, "scalar baseline → strict (not a substring match)");
});

// WHY: `signatureOf` is the primitive a repo uses to bootstrap its baseline
// (`roadmap audit --learn` will collect these). It must match the pattern
// stored in meta.audit.known_damage byte-for-byte, or the pin is a lie.
test("signatureOf produces the CODE:id signature used by knownDamage pins", () => {
  eq(signatureOf({ code: "STUB_ENTRY", id: "b2" }), "STUB_ENTRY:b2");
  eq(signatureOf({ code: "DUPLICATE_ID", id: "b1" }), "DUPLICATE_ID:b1");
});

// WHY: knownDamageOf is the tiny adapter validate.mjs / store.mjs use to
// pull the pin list from a parsed backlog. It must degrade to [] on any
// unusual shape rather than reaching into null/undefined and throwing.
test("knownDamageOf reads meta.audit.known_damage and degrades safely on any missing/mistyped shape", () => {
  eq(knownDamageOf({ meta: { audit: { known_damage: ["STUB_ENTRY:b2", "DUPLICATE_ID:b1"] } }, items: [] }),
    ["STUB_ENTRY:b2", "DUPLICATE_ID:b1"], "the standard shape returns the list");
  eq(knownDamageOf({ meta: { audit: {} }, items: [] }), [], "missing known_damage → []");
  eq(knownDamageOf({ meta: {}, items: [] }), [], "missing audit → []");
  eq(knownDamageOf({ items: [] }), [], "missing meta → []");
  eq(knownDamageOf(null), [], "null backlog → []");
  eq(knownDamageOf({ meta: { audit: { known_damage: "not an array" } } }), [], "wrong type → []");
  eq(knownDamageOf({ meta: { audit: { known_damage: ["ok", 42, null, "also-ok"] } } }),
    ["ok", "also-ok"], "non-string entries are filtered out (config typos don't get pinned)");
});
