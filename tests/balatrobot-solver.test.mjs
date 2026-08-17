import test from "node:test";
import assert from "node:assert/strict";

import {
  assertBalatrobotCandidateAction,
  balatrobotHighScoreBuildProfile,
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

test("candidate guard rejects hallucinated hand and non-hand actions", () => {
  const candidates = generateBalatrobotCandidates(state([card("6", "H"), card("6", "S"), card("K", "D")]));
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "play", params: { cards: [1] } }, candidates),
    /locally enumerated candidate/,
  );
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "use", params: { consumable: 0 } }, candidates),
    /must exactly match one locally enumerated candidate/,
  );
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

test("Director's Cut and Retcon expose an exact strategic Boss reroll candidate", () => {
  const base = {
    state: "BLIND_SELECT",
    money: 18,
    boss_rerolled: false,
    used_vouchers: { v_directors_cut: "" },
    blinds: { boss: { type: "BOSS", status: "SELECT", name: "The Plant", effect: "All face cards are debuffed" } },
  };
  const candidates = generateBalatrobotCandidates(base);
  const reroll = candidates.find((candidate) => candidate.action.method === "reroll_boss");
  assert.ok(reroll?.requiresStrategic);
  assert.deepEqual(
    balatrobotThinkingMode(base, candidates, {
      balatrobotStrategicThinkingEnabled: true,
      balatrobotStrategicReasoningEffort: "high",
      balatrobotRoutineReasoningEffort: "none",
    }),
    { strategic: true, effort: "high", reason: "Boss reroll needs strategic approval" },
  );
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "reroll_boss", params: {} },
    candidates,
    base,
  ));
  assert.equal(generateBalatrobotCandidates({ ...base, boss_rerolled: true }).some(
    (candidate) => candidate.action.method === "reroll_boss"), false);
  assert.ok(generateBalatrobotCandidates({
    ...base,
    boss_rerolled: true,
    used_vouchers: { v_retcon: "" },
  }).some((candidate) => candidate.action.method === "reroll_boss"));
  assert.equal(generateBalatrobotCandidates({ ...base, money: 9 }).some(
    (candidate) => candidate.action.method === "reroll_boss"), false);

  const creditCard = () => ({
    key: "j_credit_card",
    label: "Credit Card",
    set: "JOKER",
    modifier: {},
    state: {},
  });
  const stackedCredit = {
    ...base,
    money: -25,
    jokers: { count: 2, limit: 5, cards: [creditCard(), creditCard()] },
  };
  assert.ok(generateBalatrobotCandidates(stackedCredit).some(
    (candidate) => candidate.action.method === "reroll_boss"),
  "a strategic Boss reroll may use the exact legal liquidity from multiple Credit Cards");
  assert.equal(generateBalatrobotCandidates({
    ...stackedCredit,
    jokers: { count: 1, limit: 5, cards: [creditCard()] },
  }).some((candidate) => candidate.action.method === "reroll_boss"), false);
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
  assert.equal(candidates.some((candidate) => candidate.id === "reroll:shop"), false);
  assert.ok(candidates.some((candidate) => candidate.id === "next_round:shop" && candidate.requiresStrategic));
  assert.equal(candidates.some((candidate) => candidate.action.method === "sell"), false);
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "buy", params: { card: 0 } },
    candidates,
    shop,
  ));
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "buy", params: { card: 1 } }, candidates, shop),
    /must exactly match one locally enumerated candidate/,
  );
});

test("Gold blind candidates expose the zero Small Blind reward and exact skip opportunity cost", () => {
  const gold = {
    state: "BLIND_SELECT",
    stake: "GOLD",
    ante_num: 2,
    round: { hands_left: 4 },
    jokers: { count: 3, limit: 5, cards: [
      { key: "j_joker", set: "JOKER", modifier: {}, state: {} },
      { key: "j_walkie_talkie", set: "JOKER", modifier: {}, state: {} },
      { key: "j_credit_card", set: "JOKER", modifier: {}, state: {} },
    ] },
    blinds: {
      small: {
        type: "SMALL",
        status: "SELECT",
        name: "Small Blind",
        tagName: "Rare Tag",
        tagEffect: "The shop has a free Rare Joker",
      },
    },
  };
  const candidates = generateBalatrobotCandidates(gold);
  const select = candidates.find((candidate) => candidate.action.method === "select");
  const skip = candidates.find((candidate) => candidate.action.method === "skip");
  assert.equal(select.economy.smallBlindReward, 0);
  assert.equal(select.economy.maximumRemainingHandMoney, 4);
  assert.match(select.strategicReason, /fixed reward is \$0.*post-blind shop.*unused hands/iu);
  assert.equal(skip.requiresStrategic, true);
  assert.equal(skip.fallbackSafe, false);
  assert.deepEqual(skip.skipEligibility, {
    ante: 2,
    activeJokers: 3,
    scoringJokers: 2,
    highValueTag: true,
    matureBuild: true,
  });
  assert.match(skip.strategicReason, /forfeits.*unused-hand money.*shop/iu);

  const whiteSelect = generateBalatrobotCandidates({ ...gold, stake: "WHITE" })
    .find((candidate) => candidate.action.method === "select");
  assert.equal(whiteSelect.economy.smallBlindReward, 3);
  const boss = generateBalatrobotCandidates({
    ...gold,
    blinds: { boss: { type: "BOSS", status: "SELECT", name: "The Wall", tagName: "Rare Tag" } },
  });
  assert.equal(boss.some((candidate) => candidate.action.method === "skip"), false);

  const noSkip = (stateValue) => generateBalatrobotCandidates(stateValue)
    .some((candidate) => candidate.action.method === "skip");
  assert.equal(noSkip({ ...gold, ante_num: 1 }), false);
  assert.equal(noSkip({ ...gold, jokers: { count: 0, limit: 5, cards: [] } }), false);
  assert.equal(noSkip({
    ...gold,
    blinds: { small: { ...gold.blinds.small, tagName: "Double Tag" } },
  }), false);
});

