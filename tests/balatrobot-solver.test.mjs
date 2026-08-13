import test from "node:test";
import assert from "node:assert/strict";

import {
  assertBalatrobotCandidateAction,
  balatrobotMouthLockedHandType,
  balatrobotJokerOrderAction,
  balatrobotSurvivalAssessment,
  balatrobotThinkingMode,
  estimateBalatrobotCandidateScore,
  filterBalatrobotExecutableCandidates,
  generateBalatrobotCandidates,
  generateBalatrobotPackCandidates,
} from "../src/balatrobot-solver.mjs";
import { fallbackBalatrobotAction } from "../src/balatrobot-policy.mjs";

test("local Joker order puts Chips and additive Mult before XMult", () => {
  const exact = state([], {
    jokers: [
      { key: "j_cavendish", label: "Cavendish", value: { effect: "X3 Mult" }, modifier: {} },
      { key: "j_banner", label: "Banner", value: { effect: "+30 Chips per discard" }, modifier: {} },
      { key: "j_joker", label: "Joker", value: { effect: "+4 Mult" }, modifier: {} },
      { key: "j_hanging_chad", label: "Hanging Chad", value: { effect: "Retrigger first card" }, modifier: {} },
    ],
  });
  assert.deepEqual(balatrobotJokerOrderAction(exact), {
    method: "rearrange",
    params: { jokers: [1, 2, 3, 0] },
    reason: "Put Chips/+Mult before XMult: Banner → Joker → Hanging Chad → Cavendish",
  });
});

test("local Joker order is stable and defers positional copy or sacrifice builds", () => {
  const sorted = state([], {
    jokers: [
      { key: "j_joker", value: { effect: "+4 Mult" }, modifier: {} },
      { key: "j_cavendish", value: { effect: "X3 Mult" }, modifier: {} },
    ],
  });
  assert.equal(balatrobotJokerOrderAction(sorted), null);
  sorted.jokers.cards.unshift({ key: "j_blueprint", value: { effect: "Copies Joker to the right" }, modifier: {} });
  assert.equal(balatrobotJokerOrderAction(sorted), null);
});

function card(rank, suit, { debuff = false, enhancement = null, edition = null, effect = "" } = {}) {
  return { value: { rank, suit, effect }, state: { debuff }, modifier: { enhancement, edition } };
}

function state(
  cards,
  {
    discards = 3,
    jokers = [],
    handsLeft = 4,
    handsPlayed = 1,
    discardsUsed = 1,
    chips = 0,
    blind = null,
    remaining = [],
  } = {},
) {
  return {
    state: "SELECTING_HAND",
    round: {
      chips,
      hands_left: handsLeft,
      hands_played: handsPlayed,
      discards_left: discards,
      discards_used: discardsUsed,
    },
    blinds: blind ? { boss: blind } : {},
    hand: { cards, highlighted_limit: 5 },
    cards: { cards: remaining },
    jokers: { cards: jokers },
    consumables: { cards: [] },
  };
}

test("local candidates identify a real pair and offer only low-value cycle fillers", () => {
  const hand = [
    card("6", "H"),
    card("6", "S"),
    card("K", "D"),
    card("Q", "C"),
    card("J", "H"),
    card("4", "D"),
    card("3", "C"),
    card("2", "S"),
  ];
  const candidates = generateBalatrobotCandidates(state(hand));
  const pairCore = candidates.find((candidate) => candidate.id === "play:0,1");
  const pairCycle = candidates.find((candidate) => candidate.handType === "Pair" && candidate.action.cards.length === 5);
  assert.deepEqual(pairCore.scoringCards, [0, 1]);
  assert.deepEqual(pairCycle.action.cards, [0, 1, 5, 6, 7]);
  assert.deepEqual(pairCycle.cycleFillers, [5, 6, 7]);
  assert.equal(candidates.some((candidate) => candidate.id === "play:0,1,2,3,4"), false);
});

test("local candidates classify full house and generate discard draws from exact remaining deck", () => {
  const hand = [card("T", "S"), card("T", "D"), card("9", "S"), card("9", "H"), card("9", "C"), card("8", "C"), card("7", "D"), card("6", "D")];
  const remaining = [card("T", "H"), card("9", "D"), card("5", "C")];
  const candidates = generateBalatrobotCandidates(state(hand, { remaining }));
  const fullHouse = candidates.find((candidate) => candidate.handType === "Full House");
  assert.deepEqual(fullHouse.action.cards, [0, 1, 2, 3, 4]);
  assert.deepEqual(fullHouse.scoringCards, [0, 1, 2, 3, 4]);
  assert.ok(candidates.some((candidate) => candidate.action.method === "discard" && candidate.exactRemainingDeckOuts > 0));
});

test("candidate guard rejects a hallucinated pair but allows non-hand semantic methods", () => {
  const candidates = generateBalatrobotCandidates(state([card("6", "H"), card("6", "S"), card("K", "D")]));
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "play", params: { cards: [1] } }, candidates),
    /locally enumerated candidate/,
  );
  assert.doesNotThrow(() => assertBalatrobotCandidateAction({ method: "use", params: { consumable: 0 } }, candidates));
});

