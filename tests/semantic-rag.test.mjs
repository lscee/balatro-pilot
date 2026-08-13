import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SemanticRagStore } from "../src/semantic-rag.mjs";
import { semanticDiscountedReturns, semanticStateFeatures } from "../src/semantic-experience.mjs";

function card(key) {
  const [suit, rank] = key.split("_");
  return { key, set: "DEFAULT", label: key, value: { suit, rank }, modifier: {}, state: {}, cost: { buy: 1, sell: 1 } };
}

function state(overrides = {}) {
  const handCards = [card("H_A"), card("S_A"), card("C_2")];
  return {
    state: "SELECTING_HAND",
    seed: "semantic-test",
    deck: "RED",
    stake: "WHITE",
    ante_num: 2,
    round_num: 4,
    money: 8,
    won: false,
    round: { chips: 100, hands_left: 3, discards_left: 2, reroll_cost: 5 },
    blinds: { small: { type: "SMALL", status: "CURRENT", name: "Small Blind", score: 600 } },
    hand: { count: 3, limit: 8, highlighted_limit: 5, cards: handCards },
    cards: { count: 20, limit: 52, cards: handCards },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    ...overrides,
  };
}

function config(databasePath) {
  return {
    semanticRagEnabled: true,
    semanticRagDatabasePath: databasePath,
    semanticRagTopK: 3,
    semanticRagHotLimit: 100,
    semanticRagSearchBudgetMs: 40,
    semanticRagMinimumSimilarity: 0.7,
    semanticRagMaxContextChars: 2_000,
    semanticRagMinimumSamples: 1,
    semanticFastPathEnabled: true,
    semanticFastPathMinimumSamples: 1,
    semanticFastPathMinimumWinningEpisodes: 2,
    semanticFastPathMinimumAverageReturn: 0,
    semanticFastPathMinimumPositiveRate: 0.5,
    semanticEpisodeDiscount: 0.97,
  };
}

