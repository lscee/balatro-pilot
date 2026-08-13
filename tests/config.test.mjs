import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, plannerConfigForBackend } from "../src/config.mjs";

function withConfig(contents, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-pilot-config-"));
  try {
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(contents));
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("loadConfig keeps Kimi vision while routing exact state to DeepSeek V4 Flash", () => {
  withConfig(
    {
      provider: "kimi-platform",
      model: "kimi-k3",
      apiBaseUrl: "https://api.moonshot.cn/v1",
      balatrobotProvider: "deepseek-chat",
      balatrobotModel: "deepseek-v4-flash",
      balatrobotApiBaseUrl: "https://api.deepseek.com",
      balatrobotReasoningEffort: "none",
      balatrobotStrategicProvider: "kimi-chat",
      balatrobotStrategicModel: "k3-256k",
      balatrobotStrategicApiBaseUrl: "https://api.kimi.com/coding/v1",
    },
    (directory) => {
      const config = loadConfig(directory, {});
      const exact = plannerConfigForBackend(config, "balatrobot");
      const local = plannerConfigForBackend(config, "balatrobot-local");
      const strategic = plannerConfigForBackend(config, "balatrobot-strategic");
      assert.equal(config.provider, "kimi-platform");
      assert.equal(config.model, "kimi-k3");
      assert.equal(exact.provider, "deepseek-chat");
      assert.equal(exact.plannerRole, "routine");
      assert.equal(exact.model, "deepseek-v4-flash");
      assert.equal(exact.apiBaseUrl, "https://api.deepseek.com");
      assert.equal(exact.reasoningEffort, "none");
      assert.equal(local.provider, "ollama-chat");
      assert.equal(local.model, "balatro-pilot-qwen:latest");
      assert.equal(local.apiBaseUrl, "http://127.0.0.1:11434/v1");
      assert.equal(local.apiRetries, 0);
      assert.equal(config.balatrobotRoutineBackendDefault, "local");
      assert.equal(strategic.provider, "kimi-chat");
      assert.equal(strategic.plannerRole, "strategic");
      assert.equal(strategic.model, "k3-256k");
      assert.equal(strategic.apiBaseUrl, "https://api.kimi.com/coding/v1");
      assert.equal(strategic.reasoningEffort, "medium");
      assert.equal(strategic.apiTimeoutMs, 300_000);
      assert.equal(exact.balatrobotStrategicThinkingEnabled, true);
      assert.equal(exact.balatrobotStrategicReasoningEffort, "medium");
      assert.equal(exact.balatrobotRoutineReasoningEffort, "none");
      assert.equal(exact.balatrobotStrategicMaxOutputTokens, 2_400);
      assert.equal(exact.balatrobotStrategicTimeoutMs, 300_000);
      assert.equal(exact.balatrobotHandCandidateLimit, 14);
      assert.equal(exact.balatrobotDeckMode, "unlock");
      assert.equal(exact.balatrobotPostWinMode, "menu");
      assert.equal(exact.balatrobotDeckMinimumTrials, 2);
    },
  );
});

test("loadConfig supports environment overrides for the exact-state planner", () => {
  withConfig({}, (directory) => {
    const config = loadConfig(directory, {
      BALATROBOT_PROVIDER: "deepseek-chat",
      BALATROBOT_MODEL: "deepseek-v4-flash",
      DEEPSEEK_BASE_URL: "https://deepseek.example",
      BALATROBOT_REASONING_EFFORT: "none",
    });
    const exact = plannerConfigForBackend(config, "balatrobot");
    assert.equal(exact.provider, "deepseek-chat");
    assert.equal(exact.model, "deepseek-v4-flash");
    assert.equal(exact.apiBaseUrl, "https://deepseek.example");
    assert.equal(exact.reasoningEffort, "none");
  });
});

test("loadConfig supports unlock, fixed, or adaptive deck selection overrides", () => {
  withConfig({}, (directory) => {
    const fixed = loadConfig(directory, { BALATROBOT_DECK: "blue", BALATROBOT_DECK_MODE: "fixed" });
    assert.equal(fixed.balatrobotDeck, "BLUE");
    assert.equal(fixed.balatrobotDeckMode, "fixed");
  });
  withConfig({ balatrobotDeckMode: "random" }, (directory) => {
    assert.throws(() => loadConfig(directory, {}), /unlock, adaptive, or fixed/u);
  });
});

test("loadConfig defaults to ending a confirmed win and permits explicit Endless mode", () => {
  withConfig({}, (directory) => {
    assert.equal(loadConfig(directory, {}).balatrobotPostWinMode, "menu");
    assert.equal(
      loadConfig(directory, { BALATROBOT_POST_WIN_MODE: "endless" }).balatrobotPostWinMode,
      "endless",
    );
  });
  withConfig({ balatrobotPostWinMode: "invalid" }, (directory) => {
    assert.throws(() => loadConfig(directory, {}), /balatrobotPostWinMode must be menu or endless/u);
  });
});

test("loadConfig supports an independent strategic exact-state route", () => {
  withConfig({}, (directory) => {
    const config = loadConfig(directory, {
      BALATROBOT_PROVIDER: "deepseek-chat",
      BALATROBOT_MODEL: "deepseek-v4-flash",
      BALATROBOT_API_BASE_URL: "https://deepseek.example",
      BALATROBOT_STRATEGIC_PROVIDER: "kimi-chat",
      BALATROBOT_STRATEGIC_MODEL: "k3-256k",
      BALATROBOT_STRATEGIC_API_BASE_URL: "https://kimi.example/coding/v1",
      BALATROBOT_STRATEGIC_REASONING_EFFORT: "high",
      BALATROBOT_STRATEGIC_TIMEOUT_MS: "35000",
    });
    const routine = plannerConfigForBackend(config, "balatrobot");
    const strategic = plannerConfigForBackend(config, "balatrobot-strategic");
    assert.equal(routine.provider, "deepseek-chat");
    assert.equal(routine.model, "deepseek-v4-flash");
    assert.equal(strategic.provider, "kimi-chat");
    assert.equal(strategic.model, "k3-256k");
    assert.equal(strategic.apiBaseUrl, "https://kimi.example/coding/v1");
    assert.equal(strategic.reasoningEffort, "high");
    assert.equal(strategic.apiTimeoutMs, 35_000);
  });
});

test("loadConfig rejects unsupported exact-state providers", () => {
  withConfig({ balatrobotProvider: "unknown-provider" }, (directory) => {
    assert.throws(() => loadConfig(directory, {}), /balatrobotProvider must be/);
  });
});

test("loadConfig exposes two public cloud model routes and keeps legacy aliases synchronized", () => {
  withConfig(
    {
      modelRoutes: {
        routine: {
          provider: "deepseek-chat",
          model: "deepseek-v4-flash",
          baseUrl: "https://routine.example",
          reasoningEffort: "none",
          timeoutMs: 45000,
        },
        strategic: {
          provider: "kimi-chat",
          model: "k3-256k",
          baseUrl: "https://strategic.example/v1",
          reasoningEffort: "high",
          timeoutMs: 240000,
        },
      },
    },
    (directory) => {
      const config = loadConfig(directory, {});
      assert.equal(config.modelRoutes.routine.provider, "deepseek-chat");
      assert.equal(config.modelRoutes.strategic.provider, "kimi-chat");
      assert.equal(config.modelRoutes.vision.provider, "kimi-chat");
      assert.equal(config.modelRoutes.vision.model, "k3-256k");
      assert.equal(config.balatrobotProvider, "deepseek-chat");
      assert.equal(config.balatrobotStrategicProvider, "kimi-chat");
      assert.equal(plannerConfigForBackend(config, "balatrobot").apiTimeoutMs, 45000);
      assert.equal(plannerConfigForBackend(config, "balatrobot-strategic").apiTimeoutMs, 240000);
    },
  );
});

test("a two-route config makes the vision fallback reuse the strategic route", () => {
  withConfig({
    modelRoutes: {
      routine: { provider: "deepseek-chat", model: "flash", baseUrl: "https://api.deepseek.com", reasoningEffort: "none" },
      strategic: { provider: "kimi-chat", model: "k3", baseUrl: "https://api.kimi.com/coding/v1", reasoningEffort: "medium" },
    },
  }, (directory) => {
    const config = loadConfig(directory, {});
    assert.equal(config.modelRoutes.vision.provider, "kimi-chat");
    assert.equal(config.modelRoutes.vision.model, "k3");
    assert.equal(config.modelRoutes.vision.baseUrl, "https://api.kimi.com/coding/v1");
  });
});

test("an explicit new strategic route rejects unsupported providers", () => {
  withConfig({ modelRoutes: { strategic: { provider: "openai-responses", model: "gpt", baseUrl: "https://api.openai.com/v1" } } }, (directory) => {
    assert.throws(() => loadConfig(directory, {}), /modelRoutes\.strategic\.provider/u);
  });
});

test("new route-specific environment variables override modelRoutes", () => {
  withConfig({}, (directory) => {
    const config = loadConfig(directory, {
      BALATRO_ROUTINE_PROVIDER: "deepseek-chat",
      BALATRO_ROUTINE_MODEL: "routine-model",
      BALATRO_ROUTINE_BASE_URL: "https://routine.example",
      BALATRO_STRATEGIC_PROVIDER: "kimi-platform",
      BALATRO_STRATEGIC_MODEL: "strategic-model",
      BALATRO_STRATEGIC_BASE_URL: "https://strategic.example/v1",
    });
    assert.equal(config.modelRoutes.routine.model, "routine-model");
    assert.equal(config.modelRoutes.routine.baseUrl, "https://routine.example");
    assert.equal(config.modelRoutes.strategic.provider, "kimi-platform");
    assert.equal(config.modelRoutes.strategic.model, "strategic-model");
  });
});

test("loadConfig rejects invalid route-specific timeouts and remote Ollama URLs", () => {
  withConfig({}, (directory) => {
    assert.throws(
      () => loadConfig(directory, { BALATRO_ROUTINE_TIMEOUT_MS: "bad" }),
      /modelRoutes\.routine\.timeoutMs/u,
    );
    assert.throws(
      () => loadConfig(directory, { BALATRO_ROUTINE_TIMEOUT_MS: "1234.5" }),
      /modelRoutes\.routine\.timeoutMs/u,
    );
    assert.throws(
      () => loadConfig(directory, { BALATRO_LOCAL_BASE_URL: "https://remote.example/v1" }),
      /loopback host/u,
    );
  });
});
