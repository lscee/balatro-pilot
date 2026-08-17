import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createDashboardServer } from "../src/dashboard-server.mjs";
import { DashboardStats } from "../src/dashboard-stats.mjs";

function compactState(seed, {
  state = "SELECTING_HAND",
  ante = 1,
  round = 1,
  score = 0,
  won = false,
  money = 4,
} = {}) {
  return {
    state,
    ante,
    roundNumber: round,
    money,
    won,
    seed,
    round: {
      chips: score,
      handsLeft: 4,
      handsPlayed: 0,
      discardsLeft: 3,
      discardsUsed: 0,
    },
    blinds: {
      small: {
        type: "SMALL",
        status: state === "ROUND_EVAL" ? "DEFEATED" : "CURRENT",
        name: "Small Blind",
        score: 300,
      },
    },
    jokers: { count: 1, cards: [{ key: "j_banner", label: "Banner" }] },
  };
}

function event(at, type, data = {}) {
  return JSON.stringify({ at, type, ...data });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-dashboard-"));
  const dashboard = path.join(root, "dashboard");
  fs.mkdirSync(dashboard, { recursive: true });
  fs.writeFileSync(path.join(dashboard, "index.html"), "<!doctype html><title>test</title>");
  fs.writeFileSync(path.join(dashboard, "app.js"), "");
  fs.writeFileSync(path.join(dashboard, "styles.css"), "");
  const writeRun = (name, lines) => {
    const directory = path.join(root, "runs", name);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "events.ndjson");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };
  const firstFile = writeRun("2026-08-01T00-00-00-000Z-bot-run", [
    event("2026-08-01T00:00:00.000Z", "semantic_episode_started", { episodeId: "episode-1" }),
    event("2026-08-01T00:00:01.000Z", "bot_state", { state: compactState("SEED1") }),
    event("2026-08-01T00:00:02.000Z", "bot_strategy_mode", { strategic: true }),
    event("2026-08-01T00:00:03.000Z", "plan", {
      planningMs: 12_000,
      usage: { apiCalls: 2, inputTokens: 1000, cachedInputTokens: 700, outputTokens: 200, totalTokens: 1200 },
    }),
    event("2026-08-01T00:00:04.000Z", "rpc_execute", { method: "play" }),
    event("2026-08-01T00:00:05.000Z", "bot_state", {
      state: compactState("SEED1", { state: "ROUND_EVAL", score: 300 }),
    }),
    event("2026-08-01T00:00:06.000Z", "bot_state", {
      state: compactState("SEED1", { state: "GAME_OVER", score: 300, won: false }),
    }),
    event("2026-08-01T00:00:07.000Z", "semantic_episode_completed", {
      episodeId: "episode-1",
      outcome: "lost",
      transitions: 3,
    }),
  ]);
  writeRun("2026-08-02T00-00-00-000Z-bot-run", [
    event("2026-08-02T00:00:00.000Z", "semantic_episode_resumed", {
      episodeId: "episode-2",
      previousRunId: "previous-controller",
    }),
    event("2026-08-02T00:00:01.000Z", "bot_state", {
      state: compactState("SEED2", { ante: 2, round: 4 }),
    }),
    event("2026-08-02T00:00:02.000Z", "bot_strategy_mode", { strategic: false }),
    event("2026-08-02T00:00:02.100Z", "semantic_retrieval", {
      candidates: 2,
      injected: 1,
      decisionPrior: { evidence: 4, matchedCandidates: 2, appliedCandidates: 1 },
    }),
    event("2026-08-02T00:00:02.200Z", "semantic_prior_decision", {
      available: true,
      applied: true,
      influenced: true,
    }),
    event("2026-08-02T00:00:03.000Z", "plan", {
      planningMs: 3_000,
      usage: { apiCalls: 1, inputTokens: 900, cachedInputTokens: 800, outputTokens: 100, totalTokens: 1000 },
    }),
    event("2026-08-02T00:00:04.000Z", "rpc_execute", { method: "discard" }),
    event("2026-08-02T00:00:05.000Z", "rpc_execute", { method: "play" }),
    event("2026-08-02T00:00:05.100Z", "bot_score_prediction", {
      step: 8,
      conservativeScore: 100_000,
      chips: 250,
      mult: 40,
      xMult: 12,
      knownRetriggers: 3,
      predictedEngineReady: true,
    }),
    event("2026-08-02T00:00:05.200Z", "bot_score_result", { step: 8, actual: 110_000 }),
    event("2026-08-02T00:00:06.000Z", "bot_state", {
      state: compactState("SEED2", { state: "ROUND_EVAL", ante: 8, round: 24, score: 100_000, won: true, money: 14 }),
    }),
    event("2026-08-02T00:00:07.000Z", "bot_state", {
      state: compactState("SEED2", { state: "GAME_OVER", ante: 9, round: 25, score: 900, won: true, money: 14 }),
    }),
    event("2026-08-02T00:00:08.000Z", "semantic_episode_completed", {
      episodeId: "episode-2",
      outcome: "won",
      transitions: 4,
    }),
  ]);
  return { root, firstFile };
}

