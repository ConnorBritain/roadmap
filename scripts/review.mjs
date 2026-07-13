#!/usr/bin/env node
// roadmap review [--since <rev|date>] [--json] — the date-anchored review digest: what
// shipped vs what grew since the last human review. The anchor chain: meta.last_review.commit
// → --since (a YYYY-MM-DD resolves to the last commit before that date; anything else is a
// git rev) → the last commit before a default 14-day window. Old YAML snapshots come from
// `git show <commit>:docs/roadmap/roadmap.yaml` (forward slashes — git pathspecs, not OS paths).
// Read-only; /debrief and /retro consume --json.

import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { loadGraph } from "./lib/graph.mjs";
import { loadBacklog } from "./lib/store.mjs";
import { graphDiff, backlogDiff, reviewDigest } from "./lib/review-core.mjs";

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const git = (...a) => spawnSync("git", a, { encoding: "utf8" });

function resolveAnchor(graph) {
  const lr = graph.meta && graph.meta.last_review;
  const since = val("--since");
  if (!since && lr && lr.commit) return { commit: lr.commit, date: lr.date || null, source: "meta.last_review" };
  if (since) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      const sha = git("rev-list", "-1", `--before=${since}`, "HEAD").stdout.trim();
      return sha ? { commit: sha, date: since, source: "--since date" } : null;
    }
    return { commit: since, date: null, source: "--since rev" };
  }
  const d = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10);
  const sha = git("rev-list", "-1", `--before=${d}`, "HEAD").stdout.trim();
  return sha ? { commit: sha, date: d, source: "default 14-day window" } : null;
}

function yamlAt(commit, rel) {
  const r = git("show", `${commit}:${rel}`);
  return r.status === 0 ? YAML.parse(r.stdout) : null;   // file didn't exist at that rev
}

const graph = loadGraph("docs/roadmap/roadmap.yaml");
const backlog = loadBacklog(process.cwd());
const anchor = resolveAnchor(graph);
let note = null;
let oldGraph = { meta: {}, pis: [] };
let oldBacklog = null;
if (!anchor) {
  note = "no anchor commit found (young repo?) — diffing against an empty roadmap";
} else {
  oldGraph = yamlAt(anchor.commit, "docs/roadmap/roadmap.yaml") || { meta: {}, pis: [] };
  oldBacklog = yamlAt(anchor.commit, "docs/roadmap/backlog.yaml");
}

let digest;
try {
  digest = reviewDigest({ gd: graphDiff(oldGraph, graph), bd: backlogDiff(oldBacklog, backlog), graph });
} catch (e) {
  console.error(`✗ ${e.message}${anchor ? ` (old snapshot at ${anchor.commit})` : ""}`);
  process.exit(1);
}

if (args.includes("--json")) {
  process.stdout.write(JSON.stringify({ anchor, note, digest }, null, 2) + "\n");
  process.exit(0);
}

// ── human digest ───────────────────────────────────────────────────────────────
const short = (sha) => String(sha).slice(0, 8);
const out = [];
out.push(anchor
  ? `review window: ${short(anchor.commit)}${anchor.date ? ` (${anchor.date})` : ""} → HEAD   [${anchor.source}]`
  : `review window: (${note})`);
out.push(`shipped (${digest.shipped.length}): ${digest.shipped.map((s) => `${s.invoke}${s.prs && s.prs.length ? ` (${s.prs.join(" ")})` : ""}`).join(", ") || "—"}`);
out.push(`captured (${digest.netGrowth.added}): ${digest.captured.items.length} backlog item(s), ${digest.captured.sprints.length} sprint(s)`);
out.push(`net growth: +${digest.netGrowth.added} / -${digest.shipped.length + digest.closedItems.length} (ratio ${digest.netGrowth.ratio})`);
out.push(`closure: ${digest.newPis.length} PI(s) born / ${digest.removedPis.length} died · capture-to-ship ratio ${digest.netGrowth.ratio} · ~${digest.estOpenSessions} open session(s) remaining`);
if (digest.aging.length) out.push(`held since before last review: ${digest.aging.map((a) => `${a.invoke} (${a.status})`).join(", ")}`);
if (digest.newPis.length) out.push(`new PIs: ${digest.newPis.map((p) => p.id).join(", ")}`);
if (digest.pisInFlight > 1) out.push(`PIs in flight: ${digest.pisInFlight}`);
for (const w of digest.sprawl) out.push(w);
console.log(out.join("\n"));
