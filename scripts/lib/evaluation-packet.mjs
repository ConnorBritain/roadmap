// Pure evidence admission. Valid provenance is not proof of a claim's truth.
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

export const PACKET_VERSION = 1;
export const PACKET_MAX_BYTES = 16 * 1024 * 1024;
export const EVIDENCE_TYPES = Object.freeze(["source_code", "test", "documentation", "rendered_ui", "history", "other"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const SHA = /^[a-f0-9]{40}$/;
const SUPPORT = /^evidence\/.+\.(md|txt|log|json|yaml|yml|png|jpg|jpeg|webp)$/i;
const IMAGE = /\.(png|jpg|jpeg|webp)$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{16,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:authorization\s*:\s*bearer|(?:set-)?cookie\s*:)\s*\S{8,}/i,
  /\b(?:patient_name|patient_email|medical_record_number|social_security_number)\b["']?[ \t]*:[ \t]*["']?[^"'\r\n]{3,}/i,
];

export function safePacketPath(path) {
  return typeof path === "string" && path.length > 0 && path.length < 1024
    && !/^[A-Za-z]:/.test(path) && !/[\\\x00-\x1f\x7f]/.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}

export function packetDigest(files) {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    const bytes = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name]);
    hash.update(JSON.stringify([name, bytes.length]) + "\n"); hash.update(bytes);
  }
  return hash.digest("hex");
}

export function prohibitedDataFindings(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  // Never include matched values in errors, logs or receipts.
  return SECRET_PATTERNS.some((pattern) => pattern.test(text)) ? ["possible credential, session or patient data"] : [];
}

function timestamp(value, now) {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value))
    && Date.parse(value) <= now + 5 * 60 * 1000;
}
function strings(value) { return Array.isArray(value) && value.every((x) => typeof x === "string" && x.trim()); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }

