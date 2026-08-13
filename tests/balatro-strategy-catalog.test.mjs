import test from "node:test";
import assert from "node:assert/strict";

import {
  balatrobotJokerCapability,
  balatrobotJokerTacticalContext,
  balatrobotVoucherValue,
} from "../src/balatro-strategy-catalog.mjs";
import {
  balatrobotHighScoreBuildProfile,
  balatrobotThinkingMode,
  estimateBalatrobotCandidateScore,
  generateBalatrobotShopCandidates,
} from "../src/balatrobot-solver.mjs";

function exactState(overrides = {}) {
  return {
    state: "SHOP",
    ante: 2,
    roundNumber: 4,
    money: 20,
    round: {
      handsLeft: 4,
      handsPlayed: 0,
      discardsLeft: 3,
      discardsUsed: 0,
      rerollCost: 5,
    },
    hand: { count: 8, limit: 8, cards: [] },
    jokers: { count: 2, limit: 5, cards: [] },
    consumables: { count: 2, limit: 2, cards: [{ key: "c_mercury" }, { key: "c_uranus" }] },
    shop: { count: 0, limit: 2, cards: [] },
    vouchers: { count: 0, limit: 1, cards: [] },
    packs: { count: 0, limit: 2, cards: [] },
    pokerHands: { Pair: { played: 8 }, Flush: { played: 2 } },
    usedVouchers: {},
    ...overrides,
  };
}

test("Blank voucher value follows known Antimatter unlock progress", () => {
  const early = exactState({ collectionKnowledge: { voucherProgress: { blankPurchases: 1 } } });
  const near = exactState({ collectionKnowledge: { voucherProgress: { blankPurchases: 9 } } });
  const unlocked = exactState({
    collectionKnowledge: {
      voucherProgress: { blankPurchases: 10 },
      unlockedVouchers: ["v_antimatter"],
    },
  });
  const blank = { key: "v_blank", buy: 10 };

  const earlyValue = balatrobotVoucherValue(early, blank);
  const nearValue = balatrobotVoucherValue(near, blank);
  const unlockedValue = balatrobotVoucherValue(unlocked, blank);
  assert.equal(earlyValue.progressKnown, true);
  assert.equal(nearValue.blankPurchases, 9);
  assert.ok(nearValue.value > earlyValue.value);
  assert.equal(unlockedValue.antimatterUnlocked, true);
  assert.equal(unlockedValue.value, 0);
});

test("Blank voucher reads the save-backed voucherProgress array used by the profile reader", () => {
  const state = exactState({
    collectionKnowledge: {
      unlockedVouchers: [{ key: "v_blank" }],
      voucherProgress: [{
        key: "v_antimatter",
        progress: { type: "blank_redeems", current: 8, target: 10 },
      }],
    },
  });
  const value = balatrobotVoucherValue(state, { key: "v_blank" }, { price: 10 });
  assert.equal(value.progressKnown, true);
  assert.equal(value.blankPurchases, 8);
  assert.match(value.rationale, /8\/10/);
});

test("voucher utility responds to slots, hands, rerolls, economy, packs and Ante tradeoffs", () => {
  const base = exactState({
    highScoreTraining: { missing: ["xMult", "copy"] },
  });
  assert.equal(balatrobotVoucherValue(base, { key: "v_crystal_ball", buy: 10 }).category, "consumable-slot");
  assert.equal(balatrobotVoucherValue(base, { key: "v_overstock_norm", buy: 10 }).category, "shop-slot");
  assert.equal(balatrobotVoucherValue(base, { key: "v_grabber", buy: 10 }).category, "hands");
  assert.equal(balatrobotVoucherValue(base, { key: "v_omen_globe", buy: 10 }).category, "pack");
  assert.equal(balatrobotVoucherValue(base, { key: "v_seed_money", buy: 10 }).category, "economy");
  assert.equal(balatrobotVoucherValue(base, { key: "v_telescope", buy: 10 }).category, "poker-hand");
  assert.equal(balatrobotVoucherValue(base, { key: "v_reroll_surplus", buy: 10 }).category, "reroll");
  assert.equal(balatrobotVoucherValue(base, { key: "v_hieroglyph", buy: 10 }).destructiveTradeoff, true);

  const lowHands = exactState({ round: { ...base.round, handsLeft: 1 } });
  assert.ok(
    balatrobotVoucherValue(lowHands, { key: "v_grabber", buy: 10 }).value >
      balatrobotVoucherValue(base, { key: "v_grabber", buy: 10 }).value,
  );
  assert.ok(
    balatrobotVoucherValue(lowHands, { key: "v_hieroglyph", buy: 10 }).value <
      balatrobotVoucherValue(base, { key: "v_hieroglyph", buy: 10 }).value,
  );
});

