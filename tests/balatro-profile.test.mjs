import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  BalatroProfileReader,
  BalatroRunCardTracker,
  parseDeckStakeProgress,
  parseVanillaConsumableCatalog,
  parseVanillaDeckCatalog,
  parseVanillaJokerCatalog,
  parseVanillaStakeCatalog,
  parseVanillaVoucherCatalog,
} from "../src/balatro-profile.mjs";

function writeJkr(filePath, lua) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, deflateRawSync(Buffer.from(lua, "utf8")));
}

const gameLua = `
  stake_white = {name = 'White Chip', unlocked = true, order = 1, stake_level = 1, set = 'Stake'},
  stake_red = {name = 'Red Chip', unlocked = false, order = 2, stake_level = 2, set = 'Stake'},
  stake_green = {name = 'Green Chip', unlocked = false, order = 3, stake_level = 3, set = 'Stake'},
  stake_black = {name = 'Black Chip', unlocked = false, order = 4, stake_level = 4, set = 'Stake'},
  stake_blue = {name = 'Blue Chip', unlocked = false, order = 5, stake_level = 5, set = 'Stake'},
  j_joker={order=1, unlocked=true, discovered=false, rarity=1, name="Joker", set="Joker"},
  j_blueprint={order=2, unlocked=false, discovered=false, rarity=3, name="Blueprint", set="Joker", unlock_condition={type='win', n_rounds=18}},
  j_brainstorm={order=3, unlocked=false, discovered=false, rarity=3, name="Brainstorm", set="Joker", unlock_condition={type='chip_score', chips=100000000, extra={count=2, suit='Spades'}}},
  j_cartomancer={order=4, unlocked=false, discovered=false, rarity=2, name="Cartomancer", set="Joker", unlock_condition={type='discover_amount', tarot_count=22}},
  j_showman={order=5, unlocked=false, discovered=false, rarity=2, name="Showman", set="Joker", unlock_condition={type='ante_up', ante=4}},
  c_fool={order=1, discovered=false, cost=3, consumeable=true, name="The Fool", set="Tarot"},
  c_mercury={order=1, discovered=false, cost=3, consumeable=true, name="Mercury", set="Planet"},
  c_ankh={order=11, discovered=false, cost=4, consumeable=true, name="Ankh", set="Spectral", hidden=true},
  v_blank={order=23, discovered=false, unlocked=true, available=true, cost=10, name="Blank", set="Voucher"},
  v_antimatter={order=24, discovered=false, unlocked=false, available=true, cost=10, name="Antimatter", set="Voucher", requires={'v_blank'}, unlock_condition={type='blank_redeems', extra=10}},
  v_reroll_glut={order=8, discovered=false, unlocked=false, available=true, cost=10, name="Reroll Glut", set="Voucher", requires={'v_reroll_surplus'}, unlock_condition={type='c_shop_rerolls', extra=100}},
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
      'return {["unlocked"]={["j_blueprint"]=true,["b_blue"]=true,["v_reroll_glut"]=true,},["discovered"]={["j_blueprint"]=true,["b_blue"]=true,["c_fool"]=true,["v_blank"]=true,},}',
    );
    writeJkr(
      path.join(balatro, "2", "profile.jkr"),
      'return {["all_unlocked"]=false,["career_stats"]={["c_shop_rerolls"]=166,},["voucher_usage"]={["v_blank"]={["count"]=2,},},["consumeable_usage"]={["c_fool"]={["count"]=4,},},["deck_usage"]={["b_red"]={["wins"]={[1]=1,},["wins_by_key"]={["stake_white"]=1,},},["b_blue"]={["wins"]={[1]=1,[2]=1,},["wins_by_key"]={["stake_white"]=1,["stake_red"]=1,},},},}',
    );
    const snapshot = new BalatroProfileReader({
      appData: root,
      executablePath: executable,
      readEntry: () => gameLua,
    }).snapshot();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.profile, "2");
    assert.equal(snapshot.unlockedJokerCount, 2);
    assert.equal(snapshot.totalJokerCount, 5);
    assert.deepEqual(snapshot.unlockedJokers.map((joker) => joker.key), ["j_blueprint", "j_joker"]);
    assert.deepEqual(snapshot.lockedJokers.map((joker) => joker.key), ["j_brainstorm", "j_cartomancer", "j_showman"]);
    assert.deepEqual(snapshot.lockedJokers[0].unlockCondition, {
      type: "chip_score",
      chips: 100000000,
      extra: "{count=2, suit='Spades'}",
      raw: "{type='chip_score', chips=100000000, extra={count=2, suit='Spades'}}",
    });
    assert.equal(snapshot.unlockedJokers.find((joker) => joker.key === "j_blueprint").discovered, true);
    assert.equal(snapshot.unlockedJokers.find((joker) => joker.key === "j_joker").discovered, false);
    assert.equal(snapshot.unlockedConsumableCount, 3);
    assert.equal(snapshot.discoveredConsumableCount, 1);
    assert.equal(snapshot.consumables.find((item) => item.key === "c_fool").timesUsed, 4);
    assert.deepEqual(snapshot.undiscoveredConsumables.map((item) => item.key), ["c_mercury", "c_ankh"]);
    assert.equal(snapshot.unlockedVoucherCount, 2);
    assert.equal(snapshot.discoveredVoucherCount, 1);
    assert.deepEqual(snapshot.lockedVouchers.map((item) => item.key), ["v_antimatter"]);
    assert.deepEqual(snapshot.vouchers.find((item) => item.key === "v_antimatter").progress, {
      type: "blank_redeems",
      current: 2,
      target: 10,
      complete: false,
      source: "voucher_usage.v_blank.count",
    });
    assert.equal(snapshot.vouchers.find((item) => item.key === "v_reroll_glut").unlocked, true);
    assert.equal(snapshot.vouchers.find((item) => item.key === "v_reroll_glut").progress, null);
    assert.equal(snapshot.unlockedDeckCount, 2);
    assert.equal(snapshot.totalDeckCount, 3);
    assert.deepEqual(snapshot.unlockedDecks.map((deck) => deck.code), ["RED", "BLUE"]);
    assert.deepEqual(snapshot.lockedDecks.map((deck) => deck.code), ["BLACK"]);
    assert.match(snapshot.unlockedDecks[1].effect, /\+1 hand/u);
    assert.equal(snapshot.highestWonStake, "RED");
    assert.deepEqual(snapshot.deckProgress.find((deck) => deck.code === "RED"), {
      key: "b_red",
      code: "RED",
      label: "Red Deck",
      order: 1,
      unlocked: true,
      winsByStake: { WHITE: 1 },
      highestWonStake: "WHITE",
      availableStakes: ["WHITE", "RED"],
      nextStake: "RED",
    });
    assert.equal(snapshot.deckProgress.find((deck) => deck.code === "BLUE").nextStake, "GREEN");
    assert.deepEqual(snapshot.deckProgress.find((deck) => deck.code === "BLACK").availableStakes, []);
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
    assert.equal(snapshot.unlockedJokerCount, 5);
    assert.deepEqual(snapshot.lockedJokers, []);
    assert.equal(snapshot.unlockedConsumableCount, 3);
    assert.equal(snapshot.unlockedVoucherCount, 3);
    assert.deepEqual(snapshot.lockedVouchers, []);
    assert.equal(snapshot.unlockedDeckCount, 3);
    assert.deepEqual(snapshot.lockedDecks, []);
    assert.deepEqual(snapshot.deckProgress[0].availableStakes, ["WHITE", "RED", "GREEN", "BLACK", "BLUE"]);
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
    {
      key: "j_blueprint",
      label: "Blueprint",
      rarity: 3,
      defaultUnlocked: false,
      defaultDiscovered: false,
      unlockCondition: { type: "win", n_rounds: 18, raw: "{type='win', n_rounds=18}" },
    },
    {
      key: "j_brainstorm",
      label: "Brainstorm",
      rarity: 3,
      defaultUnlocked: false,
      defaultDiscovered: false,
      unlockCondition: {
        type: "chip_score",
        chips: 100000000,
        extra: "{count=2, suit='Spades'}",
        raw: "{type='chip_score', chips=100000000, extra={count=2, suit='Spades'}}",
      },
    },
    {
      key: "j_cartomancer",
      label: "Cartomancer",
      rarity: 2,
      defaultUnlocked: false,
      defaultDiscovered: false,
      unlockCondition: { type: "discover_amount", tarot_count: 22, raw: "{type='discover_amount', tarot_count=22}" },
    },
    {
      key: "j_joker",
      label: "Joker",
      rarity: 1,
      defaultUnlocked: true,
      defaultDiscovered: false,
      unlockCondition: null,
    },
    {
      key: "j_showman",
      label: "Showman",
      rarity: 2,
      defaultUnlocked: false,
      defaultDiscovered: false,
      unlockCondition: { type: "ante_up", ante: 4, raw: "{type='ante_up', ante=4}" },
    },
  ]);
});

test("installed consumable and voucher parsers preserve discovery and unlock metadata", () => {
  assert.deepEqual(parseVanillaConsumableCatalog(gameLua), [
    {
      key: "c_fool",
      label: "The Fool",
      set: "TAROT",
      order: 1,
      hidden: false,
      defaultUnlocked: true,
      defaultDiscovered: false,
      unlockCondition: null,
    },
    {
      key: "c_mercury",
      label: "Mercury",
      set: "PLANET",
      order: 1,
      hidden: false,
      defaultUnlocked: true,
      defaultDiscovered: false,
      unlockCondition: null,
    },
    {
      key: "c_ankh",
      label: "Ankh",
      set: "SPECTRAL",
      order: 11,
      hidden: true,
      defaultUnlocked: true,
      defaultDiscovered: false,
      unlockCondition: null,
    },
  ]);
  assert.deepEqual(parseVanillaVoucherCatalog(gameLua).map((voucher) => voucher.key), [
    "v_reroll_glut",
    "v_blank",
    "v_antimatter",
  ]);
  assert.deepEqual(parseVanillaVoucherCatalog(gameLua).find((voucher) => voucher.key === "v_antimatter"), {
    key: "v_antimatter",
    label: "Antimatter",
    order: 24,
    defaultUnlocked: false,
    defaultDiscovered: false,
    requires: ["v_blank"],
    unlockCondition: { type: "blank_redeems", extra: 10, raw: "{type='blank_redeems', extra=10}" },
  });
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

test("installed stake parser preserves RPC codes and the vanilla prerequisite chain", () => {
  assert.deepEqual(parseVanillaStakeCatalog(gameLua), [
    {
      key: "stake_white",
      code: "WHITE",
      label: "White Chip",
      order: 1,
      stakeLevel: 1,
      defaultUnlocked: true,
      appliedStakes: [],
    },
    {
      key: "stake_red",
      code: "RED",
      label: "Red Chip",
      order: 2,
      stakeLevel: 2,
      defaultUnlocked: false,
      appliedStakes: ["stake_white"],
    },
    {
      key: "stake_green",
      code: "GREEN",
      label: "Green Chip",
      order: 3,
      stakeLevel: 3,
      defaultUnlocked: false,
      appliedStakes: ["stake_red"],
    },
    {
      key: "stake_black",
      code: "BLACK",
      label: "Black Chip",
      order: 4,
      stakeLevel: 4,
      defaultUnlocked: false,
      appliedStakes: ["stake_green"],
    },
    {
      key: "stake_blue",
      code: "BLUE",
      label: "Blue Chip",
      order: 5,
      stakeLevel: 5,
      defaultUnlocked: false,
      appliedStakes: ["stake_black"],
    },
  ]);
});

test("deck stake progress prefers wins_by_key and falls back to legacy numeric wins", () => {
  const stakes = parseVanillaStakeCatalog(gameLua);
  const parsed = parseDeckStakeProgress(`return {["deck_usage"]={
    ["b_red"]={["wins"]={[1]=9,[2]=7,},["wins_by_key"]={["stake_white"]=2,}},
    ["b_blue"]={["wins"]={[1]=1,[2]=1,[3]=1,},["wins_by_key"]={},},
  },}`, stakes);
  assert.deepEqual(parsed.get("b_red"), { WHITE: 2, RED: 7 });
  assert.deepEqual(parsed.get("b_blue"), { WHITE: 1, RED: 1, GREEN: 1 });
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
          openedPack: { cards: [{ key: "c_ankh", set: "SPECTRAL", label: "Ankh" }] },
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
      pack: { cards: [{ key: "c_fool", set: "TAROT", label: "The Fool" }] },
      openedPack: { cards: [{ key: "c_fool", set: "TAROT", label: "The Fool" }] },
    });
    assert.deepEqual(restored.jokers.map((card) => card.key), ["j_blueprint", "j_joker"]);
    assert.deepEqual(restored.consumables.map((card) => card.key), ["c_ankh", "c_fool"]);
    assert.deepEqual(restored.consumables[0].sources, ["opened_pack"]);
    assert.equal(restored.consumables[1].timesSeen, 1);
    assert.equal(restored.jokers[0].firstAnte, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
