import test from "node:test";
import assert from "node:assert/strict";

import {
  balatroCardMatchesSuit,
  balatroConsumableTargetRule,
  classifyBalatroHand,
  validateBalatroConsumableTargets,
} from "../src/balatro-rules-engine.mjs";

function card(rank, suit, { enhancement = null, debuff = false, key = `${suit}_${rank}`, set = "DEFAULT" } = {}) {
  return {
    key,
    set,
    value: { rank, suit },
    modifier: { enhancement },
    state: { debuff },
  };
}

function state(jokers = []) {
  return { jokers: { count: jokers.length, limit: 5, cards: jokers.map((key) => ({ key })) } };
}

test("one rules engine applies Smeared suits to hand classification and suit checks", () => {
  const exact = state(["j_smeared"]);
  const cards = [card("T", "S"), card("7", "S"), card("5", "S"), card("5", "C"), card("2", "C")];
  assert.equal(classifyBalatroHand(exact, cards, [0, 1, 2, 3, 4]).handType, "Flush");
  assert.equal(balatroCardMatchesSuit(exact, card("Q", "H"), "D"), true);
  assert.equal(balatroCardMatchesSuit(exact, card("Q", "H"), "S"), false);
});

test("Four Fingers, Shortcut and Wild are composable rule effects", () => {
  const four = state(["j_four_fingers"]);
  const fourCards = [card("2", "S"), card("3", "S"), card("4", "S"), card("5", "S"), card("K", "H")];
  const straightFlush = classifyBalatroHand(four, fourCards, [0, 1, 2, 3, 4]);
  assert.equal(straightFlush.handType, "Straight Flush");
  assert.deepEqual(straightFlush.scoringCards, [0, 1, 2, 3]);

  const shortcut = state(["j_shortcut"]);
  assert.equal(
    classifyBalatroHand(shortcut, [card("2", "H"), card("4", "D"), card("6", "C"), card("8", "S"), card("T", "H")], [0, 1, 2, 3, 4]).handType,
    "Straight",
  );

  const wildFlush = [card("A", "D"), card("K", "D"), card("8", "D"), card("4", "D"), card("2", "H", { enhancement: "WILD" })];
  assert.equal(classifyBalatroHand(state(), wildFlush, [0, 1, 2, 3, 4]).handType, "Flush");
});

test("vanilla consumable target contracts are explicit and fail closed", () => {
  const star = { key: "c_star", set: "TAROT" };
  const death = { key: "c_death", set: "TAROT" };
  assert.deepEqual(balatroConsumableTargetRule(star), {
    key: "c_star", known: true, min: 1, max: 3, kind: "suit", suit: "D",
  });
  assert.throws(() => validateBalatroConsumableTargets(star, [], state(), "pack.card"), /requires 1-3/);
  assert.throws(() => validateBalatroConsumableTargets(death, [0], state(), "pack.card"), /exactly 2/);
  assert.doesNotThrow(() => validateBalatroConsumableTargets(death, [0, 1], state(), "pack.card"));
  assert.throws(
    () => validateBalatroConsumableTargets({ key: "c_modded_unknown", set: "TAROT" }, [], state(), "pack.card"),
    /unknown target contract/,
  );
});

test("vanilla no-target Tarot and Spectral cards do not invent hand targets", () => {
  for (const key of [
    "c_hermit",
    "c_temperance",
    "c_judgement",
    "c_wheel_of_fortune",
    "c_immolate",
    "c_hex",
    "c_soul",
    "c_black_hole",
  ]) {
    const set = key === "c_hermit" || key === "c_temperance" || key === "c_judgement" || key === "c_wheel_of_fortune"
      ? "TAROT"
      : "SPECTRAL";
    const rule = balatroConsumableTargetRule({ key, set });
    assert.equal(rule.known, true, key);
    assert.equal(rule.min, 0, key);
    assert.equal(rule.max, 0, key);
    assert.doesNotThrow(() => validateBalatroConsumableTargets({ key, set }, [], state(), "pack.card"));
  }
});
