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

test("fixed and adaptive modes never send a Stake unavailable to the selected deck", () => {
  const knowledge = {
    ...collectionKnowledge,
    deckProgress: [
      { code: "RED", winsByStake: { WHITE: 1 }, availableStakes: ["WHITE", "RED"], nextStake: "RED" },
      { code: "BLUE", winsByStake: {}, availableStakes: ["WHITE"], nextStake: "WHITE" },
      { code: "YELLOW", winsByStake: {}, availableStakes: ["WHITE"], nextStake: "WHITE" },
    ],
  };
  const fixed = selectBalatroDeck({
    collectionKnowledge: knowledge,
    config: { balatrobotDeck: "BLUE", balatrobotDeckMode: "fixed", balatrobotStake: "RED" },
  });
  assert.equal(fixed.deck, "BLUE");
  assert.equal(fixed.stake, "WHITE");
  const adaptive = selectBalatroDeck({
    collectionKnowledge: knowledge,
    performance: [
      { deck: "RED", trials: 3, wins: 0, averageAnte: 2, averageRound: 4 },
      { deck: "BLUE", trials: 3, wins: 3, averageAnte: 8, averageRound: 24 },
      { deck: "YELLOW", trials: 3, wins: 0, averageAnte: 2, averageRound: 4 },
    ],
    config: { balatrobotDeckMode: "adaptive", balatrobotStake: "RED", balatrobotDeckMinimumTrials: 1 },
  });
  assert.equal(adaptive.deck, "BLUE");
  assert.equal(adaptive.stake, "WHITE");
});

test("missing collection data fails safely to Red Deck on White Stake", () => {
  assert.deepEqual(
    selectBalatroDeck({
      collectionKnowledge: { available: false, unlockedDecks: [] },
      config: { balatrobotDeck: "PLASMA", balatrobotStake: "GOLD", balatrobotDeckMode: "fixed" },
    }),
    {
      deck: "RED",
      stake: "WHITE",
      label: "Red Deck",
      effect: "+1 discard each round",
      mode: "fallback",
      reason: "Deck unlock data is unavailable; fail safely to Red Deck on White Stake",
      stats: null,
    },
  );
});

test("unlock mode clears direct White Stake deck dependencies before climbing Stakes", () => {
  const selected = selectBalatroDeck({
    collectionKnowledge: {
      available: true,
      unlockedDecks: [
        { code: "RED", label: "Red Deck", effect: "+1 discard", order: 1 },
        { code: "BLUE", label: "Blue Deck", effect: "+1 hand", order: 2 },
        { code: "YELLOW", label: "Yellow Deck", effect: "+$10", order: 3 },
        { code: "GREEN", label: "Green Deck", effect: "cash per hand", order: 4 },
        { code: "BLACK", label: "Black Deck", effect: "+1 slot", order: 5 },
        { code: "GHOST", label: "Ghost Deck", effect: "Spectral shop", order: 8 },
      ],
      lockedDecks: [
        { code: "MAGIC" },
        { code: "NEBULA" },
        { code: "ABANDONED" },
        { code: "CHECKERED" },
        { code: "ZODIAC" },
      ],
      deckProgress: [
        { code: "RED", winsByStake: {}, availableStakes: ["WHITE"], nextStake: "WHITE" },
        { code: "BLUE", winsByStake: {}, availableStakes: ["WHITE"], nextStake: "WHITE" },
        { code: "YELLOW", winsByStake: { WHITE: 1 }, availableStakes: ["WHITE", "RED"], nextStake: "RED" },
        { code: "GREEN", winsByStake: {}, availableStakes: ["WHITE"], nextStake: "WHITE" },
        { code: "BLACK", winsByStake: {}, availableStakes: ["WHITE"], nextStake: "WHITE" },
        { code: "GHOST", winsByStake: {}, availableStakes: ["WHITE"], nextStake: "WHITE" },
      ],
    },
    performance: [{ deck: "YELLOW", trials: 20, wins: 10, averageAnte: 8, averageRound: 24 }],
    config: { balatrobotDeckMode: "unlock" },
  });
  assert.equal(selected.deck, "RED");
  assert.equal(selected.stake, "WHITE");
  assert.equal(selected.mode, "unlock");
  assert.deepEqual(selected.targetUnlocks, ["MAGIC"]);
});