// source(path, sha) is an injected frozen-tree lookup returning { type, mode,
// line_count? }. No network, shell execution or mutable filesystem lookup here.
export function validateEvaluationPacket({ run, assignment, files = {}, source = () => null, now = Date.now() }) {
  const errors = [];
  const fail = (code, location) => errors.push({ code, location: prohibitedDataFindings(location).length ? "redacted_location" : location });
  const names = Object.keys(files);
  const bytes = (name) => Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name] || "");
  if (names.reduce((sum, name) => sum + bytes(name).length, 0) > PACKET_MAX_BYTES) fail("packet_too_large", "packet");
  for (const name of names) {
    if (!safePacketPath(name)) fail("unsafe_path", "packet");
    if (prohibitedDataFindings(bytes(name)).length) fail("prohibited_data", name);
    if (!IMAGE.test(name) && (bytes(name).includes(0) || bytes(name).length > 2 * 1024 * 1024)) fail("invalid_text_artifact", name);
  }
  for (const required of ["REPORT.md", "evidence.yaml"]) if (!names.includes(required) || !bytes(required).length) fail("required_file_missing", required);
  let data;
  try {
    const doc = parseDocument(bytes("evidence.yaml").toString("utf8"), { uniqueKeys: true });
    if (doc.errors.length) throw new Error("invalid YAML");
    data = doc.toJS({ maxAliasCount: 0 });
    if (!object(data)) throw new Error("invalid mapping");
  } catch { fail("invalid_yaml", "evidence.yaml"); }
  if (!data) return { ok: false, errors, digest: packetDigest(files), evidence_present: false, counts: { records: 0 } };
  if (data.version !== PACKET_VERSION) fail("unsupported_packet_version", "version");
  const packet = object(data.packet) ? data.packet : {};
  for (const [key, expected] of [["run_id", run.run_id], ["assignment", assignment.id], ["base_sha", run.base_sha]]) {
    if (packet[key] !== expected) fail("identity_mismatch", `packet.${key}`);
  }
  if (!timestamp(packet.captured_at, now)) fail("invalid_timestamp", "packet.captured_at");
  if (!strings(packet.artifacts)) fail("invalid_artifact_declarations", "packet.artifacts");
  const declared = Array.isArray(packet.artifacts) ? packet.artifacts : [];
  if (new Set(declared).size !== declared.length) fail("duplicate_artifact", "packet.artifacts");
  for (const path of declared) {
    if (!safePacketPath(path) || !SUPPORT.test(path)) fail("unsupported_artifact", "packet.artifacts");
    else if (!names.includes(path)) fail("declared_artifact_missing", path);
  }
  for (const name of names) if (!["REPORT.md", "evidence.yaml", ...declared].includes(name)) fail("undeclared_artifact", name);
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  if (!Array.isArray(data.evidence) || !evidence.length) fail("evidence_required", "evidence");
  const ids = new Set();
  const report = bytes("REPORT.md").toString("utf8");
  const cited = [...report.matchAll(/\[\[evidence:([^\]]+)\]\]/g)].map((match) => match[1]);
  for (const [i, entry] of evidence.entries()) {
    const location = `evidence[${i}]`;
    if (!object(entry)) { fail("invalid_evidence", location); continue; }
    if (typeof entry.id !== "string" || !ID.test(entry.id)) fail("invalid_evidence_id", location);
    if (ids.has(entry.id)) fail("duplicate_evidence_id", location);
    ids.add(entry.id);
    if (!cited.includes(entry.id)) fail("uncited_evidence", location);
    if (!EVIDENCE_TYPES.includes(entry.type)) fail("unsupported_evidence_type", location);
    if (typeof entry.claim !== "string" || !entry.claim.trim()) fail("claim_required", location);
    if (!timestamp(entry.captured_at, now)) fail("invalid_timestamp", location);
    if (!strings(entry.limitations)) fail("limitations_required", location);
    if (!["source", "deployed"].includes(entry.boundary)) fail("boundary_required", location);
    if (entry.boundary === "deployed" && run.evidence_policy?.allow_deployed !== true) fail("deployed_evidence_not_allowed", location);
    if (assignment.evidence_types && !assignment.evidence_types.includes(entry.type)) fail("assignment_evidence_type_not_allowed", location);
    const refs = Array.isArray(entry.references) ? entry.references : [];
    if (!refs.length) fail("references_required", location);
    for (const ref of refs) {
      if (!object(ref) || (!!ref.path === !!ref.url)) { fail("invalid_reference", location); continue; }
      if (ref.path) {
        if (!safePacketPath(ref.path) || !SHA.test(ref.sha || "") || ref.sha !== run.base_sha) { fail("invalid_source_identity", location); continue; }
        const found = source(ref.path, ref.sha);
        if (!found || found.type !== "blob" || !["100644", "100755"].includes(found.mode)) fail("source_not_regular_file_at_baseline", location);
        if (ref.line_start != null || ref.line_end != null) {
          if (!Number.isInteger(ref.line_start) || !Number.isInteger(ref.line_end) || ref.line_start < 1 || ref.line_end < ref.line_start
            || !found || !Number.isInteger(found.line_count) || ref.line_end > found.line_count) fail("invalid_source_range", location);
        }
      } else {
        try {
          const url = new URL(ref.url);
          if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe URL");
          if (entry.boundary === "deployed" && !(run.evidence_policy?.public_hosts || []).includes(url.hostname)) fail("deployed_host_not_allowed", location);
        } catch { fail("invalid_reference_url", location); }
      }
    }
    if (entry.boundary === "source" && !refs.some((ref) => ref?.path)) fail("source_reference_required", location);
    if (entry.boundary === "deployed" && !refs.some((ref) => ref?.url)) fail("deployed_url_required", location);
    if (entry.type === "test") {
      const test = entry.test || {};
      if (!["passed", "failed", "not_run", "blocked"].includes(test.status) || typeof test.command !== "string" || !test.command.trim()
        || typeof test.result !== "string" || !test.result.trim()) fail("test_execution_record_required", location);
      if (["passed", "failed"].includes(test.status) && (!Number.isInteger(test.exit_code)
        || (test.status === "passed") !== (test.exit_code === 0))) fail("test_exit_code_mismatch", location);
      if (["not_run", "blocked"].includes(test.status) && test.exit_code != null) fail("unexecuted_test_has_exit_code", location);
    }
    if (entry.type === "rendered_ui" && (!strings(entry.artifacts) || !entry.artifacts.length
      || entry.artifacts.some((name) => !declared.includes(name) || !IMAGE.test(name)))) fail("rendered_evidence_requires_image", location);
  }
  for (const id of new Set(cited)) if (!ids.has(id)) fail("unknown_report_evidence_id", "REPORT.md");
  // Do not return worker-authored claims or references: validation diagnostics
  // may be logged before a human has inspected/redacted the packet.
  return { ok: errors.length === 0, errors, digest: packetDigest(files),
    evidence_present: evidence.length > 0 && ["REPORT.md", "evidence.yaml"].every((name) => names.includes(name) && bytes(name).length > 0),
    counts: { records: evidence.length, source: evidence.filter((e) => e?.boundary === "source").length,
      deployed: evidence.filter((e) => e?.boundary === "deployed").length } };
}
