import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DynamicStrategicPlanner, StrategicBackendController } from "../src/strategic-backend.mjs";

function temporaryFile(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-strategic-"));
  return { directory, file: path.join(directory, name) };
}

test("strategic backend switch persists and a running planner observes dashboard changes", async () => {
  const fixture = temporaryFile("backend.json");
  try {
    const runnerController = new StrategicBackendController({ statePath: fixture.file, defaultMode: "kimi" });
    const dashboardController = new StrategicBackendController({ statePath: fixture.file, defaultMode: "kimi" });
    const calls = [];
    const planner = new DynamicStrategicPlanner({
      controller: runnerController,
      kimiPlanner: {
        config: { provider: "kimi-chat", model: "k3-256k" },
        async planState() { calls.push("kimi"); return { plan: { provider: "kimi" } }; },
      },
      deepseekPlanner: {
        config: { provider: "deepseek-chat", model: "deepseek-v4-flash" },
        async planState() { calls.push("deepseek"); return { plan: { provider: "deepseek" } }; },
      },
    });

    assert.equal(planner.config.provider, "kimi-chat");
    assert.equal((await planner.planState({})).strategicBackend, "kimi");
    dashboardController.setMode("deepseek", { updatedBy: "test-dashboard" });
    assert.equal(planner.config.provider, "deepseek-chat");
    assert.equal((await planner.planState({})).strategicBackend, "deepseek");
    assert.deepEqual(calls, ["kimi", "deepseek"]);
    assert.equal(new StrategicBackendController({ statePath: fixture.file }).read().mode, "deepseek");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("strategic backend rejects unsupported modes", () => {
  const fixture = temporaryFile("backend.json");
  try {
    const controller = new StrategicBackendController({ statePath: fixture.file });
    assert.throws(() => controller.setMode("local"), /kimi or deepseek/u);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("strategic backend can expose only the configured provider", async () => {
  const fixture = temporaryFile("backend.json");
  try {
    const controller = new StrategicBackendController({
      statePath: fixture.file,
      defaultMode: "kimi",
      availableModes: ["kimi"],
    });
    const planner = new DynamicStrategicPlanner({
      controller,
      kimiPlanner: {
        config: { provider: "kimi-chat", model: "k3" },
        async planState() { return { plan: { ok: true } }; },
      },
      deepseekPlanner: null,
    });
    assert.deepEqual(controller.status({ kimiPlanner: planner.kimiPlanner }).availableModes, ["kimi"]);
    assert.equal((await planner.planState({})).strategicBackend, "kimi");
    assert.throws(() => controller.setMode("deepseek"), /not configured/u);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
