#!/usr/bin/env node
// roadmap — the roadmap shell CLI.
// Dispatches `roadmap <command> [args]` from ANYWHERE inside a repo: it walks up from cwd
// to find docs/roadmap/roadmap.yaml and runs the target script with cwd = that repo root,
// so every relative default (--in, --out) just works. Pure logic lives in lib/cli-core.mjs.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { route, classify, buildArgs, findRepoRoot, missingRoadmapHelp, expandShort, REL } from "./lib/cli-core.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

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
  backlog         erratic-work tracker: list | add "title" [-k kind --tier PN] | set <id> f=v
  grab <id>       launch ONE backlog item in its own worktree + session
  promote <id>    promote a backlog item into a roadmap sprint (--pi <pi> [--id sN])
  cleanup         prune fanout worktrees merged into the base branch + clean
  validate        structural + dependency + cycle checks
  mcp             run the MCP server (stdio); read + mutate tools over JSON-RPC
  watch           watch fanout PRs and print a line as each lands (lead notifications)
  review          date-anchored review digest: what shipped vs what grew since meta.last_review
  linear          optional Linear sync: status [--probe] | auth | setup --team KEY | provision | sync [--dry] | post-update
  sync | init     (plugin skills) reconcile+re-render / PM-interview bootstrap
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

// Bare `roadmap` in an interactive terminal → the wizard (it hot-loads this repo's roadmap and
// walks you through terminal/wave/cap). Bare + non-TTY keeps printing the plan, so pipes and
// scripts (roadmap | cat, CI) are unaffected. `roadmap go` forces the wizard regardless.
const RAW = process.argv.slice(2);
if (RAW.length === 0 && process.stdin.isTTY) {
  const root = findRepoRoot(process.cwd());
  if (!root) { console.error(missingRoadmapHelp(process.cwd())); process.exit(2); }
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
if (!root) { console.error(missingRoadmapHelp(process.cwd())); process.exit(2); }

const r = spawnSync("node", [join(SCRIPTS, action.script), ...buildArgs(cmd, expandShort(rest))], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 0);
