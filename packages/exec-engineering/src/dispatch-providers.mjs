// roadmap — git provider adapters for the in-flight dispatch check.
//
// The cross-engine dispatch lock scans open PRs for a canonical marker line.
// Which "PRs" and how to list them depends on the git host: GitHub calls
// them PRs, GitLab calls them Merge Requests, Bitbucket calls them Pull
// Requests, Gitea calls them PRs. Each ships a different CLI (gh / glab /
// tea / bb), and each host may be self-hosted at a different domain.
//
// Rather than hard-coding `gh` — which silently returns "no protection" for
// every non-GitHub repo — this module exposes a small registry of adapters
// keyed by remote URL pattern, with a git-native fallback that needs no
// vendor CLI at all.
//
// Contract of an adapter:
//
//   {
//     name: string                     // e.g. "github", "gitlab", "git-native"
//     detect(remoteUrl): boolean       // does this adapter claim this remote?
//     available(): { ok: boolean, reason?: string }  // is the tool actually usable?
//     listOpenPrs(marker, opts): [{ number, url, body, createdAt }, ...]
//   }
//
// availability + listing are separate so `roadmap doctor` can surface WHY a
// repo is not getting protection (adapter claimed, but CLI missing / not
// authed / wrong host) without every dispatch paying the cost of failing.

import { spawnSync } from "node:child_process";

// ── github (gh) ───────────────────────────────────────────────────────────────
export const githubAdapter = {
  name: "github",
  detect(remoteUrl) {
    return /(?:^|@|\/\/)(?:github\.com|gh\.[a-z0-9.-]+)[:/]/.test(remoteUrl || "");
  },
  available({ execImpl = spawnSync } = {}) {
    const r = execImpl("gh", ["auth", "status"], { encoding: "utf8" });
    if (r.error) return { ok: false, reason: "gh CLI is not installed (https://cli.github.com)" };
    if (r.status !== 0) return { ok: false, reason: "gh CLI is installed but not authed — run 'gh auth login'" };
    return { ok: true };
  },
  listOpenPrs(marker, { root = process.cwd(), execImpl = spawnSync } = {}) {
    const r = execImpl(
      "gh",
      ["pr", "list", "--state", "open", "--search", `in:body ${marker}`, "--json", "number,url,body,createdAt", "--limit", "50"],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.status !== 0) throw new Error(`gh pr list failed: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
    return JSON.parse(r.stdout || "[]");
  },
};

// ── gitlab (glab) ─────────────────────────────────────────────────────────────
export const gitlabAdapter = {
  name: "gitlab",
  detect(remoteUrl) {
    return /(?:^|@|\/\/)(?:gitlab\.com|gitlab\.[a-z0-9.-]+)[:/]/.test(remoteUrl || "");
  },
  available({ execImpl = spawnSync } = {}) {
    const r = execImpl("glab", ["auth", "status"], { encoding: "utf8" });
    if (r.error) return { ok: false, reason: "glab CLI is not installed (https://gitlab.com/gitlab-org/cli)" };
    if (r.status !== 0) return { ok: false, reason: "glab CLI is installed but not authed — run 'glab auth login'" };
    return { ok: true };
  },
  listOpenPrs(marker, { root = process.cwd(), execImpl = spawnSync } = {}) {
    // glab has no direct body-search flag, so list open MRs and filter in-process.
    // The `--per-page 100` cap matches gh's --limit 50 in practical terms; a repo
    // with more than 100 open MRs carrying a specific marker is already broken.
    const r = execImpl(
      "glab",
      ["mr", "list", "--state", "opened", "--per-page", "100", "--output", "json"],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.status !== 0) throw new Error(`glab mr list failed: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
    const mrs = JSON.parse(r.stdout || "[]");
    return mrs
      .filter((mr) => typeof mr.description === "string" && mr.description.includes(marker))
      .map((mr) => ({
        number: mr.iid,
        url: mr.web_url,
        body: mr.description,
        createdAt: mr.created_at,
      }));
  },
};

// ── git-native fallback ──────────────────────────────────────────────────────
//
// When no vendor CLI is available (self-hosted Gitea, a locked-down runner,
// or an unknown host), we can still spot in-flight work by scanning open
// remote branches for the marker in the head commit's body. This trades PR-
// level metadata (draft/merged/closed) for portability — it can only see
// "is there a branch pushed to origin whose head commit carries the marker"
// but that's often enough: the fired session pushes its first commit before
// opening the PR, so a marker-carrying branch is a strong signal.
export const gitNativeAdapter = {
  name: "git-native",
  detect() { return true; },   // last-resort fallback; never claims first
  available({ execImpl = spawnSync } = {}) {
    const r = execImpl("git", ["--version"], { encoding: "utf8" });
    if (r.error || r.status !== 0) return { ok: false, reason: "git is not available" };
    return { ok: true };
  },
  listOpenPrs(marker, { root = process.cwd(), execImpl = spawnSync } = {}) {
    // List remote-tracking branches, then grep each head commit body for the
    // marker. Branches whose head has since been merged/deleted are pruned by
    // `git remote prune origin`, but stale ones may linger — the recency
    // window in checkInFlightDispatch is the safety net.
    const branches = execImpl(
      "git",
      ["for-each-ref", "--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)", "refs/remotes/origin/"],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (branches.status !== 0) throw new Error(`git for-each-ref failed: ${(branches.stderr || "").trim() || `exit ${branches.status}`}`);

    const results = [];
    const lines = (branches.stdout || "").split("\n").filter(Boolean);
    for (const line of lines) {
      const [name, sha, date] = line.split("|");
      if (!sha || name === "origin/HEAD") continue;
      const body = execImpl("git", ["log", "-1", "--format=%B", sha], { cwd: root, encoding: "utf8" });
      if (body.status !== 0) continue;
      if (!body.stdout || !body.stdout.includes(marker)) continue;
      // git-native has no PR number and no URL — surface the branch name in
      // both slots so the operator can still act on the refusal message.
      results.push({
        number: name.replace(/^origin\//, ""),
        url: name.replace(/^origin\//, ""),
        body: body.stdout,
        createdAt: date,
      });
    }
    return results;
  },
};

// ── registry ─────────────────────────────────────────────────────────────────
export const BUILTIN_PROVIDERS = [githubAdapter, gitlabAdapter];

/**
 * Pick the adapter for a given remote URL. Precedence:
 *   1. explicit `override` (from `meta.dispatch.provider` or `--provider`)
 *      — a user knows their setup; honor it, or fail loud if no match
 *   2. the first matching detector in the registry — repo URL wins
 *   3. `gitNativeAdapter` — the portable last resort
 *
 * The `providers` list is injectable so a repo can add a custom adapter
 * without touching the built-ins (Bitbucket, Codeberg, self-hosted Gitea).
 * Returns { adapter, source } — `source` names WHY this adapter was picked
 * so the doctor / debug output can explain the choice.
 */
export function resolveProvider({ remoteUrl = "", override = null, providers = BUILTIN_PROVIDERS, fallback = gitNativeAdapter } = {}) {
  if (override) {
    if (override === "none") return { adapter: null, source: "override:none" };
    const named = [...providers, fallback].find((a) => a && a.name === override);
    if (named) return { adapter: named, source: `override:${override}` };
    throw new Error(`unknown dispatch provider '${override}' — available: ${[...providers, fallback].map((a) => a.name).join(", ")}, or 'none' to disable`);
  }
  for (const a of providers) {
    if (a.detect && a.detect(remoteUrl)) return { adapter: a, source: "detected" };
  }
  return { adapter: fallback, source: "fallback" };
}