test("conservative score reproduces Acrobat and debuff scoring instead of trusting model arithmetic", () => {
  const hand = [
    card("T", "S"),
    card("T", "D", { debuff: true }),
    card("K", "H"),
    card("Q", "C"),
    card("3", "C"),
  ];
  const exact = state(hand, { handsLeft: 1, discards: 0, jokers: [{ key: "j_acrobat" }] });
  const pair = generateBalatrobotCandidates(exact).find((candidate) => candidate.id === "play:0,1");
  assert.equal(pair.conservativeScore, 120);
  assert.equal(estimateBalatrobotCandidateScore(exact, pair).conservativeScore, 120);
});

test("conservative score includes live hand levels, Raised Fist, and last-hand Acrobat", () => {
  const exact = state(
    [card("8", "S"), card("8", "D"), card("3", "H"), card("K", "C")],
    { handsLeft: 1, discards: 0, jokers: [{ key: "j_raised_fist" }, { key: "j_acrobat" }] },
  );
  exact.hands = { Pair: { chips: 25, mult: 3 } };
  const score = estimateBalatrobotCandidateScore(exact, {
    action: { method: "play", cards: [0, 1] },
    handType: "Pair",
    scoringCards: [0, 1],
  });
  assert.equal(score.chips, 41);
  assert.equal(score.mult, 9);
  assert.equal(score.xMult, 3);
  assert.equal(score.conservativeScore, 1_107);
});

test("conservative score recognizes BalatroBot's HOLO edition spelling", () => {
  const exact = state(
    [card("A", "D"), card("K", "D"), card("Q", "D"), card("J", "D"), card("9", "D")],
    {
      discards: 0,
      remaining: Array.from({ length: 29 }, () => card("2", "C")),
      jokers: [
        { key: "j_blue_joker", modifier: { edition: "FOIL" } },
        { key: "j_business", modifier: { edition: "HOLO" } },
      ],
    },
  );
  const flush = generateBalatrobotCandidates(exact).find((candidate) => candidate.handType === "Flush");
  assert.equal(flush.chips, 193);
  assert.equal(flush.mult, 14);
  assert.equal(flush.conservativeScore, 2_702);
});

test("score model recognizes live Smiley and permanent Hiker card chips", () => {
  const exact = state(
    [card("K", "D", { effect: "+10额外筹码" }), card("4", "C")],
    { discards: 0, jokers: [{ key: "j_smiley" }, { key: "j_hiker" }] },
  );
  const highCard = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.action.method === "play" && candidate.action.cards.length === 1 && candidate.action.cards[0] === 0,
  );
  assert.equal(highCard.chips, 25);
  assert.equal(highCard.mult, 6);
  assert.equal(highCard.conservativeScore, 150);
});

test("score model parses live Chinese dynamic Mult and Chips values", () => {
  const exact = state(
    [card("6", "H"), card("4", "C")],
    {
      discards: 0,
      jokers: [
        { key: "j_green_joker", value: { effect: "每次出牌+1倍率（当前为+13倍）" } },
        { key: "j_square", value: { effect: "这张小丑牌获得+4筹码（当前为+20筹码）" } },
      ],
    },
  );
  const highCard = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.action.method === "play" && candidate.action.cards.length === 1 && candidate.action.cards[0] === 0,
  );
  assert.equal(highCard.chips, 31);
  assert.equal(highCard.mult, 15);
  assert.equal(highCard.conservativeScore, 465);
});

test("score model applies Baron, Ramen and later additive Mult in game order", () => {
  const exact = state(
    [card("Q", "D"), card("K", "C")],
    {
      discards: 0,
      jokers: [
        { key: "j_baron" },
        { key: "j_ramen", value: { effect: "X2 Mult" } },
        { key: "j_joker" },
      ],
    },
  );
  const highCard = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.action.method === "play" && candidate.action.cards.length === 1 && candidate.action.cards[0] === 0,
  );
  assert.equal(highCard.chips, 15);
  assert.equal(highCard.mult, 5);
  assert.equal(highCard.xMult, 3);
  // Q scores at 1 Mult, held K applies Baron (x1.5), Ramen doubles that,
  // then Joker adds +4 after the multipliers: (1 * 1.5 * 2 + 4) * 15.
  assert.equal(highCard.conservativeScore, 105);
});

test("Photograph and Hanging Chad retrigger the first face before later Joker Mult", () => {
  const exact = state(
    [card("K", "H"), card("4", "C")],
    { discards: 0, jokers: [{ key: "j_photograph" }, { key: "j_hanging_chad" }, { key: "j_joker" }] },
  );
  const highCard = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.action.method === "play" && candidate.action.cards.length === 1 && candidate.action.cards[0] === 0,
  );
  assert.equal(highCard.chips, 35);
  assert.equal(highCard.mult, 5);
  assert.equal(highCard.xMult, 8);
  assert.equal(highCard.conservativeScore, 420);
});

test("recent run regression: Photograph order, Green growth and Bonus chips score 495", () => {
  const exact = state(
    [
      card("A", "D"),
      card("K", "C"),
      card("Q", "S", { enhancement: "BONUS", effect: "+10筹码 +30额外筹码" }),
      card("J", "S"),
    ],
    {
      discards: 0,
      jokers: [
        { key: "j_green_joker", value: { effect: "当前为+3倍" } },
        { key: "j_photograph" },
        { key: "j_smiley" },
        { key: "j_crazy" },
        { key: "j_crafty" },
      ],
    },
  );
  const score = estimateBalatrobotCandidateScore(exact, {
    action: { method: "play", cards: [2] },
    handType: "High Card",
    scoringCards: [2],
  });
  assert.equal(score.chips, 45);
  assert.equal(score.mult, 10);
  assert.equal(score.xMult, 2);
  assert.equal(score.conservativeScore, 495);
});

