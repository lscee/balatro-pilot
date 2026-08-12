import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalHandCardPoint,
  canonicalPackTargetPoint,
  canonicalShopTargetPoint,
  executeActions,
  normalizeAllowedKey,
  preActionChangeRatioThreshold,
  ShopLoopGuard,
  validatePlan,
  waitForInputFocus,
} from "../src/actions.mjs";

const config = { maxActionsPerTurn: 3, minimumConfidence: 0.7 };
const eightCards = ["AS", "AC", "QD", "JS", "JD", "9D", "7C", "4S"];

function shopSignature({ x = null, y = null, value = 20, changedValue = 110 } = {}) {
  const bytes = Buffer.alloc(32 * 24 * 2, value);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const centerColumn = Math.floor(x * 32);
    const centerRow = Math.floor(y * 24);
    for (let row = Math.max(0, centerRow - 3); row <= Math.min(23, centerRow + 3); row += 1) {
      for (let column = Math.max(0, centerColumn - 2); column <= Math.min(31, centerColumn + 2); column += 1) {
        const offset = (row * 32 + column) * 2;
        bytes[offset] = changedValue;
        bytes[offset + 1] = changedValue;
      }
    }
  }
  return bytes.toString("base64");
}

function plan(overrides = {}) {
  return {
    observation: "A clear Play Hand button is visible.",
    strategy: "Click the visible control.",
    memory: "Pair build; preserve interest.",
    screen: "main_menu",
    confidence: 0.9,
    finished: false,
    needsDetail: false,
    actions: [
      {
        type: "click",
        x: 0.25,
        y: 0.75,
        button: "left",
        key: null,
        ms: null,
        reason: "Visible target",
      },
    ],
    ...overrides,
  };
}

test("validatePlan accepts a normalized click", () => {
  const result = validatePlan(plan(), config);
  assert.deepEqual(result.actions[0], {
    type: "click",
    x: 0.25,
    y: 0.75,
    button: "left",
    target: null,
    reason: "Visible target",
  });
});

test("validatePlan safely normalizes key casing and common aliases", () => {
  for (const [input, expected] of [
    ["Escape", "escape"],
    [" ESC ", "escape"],
    ["ArrowLeft", "left"],
    ["Space Bar", "space"],
  ]) {
    const result = validatePlan(
      plan({
        screen: "deck_view",
        actions: [{ type: "key", key: input, reason: "Close viewer" }],
      }),
      config,
    );
    assert.equal(result.actions[0].key, expected);
    assert.equal(normalizeAllowedKey(input), expected);
  }
});

test("validatePlan still rejects keys outside the safe allowlist", () => {
  assert.throws(
    () =>
      validatePlan(
        plan({
          actions: [{ type: "key", key: "Delete", reason: "Unsafe key" }],
        }),
        config,
      ),
    /unsupported key/,
  );
});

test("pre-action freshness uses screen-risk-specific animation thresholds", () => {
  const thresholds = {
    preActionFreshnessChangeRatio: 0.18,
    preActionStaticLayoutChangeRatio: 0.26,
    preActionAnimatedOverlayChangeRatio: 0.32,
  };
  assert.equal(
    preActionChangeRatioThreshold(
      { screen: "deck_view", actions: [{ type: "key", key: "Escape" }] },
      thresholds,
    ),
    0.32,
  );
  assert.equal(preActionChangeRatioThreshold({ screen: "pack", actions: [{ type: "click" }] }, thresholds), 0.26);
  assert.equal(preActionChangeRatioThreshold({ screen: "shop", actions: [{ type: "click" }] }, thresholds), 0.26);
  assert.equal(preActionChangeRatioThreshold({ screen: "hand", actions: [{ type: "click" }] }, thresholds), 0.18);
  assert.ok(0.2318 < preActionChangeRatioThreshold({ screen: "pack", actions: [{ type: "click" }] }, thresholds));
});

test("ShopLoopGuard breaks repeated unavailable Buy & Use plans and resets on progress", () => {
  const guard = new ShopLoopGuard(3);
  const buyUsePlan = (money) => ({
    screen: "shop",
    state: { money },
    actions: [{ type: "click", target: "shop_offer_right_use" }],
  });

  assert.equal(guard.observe(buyUsePlan(11)).recover, false);
  assert.equal(guard.observe(buyUsePlan(11)).recover, false);
  assert.equal(guard.observe(buyUsePlan(null)).count, 3);
  assert.deepEqual(guard.observe(buyUsePlan(11)), {
    recover: true,
    count: 4,
    target: "shop_offer_right_use",
  });
  assert.equal(guard.observe(buyUsePlan(8)).count, 1);
  assert.equal(guard.observe({ screen: "blind_select", actions: [] }).count, 0);
  assert.equal(guard.observe(buyUsePlan(8)).count, 1);
});

