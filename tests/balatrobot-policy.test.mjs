import test from "node:test";
import assert from "node:assert/strict";

import {
  balatrobotShopRerollBudget,
  balatrobotStateFingerprint,
  compactBalatrobotState,
  deterministicBalatrobotAction,
  fallbackBalatrobotAction,
  legacyPlanForBalatrobot,
  sanitizeCollectionAwareRunPlan,
  validateBalatrobotPlan,
} from "../src/balatrobot-policy.mjs";

function card({ key, set = "DEFAULT", rank, suit, buy = 0, edition = null, eternal = false } = {}) {
  return {
    id: 1,
    key,
    set,
    label: key,
    value: { rank, suit, effect: `${key} effect` },
    modifier: { edition, eternal },
    state: { debuff: false, hidden: false, highlight: false },
    cost: { buy, sell: 1 },
  };
}

function area(cards, limit = cards.length, highlightedLimit) {
  return { count: cards.length, limit, highlighted_limit: highlightedLimit, cards };
}

function handState() {
  const cards = [
    card({ key: "H_A", rank: "A", suit: "H" }),
    card({ key: "S_A", rank: "A", suit: "S" }),
    card({ key: "D_K", rank: "K", suit: "D" }),
    card({ key: "C_7", rank: "7", suit: "C" }),
    card({ key: "H_2", rank: "2", suit: "H" }),
  ];
  return {
    state: "SELECTING_HAND",
    ante_num: 2,
    round_num: 4,
    money: 9,
    deck: "RED",
    stake: "WHITE",
    round: { chips: 40, hands_left: 3, discards_left: 2 },
    blinds: { small: { name: "Small Blind", status: "Current", score: 450 } },
    hand: area(cards, 8, 5),
    cards: area(cards, 52),
    jokers: area([], 5),
    consumables: area([], 2),
  };
}

function action(method, overrides = {}) {
  return {
    method,
    cards: [],
    card: null,
    voucher: null,
    pack: null,
    joker: null,
    consumable: null,
    targets: [],
    skip: null,
    hand: [],
    jokers: [],
    consumables: [],
    reason: "test",
    ...overrides,
  };
}

function plan(botAction, confidence = 0.9) {
  return { observation: "exact", strategy: "win", memory: "pair build", confidence, actions: [botAction] };
}

test("compact exact state preserves indexed cards and produces a semantic fingerprint", () => {
  const state = handState();
  const compact = compactBalatrobotState(state);
  assert.equal(compact.state, "SELECTING_HAND");
  assert.equal(compact.hand.cards[1].key, "S_A");
  state.hand.cards[1].state.highlight = true;
  assert.equal(compactBalatrobotState(state).hand.cards[1].highlight, true);
  assert.equal(compact.remainingDeck.cards[2].rank, "K");
  assert.equal(balatrobotStateFingerprint(state), balatrobotStateFingerprint(structuredClone(state)));
  const changed = structuredClone(state);
  changed.money = 10;
  assert.notEqual(balatrobotStateFingerprint(state), balatrobotStateFingerprint(changed));
});

test("plan validation preserves metagame, economy, and pivot policy", () => {
  const state = handState();
  const result = validateBalatrobotPlan({
    ...plan(action("play", { cards: [0, 1] })),
    runPlan: {
      metaAssessment: "early bridge, not a committed build",
      buildGoal: "repeatable pair",
      synergies: "pair planets",
      economyPolicy: "hold $10 unless survival is weak",
      shopPriorities: "scaling Mult then XMult",
      pivotPolicy: "pivot for supported Blueprint package",
      handPolicy: "keep pairs and discard dead cards",
      nextMilestone: "clear Ante 2",
      revisionReason: "no core Joker yet",
    },
  }, state);
  assert.equal(result.runPlan.metaAssessment, "early bridge, not a committed build");
  assert.equal(result.runPlan.economyPolicy, "hold $10 unless survival is weak");
  assert.equal(result.runPlan.pivotPolicy, "pivot for supported Blueprint package");
});

test("play validation follows the live hand highlighted limit", () => {
  const state = handState();
  state.hand.highlighted_limit = 3;
  assert.throws(
    () => validateBalatrobotPlan(plan(action("play", { cards: [0, 1, 2, 3] })), state),
    /1\.\.3 indices/,
  );
  const result = validateBalatrobotPlan(plan(action("play", { cards: [0, 1, 2] })), state);
  assert.deepEqual(result.actions[0].params, { cards: [0, 1, 2] });
});