test("recent run regression: Hanging Chad and Swashbuckler score the level-two trips exactly", () => {
  const sell = (key) => ({ key, cost: { sell: 2 } });
  const exact = state(
    [card("A", "S"), card("K", "S"), card("Q", "C"), card("4", "H"), card("4", "C"), card("4", "D")],
    {
      discards: 0,
      jokers: [sell("j_swashbuckler"), sell("j_odd_todd"), sell("j_hanging_chad"), sell("j_crazy"), sell("j_droll")],
    },
  );
  exact.hands = { "Three of a Kind": { chips: 50, mult: 5 } };
  const score = estimateBalatrobotCandidateScore(exact, {
    action: { method: "play", cards: [3, 4, 5] },
    handType: "Three of a Kind",
    scoringCards: [3, 4, 5],
  });
  assert.equal(score.chips, 70);
  assert.equal(score.mult, 13);
  assert.equal(score.conservativeScore, 910);
});

test("recent run regression: Hiker chips, Smiley and Ramen score the final Jack as 295", () => {
  const exact = state(
    [
      card("A", "H", { debuff: true }),
      card("J", "D", { effect: "+10筹码 +15额外筹码" }),
      card("8", "S"),
      card("7", "S", { effect: "+7筹码 +5额外筹码" }),
    ],
    {
      handsLeft: 1,
      discards: 0,
      jokers: [
        { key: "j_smiley" },
        { key: "j_hiker" },
        { key: "j_baron" },
        { key: "j_walkie_talkie" },
        { key: "j_ramen", value: { effect: "X1.64倍率" } },
      ],
    },
  );
  const score = estimateBalatrobotCandidateScore(exact, {
    action: { method: "play", cards: [1] },
    handType: "High Card",
    scoringCards: [1],
  });
  assert.equal(score.chips, 30);
  assert.equal(score.mult, 6);
  assert.equal(score.xMult, 1.64);
  assert.equal(score.conservativeScore, 295);
});

test("Glass xMult is exposed as upside but excluded from the survival lower bound", () => {
  const exact = state(
    [card("K", "D", { enhancement: "GLASS" }), card("4", "C")],
    { discards: 0, jokers: [{ key: "j_abstract", modifier: { edition: "HOLO" } }] },
  );
  const highCard = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.action.method === "play" && candidate.action.cards.length === 1 && candidate.action.cards[0] === 0,
  );
  assert.equal(highCard.volatileXMult, 2);
  assert.equal(highCard.optimisticScore, highCard.conservativeScore * 2);
  assert.equal(highCard.estimatedScore, highCard.conservativeScore);
});

test("Boss-local candidates enforce Psychic, Eye, and Mouth hand rules", () => {
  const hand = [
    card("A", "S"), card("A", "H"), card("K", "D"), card("Q", "C"),
    card("J", "S"), card("9", "H"), card("4", "D"), card("2", "C"),
  ];
  const psychic = state(hand, { blind: { type: "BOSS", status: "CURRENT", name: "The Psychic", score: 600 } });
  const psychicPlays = generateBalatrobotCandidates(psychic).filter((candidate) => candidate.action.method === "play");
  assert.ok(psychicPlays.length > 0);
  assert.ok(psychicPlays.every((candidate) => candidate.action.cards.length === 5));

  const eye = state(hand, { blind: { type: "BOSS", status: "CURRENT", name: "The Eye", score: 600 } });
  eye.hands = { Pair: { chips: 10, mult: 2, played_this_round: 1 } };
  assert.equal(generateBalatrobotCandidates(eye).some((candidate) => candidate.handType === "Pair"), false);

  const mouth = state(hand, { blind: { type: "BOSS", status: "CURRENT", name: "The Mouth", score: 600 } });
  mouth.hands = { Pair: { chips: 10, mult: 2, played_this_round: 1 } };
  const mouthPlays = generateBalatrobotCandidates(mouth).filter((candidate) => candidate.action.method === "play");
  assert.ok(mouthPlays.length > 0);
  assert.ok(mouthPlays.every((candidate) => candidate.handType === "Pair"));
});

test("The Mouth reads the RPC pokerHands lock and emits only a forced-zero candidate when locked hand is impossible", () => {
  const hand = [card("A", "S"), card("K", "H"), card("Q", "D"), card("8", "C"), card("3", "S")];
  const mouth = state(hand, {
    discards: 0,
    blind: { type: "BOSS", status: "CURRENT", name: "The Mouth", score: 600 },
  });
  mouth.pokerHands = { "Full House": { chips: 40, mult: 4, playedThisRound: 1 } };
  assert.equal(balatrobotMouthLockedHandType(mouth), "Full House");
  const candidates = generateBalatrobotCandidates(mouth);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].forcedZero, true);
  assert.equal(candidates[0].conservativeScore, 0);
  assert.match(candidates[0].bossRule, /locked to Full House/u);
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "play", params: { cards: [0] } }, candidates, mouth),
    /must exactly match one locally enumerated candidate/u,
  );
  assert.deepEqual(fallbackBalatrobotAction(mouth).params.cards, candidates[0].action.cards);
});