test("validatePlan remaps semantic shop purchases and forbids stale model coordinates", () => {
  const result = validatePlan(
    plan({
      screen: "shop",
      state: { money: 10 },
      actions: [
        {
          type: "click",
          x: null,
          y: null,
          button: null,
          target: "shop_offer_right",
          reason: "Buy Raised Fist",
        },
      ],
    }),
    config,
  );
  assert.deepEqual(result.actions[0], {
    type: "click",
    x: 0.665,
    y: 0.575,
    button: "left",
    target: "shop_offer_right",
    reason: "Buy Raised Fist",
  });
  assert.equal(canonicalShopTargetPoint("shop_offer_right").hoverX, 0.665);
  assert.equal(canonicalShopTargetPoint("shop_offer_right", 1.54).y, 0.56);
  assert.equal(canonicalShopTargetPoint("shop_pack_left", 1.54).y, 0.883);
  assert.equal(canonicalShopTargetPoint("shop_pack_left", 1.82).y, 0.925);
  assert.deepEqual(
    { x: canonicalShopTargetPoint("shop_pack_center", 1.54).x, y: canonicalShopTargetPoint("shop_pack_center", 1.54).y },
    { x: 0.668, y: 0.883 },
  );
  assert.deepEqual(
    { x: canonicalShopTargetPoint("shop_pack_center", 1.97).x, y: canonicalShopTargetPoint("shop_pack_center", 1.97).y },
    { x: 0.655, y: 0.925 },
  );

  for (const target of ["buy_raised_fist", "raised_fist", "buy", "advance"]) {
    assert.throws(
      () =>
        validatePlan(
          plan({
            screen: "shop",
            actions: [{ type: "click", x: 0.64, y: 0.44, button: "left", target }],
          }),
          config,
        ),
      /must use shop_offer_left/,
    );
  }
});

test("validatePlan corrects a singleton shop offer to the centered purchase target", () => {
  const result = validatePlan(
    plan({
      screen: "shop",
      decision: { shopOfferPositions: ["center"] },
      actions: [
        {
          type: "click",
          x: null,
          y: null,
          button: null,
          target: "shop_offer_right",
          reason: "Buy only offer",
        },
      ],
    }),
    config,
  );

  assert.equal(result.actions[0].target, "shop_offer_center");
  assert.equal(result.actions[0].x, 0.61);
  assert.deepEqual(result.decision.shopOfferPositions, ["center"]);
});

test("validatePlan rejects center semantics when two top-row offers are visible", () => {
  assert.throws(
    () =>
      validatePlan(
        plan({
          screen: "shop",
          decision: { shopOfferPositions: ["left", "right"] },
          actions: [
            {
              type: "click",
              x: null,
              y: null,
              button: null,
              target: "shop_offer_center",
              reason: "Buy an offer",
            },
          ],
        }),
        config,
      ),
    /two-offer shop layout/,
  );
});

test("validatePlan supports Buy & Use when consumable slots are full", () => {
  const result = validatePlan(
    plan({
      screen: "shop",
      actions: [
        {
          type: "click",
          x: null,
          y: null,
          button: null,
          target: "shop_offer_left_use",
          reason: "Buy and use Uranus",
        },
      ],
    }),
    config,
  );
  assert.deepEqual(result.actions[0], {
    type: "click",
    x: 0.61,
    y: 0.45,
    button: "left",
    target: "shop_offer_left_use",
    reason: "Buy and use Uranus",
  });
  assert.deepEqual(
    { hoverX: canonicalShopTargetPoint("shop_offer_left_use", 1.97).hoverX, x: canonicalShopTargetPoint("shop_offer_left_use", 1.97).x },
    { hoverX: 0.555, x: 0.61 },
  );
});

test("validatePlan remaps semantic pack playing cards and Use without clicking the offer", () => {
  const result = validatePlan(
    plan({
      screen: "pack",
      decision: {
        key: "use_magician",
        selectedBefore: [],
        selectedAfter: ["card_4", "card_5"],
        visibleCardCount: 8,
        handCapacity: 8,
        visibleCards: eightCards,
        targetHand: "other",
        packChoice: "none",
        commit: "none",
      },
      actions: [
        { type: "click", target: "pack_card_4_of_8", reason: "Select first target" },
        { type: "click", target: "pack_card_5_of_8", reason: "Select second target" },
        { type: "click", target: "pack_use_3_of_5", reason: "Use Magician" },
      ],
    }),
    config,
  );
  assert.deepEqual(
    result.actions.map(({ target, x, y }) => ({ target, x, y })),
    ["pack_card_4_of_8", "pack_card_5_of_8", "pack_use_3_of_5"].map((target) => ({
      target,
      x: canonicalPackTargetPoint(target).x,
      y: canonicalPackTargetPoint(target).y,
    })),
  );
  assert.throws(
    () =>
      validatePlan(
        plan({ screen: "pack", actions: [{ type: "click", x: 0.54, y: 0.7, button: "left", reason: "Raw pack click" }] }),
        config,
      ),
    /pack screen must use/,
  );
  assert.throws(
    () =>
      validatePlan(
        plan({
          screen: "pack",
          decision: { packChoice: "none" },
          actions: [{ type: "click", target: "pack_choice_3_of_5", reason: "Click Magician offer" }],
        }),
        config,
      ),
    /Do not click a pack offer card/,
  );
});

