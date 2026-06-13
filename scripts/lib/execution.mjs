// slice-roadmap — execution strategy brain (PURE).
// A per-slice `execution:` block declares HOW to staff the slice: the fan-out topology
// (solo / subagents / dynamic-workflow / agent-team), a suggested LIVE worker count, a
// floor, and the team composition. Agents chronically under-parallelize (a lone subagent
// where a team fits); this turns the author's intent into an IMPERATIVE directive the
// launched session reads, instead of leaving the call to gut feel.
//
// No IO. The block is OPTIONAL and BACKWARD-COMPATIBLE: a slice without it behaves exactly
// as before. validate-core checks it, render-core / show / brief render the directive, and
// fanout honors the topology.

export const EXEC_MODES = ["solo", "subagents", "dynamic-workflow", "agent-team"];
export const EXEC_ROLES = ["verifier", "implementer", "reviewer", "researcher", "integrator"];

// Cap the auto-suggested floor so a slice touching dozens of dirs doesn't recommend an
// absurd worker count — past ~6 the review/merge cost dominates the parallelism win.
export const CLUSTER_CAP = 6;

// Distinct disjoint top-level dir clusters from a file list. "src/a.ts" and "src/b.ts"
// share the `src` cluster (one shared lane); "src/x" + "docs/y" are two disjoint lanes.
export function dirClusters(files = []) {
  const set = new Set();
  for (const f of files || []) {
    const s = String(f).trim();
    if (!s) continue;
    set.add(s.split("/")[0]);
  }
  return set;
}

// Suggested concurrency FLOOR derived from a slice's touched files = the count of distinct
// disjoint top-level dir clusters (capped). A HINT, never a hard default. null when the
// slice declares no files to reason about.
export function suggestedConcurrency(node) {
  const files = [...((node && node.touches) || []), ...((node && node.owns) || [])];
  const n = dirClusters(files).size;
  if (n <= 0) return null;
  return Math.min(CLUSTER_CAP, Math.max(1, n));
}

// Normalize a raw sprint.execution block to a stable shape (or null when absent). team[].count
// defaults to 1. Does NOT validate — validateExecution does that; this just shapes for rendering.
export function normalizeExecution(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const team = Array.isArray(raw.team)
    ? raw.team
        .filter((t) => t && typeof t === "object")
        .map((t) => ({ role: t.role, count: Number.isInteger(t.count) ? t.count : 1 }))
    : null;
  return {
    mode: raw.mode || null,
    concurrency: raw.concurrency != null ? raw.concurrency : null,
    minConcurrency: raw.min_concurrency != null ? raw.min_concurrency : null,
    team: team && team.length ? team : null,
    rationale: raw.rationale || null,
  };
}

// Total declared head-count across the team composition (null when no team).
export function teamSize(team) {
  if (!team || !team.length) return null;
  return team.reduce((a, t) => a + (Number.isInteger(t.count) ? t.count : 1), 0);
}

