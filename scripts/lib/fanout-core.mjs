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