test("validatePlan requires pack target clicks to reconcile stale raised cards", () => {
  const decision = {
    key: "use_devil",
    selectedBefore: ["card_5", "card_6"],
    selectedAfter: ["card_1"],
    visibleCardCount: 8,
    handCapacity: 8,
    visibleCards: eightCards,
    targetHand: "other",
    packChoice: "none",
    commit: "none",
  };
  const valid = validatePlan(
    plan({
      screen: "pack",
      decision,
      actions: [
        { type: "click", target: "pack_card_5_of_8", reason: "Deselect stale fifth" },
        { type: "click", target: "pack_card_6_of_8", reason: "Deselect stale sixth" },
        { type: "click", target: "pack_card_1_of_8", reason: "Select Gold target" },
        { type: "click", target: "pack_use_1_of_5", reason: "Use Devil" },
      ],
    }),
    config,
  );
  assert.deepEqual(
    valid.actions.filter((action) => /^pack_card_/.test(action.target)).map((action) => action.target),
    ["pack_card_5_of_8", "pack_card_6_of_8", "pack_card_1_of_8"],
  );
  assert.throws(
    () =>
      validatePlan(
        plan({
          screen: "pack",
          decision,
          actions: [
            { type: "click", target: "pack_card_1_of_8", reason: "Add target only" },
            { type: "click", target: "pack_use_1_of_5", reason: "Use Devil" },
          ],
        }),
        config,
      ),
    /missing card_5, card_6/,
  );
});

test("validatePlan allows a verified shop batch but requires layout-changing controls last", () => {
  const result = validatePlan(
    plan({
      screen: "shop",
      actions: [
        { type: "click", x: null, y: null, button: null, target: "shop_offer_left", reason: "Buy" },
        { type: "click", x: null, y: null, button: null, target: "shop_voucher", reason: "Buy voucher" },
        { type: "click", x: null, y: null, button: null, target: "shop_next_round", reason: "Leave" },
      ],
    }),
    config,
  );
  assert.deepEqual(
    result.actions.map((action) => action.target),
    ["shop_offer_left", "shop_voucher", "shop_next_round"],
  );

  for (const actions of [
    [
      { type: "click", target: "shop_pack_left", reason: "Open" },
      { type: "click", target: "shop_next_round", reason: "Leave" },
    ],
    [
      { type: "click", target: "shop_pack_center", reason: "Open only pack" },
      { type: "click", target: "shop_next_round", reason: "Leave" },
    ],
    [
      { type: "click", target: "shop_reroll", reason: "Reroll" },
      { type: "click", target: "shop_offer_left", reason: "Buy" },
    ],
    [
      { type: "click", target: "shop_next_round", reason: "Leave" },
      { type: "click", target: "shop_offer_left", reason: "Buy" },
    ],
  ]) {
    assert.throws(() => validatePlan(plan({ screen: "shop", actions }), config), /final action/);
  }
  assert.throws(
    () =>
      validatePlan(
        plan({
          screen: "shop",
          actions: [
            { type: "click", target: "shop_offer_left", reason: "Buy first" },
            { type: "click", target: "shop_offer_center", reason: "Buy survivor" },
          ],
        }),
        config,
      ),
    /at most one top-row offer/,
  );
});

test("validatePlan turns low-confidence input into a wait", () => {
  const result = validatePlan(plan({ confidence: 0.45 }), config);
  assert.deepEqual(result.actions[0], {
    type: "wait",
    ms: 1_000,
    reason: "Confidence below local threshold",
  });
});

test("validatePlan rejects clicks at unsafe window edges", () => {
  const raw = plan();
  raw.actions[0].x = 1;
  assert.throws(() => validatePlan(raw, config), /between 0.005 and 0.995/);
});

test("validatePlan refuses input when required visual detail is unreadable", () => {
  const result = validatePlan(plan({ needsDetail: true }), config);
  assert.deepEqual(result.actions[0], {
    type: "wait",
    ms: 1_000,
    reason: "Required visual detail is unreadable",
  });
});

test("validatePlan does not impose an action-count limit", () => {
  const actions = Array.from({ length: 20 }, (_, index) => ({
    type: "click",
    x: 0.1 + index * 0.02,
    y: 0.5,
    button: "left",
    reason: `Card ${index}`,
  }));
  const result = validatePlan(plan({ screen: "run_setup", actions }), config);
  assert.equal(result.actions.length, 20);
});

test("validatePlan rejects partial card selection on a hand screen", () => {
  assert.throws(
    () => validatePlan(plan({ screen: "hand" }), config),
    /must end by clicking Play Hand or Discard/,
  );
});

test("validatePlan accepts an atomic hand plan ending in Play Hand", () => {
  const raw = plan({
    screen: "hand",
    decision: {
      key: "play_pair",
      selectedBefore: [],
      selectedAfter: ["card_4", "card_5"],
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: eightCards,
      targetHand: "pair",
      commit: "play_hand",
    },
    actions: [
      { ...plan().actions[0], target: "card_4" },
      { type: "click", x: 0.35, y: 0.7, button: "left", target: "card_5", reason: "Select pair card" },
      { type: "click", x: 0.42, y: 0.82, button: "left", target: "play_hand", reason: "Click Play Hand" },
    ],
  });
  assert.equal(validatePlan(raw, config).actions.length, 3);
});

