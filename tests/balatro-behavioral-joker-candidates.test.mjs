import test from "node:test";
import assert from "node:assert/strict";

import {
  assertBalatrobotCandidateAction,
  balatrobotSurvivalAssessment,
  filterBalatrobotExecutableCandidates,
  generateBalatrobotCandidates,
} from "../src/balatrobot-solver.mjs";

function card(rank, suit, { enhancement = null, edition = null, seal = null } = {}) {
  return {
    value: { rank, suit },
    state: { debuff: false },
    modifier: { enhancement, edition, seal },
  };
}

function exactState({
  hand = [
    card("A", "S"), card("A", "H"), card("K", "D"), card("Q", "C"),
    card("9", "S"), card("7", "H"), card("6", "D"), card("2", "C"),
  ],
  jokers = [],
  handsLeft = 4,
  handsPlayed = 0,
  discardsLeft = 3,
  discardsUsed = 0,
  chips = 0,
  target = 300,
  blind = { type: "SMALL", status: "CURRENT", name: "Small Blind" },
  consumables = [],
  consumableLimit = 2,
  hands = {},
} = {}) {
  return {
    state: "SELECTING_HAND",
    round: {
      chips,
      hands_left: handsLeft,
      hands_played: handsPlayed,
      discards_left: discardsLeft,
      discards_used: discardsUsed,
    },
    hand: { cards: hand, highlighted_limit: 5 },
    cards: { cards: [] },
    jokers: { count: jokers.length, limit: 5, cards: jokers },
    consumables: { count: consumables.length, limit: consumableLimit, cards: consumables },
    blinds: { small: { ...blind, score: target } },
    hands,
  };
}

function behaviorCandidate(candidates, key) {
  return candidates.find((candidate) => candidate.behavioralJoker?.key === key);
}

test("DNA exposes one strategically approved first-hand copy without a routine-action bypass", () => {
  const state = exactState({
    target: 100,
    jokers: [{ key: "j_dna", label: "DNA" }],
    hand: [
      card("A", "S", { edition: "POLYCHROME", seal: "RED" }),
      card("A", "H"), card("K", "D"), card("Q", "C"), card("9", "S"), card("7", "H"), card("4", "D"), card("2", "C"),
    ],
  });
  const candidates = generateBalatrobotCandidates(state, { limit: 20 });
  const dna = behaviorCandidate(candidates, "j_dna");

  assert.ok(dna);
  assert.deepEqual(dna.action, { method: "play", cards: [0] });
  assert.equal(dna.requiresStrategic, true);
  assert.equal(dna.survivalFloor.safe, true);
  assert.equal(candidates.some((candidate) => candidate.id === "play:0"), false);
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "play", params: { cards: [0] } },
    candidates,
    state,
  ));

  const afterFirstHand = exactState({ ...state, jokers: state.jokers.cards, handsPlayed: 1 });
  assert.equal(behaviorCandidate(generateBalatrobotCandidates(afterFirstHand, { limit: 20 }), "j_dna"), undefined);
});

test("DNA and Sixth Sense setup candidates fail closed when the measured remaining line cannot survive", () => {
  const impossible = exactState({
    target: 100_000,
    jokers: [{ key: "j_dna" }, { key: "j_sixth_sense" }],
  });
  const impossibleCandidates = generateBalatrobotCandidates(impossible, { limit: 20 });
  assert.equal(behaviorCandidate(impossibleCandidates, "j_dna"), undefined);
  assert.equal(behaviorCandidate(impossibleCandidates, "j_sixth_sense"), undefined);

  const fullSlots = exactState({
    jokers: [{ key: "j_sixth_sense" }],
    consumables: [{ key: "c_pluto" }, { key: "c_mercury" }],
  });
  assert.equal(behaviorCandidate(generateBalatrobotCandidates(fullSlots, { limit: 20 }), "j_sixth_sense"), undefined);
});

test("Sixth Sense exposes only a first-hand single 6 and marks the destruction", () => {
  const state = exactState({ target: 150, jokers: [{ key: "j_sixth_sense", label: "Sixth Sense" }] });
  const candidates = generateBalatrobotCandidates(state, { limit: 20 });
  const sixth = behaviorCandidate(candidates, "j_sixth_sense");

  assert.ok(sixth);
  assert.equal(sixth.action.cards.length, 1);
  assert.equal(state.hand.cards[sixth.action.cards[0]].value.rank, "6");
  assert.equal(sixth.requiresStrategic, true);
  assert.equal(sixth.destructive, true);
  assert.equal(sixth.survivalFloor.setupScore, 0);
});

