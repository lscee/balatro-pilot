import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  BalatroProfileReader,
  BalatroRunCardTracker,
  parseVanillaDeckCatalog,
  parseVanillaJokerCatalog,
} from "../src/balatro-profile.mjs";

function writeJkr(filePath, lua) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, deflateRawSync(Buffer.from(lua, "utf8")));
}

const gameLua = `
  j_joker={order=1, unlocked=true, discovered=true, rarity=1, name="Joker", set="Joker"},
  j_blueprint={order=2, unlocked=false, discovered=false, rarity=3, name="Blueprint", set="Joker"},
  j_brainstorm={order=3, unlocked=false, discovered=false, rarity=3, name="Brainstorm", set="Joker"},
  b_red={name = "Red Deck", stake = 1, unlocked = true, order = 1, config = {discards = 1}},
  b_blue={name = "Blue Deck", stake = 1, unlocked = false, order = 2, config = {hands = 1}},
  b_black={name = "Black Deck", stake = 1, unlocked = false, order = 5, config = {hands = -1, joker_slot = 1}},
`;

test("profile reader merges installed defaults with the selected profile unlock table", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-profile-"));
  try {
    const balatro = path.join(root, "Balatro");
    const executable = path.join(root, "Balatro.exe");
    fs.writeFileSync(executable, "test");
    writeJkr(path.join(balatro, "settings.jkr"), 'return {["profile"]=2,}');
    writeJkr(
      path.join(balatro, "2", "meta.jkr"),
      'return {["unlocked"]={["j_blueprint"]=true,["b_blue"]=true,},["discovered"]={["j_blueprint"]=true,["b_blue"]=true,},}',
    );
    writeJkr(path.join(balatro, "2", "profile.jkr"), 'return {["all_unlocked"]=false,}');
    const snapshot = new BalatroProfileReader({
      appData: root,
      executablePath: executable,
      readEntry: () => gameLua,
    }).snapshot();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.profile, "2");
    assert.equal(snapshot.unlockedJokerCount, 2);
    assert.equal(snapshot.totalJokerCount, 3);
    assert.deepEqual(snapshot.unlockedJokers.map((joker) => joker.key), ["j_blueprint", "j_joker"]);
    assert.deepEqual(snapshot.lockedJokers.map((joker) => joker.key), ["j_brainstorm"]);
    assert.equal(snapshot.unlockedJokers.find((joker) => joker.key === "j_blueprint").discovered, true);
    assert.equal(snapshot.unlockedDeckCount, 2);
    assert.equal(snapshot.totalDeckCount, 3);
    assert.deepEqual(snapshot.unlockedDecks.map((deck) => deck.code), ["RED", "BLUE"]);
    assert.deepEqual(snapshot.lockedDecks.map((deck) => deck.code), ["BLACK"]);
    assert.match(snapshot.unlockedDecks[1].effect, /\+1 hand/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile reader honors the all-unlocked profile flag", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-profile-all-"));
  try {
    const balatro = path.join(root, "Balatro");
    const executable = path.join(root, "Balatro.exe");
    fs.writeFileSync(executable, "test");
    writeJkr(path.join(balatro, "settings.jkr"), 'return {["profile"]=1,}');
    writeJkr(path.join(balatro, "1", "meta.jkr"), "return {}");
    writeJkr(path.join(balatro, "1", "profile.jkr"), 'return {["all_unlocked"]=true,}');
    const snapshot = new BalatroProfileReader({
      appData: root,
      executablePath: executable,
      readEntry: () => gameLua,
    }).snapshot();
    assert.equal(snapshot.unlockedJokerCount, 3);
    assert.deepEqual(snapshot.lockedJokers, []);
    assert.equal(snapshot.unlockedDeckCount, 3);
    assert.deepEqual(snapshot.lockedDecks, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run card tracker remembers cards that appeared and resets on a new seed", () => {
  const tracker = new BalatroRunCardTracker();
  tracker.observe({
    seed: "one",
    ante_num: 1,
    round_num: 1,
    jokers: { cards: [{ key: "j_joker", set: "JOKER", label: "Joker" }] },
    shop: { cards: [{ key: "j_blueprint", set: "JOKER", label: "Blueprint" }] },
  });
  const later = tracker.observe({
    seed: "one",
    ante_num: 2,
    round_num: 4,
    consumables: { cards: [{ key: "c_magician", set: "TAROT", label: "The Magician" }] },
  });
  assert.deepEqual(later.jokers.map((card) => card.key), ["j_blueprint", "j_joker"]);
  assert.deepEqual(later.consumables.map((card) => card.key), ["c_magician"]);
  const next = tracker.observe({
    seed: "two",
    jokers: { cards: [{ key: "j_brainstorm", set: "JOKER", label: "Brainstorm" }] },
  });
  assert.deepEqual(next.jokers.map((card) => card.key), ["j_brainstorm"]);
});

test("installed Joker parser preserves labels, rarity, and default lock state", () => {
  assert.deepEqual(parseVanillaJokerCatalog(gameLua), [
    { key: "j_blueprint", label: "Blueprint", rarity: 3, defaultUnlocked: false },
    { key: "j_brainstorm", label: "Brainstorm", rarity: 3, defaultUnlocked: false },
    { key: "j_joker", label: "Joker", rarity: 1, defaultUnlocked: true },
  ]);
});

test("installed deck parser preserves RPC codes, effects, and default locks", () => {
  assert.deepEqual(parseVanillaDeckCatalog(gameLua), [
    {
      key: "b_red",
      code: "RED",
      label: "Red Deck",
      effect: "+1 discard each round",
      order: 1,
      defaultUnlocked: true,
    },
    {
      key: "b_blue",
      code: "BLUE",
      label: "Blue Deck",
      effect: "+1 hand each round",
      order: 2,
      defaultUnlocked: false,
    },
    {
      key: "b_black",
      code: "BLACK",
      label: "Black Deck",
      effect: "+1 Joker slot; -1 hand each round",
      order: 5,
      defaultUnlocked: false,
    },
  ]);
});

test("run card tracker restores appeared cards from an earlier controller log", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-run-cards-"));
  try {
    const run = path.join(root, "runs", "old-bot-run");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, "events.ndjson"), [
      JSON.stringify({
        type: "bot_state",
        state: {
          seed: "same-seed",
          ante: 1,
          roundNumber: 2,
          shop: { cards: [{ key: "j_blueprint", set: "JOKER", label: "Blueprint" }] },
        },
      }),
      "{partial",
    ].join("\n"));
    const tracker = new BalatroRunCardTracker();
    tracker.hydrateFromRuns(root, "same-seed");
    const restored = tracker.observe({
      seed: "same-seed",
      ante_num: 2,
      round_num: 4,
      jokers: { cards: [{ key: "j_joker", set: "JOKER", label: "Joker" }] },
    });
    assert.deepEqual(restored.jokers.map((card) => card.key), ["j_blueprint", "j_joker"]);
    assert.equal(restored.jokers[0].firstAnte, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