test("The Psychic is a hard five-card play constraint", () => {
  const state = handState();
  state.blinds = { boss: { type: "BOSS", status: "CURRENT", name: "The Psychic", score: 600 } };
  assert.throws(
    () => validateBalatrobotPlan(plan(action("play", { cards: [0, 1, 2, 3] })), state),
    /exactly 5/,
  );
  assert.deepEqual(
    validateBalatrobotPlan(plan(action("play", { cards: [0, 1, 2, 3, 4] })), state).actions[0].params,
    { cards: [0, 1, 2, 3, 4] },
  );
});

test("hand narrative cannot keep a concrete card while discarding its index", () => {
  const state = handState();
  const contradictory = {
    ...plan(action("discard", { cards: [1, 2, 3], reason: "弃掉散牌，保留黑桃A" })),
    strategy: "保留黑桃A作为对子核心",
  };
  assert.throws(() => validateBalatrobotPlan(contradictory, state), /contradict.*keep S_A/);
  const aligned = {
    ...contradictory,
    strategy: "保留红桃A作为对子核心",
    actions: [action("discard", { cards: [1, 2, 3], reason: "弃掉黑桃A、方块K、梅花7" })],
  };
  assert.doesNotThrow(() => validateBalatrobotPlan(aligned, state));
});

test("semantic plan validates zero-based hand indices and emits RPC params", () => {
  const state = handState();
  const result = validateBalatrobotPlan(plan(action("play", { cards: [0, 1, 4] })), state, {
    minimumConfidence: 0.7,
  });
  assert.deepEqual(result.actions[0], { method: "play", params: { cards: [0, 1, 4] }, reason: "test" });
  assert.throws(
    () => validateBalatrobotPlan(plan(action("play", { cards: [0, 9] })), state),
    /outside/,
  );
  assert.throws(
    () => validateBalatrobotPlan(plan({ ...action("play", { cards: [0] }), unsupported: true }), state),
    /unsupported key/,
  );
});

test("semantic plan preserves a structured single-run build plan", () => {
  const state = handState();
  const candidate = {
    ...plan(action("play", { cards: [0, 1] })),
    runPlan: {
      buildGoal: "稳定对子构筑",
      synergies: "围绕对子触发小丑",
      shopPriorities: "优先成长和经济小丑",
      handPolicy: "保留对子，用弃牌找三条",
      nextMilestone: "形成可重复的三条",
      revisionReason: "根据当前持有建立",
    },
  };
  const result = validateBalatrobotPlan(candidate, state);
  assert.equal(result.runPlan.buildGoal, "稳定对子构筑");
  assert.match(legacyPlanForBalatrobot(state, result.actions[0], result).runPlan.shopPriorities, /成长/);
});

test("build plan rejects locked and merely hypothetical core Jokers", () => {
  const state = handState();
  const collectionKnowledge = {
    available: true,
    unlockedJokers: [
      { key: "j_joker", label: "Joker" },
      { key: "j_green_joker", label: "Green Joker" },
    ],
    lockedJokers: [{ key: "j_blueprint", label: "Blueprint" }],
  };
  const candidate = {
    ...plan(action("play", { cards: [0, 1] })),
    runPlan: { buildGoal: "Blueprint copy core", synergies: "pair scoring" },
  };
  assert.throws(
    () => validateBalatrobotPlan(candidate, state, { collectionKnowledge, appearedThisRun: { jokers: [] } }),
    /locked Joker Blueprint/,
  );
  collectionKnowledge.lockedJokers = [];
  candidate.runPlan = { buildGoal: "Green Joker core", synergies: "pair scoring" };
  assert.throws(
    () => validateBalatrobotPlan(candidate, state, { collectionKnowledge, appearedThisRun: { jokers: [] } }),
    /unlocked but unseen Joker Green Joker/,
  );
  assert.doesNotThrow(() => validateBalatrobotPlan(candidate, state, {
    collectionKnowledge,
    appearedThisRun: { jokers: [{ key: "j_green_joker", label: "Green Joker" }] },
  }));
  candidate.runPlan = { buildGoal: "pair core", synergies: "pair scoring", shopPriorities: "look for Green Joker" };
  assert.doesNotThrow(() => validateBalatrobotPlan(candidate, state, {
    collectionKnowledge,
    appearedThisRun: { jokers: [] },
  }));
});

