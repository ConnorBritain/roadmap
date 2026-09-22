#!/usr/bin/env node
// roadmap dispatch <key> [--to claude-cloud|claude|codex|oz] — send a slice/backlog item to a
// CLOUD agent instead of a local worktree. The wave-scale version is `roadmap fan --cloud`.
//
// Two transports:
//   claude-cloud (RECOMMENDED) — fires a Claude Code cloud session directly via the Routines
//     API (code.claude.com/docs/en/routines). Needs NO Linear at all; runs on the CURRENTLY
//     AUTHED claude.ai account's plan limits (multi-account hot-swap via ~/.claude-routines.json
//     keyed by account email — see docs/DEPLOYMENT.md § Cloud dispatch). BETA API: the fire
//     endpoint ships under an experimental header and may change.
//   claude|codex|oz — posts an @-mention capsule comment on the mapped Linear issue. The
//     comment is live-verified; whether the mention SUMMONS an agent requires the agent's
//     integration installed in the Linear workspace (Linear's native coding sessions are
//     paid-plan-gated; the delegate-field mutation remains unverified).
// CLI shell: the body lives in @connorbritain/roadmap-exec-engineering/cloud-dispatch.mjs; this file parses argv and re-exports it.
export * from "@connorbritain/roadmap-exec-engineering/cloud-dispatch.mjs";
import { DISPATCH_AGENTS, runDispatch } from "@connorbritain/roadmap-exec-engineering/cloud-dispatch.mjs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const key = args.find((a) => !a.startsWith("-"));
  if (!key) {
    console.error(`usage: roadmap dispatch <slice-invoke|backlog-id> [--provider claude|codex] [--to claude-cloud|codex-cloud|${Object.keys(DISPATCH_AGENTS).join("|")}]   (default claude)`);
    process.exit(2);
  }
  try {
    const r = await runDispatch(process.cwd(), key, { to: val("--to"), provider: val("--provider"), environmentId: val("--environment"), attempts: val("--attempts"), model: val("--model"), force: args.includes("--force"), tier: val("--tier") });
    if (r.transport === "claude-cloud") {
      console.log(`dispatched ${r.dispatched} → Claude Code cloud session (${r.routine}).`);
      console.log(`session: ${r.sessionUrl}`);
      if (r.linearComment) console.log(`board:   session link commented on ${r.linearComment}`);
      console.log(`(beta Routines API — if shapes change, check code.claude.com/docs/en/routines)`);
    } else if (r.transport === "codex-cloud") {
      console.log(`dispatched ${r.dispatched} → Codex Cloud task.`);
      console.log(`environment: ${r.environmentId}\ntask: ${r.taskId}\nurl: ${r.taskUrl}`);
      console.log("artifact: awaiting publication (the supported Codex CLI has no unattended task→PR command)");
    } else {
      console.log(`dispatched ${r.dispatched} → ${r.identifier} via ${r.agent} @-mention comment.`);
      console.log(`VERIFY the agent picked it up. Live-tested finding: the comment posts fine, but summoning requires the agent's`);
      console.log(`integration to be INSTALLED in the Linear workspace (Linear's native coding sessions are paid-plan-gated);`);
      console.log(`without it there is nothing to summon. If installed and nothing happens, delegate by hand — the capsule`);
      console.log(`comment is already on the issue to orient the agent.`);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
