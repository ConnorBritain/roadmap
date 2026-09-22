// packages/core tests — the Executor interface helpers, the generic scoper, and the contract run
// against the in-memory reference executor.
import { test, eq, ok, throws } from "./harness.mjs";
import { assertExecutor, assertReceipt, genericScope, EXECUTOR_METHODS } from "@connorbritain/roadmap-core/executor.mjs";
import { executorContract } from "./contracts/executor.mjs";
import { memoryExecutorFixture } from "./fixtures/memory-executor.mjs";

test("executor: assertExecutor names missing methods, refuses unknown names and malformed capabilities", () => {
  throws(() => assertExecutor({ name: "human" }), "is missing:", "missing methods listed");
  const full = Object.fromEntries(EXECUTOR_METHODS.map((m) => [m, () => ({})]));
  throws(() => assertExecutor({ ...full, name: "mainframe" }), "name must be one of", "unknown executor name");
  throws(() => assertExecutor({ ...full, name: "human", capabilities: () => ({}) }), "capabilities() must return", "malformed capabilities");
  ok(assertExecutor({ ...full, name: "human", capabilities: () => ({ concurrent: true, artifactKinds: [], gateKind: "checklist" }) }), "a complete executor passes");
  throws(() => assertReceipt({ key: "k" }), "missing executor", "receipt shape enforced");
});

test("genericScope: fills gate from the program default (or a review checklist), read_order from links + named paths, est_sessions from shape; never writes", () => {
  const graph = { meta: { default_gate: "npm test", links: { narrative: "ROADMAP.md", status: "docs/STATUS.md" } } };
  const node = { invoke: "x", what: "Update docs/guide.md and src/a.ts per the plan", shape: "refactor" };
  const before = JSON.stringify(node);
  const r = genericScope(node, graph);
  eq(r.fields.gate, "default", "gate → default");
  eq(r.fields.read_order, ["ROADMAP.md", "docs/STATUS.md", "docs/guide.md", "src/a.ts"], "links first, then paths named in the prose");
  eq(r.fields.est_sessions, 3, "refactor → 3 sessions");
  eq(JSON.stringify(node), before, "node untouched");
  const bare = genericScope({ invoke: "y", what: "think about it" }, { meta: {} });
  eq(bare.fields.gate, ["Reviewed by someone other than the author"], "no default gate → a checklist");
  eq(bare.fields.est_sessions, 1, "no shape → 1");
  ok(!("read_order" in bare.fields), "nothing to read → no read_order proposal");
  const exists = genericScope({ invoke: "z", what: "see docs/real.md and docs/ghost.md" }, { meta: {} }, { fileExists: (p) => p === "docs/real.md" });
  eq(exists.fields.read_order, ["docs/real.md"], "an injected fileExists filters phantom paths");
  const kept = genericScope({ invoke: "w", gate: "make check", est_sessions: 2, read_order: ["a.md"], what: "touch docs/b.md" }, { meta: { default_gate: "x" } });
  eq(kept.fields, { read_order: ["a.md", "docs/b.md"] }, "declared gate/est_sessions are respected; read_order is extended, not replaced");
});

executorContract("memory (reference)", memoryExecutorFixture, { test, eq, ok });