test("stale inherited build plans are reduced to currently owned Jokers", () => {
  const state = handState();
  state.jokers = area([card({ key: "j_jolly", set: "JOKER" })], 5);
  const collectionKnowledge = {
    available: true,
    unlockedJokers: [
      { key: "j_jolly", label: "Jolly Joker" },
      { key: "j_hiker", label: "Hiker" },
    ],
    lockedJokers: [],
  };
  const result = sanitizeCollectionAwareRunPlan(
    { buildGoal: "Hiker core", synergies: "Hiker grows every played card", economyPolicy: "hold $10" },
    collectionKnowledge,
    { jokers: [{ key: "j_jolly", label: "Jolly Joker" }] },
    state,
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ["Hiker"]);
  assert.match(result.runPlan.buildGoal, /j_jolly/i);
  assert.doesNotMatch(`${result.runPlan.buildGoal} ${result.runPlan.synergies}`, /Hiker/i);
  assert.equal(result.runPlan.economyPolicy, "hold $10");
  assert.doesNotThrow(() => validateBalatrobotPlan({
    ...plan(action("play", { cards: [0, 1] })),
    runPlan: result.runPlan,
  }, state, { collectionKnowledge, appearedThisRun: { jokers: [{ key: "j_jolly" }] } }));
});

test("shop validation enforces money, indices, and occupied slots before RPC", () => {
  const state = {
    ...handState(),
    state: "SHOP",
    money: 5,
    shop: area([card({ key: "j_joker", set: "JOKER", buy: 4 })], 2),
    vouchers: area([], 1),
    packs: area([], 2),
    jokers: area(
      [
        card({ key: "j_one", set: "JOKER" }),
        card({ key: "j_two", set: "JOKER" }),
      ],
      2,
    ),
  };
  assert.throws(() => validateBalatrobotPlan(plan(action("buy", { card: 0 })), state), /slots are full/);
  state.shop.cards[0].modifier.edition = "NEGATIVE";
  assert.throws(
    () => validateBalatrobotPlan(plan(action("buy", { card: 0 })), state),
    /slots are full/,
    "stable BalatroBot 1.5.2 rejects full-slot Negative purchases too",
  );
  state.jokers = area([card({ key: "j_credit_card", set: "JOKER" })], 5);
  state.shop.cards[0].modifier.edition = null;
  state.shop.cards[0].cost.buy = 8;
  const result = validateBalatrobotPlan(plan(action("buy", { card: 0 })), state);
  assert.deepEqual(result.actions[0].params, { card: 0 });
});

test("shop policy leaves build choices open while spending a score-pressure budget", () => {
  const state = {
    ...handState(),
    state: "SHOP",
    ante_num: 5,
    money: 14,
    round: { ...handState().round, reroll_cost: 5 },
    jokers: area([
      card({ key: "j_blue_joker", set: "JOKER" }),
      card({ key: "j_scholar", set: "JOKER" }),
      card({ key: "j_card_sharp", set: "JOKER" }),
      card({ key: "j_bootstraps", set: "JOKER" }),
    ], 5),
    shop: area([card({ key: "j_mad", set: "JOKER", buy: 4 })], 2),
    vouchers: area([], 1),
    packs: area([card({ key: "p_celestial", set: "BOOSTER", buy: 6 })], 2),
  };
  assert.doesNotThrow(() => validateBalatrobotPlan(plan(action("buy", { pack: 0 })), state));
  assert.doesNotThrow(() => validateBalatrobotPlan(plan(action("buy", { card: 0 })), state));

  state.ante_num = 2;
  state.money = 25;
  state.jokers = area([card({ key: "j_blue_joker", set: "JOKER" })], 5);
  state.shop = area([], 2);
  assert.throws(() => validateBalatrobotPlan(plan(action("next_round")), state), /shop survival budget/);
  assert.doesNotThrow(() => validateBalatrobotPlan(plan(action("reroll")), state));
});