test("Trading Card makes the low first-discard deck cut executable and preserves the scoring core", () => {
  const state = exactState({ target: 200, jokers: [{ key: "j_trading", label: "Trading Card" }] });
  const candidates = generateBalatrobotCandidates(state, { limit: 20 });
  const trading = behaviorCandidate(candidates, "j_trading");

  assert.ok(trading);
  assert.equal(trading.action.method, "discard");
  assert.equal(trading.action.cards.length, 1);
  assert.equal(state.hand.cards[trading.action.cards[0]].value.rank, "2");
  assert.equal(trading.requiresStrategic, true);
  assert.equal(trading.destructive, true);
  assert.equal(candidates.some((candidate) =>
    candidate.id === `discard:${trading.action.cards[0]}` && !candidate.behavioralJoker), false);
  assert.ok(filterBalatrobotExecutableCandidates(state, candidates).some((candidate) => candidate.id === trading.id));

  const used = exactState({ jokers: state.jokers.cards, discardsUsed: 1 });
  assert.equal(behaviorCandidate(generateBalatrobotCandidates(used, { limit: 20 }), "j_trading"), undefined);
});

test("Burnt Joker's first discard follows an evidenced hand route and retains a measured clear", () => {
  const state = exactState({
    jokers: [{ key: "j_burnt", label: "Burnt Joker" }],
    hand: [
      card("A", "S"), card("A", "H"), card("K", "D"), card("K", "C"),
      card("9", "S"), card("7", "H"), card("4", "D"), card("2", "C"),
    ],
    hands: { Pair: { level: 3, played: 8, chips: 40, mult: 4 } },
  });
  const candidates = generateBalatrobotCandidates(state, {
    limit: 24,
    runPlan: { direction: "Pair scaling" },
  });
  const burnt = behaviorCandidate(candidates, "j_burnt");

  assert.ok(burnt);
  assert.equal(burnt.handType, "Pair");
  assert.equal(burnt.action.method, "discard");
  assert.equal(burnt.requiresStrategic, true);
  assert.equal(burnt.survivalFloor.safe, true);
  assert.doesNotThrow(() => assertBalatrobotCandidateAction(
    { method: "discard", params: { cards: burnt.action.cards } },
    candidates,
    state,
  ));
});

test("Luchador is a strategic Boss-only sale and never becomes an automatic required sale", () => {
  const state = exactState({
    target: 600,
    jokers: [{ key: "j_joker" }, { key: "j_luchador", label: "Luchador", modifier: { eternal: false } }],
    blind: { type: "BOSS", status: "CURRENT", name: "The Wall", effect: "Extra large blind" },
  });
  // The helper places a supplied blind under `small`; active-blind selection is
  // status based, so its declared BOSS type remains authoritative.
  const candidates = generateBalatrobotCandidates(state, { limit: 20 });
  const luchador = behaviorCandidate(candidates, "j_luchador");
  const assessment = balatrobotSurvivalAssessment(state, candidates);

  assert.ok(luchador);
  assert.deepEqual(luchador.action, { method: "sell", joker: 1 });
  assert.equal(luchador.requiresStrategic, true);
  assert.equal(luchador.destructive, true);
  assert.equal(luchador.requiredForSurvival, false);
  assert.equal(assessment.requiredBossAction, null);
  assert.equal(assessment.shouldResolveBoss, false);

  const eternal = exactState({
    jokers: [{ key: "j_luchador", modifier: { eternal: true } }],
    blind: { type: "BOSS", status: "CURRENT", name: "The Wall" },
  });
  assert.equal(behaviorCandidate(generateBalatrobotCandidates(eternal, { limit: 20 }), "j_luchador"), undefined);
});

test("Mr. Bones exposes the exact 25% survival threshold without fabricating score", () => {
  const state = exactState({
    target: 1_000,
    chips: 260,
    handsLeft: 1,
    jokers: [{ key: "j_mr_bones", label: "Mr. Bones" }],
  });
  const assessment = balatrobotSurvivalAssessment(state, generateBalatrobotCandidates(state, { limit: 20 }));

  assert.deepEqual(assessment.mrBones, {
    owned: true,
    threshold: 250,
    currentReached: true,
    projectedReached: true,
    canPreventLoss: true,
    destroysOnSave: true,
    exactScoreSupported: false,
  });
  assert.equal(assessment.currentLineCanClear, false);
});
