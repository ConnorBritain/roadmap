// Compatibility shim — the pure portfolio reporting lives in packages/core; discovery/IO in
// gauntlet-portfolio-io.mjs (engineering runtime). Removed in the `unshim` slice.
export * from "@connorbritain/roadmap-core/gauntlet-portfolio-core.mjs";
export { runGauntletPortfolio } from "./gauntlet-portfolio-io.mjs";
