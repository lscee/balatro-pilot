import test from "node:test";
import assert from "node:assert/strict";

import {
  BALATRO_CONSUMABLE_KEYS,
  balatroConsumableCandidateFallbackSafe,
  balatroConsumableStrategy,
  balatroPackHasSafeConsumableChoice,
  generateBalatroConsumablePackCandidates,
  generateBalatroConsumableShopUseCandidates,
  generateBalatroConsumableUseCandidates,
  inspectBalatroConsumables,
} from "../src/balatro-consumable-strategy.mjs";
import { validateBalatrobotPlan } from "../src/balatrobot-policy.mjs";
import { assertBalatrobotCandidateAction } from "../src/balatrobot-solver.mjs";

function playing(rank, suit, { enhancement = null, edition = null, seal = null } = {}) {
  return {
    key: `${suit}_${rank}`,
    value: { rank, suit },
    modifier: { enhancement, edition, seal },
    state: {},
  };
}

function joker(key, { sell = 2, edition = null, eternal = false, effect = "" } = {}) {
  return { key, label: key, set: "JOKER", cost: { sell }, modifier: { edition, eternal }, value: { effect }, state: {} };
}

function state({ state: phase = "SELECTING_HAND", consumables = [], pack = [], jokers = [], hand = null, money = 5, ...extra } = {}) {
  const handCards = hand ?? [
    playing("A", "S"), playing("A", "H"), playing("K", "D"), playing("Q", "C"),
    playing("9", "S"), playing("7", "H"), playing("4", "D"), playing("2", "C"),
  ];
  return {
    state: phase,
    money,
    hand: { count: handCards.length, limit: 8, highlighted_limit: 5, cards: handCards },
    jokers: { count: jokers.length, limit: 5, cards: jokers },
    consumables: { count: consumables.length, limit: 2, cards: consumables },
    pack: { count: pack.length, cards: pack },
    hands: {
      Pair: { chips: 10, mult: 2, level: 1, played: 3 },
      "High Card": { chips: 5, mult: 1, level: 1, played: 1 },
    },
    ...extra,
  };
}