test("unlock mode advances the strongest proven deck by exactly one legal Stake toward Plasma", () => {
  const selected = selectBalatroDeck({
    collectionKnowledge: {
      available: true,
      unlockedDecks: [
        { code: "RED", label: "Red Deck", effect: "+1 discard", order: 1 },
        { code: "BLUE", label: "Blue Deck", effect: "+1 hand", order: 2 },
      ],
      lockedDecks: [{ code: "ZODIAC" }, { code: "PAINTED" }, { code: "ANAGLYPH" }, { code: "PLASMA" }],
      deckProgress: [
        {
          code: "RED",
          winsByStake: { WHITE: 1, RED: 1 },
          availableStakes: ["WHITE", "RED", "GREEN"],
          nextStake: "GREEN",
        },
        {
          code: "BLUE",
          winsByStake: { WHITE: 1 },
          availableStakes: ["WHITE", "RED"],
          nextStake: "RED",
        },
      ],
    },
    performance: [
      { deck: "RED", trials: 12, wins: 8, averageAnte: 8, averageRound: 24 },
      { deck: "BLUE", trials: 12, wins: 1, averageAnte: 4, averageRound: 10 },
    ],
    config: { balatrobotDeckMode: "unlock" },
  });
  assert.equal(selected.deck, "RED");
  assert.equal(selected.stake, "GREEN");
  assert.deepEqual(selected.targetUnlocks, ["PAINTED"]);
});

test("unlock mode rejects stale or illegal next-Stake data", () => {
  const selected = selectBalatroDeck({
    collectionKnowledge: {
      available: true,
      unlockedDecks: [
        { code: "RED", label: "Red Deck", effect: "+1 discard", order: 1 },
        { code: "BLUE", label: "Blue Deck", effect: "+1 hand", order: 2 },
      ],
      lockedDecks: [{ code: "PLASMA" }],
      deckProgress: [
        { code: "RED", winsByStake: { WHITE: 1 }, availableStakes: ["WHITE", "RED"], nextStake: "BLUE" },
        { code: "BLUE", winsByStake: { WHITE: 1 }, availableStakes: ["WHITE", "RED"], nextStake: "RED" },
      ],
    },
    performance: [
      { deck: "RED", trials: 10, wins: 9, averageAnte: 8, averageRound: 24 },
      { deck: "BLUE", trials: 2, wins: 1, averageAnte: 8, averageRound: 24 },
    ],
    config: { balatrobotDeckMode: "unlock" },
  });
  assert.equal(selected.deck, "BLUE");
  assert.equal(selected.stake, "RED");
});

test("unlock mode continues through Orange Stake to unlock Erratic Deck", () => {
  const selected = selectBalatroDeck({
    collectionKnowledge: {
      available: true,
      unlockedDecks: [{ code: "YELLOW", label: "Yellow Deck", effect: "+$10", order: 3 }],
      lockedDecks: [{ code: "ERRATIC" }],
      deckProgress: [{
        code: "YELLOW",
        winsByStake: { WHITE: 1, RED: 1, GREEN: 1, BLACK: 1, BLUE: 1, PURPLE: 1 },
        availableStakes: ["WHITE", "RED", "GREEN", "BLACK", "BLUE", "PURPLE", "ORANGE"],
        nextStake: "ORANGE",
      }],
    },
    performance: [{ deck: "YELLOW", trials: 20, wins: 5, averageAnte: 7, averageRound: 21 }],
    config: { balatrobotDeckMode: "unlock" },
  });
  assert.equal(selected.deck, "YELLOW");
  assert.equal(selected.stake, "ORANGE");
  assert.deepEqual(selected.targetUnlocks, ["ERRATIC"]);
});