test("validatePlan accepts five selected cards and rejects six", () => {
  const five = ["card_1", "card_2", "card_3", "card_4", "card_5"];
  const raw = plan({
    screen: "hand",
    decision: {
      key: "play_flush",
      selectedBefore: five,
      selectedAfter: five,
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: eightCards,
      targetHand: "flush",
      commit: "play_hand",
    },
    actions: [
      { type: "click", x: 0.42, y: 0.82, button: "left", target: "play_hand", reason: "Play flush" },
    ],
  });
  assert.equal(validatePlan(raw, config).decision.selectedAfter.length, 5);
  raw.decision.selectedAfter = [...five, "card_6"];
  assert.throws(() => validatePlan(raw, config), /at most 5 cards/);
});

test("validatePlan removes a redundant click on a card already selected for the final hand", () => {
  const raw = plan({
    screen: "hand",
    decision: {
      key: "discard_low",
      selectedBefore: ["card_3"],
      selectedAfter: ["card_3", "card_4"],
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: eightCards,
      targetHand: "pair",
      commit: "discard",
    },
    actions: [
      { type: "click", x: 0.5, y: 0.65, button: "left", target: "card_3", reason: "Already selected" },
      { type: "click", x: 0.6, y: 0.65, button: "left", target: "card_4", reason: "Select card 4" },
      { type: "click", x: 0.7, y: 0.85, button: "left", target: "discard", reason: "Discard" },
    ],
  });
  const result = validatePlan(raw, config);
  assert.deepEqual(result.actions.map((action) => action.target), ["card_4", "discard"]);
});

test("validatePlan rejects duplicate card toggles and remaps untrusted coordinates", () => {
  const base = plan({
    screen: "hand",
    decision: {
      key: "play_pair",
      selectedBefore: [],
      selectedAfter: ["card_3", "card_4"],
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: eightCards,
      targetHand: "pair",
      commit: "play_hand",
    },
    actions: [
      { type: "click", x: 0.5, y: 0.65, button: "left", target: "card_3", reason: "Select first" },
      { type: "click", x: 0.6, y: 0.65, button: "left", target: "card_4", reason: "Select second" },
      { type: "click", x: 0.42, y: 0.85, button: "left", target: "play_hand", reason: "Play pair" },
    ],
  });
  const duplicate = structuredClone(base);
  duplicate.actions.splice(1, 0, { ...duplicate.actions[0] });
  assert.throws(() => validatePlan(duplicate, config), /same card slot more than once/);

  const reversed = structuredClone(base);
  reversed.actions[0].x = 0.65;
  reversed.actions[1].x = 0.55;
  reversed.actions.at(-1).x = 0.2;
  reversed.actions.at(-1).y = 0.65;
  const remapped = validatePlan(reversed, config);
  assert.deepEqual(
    remapped.actions.map(({ x, y }) => [x, y]),
    [
      [canonicalHandCardPoint("card_3", 8, 8).x, 0.615],
      [canonicalHandCardPoint("card_4", 8, 8).x, 0.615],
      [0.425, 0.85],
    ],
  );

  const wrongCommit = structuredClone(base);
  wrongCommit.actions.at(-1).target = "discard";
  assert.throws(() => validatePlan(wrongCommit, config), /conflicts with decision.commit/);
});

test("canonical hand coordinates account for a partially dealt centered row", () => {
  const fullSecond = canonicalHandCardPoint("card_2", 8, 8);
  const partialFirst = canonicalHandCardPoint("card_1", 6, 8);
  const partialLast = canonicalHandCardPoint("card_6", 6, 8);
  const fullSeventh = canonicalHandCardPoint("card_7", 8, 8);
  assert.deepEqual(partialFirst, fullSecond);
  assert.deepEqual(partialLast, fullSeventh);
  assert.deepEqual(canonicalHandCardPoint("card_1", 8, 8, 1.54), { x: 0.3, y: 0.615 });
  assert.deepEqual(canonicalHandCardPoint("card_1", 8, 8, 1.97), { x: 0.322, y: 0.615 });
  assert.deepEqual(canonicalHandCardPoint("card_2", 8, 8, 1.97), { x: 0.383, y: 0.615 });
  assert.throws(() => canonicalHandCardPoint("card_7", 6, 8), /exceeds the 6 visible cards/);
});

test("validatePlan remaps the exact bad pair coordinates seen in a real run", () => {
  const raw = plan({
    screen: "hand",
    decision: {
      key: "play_pair",
      selectedBefore: [],
      selectedAfter: ["card_2", "card_3"],
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: eightCards,
      targetHand: "pair",
      commit: "play_hand",
    },
    actions: [
      { type: "click", x: 0.403, y: 0.445, button: "left", target: "card_2", reason: "Select J" },
      { type: "click", x: 0.403, y: 0.445, button: "left", target: "card_3", reason: "Select J" },
      { type: "click", x: 0.213, y: 0.68, button: "left", target: "play_hand", reason: "Play pair" },
    ],
  });
  const result = validatePlan(raw, config);
  assert.equal(result.actions[0].x, canonicalHandCardPoint("card_2", 8, 8).x);
  assert.equal(result.actions[1].x, canonicalHandCardPoint("card_3", 8, 8).x);
  assert.equal(result.actions[0].y, 0.615);
  assert.equal(result.actions[1].y, 0.615);
  assert.deepEqual(
    { x: result.actions[2].x, y: result.actions[2].y },
    { x: 0.425, y: 0.85 },
  );
});

