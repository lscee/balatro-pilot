import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { createModelStack } from "../src/models/model-stack.mjs";

class FakePlanner {
  constructor(_root, config, { apiKey } = {}) {
    this.config = config;
    this.apiKey = apiKey;
  }
}

function withConfig(contents, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-model-stack-"));
  const oldLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = directory;
  try {
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(contents));
    return callback(directory, loadConfig(directory, {}));
  } finally {
    if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocalAppData;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function route(provider, model, baseUrl) {
  return { provider, model, baseUrl, reasoningEffort: "none", timeoutMs: 10_000 };
}

test("model stack binds the routine and strategy keys independently when both routes use Kimi", () => {
  withConfig({
    controlBackend: "balatrobot",
    modelRoutes: {
      routine: route("kimi-chat", "fast-kimi", "https://api.kimi.com/coding/v1"),
      strategic: route("kimi-chat", "k3", "https://api.kimi.com/coding/v1"),
    },
  }, (directory, config) => {
    const stack = createModelStack(directory, config, {
      Planner: FakePlanner,
      credentialKeys: { routine: "routine-key", strategic: "strategy-key" },
    });
    assert.equal(stack.planners.cloudRoutine.apiKey, "routine-key");
    assert.equal(stack.planners.kimiStrategic.apiKey, "strategy-key");
    assert.equal(stack.planners.deepseekStrategic, null);
    assert.deepEqual(stack.strategicStatus.availableModes, ["kimi"]);
  });
});

test("Kimi routine can serve as the dashboard alternate without using the strategy key", () => {
  withConfig({
    controlBackend: "balatrobot",
    modelRoutes: {
      routine: route("kimi-chat", "fast-kimi", "https://api.kimi.com/coding/v1"),
      strategic: route("deepseek-chat", "reasoner", "https://api.deepseek.com"),
    },
  }, (directory, config) => {
    const stack = createModelStack(directory, config, {
      Planner: FakePlanner,
      credentialKeys: { routine: "routine-key", strategic: "strategy-key" },
    });
    assert.equal(stack.planners.kimiStrategic.apiKey, "routine-key");
    assert.equal(stack.planners.deepseekStrategic.apiKey, "strategy-key");
    assert.deepEqual(stack.strategicStatus.availableModes.sort(), ["deepseek", "kimi"]);
  });
});

test("model stack binds two independent DeepSeek keys and does not require Kimi", () => {
  withConfig({
    controlBackend: "balatrobot",
    modelRoutes: {
      routine: route("deepseek-chat", "flash", "https://api.deepseek.com"),
      strategic: route("deepseek-chat", "reasoner", "https://api.deepseek.com"),
    },
  }, (directory, config) => {
    const stack = createModelStack(directory, config, {
      Planner: FakePlanner,
      credentialKeys: { routine: "routine-key", strategic: "strategy-key" },
    });
    assert.equal(stack.planners.cloudRoutine.apiKey, "routine-key");
    assert.equal(stack.planners.deepseekStrategic.apiKey, "strategy-key");
    assert.equal(stack.planners.kimiStrategic, null);
    assert.deepEqual(stack.strategicStatus.availableModes, ["deepseek"]);
  });
});

test("the default example route matrix exposes Kimi strategy and DeepSeek alternate", () => {
  const example = JSON.parse(fs.readFileSync(path.resolve("config.example.json"), "utf8"));
  withConfig(example, (directory, config) => {
    const stack = createModelStack(directory, config, {
      Planner: FakePlanner,
      credentialKeys: { routine: "routine-key", strategic: "strategy-key" },
    });
    assert.equal(stack.planners.cloudRoutine.apiKey, "routine-key");
    assert.equal(stack.planners.kimiStrategic.apiKey, "strategy-key");
    assert.equal(stack.planners.deepseekStrategic.apiKey, "routine-key");
    assert.deepEqual(stack.strategicStatus.availableModes.sort(), ["deepseek", "kimi"]);
  });
});
