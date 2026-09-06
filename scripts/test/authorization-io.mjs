import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorizationFixture } from "./authorization.mjs";
import { githubAuthorizationStore } from "../lib/gauntlet-authorization-io.mjs";
import { reserveAuthorizedLaunch } from "../lib/gauntlet-authorization.mjs";

function fixture() {
  const refs = new Map(), blobs = new Map(), trees = new Map(), commits = new Map();
  const state = authorizationFixture();
  const source = state.authorization.source_sha;
  trees.set("source-tree", { tree: [] }); commits.set(source, { tree: { sha: "source-tree" }, parents: [] });
  const control = { actor: "lead", unsafe: false, loseRefResponse: false, refUpdates: [] };
  const sha = (object) => createHash("sha1").update(JSON.stringify(object)).digest("hex");
  const ok = (object) => ({ status: 0, stdout: JSON.stringify(object), stderr: "" });
  const failure = () => ({ status: 1, stdout: "", stderr: "HTTP 422" });
  const github = { assertAvailable: () => true, viewerLogin: () => control.actor,
    assertClaimProtection: () => ({ unsafe: control.unsafe }),
    claimRef: (key, id) => `refs/heads/roadmap-gauntlet-locks/${id}-authority`,
    getLaunchClaim(key, id) { const ref = this.claimRef(key, id); return refs.has(ref) ? { ref, sha: refs.get(ref) } : null; } };
  const execImpl = (command, args, opts) => {
    assert.equal(command, "gh");
    if (args[0] === "repo") return { status: 0, stdout: "owner/repo\n", stderr: "" };
    const endpoint = args[1].replace("repos/owner/repo/git/", "");
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const payload = opts.input ? JSON.parse(opts.input) : null;
    if (method === "GET") {
      const [type, id] = endpoint.split("/");
      const found = ({ blobs, trees, commits })[type]?.get(id);
      return found ? ok(found) : failure();
    }
    if (endpoint === "blobs") {
      const id = sha(payload); blobs.set(id, { content: Buffer.from(payload.content).toString("base64"), encoding: "base64", size: Buffer.byteLength(payload.content) });
      return ok({ sha: id });
    }
    if (endpoint === "trees") {
      const id = sha(payload); trees.set(id, { tree: payload.tree.map((entry) => ({ ...entry, size: blobs.get(entry.sha).size })) });
      return ok({ sha: id });
    }
    if (endpoint === "commits") {
      const id = sha(payload); commits.set(id, { tree: { sha: payload.tree }, parents: payload.parents });
      return ok({ sha: id });
    }
    if (endpoint === "refs" || endpoint.startsWith("refs/")) {
      const ref = method === "POST" ? payload.ref : `refs/${endpoint.slice(5)}`;
      if (method === "POST" && refs.has(ref)) return failure();
      if (method === "PATCH") {
        assert.equal(payload.force, false);
        if (commits.get(payload.sha).parents[0] !== refs.get(ref)) return failure();
      }
      refs.set(ref, payload.sha); control.refUpdates.push({ ref, method, payload });
      if (control.loseRefResponse) { control.loseRefResponse = false; return failure(); }
      return ok({ ref, object: { sha: payload.sha } });
    }
    throw new Error(`unexpected GitHub authority fixture call: ${endpoint}`);
  };
  return { store: githubAuthorizationStore("/unused-fixture", { github, execImpl }), state, control, refs };
}

export function registerAuthorizationIoTests(test) {
  test("GitHub authority journal creates a protected ref then only fast-forwards from its exact prior state", async () => {
    const f = fixture(), id = f.state.authorization.run_id;
    assert.equal(await f.store.read(id), null);
    const initial = await f.store.compareAndSwap(id, null, f.state); assert.equal(initial.written, true);
    const current = await f.store.read(id); assert.equal(current.state.authorization_digest, f.state.authorization_digest);
    const next = reserveAuthorizedLaunch(current.state, { key: "one", role: "evaluator", provider: "codex", expected_head: f.state.authorization.source_sha },
      { owner: "conductor", now: "2026-09-05T10:01:00Z" }).state;
    assert.equal((await f.store.compareAndSwap(id, current, next)).written, true);
    assert.equal((await f.store.compareAndSwap(id, current, next)).written, false);
    assert.equal(f.control.refUpdates.length, 2); assert.equal(f.control.refUpdates[1].payload.force, false);
    assert.equal((await f.store.read(id)).state.reservations.length, 1);
  });
  test("GitHub journal reconciles a lost exact ref-write response without spending a second slot", async () => {
    const f = fixture(), id = f.state.authorization.run_id;
    f.control.loseRefResponse = true;
    const initialized = await f.store.compareAndSwap(id, null, f.state);
    assert.equal(initialized.written, true); assert.equal(f.control.refUpdates.length, 1);
    const current = await f.store.read(id);
    const next = reserveAuthorizedLaunch(current.state, { key: "one", role: "evaluator", provider: "codex", expected_head: f.state.authorization.source_sha },
      { owner: "conductor", now: "2026-09-05T10:01:00Z" }).state;
    f.control.loseRefResponse = true;
    assert.equal((await f.store.compareAndSwap(id, current, next)).written, true);
    assert.equal((await f.store.read(id)).state.reservations.length, 1);
  });
  test("GitHub authority refuses unsafe rules, wrong actors and reservation deletion", async () => {
    const f = fixture(), id = f.state.authorization.run_id;
    f.control.unsafe = true;
    await assert.rejects(() => f.store.compareAndSwap(id, null, f.state), /unsafe/);
    assert.equal(f.refs.size, 0);
    f.control.unsafe = false; f.control.actor = "worker";
    await assert.rejects(() => f.store.compareAndSwap(id, null, f.state), /frozen lead/);
    f.control.actor = "lead"; await f.store.compareAndSwap(id, null, f.state);
    const current = await f.store.read(id);
    const next = reserveAuthorizedLaunch(current.state, { key: "one", role: "evaluator", provider: "codex", expected_head: f.state.authorization.source_sha },
      { owner: "conductor", now: "2026-09-05T10:01:00Z" }).state;
    await f.store.compareAndSwap(id, current, next);
    const latest = await f.store.read(id);
    await assert.rejects(() => f.store.compareAndSwap(id, latest, f.state), /append-only/);
  });
}