test("validatePlan accepts null model coordinates for semantic hand targets", () => {
  const raw = plan({
    screen: "hand",
    decision: {
      key: "play_pair_aces",
      selectedBefore: [],
      selectedAfter: ["card_1", "card_2"],
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: eightCards,
      targetHand: "pair",
      commit: "play_hand",
    },
    actions: [
      { type: "click", x: null, y: null, button: null, target: "card_1", reason: "Select ace" },
      { type: "click", x: null, y: null, button: null, target: "card_2", reason: "Select ace" },
      { type: "click", x: null, y: null, button: null, target: "play_hand", reason: "Play pair" },
    ],
  });
  const result = validatePlan(raw, config);
  assert.deepEqual(
    result.actions.map(({ x, y }) => [x, y]),
    [
      [canonicalHandCardPoint("card_1", 8, 8).x, 0.615],
      [canonicalHandCardPoint("card_2", 8, 8).x, 0.615],
      [0.425, 0.85],
    ],
  );
});

test("validatePlan allows one canonical remaining-deck inspection without changing selection", () => {
  const raw = plan({
    screen: "hand",
    decision: {
      key: "inspect_deck_for_full_house_outs",
      selectedBefore: [],
      selectedAfter: [],
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: eightCards,
      targetHand: "full_house",
      commit: "none",
    },
    actions: [
      { type: "click", x: 0.5, y: 0.5, button: "left", target: "open_deck", reason: "Check remaining A/J outs" },
    ],
  });
  const result = validatePlan(raw, config);
  assert.deepEqual(
    { x: result.actions[0].x, y: result.actions[0].y, target: result.actions[0].target },
    { x: 0.89, y: 0.8, target: "open_deck" },
  );

  const mutatesSelection = structuredClone(raw);
  mutatesSelection.decision.selectedAfter = ["card_1"];
  assert.throws(() => validatePlan(mutatesSelection, config), /cannot change the intended card selection/);
});

test("validatePlan normalizes the model's 10C notation to canonical TC", () => {
  const raw = plan({
    screen: "hand",
    decision: {
      key: "inspect_deck_with_ten",
      selectedBefore: [],
      selectedAfter: [],
      visibleCardCount: 8,
      handCapacity: 8,
      visibleCards: ["AS", "10C", "QD", "JS", "JD", "9D", "7C", "4S"],
      targetHand: "straight",
      commit: "none",
    },
    actions: [{ type: "click", x: null, y: null, button: null, target: "open_deck", reason: "Inspect outs" }],
  });
  const result = validatePlan(raw, config);
  assert.equal(result.decision.visibleCards[1], "TC");
  assert.equal(result.decision.visibleCards.length, 8);
});

test("validatePlan refuses hand input while the N/C deal is incomplete", () => {
  const raw = plan({
    screen: "hand",
    decision: {
      key: "discard_during_deal",
      selectedBefore: [],
      selectedAfter: ["card_4", "card_5"],
      visibleCardCount: 5,
      handCapacity: 8,
      visibleCards: eightCards.slice(0, 5),
      targetHand: "full_house",
      commit: "discard",
    },
    actions: [
      { type: "click", x: 0.4, y: 0.6, button: "left", target: "card_4", reason: "Discard" },
      { type: "click", x: 0.5, y: 0.6, button: "left", target: "card_5", reason: "Discard" },
      { type: "click", x: 0.6, y: 0.8, button: "left", target: "discard", reason: "Discard partial hand" },
    ],
  });
  assert.throws(() => validatePlan(raw, config), /still being dealt/);
});

test("validatePlan permits a short final hand only when the draw pile is empty", () => {
  const raw = plan({
    screen: "hand",
    state: { deckRemaining: 0 },
    decision: {
      key: "play_last_three_cards",
      selectedBefore: [],
      selectedAfter: ["card_1"],
      visibleCardCount: 3,
      handCapacity: 8,
      visibleCards: ["AS", "QC", "7D"],
      targetHand: "high_card",
      commit: "play_hand",
    },
    actions: [
      { type: "click", x: null, y: null, button: "left", target: "card_1", reason: "Select ace" },
      { type: "click", x: null, y: null, button: "left", target: "play_hand", reason: "Play final hand" },
    ],
  });
  assert.equal(validatePlan(raw, config).actions.at(-1).target, "play_hand");
});

test("executeActions treats open_deck as an ordinary hand-screen click", async () => {
  const clicks = [];
  let captures = 0;
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => {
      captures += 1;
      return {};
    },
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  await executeActions(
    [{ type: "click", x: 0.89, y: 0.8, button: "left", target: "open_deck", reason: "Inspect deck" }],
    { bridge, delayMs: 0, dryRun: false, screen: "hand" },
  );
  assert.deepEqual(clicks, [[0.89, 0.8]]);
  assert.equal(captures, 0);
});

