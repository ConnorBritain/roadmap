// packages/core tests — shared Linear fixtures (moved from scripts/test/run.mjs).
import { normalizeLinearConfig } from "@connorbritain/roadmap-core/linear-core.mjs";

export const L_STATES = [
  { id: "st-b", name: "Backlog", type: "backlog", position: 0 },
  { id: "st-u", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-s", name: "In Progress", type: "started", position: 2 },
  { id: "st-s2", name: "Blocked", type: "started", position: 3 },
  { id: "st-c", name: "Done", type: "completed", position: 4 },
  { id: "st-x", name: "Canceled", type: "canceled", position: 5 },
];
export const L_CFG = normalizeLinearConfig({ linear: { team: "ENG" } });