test("semantic RAG learns only after terminal outcomes and fast replay requires independent wins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-"));
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const before = state();
    const after = state({ round: { chips: 400, hands_left: 2, discards_left: 2, reroll_cost: 5 } });
    const action = { method: "play", params: { cards: [0, 1] }, reason: "play pair" };
    store.beginEpisode({ episodeId: "episode-1", runId: "run-1", state: before });
    const recorded = store.recordTransition({
      runId: "run-1",
      episodeId: "episode-1",
      step: 1,
      state: before,
      action,
      nextState: after,
      source: "balatrobot_model",
      plan: {
        strategy: "pair plan",
        memory: "pair build",
        runPlan: {
          metaAssessment: "weak early bridge",
          economyPolicy: "save an interest band",
          pivotPolicy: "pivot for supported scaling",
        },
      },
      usage: { totalTokens: 120 },
    });
    assert.ok(recorded.immediateReward > 0);
    assert.equal(store.retrieve(before).items.length, 0);

    const finalized = store.finalizeEpisode("episode-1", "won", { ...after, won: true, ante_num: 9 });
    assert.equal(finalized.transitions, 1);
    const priorDelta = store.rewardEvidenceForCreditEpisode("episode-1", { includeFeatures: false });
    assert.equal(priorDelta.length, 1);
    assert.equal(priorDelta[0].episodeId, "episode-1");
    assert.equal(priorDelta[0].trajectoryEpisodeId, "episode-1");
    assert.equal(typeof priorDelta[0].decisionKey, "string");
    assert.equal(typeof priorDelta[0].actionKey, "string");
    assert.equal("features" in priorDelta[0], false);
    assert.deepEqual(store.rewardEvidenceForCreditEpisode("missing"), []);
    let retrieval = store.retrieve(before);
    assert.equal(retrieval.items.length, 1);
    assert.equal(retrieval.items[0].actionMethod, "play");
    assert.match(store.formatContext(retrieval), /Local semantic experience/);
    assert.match(store.formatContext(retrieval), /weak early bridge/);
    assert.match(store.formatContext(retrieval), /pivot for supported scaling/);
    assert.equal(store.chooseFastAction(retrieval), null);

    store.beginEpisode({ episodeId: "episode-1b", runId: "run-1b", state: before });
    store.recordTransition({
      runId: "run-1b",
      episodeId: "episode-1b",
      step: 1,
      state: before,
      action,
      nextState: after,
      source: "balatrobot_model",
      plan: { strategy: "pair plan", memory: "pair build" },
      usage: { totalTokens: 100 },
    });
    store.finalizeEpisode("episode-1b", "won", { ...after, won: true, ante_num: 9 });
    retrieval = store.retrieve(before);
    assert.deepEqual(store.chooseFastAction(retrieval).action.params.cards, [0, 1]);
    assert.equal(store.stats().learnedTransitions, 2);
    assert.equal(store.stats().policyVersion, 5);
    assert.equal(store.stats().positiveLossTransitions, 0);
    assert.equal(store.stats().tenThousandEpisodes, 0);
    assert.equal(store.topActions(1)[0].method, "play");
    assert.deepEqual(store.deckPerformance("WHITE"), [{
      deck: "RED",
      trials: 2,
      wins: 2,
      averageAnte: 9,
      averageRound: 4,
    }]);
    assert.deepEqual(store.deckPerformance("GOLD"), []);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("semantic RAG records the measured single-hand peak and milestone boundaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-peak-"));
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const before = state();
    const after = state({ round: { ...before.round, chips: 600_100 } });
    store.beginEpisode({ episodeId: "peak-1", runId: "peak-run", state: before });
    store.recordTransition({
      runId: "peak-run", episodeId: "peak-1", step: 1, state: before,
      action: { method: "play", params: { cards: [0, 1] } }, nextState: after,
      source: "balatrobot_model", plan: {}, usage: {}, handScore: 600_000,
    });
    store.recordTransition({
      runId: "peak-run", episodeId: "peak-1", step: 2, state: after,
      action: { method: "play", params: { cards: [0, 1] } },
      nextState: state({ round: { ...before.round, chips: 1_200_100 } }),
      source: "balatrobot_model", plan: {}, usage: {}, handScore: 600_000,
    });
    const finalized = store.finalizeEpisode("peak-1", "lost", { ...after, state: "GAME_OVER", ante_num: 8 });
    assert.equal(finalized.maxHandScore, 600_000);
    assert.equal(finalized.highScoreTier, "hundred_thousand");
    assert.equal(store.stats().tenThousandEpisodes, 1);
    assert.equal(store.stats().hundredThousandEpisodes, 1);
    assert.equal(store.stats().millionEpisodes, 0);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("losing episodes are useful negative context but can never enter the fast path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-loss-"));
  let store;
  try {
    const lossConfig = { ...config("data/semantic.sqlite"), semanticFastPathMinimumWinningEpisodes: 1 };
    store = new SemanticRagStore(root, lossConfig);
    const before = state();
    const after = state({ round: { chips: 400, hands_left: 2, discards_left: 2, reroll_cost: 5 } });
    const action = { method: "play", params: { cards: [0, 1] }, reason: "lost pair line" };
    store.beginEpisode({ episodeId: "loss-1", runId: "loss-run", state: before });
    store.recordTransition({
      runId: "loss-run",
      episodeId: "loss-1",
      step: 1,
      state: before,
      action,
      nextState: after,
      source: "balatrobot_model",
      plan: {},
      usage: {},
    });
    store.finalizeEpisode("loss-1", "lost", { ...after, state: "GAME_OVER", ante_num: 3 });
    const retrieval = store.retrieve(before);
    assert.equal(retrieval.items[0].winningEpisodes, 0);
    assert.equal(retrieval.items[0].losingEpisodes, 1);
    assert.ok(retrieval.items[0].averageReturn < 0);
    assert.match(store.formatContext(retrieval), /avoid or reconsider/);
    assert.equal(store.chooseFastAction(retrieval), null);
    assert.equal(store.stats().positiveLossTransitions, 0);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted semantic episodes never enter retrieval", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-interrupted-"));
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const before = state();
    const after = state({ money: 9 });
    store.beginEpisode({ episodeId: "episode-2", runId: "run-2", state: before });
    store.recordTransition({
      runId: "run-2",
      episodeId: "episode-2",
      step: 1,
      state: before,
      action: { method: "play", params: { cards: [0] } },
      nextState: after,
      source: "balatrobot_planner_fallback",
      plan: {},
      usage: {},
    });
    store.markEpisodeInterrupted("episode-2");
    assert.equal(store.retrieve(before).items.length, 0);
    assert.equal(store.stats().learnedTransitions, 0);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reward migration relabels legacy trajectories idempotently without overwriting raw rewards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-migrate-"));
  const databasePath = path.join(root, "data", "semantic.sqlite");
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const before = state();
    const after = state({ round: { ...before.round, chips: 500 } });
    store.beginEpisode({ episodeId: "legacy-loss", runId: "legacy-run", state: before });
    store.recordTransition({
      runId: "legacy-run", episodeId: "legacy-loss", step: 1, state: before,
      action: { method: "play", params: { cards: [0, 1] } }, nextState: after,
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.finalizeEpisode("legacy-loss", "lost", { ...after, state: "GAME_OVER", ante_num: 2 });
    store.close();
    store = null;

    const db = new DatabaseSync(databasePath);
    const rawBefore = db.prepare("SELECT immediate_reward, return_reward, features_json FROM semantic_experiences LIMIT 1").get();
    const legacyFeatures = JSON.parse(rawBefore.features_json);
    legacyFeatures.version = 1;
    delete legacyFeatures.strategy;
    delete legacyFeatures.collectionSignature;
    delete legacyFeatures.appearedJokers;
    const legacyNext = structuredClone(legacyFeatures);
    legacyNext.round.score = 500;
    db.prepare(`
      UPDATE semantic_experiences SET policy_version=1, features_json=?, next_features_json=?,
        immediate_reward=777, return_reward=888
    `).run(JSON.stringify(legacyFeatures), JSON.stringify(legacyNext));
    db.prepare("DELETE FROM semantic_reward_labels").run();
    db.prepare("DELETE FROM semantic_reward_migrations").run();
    db.close();

    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const migration = store.rewardMigrationStatus();
    assert.equal(migration.transitions, 1);
    assert.equal(migration.semanticTransitions, 1);
    assert.equal(migration.rawTrajectoriesImmutable, true);
    assert.equal(store.stats().positiveLossTransitions, 0);
    const first = store.migrateRewards();
    assert.equal(first.changed, false);
    assert.equal(first.transitions, 1);
    const rawAfter = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      { ...rawAfter.prepare("SELECT policy_version, immediate_reward, return_reward FROM semantic_experiences LIMIT 1").get() },
      { policy_version: 1, immediate_reward: 777, return_reward: 888 },
    );
    rawAfter.close();
    const retrieval = store.retrieve(before);
    assert.equal(retrieval.evidence.length, 1);
    assert.equal(retrieval.evidence[0].outcome, "lost");
    assert.ok(retrieval.evidence[0].returnReward < 0);
    const allEvidence = store.allRewardEvidence();
    assert.equal(allEvidence.length, 1);
    assert.equal(allEvidence[0].trajectoryPolicyVersion, 1);
    assert.equal(allEvidence[0].compatibility, "semantic");
    store.close();
    store = null;
    // Windows may keep SQLite WAL/SHM handles alive until the next turn of the
    // event loop; retaining the path is harmless and avoids a flaky EPERM in
    // this migration-only fixture cleanup.
  } finally {
    store?.close();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }
  }
});