test("executeActions waits for a second card observation without toggling the card twice", async () => {
  const signatures = [10, 10, 80, 80, 120].map((value) => Buffer.alloc(32 * 24 * 2, value).toString("base64"));
  const clicks = [];
  const moves = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async (x, y) => moves.push([x, y]),
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  await executeActions(
    [
      { type: "click", x: 0.5, y: 0.65, button: "left", target: "card_4", reason: "Select card" },
      { type: "click", x: 0.7, y: 0.85, button: "left", target: "discard", reason: "Discard" },
    ],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "hand",
      cardClickDelayMs: 0,
      cardClickRetries: 1,
      cardAckThreshold: 0.01,
      cardAckSettleMs: 0,
      cardHoverSettleMs: 0,
      commitAckSettleMs: 0,
      commitAckThreshold: 0.01,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(clicks.length, 2);
  assert.deepEqual(moves, [
    [0.5, 0.65],
    [0.7, 0.85],
  ]);
  assert.equal(verifications[0].kind, "card_toggle");
  assert.equal(verifications[0].acknowledged, true);
  assert.equal(verifications[0].attempts, 1);
  assert.equal(verifications[0].observations, 2);
  assert.equal(verifications[1].kind, "hand_commit");
  assert.equal(verifications[1].acknowledged, true);
});

test("executeActions skips the hand commit when a card click remains unconfirmed", async () => {
  const unchanged = Buffer.alloc(32 * 24 * 2, 10).toString("base64");
  const clicks = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: unchanged, signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [
      { type: "click", x: 0.5, y: 0.65, button: "left", target: "card_4", reason: "Select card" },
      { type: "click", x: 0.7, y: 0.85, button: "left", target: "discard", reason: "Discard" },
    ],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "hand",
      cardClickDelayMs: 0,
      cardClickRetries: 1,
      cardAckThreshold: 0.01,
      cardAckSettleMs: 0,
      cardHoverSettleMs: 0,
    },
  );
  assert.equal(result.interrupted, true);
  assert.equal(clicks.length, 1);
});

test("executeActions remaps a semantic hand card to the live wide-window safe point", async () => {
  const signatures = [10, 80].map((value) => Buffer.alloc(32 * 24 * 2, value).toString("base64"));
  const clicks = [];
  const actions = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.1, y: 0.1, button: "left", target: "card_1", reason: "Select first card" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "hand",
      handAspectRatio: 1.97,
      handVisibleCardCount: 8,
      handCapacity: 8,
      cardClickDelayMs: 0,
      cardClickRetries: 0,
      cardAckThreshold: 0.01,
      cardHoverSettleMs: 0,
      onAction: (action) => actions.push(action),
    },
  );
  assert.equal(result.interrupted, false);
  assert.deepEqual(clicks, [[0.322, 0.615]]);
  assert.deepEqual(
    { x: actions[0].x, y: actions[0].y, target: actions[0].target },
    { x: 0.322, y: 0.615, target: "card_1" },
  );
});

test("executeActions remaps and visually confirms a semantic pack playing-card toggle", async () => {
  const signatures = [20, 100].map((value) => Buffer.alloc(32 * 24 * 2, value).toString("base64"));
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.1, y: 0.1, button: "left", target: "pack_card_3_of_8", reason: "Select target" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "pack",
      handAspectRatio: 1.97,
      cardClickDelayMs: 0,
      cardClickRetries: 0,
      cardAckThreshold: 0.01,
      cardHoverSettleMs: 0,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, false);
  const expected = canonicalPackTargetPoint("pack_card_3_of_8", 1.97);
  assert.deepEqual(clicks, [[expected.x, expected.y]]);
  assert.equal(verifications[0].kind, "pack_action");
  assert.equal(verifications[0].acknowledged, true);
});

test("executeActions hovers a pack offer before clicking Use and requires a broad transition", async () => {
  const signatures = [20, 120].map((value) => Buffer.alloc(32 * 24 * 2, value).toString("base64"));
  const moves = [];
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async (x, y) => moves.push([x, y]),
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.1, y: 0.1, button: "left", target: "pack_use_1_of_5", reason: "Use Devil" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "pack",
      cardClickDelayMs: 0,
      cardClickRetries: 0,
      cardAckThreshold: 0.01,
      cardHoverSettleMs: 0,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, false);
  assert.deepEqual(moves, [
    [0.37, 0.7],
    [0.37, 0.805],
  ]);
  assert.deepEqual(clicks, [[0.37, 0.805]]);
  assert.equal(verifications[0].transition, true);
  assert.equal(verifications[0].acknowledged, true);
  assert.ok(verifications[0].difference >= 0.08);
});

test("executeActions rejects a disabled pack Use button that leaves the layout unchanged", async () => {
  const unchanged = Buffer.alloc(32 * 24 * 2, 20).toString("base64");
  const clicks = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: unchanged, signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.37, y: 0.805, button: "left", target: "pack_use_1_of_5", reason: "Use Devil" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "pack",
      cardClickDelayMs: 0,
      cardClickRetries: 0,
      cardAckThreshold: 0.01,
      cardHoverSettleMs: 0,
    },
  );
  assert.equal(result.interrupted, true);
  assert.match(result.reason, /did not produce a layout transition/);
  assert.deepEqual(clicks, [[0.37, 0.805]]);
});

