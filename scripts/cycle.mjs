#!/usr/bin/env node
// roadmap cycle — the weekly election surface.
//   roadmap cycle plan [--capacity N] [--json]     zero-network: graph + sync cursor (stale set)
//   roadmap cycle lock --promote a,b [--demote x,y] one atomic validated write (scheduled↔next)
// The interview lives in the /cycle skill; this owns the data and the write. Statuses are the
// bookkeeping: promote = scheduled→next (committed this cycle), demote = next→scheduled. The
// Linear cycle itself follows on the next sync (cyclePlan mirrors active+next).
// CLI shell: the body lives in @connorbritain/roadmap-core/cycle-io.mjs; this file parses argv and re-exports it.
export * from "@connorbritain/roadmap-core/cycle-io.mjs";
import { runCycleLock, runCyclePlan } from "@connorbritain/roadmap-core/cycle-io.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const sub = args[0];
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const list = (n) => (val(n) ? val(n).split(",").map((s) => s.trim()).filter(Boolean) : []);
  const root = process.cwd();
  try {
    if (sub === "plan" || sub == null) {
      const p = runCyclePlan(root, { capacity: val("--capacity") ? Number(val("--capacity")) : undefined });
      if (args.includes("--json")) { console.log(JSON.stringify(p, null, 2)); process.exit(0); }
      const line = (x) => `  ${x.stale ? "⚠ STALE " : ""}${x.invoke} (${x.status}${x.est != null ? ` · ${x.est}s` : " · unestimated"}${x.priority && x.priority.tier ? ` · ${x.priority.tier}` : ""}) — ${x.title}`;
      const staleElected = p.elected.filter((x) => x.stale);
      if (staleElected.length) {
        console.log(`STALE — review these FIRST (journal silence past stale_days):`);
        for (const x of staleElected) console.log(line(x));
      }
      console.log(`committed (${p.elected.length}, ${p.elected.reduce((s, x) => s + (x.est || 0), 0)}s of ${p.capacity}s capacity):`);
      for (const x of p.elected) console.log(line(x));
      console.log(`fits on top (greedy prefix, priority order):`);
      for (const x of p.packed) console.log(line(x));
      if (!p.packed.length) console.log(`  (nothing — capacity full or no estimated ready candidates)`);
      if (p.overflow.length) console.log(`over capacity (ready, estimated, doesn't fit): ${p.overflow.map((x) => x.invoke).join(", ")}`);
      if (p.unestimated.length) console.log(`unestimated (never auto-packed — price or pass): ${p.unestimated.map((x) => x.invoke).join(", ")}`);
      if (p.unpricedElected.length) console.log(`⚠ committed but unpriced (counts as ZERO in capacity — price these): ${p.unpricedElected.map((x) => x.invoke).join(", ")}`);
      console.log(`lock with: roadmap cycle lock --promote <a,b,...> [--demote <x,y,...>]  · then 'roadmap linear sync' projects the cycle`);
    } else if (sub === "lock") {
      const r = runCycleLock(root, { promote: list("--promote"), demote: list("--demote") });
      console.log(`locked: promoted ${r.promoted.length ? r.promoted.join(", ") : "none"} → next${r.demoted.length ? ` · demoted ${r.demoted.join(", ")} → scheduled` : ""}.`);
      console.log(`run 'roadmap linear sync' to project the cycle (active+next join the active Linear cycle).`);
    } else {
      console.error(`usage: roadmap cycle plan [--capacity N] [--json] | roadmap cycle lock --promote a,b [--demote x,y]`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