function evaluateBestPlay(exact) {
  const hand = exact.hand.cards;
  const groups = new Map();
  for (const card of hand) {
    const key = String(card.value?.rank ?? card.rank);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const pair = Math.max(0, ...groups.values()) >= 2;
  const values = exact.hands?.[pair ? "Pair" : "High Card"] ?? { chips: 5, mult: 1 };
  const editions = hand.filter((card) => String(card.modifier?.edition ?? "").includes("RANDOM")).length;
  const bonuses = hand.filter((card) => String(card.modifier?.enhancement ?? "").includes("BONUS")).length;
  const stones = hand.filter((card) => String(card.modifier?.enhancement ?? "").includes("STONE")).length;
  return {
    handType: pair ? "Pair" : "High Card",
    conservativeScore: (values.chips + bonuses * 30 + editions * 20 + hand.length * 5 - stones * 20) * values.mult,
  };
}

test("every vanilla Tarot, Planet and Spectral key has an explicit support descriptor", () => {
  const expected = [
    "c_fool", "c_magician", "c_high_priestess", "c_empress", "c_emperor", "c_heirophant",
    "c_lovers", "c_chariot", "c_justice", "c_hermit", "c_wheel_of_fortune", "c_strength",
    "c_hanged_man", "c_death", "c_temperance", "c_devil", "c_tower", "c_star", "c_moon",
    "c_sun", "c_judgement", "c_world",
    "c_pluto", "c_mercury", "c_uranus", "c_venus", "c_saturn", "c_jupiter", "c_earth",
    "c_mars", "c_neptune", "c_planet_x", "c_ceres", "c_eris",
    "c_familiar", "c_grim", "c_incantation", "c_talisman", "c_aura", "c_wraith", "c_sigil",
    "c_ouija", "c_ectoplasm", "c_immolate", "c_ankh", "c_deja_vu", "c_hex", "c_trance",
    "c_medium", "c_cryptid", "c_soul", "c_black_hole",
  ].toSorted();
  assert.deepEqual(BALATRO_CONSUMABLE_KEYS, expected);
  for (const key of expected) {
    const strategy = balatroConsumableStrategy(key);
    assert.equal(strategy.known, true, key);
    assert.ok(["exact", "strategic", "blocked"].includes(strategy.support), key);
  }
  assert.equal(balatroConsumableStrategy("c_modded_unknown").support, "unsupported");
});

test("the installed vanilla catalog cannot add an unclassified Tarot, Planet, or Spectral card", async (context) => {
  let gameLua;
  try {
    const { archiveEntry, findBalatroExecutable } = await import("../src/balatro-card-assets.mjs");
    const executable = findBalatroExecutable();
    if (!executable) return context.skip("Balatro.exe is unavailable");
    gameLua = archiveEntry(executable, "game.lua", "utf8");
  } catch (error) {
    return context.skip(`installed catalog unavailable: ${error.message}`);
  }
  const installed = [];
  for (const line of gameLua.split(/\r?\n/u)) {
    const key = line.match(/^\s*(c_[a-z0-9_]+)\s*=\s*\{/iu)?.[1]?.toLowerCase();
    const set = line.match(/\bset\s*=\s*["'](Tarot|Planet|Spectral)["']/u)?.[1];
    if (key && set) installed.push(key);
  }
  assert.ok(installed.length >= 52);
  assert.deepEqual(
    installed.filter((key) => !balatroConsumableStrategy(key).known),
    [],
  );
});

test("unknown owned consumables fail closed while patched Aura targets only editionless cards", () => {
  const exact = state({ consumables: [
    { key: "c_modded_unknown", set: "TAROT" },
    { key: "c_aura", set: "SPECTRAL" },
  ], hand: [
    playing("A", "S", { edition: "FOIL" }),
    playing("K", "H"),
  ] });
  const inspected = inspectBalatroConsumables(exact);
  assert.equal(inspected[0].executable, false);
  assert.match(inspected[0].blockedReason, /fails closed/);
  assert.equal(inspected[1].executable, true);
  assert.equal(inspected[1].blockedReason, "");
  const aura = generateBalatroConsumableUseCandidates(exact, { evaluateBestPlay })
    .filter((candidate) => candidate.card?.key === "c_aura");
  assert.equal(aura.length, 1);
  assert.deepEqual(aura[0].action.cards, [1]);
  assert.equal(aura[0].requiresStrategic, true);
});

test("targeted owned cards require SELECTING_HAND while no-target cards can be used in SHOP", () => {
  const shop = state({
    state: "SHOP",
    consumables: [
      { key: "c_strength", label: "Strength", set: "TAROT" },
      { key: "c_hermit", label: "The Hermit", set: "TAROT" },
    ],
    money: 8,
  });
  const candidates = generateBalatroConsumableUseCandidates(shop, { evaluateBestPlay });
  assert.equal(candidates.some((candidate) => candidate.card.key === "c_strength"), false);
  const hermit = candidates.find((candidate) => candidate.card.key === "c_hermit");
  assert.deepEqual(hermit.action, { method: "use", consumable: 1 });
  assert.equal(hermit.expectedValue, 800);
  assert.equal(hermit.requiresStrategic, true);
});

test("Hex is safe only for a sole worthwhile Joker and destructive choices never enter fallback", () => {
  const one = state({
    consumables: [{ key: "c_hex", label: "Hex", set: "SPECTRAL" }],
    jokers: [joker("j_jolly", { effect: "+8 Mult" })],
  });
  const soleHex = generateBalatroConsumableUseCandidates(one, { evaluateBestPlay })[0];
  assert.equal(soleHex.card.key, "c_hex");
  assert.equal(soleHex.harmful, false);
  assert.equal(soleHex.destructive, true);
  assert.equal(balatroConsumableCandidateFallbackSafe(soleHex), false);

  const two = state({
    consumables: [{ key: "c_hex", label: "Hex", set: "SPECTRAL" }],
    jokers: [joker("j_jolly"), joker("j_cavendish", { effect: "X3 Mult", sell: 5 })],
  });
  const destructiveHex = generateBalatroConsumableUseCandidates(two, { evaluateBestPlay })[0];
  assert.equal(destructiveHex.harmful, true);
  assert.match(destructiveHex.assessment, /destroy other non-Eternal/);
});

test("Ankh, Ectoplasm, Immolate and Wraith expose stateful costs", () => {
  const ankh = generateBalatroConsumableUseCandidates(state({
    consumables: [{ key: "c_ankh", label: "Ankh", set: "SPECTRAL" }],
    jokers: [joker("j_jolly")],
  }), { evaluateBestPlay })[0];
  assert.match(ankh.assessment, /sole Joker/);
  assert.equal(ankh.requiresStrategic, true);

  const ectoplasm = generateBalatroConsumableUseCandidates(state({
    consumables: [{ key: "c_ectoplasm", label: "Ectoplasm", set: "SPECTRAL" }],
    jokers: [joker("j_jolly"), joker("j_cavendish")],
    hand: [playing("A", "S"), playing("K", "S"), playing("Q", "S"), playing("J", "S"), playing("T", "S")],
  }), { evaluateBestPlay })[0];
  assert.match(ectoplasm.assessment, /hand size/);
  assert.equal(ectoplasm.harmful, true);

  const immolate = generateBalatroConsumableUseCandidates(state({
    consumables: [{ key: "c_immolate", label: "Immolate", set: "SPECTRAL" }],
  }), { evaluateBestPlay })[0];
  assert.match(immolate.assessment, /\$20/);
  assert.equal(immolate.destructive, true);

  const wraith = generateBalatroConsumableUseCandidates(state({
    money: 30,
    consumables: [{ key: "c_wraith", label: "Wraith", set: "SPECTRAL" }],
    jokers: [],
  }), { evaluateBestPlay })[0];
  assert.equal(wraith.harmful, true);
  assert.match(wraith.assessment, /\$30 to \$0/);
});

test("Death and Cryptid emit ordered, locally simulated copy targets", () => {
  const exact = state({
    consumables: [
      { key: "c_death", label: "Death", set: "TAROT" },
      { key: "c_cryptid", label: "Cryptid", set: "SPECTRAL" },
    ],
    hand: [
      playing("2", "C"),
      playing("A", "S", { enhancement: "BONUS", seal: "RED", edition: "POLYCHROME" }),
      playing("K", "H"),
    ],
  });
  const candidates = generateBalatroConsumableUseCandidates(exact, { evaluateBestPlay, limit: 20 });
  const death = candidates.filter((candidate) => candidate.card.key === "c_death");
  const cryptid = candidates.filter((candidate) => candidate.card.key === "c_cryptid");
  assert.ok(death.length > 0);
  assert.ok(death.every((candidate) => candidate.action.cards[0] < candidate.action.cards[1]));
  assert.ok(death.some((candidate) => candidate.action.cards.join(",") === "0,1"));
  assert.equal(death.some((candidate) => candidate.action.cards.join(",") === "1,0"), false);
  const copyStrong = death.find((candidate) => candidate.action.cards.join(",") === "0,1");
  assert.match(copyStrong.assessment, /copy card 1 onto card 0/);
  assert.ok(Number.isFinite(copyStrong.longTermValue));
  assert.equal(copyStrong.destructive, true);
  assert.equal(copyStrong.fallbackSafe, false);
  assert.equal(balatroConsumableCandidateFallbackSafe(copyStrong), false);
  assert.ok(cryptid.length > 0);
  assert.deepEqual(cryptid[0].action.cards, [1]);
  assert.ok(cryptid[0].expectedValue > cryptid.at(-1).expectedValue);
});

test("Justice, Chariot and Devil expose distinct top-K permanent deck edits", () => {
  const constantPlay = () => ({ handType: "High Card", conservativeScore: 100 });
  const exact = state({
    consumables: [
      { key: "c_justice", label: "Justice", set: "TAROT" },
      { key: "c_chariot", label: "The Chariot", set: "TAROT" },
      { key: "c_devil", label: "The Devil", set: "TAROT" },
    ],
    hand: [
      playing("A", "S"),
      playing("K", "H"),
      playing("2", "C", { enhancement: "BONUS" }),
      playing("3", "D"),
    ],
  });
  const candidates = generateBalatroConsumableUseCandidates(exact, {
    evaluateBestPlay: constantPlay,
    limit: 20,
  });
  for (const key of ["c_justice", "c_chariot", "c_devil"]) {
    const targeted = candidates.filter((candidate) => candidate.card.key === key);
    assert.equal(targeted.length, 3, key);
    assert.ok(targeted.every((candidate) => candidate.requiresStrategic === true), key);
    assert.ok(targeted.every((candidate) => Number.isFinite(candidate.longTermValue)), key);
  }
  const chariot = candidates.filter((candidate) => candidate.card.key === "c_chariot");
  const devil = candidates.filter((candidate) => candidate.card.key === "c_devil");
  assert.deepEqual(chariot[0].action.cards, [0], "Steel favors a durable high-rank held card");
  assert.deepEqual(devil[0].action.cards, [3], "Gold favors an unenhanced off-hand low-rank economy card");

  const overwriteCandidates = generateBalatroConsumableUseCandidates(state({
    consumables: [{ key: "c_justice", label: "Justice", set: "TAROT" }],
    hand: [
      playing("A", "S"),
      playing("K", "H"),
      playing("2", "C", { enhancement: "BONUS" }),
    ],
  }), { evaluateBestPlay: constantPlay, limit: 20 });
  const justiceOverwrite = overwriteCandidates.find((candidate) =>
    candidate.card.key === "c_justice" && candidate.action.cards[0] === 2);
  assert.equal(justiceOverwrite.harmful, true);
  assert.equal(justiceOverwrite.fallbackSafe, false);
  assert.match(justiceOverwrite.assessment, /replaces an existing enhancement/);
});

test("targeted top-K generation bounds large-hand combinations and skips no-op suit targets", () => {
  const largeHand = Array.from({ length: 30 }, (_, index) =>
    playing(String(2 + (index % 9)), index % 5 === 0 ? "H" : ["S", "D", "C"][index % 3]));
  let evaluations = 0;
  const exact = state({
    consumables: [{ key: "c_sun", label: "The Sun", set: "TAROT" }],
    hand: largeHand,
  });
  const candidates = generateBalatroConsumableUseCandidates(exact, {
    evaluateBestPlay(current) {
      evaluations += 1;
      return { handType: "High Card", conservativeScore: current.hand.cards.length * 10 };
    },
    limit: 20,
  });
  assert.equal(candidates.length, 3);
  assert.ok(evaluations <= 73, `expected at most 72 target simulations plus one baseline, got ${evaluations}`);
  assert.ok(candidates.every((candidate) => candidate.requiresStrategic === true));
  assert.ok(candidates.every((candidate) => candidate.action.cards.every(
    (index) => largeHand[index].value.suit !== "H",
  )));
});

test("Aura pack targeting excludes cards which already have an edition", () => {
  const exact = state({
    state: "SMODS_BOOSTER_OPENED",
    pack: [{ key: "c_aura", label: "Aura", set: "SPECTRAL" }],
    hand: [
      playing("A", "S", { edition: "FOIL" }),
      playing("K", "H"),
      playing("Q", "D", { edition: "POLYCHROME" }),
    ],
  });
  const aura = generateBalatroConsumablePackCandidates(exact, { evaluateBestPlay })
    .filter((candidate) => candidate.card?.key === "c_aura");
  assert.equal(aura.length, 1);
  assert.deepEqual(aura[0].action.targets, [1]);
  assert.equal(aura[0].fallbackSafe, false);
});

test("Hex requires an editionless Joker and Ankh preserves Eternal Joker value", () => {
  const blockedHex = generateBalatroConsumableUseCandidates(state({
    consumables: [{ key: "c_hex", label: "Hex", set: "SPECTRAL" }],
    jokers: [joker("j_foil", { edition: "FOIL" }), joker("j_negative", { edition: "NEGATIVE" })],
  }), { evaluateBestPlay });
  assert.deepEqual(blockedHex, []);

  const ankh = generateBalatroConsumableUseCandidates(state({
    consumables: [{ key: "c_ankh", label: "Ankh", set: "SPECTRAL" }],
    jokers: [
      joker("j_eternal_engine", { eternal: true, sell: 10, effect: "X5 Mult" }),
      joker("j_bridge", { sell: 1 }),
    ],
  }), { evaluateBestPlay })[0];
  assert.match(ankh.assessment, /preserve 1 Eternal/);
  assert.ok(ankh.expectedValue > -2_000);
});

test("Ectoplasm prefers the exact native escalating penalty over stale card text", () => {
  const exact = state({
    ecto_minus: 3,
    consumables: [{
      key: "c_ectoplasm",
      label: "Ectoplasm",
      set: "SPECTRAL",
      value: { effect: "给随机小丑牌增加负片版本 手牌上限-2" },
    }],
    jokers: [joker("j_jolly")],
  });
  exact.hand.limit = 8;
  const ectoplasm = generateBalatroConsumableUseCandidates(exact, { evaluateBestPlay })[0];
  assert.match(ectoplasm.assessment, /8 -> 5/);
});

test("The Fool and full-slot pack generators fail closed when game preconditions are not exposed", () => {
  const fool = generateBalatroConsumableUseCandidates(state({
    consumables: [{ key: "c_fool", label: "The Fool", set: "TAROT" }],
  }), { evaluateBestPlay });
  assert.deepEqual(fool, []);

  const knownFool = generateBalatroConsumableUseCandidates(state({
    last_tarot_planet: "c_death",
    consumables: [{ key: "c_fool", label: "The Fool", set: "TAROT" }],
  }), { evaluateBestPlay });
  assert.equal(knownFool.length, 1);
  assert.match(knownFool[0].assessment, /c_death/);

  const exact = state({
    state: "SMODS_BOOSTER_OPENED",
    consumables: [
      { key: "c_mercury", set: "PLANET" },
      { key: "c_star", set: "TAROT" },
    ],
    pack: [{ key: "c_high_priestess", label: "The High Priestess", set: "TAROT" }],
  });
  const choices = generateBalatroConsumablePackCandidates(exact, { evaluateBestPlay });
  assert.deepEqual(choices.map((candidate) => candidate.id), ["pack:skip"]);
});

test("flat generated actions pass the current planner and candidate contracts on raw state", () => {
  const selecting = state({
    consumables: [{ key: "c_strength", label: "Strength", set: "TAROT" }],
    hand: [playing("A", "S"), playing("K", "H"), playing("4", "D")],
  });
  const useCandidate = generateBalatroConsumableUseCandidates(selecting, { evaluateBestPlay })[0];
  const { method: useMethod, ...useParams } = useCandidate.action;
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: useMethod, params: useParams },
    [useCandidate],
    selecting,
  ));
  assert.doesNotThrow(() => validateBalatrobotPlan({
    observation: "exact",
    strategy: "Strength",
    memory: "test",
    confidence: 0.9,
    actions: [{ ...useCandidate.action, reason: "use Strength" }],
  }, selecting));

  const opened = state({
    state: "SMODS_BOOSTER_OPENED",
    pack: [{ key: "c_aura", label: "Aura", set: "SPECTRAL" }],
    hand: [playing("A", "S"), playing("K", "H", { edition: "FOIL" })],
  });
  const packCandidate = generateBalatroConsumablePackCandidates(opened, { evaluateBestPlay })
    .find((candidate) => !candidate.action.skip);
  const { method: packMethod, ...packParams } = packCandidate.action;
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: packMethod, params: packParams },
    [packCandidate],
    opened,
  ));
  assert.doesNotThrow(() => validateBalatrobotPlan({
    observation: "exact",
    strategy: "Aura",
    memory: "test",
    confidence: 0.9,
    actions: [{ ...packCandidate.action, reason: "use Aura" }],
  }, opened));
});

