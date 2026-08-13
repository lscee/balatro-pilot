import test from "node:test";
import assert from "node:assert/strict";

import {
  appendSemanticPriorEvidence,
  applySemanticCandidatePriors,
  buildSemanticPriorIndex,
  semanticCandidateActionKey,
  semanticDecisionKey,
  semanticDecisionState,
  semanticPriorEvidenceForState,
} from "../src/semantic-prior.mjs";
import { semanticActionTemplate, semanticStateFeatures } from "../src/semantic-experience.mjs";

function card(key) {
  const [suit, rank] = key.split("_");
  return {
    key,
    set: "DEFAULT",
    label: key,
    value: { suit, rank },
    modifier: {},
    state: {},
    cost: { buy: 1, sell: 1 },
  };
}

function state(seed = "seed-a", overrides = {}) {
  const hand = [card("H_A"), card("S_A"), card("C_2"), card("D_7")];
  return {
    state: "SELECTING_HAND",
    seed,
    deck: "RED",
    stake: "WHITE",
    ante_num: 2,
    round_num: 4,
    money: 8,
    round: { chips: 100, hands_left: 3, discards_left: 2 },
    blinds: { small: { type: "SMALL", status: "CURRENT", name: "Small Blind", score: 600 } },
    hand: { count: hand.length, limit: 8, highlighted_limit: 5, cards: hand },
    cards: { count: 20, limit: 52, cards: hand },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    hands: { Pair: { level: 2, chips: 15, mult: 3, played: 4 } },
    ...overrides,
  };
}

function evidenceFor(currentState, action, episodeId, { outcome = "won", returnReward = 3, similarity = 0.92 } = {}) {
  return {
    episodeId,
    outcome,
    returnReward,
    similarity,
    source: "balatrobot_model",
    features: semanticStateFeatures(currentState),
    actionTemplate: semanticActionTemplate(currentState, action),
  };
}

test("decision buckets generalize across seed, round id and exact card order", () => {
  const first = state("seed-a");
  const reordered = state("seed-b", {
    round_num: 99,
    hand: {
      count: 4,
      limit: 8,
      highlighted_limit: 5,
      cards: [card("D_7"), card("C_2"), card("S_A"), card("H_A")],
    },
  });
  assert.equal(semanticDecisionKey(first), semanticDecisionKey(reordered));
  assert.equal(Object.hasOwn(semanticDecisionState(first), "seed"), false);
  assert.equal(Object.hasOwn(semanticDecisionState(first), "roundNumber"), false);
});

test("action templates generalize play and discard indices while preserving intent", () => {
  const first = state();
  const reordered = state("seed-b", {
    hand: {
      count: 4,
      limit: 8,
      highlighted_limit: 5,
      cards: [card("C_2"), card("D_7"), card("S_A"), card("H_A")],
    },
  });
  assert.equal(
    semanticCandidateActionKey(first, { action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] }),
    semanticCandidateActionKey(reordered, { action: { method: "play", cards: [2, 3] }, handType: "Pair", scoringCards: [2, 3] }),
  );
  assert.equal(
    semanticCandidateActionKey(first, { action: { method: "discard", cards: [2, 3] } }),
    semanticCandidateActionKey(reordered, { action: { method: "discard", cards: [0, 1] } }),
  );
});

test("candidate priors count independent episodes, retain negative evidence and expose confidence bounds", () => {
  const current = state("current-seed");
  const pairAction = { method: "play", params: { cards: [0, 1] } };
  const candidates = [
    { id: "play:single", action: { method: "play", cards: [0] }, handType: "High Card", scoringCards: [0] },
    { id: "play:pair", action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] },
  ];
  const evidence = [
    evidenceFor(state("history-a"), pairAction, "episode-a", { outcome: "lost", returnReward: 2 }),
    // The same episode may contain the same template more than once, but it is
    // still one vote and cannot manufacture confidence.
    evidenceFor(state("history-a"), pairAction, "episode-a", { outcome: "lost", returnReward: 4, similarity: 0.99 }),
    evidenceFor(state("history-b"), pairAction, "episode-b", { outcome: "lost", returnReward: -3 }),
    evidenceFor(state("history-c"), pairAction, "episode-c", { outcome: "lost", returnReward: -4 }),
    evidenceFor(state("history-d"), pairAction, "episode-d", { outcome: "lost", returnReward: -4 }),
    evidenceFor(state("history-e"), pairAction, "episode-e", { outcome: "lost", returnReward: -4 }),
  ];
  const result = applySemanticCandidatePriors(current, candidates, { evidence }, {
    minimumEpisodes: 3,
    confidenceZ: 1,
    maximumBlend: 0.3,
  });
  const pair = result.candidates.find((candidate) => candidate.id === "play:pair");
  assert.equal(pair.experiencePrior.independentEpisodes, 5);
  assert.equal(pair.experiencePrior.winningEpisodes, 0);
  assert.equal(pair.experiencePrior.losingEpisodes, 5);
  assert.equal(pair.experiencePrior.applied, true);
  assert.ok(pair.experiencePrior.upperConfidenceBound < 0);
  assert.ok(pair.calibratedPriority < pair.localBaselinePriority);
  assert.equal(result.baselineTopCandidateId, "play:single");
  assert.equal(result.calibratedTopCandidateId, "play:single");
  assert.equal(result.rankChanged, false);
});