// Validate a raw execution block. Returns { errors, warnings } (both arrays, possibly empty).
// Absent block → no errors (backward-compatible). `where` is the "pi/sprint" locator for messages.
export function validateExecution(raw, where) {
  const errors = [];
  const warnings = [];
  if (raw == null) return { errors, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${where}: execution must be a mapping`);
    return { errors, warnings };
  }

  if (raw.mode != null && !EXEC_MODES.includes(raw.mode)) {
    errors.push(`${where}: execution.mode "${raw.mode}" invalid (one of ${EXEC_MODES.join(" | ")})`);
  }

  for (const k of ["concurrency", "min_concurrency"]) {
    if (raw[k] != null && (!Number.isInteger(raw[k]) || raw[k] < 1)) {
      errors.push(`${where}: execution.${k} must be an integer ≥1 (got ${JSON.stringify(raw[k])})`);
    }
  }

  if (
    Number.isInteger(raw.concurrency) && Number.isInteger(raw.min_concurrency) &&
    raw.min_concurrency > raw.concurrency
  ) {
    errors.push(`${where}: execution.min_concurrency (${raw.min_concurrency}) must be ≤ concurrency (${raw.concurrency})`);
  }

  if (raw.team != null) {
    if (!Array.isArray(raw.team)) {
      errors.push(`${where}: execution.team must be a list of { role, count? }`);
    } else {
      let sum = 0;
      let summable = raw.team.length > 0;
      raw.team.forEach((t, i) => {
        if (!t || typeof t !== "object" || Array.isArray(t)) {
          errors.push(`${where}: execution.team[${i}] must be a mapping { role, count? }`);
          summable = false;
          return;
        }
        if (!EXEC_ROLES.includes(t.role)) {
          errors.push(`${where}: execution.team[${i}].role "${t.role}" invalid (one of ${EXEC_ROLES.join(" | ")})`);
        }
        if (t.count != null && (!Number.isInteger(t.count) || t.count < 1)) {
          errors.push(`${where}: execution.team[${i}].count must be an integer ≥1`);
          summable = false;
        }
        sum += t.count != null ? (Number.isInteger(t.count) ? t.count : 0) : 1;
      });
      // Head-count consistency: when BOTH a team and a concurrency are given, they must agree.
      if (summable && Number.isInteger(raw.concurrency) && sum !== raw.concurrency) {
        errors.push(`${where}: execution.team head-count (${sum}) is inconsistent with concurrency (${raw.concurrency})`);
      }
      if (raw.mode === "solo" && raw.team.length) {
        warnings.push(`${where}: execution.mode is solo but a team is declared (a solo slice does not fan out)`);
      }
    }
  }

  return { errors, warnings };
}

// The IMPERATIVE directive lines for a slice — the single canonical block reused verbatim by
// SLICES.md, `roadmap show`/`/slice`, and the kickoff brief. Returns null when no execution block.
// Example (agent-team):
//   ▶ EXECUTION: agent-team — 5 workers (1 verifier · 3 implementers · 1 reviewer).
//     The touched files are disjoint. DO NOT run solo or fewer than 4. Invoke Agent Teams now (set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1).
//     Rationale: 16 disjoint fault-class files; verifier-first; one reviewer reconciles.
export function executionDirectiveLines(node) {
  const exec = normalizeExecution(node && node.execution);
  if (!exec) return null;

  const mode = exec.mode || "subagents";
  const suggested = suggestedConcurrency(node);
  const workers = exec.concurrency ?? teamSize(exec.team) ?? suggested ?? (mode === "solo" ? 1 : null);
  const floor = exec.minConcurrency ?? exec.concurrency ?? suggested ?? null;
  const comp = composition(exec.team);
  const lines = [];

  // Line 1 — headline: mode + worker count + composition.
  if (mode === "solo") {
    lines.push(`▶ EXECUTION: solo — single agent, no fan-out.`);
  } else {
    const wk = workers != null ? `${workers} worker${workers === 1 ? "" : "s"}` : `worker count TBD`;
    lines.push(`▶ EXECUTION: ${mode} — ${wk}${comp ? ` (${comp})` : ""}.`);
  }

  // Line 2 — the imperative instruction, per topology.
  const floorClause = mode !== "solo" && floor != null ? ` DO NOT run solo or fewer than ${floor}.` : "";
  if (mode === "agent-team") {
    lines.push(`  The touched files are disjoint.${floorClause} Invoke Agent Teams now (set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1).`);
  } else if (mode === "subagents") {
    const n = workers != null ? `${workers} ` : "";
    lines.push(`  Spawn ${n}background subagents per CLAUDE.md § Subagent Hand-off (disjoint files; the lead merges).${floorClause}`);
  } else if (mode === "dynamic-workflow") {
    lines.push(`  Run an in-slice pipeline — each step gates the next; do not collapse it to a single pass.${floorClause}`);
  } else if (mode === "solo") {
    lines.push(`  Single agent, no fan-out — atomic/exploratory/branching-sequential. Do not spawn workers.`);
  }

  if (exec.rationale) lines.push(`  Rationale: ${exec.rationale}`);
  return lines;
}

// "1 verifier · 3 implementers · 1 reviewer" from a normalized team (null when none).
export function composition(team) {
  if (!team || !team.length) return null;
  return team
    .map((t) => {
      const c = Number.isInteger(t.count) ? t.count : 1;
      return `${c} ${t.role}${c === 1 ? "" : "s"}`;
    })
    .join(" · ");
}

// Keep only the wave nodes whose track matches `track` (case-insensitive). No-op when track
// is falsy. Forward-compat with the three-track partition: a person fans out only their lane.
export function filterByTrack(nodes, track) {
  if (!track) return nodes;
  const want = String(track).toLowerCase();
  return nodes.filter((n) => n.track != null && String(n.track).toLowerCase() === want);
}
