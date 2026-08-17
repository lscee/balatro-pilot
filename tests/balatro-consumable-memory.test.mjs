import test from "node:test";
import assert from "node:assert/strict";

import { BalatroOwnedConsumableAgeTracker } from "../src/balatro-consumable-memory.mjs";

function state({ seed = "AGE-SEED", round = 4, ante = 2, cards = [], phase = "SHOP" } = {}) {
  return {
    state: phase,
    seed,
    round_num: round,
    ante_num: ante,
    consumables: { count: cards.length, limit: 2, cards },
  };
}

const tower = (id = 101) => ({ id, key: "c_tower", set: "TAROT", label: "The Tower" });

test("owned consumable age advances once per global round, not per phase or Boss ante change", () => {
  const tracker = new BalatroOwnedConsumableAgeTracker();
  assert.equal(tracker.observe(state({ cards: [tower()] })).byId[101].blindAge, 0);
  assert.equal(tracker.observe(state({ cards: [tower()], phase: "SELECTING_HAND" })).byId[101].blindAge, 0);
  assert.equal(tracker.observe(state({ cards: [tower()], phase: "ROUND_EVAL", ante: 3 })).byId[101].blindAge, 0);
  assert.equal(tracker.observe(state({ cards: [tower()], round: 5, ante: 3 })).byId[101].blindAge, 1);
  assert.equal(tracker.observe(state({ cards: [tower()], round: 5, phase: "BLIND_SELECT", ante: 3 })).byId[101].blindAge, 1);
});

test("owned consumable age uses runtime id and fails closed on removal, duplicates, or id recycling", () => {
  const tracker = new BalatroOwnedConsumableAgeTracker();
  tracker.observe(state({ cards: [tower()] }));
  assert.equal(tracker.observe(state({ cards: [tower()], round: 5 })).byId[101].blindAge, 1);
  assert.deepEqual(tracker.observe(state({ cards: [tower(), tower()] })).byId, {});
  assert.equal(tracker.observe(state({ cards: [tower()], round: 6 })).byId[101].blindAge, 0);
  assert.equal(tracker.observe(state({ cards: [{ ...tower(), key: "c_justice" }], round: 7 })).byId[101].blindAge, 0);
  assert.deepEqual(tracker.observe(state({ cards: [{ id: null, key: "c_tower", set: "TAROT" }], round: 8 })).byId, {});
});

test("owned consumable age resets on seed change, MENU, and same-seed round rollback", () => {
  const tracker = new BalatroOwnedConsumableAgeTracker();
  tracker.observe(state({ cards: [tower()] }));
  tracker.observe(state({ cards: [tower()], round: 5 }));
  assert.equal(tracker.observe(state({ seed: "OTHER", cards: [tower()], round: 5 })).byId[101].blindAge, 0);
  assert.deepEqual(tracker.observe({ state: "MENU", seed: "OTHER" }).byId, {});
  tracker.observe(state({ cards: [tower()], round: 6 }));
  assert.equal(tracker.observe(state({ cards: [tower()], round: 1 })).byId[101].blindAge, 0);
});

test("missing transitional consumable areas preserve records without inventing age", () => {
  const tracker = new BalatroOwnedConsumableAgeTracker();
  tracker.observe(state({ cards: [tower()] }));
  tracker.observe({ state: "ROUND_EVAL", seed: "AGE-SEED", round_num: 5, ante_num: 2 });
  assert.equal(tracker.observe(state({ cards: [tower()], round: 5 })).byId[101].blindAge, 1);
});

test("tracker stays empty before a real seed exists", () => {
  const tracker = new BalatroOwnedConsumableAgeTracker();
  assert.deepEqual(tracker.observe(state({ seed: "", cards: [tower()] })).byId, {});
});
