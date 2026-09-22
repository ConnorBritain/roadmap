// roadmap — the github-pr GauntletArtifact (engineering executor). A pull request is the artifact:
// exact head = 40-hex head SHA, comments = PR issue comments (locator `…#issuecomment-N`), claims =
// protected refs under refs/heads/roadmap-gauntlet-locks/*, actor = the authenticated gh login.
// Exact PR heads and durable comments are correctness primitives, not bonuses, so GitHub is a
// stricter dependency here than in the provider-neutral low-level dispatch lock.
//
// The object exposes the canonical interface (see @connorbritain/roadmap-core/gauntlet-artifact.mjs)
// AND the legacy method names the runtime and its test fakes still use (getPr, viewerLogin, …).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { normalizeArtifact, normalizeComment, asGauntletArtifact } from "@connorbritain/roadmap-core/gauntlet-artifact.mjs";
import { parseGauntletPrMarkers, renderGauntletPrMarkers } from "@connorbritain/roadmap-core/gauntlet-core.mjs";
import { parseRoadmapMarker } from "@connorbritain/roadmap-core/subject-marker.mjs";
import { githubAuthorizationStore } from "./github-authority-store.mjs";

const CLAIM_BRANCH_PREFIX = "roadmap-gauntlet-locks";
const REQUIRED_CLAIM_RULES = Object.freeze(["creation", "update", "deletion", "non_fast_forward"]);

// Reduce a PR's statusCheckRollup (raw `gh` JSON) to one of: none | passing | pending | failing.
export function checksOf(pr) {
  const rollup = (pr && pr.statusCheckRollup) || [];
  if (!rollup.length) return "none";
  const states = rollup.map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "failing";
  if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED", ""].includes(s))) return "pending";
  return "passing";
}

// GitHub raw (gh --json) or an already-normalized artifact → the neutral Artifact shape, plus the
// GitHub-era aliases (isDraft, mergeStateStatus, headRefName, baseRefName, headRefOid) for callers
// that still read them. Comments gain `edited` from GitHub's edit metadata.
export function normalizeGauntletPr(raw) {
  if (!raw) return null;
  const mergeState = String(raw.mergeStateStatus || "").toUpperCase();
  const comments = (raw.comments || []).map((c) => normalizeComment({ ...c,
    edited: c && (c.edited === true || c.includesCreatedEdit === true) }));
  const neutral = normalizeArtifact({
    ...raw,
    draft: raw.draft != null ? !!raw.draft : !!raw.isDraft,
    mergeable: raw.mergeable || (["CONFLICTING", "DIRTY"].includes(mergeState) ? "conflicting"
      : ["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND", "BLOCKED"].includes(mergeState) ? "clean" : "unknown"),
    headRef: raw.headRef || raw.headRefName || null,
    baseRef: raw.baseRef || raw.baseRefName || null,
    currentHead: raw.currentHead || raw.headRefOid || null,
    checks: raw.checks || checksOf(raw),
    comments,
  });
  return {
    ...neutral,
    // GitHub-era aliases for engineering-side readers (pr-watch, doctor, the runtime's status view).
    isDraft: neutral.draft,
    mergeStateStatus: raw.mergeStateStatus || "",
    headRefName: neutral.headRef,
    baseRefName: neutral.baseRef,
    headRefOid: neutral.currentHead,
  };
}

function claimKindOf(claimKey) {
  const key = String(claimKey || "");
  if (key.startsWith("gauntlet:authority:")) return "authority";
  if (key.startsWith("gauntlet:implementation:")) return "implementation";
  if (key.startsWith("gauntlet:tombstone:")) return "tombstone";
  if (key.startsWith("gauntlet:cancellation:")) return "cancellation";
  if (key.includes(":critic:")) return "critic";
  if (key.includes(":repair:")) return "repair";
  throw new Error("cannot classify Gauntlet claim key");
}

export function claimDescriptor(claimKey, runId) {
  if (typeof runId !== "string" || !runId) throw new Error("Gauntlet claim requires a run id namespace");
  const namespace = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  const kind = claimKindOf(claimKey);
  const digest = createHash("sha256").update(claimKey).digest("hex");
  const name = `${namespace}-${kind}-${digest}`;
  return { kind, name, ref: `refs/heads/${CLAIM_BRANCH_PREFIX}/${name}` };
}

function safeRemoteDescription(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    const scp = /^([^@]+@)?([^:]+):(.+)$/.exec(String(value || ""));
    return scp ? `${scp[2]}:${scp[3]}` : "an unrecognized remote URL";
  }
}

