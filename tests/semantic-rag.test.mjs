import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SemanticRagStore } from "../src/semantic-rag.mjs";

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

    const finalized = store.finalizeEpisode("episode-1", "won", { ...after, won: true, ante_num: 8 });
    assert.equal(finalized.transitions, 1);
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
    store.finalizeEpisode("episode-1b", "won", { ...after, won: true, ante_num: 8 });
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
      averageAnte: 8,
      averageRound: 4,
    }]);
    assert.deepEqual(store.deckPerformance("GOLD"), []);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
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
