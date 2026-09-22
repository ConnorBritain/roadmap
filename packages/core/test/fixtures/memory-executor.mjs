// An in-memory Executor — the reference implementation the contract is validated against, and the
// seed for exec-general's `human` executor: launch marks the slice assigned, status/receipts read
// back what was recorded, cleanup has nothing to remove.
import { genericScope } from "@connorbritain/roadmap-core/executor.mjs";
import { defaultCapacity } from "@connorbritain/roadmap-core/plan.mjs";

export function memoryExecutor({ name = "human", actor = "someone", now = () => new Date().toISOString() } = {}) {
  const assignments = new Map();   // invoke -> receipt
  return {
    name,
    capabilities() { return { concurrent: true, artifactKinds: ["doc", "git-file"], gateKind: "checklist" }; },
    scope(slice, ctx) { return genericScope(slice, ctx.graph, {}); },
    capacity(graph) { return defaultCapacity([], graph); },
    annotate(node) { return { assignee: assignments.get(node.invoke)?.actor || null }; },
    launch(slice, opts = {}) {
      const key = `${name}:${slice.invoke}:${opts.assignee || actor}`;
      if (assignments.has(key)) return assignments.get(key);
      const receipt = { key, executor: name, slice: slice.invoke, actor: opts.assignee || actor, started_at: now(), dry: !!opts.dry };
      if (!opts.dry) assignments.set(key, receipt);
      return receipt;
    },
    status(slice) {
      const receipts = [...assignments.values()].filter((r) => r.slice === slice.invoke);
      return { state: receipts.length ? "assigned" : "idle", receipts, notes: [] };
    },
    receipts(slice) { return [...assignments.values()].filter((r) => r.slice === slice.invoke); },
    cleanup(opts = {}) { return { removed: [], kept: [...assignments.keys()], dry: !opts.remove }; },
  };
}

export function memoryExecutorFixture() {
  const graph = { meta: { schema_version: 1, program: "T", default_gate: "npm test", links: { narrative: "ROADMAP.md" } }, pis: [
    { id: "a", title: "A", status: "active", sprints: [{ id: "s1", title: "Write the guide", status: "next", invoke: "guide", what: "draft docs/guide.md" }] } ] };
  return { executor: memoryExecutor(), root: "/nonexistent", graph, slice: { invoke: "guide", title: "Write the guide", what: "draft docs/guide.md", status: "next" } };
}
