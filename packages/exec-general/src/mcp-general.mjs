// roadmap — the general profile's MCP tools: the conducted loop over a git-file artifact and
// human assignment. The loader appends GENERAL_TOOLS to the core list; callGeneralTool answers
// them (undefined = not one of ours).
import { conductStart, conductStatus, conductCritic, conductVerdict, conductAck, conductRepair, conductReconcile } from "./conduct.mjs";
import { humanExecutor } from "./executors.mjs";
import { loadGraph, flatten } from "@connorbritain/roadmap-core/graph.mjs";
import { roadmapPaths } from "@connorbritain/roadmap-core/store.mjs";

export const GENERAL_TOOLS = [
  { name: "assign", description: "Assign a slice to a person (the human executor): writes the assignment brief under .roadmap/assignments/ with the checklist gate and the artifact path. dry=true previews the brief.",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string", description: "slice invoke key" }, assignee: { type: "string" }, dry: { type: "boolean" } } } },
  { name: "conduct_start", description: "Freeze the quality bar for a slice into its git-file artifact sidecar (committed), claim the run, and launch the executor (human = assignment brief; doc-agent = brief + configured assistant). No PR, no cloud. dry=true previews.",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" }, executor: { enum: ["human", "doc-agent"] }, assignee: { type: "string" }, max_rounds: { type: "integer", minimum: 0, maximum: 20 }, bar: { type: "string" }, dry: { type: "boolean" } } } },
  { name: "conduct_status", description: "Read-only: rebuild a conducted run from the ledger or the committed sidecar and derive its state (awaiting_pr → awaiting_critic → critic_in_flight → awaiting_lead_ack → needs_repair/passed …), the artifact's exact head, and the safe next actions.",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string", description: "run id or slice key" } } } },
  { name: "conduct_critic", description: "Launch one fresh independent critic for the artifact's exact head: records the launch, claims an atomic git ref, posts the lead attestation to the sidecar, and writes the critic brief (human) or starts the assistant (doc-agent). Refuses stale heads and unsafe states.",
    inputSchema: { type: "object", required: ["run", "expected_head"], properties: { run: { type: "string" }, expected_head: { type: "string", pattern: "^[a-f0-9]{40}$" }, critic_role: { type: "string" }, assignee: { type: "string" }, dry: { type: "boolean" } } } },
  { name: "conduct_verdict", description: "Post the launched critic's verdict (PASS|REVISE|HUMAN_REQUIRED|INVALID_OR_STALE) with a rationale as an immutable sidecar comment bound to the launch nonce. Non-authoritative until the frozen lead acknowledges it.",
    inputSchema: { type: "object", required: ["run", "verdict", "rationale"], properties: { run: { type: "string" }, verdict: { enum: ["PASS", "REVISE", "HUMAN_REQUIRED", "INVALID_OR_STALE"] }, rationale: { type: "string", minLength: 1 }, must_fix: { type: "string" }, expected_head: { type: "string" } } } },
  { name: "conduct_ack", description: "After the frozen lead inspects one exact critic comment, post the acknowledgment bound to its body and locator digests. Requires confirm=true.",
    inputSchema: { type: "object", required: ["run", "comment_url", "confirm"], properties: { run: { type: "string" }, comment_url: { type: "string" }, confirm: { const: true } } } },
  { name: "conduct_repair", description: "Launch a repair against the artifact at an exact expected head with a lead-synthesized packet. Requires an acknowledged current-head REVISE; refuses stale heads and exhausted rounds.",
    inputSchema: { type: "object", required: ["run", "expected_head", "packet"], properties: { run: { type: "string" }, expected_head: { type: "string", pattern: "^[a-f0-9]{40}$" }, packet: { type: "string", minLength: 1 }, assignee: { type: "string" }, dry: { type: "boolean" } } } },
  { name: "conduct_reconcile", description: "The general sync: list every conducted run's state; runs with an acknowledged PASS on the current head propose their slice complete. apply=true writes the status through the store (YAML comments preserved).",
    inputSchema: { type: "object", properties: { apply: { type: "boolean" } } } },
];

export async function callGeneralTool(name, args, { root }) {
  const a = args || {};
  if (name === "assign") {
    const graph = loadGraph(roadmapPaths(root).yaml);
    const node = flatten(graph).nodes.find((n) => n.invoke === a.key);
    if (!node) throw new Error(`no slice "${a.key}"`);
    return humanExecutor({ root }).launch(node, { assignee: a.assignee, dry: !!a.dry }, { root, graph });
  }
  if (name === "conduct_start") return conductStart(root, a.key, { executor: a.executor, assignee: a.assignee, maxRounds: a.max_rounds, additionalBar: a.bar, dry: !!a.dry });
  if (name === "conduct_status") return conductStatus(root, a.run);
  if (name === "conduct_critic") return conductCritic(root, a.run, { expectedHead: a.expected_head, criticRole: a.critic_role, assignee: a.assignee, dry: !!a.dry });
  if (name === "conduct_verdict") return conductVerdict(root, a.run, { verdict: a.verdict, rationale: a.rationale, mustFix: a.must_fix, expectedHead: a.expected_head });
  if (name === "conduct_ack") return conductAck(root, a.run, { commentUrl: a.comment_url, confirm: a.confirm === true });
  if (name === "conduct_repair") return conductRepair(root, a.run, { expectedHead: a.expected_head, packet: a.packet, assignee: a.assignee, dry: !!a.dry });
  if (name === "conduct_reconcile") return conductReconcile(root, { apply: !!a.apply });
  return undefined;
}
