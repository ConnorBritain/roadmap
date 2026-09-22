// roadmap — general-profile validators, run by `roadmap validate` after core's validateGraph.
// Each: (graph) → { errors, warnings }.
import { flatten } from "@connorbritain/roadmap-core/graph.mjs";

// A launchable slice with a command gate and no program default has nothing a person can confirm:
// under the general profile the gate is a checklist the reviewer ticks. Warn; never error (a
// command string is still a valid gate — it just means "run this and paste the result").
export function checklistGates(graph) {
  const meta = graph.meta || {};
  const bare = flatten(graph).nodes.filter((n) => n.status === "next" && (n.gate === "default" || !n.gate) && !meta.default_gate);
  return { errors: [], warnings: bare.length
    ? [`gate: ${bare.length} next slice(s) have no gate and the program has no default_gate (${bare.map((n) => n.invoke).join(", ")}) — write the gate as a checklist of criteria a reviewer confirms`]
    : [] };
}

// Two launchable slices that name the same artifact path would overwrite each other's deliverable.
export function distinctArtifacts(graph) {
  const byPath = new Map();
  for (const n of flatten(graph).nodes) {
    if (!n.artifact || ["complete", "done"].includes(n.status)) continue;
    byPath.set(n.artifact, [...(byPath.get(n.artifact) || []), n.invoke]);
  }
  const clashes = [...byPath.entries()].filter(([, ks]) => ks.length > 1);
  return { errors: clashes.map(([p, ks]) => `artifact: ${ks.join(", ")} all name ${p}; each open slice needs its own deliverable path`), warnings: [] };
}

export const generalValidators = [checklistGates, distinctArtifacts];