test("shop purchase identity remains exact without hard-coding the final Joker slot", () => {
  const state = {
    ...handState(),
    state: "SHOP",
    ante_num: 4,
    money: 12,
    round: { ...handState().round, reroll_cost: 0 },
    jokers: area([
      card({ key: "j_abstract", set: "JOKER" }),
      card({ key: "j_gros_michel", set: "JOKER" }),
      card({ key: "j_dna", set: "JOKER" }),
      card({ key: "j_superposition", set: "JOKER" }),
    ], 5),
    shop: area([card({ key: "j_chaos", set: "JOKER", buy: 4 })], 2),
    vouchers: area([], 1),
    packs: area([card({ key: "p_standard_normal_1", set: "BOOSTER", buy: 4 })], 2),
  };
  assert.throws(
    () => validateBalatrobotPlan({ ...plan(action("buy", { card: 0 })), strategy: "购买 Standard Pack" }, state),
    /action reason names|written strategy names/,
  );
  assert.doesNotThrow(
    () => validateBalatrobotPlan({ ...plan(action("buy", { card: 0 })), strategy: "购买 Chaos" }, state),
  );
  assert.throws(() => validateBalatrobotPlan(plan(action("next_round")), state), /shop survival budget/);
  assert.doesNotThrow(() => validateBalatrobotPlan(plan(action("buy", { pack: 0 })), state));
  const fallback = fallbackBalatrobotAction(state);
  assert.equal(fallback.method, "reroll");
  assert.match(fallback.reason, /dynamic search budget/);
});

test("reroll budget grows with the remaining score target and preserves cash when safe", () => {
  const base = {
    ...handState(),
    state: "SHOP",
    money: 40,
    round: { ...handState().round, hands_left: 4, reroll_cost: 5 },
    hands: { Pair: { chips: 10, mult: 2, played: 5 } },
    jokers: area([
      card({ key: "j_blue_joker", set: "JOKER" }),
      card({ key: "j_scholar", set: "JOKER" }),
      card({ key: "j_card_sharp", set: "JOKER" }),
      card({ key: "j_bootstraps", set: "JOKER" }),
      card({ key: "j_ramen", set: "JOKER" }),
    ], 5),
    shop: area([], 2),
    vouchers: area([], 1),
    packs: area([], 2),
  };
  const safe = { ...base, blinds: { small: { name: "Small Blind", status: "UPCOMING", score: 300 } } };
  const pressured = { ...base, blinds: { boss: { name: "The Wall", status: "UPCOMING", score: 10_000 } } };
  const safeBudget = balatrobotShopRerollBudget(safe);
  const pressuredBudget = balatrobotShopRerollBudget(pressured);
  assert.equal(safeBudget.budget, 0);
  assert.equal(safeBudget.shouldReroll, false);
  assert.ok(pressuredBudget.budget >= 10);
  assert.ok(pressuredBudget.maxRerolls >= 2);
  assert.ok(pressuredBudget.reserve < safeBudget.reserve);
  assert.equal(fallbackBalatrobotAction(safe).method, "next_round");
  assert.equal(fallbackBalatrobotAction(pressured).method, "reroll");
  assert.equal(compactBalatrobotState(pressured).shopReroll.target, 10_000);
});

test("shop risk forecast discounts rare hands and honors The Needle's one-hand limit", () => {
  const base = {
    ...handState(),
    state: "SHOP",
    money: 40,
    round: { ...handState().round, hands_left: 5, reroll_cost: 5 },
    hands: {
      Pair: { chips: 10, mult: 2, played: 18 },
      "Straight Flush": { chips: 100, mult: 8, played: 1 },
    },
    jokers: area([card({ key: "j_jolly", set: "JOKER" })], 5),
    shop: area([], 2),
    vouchers: area([], 1),
    packs: area([], 2),
  };
  const normal = balatrobotShopRerollBudget({
    ...base,
    blinds: { boss: { name: "The Wall", status: "UPCOMING", score: 3_200 } },
  });
  const needle = balatrobotShopRerollBudget({
    ...base,
    blinds: { boss: { name: "The Needle", status: "UPCOMING", score: 3_200 } },
  });
  assert.equal(normal.representativeHand, "Pair");
  assert.equal(normal.effectiveHands, 4);
  assert.equal(needle.effectiveHands, 1);
  assert.ok(needle.pressure > normal.pressure * 4);
  assert.ok(needle.budget >= normal.budget);
});

