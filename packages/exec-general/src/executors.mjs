// roadmap — the general profile's Executors: `human` (a person is assigned; the receipt is a brief
// file they work from) and `doc-agent` (the same brief, plus the configured assistant is started
// against the repository root — no worktree, no branch). Both write their receipts as files under
// .roadmap/assignments/, so they survive any local ledger loss and can be committed.
//
// A slice's deliverable is its `artifact` path (default docs/roadmap/artifacts/<invoke>.md); the
// executor's job ends when that file exists at a commit. Whether it PASSES is the conductor's call.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, posix } from "node:path";
import { genericScope } from "@connorbritain/roadmap-core/executor.mjs";
import { flatten, readyNodes, resolveGate, isDone } from "@connorbritain/roadmap-core/graph.mjs";

export const ASSIGNMENTS_DIR = posix.join(".roadmap", "assignments");
export const DEFAULT_ARTIFACT_DIR = posix.join("docs", "roadmap", "artifacts");
export const DEFAULT_AGENT_CMD = "claude --permission-mode {mode} {prompt}";
const RECEIPT_RE = /^<!-- roadmap-assignment (\{.*\}) -->/m;

export function artifactPathFor(node) {
  return node.artifact || (node.sprint && node.sprint.artifact) || posix.join(DEFAULT_ARTIFACT_DIR, `${node.invoke}.md`);
}
export function briefPathFor(node, role = "work", round = null) {
  const suffix = role === "work" ? "" : `.${role}${round ? `-r${round}` : ""}`;
  return posix.join(ASSIGNMENTS_DIR, `${node.invoke}${suffix}.md`);
}

// The checklist a person or critic confirms: a string gate becomes one "run: …" line.
export function checklistOf(node, graph) {
  const text = resolveGate(node, graph) || "";
  if (Array.isArray(node.gate)) return node.gate.map(String);
  return text.trim() ? text.split("\n").map((l) => l.replace(/^- /, "")).filter(Boolean).map((l) => (/^run: /.test(l) ? l : `run: ${l}`)) : ["Reviewed by someone other than the author"];
}

export function renderAssignmentBrief(node, graph, receipt, { prompt = null } = {}) {
  const L = [];
  L.push(`<!-- roadmap-assignment ${JSON.stringify(receipt)} -->`);
  L.push(`# Assignment — ${node.invoke} (${receipt.role})`);
  L.push("");
  L.push(`**Executor:** ${receipt.executor} · **Assignee:** ${receipt.actor || "unassigned"} · **Assigned:** ${receipt.started_at}`);
  L.push(`**Slice:** ${node.title || node.invoke} — ${node.what || ""}`.trimEnd());
  L.push(`**Artifact:** \`${receipt.artifactRef}\` — the deliverable. Write it there and commit it when a draft is ready for review.`);
  L.push("");
  L.push("**Gate (checklist — confirm every line before you call it done):**");
  for (const item of checklistOf(node, graph)) L.push(`- [ ] ${item}`);
  const readOrder = node.readOrder || node.read_order || [];
  if (readOrder.length) { L.push(""); L.push("**Read first:**"); readOrder.forEach((r, i) => L.push(`${i + 1}. ${r}`)); }
  if (node.prompt) { L.push(""); L.push("**Pickup notes (from the roadmap):**"); L.push(""); L.push(String(node.prompt).trimEnd()); }
  if (prompt) { L.push(""); L.push(`## ${receipt.role} brief`); L.push(""); L.push(String(prompt).trimEnd()); }
  L.push("");
  L.push("> You do not mark the slice complete — the lead conducts the review and records the outcome. Leftovers go to the backlog only.");
  return L.join("\n") + "\n";
}