test("compact openedPack is accepted for generation but raw pack remains the RPC validation source", () => {
  const exact = state({ state: "SMODS_BOOSTER_OPENED", pack: [] });
  exact.openedPack = {
    count: 1,
    cards: [{ key: "c_black_hole", label: "Black Hole", set: "SPECTRAL" }],
  };
  const candidates = generateBalatroConsumablePackCandidates(exact, { evaluateBestPlay });
  assert.ok(candidates.some((candidate) => candidate.card?.key === "c_black_hole"));
});

test("Strength and Tower values come from transformations instead of fixed emergency scores", () => {
  const exact = state({
    consumables: [
      { key: "c_strength", label: "Strength", set: "TAROT" },
      { key: "c_tower", label: "The Tower", set: "TAROT" },
    ],
    hand: [playing("A", "S"), playing("A", "H"), playing("K", "D")],
  });
  const candidates = generateBalatroConsumableUseCandidates(exact, { evaluateBestPlay, limit: 20 });
  const strength = candidates.find((candidate) => candidate.card.key === "c_strength");
  const tower = candidates.find((candidate) => candidate.card.key === "c_tower");
  assert.notEqual(strength.expectedValue, 900);
  assert.notEqual(tower.expectedValue, 900);
  assert.equal(typeof strength.projectedScore, "number");
  assert.equal(typeof tower.scoreGain, "number");
  assert.equal(tower.destructive, true);
  assert.equal(tower.eligibleForEmergency, false);
});

