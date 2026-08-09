#!/usr/bin/env node
// roadmap — PR-watch monitor. Polls `gh pr list` for this roadmap's fanout branches and
// prints one line per PR phase transition (draft -> ready, checks -> green, open -> merged, ...).
// Bundled as a plugin monitor (monitors/monitors.json): each printed line becomes a notification
// to the lead session. Also runnable as `roadmap watch` in a pane.
//
// Quiet by design: the first poll establishes a silent baseline; only changes after that print.
// Degrades gracefully: if there's no roadmap or `gh` is missing/unauthenticated, it says so once
// and exits 0 (never a crash loop).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findRepoRoot, REL } from "./lib/cli-core.mjs";
import { loadGraph } from "./lib/graph.mjs";
import { diffPrStates, belongsToRoadmapPr, checksOf, criticSignalOf } from "./lib/pr-watch-core.mjs";

const POLL_MS = Number(process.env.ROADMAP_WATCH_INTERVAL_MS || 30000);
const log = (m) => process.stdout.write(m + "\n");

function loadRoadmap() {
  const root = findRepoRoot(process.env.CODEX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) return null;
  try {
    return { root, graph: loadGraph(join(root, ...REL)) };
  } catch {
    return null;
  }
}

const ghAvailable = () => {
  try { return spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0; }
  catch { return false; }
};

function fetchPrs(root) {
  const r = spawnSync("gh", ["pr", "list", "--state", "all", "--limit", "100",
    "--json", "number,title,body,url,headRefName,headRefOid,state,isDraft,mergeStateStatus,statusCheckRollup,comments"],
    { cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function snapshot(prs, graph) {
  const map = {};
  for (const pr of prs) {
    if (!belongsToRoadmapPr(pr, graph)) continue;
    const critic = criticSignalOf(pr);
    map[pr.number] = {
      number: pr.number, title: pr.title, body: pr.body, url: pr.url,
      headRefName: pr.headRefName, headRefOid: pr.headRefOid,
      state: pr.state, isDraft: pr.isDraft, mergeStateStatus: pr.mergeStateStatus, checks: checksOf(pr),
      criticSignature: critic && critic.signature,
      criticVerdict: critic && critic.verdict,
      criticReviewedHead: critic && critic.reviewedHead,
      criticStale: !!(critic && critic.stale),
    };
  }
  return map;
}

const rm = loadRoadmap();
if (!rm) { log("roadmap-prs: no docs/roadmap/roadmap.yaml found; PR watch idle."); process.exit(0); }
if (!ghAvailable()) { log("roadmap-prs: `gh` CLI not found or not authenticated; PR watch disabled."); process.exit(0); }

let prev = {};
let primed = false;
function tick() {
  const prs = fetchPrs(rm.root);
  if (!prs) return; // transient gh failure; try again next interval
  const fresh = loadRoadmap();
  if (!fresh) return;
  const curr = snapshot(prs, fresh.graph);
  if (!primed) { prev = curr; primed = true; return; } // silent baseline on first poll
  for (const ev of diffPrStates(prev, curr)) log(ev.message);
  prev = curr;
}

tick();
setInterval(tick, POLL_MS); // keep polling until the process is killed (monitor lifecycle / Ctrl-C)
