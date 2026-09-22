// roadmap — engineering-profile validators, run by `roadmap validate` after core's validateGraph.
// Core keeps the shape checks for the optional engineering meta blocks (they are pure data rules
// and guard the pre-write gate); this module adds what only makes sense when slices are code.
// Each validator: (graph) → { errors: [], warnings: [] }.
import { flatten } from "@connorbritain/roadmap-core/graph.mjs";

// A launchable slice with no `touches` is invisible to wave contention: two such slices can land
// in one wave and edit the same files. Warn (never error: touches are optional by design).
export function touchesForContention(graph) {
  const blind = flatten(graph).nodes.filter((n) => n.status === "next" && !(n.touches && n.touches.length) && !(n.owns && n.owns.length));
  return { errors: [], warnings: blind.length
    ? [`contention: ${blind.length} next slice(s) declare no touches/owns (${blind.map((n) => n.invoke).join(", ")}) — wave packing cannot keep them off the same files; run the slice-scoper or name the paths`]
    : [] };
}

export const engineeringValidators = [touchesForContention];
