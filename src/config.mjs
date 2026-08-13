import fs from "node:fs";
import path from "node:path";

import { MODEL_PROVIDERS, resolveModelRoutes } from "./models/model-routing.mjs";

const DEFAULTS = Object.freeze({
  controlBackend: "auto",
  balatrobotUrl: "http://127.0.0.1:12346",
  balatrobotTimeoutMs: 60_000,
  balatrobotPollMs: 100,
  balatrobotTransitionTimeoutMs: 30_000,
  balatrobotDeck: "RED",
  balatrobotDeckMode: "unlock",
  balatrobotDeckMinimumTrials: 2,
  balatrobotDeckExploration: 1.15,
  balatrobotStake: "WHITE",
  balatrobotPostWinMode: "menu",
  windowTitle: "Balatro",
  provider: "openai-responses",
  model: "gpt-5.6-terra",
  apiBaseUrl: "https://api.openai.com/v1",
  reasoningEffort: "low",
  balatrobotProvider: null,
  balatrobotModel: null,
  balatrobotApiBaseUrl: null,
  balatrobotReasoningEffort: null,
  balatrobotRoutineBackendDefault: "local",
  balatrobotLocalProvider: "ollama-chat",
  balatrobotLocalModel: "balatro-pilot-qwen:latest",
  balatrobotLocalApiBaseUrl: "http://127.0.0.1:11434/v1",
  balatrobotLocalTimeoutMs: 120_000,
  balatrobotStrategicProvider: null,
  balatrobotStrategicModel: null,
  balatrobotStrategicApiBaseUrl: null,
  balatrobotStrategicThinkingEnabled: true,
  balatrobotStrategicReasoningEffort: "medium",
  balatrobotRoutineReasoningEffort: "none",
  balatrobotStrategicMaxOutputTokens: 2_400,
  balatrobotStrategicTimeoutMs: 300_000,
  balatrobotHandCandidateLimit: 14,
  imageDetail: "high",
  fallbackImageDetail: "original",
  maxOutputTokens: 1_200,
  goal:
    "Maximize the probability of clearing each Blind and winning the whole run. Plan across all remaining Hands and Discards, use remaining-deck outs when valuable, cycle low-value dead cards through spare Play Hand slots, and build sustainable high-value poker hands. Evaluate shop choices against the installed-version metagame, survival, interest bands, slot opportunity cost, and a durable single-run plan: skip weak early placeholders when already safe, spend for decisive strength, and pivot in the mid game when a supported high-impact package materially improves the run.",
  maxSteps: null,
  minimumConfidence: 0.7,
  balatrobotMinimumConfidence: 0.55,
  actionDelayMs: 100,
  cardClickDelayMs: 600,
  cardClickRetries: 1,
  cardAckThreshold: 0.03,
  cardAckSettleMs: 250,
  cardHoverSettleMs: 180,
  commitAckSettleMs: 700,
  commitClickRetries: 1,
  commitAckThreshold: 0.015,
  shopHoverSettleMs: 300,
  shopPurchaseButtonSettleMs: 250,
  shopPurchaseBaselineMs: 200,
  shopPurchaseSettleMs: 900,
  shopPurchaseConfirmMs: 250,
  shopPurchaseRetries: 1,
  shopPurchaseAckThreshold: 0.055,
  shopPurchaseStabilityThreshold: 0.04,
  shopPurchaseRetryUnchangedThreshold: 0.02,
  handTransitionSettleMs: 1_800,
  focusBeforeCapture: true,
  captureSettleMs: 100,
  frameGateEnabled: true,
  frameProbeMs: 150,
  frameStableSamples: 2,
  frameStableThreshold: 0.012,
  frameStableRatio: 0.45,
  frameChangeCellThreshold: 0.06,
  frameChangeThreshold: 0.08,
  preActionFreshnessChangeRatio: 0.18,
  preActionStaticLayoutChangeRatio: 0.26,
  preActionAnimatedOverlayChangeRatio: 0.32,
  preActionHandRegionThreshold: 0.04,
  preActionShopTargetThreshold: 0.055,
  frameGateTimeoutMs: 5_000,
  apiTimeoutMs: 90_000,
  apiRetries: 2,
  semanticRagEnabled: true,
  semanticRagDatabasePath: "data/semantic-experience.sqlite",
  semanticRagTopK: 4,
  semanticRagMinimumSamples: 1,
  semanticRagHotLimit: 5_000,
  semanticRagSearchBudgetMs: 15,
  semanticRagMinimumSimilarity: 0.72,
  semanticRagMaxContextChars: 1_600,
  // Exact replay is evidence only. Cross-seed experience calibrates the local
  // candidate list and can never bypass the routine/strategic planner.
  semanticFastPathEnabled: false,
  semanticFastPathMinimumSamples: 3,
  semanticFastPathMinimumWinningEpisodes: 3,
  semanticFastPathMinimumAverageReturn: 1,
  semanticFastPathMinimumPositiveRate: 0.75,
  semanticPriorMinimumEpisodes: 3,
  semanticPriorConfidenceZ: 1.28,
  semanticPriorMaximumBlend: 0.3,
  semanticEpisodeDiscount: 0.97,
});

function asInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const PROVIDER_BASE_URL_ENV = Object.freeze({
  "kimi-chat": "KIMI_BASE_URL",
  "kimi-platform": "MOONSHOT_BASE_URL",
  "deepseek-chat": "DEEPSEEK_BASE_URL",
  "openai-responses": "OPENAI_BASE_URL",
});

const ENV_OVERRIDES = Object.freeze([
  ["BALATRO_PROVIDER", "provider"],
  ["BALATRO_CONTROL_BACKEND", "controlBackend"],
  ["BALATROBOT_URL", "balatrobotUrl"],
  ["BALATROBOT_DECK", "balatrobotDeck"],
  ["BALATROBOT_DECK_MODE", "balatrobotDeckMode"],
  ["BALATROBOT_POST_WIN_MODE", "balatrobotPostWinMode"],
  ["BALATRO_MODEL", "model"],
  ["BALATROBOT_PROVIDER", "balatrobotProvider"],
  ["BALATROBOT_MODEL", "balatrobotModel"],
  ["BALATROBOT_API_BASE_URL", "balatrobotApiBaseUrl"],
  ["BALATROBOT_REASONING_EFFORT", "balatrobotReasoningEffort"],
  ["BALATROBOT_ROUTINE_BACKEND_DEFAULT", "balatrobotRoutineBackendDefault"],
  ["BALATROBOT_LOCAL_PROVIDER", "balatrobotLocalProvider"],
  ["BALATROBOT_LOCAL_MODEL", "balatrobotLocalModel"],
  ["BALATROBOT_LOCAL_API_BASE_URL", "balatrobotLocalApiBaseUrl"],
  ["BALATROBOT_LOCAL_TIMEOUT_MS", "balatrobotLocalTimeoutMs", Number],
  ["BALATROBOT_STRATEGIC_PROVIDER", "balatrobotStrategicProvider"],
  ["BALATROBOT_STRATEGIC_MODEL", "balatrobotStrategicModel"],
  ["BALATROBOT_STRATEGIC_API_BASE_URL", "balatrobotStrategicApiBaseUrl"],
  ["BALATROBOT_STRATEGIC_REASONING_EFFORT", "balatrobotStrategicReasoningEffort"],
  ["BALATROBOT_STRATEGIC_TIMEOUT_MS", "balatrobotStrategicTimeoutMs", Number],
]);

function applyEnvironmentOverrides(config, env) {
  for (const [environment, field, convert = (value) => value] of ENV_OVERRIDES) {
    if (env[environment] !== undefined && env[environment] !== "") {
      config[field] = convert(env[environment]);
    }
  }
}

function providerBaseUrl(env, provider) {
  const environment = PROVIDER_BASE_URL_ENV[provider];
  return environment ? env[environment] : null;
}

function assertOneOf(value, name, allowed) {
  if (allowed.includes(value)) return;
  const choices = allowed.length === 2
    ? `${allowed[0]} or ${allowed[1]}`
    : `${allowed.slice(0, -1).join(", ")}, or ${allowed.at(-1)}`;
  throw new Error(`${name} must be ${choices}`);
}

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

