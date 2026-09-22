#!/usr/bin/env node
// roadmap linear <status|auth|setup|sync> — the ONLY file that talks to Linear's API.
// The brain is packages/core/src/linear-core.mjs (pure); this layer does GraphQL IO (global fetch,
// injectable for tests), the sync cursor, and the YAML write-backs via packages/core/src/store.mjs.
//
//   roadmap linear status [--probe] [--json]   state check (probe = one networked viewer query)
//   roadmap linear auth                        how to set LINEAR_API_KEY (never stored in files)
//   roadmap linear setup --team KEY [...]      write meta.linear (queries your teams first)
//   roadmap linear provision                   shape the workspace: labels, views, guidance texts
//   roadmap linear sync [--dry] [--push-only] [--pull-only]
//   roadmap linear post-update --pi <id> --body <text|@file>   digest → Linear project update
// CLI shell: the body lives in @connorbritain/roadmap-core/linear-io.mjs; this file parses argv and re-exports it.
export * from "@connorbritain/roadmap-core/linear-io.mjs";
import { CURSOR_FILE, fetchTeamBundle, gql, readCursor, runNote, runNotes, runProjectUpdate, runProvision, runSync } from "@connorbritain/roadmap-core/linear-io.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { mutateRoadmap, roadmapPaths } from "@connorbritain/roadmap-core/store.mjs";
import { linearState, agentGuidanceText, dispatchGuidance } from "@connorbritain/roadmap-core/linear-core.mjs";
// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : "status";
  const has = (n) => args.includes(n);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const root = process.cwd();

  try {
    if (sub === "status") {
      const graph = loadGraph(roadmapPaths(root).yaml);
      const st = linearState({ meta: graph.meta, env: process.env, cursor: readCursor(root) });
      if (has("--json")) { console.log(JSON.stringify({ configured: st.configured, authed: st.authed, lastSync: st.lastSync })); process.exit(0); }
      if (!st.configured) { console.log("Linear: not configured (add meta.linear or 'roadmap linear setup --team <KEY>')."); process.exit(0); }
      if (!st.authed) { console.log(`Linear: configured (team ${st.cfg.team}) but unauthed — set LINEAR_API_KEY ('roadmap linear auth' explains).`); process.exit(0); }
      console.log(`Linear: wired (team ${st.cfg.team} · granularity ${st.cfg.granularity} · pull ${st.cfg.pull} · last sync ${st.lastSync || "never"}).`);
      if (has("--probe")) {
        const d = await gql(`query { viewer { name email } }`, {}, { apiKey: process.env.LINEAR_API_KEY });
        console.log(`  probe ok — authed as ${d.viewer.name}`);
      }
    } else if (sub === "auth") {
      console.log([
        "Linear auth uses a personal API key in the LINEAR_API_KEY env var — never stored in any file.",
        "  1. Linear → Settings → Security & access → Personal API keys → create one.",
        "  2. PowerShell:  [Environment]::SetEnvironmentVariable('LINEAR_API_KEY','<key>','User')",
        "     bash/zsh:    echo 'export LINEAR_API_KEY=<key>' >> ~/.bashrc",
        "  3. New shell, then: roadmap linear status --probe",
      ].join("\n"));
    } else if (sub === "setup") {
      const key = process.env.LINEAR_API_KEY;
      if (!key) { console.error("✗ setup needs auth first — 'roadmap linear auth' explains."); process.exit(1); }
      const teamKey = val("--team");
      if (!teamKey) {
        const d = await gql(`query { teams(first: 50) { nodes { key name } } }`, {}, { apiKey: key });
        console.log("Your Linear teams:");
        for (const t of d.teams.nodes) console.log(`  ${t.key}  ${t.name}`);
        console.log(`\nPick the push target: roadmap linear setup --team <KEY> [--granularity pis|slices|slices+backlog] [--pull off|propose|auto]`);
        process.exit(0);
      }
      await fetchTeamBundle(teamKey, { apiKey: key });   // validates the key exists before writing
      const cfg = { team: teamKey, granularity: val("--granularity") || "slices", pull: val("--pull") || "propose" };
      mutateRoadmap(root, (doc) => { doc.setIn(["meta", "linear"], doc.createNode(cfg)); return { setup: teamKey }; });
      console.log(`✓ meta.linear written (team ${teamKey}, granularity ${cfg.granularity}, pull ${cfg.pull}).`);
      console.log(`  Add to .gitignore: ${CURSOR_FILE}`);
      console.log(`  Optional: branch_convention: "{pi}/{linear}-{sprint}" makes Linear auto-link fanout PRs.`);
      console.log(`  Then: roadmap linear sync --dry`);
    } else if (sub === "provision") {
      const r = await runProvision(root);
      console.log(`labels: ${r.labelsCreated.length ? `created ${r.labelsCreated.join(", ")}` : "all present"}${r.labelsExisting.length ? ` (existing: ${r.labelsExisting.join(", ")})` : ""}`);
      if (r.views.length) console.log(`views created: ${r.views.join(", ")}`);
      if (r.viewsExisting && r.viewsExisting.length) console.log(`views already present: ${r.viewsExisting.join(", ")}`);
      if (r.viewChecklist) {
        console.log(`customViewCreate rejected (${r.viewChecklist.rejected}) — pending live verification; manual checklist (~60s in Linear):`);
        console.log(r.viewChecklist.checklist);
      }
      console.log(`\n── Workspace agent guidance (paste into Linear's agent-guidance setting) ──\n${agentGuidanceText()}`);
      console.log(`\n── Repo dispatch guidance (paste into CLAUDE.md, AGENTS.md, or a skills.md your dispatch agents read) ──\n${dispatchGuidance()}`);
    } else if (sub === "note") {
      const rest = args.slice(1);
      const positional = [];
      for (let i = 0; i < rest.length; i++) { if (rest[i] === "--kind") { i++; continue; } if (!rest[i].startsWith("-")) positional.push(rest[i]); }
      const [key, text] = positional;
      if (!key || !text) { console.error(`usage: roadmap linear note <slice-or-id> "<text>" [--kind progress|blocker|done]`); process.exit(2); }
      const r = await runNote(root, key, { kind: val("--kind"), text }, {});
      console.log(r.skipped ? `- ${key} isn't tracker-mapped yet — note skipped (run 'roadmap linear sync' to map it).` : `✓ note posted to ${r.identifier} (${key}).`);
    } else if (sub === "notes") {
      const key = args.slice(1).find((a) => !a.startsWith("-"));
      if (!key) { console.error("usage: roadmap linear notes <slice-or-id>"); process.exit(2); }
      const r = await runNotes(root, key, {});
      if (r.skipped) { console.log(`${key} isn't tracker-mapped yet — no notes ('roadmap linear sync' to map it).`); process.exit(0); }
      console.log(`Notes on ${r.identifier} (${key}) — ${r.notes.length}:`);
      if (!r.notes.length) console.log("  (none yet)");
      for (const n of r.notes) console.log(`  • ${n.createdAt ? n.createdAt.slice(0, 16).replace("T", " ") : "?"} ${n.author}: ${n.body.replace(/\s+/g, " ").trim().slice(0, 160)}`);
    } else if (sub === "post-update") {
      const pi = val("--pi");
      const bodyArg = val("--body");
      if (!pi || !bodyArg) { console.error("usage: roadmap linear post-update --pi <id> --body <text|@file>"); process.exit(2); }
      const body = bodyArg.startsWith("@") ? readFileSync(bodyArg.slice(1), "utf8") : bodyArg;
      const r = await runProjectUpdate(root, pi, body, {});
      console.log(r.posted ? `✓ posted a project update on ${pi}.` : `projectUpdateCreate rejected (${r.error}) — digest not posted; pending live verification.`);
    } else if (sub === "sync") {
      const r = await runSync(root, { dry: has("--dry"), pushOnly: has("--push-only"), pullOnly: has("--pull-only") });
      if (r.pushPlan) {
        console.log(`push plan (${r.pushPlan.length} op(s), dry):`);
        for (const op of r.pushPlan) console.log(`  ${op.op}  ${op.identifier || (op.writeBack && (op.writeBack.invoke || op.writeBack.id || op.writeBack.pi)) || ""}${op.payload && op.payload.title ? ` — ${op.payload.title}` : ""}`);
      } else if (r.pushed.length) {
        console.log(`pushed ${r.pushed.length} op(s): ${r.pushed.join(", ")}`);
      } else {
        console.log("push: nothing to do (in sync).");
      }
      if (r.proposals) {
        const { newItems, deltas } = r.proposals;
        if (!newItems.length && !deltas.length) console.log("pull: inbox empty.");
        else if (r.applied) console.log(`pull (auto): captured ${newItems.length} item(s), applied ${deltas.filter((d) => d.to != null).length} delta(s).`);
        else {
          console.log(`pull inbox (${newItems.length} new, ${deltas.length} delta(s)) — proposals only, nothing applied:`);
          for (const it of newItems) console.log(`  + ${it.id} (${it.kind}${it.priority ? ` · ${it.priority.tier}` : ""}) — ${it.title}   [from ${it.source.linear.team}${it.source.linear.project ? `/${it.source.linear.project}` : ""}]`);
          for (const d of deltas) console.log(`  ~ ${d.kind} ${d.key}: ${d.field} ${d.from} → ${d.to ?? `(${d.note})`}`);
          console.log(`  Apply keeps via /sync (it walks this inbox), backlog_add/set tools, or 'roadmap backlog add/set'.`);
        }
      }
      if (r.missingLabels && r.missingLabels.length) {
        console.log(`labels missing in team: ${r.missingLabels.join(", ")} — run 'roadmap linear provision' to create them.`);
      }
      if (r.initiatives) console.log(`initiatives: ${r.initiatives.initiatives.length} grouped${r.initiatives.created.length ? ` (created ${r.initiatives.created.join(", ")})` : ""}${r.initiatives.styled && r.initiatives.styled.length ? ` · styled ${r.initiatives.styled.length}` : ""}${r.initiatives.attached.length ? ` · attached ${r.initiatives.attached.length} project(s)` : ""}`);
      if (r.initiativesError) console.log(`initiatives skipped: ${r.initiativesError} — pending live verification of the initiative API.`);
      if (r.projectStatusError) console.log(`project status skipped: ${r.projectStatusError} — projects keep their current Linear status this sync.`);
      if (r.milestones) console.log(`milestones: ${r.milestones.milestones.length} across projects${r.milestones.created.length ? ` (created ${r.milestones.created.length})` : ""}${r.milestones.attached.length ? ` · attached ${r.milestones.attached.length} issue(s)` : ""}`);
      if (r.milestonesError) console.log(`milestones skipped: ${r.milestonesError} — pending live verification of the projectMilestone API.`);
      if (r.cycles) console.log(`cycle: assigned ${r.cycles.assigned.join(", ") || "none"}${r.cycles.cleared.length ? ` · cleared ${r.cycles.cleared.join(", ")}` : ""} — the active cycle mirrors active+next.`);
      if (r.cyclesError) console.log(`cycles skipped: ${r.cyclesError} — pending live verification of the cycle API.`);
      if (r.cyclesNote) console.log(`cycles: ${r.cyclesNote}`);
      if (r.stale && r.stale.length) console.log(`stale: ${r.stale.join(", ")} — committed work past stale_days with no journal note; the election reviews these first.`);
      if (r.staleError) console.log(`staleness skipped: ${r.staleError} — advisory only, the push was unaffected.`);
      if (r.startStamped && r.startStamped.length) console.log(`start dates: stamped ${r.startStamped.length} active PI(s) (${r.startStamped.join(", ")}) — the Linear timeline now has a start.`);
      if (r.plateDrained && r.plateDrained.length) console.log(`plate: drained ${r.plateDrained.length} completed (${r.plateDrained.join(", ")}) — off My Issues.`);
      if (r.unmatchedPlate && r.unmatchedPlate.length) console.log(`plate: ${r.unmatchedPlate.join(", ")} match no slice/backlog item — typo in meta.plate? ('roadmap plate' lists it).`);
      console.log(r.cursorAdvanced ? `cursor advanced.` : `cursor unchanged${r.dry ? " (dry)" : " (inbox pending)"}.`);
    } else {
      console.error(`roadmap linear: unknown subcommand "${sub}" (status | auth | setup | provision | sync | note | notes | post-update)`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