test("shop pressure uses recent confirmed scoring and ignores stale previous-blind hands left", () => {
  const exact = {
    ...handState(),
    state: "SHOP",
    money: 40,
    round: { ...handState().round, hands_left: 1, reroll_cost: 5 },
    hands: { "Two Pair": { chips: 20, mult: 2, played: 12 } },
    jokers: area([
      card({ key: "j_jolly", set: "JOKER" }),
      card({ key: "j_card_sharp", set: "JOKER" }),
      card({ key: "j_cavendish", set: "JOKER" }),
      card({ key: "j_blue_joker", set: "JOKER" }),
      card({ key: "j_abstract", set: "JOKER" }),
    ], 5),
    shop: area([], 2),
    vouchers: area([], 1),
    packs: area([], 2),
    blinds: { boss: { name: "The Wall", status: "UPCOMING", score: 44_000 } },
  };
  const budget = balatrobotShopRerollBudget(exact, {
    benchmarks: [14_000, 16_000, 18_000, 20_000].map((actualScore) => ({ actualScore, state: exact })),
  });
  assert.equal(budget.effectiveHands, 4);
  assert.equal(budget.estimatedPerHand, 14_000);
  assert.equal(budget.scoreEvidenceSource, "recent_actual");
  assert.equal(budget.shouldReroll, false);
});

test("shop score evidence rejects samples from a different Joker build and handles Black Deck", () => {
  const exact = {
    ...handState(),
    state: "SHOP",
    deck: "BLACK",
    money: 40,
    round: { ...handState().round, hands_left: 4, reroll_cost: 5 },
    hands: { Pair: { chips: 10, mult: 2, played: 8 } },
    jokers: area([card({ key: "j_jolly", set: "JOKER" })], 5),
    shop: area([], 2), vouchers: area([], 1), packs: area([], 2),
    blinds: { boss: { name: "The Wall", status: "UPCOMING", score: 10_000 } },
  };
  const oldBuild = { ...exact, jokers: area([card({ key: "j_cavendish", set: "JOKER" })], 5) };
  const budget = balatrobotShopRerollBudget(exact, {
    benchmarks: [{ state: oldBuild, actualScore: 50_000 }],
  });
  assert.equal(budget.effectiveHands, 3);
  assert.equal(budget.scoreEvidenceSource, "hand_level_proxy");
  assert.ok(budget.estimatedPerHand < 50_000);
});

test("shop score evidence does not reuse the same Joker key with stale effect, edition, or debuff state", () => {
  const joker = ({ effect = "+4 Mult", edition = null, debuff = false } = {}) => ({
    ...card({ key: "j_green_joker", set: "JOKER", edition }),
    value: { effect },
    state: { debuff },
  });
  const exact = {
    ...handState(),
    state: "SHOP",
    money: 40,
    round: { ...handState().round, reroll_cost: 5 },
    hands: { Pair: { chips: 10, mult: 2, played: 8 } },
    jokers: area([joker({ effect: "+18 Mult", edition: "POLYCHROME" })], 5),
    shop: area([], 2), vouchers: area([], 1), packs: area([], 2),
    blinds: { boss: { name: "The Wall", status: "UPCOMING", score: 10_000 } },
  };
  for (const staleJoker of [
    joker({ effect: "+4 Mult", edition: "POLYCHROME" }),
    joker({ effect: "+18 Mult", edition: "HOLO" }),
    joker({ effect: "+18 Mult", edition: "POLYCHROME", debuff: true }),
  ]) {
    const staleState = { ...exact, jokers: area([staleJoker], 5) };
    const budget = balatrobotShopRerollBudget(exact, {
      benchmarks: [{ state: staleState, actualScore: 50_000 }],
    });
    assert.equal(budget.scoreEvidenceSource, "hand_level_proxy");
    assert.ok(budget.estimatedPerHand < 50_000);
  }
});

test("fallback uses a final-hand scoring consumable before a losing play", () => {
  const state = handState();
  state.round = { chips: 0, hands_left: 1, discards_left: 0 };
  state.blinds = { boss: { type: "BOSS", status: "CURRENT", name: "The Needle", score: 800 } };
  state.consumables = area([card({ key: "c_mercury", set: "PLANET" })], 2);
  const fallback = fallbackBalatrobotAction(state);
  assert.deepEqual(fallback.params, { consumable: 0 });
  assert.equal(fallback.method, "use");
});