test("identical Joker offers receive distinct Eternal, Perishable, and Rental NPV", () => {
  const offer = (id, modifier) => ({
    id,
    key: "j_jolly",
    label: "Jolly Joker",
    set: "JOKER",
    value: { effect: "+8 Mult if hand contains a Pair" },
    modifier,
    state: {},
    cost: { buy: 1, sell: 1 },
  });
  const shop = {
    state: "SHOP",
    ante_num: 2,
    expected_joker_hold_blinds: 4,
    money: 40,
    round: { reroll_cost: 5 },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [
      offer(1, {}),
      offer(2, { eternal: true }),
      offer(3, { perishable: 2 }),
      offer(4, { rental: true }),
      offer(5, { eternal: true, rental: true }),
    ] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const buys = generateBalatrobotCandidates(shop, { limit: 30 })
    .filter((candidate) => candidate.action.method === "buy" && candidate.action.card != null);
  assert.equal(buys.length, 4, "Eternal+Rental is hard-rejected without measured immediate survival");
  const byId = Object.fromEntries(buys.map((candidate) => [candidate.card.id, candidate]));
  assert.equal(byId[3].card.perishable, 2);
  assert.equal(byId[4].card.rentalRate, 3);
  assert.equal(byId[4].stickerValuation.projectedRentalCost, 12);
  assert.equal(byId[2].card.eternal, true);
  assert.equal(new Set(buys.map((candidate) => candidate.expectedValue)).size, 4);
  assert.ok(byId[1].expectedValue > byId[2].expectedValue);
  assert.ok(byId[1].expectedValue > byId[3].expectedValue);
  assert.ok(byId[1].expectedValue > byId[4].expectedValue);
});

test("canonical isPerishable marker aliases preserve marker-only and expired tally zero", () => {
  const offer = (id, extra) => ({
    id,
    key: "j_jolly",
    label: "Jolly Joker",
    set: "JOKER",
    value: { effect: "+8 Mult if hand contains a Pair" },
    modifier: {},
    state: {},
    cost: { buy: 1 },
    ...extra,
  });
  const exact = {
    state: "SHOP",
    ante_num: 2,
    expected_joker_hold_blinds: 4,
    money: 40,
    round: { reroll_cost: 5 },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [
      offer(11, { modifier: { isPerishable: true } }),
      offer(12, { modifier: { is_perishable: true }, state: { perishable_tally: 0 } }),
      offer(13, { state: { isPerishable: true } }),
      offer(14, { is_perishable: true }),
    ] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const byId = Object.fromEntries(generateBalatrobotCandidates(exact, { limit: 30 })
    .filter((candidate) => candidate.action.card != null)
    .map((candidate) => [candidate.card.id, candidate]));
  for (const id of [11, 13, 14]) {
    assert.equal(byId[id].card.perishable, true);
    assert.equal(byId[id].stickerValuation.perishable, true);
    assert.equal(byId[id].stickerValuation.remainingPerishableBlinds, 5);
  }
  assert.equal(byId[12].card.perishable, 0);
  assert.equal(byId[12].stickerValuation.remainingPerishableBlinds, 0);
  assert.equal(byId[12].stickerValuation.lifespanDiscount, 0);
});

test("Eternal plus Rental is always rejected even when a local benchmark appears lifesaving", () => {
  const benchmarkState = state([
    card("A", "H"), card("A", "S"), card("2", "C"), card("3", "D"), card("4", "H"),
  ], { handsLeft: 4, handsPlayed: 0, discardsUsed: 0 });
  const play = generateBalatrobotCandidates(benchmarkState, { limit: 20 })
    .find((candidate) => candidate.action.method === "play" && candidate.handType === "Pair");
  assert.ok(play);
  const shop = {
    state: "SHOP",
    ante_num: 2,
    money: 10,
    round: { hands_left: 4, reroll_cost: 5 },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 500 } },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [{
      id: 10,
      key: "j_cavendish",
      label: "Cavendish",
      set: "JOKER",
      value: { effect: "X3 Mult" },
      modifier: { eternal: true, rental: true },
      state: {},
      cost: { buy: 1 },
    }] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const withoutEvidence = generateBalatrobotCandidates(shop, { limit: 30 });
  assert.equal(withoutEvidence.some((candidate) => candidate.id === "buy:card:0"), false);
  const withEvidence = generateBalatrobotCandidates(shop, {
    limit: 30,
    benchmarks: [{ state: benchmarkState, candidate: play }],
  });
  assert.equal(
    withEvidence.some((candidate) => candidate.id === "buy:card:0"),
    false,
    "local scoring evidence cannot prove every upcoming Blind rule",
  );

  const needle = {
    ...shop,
    blinds: { boss: { type: "BOSS", status: "UPCOMING", name: "The Needle", score: 500 } },
  };
  const needleCandidates = generateBalatrobotCandidates(needle, {
    limit: 30,
    benchmarks: [{ state: benchmarkState, candidate: play }],
  });
  assert.equal(
    needleCandidates.some((candidate) => candidate.id === "buy:card:0"),
    false,
    "The Needle must use one hand, never the four-hand benchmark capacity",
  );

  const plant = {
    ...shop,
    blinds: { boss: { type: "BOSS", status: "UPCOMING", name: "The Plant", score: 400 } },
  };
  assert.equal(generateBalatrobotCandidates(plant, {
    limit: 30,
    benchmarks: [{ state: benchmarkState, candidate: play }],
  }).some((candidate) => candidate.id === "buy:card:0"), false);
});

test("Rental and expiring Joker stop-loss works with open slots but never sells Eternal", () => {
  const owned = (id, modifier, state = {}) => ({
    id,
    key: `j_owned_${id}`,
    label: `Owned ${id}`,
    set: "JOKER",
    value: { effect: "utility effect" },
    modifier,
    state,
    cost: { sell: 1 },
  });
  const shop = {
    state: "SHOP",
    ante_num: 3,
    money: 4,
    round: { reroll_cost: 5 },
    jokers: { count: 4, limit: 5, cards: [
      owned(1, { rental: true }),
      owned(2, { perishable: 1, rental: true }),
      owned(3, { perishable: 0, rental: true }, { debuff: true }),
      owned(4, { eternal: true, rental: true }),
    ] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const candidates = generateBalatrobotCandidates(shop, { limit: 30 });
  const sales = candidates.filter((candidate) => candidate.action.method === "sell" && candidate.action.joker != null);
  assert.deepEqual(sales.map((candidate) => candidate.action.joker).toSorted(), [0, 1, 2]);
  assert.ok(sales.every((candidate) => candidate.requiresStrategic && candidate.fallbackSafe === false));
  assert.equal(sales.find((candidate) => candidate.action.joker === 2).card.perishable, 0);
  assert.equal(sales.find((candidate) => candidate.action.joker === 2).stopLoss.expired, true);
  assert.equal(candidates.some((candidate) => candidate.action.joker === 3), false);
});

test("a Rental scoring core is never offered as stop-loss when removal loses the next Blind", () => {
  const benchmarkState = state([
    card("A", "H"), card("A", "S"), card("2", "C"), card("3", "D"), card("4", "H"),
  ], { handsLeft: 4, handsPlayed: 0, discardsUsed: 0 });
  const play = generateBalatrobotCandidates(benchmarkState, { limit: 20 })
    .find((candidate) => candidate.action.method === "play" && candidate.handType === "Pair");
  const cavendish = {
    key: "j_cavendish",
    label: "Cavendish",
    set: "JOKER",
    value: { effect: "X3 Mult" },
    modifier: { rental: true },
    state: {},
    cost: { sell: 2 },
  };
  const shop = {
    state: "SHOP",
    ante_num: 2,
    money: 20,
    round: { reroll_cost: 5 },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 500 } },
    jokers: { count: 1, limit: 5, cards: [cavendish] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const measured = generateBalatrobotCandidates(shop, {
    limit: 30,
    benchmarks: [{ state: benchmarkState, candidate: play }],
  });
  assert.equal(measured.some((candidate) => candidate.action.method === "sell"), false);
  assert.equal(
    generateBalatrobotCandidates(shop, { limit: 30 }).some((candidate) => candidate.action.method === "sell"),
    false,
    "without exact evidence, a scoring Rental fails closed instead of becoming a high-EV sale",
  );

  const comfortablyClearing = {
    ...shop,
    jokers: { count: 2, limit: 5, cards: [{
      key: "j_large_mult",
      label: "Large Mult",
      set: "JOKER",
      value: { effect: "+100 Mult" },
      modifier: {},
      state: {},
    }, cavendish] },
  };
  assert.equal(generateBalatrobotCandidates(comfortablyClearing, {
    limit: 30,
    benchmarks: [{ state: benchmarkState, candidate: play }],
  }).some((candidate) => candidate.action.method === "sell" && candidate.action.joker === 1), false,
  "clearing the next Blind without Cavendish does not justify destroying a long-lived XMult layer");
});

test("unquantified recurring economy Rentals fail closed until they are actually expired", () => {
  const rental = (key, effect) => ({
    key,
    label: key,
    set: "JOKER",
    value: { effect },
    modifier: { rental: true },
    state: {},
    cost: { sell: 1 },
  });
  const economy = [
    rental("j_cloud_9", "Earn $1 for each 9 in your full deck at end of round"),
    rental("j_to_the_moon", "Earn an extra $1 of interest for every $5 you have at end of round"),
    rental("j_delayed_gratification", "Earn $2 per discard if no discards are used by end of the round"),
    rental("j_business", "Played face cards have a 1 in 2 chance to give $2 when scored"),
  ];
  const exact = {
    state: "SHOP",
    ante_num: 3,
    money: 20,
    round: { reroll_cost: 5 },
    jokers: { count: economy.length, limit: 5, cards: economy },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  assert.equal(generateBalatrobotCandidates(exact, { limit: 30 }).some(
    (candidate) => candidate.action.method === "sell"), false);

  const benchmarkState = state([
    card("A", "H"), card("A", "S"), card("2", "C"), card("3", "D"), card("4", "H"),
  ], { handsLeft: 4, handsPlayed: 0, discardsUsed: 0 });
  const play = generateBalatrobotCandidates(benchmarkState, { limit: 20 })
    .find((candidate) => candidate.action.method === "play" && candidate.handType === "Pair");
  const profitableRental = {
    ...exact,
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 100 } },
    jokers: { count: 1, limit: 5, cards: [
      rental("j_golden", "Earn $4 at end of round"),
    ] },
  };
  assert.equal(generateBalatrobotCandidates(profitableRental, {
    limit: 30,
    benchmarks: [{ state: benchmarkState, candidate: play }],
  }).some((candidate) => candidate.action.method === "sell"), false,
  "a low next-Blind target never justifies selling fixed income above its Rental upkeep");

  const expired = {
    ...exact,
    jokers: { count: 1, limit: 5, cards: [{
      ...economy[0],
      modifier: { rental: true, perishable: 0 },
      state: { debuff: true },
    }] },
  };
  assert.ok(generateBalatrobotCandidates(expired, { limit: 30 }).some(
    (candidate) => candidate.action.method === "sell" && candidate.action.joker === 0));
});

test("shop money reserves Rental upkeep across negative cash and stacked Credit Cards", () => {
  const creditCard = () => ({ key: "j_credit_card", label: "Credit Card", set: "JOKER", modifier: {}, state: {}, cost: { sell: 1 } });
  const rental = { key: "j_rental", label: "Rental", set: "JOKER", modifier: { rental: true }, state: {}, cost: { sell: 1 } };
  const exact = {
    state: "SHOP",
    ante_num: 3,
    money: -32,
    round: { reroll_cost: 3 },
    jokers: { count: 3, limit: 5, cards: [creditCard(), creditCard(), rental] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [
      { id: 1, key: "j_joker", label: "Joker", set: "JOKER", modifier: {}, state: {}, cost: { buy: 2 } },
      { id: 2, key: "j_jolly", label: "Jolly", set: "JOKER", modifier: { rental: true }, state: {}, cost: { buy: 1 } },
    ] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const stacked = generateBalatrobotCandidates(exact, { limit: 30 });
  assert.ok(stacked.some((candidate) => candidate.id === "buy:card:0"));
  assert.equal(stacked.some((candidate) => candidate.id === "buy:card:1"), false);
  const budget = stacked.find((candidate) => candidate.id === "buy:card:0").shopBudget;
  assert.equal(budget.cash, -32);
  assert.equal(budget.credit, 40);
  assert.equal(budget.rentalUpkeep, 3);
  assert.equal(budget.twoBlindUpkeep, 6);
  assert.equal(budget.projectedRentalUpkeep, 6);
  assert.equal(budget.available, 2);
  assert.equal(budget.purchaseCommitment, 2);
  assert.equal(budget.availableAfterPurchase, 0);
  exact.jokers.cards.splice(0, 1);
  exact.jokers.count = 2;
  const oneCredit = generateBalatrobotCandidates(exact, { limit: 30 });
  assert.equal(oneCredit.some((candidate) => candidate.action.method === "buy"), false);
  assert.equal(oneCredit.some((candidate) => candidate.action.method === "reroll"), false);
});

test("the second Rental payment cannot be spent, while genuinely free resources remain legal", () => {
  const rental = { key: "j_utility", label: "Utility", set: "JOKER", modifier: { rental: true }, state: {}, cost: { sell: 1 } };
  const base = {
    state: "SHOP",
    ante_num: 3,
    money: 7,
    round: { reroll_cost: 5 },
    jokers: { count: 1, limit: 5, cards: [rental] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [
      { key: "j_two", label: "Costs Two", set: "JOKER", modifier: {}, state: {}, cost: { buy: 2 } },
      { key: "j_one", label: "Costs One", set: "JOKER", modifier: {}, state: {}, cost: { buy: 1 } },
    ] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const reserved = generateBalatrobotCandidates(base, { limit: 30 });
  assert.equal(reserved.some((candidate) => candidate.id === "buy:card:0"), false);
  assert.ok(reserved.some((candidate) => candidate.id === "buy:card:1"));
  assert.equal(reserved.find((candidate) => candidate.id === "buy:card:1").shopBudget.twoBlindUpkeep, 6);

  const free = {
    ...base,
    money: -1,
    jokers: { count: 0, limit: 5, cards: [] },
    shop: { cards: [
      { key: "j_free", label: "Free Joker", set: "JOKER", modifier: {}, state: {}, cost: { buy: 0 } },
      { key: "j_free_rental", label: "Free Rental", set: "JOKER", modifier: { rental: true }, state: {}, cost: { buy: 0 } },
    ] },
    vouchers: { cards: [{ key: "v_free", label: "Free Voucher", set: "VOUCHER", cost: { buy: 0 } }] },
    packs: { cards: [{ key: "p_free", label: "Free Pack", set: "BOOSTER", cost: { buy: 0 } }] },
  };
  const freeCandidates = generateBalatrobotCandidates(free, { limit: 30 });
  assert.ok(freeCandidates.some((candidate) => candidate.id === "buy:card:0"));
  assert.equal(freeCandidates.some((candidate) => candidate.id === "buy:card:1"), false);
  assert.ok(freeCandidates.some((candidate) => candidate.id === "buy:voucher:0"));
  assert.ok(freeCandidates.some((candidate) => candidate.id === "buy:pack:0"));
});

test("buy_use and paid rerolls share the two-Blind reserve, but a needed free reroll bypasses cash", () => {
  const rental = { key: "j_utility", label: "Utility", set: "JOKER", modifier: { rental: true }, state: {}, cost: { sell: 1 } };
  const shop = {
    state: "SHOP",
    ante_num: 3,
    money: 10,
    round: { reroll_cost: 5 },
    hands: { Flush: { chips: 35, mult: 4, played: 3 } },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 4_800 } },
    jokers: { count: 1, limit: 5, cards: [rental] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [{ key: "c_hermit", label: "The Hermit", set: "TAROT", modifier: {}, cost: { buy: 4 } }] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const blocked = generateBalatrobotCandidates(shop, { limit: 30 });
  assert.equal(blocked.some((candidate) => candidate.action.method === "buy_use"), true, "cash 10 leaves $4 after two rents");
  assert.equal(blocked.some((candidate) => candidate.action.method === "reroll"), false);
  assert.equal(blocked.find((candidate) => candidate.action.method === "next_round").shopBudget.rerollBudget, 0);

  const tighter = { ...shop, money: 4 };
  const upkeepBlocked = generateBalatrobotCandidates(tighter, { limit: 30 });
  assert.equal(upkeepBlocked.some((candidate) => candidate.action.method === "buy_use"), false);
  tighter.shop.cards[0].cost.buy = 0;
  const freeBuyUse = generateBalatrobotCandidates(tighter, { limit: 30 });
  assert.ok(freeBuyUse.some((candidate) => candidate.action.method === "buy_use"));

  const freeReroll = {
    ...shop,
    money: -1,
    round: { reroll_cost: 0 },
    shop: { cards: [] },
  };
  const freeRerollCandidates = generateBalatrobotCandidates(freeReroll, { limit: 30 });
  assert.ok(freeRerollCandidates.some((candidate) => candidate.action.method === "reroll"));
  assert.ok(freeRerollCandidates.find((candidate) => candidate.action.method === "reroll").shopBudget.available < 0);
});

test("an explicitly free reroll is never wasted, while a missing price is not fabricated as free", () => {
  const emptyShop = {
    state: "SHOP",
    ante_num: 2,
    money: -1,
    round: { reroll_cost: 0 },
    hands: { Pair: { chips: 10, mult: 2, played: 2 } },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 50 } },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const free = generateBalatrobotCandidates(emptyShop, { limit: 30 });
  const reroll = free.find((candidate) => candidate.action.method === "reroll");
  assert.ok(reroll);
  assert.equal(reroll.rerollDecision.rerollCost, 0);
  assert.equal(reroll.rerollDecision.rerollCostKnown, true);

  const missing = generateBalatrobotCandidates({ ...emptyShop, round: {} }, { limit: 30 });
  assert.equal(missing.some((candidate) => candidate.action.method === "reroll"), false);
  assert.equal(missing.find((candidate) => candidate.action.method === "next_round")
    .shopBudget.rerollDecision.rerollCostKnown, false);

  const refreshed = generateBalatrobotCandidates({
    ...emptyShop,
    money: 4,
    round: { reroll_cost: 5 },
  }, { limit: 30 });
  assert.equal(refreshed.some((candidate) => candidate.action.method === "reroll"), false);
});

test("future engine profile discounts a one-blind Perishable and exposes Rental upkeep", () => {
  const base = {
    state: "SHOP",
    ante_num: 2,
    expected_joker_hold_blinds: 5,
    jokers: { count: 1, limit: 5, cards: [{
      key: "j_cavendish",
      label: "Cavendish",
      set: "JOKER",
      value: { effect: "X3 Mult" },
      modifier: { rental: true },
      state: {},
    }] },
    hands: {},
  };
  const clean = balatrobotHighScoreBuildProfile(base);
  const expiring = balatrobotHighScoreBuildProfile({
    ...base,
    jokers: { ...base.jokers, cards: [{ ...base.jokers.cards[0], modifier: { perishable: 1, rental: true } }] },
  });
  const expired = balatrobotHighScoreBuildProfile({
    ...base,
    jokers: { ...base.jokers, cards: [{ ...base.jokers.cards[0], modifier: { perishable: 0, rental: true }, state: { debuff: true } }] },
  });
  assert.ok(clean.engineScore > expiring.engineScore);
  assert.equal(expiring.futureXMultSources, 0.2);
  assert.equal(expiring.layers.xMult, false);
  assert.equal(clean.rentalUpkeepPerBlind, 3);
  assert.equal(clean.projectedRentalUpkeep, 15);
  assert.equal(expired.engineScore, 0);
});

test("an expired Perishable still occupies its Joker slot when deciding whether to reroll", () => {
  const utility = (key, modifier = {}, state = {}) => ({
    key,
    label: key,
    set: "JOKER",
    value: { effect: "utility effect" },
    modifier,
    state,
  });
  const exact = {
    state: "SHOP",
    ante_num: 3,
    money: 100,
    round: { reroll_cost: 5 },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 140 } },
    hands: {},
    // The deliberately stale count proves visible cards are never ignored.
    jokers: { count: 4, limit: 5, cards: [
      utility("j_one"),
      utility("j_two"),
      utility("j_three"),
      utility("j_four"),
      utility("j_expired", { perishable: 0 }, { debuff: true }),
    ] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { cards: [{ key: "j_offer", label: "Offer", set: "JOKER", modifier: {}, cost: { buy: 0 } }] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const candidates = generateBalatrobotCandidates(exact, { limit: 30 });
  assert.equal(candidates.some((candidate) => candidate.id === "buy:card:0"), false);
  assert.equal(candidates.some((candidate) => candidate.id === "reroll:shop"), false);
});

test("full old consumable slots expose one strategic sale without ever selling rescue or premium cards", () => {
  const shop = {
    state: "SHOP",
    seed: "AGED-SHOP",
    ante_num: 4,
    round_num: 10,
    money: 20,
    round: { reroll_cost: 1 },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: {
      count: 2,
      limit: 2,
      cards: [
        { id: 201, key: "c_tower", label: "The Tower", set: "TAROT", modifier: {}, cost: { sell: 1 } },
        { id: 202, key: "c_sun", label: "The Sun", set: "TAROT", modifier: {}, cost: { sell: 1 } },
      ],
    },
    shop: { cards: Array.from({ length: 12 }, (_, index) => ({
      id: 300 + index,
      key: `j_shop_${index}`,
      label: `Shop Joker ${index}`,
      set: "JOKER",
      modifier: {},
      cost: { buy: 1 },
    })) },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const consumableAges = {
    byId: {
      201: { id: 201, key: "c_tower", tracked: true, blindAge: 3, firstSeenRound: 7 },
      202: { id: 202, key: "c_sun", tracked: true, blindAge: 4, firstSeenRound: 6 },
    },
  };
  const candidates = generateBalatrobotCandidates(shop, { limit: 4, consumableAges });
  const sales = candidates.filter((candidate) => candidate.action.method === "sell" && candidate.action.consumable != null);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].card.id, 201);
  assert.equal(sales[0].requiresStrategic, true);
  assert.equal(sales[0].fallbackSafe, false);
  assert.equal(candidates.some((candidate) => candidate.action.consumable === 1), false);
  assert.ok(candidates.some((candidate) => candidate.action.method === "next_round"));
  const mode = balatrobotThinkingMode(shop, candidates, {
    balatrobotRoutineReasoningEffort: "none",
    balatrobotStrategicReasoningEffort: "high",
  });
  assert.equal(mode.ignorePersistedCheckpoint, true);
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "sell", params: { consumable: 0 } },
    candidates,
    shop,
  ));
});

test("many strategic consumables never crowd every ordinary hand action out", () => {
  const exact = state([
    card("A", "H"), card("K", "S"), card("Q", "D"), card("J", "C"), card("9", "H"), card("2", "C"),
  ]);
  exact.seed = "NEGATIVE-CONSUMABLES";
  exact.round_num = 9;
  exact.consumables = {
    count: 4,
    limit: 4,
    cards: ["c_justice", "c_chariot", "c_devil", "c_tower"].map((key, index) => ({
      id: 300 + index,
      key,
      label: key,
      set: "TAROT",
      modifier: { edition: "NEGATIVE" },
    })),
  };
  const consumableAges = { byId: Object.fromEntries(exact.consumables.cards.map((item) => [
    item.id,
    { id: item.id, key: item.key, tracked: true, blindAge: 3 },
  ])) };
  const candidates = generateBalatrobotCandidates(exact, { limit: 6, consumableAges });
  assert.ok(candidates.some((candidate) => candidate.action?.method === "play"));
  assert.ok(candidates.some((candidate) => candidate.action?.method === "discard"));
});

test("limit two always retains the best legal play and spends no slot on a discard", () => {
  const exact = state([
    card("A", "H"), card("A", "S"), card("K", "D"), card("Q", "C"), card("2", "H"),
  ]);
  exact.seed = "LIMIT-TWO";
  exact.round_num = 6;
  exact.consumables = {
    count: 1,
    limit: 2,
    cards: [{ id: 411, key: "c_tower", label: "The Tower", set: "TAROT" }],
  };
  const wide = generateBalatrobotCandidates(exact, { limit: 20 });
  const expectedBestPlay = wide.find((candidate) => candidate.action?.method === "play");
  assert.ok(expectedBestPlay);
  const bounded = generateBalatrobotCandidates(exact, {
    limit: 2,
    consumableAges: { byId: { 411: { id: 411, key: "c_tower", tracked: true, blindAge: 3 } } },
  });
  assert.equal(bounded.length, 2);
  assert.equal(bounded.find((candidate) => candidate.action?.method === "play")?.id, expectedBestPlay.id);
  assert.equal(bounded.some((candidate) => candidate.action?.method === "discard"), false);
  assert.ok(bounded.some((candidate) => candidate.consumableStrategicReview === true));
});

test("consumable sale fails closed without id age, sufficient age, or full slots", () => {
  const base = {
    state: "SHOP",
    seed: "SAFE-SHOP",
    money: 0,
    round: {},
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: {
      count: 2,
      limit: 2,
      cards: [
        { id: 9, key: "c_tower", label: "The Tower", set: "TAROT", cost: { sell: 1 } },
        { key: "c_justice", label: "Justice", set: "TAROT", cost: { sell: 1 } },
      ],
    },
    shop: { cards: [] },
    vouchers: { cards: [] },
    packs: { cards: [] },
  };
  const young = { byId: { 9: { id: 9, key: "c_tower", tracked: true, blindAge: 1 } } };
  assert.equal(generateBalatrobotCandidates(base, { consumableAges: young }).some(
    (candidate) => candidate.action.consumable != null && candidate.action.method === "sell"), false);
  const old = { byId: { 9: { id: 9, key: "c_tower", tracked: true, blindAge: 3 } } };
  assert.equal(generateBalatrobotCandidates({
    ...base,
    consumables: { ...base.consumables, count: 1, cards: [base.consumables.cards[0]] },
  }, { consumableAges: old }).some(
    (candidate) => candidate.action.consumable != null && candidate.action.method === "sell"), false);
});

test("an aged owned consumable forces one explicit strategic use-or-hold review", () => {
  const exact = state([
    card("A", "H"), card("K", "H"), card("Q", "H"), card("J", "H"), card("9", "H"), card("2", "C"),
  ]);
  exact.seed = "AGED-HAND";
  exact.round_num = 7;
  exact.consumables = {
    count: 1,
    limit: 2,
    cards: [{ id: 77, key: "c_tower", label: "The Tower", set: "TAROT" }],
  };
  const candidates = generateBalatrobotCandidates(exact, {
    limit: 20,
    consumableAges: { byId: { 77: { id: 77, key: "c_tower", tracked: true, blindAge: 2 } } },
  });
  const ownedUse = candidates.find((candidate) => candidate.action.method === "use");
  assert.ok(ownedUse?.consumableStrategicReview);
  const mode = balatrobotThinkingMode(exact, candidates, {
    balatrobotRoutineReasoningEffort: "none",
    balatrobotStrategicReasoningEffort: "high",
  });
  assert.equal(mode.strategic, true);
  assert.equal(mode.ignorePersistedCheckpoint, true);
  assert.match(mode.reason, /aged or full-slot consumable/);
});

test("an aged consumable with no legal use target still forces a context-only hold review", () => {
  const exact = state([card("A", "H"), card("K", "S"), card("2", "C")]);
  exact.seed = "AGED-BLOCKED";
  exact.round_num = 8;
  exact.last_tarot_planet = null;
  exact.consumables = {
    count: 1,
    limit: 2,
    cards: [{ id: 88, key: "c_fool", label: "The Fool", set: "TAROT" }],
  };
  const candidates = generateBalatrobotCandidates(exact, {
    limit: 20,
    consumableAges: { byId: { 88: { id: 88, key: "c_fool", tracked: true, blindAge: 5 } } },
  });
  const play = candidates.find((candidate) => candidate.action?.method === "play");
  assert.ok(play);
  assert.equal(play.consumableStrategicReview, true);
  assert.equal(play.consumableHoldReviews.length, 1);
  assert.match(play.consumableHoldReviews[0].blockedReason, /last|known|valid|use/iu);
  assert.ok(filterBalatrobotExecutableCandidates(exact, candidates).some(
    (candidate) => candidate.id === play.id,
  ));
  const mode = balatrobotThinkingMode(exact, candidates, {
    balatrobotRoutineReasoningEffort: "none",
    balatrobotStrategicReasoningEffort: "high",
  });
  assert.equal(mode.strategic, true);
  assert.equal(mode.ignorePersistedCheckpoint, true);
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
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "pack", params: { card: 2, targets: [] } },
    choices,
    exact,
  ));
  assert.throws(
    () => assertBalatrobotCandidateAction({ method: "pack", params: { card: 8, targets: [] } }, choices, exact),
    /must exactly match one locally enumerated candidate/,
  );

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

test("celestial pack exposes a leading Black Hole as a strong no-target choice", () => {
  const exact = {
    state: "SMODS_BOOSTER_OPENED",
    hands: {
      Flush: { level: 3, chips: 65, mult: 8, played: 9 },
      Straight: { level: 2, chips: 60, mult: 7, played: 5 },
      "Straight Flush": { level: 1, chips: 100, mult: 8, played: 0 },
    },
    hand: { count: 0, cards: [] },
    jokers: { count: 2, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    pack: { cards: [
      { key: "c_black_hole", label: "Black Hole", set: "SPECTRAL" },
      { key: "c_jupiter", label: "Jupiter", set: "PLANET" },
      { key: "c_neptune", label: "Neptune", set: "PLANET" },
    ] },
  };
  const choices = generateBalatrobotPackCandidates(exact, {
    runPlan: { buildGoal: "Straight / Flush route" },
  });
  const blackHole = choices.find((candidate) => candidate.card?.key === "c_black_hole");
  assert.ok(blackHole);
  assert.deepEqual(blackHole.action, { method: "pack", card: 0, targets: [] });
  assert.equal(blackHole.targetRule.kind, "all-hands-upgrade");
  assert.ok(Number.isFinite(blackHole.expectedValue));
  assert.ok(blackHole.expectedValue > choices.find((candidate) => candidate.card?.key === "c_jupiter").expectedValue);
  assert.ok(blackHole.expectedValue > choices.find((candidate) => candidate.card?.key === "c_neptune").expectedValue);
});

test("Joker packs preserve stickers, discount liabilities, and never force an unsafe pick", () => {
  const offer = (id, modifier) => ({
    id,
    key: "j_cavendish",
    label: "Cavendish",
    set: "JOKER",
    value: { effect: "X3 Mult" },
    modifier,
    state: {},
  });
  const exact = {
    state: "SMODS_BOOSTER_OPENED",
    ante_num: 2,
    expected_joker_hold_blinds: 4,
    hand: { count: 0, cards: [] },
    hands: {},
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    pack: { cards: [
      offer(1, {}),
      offer(2, { eternal: true }),
      offer(3, { perishable: 1 }),
      offer(4, { rental: true }),
      offer(5, { eternal: true, rental: true }),
    ] },
  };
  const candidates = generateBalatrobotPackCandidates(exact, { limit: 20 });
  const picks = candidates.filter((candidate) => candidate.action.card != null);
  assert.deepEqual(picks.map((candidate) => candidate.card.id).toSorted(), [1, 2, 3, 4]);
  assert.equal(new Set(picks.map((candidate) => candidate.expectedValue)).size, 4);
  const byId = Object.fromEntries(picks.map((candidate) => [candidate.card.id, candidate]));
  assert.equal(byId[1].safeChoice, true);
  assert.equal(byId[1].fallbackSafe, true);
  assert.equal(byId[2].card.eternal, true);
  assert.equal(byId[3].card.perishable, 1);
  assert.equal(byId[4].card.rental, true);
  for (const id of [2, 3, 4]) {
    assert.equal(byId[id].safeChoice, false);
    assert.equal(byId[id].fallbackSafe, false);
    assert.equal(byId[id].requiresStrategic, true);
  }

  const rentalOnly = { ...exact, pack: { cards: [offer(6, { rental: true })] } };
  const rentalCandidates = generateBalatrobotPackCandidates(rentalOnly, { limit: 20 });
  assert.ok(rentalCandidates.some((candidate) => candidate.card?.id === 6));
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "pack", params: { skip: true } },
    rentalCandidates,
    rentalOnly,
  ));

  const eternalRentalOnly = {
    ...exact,
    pack: { cards: [offer(7, { eternal: true, rental: true })] },
  };
  const rejectedCandidates = generateBalatrobotPackCandidates(eternalRentalOnly, { limit: 20 });
  assert.equal(rejectedCandidates.some((candidate) => candidate.action.card != null), false);
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "pack", params: { skip: true } },
    rejectedCandidates,
    eternalRentalOnly,
  ));
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

test("a debuffed Credit Card never makes unaffordable shop actions locally legal", () => {
  const exact = {
    state: "SHOP",
    ante_num: 3,
    money: -13,
    round: { reroll_cost: 5 },
    jokers: {
      count: 1,
      limit: 5,
      cards: [{
        key: "j_credit_card",
        label: "Credit Card",
        set: "JOKER",
        state: { debuff: true },
        modifier: {},
        cost: { sell: 1 },
      }],
    },
    shop: {
      cards: [{ key: "j_splash", label: "Splash", set: "JOKER", modifier: {}, cost: { buy: 3 } }],
    },
    vouchers: { cards: [] },
    packs: { cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
    hands: {},
  };
  const blocked = generateBalatrobotCandidates(exact, { limit: 30 });
  assert.equal(blocked.some((candidate) => ["buy", "reroll"].includes(candidate.action.method)), false);
  assert.equal(blocked.find((candidate) => candidate.action.method === "next_round")?.requiresStrategic, false);

  exact.jokers.cards[0].state.debuff = false;
  const active = generateBalatrobotCandidates(exact, { limit: 30 });
  assert.equal(active.some((candidate) => candidate.action.method === "buy"), true);
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
