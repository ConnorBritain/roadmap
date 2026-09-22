// packages/exec-engineering tests — the github-pr GauntletArtifact against a fake `gh` (no network),
// registered on the core contract plus GitHub-specific normalization checks.
import { test, eq, ok } from "../../core/test/harness.mjs";
import { gauntletArtifactContract } from "../../core/test/contracts/gauntlet-artifact.mjs";
import { githubPrArtifact, normalizeGauntletPr, normalizingGauntletClient, checksOf, claimDescriptor } from "@connorbritain/roadmap-exec-engineering/github-pr-artifact.mjs";

// A minimal GitHub: PRs, comments, refs, compare, rules. Driven through the exact gh argv the adapter emits.
function fakeGitHub({ login = "octo-lead", lineage }) {
  const prs = new Map(); const refs = new Map(); let nextPr = 1, nextComment = 1;
  const parents = new Map(Object.entries(lineage.parents || {}));
  const descends = (a, h) => { for (let c = h, g = 0; c && g < 100; c = parents.get(c), g++) if (c === a) return true; return false; };
  const ok = (stdout) => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
  const fail = (stderr, status = 1) => ({ status, stdout: "", stderr });
  const view = (pr) => ({ number: pr.number, url: pr.url, title: pr.title, body: pr.body, state: pr.state, isDraft: false, mergeStateStatus: "CLEAN",
    headRefName: pr.headRefName, baseRefName: "main", headRefOid: pr.head, statusCheckRollup: [], createdAt: pr.createdAt, updatedAt: pr.updatedAt,
    comments: pr.comments.map((c) => ({ body: c.body, author: { login: c.author }, createdAt: c.createdAt, updatedAt: c.updatedAt, includesCreatedEdit: c.includesCreatedEdit, url: c.url })),
    commits: pr.commits.map((oid) => ({ oid })) });
  const execImpl = (cmd, args) => {
    const a = args.join(" ");
    if (cmd === "git" && args[0] === "remote") return ok("git@github.com:owner/repo.git");
    if (cmd !== "gh") return fail(`unexpected ${cmd}`);
    if (args[0] === "auth") return ok("Logged in");
    if (a.startsWith("api user")) return ok(login);
    if (a.startsWith("repo view")) return ok("owner/repo");
    if (args[0] === "pr" && args[1] === "view") { const pr = prs.get(Number(args[2])); return pr ? ok(view(pr)) : fail("not found"); }
    if (args[0] === "pr" && args[1] === "list") { return ok([...prs.values()].map(view)); }
    if (args[0] === "pr" && args[1] === "comment") {
      const pr = prs.get(Number(args[2])); const body = args[args.indexOf("--body") + 1]; const ts = new Date().toISOString();
      pr.comments.push({ body, author: login, createdAt: ts, updatedAt: ts, includesCreatedEdit: false, url: `${pr.url}#issuecomment-${nextComment++}` });
      return ok("");
    }
    if (args[0] === "api") {
      const endpoint = args.find((x) => x.startsWith("repos/"));
      if (args.includes("--method") && args.includes("POST") && endpoint === "repos/owner/repo/git/refs") {
        const ref = args[args.indexOf("-f") + 1].slice("ref=".length); const sha = args[args.lastIndexOf("-f") + 1].slice("sha=".length);
        if (refs.has(ref)) return fail("HTTP 422 Reference already exists", 1);
        refs.set(ref, sha); return ok({ ref, object: { sha } });
      }
      let m;
      if ((m = /^repos\/owner\/repo\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(endpoint))) return ok({ status: m[1] === m[2] ? "identical" : descends(m[1], m[2]) ? "ahead" : "diverged" });
      if (/^repos\/owner\/repo\/rules\/branches\//.test(endpoint)) return ok(["creation", "update", "deletion", "non_fast_forward"].map((type) => ({ type })));
      if ((m = /^repos\/owner\/repo\/git\/ref\/(.+)$/.exec(endpoint))) { const ref = `refs/${m[1]}`; return refs.has(ref) ? ok({ ref, object: { sha: refs.get(ref) } }) : fail("HTTP 404 Not Found"); }
      if ((m = /^repos\/owner\/repo\/git\/matching-refs\/(.+)$/.exec(endpoint))) { const prefix = `refs/${m[1]}`; return ok([...refs.entries()].filter(([r]) => r.startsWith(prefix)).map(([ref, sha]) => ({ ref, object: { sha } }))); }
    }
    return fail(`unhandled gh ${a}`);
  };
  return {
    execImpl,
    publish({ body, head }) { const n = nextPr++; const ts = new Date().toISOString();
      prs.set(n, { number: n, url: `https://github.com/owner/repo/pull/${n}`, title: `PR ${n}`, body, state: "OPEN", headRefName: `gauntlet/${n}`, head, commits: [head], comments: [], createdAt: ts, updatedAt: ts }); return n; },
    advance(n, head) { const pr = prs.get(Number(n)); pr.head = head; pr.commits.push(head); pr.updatedAt = new Date().toISOString(); },
    editComment(n, url) { const c = prs.get(Number(n)).comments.find((x) => x.url === url); c.body += " (edited)"; c.includesCreatedEdit = true; c.updatedAt = new Date(Date.now() + 1000).toISOString(); },
  };
}

function githubFixture() {
  const base = "1".repeat(40), head = "2".repeat(40), unrelated = "3".repeat(40);
  const gh = fakeGitHub({ lineage: { parents: { [head]: base } } });
  const artifact = githubPrArtifact("/repo", { execImpl: gh.execImpl });
  return { artifact, publish: gh.publish, advance: gh.advance, editComment: gh.editComment, lineage: { base, head, unrelated } };
}

gauntletArtifactContract("github-pr (fake gh)", githubFixture, { test, eq, ok });

test("github-pr: normalizeGauntletPr maps GitHub fields onto the neutral shape and keeps the GitHub-era aliases", () => {
  const pr = normalizeGauntletPr({ number: 5, isDraft: true, mergeStateStatus: "DIRTY", headRefName: "h", baseRefName: "main", headRefOid: "o".repeat(40),
    statusCheckRollup: [{ conclusion: "FAILURE" }], comments: [{ body: "c", author: { login: "x" }, includesCreatedEdit: true, url: "u#issuecomment-1" }], commits: [{ oid: "o".repeat(40) }] });
  eq([pr.draft, pr.mergeable, pr.headRef, pr.baseRef, pr.currentHead, pr.checks, pr.comments[0].edited, pr.comments[0].author], [true, "conflicting", "h", "main", "o".repeat(40), "failing", true, "x"], "neutral fields");
  eq([pr.isDraft, pr.mergeStateStatus, pr.headRefName, pr.baseRefName, pr.headRefOid], [true, "DIRTY", "h", "main", "o".repeat(40)], "aliases retained for engineering readers");
  eq(checksOf({ statusCheckRollup: [{ state: "PENDING" }] }), "pending", "rollup → pending");
  eq(normalizeGauntletPr(null), null, "null passes through");
});

test("github-pr: normalizingGauntletClient wraps a legacy fake so fetched artifacts are neutral and canonical names resolve", async () => {
  const fake = { viewerLogin: () => "lead", getPr: (n) => ({ number: n, baseRefName: "main", headRefOid: "f".repeat(40), comments: [{ body: "x", includesCreatedEdit: true }] }) };
  const c = normalizingGauntletClient(fake);
  const pr = await c.fetch({ number: 9 });
  eq([pr.baseRef, pr.currentHead, pr.comments[0].edited, c.kind], ["main", "f".repeat(40), true, "github-pr"], "fetch normalizes and the kind defaults to github-pr");
  eq(await c.actor(), "lead", "actor ← viewerLogin");
  ok(c.workerFetchInstructions({ number: 9 }, "h").label === "PR #9", "GitHub wording for workers");
  const d = claimDescriptor("gnt_x:critic:1:abc:critic", "gnt_x");
  ok(d.kind === "critic" && d.ref.startsWith("refs/heads/roadmap-gauntlet-locks/"), "claim refs live under the protected namespace");
});