test("The Mouth discard candidates pursue only the locked hand type", () => {
  const hand = [card("9", "D"), card("9", "C"), card("A", "S"), card("K", "S"), card("Q", "S"), card("4", "H")];
  const mouth = state(hand, { blind: { type: "BOSS", status: "CURRENT", name: "The Mouth", score: 600 } });
  mouth.pokerHands = { "Full House": { chips: 40, mult: 4, playedThisRound: 1 } };
  const discards = generateBalatrobotCandidates(mouth).filter((candidate) => candidate.action.method === "discard");
  assert.ok(discards.length > 0);
  assert.ok(discards.every((candidate) => candidate.pursuesHandTypes.includes("Full House")));
  assert.ok(discards.some((candidate) => candidate.target === "chase The Mouth locked Full House"));
  assert.equal(discards.some((candidate) => candidate.target.includes("flush")), false);
});

test("The Mouth forced-zero play leaves an available locked rank core in hand and cycles only other cards", () => {
  const hand = [
    card("A", "S"), card("K", "H"), card("Q", "D"), card("J", "C"),
    card("9", "D"), card("9", "C"), card("3", "H"), card("2", "S"),
  ];
  const mouth = state(hand, {
    discards: 0,
    blind: { type: "BOSS", status: "CURRENT", name: "The Mouth", score: 600 },
  });
  Object.defineProperty(mouth, "__mouthLockedHandType", { value: "Full House", configurable: true });
  const forced = generateBalatrobotCandidates(mouth).find((candidate) => candidate.forcedZero);
  assert.ok(forced);
  assert.equal(forced.action.cards.includes(4), false);
  assert.equal(forced.action.cards.includes(5), false);
  assert.equal(forced.action.cards.length, 5);
  assert.ok(forced.action.cards.includes(6));
  assert.ok(forced.action.cards.includes(7));
});

test("The Mouth forced-zero play preserves a four-card Flush Five rank core", () => {
  const hand = [
    card("7", "S"), card("7", "H"), card("7", "D"), card("7", "C"),
    card("A", "S"), card("K", "H"), card("Q", "D"), card("2", "C"),
  ];
  const mouth = state(hand, {
    discards: 0,
    blind: { type: "BOSS", status: "CURRENT", name: "The Mouth", score: 600 },
  });
  Object.defineProperty(mouth, "__mouthLockedHandType", { value: "Flush Five", configurable: true });
  const forced = generateBalatrobotCandidates(mouth).find((candidate) => candidate.forcedZero);
  assert.ok(forced);
  assert.deepEqual(forced.action.cards, [4, 5, 6, 7]);
  assert.equal(forced.conservativeScore, 0);
});

test("The Mouth conflicting RPC counters fail closed unless the runner latched the first hand", () => {
  const hand = [card("A", "S"), card("A", "H"), card("K", "D"), card("Q", "C"), card("4", "S")];
  const mouth = state(hand, { blind: { type: "BOSS", status: "CURRENT", name: "The Mouth", score: 600 } });
  mouth.hands = { Pair: { played_this_round: 2 } };
  mouth.pokerHands = { Flush: { playedThisRound: 1 } };
  assert.equal(balatrobotMouthLockedHandType(mouth), "__AMBIGUOUS_MOUTH_LOCK__");
  Object.defineProperty(mouth, "__mouthLockedHandType", { value: "Flush", configurable: true });
  assert.equal(balatrobotMouthLockedHandType(mouth), "Flush");
  const candidates = generateBalatrobotCandidates(mouth);
  assert.ok(candidates.filter((candidate) => candidate.action.method === "play").every((candidate) => candidate.handType === "Flush"));
  assert.equal(candidates.some((candidate) => candidate.handType === "Pair"), false);
});

test("Cerulean Bell candidates always include the forced highlighted card", () => {
  const hand = [card("A", "S"), card("A", "H"), card("K", "D"), card("7", "C"), card("2", "H")];
  hand[4].state.highlight = true;
  const exact = state(hand, { blind: { type: "BOSS", status: "CURRENT", name: "The Cerulean Bell", score: 600 } });
  const plays = generateBalatrobotCandidates(exact).filter((candidate) => candidate.action.method === "play");
  assert.ok(plays.length > 0);
  assert.ok(plays.every((candidate) => candidate.action.cards.includes(4)));
});

test("The Flint halves only base Chips and base Mult before local effects", () => {
  const exact = state(
    [card("T", "S"), card("T", "D"), card("3", "H")],
    { discards: 0, blind: { type: "BOSS", status: "CURRENT", name: "The Flint", score: 600 } },
  );
  const pair = generateBalatrobotCandidates(exact).find((candidate) => candidate.handType === "Pair");
  assert.equal(pair.chips, 25);
  assert.equal(pair.mult, 1);
  assert.equal(pair.conservativeScore, 25);
});

test("score model handles Splash, Flower Pot, Bootstraps, and Bull together", () => {
  const exact = state([card("6", "H"), card("6", "S"), card("A", "D"), card("K", "C")], {
    discards: 0,
    jokers: [{ key: "j_splash" }, { key: "j_flower_pot" }, { key: "j_bootstraps" }, { key: "j_bull" }],
  });
  exact.money = 10;
  const pair = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.handType === "Pair" && candidate.action.cards.length === 4,
  );
  assert.equal(pair.chips, 63);
  assert.equal(pair.mult, 6);
  assert.equal(pair.xMult, 3);
  // Flower Pot is left of Bootstraps, so its X3 applies before the later +4
  // Mult instead of multiplying that later addition too.
  assert.equal(pair.conservativeScore, 630);
});

