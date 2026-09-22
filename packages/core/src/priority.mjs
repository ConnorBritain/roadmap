// roadmap — priority brain (PURE). Shared by roadmap sprints and backlog items:
// priority: { tier: P0..P3, weight: 0..100, reason }. Every field optional; sort
// order is DERIVED (tier asc, then weight desc), never stored.

export const TIERS = ["P0", "P1", "P2", "P3"];
const TIER_RANK = new Map(TIERS.map((t, i) => [t, i]));

// Validate an optional priority block. Absent → no errors (backward-compatible).
export function validatePriority(raw, where) {
  const errors = [];
  if (raw == null) return { errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: [`${where}: priority must be a mapping { tier, weight, reason }`] };
  }
  if (raw.tier != null && !TIER_RANK.has(raw.tier)) {
    errors.push(`${where}: priority.tier "${raw.tier}" is not one of ${TIERS.join("|")}`);
  }
  if (raw.weight != null && (typeof raw.weight !== "number" || raw.weight < 0 || raw.weight > 100)) {
    errors.push(`${where}: priority.weight must be a number 0..100 (got ${JSON.stringify(raw.weight)})`);
  }
  if (raw.reason != null && typeof raw.reason !== "string") {
    errors.push(`${where}: priority.reason must be a string`);
  }
  return { errors };
}

// Sort comparator. Tier ascending (absent tier ranks AFTER P3), then weight descending
// (absent = 0). Returns 0 when both are absent — the backward-compat guarantee: an
// unprioritized graph falls through to the caller's existing ordering untouched.
export function comparePriority(a, b) {
  if (a == null && b == null) return 0;
  const ta = a && TIER_RANK.has(a.tier) ? TIER_RANK.get(a.tier) : TIERS.length;
  const tb = b && TIER_RANK.has(b.tier) ? TIER_RANK.get(b.tier) : TIERS.length;
  if (ta !== tb) return ta - tb;
  const wa = (a && typeof a.weight === "number") ? a.weight : 0;
  const wb = (b && typeof b.weight === "number") ? b.weight : 0;
  return wb - wa;
}

// "P0" | null — the compact badge for renders and plan listings.
export function tierBadge(p) {
  return p && TIER_RANK.has(p.tier) ? p.tier : null;
}

// Command-lane sort boost (see graph.mjs commandLaneMembers/Active). When a dated command lane is
// active, its member slices sort FIRST — ahead of even declared priority — so finishing the committed
// objective beats discovering the next slice. Inactive (or no lane) → always 0, so the caller's
// existing ordering is byte-for-byte untouched: the backward-compat guarantee.
export function laneComparator(members, active) {
  return (a, b) => active ? ((members.has(a.invoke) ? 0 : 1) - (members.has(b.invoke) ? 0 : 1)) : 0;
}