function assertUnitInterval(value, name) {
  if (typeof value !== "number" || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}

function assertBoolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
}

export function loadConfig(projectRoot, env = process.env) {
  const configPath = path.join(projectRoot, "config.json");
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  const config = {
    ...DEFAULTS,
    ...fileConfig,
  };

  applyEnvironmentOverrides(config, env);
  config.apiBaseUrl = providerBaseUrl(env, config.provider) || config.apiBaseUrl;

  config.balatrobotProvider ??= config.provider;
  config.balatrobotModel ??= config.model;
  config.balatrobotApiBaseUrl ??= config.apiBaseUrl;
  config.balatrobotReasoningEffort ??= config.reasoningEffort;
  config.balatrobotStrategicProvider ??= config.balatrobotProvider;
  config.balatrobotStrategicModel ??= config.balatrobotModel;
  config.balatrobotStrategicApiBaseUrl ??= config.balatrobotApiBaseUrl;
  if (!env.BALATROBOT_API_BASE_URL && fileConfig.balatrobotApiBaseUrl == null) {
    config.balatrobotApiBaseUrl = providerBaseUrl(env, config.balatrobotProvider) || config.balatrobotApiBaseUrl;
  }
  if (!env.BALATROBOT_STRATEGIC_API_BASE_URL && fileConfig.balatrobotStrategicApiBaseUrl == null) {
    config.balatrobotStrategicApiBaseUrl =
      providerBaseUrl(env, config.balatrobotStrategicProvider) || config.balatrobotStrategicApiBaseUrl;
  }

  config.modelRoutes = resolveModelRoutes(
    fileConfig,
    {
      routine: {
        provider: config.balatrobotProvider,
        model: config.balatrobotModel,
        baseUrl: config.balatrobotApiBaseUrl,
        reasoningEffort: config.balatrobotReasoningEffort,
        timeoutMs: config.apiTimeoutMs,
      },
      strategic: {
        provider: config.balatrobotStrategicProvider,
        model: config.balatrobotStrategicModel,
        baseUrl: config.balatrobotStrategicApiBaseUrl,
        reasoningEffort: config.balatrobotStrategicReasoningEffort,
        timeoutMs: config.balatrobotStrategicTimeoutMs,
      },
      local: {
        provider: config.balatrobotLocalProvider,
        model: config.balatrobotLocalModel,
        baseUrl: config.balatrobotLocalApiBaseUrl,
        reasoningEffort: config.balatrobotRoutineReasoningEffort,
        timeoutMs: config.balatrobotLocalTimeoutMs,
      },
      vision: {
        provider: config.provider,
        model: config.model,
        baseUrl: config.apiBaseUrl,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.apiTimeoutMs,
      },
    },
    env,
  );
  const hasExplicitModelRoutes = fileConfig.modelRoutes && typeof fileConfig.modelRoutes === "object";
  const hasExplicitVisionRoute = hasExplicitModelRoutes && fileConfig.modelRoutes.vision && typeof fileConfig.modelRoutes.vision === "object";
  const hasVisionEnvironmentOverride = Object.keys(env).some((name) => name.startsWith("BALATRO_VISION_") && env[name]);
  if (hasExplicitModelRoutes && !hasExplicitVisionRoute && !hasVisionEnvironmentOverride) {
    config.modelRoutes = Object.freeze({
      ...config.modelRoutes,
      vision: Object.freeze({
        ...config.modelRoutes.strategic,
        reasoningEffort: "low",
        timeoutMs: Math.min(config.modelRoutes.strategic.timeoutMs ?? config.apiTimeoutMs, config.apiTimeoutMs),
      }),
    });
  }
  config.balatrobotProvider = config.modelRoutes.routine.provider;
  config.balatrobotModel = config.modelRoutes.routine.model;
  config.balatrobotApiBaseUrl = config.modelRoutes.routine.baseUrl;
  config.balatrobotReasoningEffort = config.modelRoutes.routine.reasoningEffort;
  config.balatrobotStrategicProvider = config.modelRoutes.strategic.provider;
  config.balatrobotStrategicModel = config.modelRoutes.strategic.model;
  config.balatrobotStrategicApiBaseUrl = config.modelRoutes.strategic.baseUrl;
  config.balatrobotStrategicReasoningEffort = config.modelRoutes.strategic.reasoningEffort;
  config.balatrobotStrategicTimeoutMs = config.modelRoutes.strategic.timeoutMs ?? config.balatrobotStrategicTimeoutMs;
  config.balatrobotLocalProvider = config.modelRoutes.local.provider;
  config.balatrobotLocalModel = config.modelRoutes.local.model;
  config.balatrobotLocalApiBaseUrl = config.modelRoutes.local.baseUrl;
  config.balatrobotLocalTimeoutMs = config.modelRoutes.local.timeoutMs ?? config.balatrobotLocalTimeoutMs;
  config.provider = config.modelRoutes.vision.provider;
  config.model = config.modelRoutes.vision.model;
  config.apiBaseUrl = config.modelRoutes.vision.baseUrl;
  config.reasoningEffort = config.modelRoutes.vision.reasoningEffort;

  assertNonEmpty(config.windowTitle, "windowTitle");
  assertOneOf(config.controlBackend, "controlBackend", ["auto", "balatrobot", "vision"]);
  let balatrobotUrl;
  try {
    balatrobotUrl = new URL(config.balatrobotUrl);
  } catch {
    throw new Error("balatrobotUrl must be an http(s) URL");
  }
  if (!new Set(["http:", "https:"]).has(balatrobotUrl.protocol)) {
    throw new Error("balatrobotUrl must be an http(s) URL");
  }
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(balatrobotUrl.hostname)) {
    throw new Error("balatrobotUrl must use loopback host 127.0.0.1, localhost, or [::1]");
  }
  const balatrobotDecks = new Set([
    "RED",
    "BLUE",
    "YELLOW",
    "GREEN",
    "BLACK",
    "MAGIC",
    "NEBULA",
    "GHOST",
    "ABANDONED",
    "CHECKERED",
    "ZODIAC",
    "PAINTED",
    "ANAGLYPH",
    "PLASMA",
    "ERRATIC",
  ]);
  config.balatrobotDeck = String(config.balatrobotDeck).toUpperCase();
  if (!balatrobotDecks.has(config.balatrobotDeck)) {
    throw new Error(`balatrobotDeck must be one of: ${[...balatrobotDecks].join(", ")}`);
  }
  assertOneOf(config.balatrobotDeckMode, "balatrobotDeckMode", ["unlock", "adaptive", "fixed"]);
  const balatrobotStakes = new Set(["WHITE", "RED", "GREEN", "BLACK", "BLUE", "PURPLE", "ORANGE", "GOLD"]);
  if (!balatrobotStakes.has(config.balatrobotStake)) {
    throw new Error(`balatrobotStake must be one of: ${[...balatrobotStakes].join(", ")}`);
  }
  assertOneOf(config.balatrobotPostWinMode, "balatrobotPostWinMode", ["menu", "endless"]);
  assertNonEmpty(config.model, "model");
  const providers = new Set(MODEL_PROVIDERS);
  for (const [name, value] of [
    ["provider", config.provider],
    ["balatrobotProvider", config.balatrobotProvider],
    ["balatrobotStrategicProvider", config.balatrobotStrategicProvider],
    ["balatrobotLocalProvider", config.balatrobotLocalProvider],
  ]) {
    if (!providers.has(value)) {
      throw new Error(`${name} must be openai-responses, kimi-chat, kimi-platform, deepseek-chat, or ollama-chat`);
    }
  }
  for (const [name, value] of [
    ["apiBaseUrl", config.apiBaseUrl],
    ["balatrobotApiBaseUrl", config.balatrobotApiBaseUrl],
    ["balatrobotStrategicApiBaseUrl", config.balatrobotStrategicApiBaseUrl],
    ["balatrobotLocalApiBaseUrl", config.balatrobotLocalApiBaseUrl],
  ]) {
    if (!/^https?:\/\//i.test(value)) throw new Error(`${name} must be an http(s) URL`);
  }
  const localUrl = new URL(config.balatrobotLocalApiBaseUrl);
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(localUrl.hostname)) {
    throw new Error("balatrobotLocalApiBaseUrl must use a loopback host");
  }
  assertOneOf(config.balatrobotRoutineBackendDefault, "balatrobotRoutineBackendDefault", ["local", "deepseek"]);
  const reasoningEfforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
  for (const [name, value] of [
    ["reasoningEffort", config.reasoningEffort],
    ["balatrobotReasoningEffort", config.balatrobotReasoningEffort],
    ["balatrobotStrategicReasoningEffort", config.balatrobotStrategicReasoningEffort],
    ["balatrobotRoutineReasoningEffort", config.balatrobotRoutineReasoningEffort],
  ]) {
    if (!reasoningEfforts.has(value)) throw new Error(`${name} is invalid`);
  }
  for (const [routeName, route] of Object.entries(config.modelRoutes)) {
    assertNonEmpty(route.model, `modelRoutes.${routeName}.model`);
    if (!providers.has(route.provider)) {
      throw new Error(`modelRoutes.${routeName}.provider must be openai-responses, kimi-chat, kimi-platform, deepseek-chat, or ollama-chat`);
    }
    if (!reasoningEfforts.has(route.reasoningEffort)) {
      throw new Error(`modelRoutes.${routeName}.reasoningEffort is invalid`);
    }
    let routeUrl;
    try {
      routeUrl = new URL(route.baseUrl);
    } catch {
      throw new Error(`modelRoutes.${routeName}.baseUrl must be an http(s) URL`);
    }
    if (!new Set(["http:", "https:"]).has(routeUrl.protocol)) {
      throw new Error(`modelRoutes.${routeName}.baseUrl must be an http(s) URL`);
    }
    if (route.provider === "ollama-chat" && !new Set(["127.0.0.1", "localhost", "[::1]"]).has(routeUrl.hostname)) {
      throw new Error(`modelRoutes.${routeName}.baseUrl must use a loopback host for ollama-chat`);
    }
    if (route.timeoutMs !== undefined) {
      asInteger(route.timeoutMs, `modelRoutes.${routeName}.timeoutMs`, 1_000, 600_000);
    }
  }
  if (hasExplicitModelRoutes && !new Set(["kimi-chat", "kimi-platform", "deepseek-chat"]).has(config.modelRoutes.strategic.provider)) {
    throw new Error("modelRoutes.strategic.provider must be kimi-chat, kimi-platform, or deepseek-chat");
  }
  if (hasExplicitModelRoutes && config.modelRoutes.routine.provider === "ollama-chat") {
    throw new Error("modelRoutes.routine.provider must be a cloud provider; use modelRoutes.local for ollama-chat");
  }
  if (hasExplicitModelRoutes && (config.controlBackend === "auto" || config.controlBackend === "vision") &&
      config.modelRoutes.vision.provider !== config.modelRoutes.strategic.provider) {
    throw new Error("modelRoutes.vision.provider must match modelRoutes.strategic.provider so both can use the strategic API Key");
  }
  if (hasExplicitModelRoutes && (config.controlBackend === "auto" || config.controlBackend === "vision") &&
      !new Set(["openai-responses", "kimi-chat", "kimi-platform"]).has(config.modelRoutes.vision.provider)) {
    throw new Error("modelRoutes.vision.provider must support image input in auto or vision mode");
  }
  for (const name of ["balatrobotModel", "balatrobotStrategicModel", "balatrobotLocalModel"]) {
    assertNonEmpty(config[name], name);
  }
  for (const name of ["imageDetail", "fallbackImageDetail"]) {
    assertOneOf(config[name], name, ["low", "high", "auto", "original"]);
  }
  if (config.maxSteps !== null) asInteger(config.maxSteps, "maxSteps", 1, 10_000);
  asInteger(config.maxOutputTokens, "maxOutputTokens", 200, 5_000);
  asInteger(config.balatrobotStrategicMaxOutputTokens, "balatrobotStrategicMaxOutputTokens", 800, 32_000);
  asInteger(config.balatrobotStrategicTimeoutMs, "balatrobotStrategicTimeoutMs", 5_000, 600_000);
  asInteger(config.balatrobotLocalTimeoutMs, "balatrobotLocalTimeoutMs", 5_000, 600_000);
  asInteger(config.balatrobotTimeoutMs, "balatrobotTimeoutMs", 1_000, 120_000);
  asInteger(config.balatrobotPollMs, "balatrobotPollMs", 0, 5_000);
  asInteger(config.balatrobotTransitionTimeoutMs, "balatrobotTransitionTimeoutMs", 1_000, 120_000);
  asInteger(config.balatrobotDeckMinimumTrials, "balatrobotDeckMinimumTrials", 1, 100);
  asInteger(config.actionDelayMs, "actionDelayMs", 0, 10_000);
  asInteger(config.cardClickDelayMs, "cardClickDelayMs", 50, 2_000);
  asInteger(config.cardClickRetries, "cardClickRetries", 0, 3);
  asInteger(config.cardAckSettleMs, "cardAckSettleMs", 0, 2_000);
  asInteger(config.cardHoverSettleMs, "cardHoverSettleMs", 0, 2_000);
  asInteger(config.commitAckSettleMs, "commitAckSettleMs", 100, 5_000);
  asInteger(config.commitClickRetries, "commitClickRetries", 0, 3);
  asInteger(config.shopHoverSettleMs, "shopHoverSettleMs", 50, 2_000);
  asInteger(config.shopPurchaseButtonSettleMs, "shopPurchaseButtonSettleMs", 0, 2_000);
  asInteger(config.shopPurchaseBaselineMs, "shopPurchaseBaselineMs", 0, 2_000);
  asInteger(config.shopPurchaseSettleMs, "shopPurchaseSettleMs", 100, 5_000);
  asInteger(config.shopPurchaseConfirmMs, "shopPurchaseConfirmMs", 0, 2_000);
  asInteger(config.shopPurchaseRetries, "shopPurchaseRetries", 0, 3);
  asInteger(config.handTransitionSettleMs, "handTransitionSettleMs", 0, 10_000);
  asInteger(config.captureSettleMs, "captureSettleMs", 0, 10_000);
  asInteger(config.frameProbeMs, "frameProbeMs", 50, 5_000);
  asInteger(config.frameStableSamples, "frameStableSamples", 1, 10);
  asInteger(config.frameGateTimeoutMs, "frameGateTimeoutMs", 500, 60_000);
  asInteger(config.apiTimeoutMs, "apiTimeoutMs", 1_000, 600_000);
  asInteger(config.apiRetries, "apiRetries", 0, 5);
  asInteger(config.semanticRagTopK, "semanticRagTopK", 1, 10);
  asInteger(config.semanticRagMinimumSamples, "semanticRagMinimumSamples", 1, 10_000);
  asInteger(config.semanticRagHotLimit, "semanticRagHotLimit", 100, 100_000);
  asInteger(config.semanticRagSearchBudgetMs, "semanticRagSearchBudgetMs", 1, 1_000);
  asInteger(config.semanticRagMaxContextChars, "semanticRagMaxContextChars", 200, 5_000);
  asInteger(config.semanticFastPathMinimumSamples, "semanticFastPathMinimumSamples", 1, 10_000);
  asInteger(config.semanticFastPathMinimumWinningEpisodes, "semanticFastPathMinimumWinningEpisodes", 1, 10_000);
  asInteger(config.semanticPriorMinimumEpisodes, "semanticPriorMinimumEpisodes", 2, 10_000);
  asInteger(config.balatrobotHandCandidateLimit, "balatrobotHandCandidateLimit", 2, 30);
  for (const name of [
    "minimumConfidence",
    "balatrobotMinimumConfidence",
    "cardAckThreshold",
    "commitAckThreshold",
    "shopPurchaseAckThreshold",
    "shopPurchaseStabilityThreshold",
    "shopPurchaseRetryUnchangedThreshold",
    "frameStableThreshold",
    "frameStableRatio",
    "frameChangeCellThreshold",
    "frameChangeThreshold",
    "preActionFreshnessChangeRatio",
    "preActionStaticLayoutChangeRatio",
    "preActionAnimatedOverlayChangeRatio",
    "preActionHandRegionThreshold",
    "preActionShopTargetThreshold",
  ]) {
    assertUnitInterval(config[name], name);
  }
  if (config.frameStableThreshold >= config.frameChangeCellThreshold) {
    throw new Error("frameStableThreshold must be lower than frameChangeCellThreshold");
  }
  if (config.preActionAnimatedOverlayChangeRatio < config.preActionFreshnessChangeRatio) {
    throw new Error("preActionAnimatedOverlayChangeRatio must be at least preActionFreshnessChangeRatio");
  }
  if (config.preActionStaticLayoutChangeRatio < config.preActionFreshnessChangeRatio) {
    throw new Error("preActionStaticLayoutChangeRatio must be at least preActionFreshnessChangeRatio");
  }
  for (const name of [
    "frameGateEnabled",
    "semanticRagEnabled",
    "semanticFastPathEnabled",
    "balatrobotStrategicThinkingEnabled",
  ]) assertBoolean(config[name], name);
  assertNonEmpty(config.semanticRagDatabasePath, "semanticRagDatabasePath");
  for (const name of ["semanticRagMinimumSimilarity", "semanticFastPathMinimumPositiveRate", "semanticPriorMaximumBlend", "semanticEpisodeDiscount"]) {
    assertUnitInterval(config[name], name);
  }
  if (!Number.isFinite(config.semanticPriorConfidenceZ) || config.semanticPriorConfidenceZ < 0.5 || config.semanticPriorConfidenceZ > 3) {
    throw new Error("semanticPriorConfidenceZ must be between 0.5 and 3");
  }
  if (!Number.isFinite(config.semanticFastPathMinimumAverageReturn)) {
    throw new Error("semanticFastPathMinimumAverageReturn must be a finite number");
  }
  if (!Number.isFinite(config.balatrobotDeckExploration) || config.balatrobotDeckExploration < 0 || config.balatrobotDeckExploration > 5) {
    throw new Error("balatrobotDeckExploration must be between 0 and 5");
  }

  return Object.freeze(config);
}

