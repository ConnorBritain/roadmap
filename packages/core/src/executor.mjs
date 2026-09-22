// roadmap — the Executor interface (core). How a slice gets worked. The profile loader registers
// one; core reaches execution only through this surface. Pure data in, receipts out. Every method
// takes `ctx` = { root, graph, meta, env, io } with injectable io for tests.
//
//   capabilities()                -> { concurrent, artifactKinds[], gateKind: "command"|"checklist" }
//   scope(slice, ctx)             -> { fields, rationale }        proposals only; never writes
//   capacity(graph, ctx)          -> { recommended, binding, sys?, disk?, candidates[] }  (buildPlan's `capacity`)
//   annotate(node, graph, ctx)    -> extra per-node plan fields   (buildPlan's `annotate`)
//   launch(slice, opts, ctx)      -> Receipt                      idempotent per launch key; opts.dry never spawns
//   status(slice, ctx)            -> { state, receipts, artifactRef?, notes[] }
//   receipts(slice, ctx)          -> Receipt[]                    durable evidence, re-readable after ledger loss
//   cleanup(opts, ctx)            -> { removed[], kept[], dry }   dry by default
//
//   Receipt { key, executor, slice, role?, external_id?, url?, artifactRef?, actor?, started_at, ended_at?, evidence? }

export const EXECUTOR_KINDS = ["worktree-session", "cloud-dispatch", "human", "doc-agent"];
export const EXECUTOR_METHODS = ["capabilities", "scope", "capacity", "annotate", "launch", "status", "receipts", "cleanup"];
export const EXECUTOR_STATES = ["idle", "assigned", "running", "awaiting_artifact", "done", "ambiguous"];
export const GATE_KINDS = ["command", "checklist"];

export function assertExecutor(executor) {
  if (!executor || typeof executor !== "object") throw new Error("an Executor is required");
  const missing = EXECUTOR_METHODS.filter((m) => typeof executor[m] !== "function");
  if (missing.length) throw new Error(`Executor ${executor.name || "?"} is missing: ${missing.join(", ")}`);
  if (!EXECUTOR_KINDS.includes(executor.name)) throw new Error(`Executor name must be one of ${EXECUTOR_KINDS.join(", ")} (got ${executor.name})`);
  const caps = executor.capabilities();
  if (typeof caps.concurrent !== "boolean" || !Array.isArray(caps.artifactKinds) || !GATE_KINDS.includes(caps.gateKind)) {
    throw new Error(`Executor ${executor.name} capabilities() must return { concurrent: bool, artifactKinds: [], gateKind: command|checklist }`);
  }
  return executor;
}

// A receipt shape check used by contract tests and the runtime before persisting.
export function assertReceipt(receipt) {
  for (const field of ["key", "executor", "slice", "started_at"]) {
    if (receipt == null || receipt[field] == null || receipt[field] === "") throw new Error(`Receipt is missing ${field}`);
  }
  return receipt;
}

// ── the generic scoper (core) ─────────────────────────────────────────────────
// Fills what a document-only view of the slice can justify: a gate (the program default when
// the slice has none), a read order (declared docs + paths the slice's own prose names), and a
// session estimate from the shape. It grep-s nothing and writes nothing; the engineering executor
// layers code-derived `touches` on top of this.
const PATH_RE = /(?:^|[\s(`"'])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})/g;
const SESSIONS_BY_SHAPE = { "trivial-edit": 1, "localized-bugfix": 1, "test-only": 1, "localized-feature": 2, "research-design": 2,
  "debugging-unknown": 2, "integration-env": 2, "refactor": 3, "migration-schema": 3, "cross-cutting-feature": 3 };

export function genericScope(node, graph, { fileExists = null } = {}) {
  const meta = (graph && graph.meta) || {};
  const fields = {};
  const rationale = [];
  const gate = node.gate;
  if (gate == null || gate === "") {
    if (meta.default_gate) { fields.gate = "default"; rationale.push("gate: the program default (meta.default_gate)"); }
    else { fields.gate = ["Reviewed by someone other than the author"]; rationale.push("gate: no program default, so a one-item review checklist"); }
  }
  const prose = [node.what, node.prompt, node.resume_action || node.resumeAction, node.kickoff_brief].filter(Boolean).join("\n");
  const named = new Set();
  for (const m of prose.matchAll(PATH_RE)) named.add(m[1]);
  const existing = new Set([...(node.read_order || node.readOrder || [])].map(String));
  const links = Object.values(meta.links || {}).filter((v) => typeof v === "string");
  const candidates = [...links, ...named].filter((p) => !existing.has(p) && (!fileExists || fileExists(p)));
  if (candidates.length) {
    fields.read_order = [...existing, ...candidates];
    rationale.push(`read_order: ${links.length ? "meta.links" : ""}${links.length && named.size ? " + " : ""}${named.size ? "paths the slice's own prose names" : ""}`.trim());
  }
  if (node.est_sessions == null && node.estSessions == null) {
    const shape = node.shape;
    fields.est_sessions = SESSIONS_BY_SHAPE[shape] || 1;
    rationale.push(shape ? `est_sessions: ${fields.est_sessions} from shape ${shape}` : "est_sessions: 1 (no shape declared; classify the slice to refine)");
  }
  return { fields, rationale };
}
