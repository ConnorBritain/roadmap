// The Executor contract (core). Every implementation registers this suite. The fixture supplies a
// root, a graph and one launchable slice node; the contract drives the executor only through the
// interface, always with opts.dry so nothing is spawned.
//
//   makeFixture() -> { executor, root, graph, slice, cleanup?() }
import { assertExecutor, assertReceipt, EXECUTOR_STATES } from "@connorbritain/roadmap-core/executor.mjs";

export function executorContract(name, makeFixture, { test, eq, ok }) {
  const ctxOf = (fx) => ({ root: fx.root, graph: fx.graph, meta: fx.graph.meta || {}, env: {} });

  test(`${name} Executor: implements the interface with well-formed capabilities`, () => {
    const fx = makeFixture();
    try {
      const x = assertExecutor(fx.executor);
      const caps = x.capabilities();
      ok(caps.artifactKinds.every((k) => typeof k === "string"), "artifact kinds are names");
    } finally { fx.cleanup && fx.cleanup(); }
  });

  test(`${name} Executor: scope() proposes fields with a rationale and never writes`, async () => {
    const fx = makeFixture();
    try {
      const before = JSON.stringify([fx.graph, fx.slice]);
      const r = await fx.executor.scope(fx.slice, ctxOf(fx));
      ok(r && typeof r.fields === "object" && Array.isArray(r.rationale), "shape { fields, rationale }");
      eq(JSON.stringify([fx.graph, fx.slice]), before, "graph and slice untouched");
    } finally { fx.cleanup && fx.cleanup(); }
  });

  test(`${name} Executor: capacity() recommends at least one slot and names what binds; annotate() returns fields`, async () => {
    const fx = makeFixture();
    try {
      const cap = await fx.executor.capacity(fx.graph, ctxOf(fx));
      ok(Number.isFinite(cap.recommended) && cap.recommended >= 1, `recommended ≥ 1 (got ${cap.recommended})`);
      ok(cap.binding && typeof cap.binding.why === "string", "binding names why");
      const extra = await fx.executor.annotate(fx.slice, fx.graph, ctxOf(fx));
      ok(extra && typeof extra === "object", "annotate returns an object");
    } finally { fx.cleanup && fx.cleanup(); }
  });

  test(`${name} Executor: a dry launch returns a receipt, is idempotent per key, and spawns nothing`, async () => {
    const fx = makeFixture();
    try {
      const a = assertReceipt(await fx.executor.launch(fx.slice, { dry: true }, ctxOf(fx)));
      const b = assertReceipt(await fx.executor.launch(fx.slice, { dry: true }, ctxOf(fx)));
      eq([a.executor, a.slice, a.dry], [fx.executor.name, fx.slice.invoke, true], "receipt names the executor, the slice, and that it was dry");
      eq(a.key, b.key, "the same launch has the same key");
      const st = await fx.executor.status(fx.slice, ctxOf(fx));
      ok(EXECUTOR_STATES.includes(st.state), `status state is one of the interface set (got ${st.state})`);
      ok(Array.isArray(st.receipts) && Array.isArray(await fx.executor.receipts(fx.slice, ctxOf(fx))), "receipts are arrays");
    } finally { fx.cleanup && fx.cleanup(); }
  });

  test(`${name} Executor: cleanup() is dry by default`, async () => {
    const fx = makeFixture();
    try {
      const r = await fx.executor.cleanup({}, ctxOf(fx));
      eq(r.dry, true, "dry by default");
      ok(Array.isArray(r.removed) && Array.isArray(r.kept) && r.removed.length === 0, "nothing removed on a dry cleanup");
    } finally { fx.cleanup && fx.cleanup(); }
  });
}