export function plannerConfigForBackend(config, backend = "vision") {
  if (backend === "vision") {
    const route = config.modelRoutes.vision;
    return Object.freeze({
      ...config,
      plannerRole: "vision",
      provider: route.provider,
      model: route.model,
      apiBaseUrl: route.baseUrl,
      reasoningEffort: route.reasoningEffort,
      apiTimeoutMs: route.timeoutMs ?? config.apiTimeoutMs,
    });
  }
  const route = {
    balatrobot: {
      plannerRole: "routine",
      provider: config.modelRoutes.routine.provider,
      model: config.modelRoutes.routine.model,
      apiBaseUrl: config.modelRoutes.routine.baseUrl,
      reasoningEffort: config.modelRoutes.routine.reasoningEffort,
      apiTimeoutMs: config.modelRoutes.routine.timeoutMs ?? config.apiTimeoutMs,
    },
    "balatrobot-local": {
      plannerRole: "routine",
      provider: config.modelRoutes.local.provider,
      model: config.modelRoutes.local.model,
      apiBaseUrl: config.modelRoutes.local.baseUrl,
      reasoningEffort: config.modelRoutes.local.reasoningEffort,
      apiTimeoutMs: config.modelRoutes.local.timeoutMs ?? config.balatrobotLocalTimeoutMs,
      apiRetries: 0,
    },
    "balatrobot-strategic": {
      plannerRole: "strategic",
      provider: config.modelRoutes.strategic.provider,
      model: config.modelRoutes.strategic.model,
      apiBaseUrl: config.modelRoutes.strategic.baseUrl,
      reasoningEffort: config.modelRoutes.strategic.reasoningEffort,
      apiTimeoutMs: config.modelRoutes.strategic.timeoutMs ?? config.balatrobotStrategicTimeoutMs,
    },
  }[backend];
  if (!route) {
    throw new Error("planner backend must be vision, balatrobot, balatrobot-local, or balatrobot-strategic");
  }
  return Object.freeze({ ...config, ...route });
}

export { DEFAULTS };
