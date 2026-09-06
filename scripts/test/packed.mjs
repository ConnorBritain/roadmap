// Exercise the installed tarball, not source-tree imports. Never launches cloud work.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { npmCommand } from "./npm-command.mjs";

const archive = resolve(process.argv[2] || "");
assert.ok(archive.endsWith(".tgz"), "pass the candidate npm tarball");
const root = mkdtempSync(join(tmpdir(), "roadmap-packed-smoke-"));
function execute(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, input, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}
try {
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
  const npm = npmCommand(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", archive]);
  execute(npm.command, npm.args);
  const installed = join(root, "node_modules", "@connorbritain", "roadmap");
  const cli = join(installed, "scripts", "cli.mjs");
  const mcp = join(installed, "scripts", "mcp.mjs");
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "roadmap.yaml"), readFileSync(new URL("./fixtures/admission/roadmap.yaml", import.meta.url)));
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "example.js"), "export const value = 1;\n");
  writeFileSync(join(root, "assignments.yaml"), "- id: source-map\n  wave: wave-one\n  prompt: Inspect example.js\n");
  execute("git", ["init", "-q"]); execute("git", ["config", "user.name", "Package fixture"]);
  execute("git", ["config", "user.email", "fixture@example.test"]);
  execute("git", ["add", "."]); execute("git", ["commit", "-qm", "fixture source"]);
  const sha = execute("git", ["rev-parse", "HEAD"]).trim();
  execute(process.execPath, [cli, "validate"]);
  execute(process.execPath, [cli, "gauntlet", "eval", "init", "--run", "package-smoke", "--base-sha", sha, "--assignments", join(root, "assignments.yaml")]);
  const packet = join(root, "docs/gauntlets/fixture/evaluation/runs/package-smoke/inbox/source-map");
  mkdirSync(packet, { recursive: true });
  writeFileSync(join(packet, "REPORT.md"), "Source has an export. [[evidence:E1]]\n");
  const captured_at = new Date().toISOString();
  writeFileSync(join(packet, "evidence.yaml"), JSON.stringify({ version: 1,
    packet: { run_id: "package-smoke", assignment: "source-map", base_sha: sha, captured_at, artifacts: [] },
    evidence: [{ id: "E1", type: "source_code", claim: "The source exports a constant.", boundary: "source", captured_at,
      limitations: ["No runtime check"], references: [{ path: "example.js", sha, line_start: 1, line_end: 1 }] }] }));
  const validation = JSON.parse(execute(process.execPath, [cli, "gauntlet", "eval", "validate", "--run", "package-smoke", "--assignment", "source-map"]));
  assert.equal(validation.ok, true);
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gauntlet_eval_validate", arguments: { run: "package-smoke", assignment: "source-map" } } },
  ];
  const replies = execute(process.execPath, [mcp], requests.map((request) => JSON.stringify(request)).join("\n") + "\n")
    .trim().split("\n").map((line) => JSON.parse(line));
  const listed = replies.find((reply) => reply.id === 1).result.tools;
  for (const name of ["gauntlet_start", "gauntlet_status", "gauntlet_observe", "gauntlet_reconcile", "gauntlet_decision", "gauntlet_eval_decision", "gauntlet_eval_validate", "gauntlet_eval_collect", "gauntlet_eval_migrate",
    "gauntlet_continuation", "gauntlet_eval_continuation", "gauntlet_eval_authorize", "gauntlet_eval_critic", "gauntlet_eval_ack", "gauntlet_eval_repair", "gauntlet_eval_reconcile"]) {
    assert.ok(listed.some((tool) => tool.name === name), name);
  }
  const result = replies.find((reply) => reply.id === 2).result;
  assert.ok(!result.isError); assert.equal(JSON.parse(result.content[0].text).digest, validation.digest);
  assert.equal(listed.find((tool) => tool.name === "gauntlet_status").inputSchema.properties.all.type, "boolean");
  assert.ok(listed.find((tool) => tool.name === "gauntlet_eval_critic").inputSchema.properties.model_preference);
  assert.equal(listed.find((tool) => tool.name === "gauntlet_eval_critic").inputSchema.properties.allow_incomplete.type, "boolean");
  for (const name of ["EVIDENCE_PACKETS.md", "EVALUATION_RUNBOOK.md", "GAUNTLET_CONTINUATION.md", "specs/trustworthy-gauntlet.md", "qualification/2026-09-06-pidgeon.md"]) assert.ok(readFileSync(join(installed, "docs", name)).length);
  console.log("Packed artifact: CLI roadmap validation, evaluation init/admission, MCP registry and admission parity passed. No remote submissions.");
} finally { rmSync(root, { recursive: true, force: true }); }