test("Flower Pot assigns each Wild card to at most one missing suit", () => {
  const exact = state([
    card("J", "D"),
    card("9", "D"),
    card("9", "D"),
    card("6", "H", { enhancement: "WILD" }),
    card("3", "D"),
  ], {
    discards: 0,
    jokers: [{ key: "j_splash" }, { key: "j_flower_pot" }],
  });
  const allFive = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.action.method === "play" && candidate.action.cards.length === 5,
  );
  assert.equal(allFive.handType, "Flush");
  assert.equal(allFive.xMult, 1);
  assert.equal(allFive.conservativeScore, 288);
});

test("Flower Pot still triggers when four distinct cards cover the four suits", () => {
  const exact = state([
    card("9", "D"), card("9", "C"), card("6", "H"), card("3", "S"),
  ], { discards: 0, jokers: [{ key: "j_splash" }, { key: "j_flower_pot" }] });
  const pair = generateBalatrobotCandidates(exact).find(
    (candidate) => candidate.handType === "Pair" && candidate.action.cards.length === 4,
  );
  assert.equal(pair.xMult, 3);
});

test("Verdant Leaf exposes a non-core Joker sale before a losing debuffed play", () => {
  const hand = [card("A", "S", { debuff: true }), card("A", "H", { debuff: true }), card("4", "D", { debuff: true })];
  const utility = { key: "j_business", modifier: { eternal: false }, cost: { sell: 2 } };
  const scoring = { key: "j_joker", modifier: { eternal: false }, cost: { sell: 1 } };
  const exact = state(hand, {
    discards: 0,
    jokers: [scoring, utility],
    blind: { type: "BOSS", status: "CURRENT", name: "Verdant Leaf", score: 600 },
  });
  const candidates = generateBalatrobotCandidates(exact);
  assert.deepEqual(candidates.find((candidate) => candidate.action.method === "sell").action, { method: "sell", joker: 1 });
  const play = candidates.find((candidate) => candidate.action.method === "play");
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "play", params: { cards: play.action.cards } }, candidates, exact),
    /Verdant Leaf/,
  );
});

test("discard ranking removes debuffed cards and blocks over-chasing a safe made hand", () => {
  const debuffed = state([
    card("A", "S"), card("K", "S"), card("Q", "S"), card("J", "S"), card("T", "S"),
    card("6", "H", { debuff: true }), card("6", "D", { debuff: true }),
  ], { remaining: [card("9", "S"), card("6", "C")] });
  const bestDiscard = generateBalatrobotCandidates(debuffed).find((candidate) => candidate.action.method === "discard");
  assert.deepEqual(bestDiscard.action.cards, [5, 6]);
  assert.equal(bestDiscard.debuffedDiscarded, 2);

  const made = state(
    [card("A", "H"), card("A", "D"), card("Q", "S"), card("Q", "D"), card("9", "C"), card("4", "S")],
    { chips: 96, handsLeft: 3, discards: 2, blind: { type: "SMALL", status: "CURRENT", name: "Small Blind", score: 300 } },
  );
  const candidates = generateBalatrobotCandidates(made);
  const discard = candidates.find((candidate) => candidate.action.method === "discard");
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "discard", params: { cards: discard.action.cards } }, candidates, made),
    /bank the score/,
  );
});

test("final-hand candidate context exposes and requires an emergency consumable", () => {
  const exact = state(
    [card("6", "H"), card("6", "S"), card("K", "D"), card("4", "C")],
    { handsLeft: 1, discards: 0, blind: { type: "BOSS", status: "CURRENT", name: "The Needle", score: 800 } },
  );
  exact.consumables.cards.push({ key: "c_mercury", set: "PLANET" });
  const candidates = generateBalatrobotCandidates(exact);
  const emergency = candidates.find((candidate) => candidate.action.method === "use");
  const play = candidates.find((candidate) => candidate.action.method === "play");
  assert.deepEqual(emergency.action, { method: "use", consumable: 0 });
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "play", params: { cards: play.action.cards } }, candidates, exact),
    /emergency consumable/,
  );
});

test("final-hand solver only spends a Planet that upgrades the hand being played", () => {
  const exact = state(
    [card("6", "H"), card("6", "S"), card("K", "D"), card("4", "C")],
    { handsLeft: 1, discards: 0, blind: { type: "BOSS", status: "CURRENT", name: "The Needle", score: 800 } },
  );
  exact.consumables.cards.push({ key: "c_venus", set: "PLANET" });
  const candidates = generateBalatrobotCandidates(exact);
  assert.equal(candidates.some((candidate) => candidate.action.method === "use"), false);
});

