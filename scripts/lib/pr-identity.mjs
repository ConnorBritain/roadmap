// roadmap — shared PR identity predicate (PURE).
// Branch conventions and exact machine markers are identity; loose prose and
// substring matches are not.

import { flatten } from "./graph.mjs";
import { branchFor } from "./brief.mjs";
import { FROZEN_BAR_END, FROZEN_BAR_START, parseGauntletRunMarker } from "./gauntlet-core.mjs";

const SUBJECT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SUBJECT_TYPES = new Set(["slice", "backlog"]);
const MAX_PR_BODY = 256 * 1024;

export function renderRoadmapMarker({ subjectType, subject_type, type, key } = {}) {
  const resolvedType = subjectType || subject_type || type;
  if (!SUBJECT_TYPES.has(resolvedType)) throw new Error("roadmap marker type must be slice or backlog");
  if (typeof key !== "string" || !SUBJECT_KEY_RE.test(key)) throw new Error("roadmap marker key must be a lowercase slug");
  return `roadmap: ${resolvedType}=${key}`;
}

export function parseRoadmapMarker(text) {
  if (typeof text !== "string" || text.length > MAX_PR_BODY) return null;
  const normalizedAll = text.replace(/\r\n?/g, "\n");
  const markers = [];
  let frozen = false;
  let fence = null;
  for (const line of normalizedAll.split("\n")) {
    if (line === FROZEN_BAR_START) { frozen = true; continue; }
    if (line === FROZEN_BAR_END) { frozen = false; continue; }
    if (frozen) continue;
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (boundary) {
      const token = boundary[1];
      if (!fence) fence = { char: token[0], length: token.length };
      else if (fence.char === token[0] && token.length >= fence.length && !boundary[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^roadmap: (slice|backlog)=([a-z0-9][a-z0-9-]{0,127})$/.exec(line);
    if (match) markers.push({ subjectType: match[1], subject_type: match[1], type: match[1], key: match[2] });
  }
  return markers.length === 1 ? markers[0] : null;
}

export function roadmapSubjectMarkers(pr) {
  const parsed = parseRoadmapMarker(pr && pr.body);
  return parsed ? [{ ...parsed, marker: renderRoadmapMarker(parsed) }] : [];
}

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
  if (matchesRoadmapBranches(pr.headRefName || pr.head_ref_name || pr.branch, graph)) return true;
  if (roadmapSubjectMarkers(pr).length > 0) return true;
  return parseGauntletRunMarker(pr.body) != null;
}

export const renderRoadmapSubjectMarker = renderRoadmapMarker;
export const parseRoadmapSubjectMarker = parseRoadmapMarker;
