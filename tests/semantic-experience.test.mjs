import test from "node:test";
import assert from "node:assert/strict";

import {
  semanticActionKey,
  semanticActionTemplate,
  semanticDiscountedReturns,
  SEMANTIC_POLICY_VERSION,
  semanticReplayFingerprint,
  semanticHighScoreTier,
  semanticPlayedHandScore,
  semanticStateBucket,
  semanticStateFeatures,
  semanticStateSimilarity,
  semanticStateText,
  semanticTerminalOutcome,
  semanticTransitionReward,
} from "../src/semantic-experience.mjs";

function card(key, { set = "DEFAULT", buy = 1 } = {}) {
  const [suit, rank] = key.split("_");
  return {
    key,
    set,
    label: key,
    value: { suit, rank, effect: "" },
    modifier: {},
    state: {},
    cost: { buy, sell: 1 },
  };
}

function state(overrides = {}) {
  const hand = [card("H_A"), card("S_A"), card("C_2")];
  return {
    state: "SELECTING_HAND",
    seed: "seed-one",
    deck: "RED",
    stake: "WHITE",
    ante_num: 2,
    round_num: 4,
    money: 8,
    won: false,
    round: { chips: 100, hands_left: 3, discards_left: 2, reroll_cost: 5 },
    blinds: { small: { type: "SMALL", status: "CURRENT", name: "Small Blind", score: 600 } },
    hand: { count: 3, limit: 8, highlighted_limit: 5, cards: hand },
    cards: { count: 20, limit: 52, cards: hand },
    jokers: { count: 1, limit: 5, cards: [card("j_joker", { set: "JOKER" })] },
    consumables: { count: 0, limit: 2, cards: [] },
    hands: { Pair: { level: 2, chips: 15, mult: 3, played: 4 } },
    ...overrides,
  };
}

test("semantic state separates exact safety fingerprints from reusable visible-state fingerprints", () => {
  const first = state();
  const second = state({ seed: "another-seed" });
  const features = semanticStateFeatures(first);
  assert.equal(SEMANTIC_POLICY_VERSION, 5);
  assert.equal(features.screen, "SELECTING_HAND");
  assert.deepEqual(features.hand, ["H_A", "S_A", "C_2"]);
  assert.equal(semanticReplayFingerprint(first), semanticReplayFingerprint(second));
  assert.match(semanticStateBucket(first), /SELECTING_HAND/);
  assert.match(semanticStateText(first), /score=100\/600/);
});

test("semantic replay separates unlock pools and remembers Jokers seen in the run", () => {
  const first = state({
    collection_knowledge: { signature: "pool-a" },
    appeared_this_run: { jokers: [{ key: "j_blueprint" }] },
  });
  const second = state({
    collection_knowledge: { signature: "pool-b" },
    appeared_this_run: { jokers: [{ key: "j_brainstorm" }] },
  });
  const features = semanticStateFeatures(first);
  assert.equal(features.collectionSignature, "pool-a");
  assert.deepEqual(features.appearedJokers, ["j_blueprint"]);
  assert.notEqual(semanticReplayFingerprint(first), semanticReplayFingerprint(second));
  assert.match(semanticStateText(first), /appearedJokers=j_blueprint/);
});

test("semantic replay identity distinguishes Boss-debuffed cards", () => {
  const normal = state();
  const debuffed = structuredClone(normal);
  debuffed.hand.cards[0].state.debuff = true;
  assert.notEqual(semanticReplayFingerprint(normal), semanticReplayFingerprint(debuffed));
  assert.match(semanticStateText(debuffed), /H_A\+debuff/);
});

test("semantic similarity generalizes nearby exact states but never crosses screens", () => {
  const first = state();
  const nearby = state({ money: 10, round: { chips: 120, hands_left: 3, discards_left: 2, reroll_cost: 5 } });
  const shop = state({ state: "SHOP", hand: null, shop: { count: 1, limit: 2, cards: [card("j_joker", { set: "JOKER", buy: 4 })] } });
  assert.ok(semanticStateSimilarity(first, nearby) > 0.85);
  assert.equal(semanticStateSimilarity(first, shop), 0);
});

