// Repository IO for evidence collection. The cloud patch is validated in a
// disposable Git index, never by editing the source checkout speculatively.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { assignmentDirectory, assertEvaluationDiffPaths } from "./evaluation-core.mjs";
import { PACKET_MAX_BYTES, safePacketPath, validateEvaluationPacket } from "./evaluation-packet.mjs";

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

function filesFromIndex(root, directory, env) {
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
    if (size > PACKET_MAX_BYTES) throw new Error("evaluation packet exceeds byte limit");
    files[name] = bytes;
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

export function inspectLocalEvaluationPacket(root, { run, assignment, now }) {
  const directory = assignmentDirectory(run.run_id, assignment.id, run.artifact_root);
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
      if (info.size + size > PACKET_MAX_BYTES) throw new Error("evaluation packet exceeds byte limit");
      const bytes = readFileSync(full); size += bytes.length;
      if (size > PACKET_MAX_BYTES) throw new Error("evaluation packet exceeds byte limit");
      files[relative(join(root, directory), full).split("\\").join("/")] = bytes;
    }
  }
  visit(join(root, directory));
  return validateEvaluationPacket({ run, assignment, files, source: frozenSourceLookup(root), now });
}