test("suit Tarot solver uses a guaranteed rescue before a low-scoring play with hands remaining", () => {
  const exact = state(
    [
      card("K", "C"), card("J", "H"), card("T", "D"), card("6", "D"),
      card("5", "D"), card("4", "H"), card("4", "C"), card("3", "D"),
    ],
    {
      chips: 1_498,
      handsLeft: 3,
      discards: 0,
      blind: { type: "BIG", status: "CURRENT", name: "Big Blind", score: 3_000 },
      jokers: [{ key: "j_greedy_joker" }, { key: "j_droll" }],
    },
  );
  exact.consumables.cards.push({ key: "c_star", set: "TAROT" });
  const candidates = generateBalatrobotCandidates(exact);
  const rescue = candidates.find((candidate) => candidate.action.method === "use");
  const play = candidates.find((candidate) => candidate.action.method === "play");
  assert.equal(rescue.action.consumable, 0);
  assert.ok(rescue.action.cards.length >= 1 && rescue.action.cards.length <= 3);
  assert.equal(rescue.projectedPlay.handType, "Flush");
  assert.ok(rescue.projectedScore >= 1_502);
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "play", params: { cards: play.action.cards } }, candidates, exact),
    /lifesaving emergency consumable/,
  );
  const mode = balatrobotThinkingMode(exact, candidates, {
    balatrobotStrategicThinkingEnabled: true,
    balatrobotStrategicReasoningEffort: "high",
  });
  assert.equal(mode.strategic, true);
  assert.equal(mode.checkpointPhase, "blind");
});

test("survival guard demands a discard when every play is far below pace", () => {
  const exact = state(
    [card("6", "H"), card("6", "S"), card("K", "D"), card("4", "C"), card("2", "H")],
    { handsLeft: 4, discards: 3, blind: { type: "SMALL", status: "CURRENT", score: 600 } },
  );
  const candidates = generateBalatrobotCandidates(exact);
  const pair = candidates.find((candidate) => candidate.id === "play:0,1");
  const discard = candidates.find((candidate) => candidate.action.method === "discard");
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "play", params: { cards: pair.action.cards } }, candidates, exact),
    /discard to improve first/,
  );
  assert.doesNotThrow(
    () => assertBalatrobotCandidateAction({ method: "discard", params: { cards: discard.action.cards } }, candidates, exact),
  );
});

test("routine ranking only receives candidates accepted by the survival guard", () => {
  const behind = state(
    [card("6", "H"), card("6", "S"), card("K", "D"), card("4", "C"), card("2", "H")],
    { handsLeft: 4, discards: 3, blind: { type: "SMALL", status: "CURRENT", name: "Small Blind", score: 600 } },
  );
  const behindGenerated = generateBalatrobotCandidates(behind);
  const behindExecutable = filterBalatrobotExecutableCandidates(behind, behindGenerated);
  assert.ok(behindExecutable.length > 0);
  assert.ok(behindExecutable.every((candidate) => candidate.action.method === "discard"));
  assert.ok(behindExecutable.every((candidate) =>
    assert.doesNotThrow(() => assertBalatrobotCandidateAction(
      { method: candidate.action.method, params: { cards: candidate.action.cards } },
      behindGenerated,
      behind,
    )) === undefined));

  const safe = state(
    [card("A", "H"), card("A", "D"), card("Q", "S"), card("Q", "D"), card("9", "C"), card("4", "S")],
    { chips: 96, handsLeft: 3, discards: 2, blind: { type: "SMALL", status: "CURRENT", name: "Small Blind", score: 300 } },
  );
  const safeExecutable = filterBalatrobotExecutableCandidates(safe, generateBalatrobotCandidates(safe));
  assert.ok(safeExecutable.length > 0);
  assert.ok(safeExecutable.every((candidate) => candidate.action.method !== "discard"));
});

test("routine hands stay fast while Boss and guaranteed rescue states enable strategic thinking", () => {
  const simpleState = state([card("A", "H"), card("A", "S"), card("2", "C")]);
  const candidates = generateBalatrobotCandidates(simpleState);
  const config = {
    balatrobotStrategicThinkingEnabled: true,
    balatrobotStrategicReasoningEffort: "high",
    balatrobotRoutineReasoningEffort: "none",
  };
  assert.deepEqual(balatrobotThinkingMode(simpleState, candidates, config), {
    strategic: false,
    effort: "none",
    reason: "local candidate solver ranks play versus discard",
  });
  const setup = state(simpleState.hand.cards, { handsPlayed: 0, discardsUsed: 0 });
  assert.equal(balatrobotThinkingMode(setup, candidates, config).strategic, false);
  const comfortablyAhead = state(simpleState.hand.cards, {
    chips: 240,
    blind: { type: "SMALL", status: "CURRENT", score: 300 },
    jokers: [{ key: "j_walkie_talkie" }],
  });
  assert.equal(balatrobotThinkingMode(comfortablyAhead, candidates, config).effort, "none");
  const behindRequiredPace = state(simpleState.hand.cards, {
    chips: 0,
    blind: { type: "SMALL", status: "CURRENT", score: 300 },
  });
  assert.match(balatrobotThinkingMode(behindRequiredPace, candidates, config).reason, /local survival solver/);
  const boss = state(simpleState.hand.cards, { blind: { type: "BOSS", status: "CURRENT", score: 300 } });
  assert.equal(balatrobotThinkingMode(boss, candidates, config).strategic, true);
});

test("early blind selection stays fast while a developed-run skip reward gets strategic valuation", () => {
  const config = {
    balatrobotStrategicThinkingEnabled: true,
    balatrobotStrategicReasoningEffort: "high",
    balatrobotRoutineReasoningEffort: "none",
  };
  const blindSelect = {
    state: "BLIND_SELECT",
    ante_num: 1,
    blinds: { small: { type: "SMALL", status: "SELECT", tagName: "Charm Tag" } },
  };
  assert.equal(balatrobotThinkingMode(blindSelect, [], config).effort, "none");
  assert.equal(balatrobotThinkingMode({ ...blindSelect, ante_num: 2 }, [], config).effort, "high");
});

