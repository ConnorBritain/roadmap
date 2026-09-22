// Compatibility shim — sync-core now lives in packages/core (@connorbritain/roadmap-core). Removed in the `unshim` slice.
export * from "@connorbritain/roadmap-core/sync-core.mjs";
// The PR-matching half moved to the engineering executor; re-exported here so existing importers see one module.
export * from "@connorbritain/roadmap-exec-engineering/reconcile-core.mjs";
