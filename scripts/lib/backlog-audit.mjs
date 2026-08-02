// roadmap — backlog damage detector (PURE, text-level, zero-dep).
//
// A concurrent-append merge on docs/roadmap/backlog.yaml, resolved with
// `merge=union`, can leave the file parseable-but-damaged: an entry's body
// swallowed by a neighbour, two entries sharing one id, an orphaned `reason:`
// spliced into another entry's `refs:` sequence. The parsed object may look
// fine while the raw text is quietly broken.
//
// This module reads the raw text and reports the four collision-damage shapes
// observed on real corrupted backlogs. It is intentionally NOT a YAML parser:
// a strict load remains the authoritative check for parseability. This audit
// is what still answers when that load either throws (SEQUENCE_KEY_INTRUSION)
// OR silently normalizes the damage away (DUPLICATE_ID, STUB_ENTRY,
// REPEATED_KEY).
//
// Design and shape adopted from pidgeon's `scripts/roadmap-preflight/backlog-id.mjs`
// (the reference implementation shipped in the PidgeonHealth/pidgeon repo,
// backlog b290). Kept dependency-free by the same reasoning: the questions
// here are narrow and structural (where does each entry start, which keys does
// it carry, do the ids repeat), and a full parse would be the more fragile
// choice on a file that is often malformed by definition.

const ENTRY_RE = /^ {2}-\s*id:\s*["']?([^"'\s]+)["']?\s*$/;
const BODY_KEY_RE = /^ {4}([a-z_]+):/;
const NUMERIC_ID_RE = /^b(\d+)$/;

export const AUDIT_CODES = Object.freeze({
  DUPLICATE_ID: "DUPLICATE_ID",
  STUB_ENTRY: "STUB_ENTRY",
  REPEATED_KEY: "REPEATED_KEY",
  SEQUENCE_KEY_INTRUSION: "SEQUENCE_KEY_INTRUSION",
  MALFORMED_ID: "MALFORMED_ID",
});

export function splitLines(text) {
  return text.split(/\r?\n/);
}

function indentOf(line) {
  return /^( *)/.exec(line)[1].length;
}

/**
 * Every top-level `- id: <key>` entry in the raw text, with its line span and
 * the body keys it carries. An entry runs to the line before the next entry
 * (or EOF). This walks lines, not the parsed graph — the point is to see the
 * damage a lossy parse hides.
 */
export function collectEntries(text) {
  const lines = splitLines(text);
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY_RE.exec(lines[i]);
    if (m) starts.push({ id: m[1], startIdx: i });
  }
  return starts.map((entry, idx) => {
    const endIdx = idx + 1 < starts.length ? starts[idx + 1].startIdx : lines.length;
    const block = lines.slice(entry.startIdx, endIdx);
    const keys = block.map((l) => BODY_KEY_RE.exec(l)).filter(Boolean).map((m) => m[1]);
    return { ...entry, endIdx, block, keys, line: entry.startIdx + 1 };
  });
}

/**
 * Two entries carrying the same id. The loser is unreachable by id from every
 * consumer that keys on it, and whichever body a careless resolve dropped is
 * simply gone — worse than a dropped append, because the file still parses.
 */
function auditDuplicateIds(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const findings = [];
  for (const [id, group] of byId) {
    if (group.length > 1) {
      findings.push({
        code: AUDIT_CODES.DUPLICATE_ID,
        id,
        lines: group.map((e) => e.line),
        message: `'${id}' is used by ${group.length} entries (lines ${group.map((e) => e.line).join(", ")}). Renumber all but one to a fresh id from the file's max.`,
      });
    }
  }
  return findings;
}

/**
 * An entry reduced to `- id:` (± `title:`) — no kind, no status. A capture is
 * never authored this way; it is what remains when a collision ate the body,
 * or when a duplicate `- id:` line landed above another complete entry and
 * the id-line's own entry has nothing under it.
 */
function auditStubs(entries) {
  return entries
    .filter((e) => !e.keys.includes("kind") && !e.keys.includes("status"))
    .map((e) => ({
      code: AUDIT_CODES.STUB_ENTRY,
      id: e.id,
      lines: [e.line],
      message: `'${e.id}' (line ${e.line}) carries only [${e.keys.join(", ") || "nothing"}] — no kind/status. Its body was destroyed by a collision; restore it from the authoring PR or delete the stub.`,
    }));
}

/**
 * The same body key twice inside one entry — two `title:`, or a second
 * `source:`/`refs:` pair. This is a neighbouring entry absorbed after losing
 * its own `- id:` line, and it is the shape that most often makes the whole
 * file unparseable (yaml.parse: `Map keys must be unique`).
 */