test("routine navigation and shop choices are exposed only as local candidate ids", () => {
  const blind = {
    state: "BLIND_SELECT",
    blinds: { small: { type: "SMALL", status: "SELECT", name: "Small Blind" } },
  };
  assert.deepEqual(generateBalatrobotCandidates(blind).map((candidate) => candidate.id), ["select:current"]);

  const shop = {
    state: "SHOP",
    money: 10,
    round: { reroll_cost: 5 },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: {
      cards: [{ key: "j_jolly", set: "JOKER", label: "Jolly Joker", value: { effect: "+8 Mult" }, modifier: {}, cost: { buy: 4 } }],
    },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const candidates = generateBalatrobotCandidates(shop);
  assert.ok(candidates.some((candidate) => candidate.id === "buy:card:0" && candidate.requiresStrategic));
  assert.ok(candidates.some((candidate) => candidate.id === "reroll:shop" && candidate.requiresStrategic));
  assert.ok(candidates.some((candidate) => candidate.id === "next_round:shop" && candidate.requiresStrategic));
  assert.equal(candidates.some((candidate) => candidate.action.method === "sell"), false);
});

test("celestial pack fallback follows the committed hand route and skips unrelated planets", () => {
  const exact = {
    state: "SMODS_BOOSTER_OPENED",
    hands: {
      Pair: { level: 2, chips: 25, mult: 3, played: 8 },
      "Two Pair": { level: 4, chips: 80, mult: 5, played: 14 },
      "High Card": { level: 1, chips: 5, mult: 1, played: 2 },
    },
    jokers: { count: 1, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    pack: {
      cards: [
        { key: "c_pluto", label: "Pluto", set: "PLANET" },
        { key: "c_mercury", label: "Mercury", set: "PLANET" },
        { key: "c_uranus", label: "Uranus", set: "PLANET" },
      ],
    },
  };
  const runPlan = { buildGoal: "以两对为稳定主线，优先升级 Two Pair" };
  const choices = generateBalatrobotPackCandidates(exact, { runPlan, limit: 12 });
  assert.equal(choices[0].card.key, "c_uranus");
  assert.equal(choices[0].planRelevance, "primary");
  assert.ok(choices.some((candidate) => candidate.card?.key === "c_mercury" && candidate.planRelevance === "support"));
  assert.ok(choices.some((candidate) => candidate.card?.key === "c_pluto" && candidate.planRelevance === "unrelated"));

  const fallbackOnly = generateBalatrobotPackCandidates({
    ...exact,
    pack: { cards: [{ key: "c_pluto", label: "Pluto", set: "PLANET" }] },
  }, { runPlan });
  assert.deepEqual(fallbackOnly.map((candidate) => candidate.id), ["pack:0", "pack:skip"]);
});

test("compound planet route names do not also promote their substring hands", () => {
  const exact = {
    state: "SMODS_BOOSTER_OPENED",
    hands: {},
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    pack: { cards: [
      { key: "c_neptune", label: "Neptune", set: "PLANET" },
      { key: "c_saturn", label: "Saturn", set: "PLANET" },
      { key: "c_jupiter", label: "Jupiter", set: "PLANET" },
    ] },
  };
  const choices = generateBalatrobotPackCandidates(exact, {
    runPlan: { buildGoal: "Straight Flush / 同花顺主线" },
  });
  assert.equal(choices[0].card.key, "c_neptune");
  assert.equal(choices.find((item) => item.card?.key === "c_saturn").planRelevance, "unrelated");
  assert.equal(choices.find((item) => item.card?.key === "c_jupiter").planRelevance, "unrelated");
});

test("shop counterfactual values multiplicative engines and offers a verified full-slot replacement", () => {
  const shop = {
    state: "SHOP",
    ante_num: 6,
    money: 20,
    round: { reroll_cost: 5 },
    hands: { Pair: { level: 5, chips: 70, mult: 6, played: 20 } },
    jokers: {
      count: 2,
      limit: 2,
      cards: [
        { key: "j_joker", label: "Joker", set: "JOKER", value: { effect: "+4 Mult" }, modifier: {}, state: {}, cost: { sell: 1 } },
        { key: "j_jolly", label: "Jolly Joker", set: "JOKER", value: { effect: "+8 Mult" }, modifier: {}, state: {}, cost: { sell: 2 } },
      ],
    },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: {
      cards: [{ key: "j_cavendish", label: "Cavendish", set: "JOKER", value: { effect: "X3 Mult" }, modifier: {}, state: {}, cost: { buy: 4 } }],
    },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const candidates = generateBalatrobotCandidates(shop, { limit: 20 });
  const replacement = candidates.find((candidate) => candidate.action.method === "sell");
  assert.ok(replacement);
  assert.equal(replacement.requiresStrategic, true);
  assert.equal(replacement.replacement.key, "j_cavendish");
  assert.ok(replacement.replacement.engineDelta > 0);
  assert.equal(candidates.some((candidate) => candidate.id === "buy:card:0"), false);
});

test("high-score chase may discard a safe late-game line only with a retained survival floor", () => {
  const exact = state(
    [card("A", "H"), card("A", "D"), card("K", "S"), card("Q", "C"), card("4", "D"), card("2", "C")],
    {
      chips: 920,
      handsLeft: 3,
      discards: 2,
      blind: { type: "BIG", status: "CURRENT", name: "Big Blind", score: 1_000 },
      remaining: [card("A", "S"), card("A", "C"), card("K", "H")],
    },
  );
  exact.ante_num = 6;
  exact.hands = { Pair: { chips: 10, mult: 2, level: 4 } };
  const candidates = generateBalatrobotCandidates(exact, { limit: 30 });
  const chase = candidates.find((candidate) =>
    candidate.action.method === "discard" && candidate.survivalFloorScore > 0 && candidate.exactRemainingDeckOuts > 0);
  assert.ok(chase);
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "discard", params: { cards: chase.action.cards } },
    candidates,
    exact,
  ));

  const early = { ...exact, ante_num: 2 };
  const earlyCandidates = generateBalatrobotCandidates(early, { limit: 30 });
  const earlyChase = earlyCandidates.find((candidate) =>
    candidate.action.method === "discard" && candidate.survivalFloorScore > 0 && candidate.exactRemainingDeckOuts > 0);
  assert.throws(() => assertBalatrobotCandidateAction(
    { method: "discard", params: { cards: earlyChase.action.cards } },
    earlyCandidates,
    early,
  ), /already clears|safely exceeds/);
});

