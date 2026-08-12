import test from "node:test";
import assert from "node:assert/strict";

import { selectBalatroDeck } from "../src/balatro-deck-selector.mjs";

const collectionKnowledge = {
  available: true,
  unlockedDecks: [
    { code: "RED", label: "Red Deck", effect: "+1 discard", order: 1 },
    { code: "BLUE", label: "Blue Deck", effect: "+1 hand", order: 2 },
    { code: "YELLOW", label: "Yellow Deck", effect: "+$10", order: 3 },
  ],
  lockedDecks: [{ code: "BLACK", label: "Black Deck", effect: "+1 slot", order: 5 }],
};

test("adaptive deck selection explores every unlocked deck and excludes locked decks", () => {
  const selected = selectBalatroDeck({
    collectionKnowledge,
    performance: [{ deck: "RED", trials: 1, wins: 1, averageAnte: 8, averageRound: 24 }],
    config: { balatrobotDeck: "RED", balatrobotDeckMode: "adaptive", balatrobotDeckMinimumTrials: 1 },
  });
  assert.equal(selected.deck, "YELLOW", "the deterministic exploration rotation selects an untried deck");
  assert.equal(selected.mode, "explore");
  assert.notEqual(selected.deck, "BLACK");
});

test("adaptive deck selection exploits results while retaining an exploration bonus", () => {
  const selected = selectBalatroDeck({
    collectionKnowledge,
    performance: [
      { deck: "RED", trials: 10, wins: 1, averageAnte: 3, averageRound: 8 },
      { deck: "BLUE", trials: 6, wins: 4, averageAnte: 7, averageRound: 20 },
      { deck: "YELLOW", trials: 8, wins: 1, averageAnte: 4, averageRound: 11 },
    ],
    config: {
      balatrobotDeck: "RED",
      balatrobotDeckMode: "adaptive",
      balatrobotDeckMinimumTrials: 2,
      balatrobotDeckExploration: 1.15,
    },
  });
  assert.equal(selected.deck, "BLUE");
  assert.equal(selected.mode, "adaptive");
});

test("fixed mode honors an unlocked choice and safely rejects a locked configured deck", () => {
  assert.equal(selectBalatroDeck({
    collectionKnowledge,
    config: { balatrobotDeck: "BLUE", balatrobotDeckMode: "fixed" },
  }).deck, "BLUE");
  const locked = selectBalatroDeck({
    collectionKnowledge,
    config: { balatrobotDeck: "BLACK", balatrobotDeckMode: "fixed" },
  });
  assert.equal(locked.deck, "RED");
  assert.match(locked.reason, /locked/u);
});