test("semantic actions store card identities instead of transient indices", () => {
  const first = state();
  const reordered = state({
    hand: { count: 3, limit: 8, highlighted_limit: 5, cards: [card("C_2"), card("S_A"), card("H_A")] },
  });
  const firstAction = { method: "play", params: { cards: [0, 1] } };
  const reorderedAction = { method: "play", params: { cards: [2, 1] } };
  assert.deepEqual(semanticActionTemplate(first, firstAction), { method: "play", cards: ["H_A", "S_A"] });
  assert.equal(semanticActionKey(first, firstAction), semanticActionKey(reordered, reorderedAction));
});

test("reward and discounted return propagate whole-run outcomes backwards", () => {
  const before = state();
  const after = state({ round: { chips: 400, hands_left: 2, discards_left: 2, reroll_cost: 5 } });
  const immediate = semanticTransitionReward(before, { method: "play", params: { cards: [0, 1] } }, after);
  assert.ok(immediate > 0);
  const winReturns = semanticDiscountedReturns([{ id: 1, immediateReward: immediate }, { id: 2, immediateReward: 0.2 }], "won", { ante_num: 8 }, 0.97);
  const lossReturns = semanticDiscountedReturns([{ id: 1, immediateReward: immediate }, { id: 2, immediateReward: 0.2 }], "lost", { ante_num: 2 }, 0.97);
  assert.ok(winReturns.get(1) > lossReturns.get(1));
  assert.ok([...winReturns.values()].every((value) => value > 0));
  assert.ok([...lossReturns.values()].every((value) => value < 0));
  assert.equal(semanticTerminalOutcome({ state: "ROUND_EVAL", won: true }), null);
  assert.equal(semanticTerminalOutcome({ state: "GAME_OVER", won: true }), "lost");
  assert.equal(semanticTerminalOutcome({ state: "GAME_OVER", won: true }, { victoryCheckpointSeen: true }), "won");
  assert.equal(semanticTerminalOutcome({ state: "GAME_OVER", won: false }), "lost");
  assert.ok(semanticTransitionReward(before, { method: "skip", params: {} }, before) < 0);
  assert.ok(
    semanticDiscountedReturns([{ id: 3, immediateReward: 0 }], "lost", { ante_num: 2, money: 60 }).get(3) <
      semanticDiscountedReturns([{ id: 3, immediateReward: 0 }], "lost", { ante_num: 2, money: 0 }).get(3),
  );
});

test("high-score learning distinguishes a million-point hand from merely clearing a blind", () => {
  const before = state({ round: { chips: 10_000, hands_left: 2, discards_left: 1, reroll_cost: 5 } });
  const after = state({ round: { chips: 1_110_000, hands_left: 1, discards_left: 1, reroll_cost: 5 } });
  const action = { method: "play", params: { cards: [0, 1] } };
  assert.equal(semanticPlayedHandScore(before, action, after), 1_100_000);
  assert.equal(semanticHighScoreTier(1_100_000), "million");
  const ordinary = semanticDiscountedReturns(
    [{ id: 1, immediateReward: 0 }],
    "lost",
    { ante_num: 8, money: 0, trainingMaxHandScore: 20_000 },
  ).get(1);
  const million = semanticDiscountedReturns(
    [{ id: 1, immediateReward: 0 }],
    "lost",
    { ante_num: 8, money: 0, trainingMaxHandScore: 1_100_000 },
  ).get(1);
  assert.ok(million > ordinary + 5);
  assert.equal(
    semanticPlayedHandScore(before, action, { ...after, round_num: after.round_num + 1, round: { ...after.round, chips: 0 } }),
    0,
  );
  assert.equal(
    semanticPlayedHandScore(before, action, { ...after, ante_num: after.ante_num + 1 }),
    1_100_000,
  );
});

test("semantic strategy similarity transfers across different exact hands in the same build", () => {
  const first = state();
  const differentHand = state({
    hand: { count: 3, limit: 8, highlighted_limit: 5, cards: [card("D_K"), card("S_K"), card("C_7")] },
  });
  const differentBuild = state({
    jokers: { count: 1, limit: 5, cards: [card("j_stuntman", { set: "JOKER" })] },
  });
  assert.notEqual(semanticReplayFingerprint(first), semanticReplayFingerprint(differentHand));
  assert.ok(semanticStateSimilarity(first, differentHand) >= 0.72);
  assert.ok(semanticStateSimilarity(first, differentHand) > semanticStateSimilarity(first, differentBuild));
});