test("DashboardStats aggregates exact games, outcomes, score deltas, actions, and model usage", () => {
  const fixture = createFixture();
  try {
    const tracker = new DashboardStats(fixture.root);
    const stats = tracker.refresh();
    assert.equal(stats.overview.exactGames, 2);
    assert.equal(stats.overview.completedGames, 2);
    assert.equal(stats.overview.wins, 1);
    assert.equal(stats.overview.winRate, 0.5);
    assert.equal(stats.overview.highestScore, 100_000);
    assert.equal(stats.overview.highestHandScore, 110_000);
    assert.equal(stats.highScore.milestones.hundredThousand.games, 1);
    assert.equal(stats.highScore.milestones.million.games, 0);
    assert.equal(stats.highScore.peakPredictedXMult, 12);
    assert.equal(stats.highScore.peakKnownRetriggers, 3);
    assert.equal(stats.highScore.buildReadyRate, 0.5);
    assert.equal(stats.overview.highestAnte, 9);
    assert.equal(stats.overview.highestRound, 25);
    assert.equal(stats.overview.blindsCleared, 2);
    assert.equal(stats.gameplay.actions.play, 2);
    assert.equal(stats.gameplay.actions.discard, 1);
    assert.equal(stats.model.usage.apiCalls, 3);
    assert.equal(stats.model.cacheRate, 1500 / 1900);
    assert.equal(stats.model.medianPlanningMs, 7500);
    assert.equal(stats.learning.retrieval.requests, 1);
    assert.equal(stats.learning.retrieval.hitRate, 1);
    assert.equal(stats.learning.retrieval.injectionRate, 1);
    assert.equal(stats.learning.actionInfluence.applied, 1);
    assert.equal(stats.learning.actionInfluence.influenceRate, 1);
    assert.equal(stats.learning.episodeStitching.resumed, 1);
    assert.equal(stats.learning.durable.available, false);
    assert.equal(stats.live.gameId, "SEED2");
    assert.equal(stats.live.state, "GAME_OVER");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DashboardStats reads only appended event bytes without duplicating old metrics", () => {
  const fixture = createFixture();
  try {
    const tracker = new DashboardStats(fixture.root);
    const before = tracker.refresh();
    fs.appendFileSync(
      fixture.firstFile,
      event("2026-08-01T00:00:08.000Z", "bot_planner_fallback", {}) + "\n",
    );
    const after = tracker.refresh();
    assert.equal(after.coverage.totalEvents, before.coverage.totalEvents + 1);
    assert.equal(after.model.usage.apiCalls, before.model.usage.apiCalls);
    assert.equal(after.model.fallbacks, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DashboardStats streams an event file larger than one read chunk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-dashboard-chunked-"));
  try {
    const directory = path.join(root, "runs", "2026-08-02T00-00-00-000Z-bot-run");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "events.ndjson"), [
      event("2026-08-02T00:00:00.000Z", "diagnostic_payload", {
        payload: "x".repeat(1024 * 1024 + 257),
      }),
      event("2026-08-02T00:00:01.000Z", "bot_state", {
        state: compactState("CHUNKED", { ante: 3, round: 8 }),
      }),
    ].join("\n") + "\n");

    const stats = new DashboardStats(root).refresh();
    assert.equal(stats.coverage.totalEvents, 2);
    assert.equal(stats.coverage.malformedLines, 0);
    assert.equal(stats.live.gameId, "CHUNKED");
    assert.equal(stats.live.ante, 3);
    assert.equal(stats.live.round, 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DashboardStats records a repeated seed as a new attempt after the previous game ended", () => {
  const fixture = createFixture();
  try {
    const tracker = new DashboardStats(fixture.root);
    tracker.refresh();
    const directory = path.join(fixture.root, "runs", "2026-08-03T00-00-00-000Z-bot-run");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "events.ndjson"), [
      event("2026-08-03T00:00:00.000Z", "semantic_episode_started", { episodeId: "episode-3" }),
      event("2026-08-03T00:00:01.000Z", "bot_state", { state: compactState("SEED1") }),
    ].join("\n") + "\n");

    const stats = tracker.refresh();
    assert.equal(stats.overview.exactGames, 3);
    assert.equal(stats.overview.completedGames, 2);
    assert.equal(stats.overview.ongoingGames, 1);
    assert.equal(stats.overview.interruptedGames, 0);
    assert.equal(stats.live.gameId, "SEED1#2");
    assert.equal(stats.recentGames[0].seed, "SEED1");
    assert.equal(stats.recentGames[0].outcome, "ongoing");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DashboardStats keeps a post-finalization win overlay in the completed attempt", () => {
  const fixture = createFixture();
  try {
    const directory = path.join(fixture.root, "runs", "2026-08-03T00-00-00-000Z-bot-run");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "events.ndjson"), [
      event("2026-08-03T00:00:00.000Z", "semantic_episode_started", { episodeId: "episode-menu-win" }),
      event("2026-08-03T00:00:01.000Z", "bot_state", {
        state: compactState("MENU-WIN", { ante: 8, round: 24 }),
      }),
      event("2026-08-03T00:00:02.000Z", "semantic_episode_completed", {
        episodeId: "episode-menu-win",
        outcome: "won",
        transitions: 12,
      }),
      event("2026-08-03T00:00:03.000Z", "bot_state", {
        state: compactState("MENU-WIN", {
          state: "ROUND_EVAL",
          ante: 8,
          round: 24,
          score: 100_000,
          won: true,
        }),
      }),
    ].join("\n") + "\n");

    const tracker = new DashboardStats(fixture.root);
    const stats = tracker.refresh();
    const games = stats.recentGames.filter((game) => game.seed === "MENU-WIN");
    assert.equal(games.length, 1);
    assert.equal(games[0].outcome, "won");
    assert.equal(stats.overview.ongoingGames, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DashboardStats merges time-overlapping controller logs for the same seed", () => {
  const fixture = createFixture();
  try {
    const tracker = new DashboardStats(fixture.root);
    tracker.refresh();
    const directory = path.join(fixture.root, "runs", "2026-08-04T00-00-00-000Z-bot-run");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "events.ndjson"), [
      event("2026-08-01T00:00:03.500Z", "bot_state", {
        state: compactState("SEED1", { score: 100 }),
      }),
    ].join("\n") + "\n");

    const stats = tracker.refresh();
    assert.equal(stats.overview.exactGames, 2);
    assert.equal(stats.overview.completedGames, 2);
    assert.equal(stats.overview.interruptedGames, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard server exposes loopback-ready health, stats, and static page endpoints", async () => {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.root, "config.json"), JSON.stringify({
    semanticRagDatabasePath: "custom-data/learning.sqlite",
    semanticPriorMinimumEpisodes: 5,
    semanticPriorConfidenceZ: 1.64,
  }));
  const componentHealth = {
    async refresh() {
      return { ok: true, overall: { status: "healthy" }, components: [{ id: "dashboard", status: "healthy" }] };
    },
  };
  const server = createDashboardServer({ projectRoot: fixture.root, componentHealth });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const get = (pathname) => new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:" + address.port + pathname, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body, headers: response.headers }));
    }).on("error", reject);
  });
  try {
    const health = await get("/api/health");
    const components = await get("/api/components");
    const stats = await get("/api/stats");
    const page = await get("/");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    assert.equal(components.status, 200);
    assert.equal(JSON.parse(components.body).components[0].id, "dashboard");
    assert.equal(components.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(stats.body).overview.highestScore, 100_000);
    assert.equal(
      JSON.parse(stats.body).learning.durable.databasePath,
      path.resolve(fixture.root, "custom-data/learning.sqlite"),
    );
    assert.equal(stats.headers["cache-control"], "no-store");
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>test<\/title>/);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard exposes revision-aware pilot status and operations", async () => {
  const fixture = createFixture();
  const calls = [];
  const running = {
    desiredState: "running",
    effectiveState: "running",
    revision: 4,
    controllerPid: 102,
  };
  const pilotControl = {
    async status() { calls.push(["status"]); return running; },
    async operate(action, options) {
      calls.push([action, options]);
      return { ...running, desiredState: "paused", effectiveState: "paused", revision: 5, controllerPid: null };
    },
  };
  let invalidations = 0;
  const componentHealth = {
    invalidate() { invalidations += 1; },
    async refresh() { return { ok: true, components: [] }; },
  };
  const server = createDashboardServer({ projectRoot: fixture.root, pilotControl, componentHealth });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const getResponse = await fetch(`http://127.0.0.1:${address.port}/api/pilot-control`);
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).controllerPid, 102);
    const postResponse = await fetch(`http://127.0.0.1:${address.port}/api/pilot-control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause", expectedRevision: 4 }),
    });
    assert.equal(postResponse.status, 200);
    assert.equal((await postResponse.json()).effectiveState, "paused");
    assert.deepEqual(calls, [["status"], ["pause", { expectedRevision: 4 }]]);
    assert.equal(invalidations, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard switches the routine backend and unloads the local model for DeepSeek", async () => {
  const fixture = createFixture();
  const calls = [];
  const routineBackend = {
    async status() { return { mode: "local", effective: "local", ollama: { reachable: true, loaded: true } }; },
    setMode(mode) { calls.push(["mode", mode]); return { mode, updatedAt: "now", updatedBy: "dashboard" }; },
    async loadLocalModel() { calls.push(["load"]); return { reachable: true, loaded: true }; },
    async unloadLocalModel() { calls.push(["unload"]); return { reachable: true, loaded: false }; },
    async ollamaStatus() { return { reachable: true, loaded: false }; },
  };
  const server = createDashboardServer({ projectRoot: fixture.root, routineBackend });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const getStatus = await fetch(`http://127.0.0.1:${address.port}/api/routine-backend`).then((response) => response.json());
    assert.equal(getStatus.mode, "local");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/routine-backend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "deepseek" }),
    });
    const switched = await response.json();
    assert.equal(switched.mode, "deepseek");
    assert.equal(switched.effective, "deepseek");
    assert.deepEqual(calls, [["mode", "deepseek"], ["unload"]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard switches the strategic backend between Kimi and DeepSeek without a paid probe", async () => {
  const fixture = createFixture();
  const calls = [];
  let mode = "kimi";
  const strategicBackend = {
    status() {
      return {
        mode,
        effective: mode,
        provider: mode === "kimi" ? "kimi-chat" : "deepseek-chat",
        model: mode === "kimi" ? "k3-256k" : "deepseek-v4-flash",
      };
    },
    setMode(nextMode) {
      calls.push(nextMode);
      mode = nextMode;
      return { mode, updatedAt: "now", updatedBy: "dashboard" };
    },
  };
  const server = createDashboardServer({ projectRoot: fixture.root, strategicBackend });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const before = await fetch(`http://127.0.0.1:${address.port}/api/strategic-backend`).then((response) => response.json());
    assert.equal(before.mode, "kimi");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/strategic-backend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "deepseek" }),
    });
    const after = await response.json();
    assert.equal(response.status, 200);
    assert.equal(after.mode, "deepseek");
    assert.equal(after.provider, "deepseek-chat");
    assert.deepEqual(calls, ["deepseek"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
