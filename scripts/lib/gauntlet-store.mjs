// roadmap — minimal local Gauntlet launch ledger.
//
// GitHub is the durable artifact/event log. This gitignored JSON file only closes the
// pre-PR dispatch window and records Routine launch receipts that GitHub cannot know.
// Writes are lock-guarded and atomic so two lead processes cannot both launch the same role.

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";

export const GAUNTLET_LEDGER_VERSION = 1;
export const GAUNTLET_STATE_FILE = ".roadmap-gauntlet-state.json";
const LOCK_FILE = ".roadmap-gauntlet-state.lock";

export function emptyGauntletLedger() {
  return { version: GAUNTLET_LEDGER_VERSION, runs: {} };
}

export function readGauntletLedger(root) {
  const path = join(root, GAUNTLET_STATE_FILE);
  if (!existsSync(path)) return emptyGauntletLedger();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${GAUNTLET_STATE_FILE} is unreadable — refusing to forget launch receipts: ${e.message}`);
  }
  if (!parsed || parsed.version !== GAUNTLET_LEDGER_VERSION || !parsed.runs || typeof parsed.runs !== "object" || Array.isArray(parsed.runs)) {
    throw new Error(`${GAUNTLET_STATE_FILE} has an unsupported shape (expected version ${GAUNTLET_LEDGER_VERSION} with a runs mapping)`);
  }
  return parsed;
}

export function writeGauntletLedger(root, ledger) {
  const target = join(root, GAUNTLET_STATE_FILE);
  const temp = join(root, `${GAUNTLET_STATE_FILE}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

export function mutateGauntletLedger(root, mutate) {
  const lockPath = join(root, LOCK_FILE);
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created_at: new Date().toISOString() }) + "\n", "utf8");
    } catch (writeError) {
      try { closeSync(fd); } catch { /* best effort */ }
      fd = undefined;
      try { unlinkSync(lockPath); } catch { /* best effort */ }
      throw writeError;
    }
  } catch (e) {
    if (!(e && e.code === "EEXIST")) throw e;
    let owner = "unknown owner";
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      owner = `pid ${parsed.pid || "?"} on ${parsed.host || "?"} since ${parsed.created_at || "?"}`;
    } catch { /* keep fail-closed */ }
    // Never auto-delete by pathname: a delayed stale-lock reclaimer can unlink a
    // replacement live lock. Owner metadata makes manual recovery auditable.
    throw new Error(`another Gauntlet mutation is in progress (${owner}) — retry after it finishes; after a confirmed process crash and with no Gauntlet command active, remove ${LOCK_FILE} manually`);
  }
  try {
    const ledger = readGauntletLedger(root);
    const result = mutate(ledger);
    writeGauntletLedger(root, ledger);
    return result;
  } finally {
    try { if (fd != null) closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

const TERMINAL = new Set(["passed", "human_required", "exhausted", "cancelled", "merged", "closed"]);

export function findLedgerRun(ledger, idOrKey, { activeOnly = false } = {}) {
  if (!idOrKey) return null;
  const exact = ledger.runs[idOrKey];
  if (exact && (!activeOnly || !TERMINAL.has(exact.last_state))) return exact;
  const matches = Object.values(ledger.runs)
    .filter((run) => run && run.subject_key === idOrKey)
    .filter((run) => !activeOnly || !TERMINAL.has(run.last_state))
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return matches[0] || null;
}

function nonceProof(launch) {
  const explicit = launch && (launch.nonce_sha256 || launch.nonceSha256);
  if (explicit) return explicit;
  const nonce = launch && launch.nonce;
  return nonce ? createHash("sha256").update(nonce).digest("hex") : null;
}

export function launchReceipt(run, { role, round, expectedHead = null, criticRole = null, provider = null,
  attempt = null, nonce = null, nonceSha256 = null, packetSha256 = null } = {}) {
  const expectedNonceProof = nonceSha256
    || (nonce ? createHash("sha256").update(nonce).digest("hex") : null);
  return [...(run.launches || [])].reverse().find((launch) => launch
    && !["preflight_failed", "aborted_stale", "invalid_result", "duplicate_remote", "superseded_remote"].includes(launch.status)
    && launch.role === role
    && Number(launch.round) === Number(round)
    && (launch.expected_head || null) === (expectedHead || null)
    && (launch.critic_role || null) === (criticRole || null)
    && (provider == null || (launch.provider || "claude") === provider)
    && (attempt == null || Number(launch.attempt || 1) === Number(attempt))
    && (!expectedNonceProof || nonceProof(launch) === expectedNonceProof)
    && (!packetSha256 || (launch.packet_sha256 || launch.packetSha256) === packetSha256)) || null;
}