test("shop candidates expose stateful voucher valuation instead of a fixed score", () => {
  const state = exactState({
    vouchers: {
      count: 2,
      limit: 2,
      cards: [
        { key: "v_blank", label: "Blank", buy: 10 },
        { key: "v_grabber", label: "Grabber", buy: 10 },
      ],
    },
    collectionKnowledge: { voucherProgress: { blankPurchases: 0 } },
  });
  const candidates = generateBalatrobotShopCandidates(state);
  const blank = candidates.find((candidate) => candidate.id === "buy:voucher:0");
  const grabber = candidates.find((candidate) => candidate.id === "buy:voucher:1");
  assert.equal(blank.valuation.category, "progression");
  assert.equal(grabber.valuation.category, "hands");
  assert.notEqual(blank.expectedValue, grabber.expectedValue);
  assert.equal(grabber.strategicReason, grabber.valuation.rationale);
});

test("behavioral Joker catalog covers destructive and sequencing mechanics without fake score support", () => {
  const state = exactState({
    state: "SELECTING_HAND",
    money: 4,
    jokers: {
      count: 7,
      limit: 7,
      cards: [
        { key: "j_dna", label: "DNA" },
        { key: "j_burnt", label: "Burnt Joker" },
        { key: "j_trading", label: "Trading Card" },
        { key: "j_sixth_sense", label: "Sixth Sense" },
        { key: "j_vagabond", label: "Vagabond" },
        { key: "j_luchador", label: "Luchador" },
        { key: "j_mr_bones", label: "Mr. Bones" },
      ],
    },
    consumables: { count: 0, limit: 2, cards: [] },
    blinds: { boss: { type: "BOSS", status: "CURRENT", name: "The Wall", score: 8_000 } },
  });
  const tactics = balatrobotJokerTacticalContext(state);
  assert.deepEqual(
    tactics.capabilities.map((capability) => capability.key),
    ["j_dna", "j_burnt", "j_trading", "j_sixth_sense", "j_vagabond", "j_luchador", "j_mr_bones"],
  );
  assert.equal(tactics.requiresStrategic, true);
  assert.ok(tactics.capabilities.every((capability) => capability.exactScoreSupported === false));
  assert.match(tactics.constraints.join(" "), /exactly one card/u);
  assert.match(tactics.constraints.join(" "), /25%/u);

  const afterSetup = {
    ...state,
    round: { ...state.round, handsPlayed: 1, discardsUsed: 1 },
    money: 7,
    consumables: { count: 2, limit: 2, cards: [{}, {}] },
  };
  assert.equal(balatrobotJokerCapability({ key: "j_dna" }, afterSetup).activeNow, false);
  assert.equal(balatrobotJokerCapability({ key: "j_burnt" }, afterSetup).activeNow, false);
  assert.equal(balatrobotJokerCapability({ key: "j_vagabond" }, afterSetup).activeNow, false);
});

test("active behavioral Joker setup forces strategic thinking outside a Boss", () => {
  const state = exactState({
    state: "SELECTING_HAND",
    hand: { cards: [] },
    jokers: { count: 1, limit: 5, cards: [{ key: "j_dna" }] },
    consumables: { cards: [] },
    blinds: { small: { type: "SMALL", status: "CURRENT", score: 300 } },
  });
  const mode = balatrobotThinkingMode(state, [], {
    balatrobotStrategicThinkingEnabled: true,
    balatrobotStrategicReasoningEffort: "high",
    balatrobotRoutineReasoningEffort: "none",
  });
  assert.equal(mode.strategic, true);
  assert.match(mode.reason, /behavioral Joker/u);
});

test("live BalatroBot keys j_selzer and j_ancient are recognized", () => {
  const base = exactState({
    state: "SELECTING_HAND",
    hand: {
      cards: [
        { rank: "A", suit: "S", modifier: {} },
        { rank: "A", suit: "H", modifier: {} },
      ],
    },
    jokers: { count: 1, limit: 5, cards: [{ key: "j_selzer" }] },
    consumables: { cards: [] },
  });
  const candidate = { action: { method: "play", cards: [0, 1] }, handType: "Pair", scoringCards: [0, 1] };
  const scored = estimateBalatrobotCandidateScore(base, candidate);
  assert.ok(scored.knownRetriggerSources.includes("j_selzer"));
  assert.equal(scored.knownRetriggers, 2);

  const ancient = exactState({ jokers: { count: 1, limit: 5, cards: [{ key: "j_ancient" }] } });
  assert.equal(balatrobotHighScoreBuildProfile(ancient).xMultSources, 1);
});