export function parseReceipt(text) {
  const m = RECEIPT_RE.exec(text || "");
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function gitIdentity(root, execImpl) {
  try {
    const r = execImpl("git", ["config", "user.email"], { cwd: root, encoding: "utf8" });
    return r.status === 0 ? String(r.stdout).trim() : "";
  } catch { return ""; }
}
function lastCommitTouching(root, rel, execImpl) {
  try {
    const r = execImpl("git", ["log", "-1", "--format=%H", "HEAD", "--", rel], { cwd: root, encoding: "utf8" });
    const sha = r.status === 0 ? String(r.stdout).trim() : "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
}

// Shared body of both executors. `spawnAgent(root, cmd)` is what doc-agent does after writing the
// brief (injectable; the default runs it through bash and waits, like grab does).
function generalExecutor(name, { root = process.cwd(), execImpl = spawnSync, now = () => new Date().toISOString(), spawnAgent = null, actor = null } = {}) {
  const abs = (rel) => join(root, ...rel.split("/"));
  const readReceipts = (slice) => {
    const dir = abs(ASSIGNMENTS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => parseReceipt(readFileSync(join(dir, f), "utf8")))
      .filter((r) => r && r.executor === name && r.slice === slice.invoke);
  };
  return {
    name,
    capabilities() { return { concurrent: true, artifactKinds: ["git-file", "doc"], gateKind: "checklist" }; },
    scope(slice, ctx = {}) { return genericScope(slice, ctx.graph, { fileExists: (p) => existsSync(join(ctx.root || root, p)) }); },
    // No machine ceilings: people-hours bind. meta.default_concurrency is the review capacity.
    capacity(graph) {
      const ready = readyNodes(flatten(graph));
      const review = Number((graph.meta && graph.meta.default_concurrency) || 3);
      const candidates = [
        { n: Math.max(1, review), why: `review — ${review} concurrent assignment(s) (meta.default_concurrency); no machine ceiling in the ${name} executor` },
        { n: Math.max(1, ready.length || 1), why: `work — ${ready.length} independent ready slice(s)` },
      ];
      const binding = candidates.reduce((a, b) => (b.n < a.n ? b : a));
      return { recommended: Math.max(1, binding.n), binding, candidates, sys: null, disk: null };
    },
    annotate(node) {
      const latest = readReceipts(node).filter((r) => r.role === "work").sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
      return { assignee: latest ? latest.actor : null, artifact: artifactPathFor(node), brief: briefPathFor(node) };
    },
    async launch(slice, opts = {}, ctx = {}) {
      const graph = ctx.graph || { meta: {} };
      const role = opts.role || "work";
      const round = opts.round || null;
      const brief = briefPathFor(slice, role, round);
      const key = `${name}:${slice.invoke}:${role}${round ? `:r${round}` : ""}`;
      if (!opts.force && existsSync(abs(brief))) {
        const existing = parseReceipt(readFileSync(abs(brief), "utf8"));
        if (existing) return { ...existing, brief, dry: false, existing: true };   // idempotent per key
      }
      const receipt = { key, executor: name, slice: slice.invoke, role, ...(round ? { round } : {}),
        actor: opts.assignee || actor || gitIdentity(root, execImpl) || "unassigned",
        artifactRef: artifactPathFor(slice), started_at: now(), dry: !!opts.dry };
      const text = renderAssignmentBrief(slice, graph, { ...receipt, dry: undefined }, { prompt: opts.prompt || null });
      if (opts.dry) return { ...receipt, brief, text };
      mkdirSync(dirname(abs(brief)), { recursive: true });
      writeFileSync(abs(brief), text);
      if (name === "doc-agent") {
        const tpl = (graph.meta && graph.meta.agent_cmd) || DEFAULT_AGENT_CMD;
        const prompt = `Read ${brief} and carry out the assignment it describes. The artifact path and the checklist gate are inside. Commit the artifact when a draft is ready. Do NOT mark the slice complete.`;
        const cmd = tpl.replace("{mode}", (graph.meta && graph.meta.worker_mode) || "plan").replace("{prompt}", `"${prompt}"`);
        const run = spawnAgent || ((r, c) => execImpl("bash", ["-c", c], { cwd: r, stdio: "inherit" }));
        const result = run(root, cmd);
        return { ...receipt, brief, command: cmd, exit: result && result.status != null ? result.status : null };
      }
      return { ...receipt, brief };
    },
    async status(slice, ctx = {}) {
      const receipts = readReceipts(slice);
      if (!receipts.length) return { state: "idle", receipts: [], notes: [] };
      const path = artifactPathFor(slice);
      const committed = lastCommitTouching(ctx.root || root, path, execImpl);
      const exists = existsSync(abs(path));
      const state = committed ? "done" : exists ? "running" : "assigned";
      return { state, receipts, artifactRef: path, ...(committed ? { head: committed } : {}),
        notes: [committed ? `artifact committed at ${committed}` : exists ? "artifact drafted, not yet committed" : "assigned; no artifact yet"] };
    },
    async receipts(slice) { return readReceipts(slice); },
    async cleanup(opts = {}, ctx = {}) {
      const dir = abs(ASSIGNMENTS_DIR);
      const removed = [], kept = [];
      if (existsSync(dir)) {
        const done = new Set(ctx.graph ? flatten(ctx.graph).nodes.filter((n) => isDone(n.status)).map((n) => n.invoke) : []);
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
          const r = parseReceipt(readFileSync(join(dir, f), "utf8"));
          const rel = posix.join(ASSIGNMENTS_DIR, f);
          if (r && r.executor === name && (done.has(r.slice) || opts.force)) {
            if (opts.remove) rmSync(join(dir, f));
            removed.push(rel);
          } else kept.push(rel);
        }
      }
      return { removed: opts.remove ? removed : [], kept: opts.remove ? kept : [...removed, ...kept], wouldRemove: removed, dry: !opts.remove };
    },
  };
}

export const humanExecutor = (opts = {}) => generalExecutor("human", opts);
export const docAgentExecutor = (opts = {}) => generalExecutor("doc-agent", opts);
export const EXECUTORS = { human: humanExecutor, "doc-agent": docAgentExecutor };
