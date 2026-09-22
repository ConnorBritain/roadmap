// Requested policy, transport support, and provider-reported actual execution
// are separate facts. A prompt and a worker's self-description verify neither.
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export function normalizeModelPreference(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model preference must be a mapping");
  if (Object.keys(value).some((key) => !["model", "reasoning_effort", "strict"].includes(key))) throw new Error("unknown model preference field");
  for (const key of ["model", "reasoning_effort"]) {
    if (value[key] != null && (typeof value[key] !== "string" || !VALUE.test(value[key]))) throw new Error(`invalid ${key} preference`);
  }
  if (value.strict != null && typeof value.strict !== "boolean") throw new Error("model preference strict must be boolean");
  return { model: value.model ?? null, reasoning_effort: value.reasoning_effort ?? null, strict: value.strict ?? false };
}

export function roleModelPreference(preferences = {}, role, override = null) {
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("role model preferences must be a mapping");
  for (const [key, value] of Object.entries(preferences)) {
    if (!["lead", "cloud", "implementation", "evaluator", "critic", "repair"].includes(key)) throw new Error(`unknown model preference role: ${key}`);
    normalizeModelPreference(value);
  }
  const configured = { ...(role === "lead" ? {} : preferences.cloud || {}), ...(preferences[role] || {}) };
  const requested = normalizeModelPreference({ ...configured, ...(override || {}) });
  return { ...requested, override: override ? normalizeModelPreference(override) : null };
}

export function qualifyModelPreference({ provider, preference = {}, capabilities = {} }) {
  const { model, reasoning_effort, strict } = normalizeModelPreference(Object.fromEntries(Object.entries(preference).filter(([key]) => key !== "override")));
  const supported = { model: capabilities.per_task_model === true, reasoning_effort: capabilities.per_task_reasoning_effort === true };
  const requested = { model, reasoning_effort };
  const unsupported = Object.keys(requested).filter((key) => requested[key] != null && !supported[key]);
  if (strict && unsupported.length) throw new Error(`${provider} transport cannot enforce strict ${unsupported.join("/")} settings; choose a supported interface or explicitly use a preference instead`);
  return { requested, strict, override: preference.override || null,
    transport: { supported, model: supported.model ? model : null, reasoning_effort: supported.reasoning_effort ? reasoning_effort : null },
    actual: { model: null, reasoning_effort: null, verification: "unverified" },
    selection: unsupported.length || (!model && !reasoning_effort) ? "provider_managed_default" : "requested_settings_sent",
    warnings: unsupported.map((key) => `${provider} cannot enforce preferred ${key}=${requested[key]} through this transport; the provider-managed setting remains unverified. No local/API/provider substitution was made.`) };
}

export function recordActualModel(policy, actual, { source } = {}) {
  if (!["provider_response", "desktop_metadata"].includes(source)) throw new Error("only trustworthy provider or desktop metadata can verify actual model settings");
  const normalized = normalizeModelPreference(actual);
  return { ...policy, actual: { model: normalized.model, reasoning_effort: normalized.reasoning_effort,
    verification: normalized.model && normalized.reasoning_effort ? "verified" : "partial", source } };
}
