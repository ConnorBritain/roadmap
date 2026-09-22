#!/usr/bin/env node
// roadmap gauntlet — the CLI entry. The runtime (senses + actuators) is scripts/lib/gauntlet-runtime.mjs,
// the portfolio view is scripts/lib/gauntlet-portfolio-io.mjs, and this file wires them; it re-exports
// the runtime so mcp.mjs and the tests keep one import path.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDecisionFile } from "./lib/gauntlet-decisions.mjs";
import { runGauntletPortfolio } from "./lib/gauntlet-portfolio-io.mjs";
import {
  runGauntletStart, runGauntletStatus, runGauntletObserve, runGauntletContinuation, runGauntletReconcile,
  runGauntletDecision, runGauntletAcknowledge, runGauntletCritic, runGauntletRepair, runGauntletCancel,
  formatGauntletStatus, formatGauntletLaunchResult,
} from "./lib/gauntlet-runtime.mjs";
export * from "./lib/gauntlet-runtime.mjs";

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "eval") {
    const result = spawnSync("node", [resolve(new URL("./evaluate.mjs", import.meta.url).pathname), ...args.slice(1)], {
      cwd: process.cwd(), stdio: "inherit",
    });
    process.exit(result.status ?? 1);
  }
  const known = new Set(["start", "status", "observe", "continuation", "reconcile", "decision", "ack", "critic", "repair", "cancel"]);
  const action = known.has(args[0]) ? args.shift() : "start";
  const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const modelPreference = val("--model") || val("--reasoning-effort") || args.includes("--strict-model")
    ? { ...(val("--model") ? { model: val("--model") } : {}), ...(val("--reasoning-effort") ? { reasoning_effort: val("--reasoning-effort") } : {}),
      ...(args.includes("--strict-model") ? { strict: true } : {}) } : null;
  const positional = args.find((arg, index) => !arg.startsWith("-") && (index === 0 || !args[index - 1].startsWith("--")));
  if (!positional && !(action === "status" && args.includes("--all"))) {
    console.error(`usage:
  roadmap gauntlet start <key> [--bar-file <path>] [--max-rounds <0..20>] [--implementation-provider claude|codex] [--critic-provider claude|codex] [--repair-provider claude|codex] [--implementation-tier <tier>] [--critic-tier <tier>] [--critic-profile <name>] [--repair-tier <tier>] [--force]
  roadmap gauntlet status <run|key> [--json] | status --all --json
  roadmap gauntlet reconcile <run> --launch-key <key> --task-id <exact-id> --task-url <exact-url> --reason <text> --confirm
  roadmap gauntlet decision <run> --expected-head <sha> --record-file <decision.json> --confirm
  roadmap gauntlet continuation <run> --receipt-file <desktop-receipt.json> --confirm
  roadmap gauntlet ack <run|key> --comment-url <exact-url> --confirm
  roadmap gauntlet critic <run|key> --expected-head <full-sha> [--provider claude|codex] [--critic-role <slug>] [--tier <tier>] [--profile <name>] [--force-checks] [--confirm-recovered-bar]
  roadmap gauntlet repair <run|key> --expected-head <full-sha> --packet-file <path> [--provider claude|codex] [--tier <tier>] [--profile <name>]
  roadmap gauntlet cancel <run|key> --reason <text> --confirm`);
    process.exit(2);
  }
  try {
    let result;
    if (action === "start") {
      const barFile = val("--bar-file");
      result = await runGauntletStart(process.cwd(), positional, {
        maxRounds: val("--max-rounds") != null ? Number(val("--max-rounds")) : undefined,
        criticTier: val("--critic-tier"), criticProfile: val("--critic-profile"),
        implementationTier: val("--implementation-tier"), repairTier: val("--repair-tier"),
        implementationProvider: val("--implementation-provider"), criticProvider: val("--critic-provider"), repairProvider: val("--repair-provider"),
        force: args.includes("--force"),
        authorizationPolicy: val("--authorization-file") ? JSON.parse(readFileSync(resolve(val("--authorization-file")), "utf8")) : null,
        continuationRecord: val("--continuation-file") ? readDecisionFile(val("--continuation-file")) : null,
        confirmContinuation: args.includes("--confirm-continuation"),
        modelPreference,
        additionalBar: barFile ? readFileSync(resolve(barFile), "utf8") : null,
      });
      console.log(result.launched === false ? `Gauntlet ${result.runId} is awaiting desktop continuation; no worker was launched.\n${result.continuation.handoff}` : result.duplicate
        ? `Gauntlet ${result.runId} already active for ${positional} (${result.state}).`
        : `Gauntlet ${result.runId} started for ${positional}.\nimplementation (${result.provider || "claude"}): ${result.externalUrl || result.sessionUrl}\nstate: ${result.state}`);
    } else if (action === "status") {
      result = args.includes("--all") ? await runGauntletPortfolio(process.cwd(), {}) : await runGauntletStatus(process.cwd(), positional, {});
      console.log(args.includes("--json") || args.includes("--all") ? JSON.stringify(result, null, 2) : formatGauntletStatus(result));
    } else if (action === "observe") {
      result = await runGauntletObserve(process.cwd(), positional);
      console.log(JSON.stringify(result, null, 2));
    } else if (action === "continuation") {
      result = await runGauntletContinuation(process.cwd(), positional, { record: readDecisionFile(val("--receipt-file")), confirm: args.includes("--confirm") });
      console.log(JSON.stringify(result, null, 2));
    } else if (action === "reconcile") {
      result = await runGauntletReconcile(process.cwd(), positional, { launchKey: val("--launch-key"), taskId: val("--task-id"), taskUrl: val("--task-url"),
        reason: val("--reason"), confirm: args.includes("--confirm") });
      console.log(JSON.stringify(result, null, 2));
    } else if (action === "decision") {
      result = await runGauntletDecision(process.cwd(), positional, { expectedHead: val("--expected-head"), record: readDecisionFile(val("--record-file")), confirm: args.includes("--confirm") });
      console.log(JSON.stringify(result, null, 2));
    } else if (action === "ack") {
      result = await runGauntletAcknowledge(process.cwd(), positional, {
        commentUrl: val("--comment-url"), confirm: args.includes("--confirm"),
      });
      console.log(result.duplicate
        ? `Gauntlet ${result.runId} verdict was already acknowledged.`
        : `Gauntlet ${result.runId} acknowledged ${result.verdict} @ ${result.head}.`);
    } else if (action === "critic") {
      result = await runGauntletCritic(process.cwd(), positional, {
        modelPreference,
        expectedHead: val("--expected-head"), tier: val("--tier"),
        profile: val("--profile"), provider: val("--provider"), criticRole: val("--critic-role") || "critic",
        forceChecks: args.includes("--force-checks"),
        confirmRecoveredBar: args.includes("--confirm-recovered-bar"),
      });
      console.log(formatGauntletLaunchResult(result, "critic"));
    } else if (action === "repair") {
      const packetFile = val("--packet-file");
      const packet = packetFile ? readFileSync(resolve(packetFile), "utf8") : val("--packet");
      result = await runGauntletRepair(process.cwd(), positional, {
        modelPreference,
        expectedHead: val("--expected-head"), packet, tier: val("--tier"), profile: val("--profile"), provider: val("--provider"),
      });
      console.log(formatGauntletLaunchResult(result, "repair"));
    } else {
      result = await runGauntletCancel(process.cwd(), positional, {
        reason: val("--reason"), confirm: args.includes("--confirm"),
      });
      console.log(`Gauntlet ${result.runId} cancelled: ${result.reason}`);
    }
    for (const warning of result?.modelPolicy?.warnings || []) console.error(`warning: ${warning}`);
  } catch (e) {
    console.error(`roadmap gauntlet: ${e.message}`);
    process.exit(1);
  }
}

if (isMain) main().catch((error) => {
  console.error(`roadmap gauntlet: ${error.message}`);
  process.exitCode = 1;
});
