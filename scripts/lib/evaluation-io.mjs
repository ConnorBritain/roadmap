// Repository IO for evidence collection. The cloud patch is validated in a
// disposable Git index, never by editing the source checkout speculatively.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { assignmentDirectory, assertEvaluationDiffPaths, changedPathsFromUnifiedDiff, evaluationDirectory } from "./evaluation-core.mjs";
import { PACKET_MAX_BYTES, safePacketPath, validateEvaluationPacket, prohibitedDataFindings, packetDigest } from "./evaluation-packet.mjs";

export function evaluationCommand(root, command, args, { input, env, encoding = "utf8", execImpl = spawnSync } = {}) {
  const result = execImpl(command, args, { cwd: root, input, env, encoding, maxBuffer: 32 * 1024 * 1024 });
  // Do not echo arbitrary stderr: a provider, patch or source can contain credentials.
  if (result.error || result.status !== 0) throw new Error(`${command} operation failed (exit ${result.status ?? "unknown"}); inspect the operation locally without publishing raw output`);
  return result.stdout || (encoding ? "" : Buffer.alloc(0));
}

export function assertNoSymlinkAncestors(root, path) {
  if (!safePacketPath(path)) throw new Error("unsafe evaluation path");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error("evaluation path has a symbolic-link ancestor or target");
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

export function frozenSourceLookup(root) {
  const cache = new Map();
  return (path, sha) => {
    if (!safePacketPath(path) || !/^[a-f0-9]{40}$/.test(sha)) return null;
    const key = `${sha}:${path}`;
    if (cache.has(key)) return cache.get(key);
    const result = evaluationCommand(root, "git", ["--literal-pathspecs", "ls-tree", "-z", sha, "--", path]);
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([^\0]+)\0$/.exec(result);
    if (!match || match[4] !== path) { cache.set(key, null); return null; }
    const entry = { mode: match[1], type: match[2] };
    if (entry.type === "blob" && ["100644", "100755"].includes(entry.mode)) {
      const text = evaluationCommand(root, "git", ["cat-file", "blob", match[3]]);
      entry.line_count = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    }
    cache.set(key, entry); return entry;
  };
}

function filesFromIndex(root, directory, env, maxBytes = PACKET_MAX_BYTES) {
  const output = evaluationCommand(root, "git", ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", directory], { env });
  const files = Object.create(null);
  let size = 0;
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/.exec(record);
    if (!match || match[1] !== "100644" || match[3] !== "0" || !match[4].startsWith(directory + "/")) throw new Error("evaluation packet contains an unsupported Git entry");
    const name = match[4].slice(directory.length + 1);
    if (!safePacketPath(name)) throw new Error("unsafe packet file");
    const bytes = evaluationCommand(root, "git", ["cat-file", "blob", match[2]], { env, encoding: null });
    size += bytes.length;
    if (size > maxBytes) throw new Error("evaluation packet/corpus exceeds byte limit");
    files[name] = bytes;
  }
  return files;
}

export function evaluationFilesAtCommit(root, sha, directory) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !safePacketPath(directory)) throw new Error("unsafe evidence tree identity");
  const records = evaluationCommand(root, "git", ["--literal-pathspecs", "ls-tree", "-r", "-z", sha, "--", directory]);
  const files = Object.create(null); let size = 0;
  for (const record of records.split("\0").filter(Boolean)) {
    const match = /^100644 blob ([a-f0-9]{40})\t([^\0]+)$/.exec(record);
    if (!match || !safePacketPath(match[2]) || !match[2].startsWith(directory + "/")) throw new Error("unsupported evidence Git file mode or path");
    const bytes = evaluationCommand(root, "git", ["cat-file", "blob", match[1]], { encoding: null });
    size += bytes.length;
    if (size > 64 * 1024 * 1024) throw new Error("evaluation corpus exceeds 64 MiB");
    if (prohibitedDataFindings(bytes).length) throw new Error("committed evidence corpus contains detected prohibited data");
    files[match[2].slice(directory.length + 1)] = bytes;
  }
  return files;
}

