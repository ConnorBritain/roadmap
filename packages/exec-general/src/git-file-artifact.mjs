// roadmap — the git-file GauntletArtifact (general profile). The artifact is a FILE in this git
// repository; its exact version identity is the last commit that touched it. The frozen-bar packet
// and every protocol comment live in an append-only sidecar under .roadmap/gauntlet/<slug>/, each
// entry committed the moment it is posted, so immutability is checkable against git history and
// claims are atomic git refs (create-if-absent via `git update-ref` with a zero old value).
//
// Ref forms fetch() accepts: { number: <path|artifactNumber> } | { path } | { runId } | { subject: { type, key } }.
// Nothing here is GitHub-shaped: the protocol sees the neutral Artifact/Comment shapes only.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { isActorIdentity } from "@connorbritain/roadmap-core/gauntlet-artifact.mjs";
import { renderGauntletPrMarkers, parseGauntletPrMarkers } from "@connorbritain/roadmap-core/gauntlet-core.mjs";

export const GAUNTLET_DIR = posix.join(".roadmap", "gauntlet");
export const LOCK_REF_ROOT = "refs/roadmap-gauntlet-locks";
const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// A stable positive integer for the artifact (the protocol's prompt builders want a number; the
// wording the worker reads names the path).
export const artifactNumberOf = (path) => parseInt(sha256(path).slice(0, 7), 16) + 1;
export const artifactSlug = (path) => path.replace(/[^A-Za-z0-9._-]+/g, "_");
export const artifactUrl = (path) => `git-file://${path}`;

