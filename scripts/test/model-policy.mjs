import assert from "node:assert/strict";
import { roleModelPreference, qualifyModelPreference, recordActualModel } from "../lib/model-policy.mjs";
import { cloudProviderCapabilities } from "../lib/cloud-agent-providers.mjs";
import { npmCommand } from "./npm-command.mjs";

export function registerModelPolicyTests(test) {
  test("packed smoke npm launcher keeps Windows archive paths out of a shell", () => {
    const archive = "C:\\artifact dir\\candidate %NAME% & value.tgz";
    const result = npmCommand(["install", archive], { platform: "win32", node: "C:\\Program Files\\nodejs\\node.exe",
      npmEntry: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", exists: () => true });
    assert.equal(result.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(result.args.slice(1), ["install", archive]);
    assert.throws(() => npmCommand(["install", archive], { platform: "win32", exists: () => false }), /npm run test:packed/);
    assert.deepEqual(npmCommand(["install", "safe.tgz"], { platform: "darwin" }), { command: "npm", args: ["install", "safe.tgz"] });
  });
  test("unconfigured role policy preserves provider-managed consumer defaults", () => {
    const policy = qualifyModelPreference({ provider: "codex", preference: roleModelPreference({}, "evaluator") });
    assert.deepEqual(policy.requested, { model: null, reasoning_effort: null });
    assert.deepEqual(policy.warnings, []); assert.equal(policy.actual.verification, "unverified");
  });
  test("Astra high lead and medium cloud preferences remain separate and inheritable", () => {
    const preferences = { lead: { model: "gpt-6-astra", reasoning_effort: "high" }, cloud: { model: "gpt-6-astra", reasoning_effort: "medium" } };
    assert.equal(roleModelPreference(preferences, "lead").reasoning_effort, "high");
    for (const role of ["implementation", "evaluator", "critic", "repair"]) {
      assert.equal(roleModelPreference(preferences, role).reasoning_effort, "medium");
    }
  });
  test("unsupported preferred model settings warn without substituting a provider or execution surface", () => {
    const policy = qualifyModelPreference({ provider: "codex", capabilities: cloudProviderCapabilities("codex"),
      preference: { model: "gpt-6-astra", reasoning_effort: "medium" } });
    assert.equal(policy.warnings.length, 2); assert.equal(policy.transport.model, null);
    assert.equal(policy.selection, "provider_managed_default");
    assert.deepEqual(policy.actual, { model: null, reasoning_effort: null, verification: "unverified" });
  });
  test("strict unsupported preferences fail instead of degrading silently", () => {
    for (const provider of ["codex", "claude"]) assert.throws(() => qualifyModelPreference({ provider,
      capabilities: cloudProviderCapabilities(provider), preference: { model: "gpt-6-astra", reasoning_effort: "medium", strict: true } }), /cannot enforce strict/);
  });
  test("explicit effort overrides are recorded without rewriting the frozen preference", () => {
    const preferences = { cloud: { model: "gpt-6-astra", reasoning_effort: "medium" } };
    const preference = roleModelPreference(preferences, "critic", { reasoning_effort: "high" });
    const policy = qualifyModelPreference({ provider: "codex", preference });
    assert.equal(policy.requested.reasoning_effort, "high"); assert.equal(policy.override.reasoning_effort, "high");
    assert.equal(preferences.cloud.reasoning_effort, "medium");
  });
  test("sending supported settings does not verify what model actually ran", () => {
    const policy = qualifyModelPreference({ provider: "test-supported-transport", capabilities: { per_task_model: true, per_task_reasoning_effort: true },
      preference: { model: "gpt-6-astra", reasoning_effort: "high", strict: true } });
    assert.equal(policy.selection, "requested_settings_sent"); assert.equal(policy.transport.model, "gpt-6-astra");
    assert.equal(policy.actual.verification, "unverified");
    assert.throws(() => recordActualModel(policy, { model: "gpt-6-astra", reasoning_effort: "high" }, { source: "worker_self_description" }), /trustworthy/);
    assert.equal(recordActualModel(policy, { model: "gpt-6-astra", reasoning_effort: "high" }, { source: "provider_response" }).actual.verification, "verified");
    assert.equal(recordActualModel(policy, { model: "gpt-6-astra" }, { source: "desktop_metadata" }).actual.verification, "partial");
  });
  test("model preference typos and malformed role fields fail visibly", () => {
    for (const prefs of [{ clod: {} }, { cloud: { effort: "high" } }, { critic: { strict: "true" } }, { cloud: { model: "--shell-command" } }]) {
      assert.throws(() => roleModelPreference(prefs, "critic"));
    }
  });
}