test("resumeEpisode atomically resumes only a non-regressing matching interrupted run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-resume-"));
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const before = state({ seed: "resume-seed", ante_num: 3, round_num: 7 });
    const after = state({ seed: "resume-seed", ante_num: 3, round_num: 8 });
    store.beginEpisode({ episodeId: "resume-me", runId: "old-run", state: before });
    store.recordTransition({
      runId: "old-run", episodeId: "resume-me", step: 1, state: before,
      action: { method: "play", params: { cards: [0, 1] } }, nextState: after,
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.markEpisodeInterrupted("resume-me");
    assert.equal(store.resumeEpisode({ runId: "too-early", state: { ...before, round_num: 6 } }), null);
    assert.equal(store.resumeEpisode({ runId: "wrong-money", state: { ...after, money: 99 } }), null);
    const resumed = store.resumeEpisode({ runId: "new-run", state: after });
    assert.equal(resumed.episodeId, "resume-me");
    assert.equal(resumed.previousRunId, "old-run");
    assert.equal(store.resumeEpisode({ runId: "again", state: after }), null);

    const expiredStart = state({ seed: "expired-seed", ante_num: 3, round_num: 7 });
    const expiredEnd = state({ seed: "expired-seed", ante_num: 3, round_num: 8 });
    store.beginEpisode({ episodeId: "expired", runId: "expired-old", state: expiredStart });
    store.recordTransition({
      runId: "expired-old", episodeId: "expired", step: 1, state: expiredStart,
      action: { method: "play", params: { cards: [0, 1] } }, nextState: expiredEnd,
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.markEpisodeInterrupted("expired");
    const db = new DatabaseSync(path.join(root, "data", "semantic.sqlite"));
    db.prepare("UPDATE semantic_episodes SET ended_at='2020-01-01T00:00:00.000Z' WHERE episode_id='expired'").run();
    db.close();
    assert.equal(store.resumeEpisode({ runId: "expired-new", state: expiredEnd }), null);

    const replayStart = state({ seed: "fixed-seed", ante_num: 1, round_num: 0 });
    const replayEnd = state({ seed: "fixed-seed", ante_num: 1, round_num: 1 });
    store.beginEpisode({ episodeId: "fixed-attempt", runId: "fixed-old", state: replayStart });
    store.recordTransition({
      runId: "fixed-old", episodeId: "fixed-attempt", step: 1, state: replayStart,
      action: { method: "select", params: {} }, nextState: replayEnd,
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.markEpisodeInterrupted("fixed-attempt");
    assert.equal(store.resumeEpisode({ runId: "fixed-replay", state: replayEnd }), null);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reward migration corrects an unproven legacy Ante-8 win without mutating its raw outcome", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-false-win-"));
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const before = state({ ante_num: 8, round_num: 24 });
    const failedBoss = state({
      state: "GAME_OVER", ante_num: 8, round_num: 24, won: true,
      round: { ...before.round, chips: 2_922 },
      blinds: { boss: { type: "BOSS", status: "CURRENT", name: "Boss", score: 100_000 } },
    });
    store.beginEpisode({ episodeId: "false-win", runId: "legacy", state: before });
    store.recordTransition({
      runId: "legacy", episodeId: "false-win", step: 1, state: before,
      action: { method: "play", params: { cards: [0, 1] } }, nextState: failedBoss,
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.finalizeEpisode("false-win", "won", failedBoss);
    const migration = store.rewardMigrationStatus();
    assert.equal(migration.correctedOutcomes, 1);
    assert.equal(store.allRewardEvidence()[0].outcome, "lost");
    assert.ok(store.allRewardEvidence()[0].returnReward < 0);
    const raw = new DatabaseSync(path.join(root, "data", "semantic.sqlite"), { readOnly: true });
    assert.equal(raw.prepare("SELECT outcome FROM semantic_episodes WHERE episode_id='false-win'").get().outcome, "won");
    raw.close();
    store.close();
    store = null;
  } finally {
    store?.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }
  }
});

test("reward migration links a conservative interrupted segment to one completed terminal episode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-link-"));
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const pokerHandsBeforeRestart = {
      "Two Pair": { level: 4, chips: 80, mult: 5, played: 20 },
      Flush: { level: 3, chips: 65, mult: 8, played: 10 },
    };
    const pokerHandsAfterRestart = {
      "Two Pair": { level: 4, chips: 80, mult: 5, played: 19 },
      Flush: { level: 3, chips: 65, mult: 8, played: 10 },
    };
    const boundary = state({
      seed: "linked-seed", ante_num: 6, round_num: 17,
      hands: pokerHandsBeforeRestart,
    });
    const sharedJokers = { count: 1, limit: 5, cards: [card("j_joker")] };
    const segmentStart = { ...boundary, round_num: 16, jokers: sharedJokers };
    const segmentEnd = { ...boundary, jokers: sharedJokers };
    const restartedBoundary = { ...segmentEnd, hands: pokerHandsAfterRestart };
    store.beginEpisode({ episodeId: "front", runId: "front-run", state: segmentStart });
    store.recordTransition({
      runId: "front-run", episodeId: "front", step: 1, state: segmentStart,
      action: { method: "play", params: { cards: [0, 1] } }, nextState: segmentEnd,
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.markEpisodeInterrupted("front");
    store.beginEpisode({ episodeId: "terminal", runId: "terminal-run", state: restartedBoundary });
    store.recordTransition({
      runId: "terminal-run", episodeId: "terminal", step: 1, state: restartedBoundary,
      action: { method: "play", params: { cards: [0, 1] } },
      nextState: { ...restartedBoundary, ante_num: 9, round_num: 25, state: "GAME_OVER", won: true },
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.finalizeEpisode("terminal", "won", { ...restartedBoundary, ante_num: 9, round_num: 25, state: "GAME_OVER" });
    // Make the synthetic restart gap explicit and deterministic.
    const db = new DatabaseSync(path.join(root, "data", "semantic.sqlite"));
    db.prepare("UPDATE semantic_episodes SET ended_at=? WHERE episode_id='front'").run("2026-08-01T00:30:00.000Z");
    db.prepare("UPDATE semantic_episodes SET started_at=? WHERE episode_id='terminal'").run("2026-08-01T01:00:00.000Z");
    db.prepare("UPDATE semantic_episodes SET max_hand_score=100565 WHERE episode_id='front'").run();
    db.prepare("UPDATE semantic_episodes SET max_hand_score=53955 WHERE episode_id='terminal'").run();
    const rawEpisodesBefore = db.prepare("SELECT * FROM semantic_episodes ORDER BY episode_id").all();
    const rawTransitionsBefore = db.prepare("SELECT * FROM semantic_experiences ORDER BY id").all();
    db.prepare("DELETE FROM semantic_reward_labels").run();
    db.prepare("DELETE FROM semantic_reward_migrations").run();
    db.close();
    store.close();
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    assert.equal(store.rewardMigrationStatus().linkedSegments, 1);
    assert.equal(store.rewardMigrationStatus().linkedTransitions, 1);
    const linked = store.allRewardEvidence().find((item) => item.trajectoryEpisodeId === "front");
    const terminal = store.allRewardEvidence().find((item) => item.trajectoryEpisodeId === "terminal");
    assert.equal(linked.episodeId, "terminal");
    assert.equal(linked.outcome, "won");
    assert.ok(linked.returnReward > 0);
    const rewardDb = new DatabaseSync(path.join(root, "data", "semantic.sqlite"), { readOnly: true });
    const rawImmediate = rewardDb.prepare(`
      SELECT e.episode_id, labels.immediate_reward
      FROM semantic_reward_labels labels
      JOIN semantic_experiences e ON e.id = labels.experience_id
      WHERE labels.reward_version = 6 AND labels.credit_episode_id = 'terminal'
      ORDER BY CASE e.episode_id WHEN 'front' THEN 0 ELSE 1 END, e.id
    `).all();
    rewardDb.close();
    const expectedCombinedReturns = semanticDiscountedReturns(rawImmediate.map((row, index) => ({
      id: index + 1,
      immediateReward: Number(row.immediate_reward) || 0,
    })), "won", { ante_num: 9, trainingMaxHandScore: 100565 }, 0.97);
    const firstFrontIndex = rawImmediate.findIndex((row) => row.episode_id === "front") + 1;
    const firstTerminalIndex = rawImmediate.findIndex((row) => row.episode_id === "terminal") + 1;
    assert.equal(linked.returnReward, expectedCombinedReturns.get(firstFrontIndex), JSON.stringify({
      rawImmediate, firstFrontIndex, firstTerminalIndex,
      expected: [...expectedCombinedReturns], linked, terminal,
    }));
    assert.equal(terminal.returnReward, expectedCombinedReturns.get(firstTerminalIndex));
    // The prefix peak, not the lower tail peak, is included in the one combined
    // terminal calculation above; it is not awarded as a second terminal.
    const raw = new DatabaseSync(path.join(root, "data", "semantic.sqlite"), { readOnly: true });
    assert.equal(raw.prepare("SELECT outcome FROM semantic_episodes WHERE episode_id='front'").get().outcome, "interrupted");
    assert.deepEqual(raw.prepare("SELECT * FROM semantic_episodes ORDER BY episode_id").all(), rawEpisodesBefore);
    assert.deepEqual(raw.prepare("SELECT * FROM semantic_experiences ORDER BY id").all(), rawTransitionsBefore);
    raw.close();
    assert.equal(store.migrateRewards().changed, false);
    store.close();
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    assert.equal(store.rewardMigrationStatus().changed, false);
    const retrieval = store.retrieve(segmentStart);
    const matchingGroup = retrieval.groups.find((group) => group.actionMethod === "play");
    assert.equal(matchingGroup.samples, 1);
    assert.equal(matchingGroup.winningEpisodes, 1);
  } finally {
    store?.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }
  }
});

test("reward migration refuses ambiguous Ante-1 repeated-seed interrupted segments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-semantic-rag-no-link-"));
  let store;
  try {
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    const first = state({ seed: "repeated", ante_num: 1, round_num: 0 });
    store.beginEpisode({ episodeId: "ante-one", runId: "front", state: first });
    store.recordTransition({
      runId: "front", episodeId: "ante-one", step: 1, state: first,
      action: { method: "select", params: {} }, nextState: { ...first, round_num: 1 },
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.markEpisodeInterrupted("ante-one");
    store.beginEpisode({ episodeId: "other-attempt", runId: "back", state: { ...first, round_num: 1 } });
    store.recordTransition({
      runId: "back", episodeId: "other-attempt", step: 1, state: { ...first, round_num: 1 },
      action: { method: "play", params: { cards: [0] } }, nextState: { ...first, state: "GAME_OVER" },
      source: "balatrobot_model", plan: {}, usage: {},
    });
    store.finalizeEpisode("other-attempt", "lost", { ...first, state: "GAME_OVER" });
    const db = new DatabaseSync(path.join(root, "data", "semantic.sqlite"));
    db.prepare("UPDATE semantic_episodes SET ended_at=? WHERE episode_id='ante-one'").run("2026-08-01T00:30:00.000Z");
    db.prepare("UPDATE semantic_episodes SET started_at=? WHERE episode_id='other-attempt'").run("2026-08-01T01:00:00.000Z");
    db.prepare("DELETE FROM semantic_reward_labels").run();
    db.prepare("DELETE FROM semantic_reward_migrations").run();
    db.close();
    store.close();
    store = new SemanticRagStore(root, config("data/semantic.sqlite"));
    assert.equal(store.rewardMigrationStatus().linkedSegments, 0);
    assert.equal(store.allRewardEvidence().some((item) => item.trajectoryEpisodeId === "ante-one"), false);
  } finally {
    store?.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }
  }
});