function execOrThrow(execImpl, command, args, opts, label) {
  const r = execImpl(command, args, opts);
  if (r.error || r.status !== 0) {
    throw new Error(`${label}: ${(r.stderr || "").trim() || (r.error && r.error.message) || `exit ${r.status}`}`);
  }
  return r.stdout || "";
}

function jsonOrThrow(text, label) {
  try { return JSON.parse(text || "null"); }
  catch (e) { throw new Error(`${label} returned invalid JSON: ${e.message}`); }
}

// The worker-facing description of one exact head on this backend.
export function githubWorkerFetchInstructions(artifact, head) {
  const number = artifact && artifact.number;
  return {
    label: `PR #${number}`,
    fetch: `Fetch PR #${number} and resolve its current head to a full 40-hex SHA (expected ${head}).`,
  };
}

export function githubPrArtifact(root, { execImpl = spawnSync, remote = "origin" } = {}) {
  const run = (args, label) => execOrThrow(execImpl, "gh", args,
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, label);
  const getPr = (number) => normalizeGauntletPr(jsonOrThrow(run([
    "pr", "view", String(number), "--json",
    "number,url,title,body,state,isDraft,mergeStateStatus,headRefName,baseRefName,headRefOid,statusCheckRollup,comments,commits,createdAt,updatedAt",
  ], `gh pr view ${number} failed`), `gh pr view ${number}`));
  const candidates = (query) => jsonOrThrow(run([
    "pr", "list", "--state", "all", "--limit", "100", "--search", query,
    "--json", "number,url,title,body,state,headRefName,createdAt,updatedAt",
  ], "gh pr list failed"), "gh pr list") || [];
  let slugCache = null;
  const repositorySlug = () => {
    if (!slugCache) slugCache = run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], "cannot resolve GitHub repository").trim();
    return slugCache;
  };
  const call = (args) => execImpl("gh", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15000 });

  const adapter = {
    kind: "github-pr",
    supportsProtectedAuthority: true,
    assertAvailable() {
      const remoteUrl = execOrThrow(execImpl, "git", ["remote", "get-url", remote],
        { cwd: root, encoding: "utf8" }, `cannot read git remote ${remote}`).trim();
      if (!/(?:^|@|\/\/)github\.com[:/]/i.test(remoteUrl)) {
        throw new Error(`Gauntlet V1 requires a GitHub remote; ${remote} is ${remoteUrl ? safeRemoteDescription(remoteUrl) : "unset"}. Low-level dispatch remains provider-neutral.`);
      }
      execOrThrow(execImpl, "gh", ["auth", "status"], { cwd: root, encoding: "utf8", timeout: 10000 },
        "Gauntlet V1 requires an authenticated gh CLI (`gh auth login`)");
      return true;
    },
    // ── canonical interface ────────────────────────────────────────────────
    actor() { return run(["api", "user", "--jq", ".login"], "cannot resolve authenticated GitHub actor").trim(); },
    freeze({ run: gauntletRun, frozenBar }) {
      const packet = renderGauntletPrMarkers({ run: gauntletRun, subjectType: gauntletRun.subject_type, key: gauntletRun.subject_key, qualityBar: frozenBar });
      return { barSha256: gauntletRun.bar_sha256 || gauntletRun.barSha256, packet };
    },
    head(artifact) { return (artifact && artifact.currentHead) || null; },
    fetch(ref) {
      if (ref && typeof ref === "object") {
        if (ref.number != null) return getPr(ref.number);
        if (ref.runId) return adapter.findPrByRun(ref.runId);
        if (ref.subject) return ref.open ? adapter.findOpenPrBySubject(ref.subject.type, ref.subject.key) : adapter.findPrBySubject(ref.subject.type, ref.subject.key);
        throw new Error("fetch needs { number } | { runId } | { subject }");
      }
      return getPr(ref);
    },
    comment(ref, body) {
      const number = ref && typeof ref === "object" ? ref.number : ref;
      run(["pr", "comment", String(number), "--body", body], `gh pr comment ${number} failed`);
      return true;
    },
    ack(ref, body) { return adapter.comment(ref, body); },
    descendsFrom(baseSha, headSha) {
      const slug = repositorySlug();
      const comparison = jsonOrThrow(run(["api", `repos/${slug}/compare/${baseSha}...${headSha}`], "GitHub ancestry check failed"), "GitHub compare API");
      return comparison && ["ahead", "identical"].includes(comparison.status);
    },
    assertClaimSafety(claimKey, runId) {
      if (process.env.ROADMAP_GAUNTLET_UNSAFE_CLAIMS === "1") return { unsafe: true };
      const slug = repositorySlug();
      const { name, ref } = claimDescriptor(claimKey, runId);
      const branch = encodeURIComponent(`${CLAIM_BRANCH_PREFIX}/${name}`);
      const rules = jsonOrThrow(run(["api", `repos/${slug}/rules/branches/${branch}`],
        "cannot inspect effective GitHub rules for Gauntlet claim branches"), "GitHub effective branch rules") || [];
      const types = new Set(rules.map((rule) => rule && rule.type).filter(Boolean));
      const missing = REQUIRED_CLAIM_RULES.filter((type) => !types.has(type));
      if (missing.length) {
        throw new Error(`Gauntlet claim branch rules are unsafe for exact prospective ref ${ref} (missing ${missing.join(", ")}). Configure an active ruleset for ${CLAIM_BRANCH_PREFIX}/* with creation, update, deletion, and non-fast-forward rules. Separately verify in GitHub that only the trusted lead/service identity can bypass those rules and Routine workers cannot. Set ROADMAP_GAUNTLET_UNSAFE_CLAIMS=1 only for an explicitly accepted unsafe test environment.`);
      }
      return { unsafe: false, ref, rules: [...types] };
    },
    claim(claimKey, headSha, runId) {
      const slug = repositorySlug();
      const { ref, name } = claimDescriptor(claimKey, runId);
      const created = call(["api", "--method", "POST", `repos/${slug}/git/refs`, "-f", `ref=${ref}`, "-f", `sha=${headSha}`]);
      if (!created.error && created.status === 0) return { claimed: true, ref };
      // POST responses can be lost. Reconcile the deterministic ref before
      // deciding: existence means this conductor must not spend a Routine.
      const existing = call(["api", `repos/${slug}/git/ref/heads/${CLAIM_BRANCH_PREFIX}/${name}`]);
      if (!existing.error && existing.status === 0) {
        const parsed = jsonOrThrow(existing.stdout, "GitHub launch lock");
        if (parsed && parsed.object && parsed.object.sha === headSha) return { claimed: false, ref };
        throw new Error(`Gauntlet launch lock ${ref} points at an unexpected object`);
      }
      throw new Error("could not atomically claim or reconcile the GitHub Gauntlet launch lock");
    },
    readClaim(claimKey, runId) {
      const slug = repositorySlug();
      const { ref, name } = claimDescriptor(claimKey, runId);
      const result = call(["api", `repos/${slug}/git/ref/heads/${CLAIM_BRANCH_PREFIX}/${name}`]);
      if (!result.error && result.status === 0) {
        const parsed = jsonOrThrow(result.stdout, "GitHub launch lock");
        return { ref, sha: parsed && parsed.object && parsed.object.sha };
      }
      if (String(result.stderr || "").includes("HTTP 404")) return null;
      throw new Error(`could not inspect GitHub Gauntlet launch lock ${ref}: ${(result.stderr || "").trim() || (result.error && result.error.message) || `exit ${result.status}`}`);
    },
    listClaims(runId) {
      const slug = repositorySlug();
      const namespace = createHash("sha256").update(runId).digest("hex").slice(0, 16);
      const result = call(["api", `repos/${slug}/git/matching-refs/heads/${CLAIM_BRANCH_PREFIX}/${namespace}-`]);
      if ((result.error || result.status !== 0) && /HTTP (404|409)/.test(String(result.stderr || ""))) return [];
      if (result.error || result.status !== 0) {
        throw new Error(`could not inspect GitHub Gauntlet claims for ${runId}: ${(result.stderr || "").trim() || (result.error && result.error.message) || `exit ${result.status}`}`);
      }
      const refs = jsonOrThrow(result.stdout, "GitHub Gauntlet claim list") || [];
      const pattern = new RegExp(`^refs/heads/${CLAIM_BRANCH_PREFIX}/${namespace}-(implementation|critic|repair|cancellation|tombstone)-[0-9a-f]{64}$`);
      return refs.map((entry) => {
        const match = pattern.exec((entry && entry.ref) || "");
        return match ? { ref: entry.ref, kind: match[1], sha: entry.object && entry.object.sha } : null;
      }).filter(Boolean);
    },
    claimRef(claimKey, runId) { return claimDescriptor(claimKey, runId).ref; },
    workerFetchInstructions: githubWorkerFetchInstructions,
    authorityStore({ root: storeRoot = root, execImpl: storeExec = execImpl } = {}) {
      return githubAuthorizationStore(storeRoot, { github: adapter, execImpl: storeExec });
    },
    // ── discovery ──────────────────────────────────────────────────────────
    getPr,
    listGauntletPrs() {
      const prs = candidates('"roadmap-gauntlet" in:body');
      return { prs: prs.filter((pr) => parseGauntletPrMarkers(pr.body || "")), possibly_truncated: prs.length >= 100 };
    },
    findPrByRun(runId) {
      const exact = candidates(`in:body \"roadmap-gauntlet: run=${runId}\"`)
        .filter((pr) => { const parsed = parseGauntletPrMarkers(pr.body || ""); return parsed && parsed.runId === runId; });
      if (exact.length > 1) {
        throw new Error(`Gauntlet protocol collision: ${exact.length} PRs claim run ${runId} (${exact.map((p) => `#${p.number}`).join(", ")})`);
      }
      return exact.length ? getPr(exact[0].number) : null;
    },
    findPrBySubject(type, key) {
      const exact = candidates(`in:body \"roadmap: ${type}=${key}\"`)
        .filter((pr) => {
          const subject = parseRoadmapMarker(pr.body || "");
          const marker = parseGauntletPrMarkers(pr.body || "");
          return subject && subject.type === type && subject.key === key && marker;
        })
        .sort((a, b) => {
          const aOpen = String(a.state).toUpperCase() === "OPEN" ? 1 : 0;
          const bOpen = String(b.state).toUpperCase() === "OPEN" ? 1 : 0;
          return bOpen - aOpen || String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        });
      const open = exact.filter((pr) => String(pr.state).toUpperCase() === "OPEN");
      if (open.length > 1) {
        throw new Error(`Gauntlet protocol collision: ${open.length} open PRs claim ${type}:${key} (${open.map((p) => `#${p.number}`).join(", ")})`);
      }
      return open.length ? getPr(open[0].number) : (exact.length ? getPr(exact[0].number) : null);
    },
    findOpenPrBySubject(type, key) {
      const exact = candidates(`in:body \"roadmap: ${type}=${key}\"`)
        .filter((pr) => {
          const subject = parseRoadmapMarker(pr.body || "");
          return subject && subject.type === type && subject.key === key && String(pr.state).toUpperCase() === "OPEN";
        });
      if (exact.length > 1) {
        throw new Error(`roadmap PR collision: ${exact.length} open PRs claim ${type}:${key} (${exact.map((p) => `#${p.number}`).join(", ")})`);
      }
      return exact.length ? getPr(exact[0].number) : null;
    },
  };
  // Legacy method names (the runtime and its fakes).
  adapter.viewerLogin = adapter.actor;
  adapter.addComment = adapter.comment;
  adapter.isAncestor = adapter.descendsFrom;
  adapter.assertClaimProtection = adapter.assertClaimSafety;
  adapter.claimLaunch = adapter.claim;
  adapter.getLaunchClaim = adapter.readClaim;
  adapter.listRunClaims = adapter.listClaims;
  adapter.__gauntletArtifact = true;
  return adapter;
}

// Wrap any GitHub-shaped client (the real adapter or a test fake) so every artifact it returns is
// in the neutral shape and every canonical method name resolves. The runtime applies this once.
export function normalizingGauntletClient(client) {
  const base = asGauntletArtifact(client);
  const wrapResult = (value) => (value && typeof value.then === "function") ? value.then(normalizeGauntletPr) : normalizeGauntletPr(value);
  const wrapped = Object.create(null);
  for (const key of Object.keys(base)) wrapped[key] = base[key];
  for (const name of ["getPr", "findPrByRun", "findPrBySubject", "findOpenPrBySubject"]) {
    if (typeof base[name] === "function") wrapped[name] = (...args) => wrapResult(base[name](...args));
  }
  wrapped.fetch = (ref) => {
    if (ref && typeof ref === "object") {
      if (ref.number != null) return wrapped.getPr(ref.number);
      if (ref.runId) return wrapped.findPrByRun(ref.runId);
      if (ref.subject) return ref.open && wrapped.findOpenPrBySubject ? wrapped.findOpenPrBySubject(ref.subject.type, ref.subject.key) : wrapped.findPrBySubject(ref.subject.type, ref.subject.key);
      throw new Error("fetch needs { number } | { runId } | { subject }");
    }
    return wrapped.getPr(ref);
  };
  if (typeof wrapped.workerFetchInstructions !== "function" || wrapped.kind === "unknown") wrapped.workerFetchInstructions = githubWorkerFetchInstructions;
  wrapped.kind = base.kind === "unknown" ? "github-pr" : base.kind;
  wrapped.__gauntletArtifact = true;
  return wrapped;
}

// The GitHub-era name.
export const githubClient = githubPrArtifact;
