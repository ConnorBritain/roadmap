// Compatibility shim — the store-agnostic authority journal lives in packages/core
// (gauntlet-authority.mjs); the protected-GitHub-objects store lives in packages/exec-engineering.
// Removed in the `unshim` slice.
export { authorizationClaimKey, mutateAuthorization, recordRunContinuation } from "@connorbritain/roadmap-core/gauntlet-authority.mjs";
export { githubAuthorizationStore } from "@connorbritain/roadmap-exec-engineering/github-authority-store.mjs";
