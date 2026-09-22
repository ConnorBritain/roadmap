#!/usr/bin/env node
// roadmap conduct — the general profile's conducted loop over a git-file artifact (thin CLI).
//
//   conduct start <key> [--executor human|doc-agent] [--assignee who] [--bar "extra criteria"] [--dry]
//   conduct status <run|key>
//   conduct critic <run> --head <sha> [--role critic] [--assignee who] [--dry]
//   conduct verdict <run> --verdict PASS|REVISE|HUMAN_REQUIRED|INVALID_OR_STALE --rationale "…" [--must-fix "…"]
//   conduct ack <run> --comment <locator> --confirm
//   conduct repair <run> --head <sha> --packet <text|@file> [--dry]
//   conduct reconcile [--apply]
import { readFileSync } from "node:fs";
import { conductStart, conductStatus, conductCritic, conductVerdict, conductAck, conductRepair, conductReconcile } from "@connorbritain/roadmap-exec-general/conduct.mjs";

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const [action, target] = args.filter((a) => !a.startsWith("--")).slice(0, 2);
const root = process.cwd();
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

try {
  if (action === "start") out(await conductStart(root, target, { executor: val("--executor", "human"), assignee: val("--assignee", null), additionalBar: val("--bar", null), dry: has("--dry") }));
  else if (action === "status") out(conductStatus(root, target));
  else if (action === "critic") out(await conductCritic(root, target, { expectedHead: val("--head", null), criticRole: val("--role", null), assignee: val("--assignee", null), dry: has("--dry") }));
  else if (action === "verdict") out(conductVerdict(root, target, { verdict: val("--verdict", null), rationale: val("--rationale", null), mustFix: val("--must-fix", null), expectedHead: val("--head", null) }));
  else if (action === "ack") out(conductAck(root, target, { commentUrl: val("--comment", null), confirm: has("--confirm") }));
  else if (action === "repair") {
    const p = val("--packet", "");
    out(await conductRepair(root, target, { expectedHead: val("--head", null), packet: p.startsWith("@") ? readFileSync(p.slice(1), "utf8") : p, assignee: val("--assignee", null), dry: has("--dry") }));
  }
  else if (action === "reconcile") out(conductReconcile(root, { apply: has("--apply") }));
  else { console.error("usage: roadmap conduct start|status|critic|verdict|ack|repair|reconcile … (see the header of scripts/conduct.mjs)"); process.exit(2); }
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
