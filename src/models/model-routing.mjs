export const MODEL_PROVIDERS = Object.freeze([
  "openai-responses",
  "kimi-chat",
  "kimi-platform",
  "deepseek-chat",
  "ollama-chat",
]);

export const MODEL_ROUTES = Object.freeze({
  routine: Object.freeze({
    label: "high-frequency play",
    configField: "modelRoutes.routine",
    environmentPrefix: "BALATRO_ROUTINE",
  }),
  strategic: Object.freeze({
    label: "strategic planning",
    configField: "modelRoutes.strategic",
    environmentPrefix: "BALATRO_STRATEGIC",
  }),
  local: Object.freeze({
    label: "local high-frequency play",
    configField: "modelRoutes.local",
    environmentPrefix: "BALATRO_LOCAL",
  }),
  vision: Object.freeze({
    label: "vision fallback",
    configField: "modelRoutes.vision",
    environmentPrefix: "BALATRO_VISION",
  }),
});

const PROVIDER_DEFAULTS = Object.freeze({
  "openai-responses": Object.freeze({ baseUrl: "https://api.openai.com/v1", keyEnvironment: "OPENAI_API_KEY" }),
  "kimi-chat": Object.freeze({ baseUrl: "https://api.kimi.com/coding/v1", keyEnvironment: "KIMI_API_KEY" }),
  "kimi-platform": Object.freeze({ baseUrl: "https://api.moonshot.cn/v1", keyEnvironment: "MOONSHOT_API_KEY" }),
  "deepseek-chat": Object.freeze({ baseUrl: "https://api.deepseek.com", keyEnvironment: "DEEPSEEK_API_KEY" }),
  "ollama-chat": Object.freeze({ baseUrl: "http://127.0.0.1:11434/v1", keyEnvironment: null }),
});

const PROVIDER_BASE_URL_ENV = Object.freeze({
  "kimi-chat": "KIMI_BASE_URL",
  "kimi-platform": "MOONSHOT_BASE_URL",
  "deepseek-chat": "DEEPSEEK_BASE_URL",
  "openai-responses": "OPENAI_BASE_URL",
});

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function providerBaseUrl(provider, env, explicit) {
  const override = PROVIDER_BASE_URL_ENV[provider];
  return nonEmpty(explicit, nonEmpty(override ? env[override] : null, PROVIDER_DEFAULTS[provider]?.baseUrl));
}

function normalizeRoute(route, fallback, env, prefix) {
  const configured = objectOrEmpty(route);
  const source = { ...fallback, ...configured };
  const provider = nonEmpty(env[`${prefix}_PROVIDER`], source.provider);
  const model = nonEmpty(env[`${prefix}_MODEL`], source.model);
  const providerChanged = provider !== fallback.provider;
  const explicitBaseUrl = nonEmpty(env[`${prefix}_BASE_URL`], nonEmpty(env[`${prefix}_API_BASE_URL`], configured.baseUrl ?? configured.apiBaseUrl));
  const baseUrl = providerBaseUrl(
    provider,
    env,
    explicitBaseUrl ?? (providerChanged ? undefined : source.baseUrl ?? source.apiBaseUrl),
  );
  const reasoningEffort = nonEmpty(env[`${prefix}_REASONING_EFFORT`], source.reasoningEffort);
  const timeoutValue = env[`${prefix}_TIMEOUT_MS`] ?? source.timeoutMs;
  const timeoutMs = timeoutValue === undefined || timeoutValue === null ? undefined : Number(timeoutValue);
  return Object.freeze({ provider, model, baseUrl, reasoningEffort, timeoutMs });
}

/**
 * Build the public model boundary. New installations configure only these
 * routes. The caller supplies legacy-derived fallbacks so existing config.json
 * files continue to work without migration downtime.
 */
export function resolveModelRoutes(fileConfig = {}, legacyFallbacks, env = process.env) {
  const configured = objectOrEmpty(fileConfig.modelRoutes);
  return Object.freeze({
    routine: normalizeRoute(configured.routine, legacyFallbacks.routine, env, "BALATRO_ROUTINE"),
    strategic: normalizeRoute(configured.strategic, legacyFallbacks.strategic, env, "BALATRO_STRATEGIC"),
    local: normalizeRoute(configured.local, legacyFallbacks.local, env, "BALATRO_LOCAL"),
    vision: normalizeRoute(configured.vision, legacyFallbacks.vision, env, "BALATRO_VISION"),
  });
}

export function apiKeyEnvironment(provider) {
  if (provider === "ollama-chat") return null;
  return PROVIDER_DEFAULTS[provider]?.keyEnvironment ?? "OPENAI_API_KEY";
}

export function modelRouteCredentialEnvironments(routes, { includeVision = true } = {}) {
  const names = new Set();
  for (const name of includeVision ? ["routine", "strategic", "vision"] : ["routine", "strategic"]) {
    const environment = apiKeyEnvironment(routes[name]?.provider);
    if (environment) names.add(environment);
  }
  return names;
}

export function publicModelConfiguration(config) {
  return Object.freeze({
    routine: Object.freeze({ ...config.modelRoutes.routine }),
    strategic: Object.freeze({ ...config.modelRoutes.strategic }),
    local: Object.freeze({ ...config.modelRoutes.local }),
    vision: Object.freeze({ ...config.modelRoutes.vision }),
  });
}