test("executeActions retries and interrupts an unconfirmed Play Hand commit", async () => {
  const unchanged = Buffer.alloc(32 * 24 * 2, 20).toString("base64");
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: unchanged, signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.42, y: 0.85, button: "left", target: "play_hand", reason: "Play" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "hand",
      cardHoverSettleMs: 0,
      commitAckSettleMs: 0,
      commitClickRetries: 1,
      commitAckThreshold: 0.01,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, true);
  assert.match(result.reason, /not visually confirmed/);
  assert.equal(clicks.length, 2);
  assert.equal(verifications[0].kind, "hand_commit");
  assert.equal(verifications[0].acknowledged, false);
});

test("executeActions verifies a semantic purchase before continuing a batched shop plan", async () => {
  const base = shopSignature();
  const purchased = shopSignature({ x: 0.665, y: 0.48 });
  const signatures = [base, purchased, purchased];
  const moves = [];
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async (x, y) => moves.push([x, y]),
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [
      { type: "click", x: 0.665, y: 0.575, button: "left", target: "shop_offer_right", reason: "Buy" },
      { type: "click", x: 0.36, y: 0.42, button: "left", target: "shop_next_round", reason: "Leave" },
    ],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 1,
      shopPurchaseRetries: 1,
      shopPurchaseAckThreshold: 0.02,
      shopPurchaseStabilityThreshold: 0.02,
      shopPurchaseRetryUnchangedThreshold: 0.01,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, false);
  assert.deepEqual(moves, [
    [0.665, 0.48],
    [0.665, 0.575],
  ]);
  assert.deepEqual(clicks, [
    [0.665, 0.575],
    [0.36, 0.42],
  ]);
  assert.equal(verifications[0].kind, "shop_purchase");
  assert.equal(verifications[0].acknowledged, true);
  assert.equal(verifications[0].attempts, 1);
  assert.equal(verifications[0].point.y, 0.575);
});

test("executeActions waits for the shop hover animation to stabilize before purchasing", async () => {
  const base = shopSignature();
  const hovered = shopSignature({ x: 0.665, y: 0.48, changedValue: 60 });
  const purchased = shopSignature({ x: 0.665, y: 0.48, changedValue: 120 });
  const signatures = [base, hovered, hovered, purchased, purchased];
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.665, y: 0.575, button: "left", target: "shop_offer_right", reason: "Buy" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseBaselineMs: 1,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseRetries: 0,
      shopPurchaseAckThreshold: 0.02,
      shopPurchaseStabilityThreshold: 0.02,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, false);
  assert.equal(clicks.length, 1);
  assert.equal(verifications[0].baselineChecks, 2);
  assert.equal(verifications[0].baselineUnstable, false);
  assert.equal(verifications[0].preStabilityDifference, 0);
  assert.equal(verifications[0].acknowledged, true);
});

test("executeActions never clicks while the shop purchase baseline is still moving", async () => {
  const base = shopSignature();
  const animated = shopSignature({ x: 0.665, y: 0.48, changedValue: 100 });
  const signatures = [base, animated, base];
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.665, y: 0.575, button: "left", target: "shop_offer_right", reason: "Buy" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseBaselineMs: 1,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseRetries: 0,
      shopPurchaseAckThreshold: 0.02,
      shopPurchaseStabilityThreshold: 0.02,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, true);
  assert.equal(clicks.length, 0);
  assert.equal(verifications[0].baselineChecks, 2);
  assert.equal(verifications[0].baselineUnstable, true);
  assert.equal(verifications[0].attempts, 0);
  assert.equal(verifications[0].acknowledged, false);
});

test("executeActions retries an unconfirmed shop purchase locally, then interrupts", async () => {
  const unchanged = Buffer.alloc(32 * 24 * 2, 20).toString("base64");
  const moves = [];
  const clicks = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: unchanged, signatureCellBytes: 2 }),
    move: async (x, y) => moves.push([x, y]),
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [
      { type: "click", x: 0.61, y: 0.575, button: "left", target: "shop_offer_center", reason: "Buy" },
      { type: "click", x: 0.36, y: 0.42, button: "left", target: "shop_next_round", reason: "Leave" },
    ],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseRetries: 1,
      shopPurchaseAckThreshold: 0.02,
      shopPurchaseStabilityThreshold: 0.02,
      shopPurchaseRetryUnchangedThreshold: 0.01,
    },
  );
  assert.equal(result.interrupted, true);
  assert.match(result.reason, /not visually confirmed/);
  assert.equal(moves.length, 4);
  assert.equal(clicks.length, 2);
});