test("harmful Spectral pack offers remain skippable and never count as a safe choice", () => {
  const exact = state({
    state: "SMODS_BOOSTER_OPENED",
    pack: [
      { key: "c_hex", label: "Hex", set: "SPECTRAL" },
      { key: "c_ectoplasm", label: "Ectoplasm", set: "SPECTRAL" },
    ],
    jokers: [joker("j_jolly"), joker("j_cavendish", { effect: "X3 Mult", sell: 5 })],
  });
  exact.hand.limit = 5;
  const candidates = generateBalatroConsumablePackCandidates(exact, { evaluateBestPlay });
  const choices = candidates.filter((candidate) => !candidate.action.skip);
  assert.ok(choices.length > 0);
  assert.ok(choices.every((candidate) => candidate.harmful && !candidate.safeChoice));
  assert.equal(balatroPackHasSafeConsumableChoice(candidates), false);
  assert.ok(candidates.some((candidate) => candidate.action.skip));
});

test("Black Hole is a safe high-value pack choice while destructive choices still require strategy", () => {
  const exact = state({
    state: "SMODS_BOOSTER_OPENED",
    pack: [
      { key: "c_black_hole", label: "Black Hole", set: "SPECTRAL" },
      { key: "c_immolate", label: "Immolate", set: "SPECTRAL" },
    ],
  });
  const candidates = generateBalatroConsumablePackCandidates(exact, { evaluateBestPlay });
  const blackHole = candidates.find((candidate) => candidate.card?.key === "c_black_hole");
  const immolate = candidates.find((candidate) => candidate.card?.key === "c_immolate");
  assert.equal(blackHole.safeChoice, true);
  assert.equal(balatroPackHasSafeConsumableChoice(candidates), true);
  assert.equal(immolate.destructive, true);
  assert.equal(immolate.fallbackSafe, false);
  assert.ok(blackHole.expectedValue > immolate.expectedValue);
});

