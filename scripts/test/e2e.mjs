#!/usr/bin/env node
// roadmap — the two end-to-end checks the core/executor split promised, runnable on their own
// (`npm run test:e2e`; both are also part of `npm test`):
//   1. engineering: a dry fanout on a fixture repo — the launcher CLIs' output matches the golden
//      fixtures byte for byte (packages/exec-engineering/test/launchers.mjs);
//   2. general: a conduct loop on a markdown artifact — start → critic → REVISE → ack → repair →
//      fresh critic → PASS → reconcile, plus ledger loss (packages/exec-general/test/general.mjs).
import { summary } from "../../packages/core/test/harness.mjs";
await import("../../packages/exec-engineering/test/launchers.mjs");
await import("../../packages/exec-general/test/general.mjs");
const r = await summary();
process.exit(r && r.failed ? 1 : 0);