function auditRepeatedKeys(entries) {
  const findings = [];
  for (const e of entries) {
    const seen = new Map();
    for (const k of e.keys) seen.set(k, (seen.get(k) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    if (repeated.length) {
      findings.push({
        code: AUDIT_CODES.REPEATED_KEY,
        id: e.id,
        lines: [e.line],
        keys: repeated,
        message: `'${e.id}' (line ${e.line}) repeats [${repeated.join(", ")}] — it has swallowed a neighbouring entry that lost its own '- id:' line. Split it back into two entries.`,
      });
    }
  }
  return findings;
}

/**
 * A bare `key:` sitting at the same indent as the `- ` items of a block
 * sequence. YAML cannot represent it (a sequence holds items, not keys), so a
 * strict load throws on the whole file. It is the residue of a merge that
 * spliced one entry's `priority.reason` into another entry's `refs:` list.
 */
export function auditSequenceIntrusions(text) {
  const lines = splitLines(text);
  const findings = [];
  let seqIndent = null;
  let seqOwner = null;
  let currentId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const entry = ENTRY_RE.exec(line);
    if (entry) {
      currentId = entry[1];
      seqIndent = null;
      continue;
    }

    const indent = indentOf(line);
    const isItem = /^\s*-\s/.test(line);

    if (seqIndent !== null) {
      if (isItem && indent === seqIndent) continue;
      if (!isItem && indent === seqIndent && /^\s*[a-z_]+:/.test(line)) {
        findings.push({
          code: AUDIT_CODES.SEQUENCE_KEY_INTRUSION,
          id: currentId,
          lines: [i + 1],
          message: `line ${i + 1}: a mapping key sits inside the '${seqOwner}:' sequence of '${currentId}' at the items' own indent. YAML cannot parse this — it is another entry's key spliced in by a merge. Move it back to the entry it belongs to.`,
        });
        seqIndent = null;
        continue;
      }
      if (indent <= seqIndent && !isItem) seqIndent = null;
    }

    const keyOnly = /^(\s*)([a-z_]+):\s*$/.exec(line);
    if (keyOnly) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      if (next && /^\s*-\s/.test(next) && indentOf(next) > keyOnly[1].length) {
        seqIndent = indentOf(next);
        seqOwner = keyOnly[2];
      }
    }
  }
  return findings;
}

/**
 * An id that does not match `bNNN`. Custom slugs are valid per the schema
 * (`backlog-core.KINDS/ITEM_STATUSES`), but they take no part in numeric id
 * allocation, so surfacing them helps a reader who is trying to reason about
 * the next-free-id space. This is INFO-shaped, not a parse or write hazard.
 */
function auditMalformedIds(entries) {
  return entries
    .filter((e) => !NUMERIC_ID_RE.test(e.id))
    .map((e) => ({
      code: AUDIT_CODES.MALFORMED_ID,
      id: e.id,
      lines: [e.line],
      message: `'${e.id}' (line ${e.line}) is not a bNNN id, so it takes no part in id allocation and will be skipped when the next id is computed.`,
    }));
}

/**
 * Every structural finding, ordered by first affected line. `ok: true` means
 * the file is free of the four collision-damage shapes — not that it is valid
 * YAML in every other respect, which only a strict load can say.
 *
 * MALFORMED_ID is included as INFO; a caller that wants to gate should filter
 * on the four collision shapes (DUPLICATE_ID / STUB_ENTRY / REPEATED_KEY /
 * SEQUENCE_KEY_INTRUSION). `damaged: true` reflects that filter — `ok` alone
 * mixes info in with the real hazards, so both signals are exposed.
 */
export function auditBacklog(text) {
  if (typeof text !== "string") throw new TypeError("auditBacklog(text): text must be a string");
  const entries = collectEntries(text);
  const findings = [
    ...auditDuplicateIds(entries),
    ...auditStubs(entries),
    ...auditRepeatedKeys(entries),
    ...auditSequenceIntrusions(text),
    ...auditMalformedIds(entries),
  ].sort((a, b) => a.lines[0] - b.lines[0]);

  const gatingCodes = new Set([
    AUDIT_CODES.DUPLICATE_ID,
    AUDIT_CODES.STUB_ENTRY,
    AUDIT_CODES.REPEATED_KEY,
    AUDIT_CODES.SEQUENCE_KEY_INTRUSION,
  ]);
  const damaged = findings.some((f) => gatingCodes.has(f.code));

  return { ok: findings.length === 0, damaged, findings, entryCount: entries.length };
}