test("small or conflicting samples remain visible but cannot alter the prior", () => {
  const current = state();
  const pairAction = { method: "play", params: { cards: [0, 1] } };
  const candidate = { id: "pair", action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] };
  const result = applySemanticCandidatePriors(current, [candidate], {
    evidence: [
      evidenceFor(state("one"), pairAction, "one", { outcome: "won", returnReward: 4 }),
      evidenceFor(state("two"), pairAction, "two", { outcome: "lost", returnReward: -4 }),
    ],
  });
  assert.equal(result.candidates[0].experiencePrior.independentEpisodes, 2);
  assert.equal(result.candidates[0].experiencePrior.applied, false);
  assert.equal(result.candidates[0].calibratedPriority, result.candidates[0].localBaselinePriority);
});

test("precomputed full-history prior evidence does not need raw feature payloads", () => {
  const current = state("current");
  const candidate = { id: "pair", action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] };
  const decisionKey = semanticDecisionKey(current);
  const actionKey = semanticCandidateActionKey(current, candidate);
  const evidence = Array.from({ length: 8 }, (_, index) => ({
    episodeId: `episode-${index}`,
    outcome: "won",
    returnReward: 4,
    similarity: 1,
    source: "balatrobot_model",
    decisionKey,
    actionKey,
  }));
  const result = applySemanticCandidatePriors(current, [candidate], { evidence });
  assert.equal(result.candidates[0].experiencePrior.independentEpisodes, 8);
  assert.equal(result.candidates[0].experiencePrior.applied, true);
  assert.ok(result.candidates[0].experiencePrior.lowerConfidenceBound > 0);
});

test("calibration reports when experience changes the top local rank", () => {
  const current = state();
  const high = { id: "high", action: { method: "play", cards: [2] }, handType: "High Card", scoringCards: [2] };
  const pair = { id: "pair", action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] };
  const fillers = [
    { id: "discard-a", action: { method: "discard", cards: [2] } },
    { id: "discard-b", action: { method: "discard", cards: [3] } },
    { id: "play-low", action: { method: "play", cards: [3] }, handType: "High Card", scoringCards: [3] },
  ];
  const decisionKey = semanticDecisionKey(current);
  const actionKey = semanticCandidateActionKey(current, pair);
  const evidence = Array.from({ length: 20 }, (_, index) => ({
    episodeId: `win-${index}`,
    outcome: "won",
    returnReward: 10,
    similarity: 1,
    source: "balatrobot_model",
    decisionKey,
    actionKey,
  }));
  const result = applySemanticCandidatePriors(current, [high, pair, ...fillers], { evidence }, { maximumBlend: 0.5 });
  assert.equal(result.baselineTopCandidateId, "high");
  assert.equal(result.calibratedTopCandidateId, "pair");
  assert.equal(result.rankChanged, true);
  assert.equal(result.candidates[0].baselineRank, 2);
  assert.equal(result.candidates[0].calibratedRank, 1);
});

test("full-history prior index performs one decision-bucket lookup per turn", () => {
  const current = state();
  const candidate = { id: "pair", action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] };
  const decisionKey = semanticDecisionKey(current);
  const actionKey = semanticCandidateActionKey(current, candidate);
  const raw = [
    { episodeId: "one", decisionKey, actionKey, outcome: "won", returnReward: 4, similarity: 1, source: "balatrobot_model" },
    { episodeId: "wrong", decisionKey: "other", actionKey, outcome: "lost", returnReward: -4, similarity: 1, source: "balatrobot_model" },
    { episodeId: null, decisionKey, actionKey },
  ];
  const index = buildSemanticPriorIndex(raw);
  assert.equal(index.size, 2);
  assert.deepEqual(semanticPriorEvidenceForState(index, current).map((item) => item.episodeId), ["one"]);
  const result = applySemanticCandidatePriors(current, [candidate], { priorIndex: index });
  assert.equal(result.evidenceCount, 1);
  assert.equal(result.candidates[0].experiencePrior.independentEpisodes, 1);
});

test("incremental prior index keeps one vote per canonical episode across linked trajectories", () => {
  const current = state();
  const candidate = { id: "pair", action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] };
  const decisionKey = semanticDecisionKey(current);
  const actionKey = semanticCandidateActionKey(current, candidate);
  const index = buildSemanticPriorIndex([
    { episodeId: "credit-old", trajectoryEpisodeId: "raw-1", decisionKey, actionKey, outcome: "lost", returnReward: -4, source: "balatrobot_model" },
    { episodeId: "credit-old", trajectoryEpisodeId: "raw-1", decisionKey, actionKey, outcome: "lost", returnReward: -2, source: "balatrobot_model" },
  ]);
  assert.equal(semanticPriorEvidenceForState(index, current).length, 1);

  appendSemanticPriorEvidence(index, [
    { episodeId: "credit-new", trajectoryEpisodeId: "raw-2", decisionKey, actionKey, outcome: "won", returnReward: 4, source: "balatrobot_model" },
    { episodeId: "credit-new", trajectoryEpisodeId: "raw-3", decisionKey, actionKey, outcome: "won", returnReward: 3, source: "balatrobot_model" },
  ]);
  const bucket = semanticPriorEvidenceForState(index, current);
  assert.equal(bucket.length, 2);
  assert.deepEqual(new Set(bucket.map((item) => item.episodeId)), new Set(["credit-old", "credit-new"]));
});
