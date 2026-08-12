import assert from "node:assert/strict";
import test from "node:test";

import {
  apiKeyEnvironment,
  modelRouteCredentialEnvironments,
  resolveModelRoutes,
} from "../src/model-routing.mjs";

const fallback = {
  routine: { provider: "deepseek-chat", model: "fast", baseUrl: "https://ds", reasoningEffort: "none" },
  strategic: { provider: "kimi-chat", model: "k3", baseUrl: "https://kimi", reasoningEffort: "high" },
  local: { provider: "ollama-chat", model: "local", baseUrl: "http://127.0.0.1:11434/v1", reasoningEffort: "none" },
  vision: { provider: "kimi-chat", model: "k3", baseUrl: "https://kimi", reasoningEffort: "low" },
};

test("model routing resolves two independent cloud routes", () => {
  const routes = resolveModelRoutes({ modelRoutes: { routine: { model: "flash" }, strategic: { timeoutMs: 300000 } } }, fallback, {});
  assert.equal(routes.routine.provider, "deepseek-chat");
  assert.equal(routes.routine.model, "flash");
  assert.equal(routes.strategic.provider, "kimi-chat");
  assert.equal(routes.strategic.timeoutMs, 300000);
  assert.deepEqual([...modelRouteCredentialEnvironments(routes)].sort(), ["DEEPSEEK_API_KEY", "KIMI_API_KEY"]);
});

test("local routes require no API key", () => {
  assert.equal(apiKeyEnvironment("ollama-chat"), null);
  assert.equal(apiKeyEnvironment("deepseek-chat"), "DEEPSEEK_API_KEY");
});

test("changing a route provider without a URL selects the new provider default", () => {
  const routes = resolveModelRoutes(
    { modelRoutes: { routine: { provider: "kimi-chat", model: "k3" } } },
    fallback,
    {},
  );
  assert.equal(routes.routine.baseUrl, "https://api.kimi.com/coding/v1");

  const overridden = resolveModelRoutes({}, fallback, { BALATRO_ROUTINE_PROVIDER: "kimi-platform" });
  assert.equal(overridden.routine.baseUrl, "https://api.moonshot.cn/v1");
});
