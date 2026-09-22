// roadmap — the GauntletArtifact interface (core). What the frozen bar attaches to and what the
// critic reads. The protocol (gauntlet-core, decisions, authorization, receipts) talks ONLY to this
// surface and to the neutral Artifact/Comment shapes below; it never learns which backend it is
// on. Implementations: github-pr (exec-engineering), git-file and doc (exec-general).
//
// Shapes (backend-neutral):
//   Artifact { id, number, url, title, body, state: OPEN|MERGED|CLOSED, draft, mergeable: clean|conflicting|unknown,
//              headRef, baseRef, currentHead, checks: passing|failing|pending|none, comments[], commits[], createdAt, updatedAt }
//   Comment  { body, author, createdAt, updatedAt, edited, url }        url = the comment's stable locator
//   Claim    { ref, sha, kind? }                                        an atomic create-if-absent election record

export const ARTIFACT_KINDS = ["github-pr", "git-file", "doc"];

// Required by the protocol. Every implementation registers gauntletArtifactContract against these.
export const GAUNTLET_ARTIFACT_METHODS = [
  "assertAvailable",        // () -> true | throws                 backend reachable + authenticated
  "actor",                  // () -> string                        authenticated lead identity
  "freeze",                 // ({ run, frozenBar }) -> { barSha256, packet }   marker packet the worker attaches
  "head",                   // (artifact) -> string|null           exact, content-addressed version identity
  "fetch",                  // (ref) -> Artifact|null              by { number } | { runId } | { subject: {type,key}, open? }
  "comment",                // (ref, body) -> true                 post an immutable protocol comment
  "ack",                    // (ref, body) -> true                 post the lead acknowledgment (protocol renders it)
  "descendsFrom",           // (ancestor, head) -> bool
  "claim",                  // (key, head, runId) -> { claimed, ref }
  "readClaim",              // (key, runId) -> Claim|null
  "listClaims",             // (runId) -> Claim[]
  "assertClaimSafety",      // (key, runId) -> { unsafe, ref?, rules? }
  "claimRef",               // (key, runId) -> string
  "workerFetchInstructions",// (artifact, head) -> { label, fetch }   text a remote worker needs to locate this exact head
];

// Legacy client method names (the GitHub-era runtime and every test fake use them). asGauntletArtifact
// maps them onto the canonical surface so both spellings resolve to one object.
const LEGACY = {
  actor: "viewerLogin", fetch: "getPr", comment: "addComment", descendsFrom: "isAncestor",
  claim: "claimLaunch", readClaim: "getLaunchClaim", listClaims: "listRunClaims", assertClaimSafety: "assertClaimProtection",
};

const ACTOR_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._@+-]{0,253})$/;
export const isActorIdentity = (value) => typeof value === "string" && ACTOR_RE.test(value);

// Wrap any client (canonical, legacy-named, or a test fake) so the protocol can call canonical names.
// Missing optional methods stay undefined, which the protocol treats as "backend cannot" (fail closed).
export function asGauntletArtifact(client) {
  if (!client) throw new Error("a GauntletArtifact adapter is required");
  if (client.__gauntletArtifact) return client;
  const out = Object.create(null);
  for (const key of Object.keys(client)) out[key] = typeof client[key] === "function" ? client[key].bind(client) : client[key];
  for (const [canonical, legacy] of Object.entries(LEGACY)) {
    if (typeof out[canonical] !== "function" && typeof out[legacy] === "function") out[canonical] = out[legacy];
    if (typeof out[legacy] !== "function" && typeof out[canonical] === "function") out[legacy] = out[canonical];
  }
  if (typeof out.fetch !== "function" && typeof out.getPr === "function") out.fetch = out.getPr;
  if (typeof out.ack !== "function" && typeof out.comment === "function") out.ack = out.comment;
  if (typeof out.head !== "function") out.head = (artifact) => (artifact && artifact.currentHead) || null;
  if (typeof out.workerFetchInstructions !== "function") {
    out.workerFetchInstructions = (artifact, head) => ({ label: `artifact #${artifact && artifact.number}`, fetch: `Fetch artifact #${artifact && artifact.number} and resolve its current head to its exact version identity (${head}).` });
  }
  out.kind = client.kind || "unknown";
  out.__gauntletArtifact = true;
  return out;
}

// Assert a full implementation (used by the contract test and the profile loader).
export function assertGauntletArtifact(adapter, { optional = [] } = {}) {
  const a = asGauntletArtifact(adapter);
  const missing = GAUNTLET_ARTIFACT_METHODS.filter((m) => !optional.includes(m) && typeof a[m] !== "function");
  if (missing.length) throw new Error(`GauntletArtifact ${a.kind} is missing: ${missing.join(", ")}`);
  if (!ARTIFACT_KINDS.includes(a.kind)) throw new Error(`GauntletArtifact kind must be one of ${ARTIFACT_KINDS.join(", ")} (got ${a.kind})`);
  return a;
}

// Coerce a comment into the neutral shape. Accepts an already-neutral comment or a raw one whose
// author is an object; the backend adapter is expected to have produced neutral field names.
export function normalizeComment(comment) {
  const author = comment && comment.author;
  return {
    body: String((comment && comment.body) || ""),
    author: author && typeof author === "object" ? (author.login || author.name || null) : (author || null),
    createdAt: (comment && (comment.createdAt || comment.created_at)) || null,
    updatedAt: (comment && (comment.updatedAt || comment.updated_at)) || null,
    edited: !!(comment && comment.edited),
    url: (comment && comment.url) || null,
  };
}

// Coerce an artifact into the neutral shape (defaults applied). Backend adapters produce neutral
// names; this only fills defaults so the protocol can rely on every field existing.
export function normalizeArtifact(raw) {
  if (!raw) return null;
  return {
    id: raw.id != null ? String(raw.id) : (raw.number != null ? String(raw.number) : null),
    number: raw.number,
    url: raw.url || null,
    title: raw.title || "",
    body: raw.body || "",
    state: String(raw.state || "OPEN").toUpperCase(),
    draft: !!raw.draft,
    mergeable: raw.mergeable || "unknown",
    headRef: raw.headRef || null,
    baseRef: raw.baseRef || null,
    currentHead: raw.currentHead || null,
    checks: raw.checks || "none",
    comments: (raw.comments || []).map(normalizeComment),
    commits: (raw.commits || []).map((c) => (typeof c === "string" ? c : c && (c.oid || c.sha))).filter(Boolean),
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

// True when a protocol comment has been altered after creation (fail closed on any edit signal).
export function commentWasEdited(comment) {
  if (!comment) return true;
  if (comment.edited === true) return true;
  const created = Date.parse(comment.createdAt || comment.created_at || "");
  const updated = Date.parse(comment.updatedAt || comment.updated_at || "");
  return Number.isFinite(created) && Number.isFinite(updated) && updated > created;
}
