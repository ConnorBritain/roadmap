// roadmap — the canonical subject marker (PURE, core): the one machine line that ties an artifact
// (PR body, document header, commit message) to a roadmap subject. Exact markers are identity;
// loose prose and substring matches are not. Branch-convention matching lives with the
// engineering executor (scripts/lib/pr-identity.mjs).

import { FROZEN_BAR_END, FROZEN_BAR_START } from "./gauntlet-core.mjs";

const SUBJECT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SUBJECT_TYPES = new Set(["slice", "backlog"]);
const MAX_BODY = 256 * 1024;

export function renderRoadmapMarker({ subjectType, subject_type, type, key } = {}) {
  const resolvedType = subjectType || subject_type || type;
  if (!SUBJECT_TYPES.has(resolvedType)) throw new Error("roadmap marker type must be slice or backlog");
  if (typeof key !== "string" || !SUBJECT_KEY_RE.test(key)) throw new Error("roadmap marker key must be a lowercase slug");
  return `roadmap: ${resolvedType}=${key}`;
}

// The marker must appear exactly once, outside the frozen-bar block and outside fenced code, so a
// bar or a code sample can never forge a subject identity.
export function parseRoadmapMarker(text) {
  if (typeof text !== "string" || text.length > MAX_BODY) return null;
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

export function roadmapSubjectMarkers(artifact) {
  const parsed = parseRoadmapMarker(artifact && artifact.body);
  return parsed ? [{ ...parsed, marker: renderRoadmapMarker(parsed) }] : [];
}

export const renderRoadmapSubjectMarker = renderRoadmapMarker;
export const parseRoadmapSubjectMarker = parseRoadmapMarker;
