#!/usr/bin/env node
// roadmap gauntlet eval — documentation-only Codex Cloud evaluation conductor.
// CLI shell: the body lives in @connorbritain/roadmap-exec-engineering/evaluate-runtime.mjs; this file parses argv and re-exports it.
export * from "@connorbritain/roadmap-exec-engineering/evaluate-runtime.mjs";
import { runEvaluation } from "@connorbritain/roadmap-exec-engineering/evaluate-runtime.mjs";
import { resolve } from "node:path";
const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  try {
    const result = await runEvaluation(process.cwd(), process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  }
  catch (error) { console.error(`roadmap gauntlet eval: ${error.message}`); process.exit(1); }
}
