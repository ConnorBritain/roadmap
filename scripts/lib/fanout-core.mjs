// Pure launch decision for the fanout.
// Default is to LAUNCH (interactive, watchable) — that matches the proven fanout pattern
// and is low-risk (you're at the keyboard). Preview without spawning via --dry / --out.
// Autonomous (headless claude -p that commits/pushes/PRs) is the only dangerous mode and
// additionally requires the --yes-spawn-autonomous double-ack.
export function launchDecision({ dry = false, out = null, autonomous = false, okAutonomous = false } = {}) {
  if (out) return { spawn: false, mode: "wrote-script" };
  if (dry) return { spawn: false, mode: "dry" };
  if (autonomous && !okAutonomous) return { spawn: false, mode: "autonomous-needs-ack" };
  return { spawn: true, mode: autonomous ? "autonomous" : "interactive" };
}

// Per-node launch-script fragments shared by fanout.mjs (waves) and grab.mjs (one backlog
// item): the worktree-add-or-reuse line plus the .kickoff.md write, in bash and PowerShell
// forms — so a quoting/format fix lands once, not in two scripts.
export function bashWorktreeLines(wt, br, baseRef, brief) {
  return [
    `git worktree add "${wt}" -b "${br}" ${baseRef} 2>/dev/null || echo "worktree ${wt} exists, reusing"`,
    `cat > "${wt}/.kickoff.md" <<'KICKOFF_EOF'`,
    brief.trimEnd(),
    `KICKOFF_EOF`,
  ];
}
export function pwshWorktreeLines(wt, br, baseRef, brief) {
  return [
    `git worktree add "${wt}" -b "${br}" ${baseRef} 2>$null; if ($LASTEXITCODE -ne 0) { Write-Host "worktree ${wt} exists, reusing" }`,
    `Set-Content -LiteralPath "${wt}/.kickoff.md" -Encoding utf8 -Value @'`,
    brief.trimEnd(),
    `'@`,
  ];
}

// The disk hard-block refusal, shared by fan and grab.
export function diskBlockLines(disk) {
  return [
    `✗ not enough disk for even one worktree: need ~${disk.perWorktreeGb.toFixed(1)}GB, ${disk.freeGb.toFixed(1)}GB free on the worktree volume.`,
    `  Free space, point meta.worktree_root at a roomier volume, or calibrate meta.worktree_gb if the estimate is off.`,
  ];
}