export function gitFileArtifact(root, { execImpl = spawnSync, remote = "origin", baseBranch = "main", now = () => new Date().toISOString() } = {}) {
  const git = (...args) => {
    const r = execImpl("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
  };
  const must = (...args) => { const r = git(...args); if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`); return r.stdout; };
  const sidecarDir = (path) => posix.join(GAUNTLET_DIR, artifactSlug(path));
  const packetFile = (path) => posix.join(sidecarDir(path), "packet.md");
  const commentsFile = (path) => posix.join(sidecarDir(path), "comments.jsonl");
  const abs = (rel) => join(root, ...rel.split("/"));
  const commitPaths = (message, paths) => {
    must("add", "--", ...paths);
    must("commit", "-q", "-m", message, "--", ...paths);
    return must("rev-parse", "HEAD").trim();
  };
  const lastCommitTouching = (rel) => { const r = git("log", "-1", "--format=%H", "HEAD", "--", rel); const sha = r.stdout.trim(); return SHA_RE.test(sha) ? sha : null; };
  const commitsTouching = (rel) => git("log", "--format=%H", "HEAD", "--", rel).stdout.split("\n").map((s) => s.trim()).filter((s) => SHA_RE.test(s));
  const commitTime = (sha) => { const r = git("log", "-1", "--format=%cI", sha); return r.status === 0 ? r.stdout.trim() : null; };
  const currentBranch = () => { const r = git("rev-parse", "--abbrev-ref", "HEAD"); return r.status === 0 ? r.stdout.trim() : null; };
  const readEntries = (rel) => existsSync(abs(rel)) ? readFileSync(abs(rel), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  // The entry as it was committed: the comment is immutable only if the working copy still says
  // exactly what the commit that introduced it recorded. The introducing commit is found by content
  // (git log -S on the entry's id), so no index of commit shas has to be kept — or trusted.
  const introducedIn = (rel, id) => {
    const r = git("log", "--format=%H", "--reverse", "-S", `"id":${id},`, "--", rel);
    const sha = r.stdout.split("\n").map((x) => x.trim()).find((x) => SHA_RE.test(x));
    return sha || null;
  };
  const committedEntry = (rel, entry) => {
    const sha = entry && introducedIn(rel, entry.id);
    if (!sha) return null;
    const r = git("show", `${sha}:${rel}`);
    if (r.status !== 0) return null;
    return r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e && e.id === entry.id) || null;
  };
  const listArtifacts = () => {
    const dir = abs(GAUNTLET_DIR);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const slug of readdirSync(dir)) {
      const pf = join(dir, slug, "packet.md");
      if (!existsSync(pf)) continue;
      const packet = readFileSync(pf, "utf8");
      const m = /^<!-- roadmap-gauntlet-artifact path=(\S+) -->/m.exec(packet);
      if (m) out.push({ path: m[1], packet });
    }
    return out;
  };
  const resolvePath = (ref) => {
    if (ref == null) return null;
    if (typeof ref === "string") return ref;
    if (typeof ref === "number") return (listArtifacts().find((a) => artifactNumberOf(a.path) === ref) || {}).path || null;
    if (ref.path) return ref.path;
    if (ref.number != null) return typeof ref.number === "number" ? resolvePath(ref.number) : String(ref.number);
    if (ref.runId || ref.run_id) {
      const want = ref.runId || ref.run_id;
      return (listArtifacts().find((a) => { const mk = parseGauntletPrMarkers(a.packet); return mk && mk.runId === want; }) || {}).path || null;
    }
    if (ref.subject) {
      const { type, key } = ref.subject;
      return (listArtifacts().find((a) => { const mk = parseGauntletPrMarkers(a.packet); return mk && mk.subjectType === type && mk.key === key; }) || {}).path || null;
    }
    return null;
  };
  const kindOf = (key) => key.startsWith("gauntlet:authority:") ? "authority" : key.startsWith("gauntlet:implementation:") ? "implementation"
    : key.startsWith("gauntlet:tombstone:") ? "tombstone" : key.startsWith("gauntlet:cancellation:") ? "cancellation"
    : key.includes(":critic:") ? "critic" : key.includes(":repair:") ? "repair" : "other";

  const adapter = {
    kind: "git-file",
    supportsProtectedAuthority: false,
    assertAvailable() {
      const r = git("rev-parse", "--is-inside-work-tree");
      if (r.status !== 0 || r.stdout.trim() !== "true") throw new Error(`${root} is not a git repository; the git-file artifact needs one`);
      return true;
    },
    actor() {
      const email = git("config", "user.email").stdout.trim();
      const name = git("config", "user.name").stdout.trim();
      const id = email || name;
      if (!isActorIdentity(id)) throw new Error("git identity is not configured (git config user.email); the general Gauntlet needs a bounded lead identity");
      return id;
    },
    freeze({ run, frozenBar }) {
      return { barSha256: run.bar_sha256, packet: renderGauntletPrMarkers({ run, subjectType: run.subject_type, key: run.subject_key, qualityBar: frozenBar }) };
    },
    head(artifact) { return (artifact && artifact.currentHead) || null; },
    fetch(ref) {
      const path = resolvePath(ref);
      if (!path) return null;
      const pf = packetFile(path), cf = commentsFile(path);
      const packetExists = existsSync(abs(pf));
      const docExists = existsSync(abs(path));
      if (!packetExists && !docExists && !commitsTouching(path).length) return null;
      const body = packetExists ? readFileSync(abs(pf), "utf8") : "";
      const commits = commitsTouching(path);
      const currentHead = commits[0] || null;
      const comments = readEntries(cf).map((e) => {
        const committed = committedEntry(cf, e);
        const edited = !committed || committed.body !== e.body || committed.author !== e.author || committed.createdAt !== e.createdAt;
        return { body: String(e.body || ""), author: e.author || null, createdAt: e.createdAt || null,
          updatedAt: edited ? (commitTime(lastCommitTouching(cf)) || now()) : (e.createdAt || null), edited, url: `${artifactUrl(path)}#comment-${e.id}` };
      });
      const created = commits.length ? commitTime(commits[commits.length - 1]) : null;
      return { id: path, number: artifactNumberOf(path), url: artifactUrl(path), title: path, body, state: "OPEN", draft: false, mergeable: "clean",
        headRef: currentBranch(), baseRef: baseBranch, currentHead, checks: "none", comments, commits, createdAt: created, updatedAt: currentHead ? commitTime(currentHead) : created,
        path, packetPath: pf, commentsPath: cf };
    },
    comment(ref, body) {
      const path = resolvePath(ref);
      if (!path) throw new Error("no such artifact");
      const cf = commentsFile(path);
      mkdirSync(dirname(abs(cf)), { recursive: true });
      const id = readEntries(cf).length + 1;
      const entry = { id, body, author: adapter.actor(), createdAt: now(), body_sha256: sha256(body) };
      appendFileSync(abs(cf), JSON.stringify(entry) + "\n");
      commitPaths(`gauntlet: comment ${id} on ${path}`, [cf]);   // the artifact's own head is untouched
      return true;
    },
    ack(ref, body) { return adapter.comment(ref, body); },
    descendsFrom(ancestor, head) {
      if (!SHA_RE.test(ancestor || "") || !SHA_RE.test(head || "")) return false;
      return git("merge-base", "--is-ancestor", ancestor, head).status === 0;
    },
    claimRef(key, runId) { return `${LOCK_REF_ROOT}/${runId}/${kindOf(key)}/${sha256(key).slice(0, 32)}`; },
    assertClaimSafety(key, runId) {
      // Local refs are atomic for every conductor sharing this repository, but nothing protects
      // them from a `git update-ref -d`; say so instead of pretending a ruleset exists.
      return { unsafe: false, ref: adapter.claimRef(key, runId), rules: ["local git refs: atomic create-if-absent; no remote protection"] };
    },
    claim(key, head, runId) {
      if (!SHA_RE.test(head || "")) throw new Error("claim requires a 40-hex head");
      const ref = adapter.claimRef(key, runId);
      const r = git("update-ref", ref, head, ZERO);
      return { claimed: r.status === 0, ref };
    },
    readClaim(key, runId) {
      const ref = adapter.claimRef(key, runId);
      const r = git("rev-parse", "--verify", "-q", ref);
      return r.status === 0 && SHA_RE.test(r.stdout.trim()) ? { ref, sha: r.stdout.trim() } : null;
    },
    listClaims(runId) {
      const r = git("for-each-ref", "--format=%(refname) %(objectname)", `${LOCK_REF_ROOT}/${runId}/`);
      if (r.status !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => { const [ref, sha] = line.split(" "); return { ref, sha, kind: ref.split("/")[3] || "other" }; });
    },
    workerFetchInstructions(artifact, head) {
      const path = (artifact && (artifact.path || artifact.id)) || resolvePath(artifact) || "<artifact>";
      return { label: `file ${path} at commit ${head}`,
        fetch: `In this repository run \`git log -1 --format=%H HEAD -- ${path}\` and confirm it prints exactly ${head}; then read the file at that commit (\`git show ${head}:${path}\`).` };
    },
    // ── general-profile extras (not part of the core interface) ──────────────
    // The lead attaches the frozen packet to the artifact's sidecar and commits it. The artifact's
    // own head is untouched (the packet is not the deliverable).
    publishPacket(path, packet) {
      const pf = packetFile(path);
      mkdirSync(dirname(abs(pf)), { recursive: true });
      writeFileSync(abs(pf), `<!-- roadmap-gauntlet-artifact path=${path} -->\n${packet}`);
      return commitPaths(`gauntlet: freeze bar for ${path}`, [pf]);
    },
    sidecarDir, packetFile, commentsFile, listArtifacts,
    lastCommitTouching, commitsTouching,
  };
  return adapter;
}