export function inspectEvaluationPatch(root, { run, assignment, diff, now }) {
  const paths = assertEvaluationDiffPaths({ runId: run.run_id, assignmentId: assignment.id, artifactRoot: run.artifact_root, diff });
  const directory = assignmentDirectory(run.run_id, assignment.id, run.artifact_root);
  for (const path of paths) assertNoSymlinkAncestors(root, path);
  // Initial and correction patches are based on the committed local artifact;
  // neither staged nor untracked files may be overwritten by collection.
  const dirty = evaluationCommand(root, "git", ["--literal-pathspecs", "status", "--porcelain", "--untracked-files=all", "--", directory]);
  if (dirty.trim()) throw new Error("evaluation packet has local changes; commit or relocate them before collection");
  const temp = mkdtempSync(join(tmpdir(), "roadmap-evidence-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
    evaluationCommand(root, "git", ["read-tree", "HEAD"], { env });
    if (packetDigest(readEvaluationFiles(root, directory)) !== packetDigest(filesFromIndex(root, directory, env))) {
      throw new Error("local packet bytes differ from the committed base, including ignored or assume-unchanged files");
    }
    evaluationCommand(root, "git", ["apply", "--cached", "--whitespace=nowarn", "-"], { env, input: diff });
    const actualPaths = evaluationCommand(root, "git", ["diff", "--cached", "--name-only", "-z", "HEAD"], { env }).split("\0").filter(Boolean);
    if (!actualPaths.length || actualPaths.some((path) => !path.startsWith(directory + "/") || !paths.includes(path))) {
      throw new Error("Git patch paths differ from validated packet headers");
    }
    const files = filesFromIndex(root, directory, env);
    const validation = validateEvaluationPacket({ run, assignment, files, source: frozenSourceLookup(root), now });
    return { ...validation, paths: validation.ok ? paths : [], patch_digest: createHash("sha256").update(diff).digest("hex") };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function applyEvaluationPatch(root, args) {
  const validation = inspectEvaluationPatch(root, args);
  if (!validation.ok) return validation;
  for (const path of validation.paths) assertNoSymlinkAncestors(root, path);
  evaluationCommand(root, "git", ["apply", "--check", "--whitespace=nowarn", "-"], { input: args.diff });
  evaluationCommand(root, "git", ["apply", "--whitespace=nowarn", "-"], { input: args.diff });
  const applied = inspectLocalEvaluationPacket(root, args);
  if (!applied.ok || applied.digest !== validation.digest) throw new Error("applied packet differs from validated content; collection was not recorded");
  return validation;
}

function readEvaluationFiles(root, directory, maxBytes = PACKET_MAX_BYTES) {
  assertNoSymlinkAncestors(root, directory);
  const files = Object.create(null);
  let size = 0;
  function visit(path) {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("packet contains a symlink or special file");
      if (entry.isDirectory()) { visit(full); continue; }
      const info = lstatSync(full);
      if ((info.mode & 0o111) !== 0) throw new Error("packet contains an executable file");
      if (info.size + size > maxBytes) throw new Error("evaluation packet/corpus exceeds byte limit");
      const bytes = readFileSync(full); size += bytes.length;
      if (size > maxBytes) throw new Error("evaluation packet/corpus exceeds byte limit");
      files[relative(join(root, directory), full).split("\\").join("/")] = bytes;
    }
  }
  visit(join(root, directory));
  return files;
}

export function inspectLocalEvaluationPacket(root, { run, assignment, now }) {
  const directory = assignmentDirectory(run.run_id, assignment.id, run.artifact_root);
  const files = readEvaluationFiles(root, directory);
  return validateEvaluationPacket({ run, assignment, files, source: frozenSourceLookup(root), now });
}

export function inspectEvaluationRepairPatch(root, { run, reservation, diff, now }) {
  const paths = changedPathsFromUnifiedDiff(diff);
  const allowed = reservation?.request.allowed_paths;
  if (reservation?.role !== "repair" || !Array.isArray(allowed) || paths.some((path) => !allowed.includes(path))) throw new Error("repair diff escapes the lead-approved exact file list");
  if (evaluationCommand(root, "git", ["rev-parse", "HEAD"]).trim() !== reservation.expected_head) throw new Error("repair collection expected head moved; never force-apply an old repair");
  const directory = evaluationDirectory(run.run_id, run.artifact_root);
  if (paths.some((path) => !safePacketPath(path) || !path.startsWith(directory + "/"))) throw new Error("repair diff escapes run documentation");
  for (const line of String(diff).split("\n")) {
    if ((/^(?:new file|deleted file|old|new) mode /.test(line) && !line.endsWith(" 100644")) || /^(?:rename|copy) (?:from|to) /.test(line)) throw new Error("repair diff contains unsupported modes or renames");
  }
  for (const path of paths) assertNoSymlinkAncestors(root, path);
  // All packet files are revalidated, so require the whole corpus to match its
  // committed base instead of trusting only the files named by the worker.
  if (evaluationCommand(root, "git", ["--literal-pathspecs", "status", "--porcelain", "--untracked-files=all", "--", directory]).trim()) throw new Error("commit or relocate local corpus changes before repair collection");
  const temp = mkdtempSync(join(tmpdir(), "roadmap-repair-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
    evaluationCommand(root, "git", ["read-tree", "HEAD"], { env });
    if (packetDigest(readEvaluationFiles(root, directory, 64 * 1024 * 1024)) !== packetDigest(filesFromIndex(root, directory, env, 64 * 1024 * 1024))) {
      throw new Error("local corpus bytes differ from the committed repair base");
    }
    evaluationCommand(root, "git", ["apply", "--cached", "--whitespace=nowarn", "-"], { env, input: diff });
    const actual = evaluationCommand(root, "git", ["diff", "--cached", "--name-only", "-z", "HEAD"], { env }).split("\0").filter(Boolean);
    if (!actual.length || actual.some((path) => !allowed.includes(path) || !paths.includes(path))) throw new Error("actual repair patch differs from its allowed headers");
    const files = filesFromIndex(root, directory, env, 64 * 1024 * 1024);
    if (Object.values(files).some((bytes) => prohibitedDataFindings(bytes).length)) throw new Error("repair corpus contains detected prohibited data");
    const packets = run.assignments.map((assignment) => {
      const prefix = `inbox/${assignment.id}/`;
      const packet = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => [path.slice(prefix.length), bytes]));
      return { assignment: assignment.id, ...validateEvaluationPacket({ run, assignment, files: packet, source: frozenSourceLookup(root), now }) };
    });
    const artifact_digests = Object.fromEntries(paths.map((path) => {
      const file = files[path.slice(directory.length + 1)];
      return [path, file ? createHash("sha256").update(file).digest("hex") : null];
    }));
    return { ok: packets.every((packet) => packet.ok), packets, paths, artifact_digests, patch_digest: createHash("sha256").update(diff).digest("hex") };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function applyEvaluationRepairPatch(root, args) {
  const validation = inspectEvaluationRepairPatch(root, args);
  if (!validation.ok) return validation;
  for (const path of validation.paths) assertNoSymlinkAncestors(root, path);
  evaluationCommand(root, "git", ["apply", "--check", "--whitespace=nowarn", "-"], { input: args.diff });
  evaluationCommand(root, "git", ["apply", "--whitespace=nowarn", "-"], { input: args.diff });
  for (const [path, expected] of Object.entries(validation.artifact_digests)) {
    let actual = null;
    try { actual = createHash("sha256").update(readFileSync(join(root, path))).digest("hex"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    if (actual !== expected) throw new Error("repair artifact differs from the validated patch; collection was not recorded");
  }
  for (const assignment of args.run.assignments) {
    const applied = inspectLocalEvaluationPacket(root, { run: args.run, assignment });
    if (!applied.ok || applied.digest !== validation.packets.find((packet) => packet.assignment === assignment.id).digest) throw new Error("repair application differs from validated packets; collection was not recorded");
  }
  return validation;
}
