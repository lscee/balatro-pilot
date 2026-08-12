import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DynamicRoutinePlanner, RoutineBackendController } from "../src/routine-backend.mjs";
import { StrategicCheckpointStore } from "../src/strategic-checkpoints.mjs";

function temporaryFile(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-routine-"));
  return { directory, file: path.join(directory, name) };
}

test("routine backend mode persists and DeepSeek selection bypasses the local planner", async () => {
  const fixture = temporaryFile("backend.json");
  try {
    const controller = new RoutineBackendController({ statePath: fixture.file, defaultMode: "local" });
    assert.equal(controller.read().mode, "local");
    controller.setMode("deepseek", { updatedBy: "test" });
    assert.equal(new RoutineBackendController({ statePath: fixture.file }).read().mode, "deepseek");
    const planner = new DynamicRoutinePlanner({
      controller,
      localPlanner: { config: { provider: "ollama-chat" }, async planState() { throw new Error("must not run"); } },
      deepseekPlanner: { config: { provider: "deepseek-chat" }, async planState() { return { plan: { ok: true } }; } },
    });
    const result = await planner.planState({});
    assert.equal(result.routineBackend, "deepseek");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("local planner failure falls back once to DeepSeek and enters a short cooldown", async () => {
  const fixture = temporaryFile("backend.json");
  try {
    const controller = new RoutineBackendController({ statePath: fixture.file, defaultMode: "local", localFailureCooldownMs: 60_000 });
    let localCalls = 0;
    let deepseekCalls = 0;
    const planner = new DynamicRoutinePlanner({
      controller,
      localPlanner: {
        config: { provider: "ollama-chat" },
        async planState() { localCalls += 1; throw new Error("offline"); },
      },
      deepseekPlanner: {
        config: { provider: "deepseek-chat" },
        async planState() { deepseekCalls += 1; return { plan: { ok: true } }; },
      },
    });
    const first = await planner.planState({ previousError: "" });
    const second = await planner.planState({ previousError: "" });
    assert.equal(first.routineBackendFallback, "offline");
    assert.equal(second.routineBackend, "deepseek");
    assert.equal(localCalls, 1);
    assert.equal(deepseekCalls, 2);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("candidate ranking falls back from a malformed local response to DeepSeek", async () => {
  const fixture = temporaryFile("backend.json");
  try {
    const controller = new RoutineBackendController({ statePath: fixture.file, defaultMode: "local", localFailureCooldownMs: 60_000 });
    let deepseekCalls = 0;
    const planner = new DynamicRoutinePlanner({
      controller,
      localPlanner: {
        config: { provider: "ollama-chat" },
        async rankCandidate() { throw new Error("unknown candidate id"); },
      },
      deepseekPlanner: {
        config: { provider: "deepseek-chat" },
        async rankCandidate() {
          deepseekCalls += 1;
          return { candidateId: "play:0,1", reason: "validated", usage: { totalTokens: 10 }, attempts: [] };
        },
      },
    });
    const result = await planner.rankCandidate({});
    assert.equal(result.candidateId, "play:0,1");
    assert.equal(result.routineBackend, "deepseek");
    assert.equal(result.routineBackendFallback, "unknown candidate id");
    assert.equal(deepseekCalls, 1);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a running controller observes dashboard mode changes without restarting", () => {
  const fixture = temporaryFile("backend.json");
  try {
    const runner = new RoutineBackendController({ statePath: fixture.file, defaultMode: "local" });
    const dashboard = new RoutineBackendController({ statePath: fixture.file, defaultMode: "local" });
    assert.equal(runner.read().mode, "local");
    dashboard.setMode("deepseek", { updatedBy: "test-dashboard" });
    assert.equal(runner.read().mode, "deepseek");
    dashboard.setMode("local", { updatedBy: "test-dashboard" });
    assert.equal(runner.read().mode, "local");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("strategic checkpoints and the single-run plan survive a controller restart", () => {
  const fixture = temporaryFile("checkpoints.json");
  try {
    const first = new StrategicCheckpointStore({ filePath: fixture.file });
    first.mark("SEED", "SEED:hand:3:9", { buildGoal: "pair economy" });
    const second = new StrategicCheckpointStore({ filePath: fixture.file });
    assert.equal(second.has("SEED", "SEED:hand:3:9"), true);
    assert.deepEqual(second.runPlan("SEED"), { buildGoal: "pair economy" });
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