test("fallback converts suits to clear the blind before spending another hand", () => {
  const state = handState();
  state.round = { chips: 1_498, hands_left: 3, discards_left: 0 };
  state.blinds = { big: { type: "BIG", status: "CURRENT", name: "Big Blind", score: 3_000 } };
  state.hand = area([
    card({ key: "C_K", rank: "K", suit: "C" }),
    card({ key: "H_J", rank: "J", suit: "H" }),
    card({ key: "D_T", rank: "T", suit: "D" }),
    card({ key: "D_6", rank: "6", suit: "D" }),
    card({ key: "D_5", rank: "5", suit: "D" }),
    card({ key: "H_4", rank: "4", suit: "H" }),
    card({ key: "C_4", rank: "4", suit: "C" }),
    card({ key: "D_3", rank: "3", suit: "D" }),
  ], 8, 5);
  state.jokers = area([
    card({ key: "j_greedy_joker", set: "JOKER" }),
    card({ key: "j_droll", set: "JOKER" }),
  ], 5);
  state.consumables = area([card({ key: "c_star", set: "TAROT" })], 2);
  const fallback = fallbackBalatrobotAction(state);
  assert.equal(fallback.method, "use");
  assert.equal(fallback.params.consumable, 0);
  assert.ok(fallback.params.cards.length >= 1);
});

test("opened pack supports a selected card plus explicit target cards", () => {
  const state = {
    ...handState(),
    state: "SMODS_BOOSTER_OPENED",
    pack: area([card({ key: "c_magician", set: "TAROT" })], 2),
  };
  const use = validateBalatrobotPlan(plan(action("pack", { card: 0, targets: [1, 4] })), state);
  assert.deepEqual(use.actions[0].params, { card: 0, targets: [1, 4] });
  const skip = validateBalatrobotPlan(plan(action("pack", { skip: true })), state);
  assert.deepEqual(skip.actions[0].params, { skip: true });
});

test("targeted pack cards cannot omit their game-level target contract", () => {
  const state = {
    ...handState(),
    state: "SMODS_BOOSTER_OPENED",
    pack: area([
      card({ key: "c_star", set: "TAROT" }),
      card({ key: "c_devil", set: "TAROT" }),
    ], 2),
  };
  assert.throws(() => validateBalatrobotPlan(plan(action("pack", { card: 0 })), state), /c_star requires 1-3/);
  assert.throws(() => validateBalatrobotPlan(plan(action("pack", { card: 1 })), state), /c_devil requires exactly 1/);
  assert.doesNotThrow(() => validateBalatrobotPlan(plan(action("pack", { card: 0, targets: [2, 3] })), state));
  const fallback = fallbackBalatrobotAction(state);
  assert.equal(fallback.method, "pack");
  assert.ok(new Set([0, 1]).has(fallback.params.card));
  const expectedMaximum = fallback.params.card === 0 ? 3 : 1;
  assert.ok(fallback.params.targets.length >= 1 && fallback.params.targets.length <= expectedMaximum);
});

test("local policy rejects v1.5.2 actions that are certainly unavailable", () => {
  const bossState = {
    ...handState(),
    state: "BLIND_SELECT",
    blinds: { boss: { type: "BOSS", status: "SELECT", name: "The Hook", score: 600 } },
  };
  assert.throws(() => validateBalatrobotPlan(plan(action("skip")), bossState), /Boss Blind/);

  const shopState = {
    ...handState(),
    state: "SHOP",
    money: 2,
    round: { ...handState().round, reroll_cost: 5 },
    shop: area([], 2),
    vouchers: area([], 1),
    packs: area([], 2),
  };
  assert.throws(() => validateBalatrobotPlan(plan(action("reroll")), shopState), /costs \$5/);

  const packState = {
    ...handState(),
    state: "SMODS_BOOSTER_OPENED",
    pack: area([card({ key: "j_joker", set: "JOKER" })], 2),
    jokers: area(
      [
        card({ key: "j_one", set: "JOKER" }),
        card({ key: "j_two", set: "JOKER" }),
      ],
      2,
    ),
  };
  assert.throws(
    () => validateBalatrobotPlan(plan(action("pack", { card: 0 })), packState),
    /Joker slots are full/,
  );
});