test("full-slot replacement never sells Credit Card for an offer that becomes unaffordable", () => {
  const exact = {
    state: "SHOP",
    ante_num: 6,
    money: 0,
    round: { reroll_cost: 5 },
    jokers: {
      count: 2,
      limit: 2,
      cards: [
        { key: "j_credit_card", label: "Credit Card", set: "JOKER", modifier: {}, cost: { sell: 1 } },
        { key: "j_joker", label: "Joker", set: "JOKER", value: { effect: "+4 Mult" }, modifier: {}, cost: { sell: 1 } },
      ],
    },
    shop: {
      cards: [{ key: "j_cavendish", label: "Cavendish", set: "JOKER", value: { effect: "X3 Mult" }, modifier: {}, cost: { buy: 15 } }],
    },
    vouchers: { cards: [] },
    packs: { cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    hands: {},
  };
  const candidates = generateBalatrobotCandidates(exact, { limit: 30 });
  assert.equal(candidates.some((candidate) => candidate.action.method === "sell" && candidate.action.joker === 0), false);
});

test("score telemetry includes known retriggers from Chad and Red Seal", () => {
  const exact = state(
    [card("K", "H", { edition: null }), card("K", "D"), card("2", "C")],
    { discards: 0, jokers: [{ key: "j_hanging_chad" }, { key: "j_photograph" }] },
  );
  exact.hand.cards[0].modifier.seal = "RED";
  const pair = generateBalatrobotCandidates(exact).find((candidate) => candidate.id === "play:0,1");
  assert.equal(pair.knownRetriggers, 3);
  assert.deepEqual(pair.knownRetriggerSources, ["j_hanging_chad", "red_seal"]);
});

test("1BFYM79X regression: Smeared mixed-black flushes are classified and scored exactly", () => {
  const exact = state([
    card("J", "D"), card("T", "S"), card("7", "S"), card("6", "D"),
    card("5", "S"), card("5", "C"), card("3", "D"), card("2", "C"),
  ], { discards: 0, jokers: [{ key: "j_smeared" }] });
  exact.hands = { Flush: { chips: 65, mult: 8 } };
  const flush = generateBalatrobotCandidates(exact, { limit: 30 }).find((candidate) => candidate.id === "play:1,2,4,5,7");
  assert.equal(flush.handType, "Flush");
  assert.deepEqual(flush.rulesApplied, ["smeared-suits"]);
  assert.equal(flush.conservativeScore, 752);

  exact.hand.cards = [
    card("A", "C"), card("K", "S"), card("Q", "C"), card("J", "S"),
    card("T", "S"), card("7", "S"), card("5", "C"), card("4", "C"),
  ];
  exact.hands["Straight Flush"] = { chips: 100, mult: 8 };
  const royal = generateBalatrobotCandidates(exact, { limit: 30 }).find((candidate) => candidate.id === "play:0,1,2,3,4");
  assert.equal(royal.handType, "Straight Flush");
  assert.equal(royal.conservativeScore, 1_208);
});

test("HXZHF43Y regression: whole-round budget preserves the last useful discard", () => {
  const exact = state([
    card("A", "D"), card("K", "S", { debuff: true }), card("K", "C"), card("T", "D"),
    card("8", "H"), card("8", "D"), card("7", "S", { debuff: true }), card("2", "D", { debuff: true }),
  ], {
    discards: 1,
    handsLeft: 5,
    chips: 0,
    jokers: [{ key: "j_droll" }, { key: "j_crazy" }],
    blind: { type: "BOSS", status: "CURRENT", name: "The Pillar", score: 600 },
    remaining: [card("Q", "D"), card("9", "D"), card("6", "D"), card("4", "C")],
  });
  const candidates = generateBalatrobotCandidates(exact, { limit: 30 });
  const assessment = balatrobotSurvivalAssessment(exact, candidates);
  assert.equal(assessment.bestScore, 92);
  assert.equal(assessment.projectedRemaining, 460);
  assert.equal(assessment.currentLineCanClear, false);
  assert.equal(assessment.shouldDiscard, true);
  assert.deepEqual(assessment.discard.action.cards, [1, 2, 4, 6]);
});