test("executeActions does not retry a shop slot that changed after an ambiguous first click", async () => {
  const base = shopSignature();
  const changed = shopSignature({ x: 0.665, y: 0.48 });
  const signatures = [base, changed, base, changed];
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift() ?? changed, signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.665, y: 0.575, button: "left", target: "shop_offer_right", reason: "Buy" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseRetries: 1,
      shopPurchaseAckThreshold: 0.04,
      shopPurchaseStabilityThreshold: 0.04,
      shopPurchaseRetryUnchangedThreshold: 0.02,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, true);
  assert.equal(clicks.length, 1);
  assert.equal(verifications[0].retryAborted, true);
  assert.equal(verifications[0].attempts, 1);
});

test("executeActions acknowledges a sustained booster transition without waiting for animation stability", async () => {
  const base = shopSignature();
  const opening = shopSignature({ x: 0.715, y: 0.78, changedValue: 90 });
  const openingLater = shopSignature({ x: 0.715, y: 0.78, changedValue: 150 });
  const signatures = [base, opening, openingLater];
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.715, y: 0.925, button: "left", target: "shop_pack_right", reason: "Open pack" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopAspectRatio: 1.97,
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseRetries: 0,
      shopPurchaseAckThreshold: 0.02,
      shopPurchaseStabilityThreshold: 0.001,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, false);
  assert.deepEqual(clicks, [[0.715, 0.925]]);
  assert.equal(verifications[0].acknowledged, true);
  assert.ok(verifications[0].postStabilityDifference > 0.001);
});

test("executeActions rejects a transient shop-button animation and never retries packs", async () => {
  const base = Buffer.alloc(32 * 24 * 2, 20).toString("base64");
  const animated = Buffer.alloc(32 * 24 * 2, 100).toString("base64");
  const signatures = [base, animated, base];
  const clicks = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift() ?? base, signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.61, y: 0.925, button: "left", target: "shop_pack_left", reason: "Open pack" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseRetries: 3,
      shopPurchaseAckThreshold: 0.04,
      shopPurchaseStabilityThreshold: 0.04,
      shopPurchaseRetryUnchangedThreshold: 0.02,
    },
  );
  assert.equal(result.interrupted, true);
  assert.equal(clicks.length, 1);
});

test("executeActions opens a single centered booster at the aspect-calibrated button", async () => {
  const base = shopSignature();
  const opened = shopSignature({ x: 0.655, y: 0.78 });
  const signatures = [base, opened, opened];
  const moves = [];
  const clicks = [];
  const verifications = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: signatures.shift(), signatureCellBytes: 2 }),
    move: async (x, y) => moves.push([x, y]),
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [{ type: "click", x: 0.655, y: 0.925, button: "left", target: "shop_pack_center", reason: "Open only pack" }],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopAspectRatio: 1.97,
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseAckThreshold: 0.02,
      shopPurchaseStabilityThreshold: 0.02,
      onVerification: (value) => verifications.push(value),
    },
  );
  assert.equal(result.interrupted, false);
  assert.deepEqual(moves, [
    [0.655, 0.78],
    [0.655, 0.925],
  ]);
  assert.deepEqual(clicks, [[0.655, 0.925]]);
  assert.equal(verifications[0].point.x, 0.655);
  assert.equal(verifications[0].acknowledged, true);
});

test("executeActions fails closed when a shop verification signature is missing", async () => {
  const clicks = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    capture: async () => ({ signature: "", signatureCellBytes: 2 }),
    move: async () => {},
    click: async (x, y) => clicks.push([x, y]),
    key: async () => {},
  };
  const result = await executeActions(
    [
      { type: "click", x: 0.665, y: 0.575, button: "left", target: "shop_offer_right", reason: "Buy" },
      { type: "click", x: 0.36, y: 0.42, button: "left", target: "shop_next_round", reason: "Leave" },
    ],
    {
      bridge,
      delayMs: 0,
      dryRun: false,
      screen: "shop",
      shopHoverSettleMs: 0,
      shopPurchaseButtonSettleMs: 0,
      shopPurchaseSettleMs: 0,
      shopPurchaseConfirmMs: 0,
      shopPurchaseRetries: 1,
    },
  );
  assert.equal(result.interrupted, true);
  assert.equal(clicks.length, 0);
});

test("executeActions dry-run never sends input", async () => {
  const calls = [];
  const bridge = {
    focus: async () => ({ focused: true }),
    stopPressed: async () => ({ pressed: false }),
    click: async () => calls.push("click"),
    key: async () => calls.push("key"),
  };
  const seen = [];
  await executeActions(validatePlan(plan(), config).actions, {
    bridge,
    delayMs: 0,
    dryRun: true,
    onAction: (action) => seen.push(action.type),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(seen, ["click"]);
});

test("waitForInputFocus waits locally until the game is foreground", async () => {
  const focusResults = [false, false, true];
  const events = [];
  const bridge = {
    focus: async () => ({ focused: focusResults.shift() }),
    stopPressed: async () => ({ pressed: false }),
  };
  const result = await waitForInputFocus({
    bridge,
    retryMs: 0,
    onWaiting: ({ attempts }) => events.push(["waiting", attempts]),
    onRestored: ({ attempts }) => events.push(["restored", attempts]),
  });
  assert.deepEqual(result, { focused: true, attempts: 3, waited: true });
  assert.deepEqual(events, [
    ["waiting", 1],
    ["restored", 3],
  ]);
});
