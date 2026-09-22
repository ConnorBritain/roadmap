// roadmap — shared PR identity predicate (engineering executor).
// The exact subject-marker grammar is core protocol (packages/core subject-marker.mjs); this module
// adds the branch-convention half, which only the engineering executor knows.

import { flatten } from "@connorbritain/roadmap-core/graph.mjs";
import { branchFor } from "./brief.mjs";
import { parseGauntletRunMarker } from "@connorbritain/roadmap-core/gauntlet-core.mjs";
import { roadmapSubjectMarkers } from "@connorbritain/roadmap-core/subject-marker.mjs";

export { renderRoadmapMarker, parseRoadmapMarker, roadmapSubjectMarkers, renderRoadmapSubjectMarker, parseRoadmapSubjectMarker } from "@connorbritain/roadmap-core/subject-marker.mjs";

export function roadmapBranches(graph) {
  if (!graph || typeof graph !== "object") return new Set();
  const model = flatten(graph);
  return new Set(model.nodes.map((node) => branchFor(node, graph)));
}

export function matchesRoadmapBranches(headRef, graph) {
  return typeof headRef === "string" && roadmapBranches(graph).has(headRef);
}

export function belongsToRoadmapPr(pr, graph) {
  if (!pr || typeof pr !== "object") return false;
  if (matchesRoadmapBranches(pr.headRefName || pr.headRef || pr.head_ref_name || pr.branch, graph)) return true;
  if (roadmapSubjectMarkers(pr).length > 0) return true;
  return parseGauntletRunMarker(pr.body) != null;
}
