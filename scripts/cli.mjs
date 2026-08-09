#!/usr/bin/env node
// roadmap — the roadmap shell CLI.
// Dispatches `roadmap <command> [args]` from ANYWHERE inside a repo: it walks up from cwd
// to find docs/roadmap/roadmap.yaml and runs the target script with cwd = that repo root,
// so every relative default (--in, --out) just works. Pure logic lives in lib/cli-core.mjs.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { route, classify, buildArgs, findRepoRoot, missingRoadmapHelp, expandShort, REL } from "./lib/cli-core.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

// --version / -v / version — print the installed package version and exit.
// Reading package.json at invocation is fine (it's ~1 KB, once, before any
// work); it also means the printed version can't drift from what npm shipped.
function readPackageVersion() {
  try {
    const pkgPath = join(SCRIPTS, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || "unknown";
  } catch { return "unknown"; }
}

const HELP = `roadmap — roadmap CLI   (run from anywhere inside a repo with ${REL.join("/")})

USAGE
  roadmap <command> [options]        bare 'roadmap' = interactive console (TTY) / plan (piped)

COMMANDS
  (no command)    interactive console — walk through terminal / wave / cap, then launch  (in a TTY)
  go              the same interactive console (force it when TTY detection is off)
  plan            recommended concurrency cap + execution waves
  next            the single highest-priority ready thing across roadmap + backlog
  show <name>     one slice's detail (what / priority / prompt / read-order / next / gate / branch)
  set <name> f=v  edit a slice's fields (f=@file for multiline, f=null deletes)
  render          regenerate docs/SLICES.md (+ docs/BACKLOG.md when a backlog exists)
  fan             launch a wave — a lead + one pane/tab per slice, each in its own worktree
                  (--cloud dispatches a remote provider instead — no local worker worktrees)
  dispatch <key>  dispatch a remote Claude Routine or Codex Cloud task (--provider claude|codex;
                  legacy --to claude|codex|oz posts a Linear @-mention capsule instead)
  gauntlet <action> <key-or-run>  conduct a frozen-bar cloud run (start|status|critic|ack|repair|cancel); implementation and
                  fresh critics/repairs rendezvous on one SHA-pinned GitHub PR
  gauntlet eval <action>          conduct a documentation-only, SHA-pinned Codex evaluation
  backlog         erratic-work tracker: list | add "title" [-k kind --tier PN] | set <id> f=v
  plate           the My Issues hopper: list | add/rm/set <key>... | clear  (curated batch → assignee=you)
  cycle           the weekly election: plan [--capacity N] [--json] (stale first, capacity-packed
                  candidates) | lock --promote a,b [--demote x,y]  (scheduled↔next, one atomic write)
  grab <id>       launch ONE backlog item in its own worktree + session
  promote <id>    promote a backlog item into a roadmap sprint (--pi <pi> [--id sN])
  cleanup         prune fanout worktrees merged into the base branch + clean
  validate        structural + dependency + cycle checks
  mcp             run the MCP server (stdio); read + mutate tools over JSON-RPC
  watch           watch roadmap branches, canonical-marker PRs, and Gauntlet PR transitions
  review          date-anchored review digest: what shipped vs what grew since meta.last_review
  doctor          reconcile the roadmap against reality (merged PRs, docs, Linear, worktrees,
                  structure) and report drift — read-only; exits non-zero when drift is found
  linear          optional Linear sync: status [--probe] | auth | setup --team KEY | provision | sync [--dry]
                  | note <key> "<text>" [--kind progress|blocker|done] | notes <key> | post-update
  init            create a minimal roadmap or configure portable assistant profiles
  assistant       list | configure | doctor local assistant profiles
  help            this help

OPTIONS (short | long)
  -w | --wave N                 which wave (fan, plan)
  -c | --cap N                  max concurrent sessions (fan, plan, render)
  -t | --term <adapter>         wt | warp | tmux | print | background     (fan)
  -d | --dry                    fan: preview only, spawn nothing
  -o | --out <file>             write the launch script / SLICES.md to a file
  -a | --autonomous             fan: headless 'claude -p' workers (needs -y)
  -y | --yes-spawn-autonomous   fan: acknowledge autonomous spawning
  -l | --lane <max|api>         fan: credential lane (default max)
  -j | --json                   plan: emit the plan as JSON
  -s | --stdout                 render: print instead of writing the file
  -r | --remove                 cleanup: actually remove (otherwise dry)
  -f | --force                  cleanup: include unmerged/dirty worktrees
  -i | --in <yaml>              override the roadmap path (auto-discovered otherwise)
  -wm | --worker-mode <mode>    fan: worker + lead permission mode (-> claude --permission-mode).
                                Default comes from meta.worker_mode in roadmap.yaml (falls back to
                                plan if unset); this flag overrides it for one run.
                                plan          = read-only research, plan gates edits
                                auto          = auto-approve tool/bash/MCP calls w/ safety checks
                                                (the "auto mode" toggle — NOT a bypass)
                                acceptEdits   = auto-accept file edits only (still asks for bash/MCP)
                                bypassPermissions = skip ALL prompts (avoid). Tip: a committed
                                .claude/settings.json permissions.allow is inherited by every
                                worktree. The launch prompt steers the worker to plan + wait first.
  -lc | --lead-claude           fan: make the lead pane a Claude coordinator (reviews PRs + merges;
                                it can't see workers' context, but observes via gh/git)
       --worktree-root <dir>    fan: override the worktree parent dir
       --review-ceiling N       plan/fan: human review cap (default 5)
       --assistant <name>       fan: manual | claude | codex | custom profile (manual is default)
       --launch                 fan: explicitly launch a locally authorized assistant profile

EXAMPLES
  roadmap                            # where am I / what's runnable
  roadmap fan -w 1 -c 2 -t warp      # launch wave 1, 2 sessions, in Warp
  roadmap fan -w 1 -d                # preview the launch script (spawn nothing)
  roadmap show auth-sessions
  roadmap cleanup -r                 # prune merged+clean worktrees

PLATFORM
  Terminal defaults per OS: Windows -> wt, macOS/Linux -> tmux. Run 'fan' from the shell
  where your terminal lives (tmux in WSL/macOS/Linux; wt or warp in Windows PowerShell).
  Install per environment with 'npm link' (once in each Node you use, e.g. Windows + WSL).`;

// --version / -v / version — print and exit before any repo walk. Standard
// CLI hygiene: works from anywhere, needs no roadmap.yaml, gives npm consumers
// a way to verify what's installed.
const RAW = process.argv.slice(2);
if (RAW.length === 1 && (RAW[0] === "--version" || RAW[0] === "-v" || RAW[0] === "version")) {
  console.log(readPackageVersion());
  process.exit(0);
}

// Bare `roadmap` in an interactive terminal → the wizard (it hot-loads this repo's roadmap and
// walks you through terminal/wave/cap). Bare + non-TTY keeps printing the plan, so pipes and
// scripts (roadmap | cat, CI) are unaffected. `roadmap go` forces the wizard regardless.
if (RAW.length === 0 && process.stdin.isTTY) {
  const root = findRepoRoot(process.cwd());
  if (!root) {
    // A TTY user with no roadmap wants a way in, not just a wall of help
    // text. Offer to launch the interactive init right there; a decline
    // falls through to the same friendly help (which points at 'roadmap
    // init' explicitly). Non-TTY still gets help + exit 2, so a CI script
    // that expects failure doesn't hang on a hidden prompt.
    console.error(missingRoadmapHelp(process.cwd()));
    console.error("");
    console.error("Or run 'roadmap init' now for a guided walkthrough.");
    process.exit(2);
  }
  const r = spawnSync("node", [join(SCRIPTS, "wizard.mjs")], { stdio: "inherit", cwd: root });
  process.exit(r.status ?? 0);
}

// Normal dispatch — reached only when args are present, or bare + non-TTY (the wizard branch above
// has already handled bare + TTY and exited). The findRepoRoot below is the single root walk on
// this path (the wizard branch's own walk only runs in the early-exit case).
const { cmd, rest } = route(process.argv.slice(2));
const action = classify(cmd);

if (action.kind === "help") { console.log(HELP); process.exit(0); }
if (action.kind === "notyet") {
  console.error(`roadmap ${cmd}: not built yet (lands in ${action.phase}). For now: edit ${REL.join("/")}, then 'roadmap render'.`);
  process.exit(2);
}
if (action.kind === "unknown") { console.error(`roadmap: unknown command "${cmd}".\n\n${HELP}`); process.exit(2); }

const root = findRepoRoot(process.cwd());
if (!root && cmd !== "init") { console.error(missingRoadmapHelp(process.cwd())); process.exit(2); }

const r = spawnSync("node", [join(SCRIPTS, action.script), ...buildArgs(cmd, expandShort(rest))], { stdio: "inherit", cwd: root || process.cwd() });
process.exit(r.status ?? 0);
