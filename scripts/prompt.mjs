// slice-roadmap — zero-dependency terminal prompts for the bare-`roadmap` wizard.
// IO file (raw-mode stdin, stdout, process.exit on cancel) — lives at scripts/ (not lib/), like the
// other side-effecting entrypoints. select() uses raw-mode arrow-key navigation when the TTY
// supports it, and DEGRADES to a numbered text prompt otherwise (so it never hangs on a terminal
// without raw mode). number() and confirm() are line-based. Ctrl-C / ESC cancel cleanly (restore
// the TTY, exit 0). The pure decision logic (movement, cap parsing) lives in lib/wizard-core.mjs.

import readline from "node:readline";
import { moveSelection, parseCap } from "./lib/wizard-core.mjs";

const S = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m",
};

const question = (rl, q) => new Promise((res) => rl.question(q, res));
const clamp = (i, len) => Math.min(Math.max(0, i | 0), Math.max(0, len - 1));

// Normalize a choice to { label, value, hint }. A bare string is both label and value.
function norm(choice) {
  if (typeof choice === "string") return { label: choice, value: choice, hint: "" };
  return { label: choice.label, value: "value" in choice ? choice.value : choice.label, hint: choice.hint || "" };
}

function cancel() {
  process.stdout.write(`\n${S.dim}Cancelled.${S.reset}\n`);
  process.exit(0);
}

function renderList(items, idx) {
  return items.map((it, i) => {
    const sel = i === idx;
    const cursor = sel ? `${S.cyan}❯${S.reset} ` : "  ";
    const label = sel ? `${S.bold}${S.cyan}${it.label}${S.reset}` : it.label;
    const hint = it.hint ? `  ${S.dim}${it.hint}${S.reset}` : "";
    return `${cursor}${label}${hint}`;
  });
}

// Single-select. Returns the chosen choice's value. Raw-mode arrows when available; else numbered.
export function select(title, choices, opts = {}) {
  const items = choices.map(norm);
  const start = clamp(opts.defaultIdx ?? 0, items.length);
  const canRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (!canRaw) return numberedSelect(title, items, start);

  return new Promise((resolve) => {
    let idx = start;
    process.stdout.write(`${S.bold}${title}${S.reset}  ${S.dim}(↑/↓, Enter)${S.reset}\n`);
    process.stdout.write(renderList(items, idx).join("\n") + "\n");

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const redraw = () => {
      process.stdout.write(`\x1b[${items.length}A`); // up to the first item line
      for (const line of renderList(items, idx)) process.stdout.write(`\x1b[2K${line}\n`);
    };
    const teardown = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
    };
    const onKey = (_str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") { teardown(); cancel(); return; }
      if (key.name === "escape") { teardown(); cancel(); return; }
      if (key.name === "return" || key.name === "enter") {
        teardown();
        process.stdout.write(`${S.green}✓${S.reset} ${S.dim}${title}:${S.reset} ${items[idx].label}\n`);
        resolve(items[idx].value);
        return;
      }
      const next = moveSelection(idx, key.name, items.length);
      if (next !== idx) { idx = next; redraw(); }
    };
    process.stdin.on("keypress", onKey);
  });
}

async function numberedSelect(title, items, startIdx) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => { rl.close(); cancel(); });
  try {
    process.stdout.write(`${S.bold}${title}${S.reset}\n`);
    items.forEach((it, i) =>
      process.stdout.write(`  ${i + 1}) ${it.label}${it.hint ? `  ${S.dim}${it.hint}${S.reset}` : ""}\n`));
    const def = startIdx + 1;
    for (;;) {
      const ans = (await question(rl, `Choose [1-${items.length}] (${def}): `)).trim();
      if (ans === "") return items[startIdx].value;
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].value;
      process.stdout.write(`${S.red}Enter a number between 1 and ${items.length}.${S.reset}\n`);
    }
  } finally { rl.close(); }
}

// Whole-number prompt with a default and a [min,max] range. Re-asks on bad input.
export async function number(title, { def, min = 1, max = Infinity } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => { rl.close(); cancel(); });
  try {
    for (;;) {
      const ans = await question(rl, `${S.bold}${title}${S.reset} ${S.dim}[${def}]${S.reset} `);
      const res = parseCap(ans, { min, max, def });
      if (res.error) { process.stdout.write(`${S.red}${res.error}${S.reset}\n`); continue; }
      return res.value;
    }
  } finally { rl.close(); }
}

// Yes/No with a default. Blank → default.
export async function confirm(title, def = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => { rl.close(); cancel(); });
  try {
    const hint = def ? "Y/n" : "y/N";
    const ans = (await question(rl, `${S.bold}${title}${S.reset} ${S.dim}[${hint}]${S.reset} `)).trim().toLowerCase();
    if (ans === "") return def;
    return ans === "y" || ans === "yes";
  } finally { rl.close(); }
}
