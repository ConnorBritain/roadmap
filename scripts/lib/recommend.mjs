// roadmap — concurrency recommender.
// Recommends a max-parallel-sessions cap from a resource + repo-purpose eval, and
// reports WHICH constraint binds. The point: concurrency that exceeds your RAM/CPU
// thrashes the machine, concurrency that exceeds free DISK fails mid-checkout, and
// concurrency that exceeds independent work or your ability to review the resulting
// PRs is wasted. So we take the min of five real ceilings.

import os from "node:os";
import { existsSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { resolveGate } from "./graph.mjs";

// Per-session resource cost by weight class — cross-language defaults (a full test
// suite / heavy compile ~3.5GB/2 cores; a build/lint ~1.5GB/1 core; docs cheap).
// A repo can override any of these via meta.weight_cost: { heavy: {ram, cores}, ... }.
const WEIGHT_COST = {
  heavy:  { ram: 3.5, cores: 2.0 },
  medium: { ram: 1.5, cores: 1.0 },
  light:  { ram: 0.6, cores: 0.5 },
};

// Anything that isn't documentation counts as "code-ish" (so it floors at medium when
// the gate's runner isn't recognized). Language-agnostic on purpose.
const DOCISH = /\.(md|mdx|rst|txt|ya?ml|toml|json)$|(^|\/)docs?\//i;

// Built-in, MULTI-ECOSYSTEM runner → weight. heavy = a full test suite or a heavy
// compile; medium = a build / typecheck / lint. Repos EXTEND or override via
// meta.weight_patterns: { heavy: ["regex", ...], medium: [...] } (strings, case-insensitive).
const BUILTIN_PATTERNS = {
  heavy: [
    /dotnet test/, /\bcargo test\b/, /\bpytest\b/, /\bgo test\b/, /\btox\b/, /\bnox\b/,
    /gradlew?\b[^\n]*\b(test|check)\b/, /\bmvn\b[^\n]*\b(test|verify)\b/, /\brspec\b/, /\bphpunit\b/,
    /\bmix test\b/, /\bctest\b/, /\bbazel test\b/, /\bjest\b/, /vitest\b[^\n]*\brun\b/,
    /(npm|yarn|pnpm)\s+(run\s+)?test\b/, /\bdeno test\b/, /\bmake\b[^\n]*\btest\b/, /\brake\b[^\n]*\btest\b/,
  ],
  medium: [
    /dotnet build/, /\bcargo (build|check|clippy)\b/, /\bgo build\b/, /gradlew?\b[^\n]*\bbuild\b/,
    /\bmvn\b[^\n]*\b(compile|package)\b/, /\btsc\b/, /\bvitest\b/, /\beslint\b/, /\bruff\b/, /\bmypy\b/,
    /(npm|yarn|pnpm)\s+(run\s+)?build\b/, /\bmake\b/, /\bcmake\b/, /\bbundle\b/, /\bwebpack\b/, /\bvite build\b/,
  ],
};

function compilePatterns(graph) {
  const extra = (graph.meta && graph.meta.weight_patterns) || {};
  const toRe = (s) => (s instanceof RegExp ? s : new RegExp(s, "i"));
  return {
    heavy: [...BUILTIN_PATTERNS.heavy, ...((extra.heavy) || []).map(toRe)],
    medium: [...BUILTIN_PATTERNS.medium, ...((extra.medium) || []).map(toRe)],
  };
}

function costTable(graph) {
  const o = (graph.meta && graph.meta.weight_cost) || {};
  return {
    heavy:  { ...WEIGHT_COST.heavy,  ...(o.heavy  || {}) },
    medium: { ...WEIGHT_COST.medium, ...(o.medium || {}) },
    light:  { ...WEIGHT_COST.light,  ...(o.light  || {}) },
  };
}

// Classify a slice's weight: explicit `weight` override wins; else docs-only → light;
// else match the resolved gate against the built-in + repo runner patterns; else a slice
// that touches non-docs files floors at medium; else meta.default_weight (or light).
export function nodeWeight(node, graph) {
  if (node.sprint && node.sprint.weight) return node.sprint.weight;
  const gate = (resolveGate(node, graph) || "").toLowerCase();
  const touches = [...(node.touches || []), ...(node.owns || [])];
  const allDocish = touches.length > 0 && touches.every((f) => DOCISH.test(f));
  if (allDocish) return "light";
  const pats = compilePatterns(graph);
  if (pats.heavy.some((re) => re.test(gate))) return "heavy";
  if (pats.medium.some((re) => re.test(gate))) return "medium";
  if (touches.some((f) => !DOCISH.test(f))) return "medium";  // unknown runner but touches code
  return (graph.meta && graph.meta.default_weight) || "light";
}

// Disk feasibility probe: what one more worktree costs vs what the worktree volume has free.
// Per-worktree cost = the checked-out tree's blob bytes (git ls-tree -r -l HEAD; one fast
// command, no fs walk) × a safety factor, overridable via meta.worktree_gb — the calibration
// knob for repos whose gates install node_modules or build artifacts per worktree.
// ponytail: 1.3× covers normal build litter; per-worktree package installs can exceed it —
// meta.worktree_gb is the knob, no measurement machinery.
// Returns { perWorktreeGb, freeGb } or null when undetectable (no git HEAD, statfs
// unsupported) — the caller then simply skips the disk ceiling.
export function probeDisk(graph, cwd = process.cwd()) {
  try {
    const meta = (graph && graph.meta) || {};
    let perWorktreeGb = typeof meta.worktree_gb === "number" ? meta.worktree_gb : null;
    if (perWorktreeGb == null) {
      const r = spawnSync("git", ["ls-tree", "-r", "-l", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
      if (r.status !== 0 || !r.stdout) return null;
      let bytes = 0;
      for (const line of r.stdout.split("\n")) {
        const m = /\s(\d+)\t/.exec(line);   // blob size column; trees show "-"
        if (m) bytes += Number(m[1]);
      }
      if (!bytes) return null;
      perWorktreeGb = (bytes / 2 ** 30) * 1.3;
    }
    // Free space on the volume that will hold the worktrees — walk worktree_root up to its
    // nearest EXISTING ancestor (the root itself may not exist until the first fanout).
    let dir = resolve(meta.worktree_root || resolve(cwd, "..", "_worktrees"));
    while (!existsSync(dir)) {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    const s = statfsSync(dir);   // Node >= 18.15, win32 + POSIX
    return { perWorktreeGb, freeGb: (s.bavail * s.bsize) / 2 ** 30 };
  } catch {
    return null;
  }
}

export function systemInfo() {
  const cpus = os.cpus() || [];
  return {
    cores: cpus.length || 4,
    totalGb: os.totalmem() / 2 ** 30,
    freeGb: os.freemem() / 2 ** 30,
    platform: os.platform(),
  };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Recommend a concurrency cap over the set of slices we'd actually fan out (`ready`).
// opts: { sys, useFree (RAM basis), reviewCeiling, osCoreReserve, osRamReserveGb,
//         disk ({ perWorktreeGb, freeGb } from probeDisk; absent/null → no disk ceiling) }
export function recommendConcurrency(ready, graph, opts = {}) {
  const sys = opts.sys || systemInfo();
  const reviewCeiling = opts.reviewCeiling ?? 5;
  const coreReserve = opts.osCoreReserve ?? 2;     // leave cores for the OS/editor/lead
  const ramReserve = opts.osRamReserveGb ?? 4;
  const disk = opts.disk || null;                  // stays PURE: callers probe (probeDisk) and inject

  const COST = costTable(graph);
  const costs = (ready.length ? ready : [null]).map((n) =>
    n ? COST[nodeWeight(n, graph)] : COST.medium
  );
  const avgRam = avg(costs.map((c) => c.ram)) || COST.medium.ram;
  const avgCores = avg(costs.map((c) => c.cores)) || COST.medium.cores;

  const usableCores = Math.max(1, sys.cores - coreReserve);
  const ramBasis = opts.useFree ? sys.freeGb : sys.totalGb * 0.75; // 75% of total, or live-free
  const usableRamGb = Math.max(1, ramBasis - ramReserve);

  const cpuCap = Math.max(1, Math.floor(usableCores / avgCores));
  const ramCap = Math.max(1, Math.floor(usableRamGb / avgRam));
  const workCap = Math.max(1, ready.length || 1);

  const candidates = [
    { n: cpuCap,        why: `CPU — ${sys.cores} cores (− ${coreReserve} reserved) ÷ ~${avgCores.toFixed(1)}/session` },
    { n: ramCap,        why: `RAM — ~${ramBasis.toFixed(0)}GB usable ÷ ~${avgRam.toFixed(1)}GB/session` },
    { n: workCap,       why: `work — ${ready.length} independent ready slice(s)` },
    { n: reviewCeiling, why: `review — PR review/merge bottleneck (soft ceiling)` },
  ];
  // Disk ceiling — the only one allowed to compute to 0: recommended stays >= 1 (soft
  // auto-dial), but callers that create worktrees (fan, grab) hard-block on disk.cap < 1.
  let diskCap = null;
  if (disk) {
    const diskReserve = opts.diskReserveGb ?? 2;
    diskCap = Math.floor(Math.max(0, disk.freeGb - diskReserve) / Math.max(disk.perWorktreeGb, 0.01));
    candidates.push({ n: Math.max(diskCap, 0), why: `disk — need ~${disk.perWorktreeGb.toFixed(1)}GB/worktree, ${disk.freeGb.toFixed(1)}GB free` });
  }
  const binding = candidates.reduce((a, b) => (b.n < a.n ? b : a));
  return {
    recommended: Math.max(1, binding.n),
    binding,
    candidates,
    sys,
    disk: disk ? { ...disk, cap: diskCap } : null,
    avgRam,
    avgCores,
    weights: ready.map((n) => ({ invoke: n.invoke, weight: nodeWeight(n, graph) })),
  };
}