test("blind skipping is strategic-only, explicit, and requires a mature scoring build", () => {
  const skipState = {
    ...handState(),
    state: "BLIND_SELECT",
    ante_num: 3,
    blinds: { small: { type: "SMALL", status: "SELECT", name: "Small Blind", tagName: "Investment Tag" } },
    jokers: area([
      card({ key: "j_joker", set: "JOKER" }),
      card({ key: "j_walkie_talkie", set: "JOKER" }),
      card({ key: "j_credit_card", set: "JOKER" }),
    ], 5),
  };
  const explicit = {
    ...plan(action("skip", { reason: "跳过以领取投资标签" }), 0.96),
    strategy: "明确跳过小盲，投资标签收益高且现有计分足够。",
  };
  assert.equal(validateBalatrobotPlan(explicit, skipState, { allowBlindSkip: true }).actions[0].method, "skip");
  assert.throws(() => validateBalatrobotPlan(explicit, skipState), /disabled outside/);
  assert.throws(
    () => validateBalatrobotPlan({ ...explicit, strategy: "正常挑战当前盲注，不跳过。" }, skipState, { allowBlindSkip: true }),
    /contradicts/,
  );
  const weak = { ...skipState, jokers: area([], 5) };
  assert.throws(() => validateBalatrobotPlan(explicit, weak, { allowBlindSkip: true }), /3 active Jokers/);
});

test("sell validation refuses a stale index that names a different Joker", () => {
  const shopState = {
    ...handState(),
    state: "SHOP",
    jokers: area([
      card({ key: "j_blue_joker", set: "JOKER" }),
      card({ key: "j_business", set: "JOKER" }),
      { ...card({ key: "j_ride_the_bus", set: "JOKER" }), label: "Ride the Bus" },
    ], 5),
    shop: area([], 2),
    vouchers: area([], 1),
    packs: area([], 2),
  };
  const stale = {
    ...plan(action("sell", { joker: 2, reason: "出售 Ice Cream 腾出槽位" })),
    strategy: "卖掉 Ice Cream。",
  };
  assert.throws(() => validateBalatrobotPlan(stale, shopState), /Ride the Bus.*does not name/);
  const exact = {
    ...stale,
    strategy: "卖掉 Ride the Bus。",
    actions: [action("sell", { joker: 2, reason: "出售 Ride the Bus" })],
  };
  assert.deepEqual(validateBalatrobotPlan(exact, shopState).actions[0].params, { joker: 2 });
});

test("navigation and fallback policies always make legal forward progress", () => {
  assert.deepEqual(deterministicBalatrobotAction({ state: "MENU" }, { balatrobotDeck: "BLUE", balatrobotStake: "RED" }), {
    method: "start",
    params: { deck: "BLUE", stake: "RED" },
    reason: "Start the next run locally",
  });
  assert.equal(deterministicBalatrobotAction({ state: "ROUND_EVAL", won: false }).method, "cash_out");
  assert.equal(deterministicBalatrobotAction({ state: "ROUND_EVAL", won: true }).method, "endless");
  assert.equal(
    deterministicBalatrobotAction(
      { state: "ROUND_EVAL", won: true },
      { balatrobotVictoryOverlayDismissed: true },
    ).method,
    "cash_out",
  );
  assert.equal(fallbackBalatrobotAction({ state: "SHOP" }).method, "next_round");
  const fallbackHand = fallbackBalatrobotAction(handState());
  assert.equal(fallbackHand.method, "discard");
  assert.ok(fallbackHand.params.cards.length > 0);
});

test("deterministic policy rearranges ordinary Joker scoring layers before planning", () => {
  const state = handState();
  state.jokers = area([
    { ...card({ key: "j_cavendish" }), label: "Cavendish", value: { effect: "X3 Mult" } },
    { ...card({ key: "j_joker" }), label: "Joker", value: { effect: "+4 Mult" } },
  ], 5);
  assert.deepEqual(deterministicBalatrobotAction(state), {
    method: "rearrange",
    params: { jokers: [1, 0] },
    reason: "Put Chips/+Mult before XMult: Joker → Cavendish",
  });
});

test("legacy log projection remains compatible with watchdog progress fields", () => {
  const state = handState();
  const actionValue = { method: "play", params: { cards: [0, 1] }, reason: "pair" };
  const legacy = legacyPlanForBalatrobot(state, actionValue, { confidence: 0.95 });
  assert.equal(legacy.screen, "hand");
  assert.equal(legacy.state.ante, 2);
  assert.equal(legacy.state.score, 40);
  assert.equal(legacy.state.target, 450);
  assert.equal(legacy.actions[0].type, "rpc");
});