test("shop Buy & Use works at full consumable capacity without entering fallback", () => {
  const exact = state({
    state: "SHOP",
    money: 20,
    consumables: [
      { key: "c_death", label: "Death", set: "TAROT" },
      { key: "c_strength", label: "Strength", set: "TAROT" },
    ],
    shop: { count: 2, cards: [
      { key: "c_hermit", label: "The Hermit", set: "TAROT", cost: { buy: 4, sell: 2 } },
      { key: "c_emperor", label: "The Emperor", set: "TAROT", cost: { buy: 4, sell: 2 } },
    ] },
  });
  const choices = generateBalatroConsumableShopUseCandidates(exact, { evaluateBestPlay });
  const hermit = choices.find((candidate) => candidate.card.key === "c_hermit");
  assert.deepEqual(hermit.action, { method: "buy_use", card: 0 });
  assert.equal(hermit.requiresStrategic, true);
  assert.equal(hermit.fallbackSafe, false);
  assert.equal(choices.some((candidate) => candidate.card.key === "c_emperor"), false,
    "a shop generator cannot pretend that Buy & Use frees an owned consumable slot");
});

test("shop Buy & Use ignores the overdraft from a debuffed Credit Card", () => {
  const exact = state({
    state: "SHOP",
    money: -13,
    jokers: [{ key: "j_credit_card", label: "Credit Card", state: { debuff: true } }],
    shop: { count: 1, cards: [
      { key: "c_hermit", label: "The Hermit", set: "TAROT", cost: { buy: 3, sell: 1 } },
    ] },
  });
  assert.equal(generateBalatroConsumableShopUseCandidates(exact, { evaluateBestPlay }).length, 0);

  exact.jokers.cards[0].state.debuff = false;
  assert.equal(generateBalatroConsumableShopUseCandidates(exact, { evaluateBestPlay }).length, 1);
});
