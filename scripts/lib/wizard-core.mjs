// slice-roadmap — interactive console core (PURE, unit-tested).
// The bare-`roadmap` wizard's decisions live here so they're testable without a TTY:
// which terminal to default to, how arrow-keys move a selection, how the cap field parses,
// and how the collected answers translate into the exact `fanout.mjs` flags. The raw-mode IO
// lives in prompt.mjs; the orchestration in wizard.mjs. No side effects on import.

// Terminal adapters offered by the wizard, platform default first (it's the safe Enter).
// Windows → Windows Terminal; everything else → tmux. All adapters stay selectable.
export function terminalChoices(platform) {
  const def = platform === "win32" ? "wt" : "tmux";
  const all = ["wt", "warp", "tmux", "print", "background"];
  return [def, ...all.filter((t) => t !== def)];
}

// Arrow-key navigation for a list of length `len`, wrapping at both ends (k/j alias up/down).
// Unrelated keys leave the index unchanged.
export function moveSelection(idx, key, len) {
  if (len <= 0) return 0;
  if (key === "up" || key === "k") return (idx - 1 + len) % len;
  if (key === "down" || key === "j") return (idx + 1) % len;
  return idx;
}

// Parse the max-concurrency field. Blank → the recommended default; non-numeric or out-of-range
// → an error message (so the prompt re-asks rather than silently coercing a thrashing/no-op cap).
export function parseCap(input, { min = 1, max = Infinity, def } = {}) {
  const str = String(input ?? "").trim();
  if (str === "") return { value: def };
  if (!/^\d+$/.test(str)) return { error: `Enter a whole number between ${min} and ${max}.` };
  const n = Number(str);
  if (n < min || n > max) return { error: `Must be between ${min} and ${max}.` };
  return { value: n };
}

// Translate the wizard's collected answers into the argv `fanout.mjs` understands.
// launch = fanout's default (no extra flag); dry = --dry; save = --out <name>.
export function buildFanArgs({ term, cap, wave, lead, mode, outName }) {
  const args = ["--term", String(term), "--cap", String(cap), "--wave", String(wave)];
  if (lead) args.push("--lead-claude");
  if (mode === "dry") args.push("--dry");
  else if (mode === "save") args.push("--out", outName);
  return args;
}

// Default filename for the "save script" action — the extension must match the target shell
// (PowerShell for wt/warp, bash for tmux/print/background) or the saved script won't run.
export function autoOutName(term, wave) {
  const ext = term === "wt" || term === "warp" ? "ps1" : "sh";
  return `wave${wave}.${ext}`;
}
