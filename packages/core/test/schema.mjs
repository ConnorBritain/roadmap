// packages/core tests — the JSON schemas declare every meta key the code reads (backlog b1: meta
// was additionalProperties:false while command_lane / assistants / jira / audit were undeclared),
// and the repo's own roadmap + backlog carry no key the schema would reject.
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { test, eq, ok } from "./harness.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schema = (f) => JSON.parse(readFileSync(join(REPO, "schema", f), "utf8"));

// Every `meta.<key>` the packages and scripts read (graph.mjs, validate-core, the executors, the
// loader). Kept explicit so a new reader has to declare its key here AND in the schema.
const ROADMAP_META_KEYS = ["schema_version", "program", "profile", "north_star", "updated", "default_gate", "branch_convention",
  "worktree_root", "worktree_gb", "terminal", "default_concurrency", "worker_mode", "agent_cmd", "completed_window_days",
  "base_branch", "remote", "default_weight", "weight_patterns", "weight_cost", "initiatives", "plate", "dispatch", "gauntlet",
  "linear", "estimation", "discipline", "last_review", "links", "command_lane", "assistants", "jira"];

test("schema: roadmap meta declares every key the code reads, and backlog meta declares audit", () => {
  const meta = schema("roadmap.schema.json").properties.meta;
  eq(meta.additionalProperties, false, "meta stays closed (typos are caught)");
  const declared = Object.keys(meta.properties);
  const missing = ROADMAP_META_KEYS.filter((k) => !declared.includes(k));
  eq(missing, [], "every read key is declared");
  const bmeta = schema("backlog.schema.json").properties.meta;
  ok(bmeta.properties.audit && bmeta.properties.audit.properties.known_damage, "backlog meta.audit.known_damage declared");
  ok(meta.properties.command_lane.required.includes("until") && meta.properties.gate === undefined, "command_lane requires its date");
});

test("schema: this repo's own roadmap.yaml and backlog.yaml use only declared meta keys", () => {
  const r = parse(readFileSync(join(REPO, "docs", "roadmap", "roadmap.yaml"), "utf8"));
  const b = parse(readFileSync(join(REPO, "docs", "roadmap", "backlog.yaml"), "utf8"));
  const rdecl = Object.keys(schema("roadmap.schema.json").properties.meta.properties);
  const bdecl = Object.keys(schema("backlog.schema.json").properties.meta.properties);
  eq(Object.keys(r.meta).filter((k) => !rdecl.includes(k)), [], "roadmap meta keys declared");
  eq(Object.keys(b.meta).filter((k) => !bdecl.includes(k)), [], "backlog meta keys declared");
});
