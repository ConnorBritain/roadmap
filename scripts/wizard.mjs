#!/usr/bin/env node
// slice-roadmap — the interactive console (bare `roadmap` in a TTY, or `roadmap go`).
// Hot-loads THIS repo's roadmap (cwd = repo root, set by cli.mjs), shows what's runnable, then
// walks through a few prompts — terminal, max concurrency, wave, lead?, action — and hands the
// choices to fanout.mjs. Worker permission mode is NOT surfaced here: it comes from
// meta.worker_mode (or the --worker-mode flag). Nothing here merges; fanout enforces that.

import os from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph, flatten, computeWaves, readyNodes } from "./lib/graph.mjs";
import { recommendConcurrency } from "./lib/recommend.mjs";
import { terminalChoices, buildFanArgs, autoOutName } from "./lib/wizard-core.mjs";
import { select, number, confirm } from "./prompt.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const INPATH = "docs/roadmap/roadmap.yaml";
const S = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m" };

const TERM_HINTS = {
  wt: "Windows Terminal tabs",
  warp: "Warp tab config + deeplink",
  tmux: "tmux panes (WSL/macOS/Linux)",
  print: "print the commands only",
  background: "detached background sessions",
};

async function main() {
  let graph;
  try { graph = loadGraph(INPATH); }
  catch (e) { console.error(`${S.red}Couldn't load ${INPATH}: ${e.message}${S.reset}`); process.exit(1); }

  const model = flatten(graph);
  const ready = readyNodes(model);
  const rec = recommendConcurrency(ready, graph);
  const program = (graph.meta && graph.meta.program) || "roadmap";

  console.log(`\n${S.bold}${S.cyan}${program} — fanout${S.reset}  ${S.dim}${process.cwd()}${S.reset}`);

  if (!ready.length) {
    console.log(`\n${S.dim}No agent-runnable slices right now.${S.reset}`);
    let held = null;
    try { ({ held } = computeWaves(model, 1)); } catch { /* cycle — skip the held view */ }
    if (held && held.onHuman.length) {
      console.log("Held on a human:");
      for (const n of held.onHuman) console.log(`  • ${n.invoke} — gated on ${n.gatedOn}`);
    }
    console.log(`\nRun ${S.bold}roadmap plan${S.reset} for the full picture.`);
    process.exit(0);
  }

  console.log(`${ready.length} ready slice(s) · recommended cap ${S.bold}${rec.recommended}${S.reset} ${S.dim}(${rec.binding.why.split(" — ")[0]})${S.reset}\n`);

  // 1) terminal — platform default first, or meta.terminal if set
  const termIds = terminalChoices(os.platform());
  const metaTerm = graph.meta && graph.meta.terminal;
  const defTermIdx = Math.max(0, termIds.indexOf(metaTerm || termIds[0]));
  const term = await select(
    "Terminal",
    termIds.map((t) => ({ label: t, value: t, hint: TERM_HINTS[t] })),
    { defaultIdx: defTermIdx },
  );

  // 2) max concurrency — default = recommended, clamp to the ready count
  const cap = await number("Max concurrent sessions", { def: rec.recommended, min: 1, max: ready.length });

  // 3) wave — recompute under the chosen cap
  let waves;
  try { ({ waves } = computeWaves(model, cap)); }
  catch (e) { console.error(`${S.red}✗ ${e.message}${S.reset}`); process.exit(1); }
  if (!waves.length) { console.log(`${S.dim}No runnable waves at cap ${cap}.${S.reset}`); process.exit(0); }
  const wave = await select(
    "Which wave",
    waves.map((w, i) => ({ label: `Wave ${i + 1} — ${w.length} concurrent`, value: i + 1, hint: w.map((n) => n.invoke).join(", ") })),
    { defaultIdx: 0 },
  );

  // 4) lead coordinator session?
  const lead = await confirm("Open a LEAD coordinator session too?", false);

  // 5) action
  const mode = await select("Action", [
    { label: "Launch now", value: "launch", hint: "open the wave" },
    { label: "Preview only", value: "dry", hint: "print the launch script, spawn nothing" },
    { label: "Save script to a file", value: "save", hint: "write it, don't launch" },
  ], { defaultIdx: 0 });

  const outName = mode === "save" ? autoOutName(term, wave) : undefined;
  const fanArgs = buildFanArgs({ term, cap, wave, lead, mode, outName });

  console.log(`\n${S.green}▶${S.reset} roadmap fan ${fanArgs.join(" ")}\n`);
  const r = spawnSync("node", [join(SCRIPTS, "fanout.mjs"), ...fanArgs], { stdio: "inherit", cwd: process.cwd() });
  process.exit(r.status ?? 0);
}

main();
