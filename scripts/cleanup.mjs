#!/usr/bin/env node
// roadmap cleanup — prune fanout worktrees whose branch is merged to <remote>/<base> and
// whose tree is clean (thin CLI over the worktree-session executor's pruneWorktrees). DRY by
// default (lists the plan); --remove acts; --force includes unmerged/dirty. ONLY touches
// worktrees under the configured worktree_root (the fanout's own) — never the main checkout
// or your manual worktrees.

import { join } from "node:path";
import { loadGraph } from "@connorbritain/roadmap-core/graph.mjs";
import { REL } from "@connorbritain/roadmap-core/cli-core.mjs";
import { pruneWorktrees } from "@connorbritain/roadmap-exec-engineering/worktree-session.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes(n);

let meta = {};
try { meta = loadGraph(join(...REL)).meta || {}; } catch { /* no roadmap — fall back to defaults */ }

const r = pruneWorktrees(process.cwd(), { remove: has("--remove"), force: has("--force"), meta });
r.lines.forEach((l) => console.log(l));
r.errors.forEach((l) => console.error(l));
