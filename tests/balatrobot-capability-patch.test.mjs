import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  compactBalatrobotState,
  validateBalatrobotPlan,
} from "../src/balatrobot-policy.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), "utf8");

function card(key, { set = "DEFAULT", edition = null } = {}) {
  return {
    key,
    set,
    label: key,
    value: {},
    modifier: { edition },
    state: {},
    cost: { buy: 0, sell: 0 },
  };
}

function area(cards, limit = cards.length) {
  return { count: cards.length, limit, highlighted_limit: 5, cards };
}

function action(method, overrides = {}) {
  return {
    method,
    cards: [],
    card: null,
    voucher: null,
    pack: null,
    joker: null,
    consumable: null,
    targets: [],
    skip: null,
    hand: [],
    jokers: [],
    consumables: [],
    reason: "validated local candidate",
    ...overrides,
  };
}

function plan(botAction) {
  return {
    observation: "exact",
    strategy: "use the validated local capability",
    memory: "",
    confidence: 0.95,
    actions: [botAction],
  };
}

function baseState(overrides = {}) {
  return {
    state: "SELECTING_HAND",
    ante_num: 2,
    round_num: 4,
    money: 20,
    round: { chips: 0, hands_left: 4, discards_left: 3 },
    blinds: { small: { type: "SMALL", status: "CURRENT", score: 450 } },
    hand: area([card("H_A"), card("S_K")], 8),
    cards: area([], 52),
    jokers: area([], 5),
    consumables: area([], 2),
    used_vouchers: {},
    ...overrides,
  };
}

test("pinned use endpoint gives owned Aura its vanilla one-card contract", () => {
  const source = read("assets", "balatrobot-v1.5.2", "use.lua");
  assert.match(source, /center_key == "c_aura"/);
  assert.match(source, /requires_cards = true, min = 1, max = 1/);
  assert.match(source, /G\.STATE ~= G\.STATES\.SELECTING_HAND/);
  const highlights = source.indexOf("G.hand:add_to_highlighted");
  const gameValidation = source.indexOf("consumable_card:can_use_consumeable()");
  assert.ok(highlights >= 0 && gameValidation > highlights, "the exact target is selected before native validation");
  assert.match(source, /does not accept target cards/);
});

test("Aura is legal only for one editionless owned hand card", () => {
  const state = baseState({ consumables: area([card("c_aura", { set: "SPECTRAL" })], 2) });
  const valid = validateBalatrobotPlan(plan(action("use", { consumable: 0, cards: [0] })), state);
  assert.deepEqual(valid.actions[0].params, { consumable: 0, cards: [0] });
  assert.throws(
    () => validateBalatrobotPlan(plan(action("use", { consumable: 0, cards: [] })), state),
    /c_aura requires exactly 1/,
  );
  state.hand.cards[0].modifier.edition = "FOIL";
  assert.throws(
    () => validateBalatrobotPlan(plan(action("use", { consumable: 0, cards: [0] })), state),
    /without an existing edition/,
  );
});

test("Boss reroll endpoint rechecks voucher, money, one-per-Ante, and native completion", () => {
  const source = read("assets", "balatrobot-v1.5.2", "reroll_boss.lua");
  assert.match(source, /requires_state = \{ G\.STATES\.BLIND_SELECT \}/);
  assert.match(source, /vouchers\["v_retcon"\]/);
  assert.match(source, /vouchers\["v_directors_cut"\]/);
  assert.match(source, /game\.dollars or 0/);
  assert.match(source, /game\.bankrupt_at or 0/);
  assert.match(source, /resets\.boss_rerolled/);
  assert.match(source, /G\.FUNCS\.reroll_boss\(\{\}\)/);
  assert.match(source, /G\.blind_select_opts\.boss ~= old_boss_ui/);
  assert.match(source, /not G\.CONTROLLER\.locks\.boss_reroll/);
  assert.match(source, /state\.boss_rerolled/);
  assert.match(source, /state\.last_tarot_planet = G\.GAME and G\.GAME\.last_tarot_planet or nil/);
  assert.match(source, /state\.ecto_minus = G\.GAME and G\.GAME\.ecto_minus or 1/);
});

test("Buy & Use rechecks exact shop identity, targets, money, and native legality", () => {
  const source = read("assets", "balatrobot-v1.5.2", "buy_use.lua");
  assert.match(source, /requires_state = \{ G\.STATES\.SHOP \}/);
  assert.match(source, /args\.card \+ 1/);
  assert.match(source, /game\.dollars or 0/);
  assert.match(source, /game\.bankrupt_at or 0/);
  assert.match(source, /center_key == "c_aura"/);
  assert.match(source, /seen\[target\]/);
  const nativeCheck = source.indexOf("card:can_use_consumeable()");
  const purchase = source.indexOf('id = "buy_and_use"');
  assert.ok(nativeCheck >= 0 && purchase > nativeCheck);
  assert.match(source, /not shop_contains\(card\)/);

  const offered = { ...card("c_hermit", { set: "TAROT" }), cost: { buy: 4, sell: 2 } };
  const state = baseState({
    state: "SHOP",
    shop: area([offered], 2),
    consumables: area([card("c_death", { set: "TAROT" }), card("c_strength", { set: "TAROT" })], 2),
  });
  const valid = validateBalatrobotPlan(
    plan(action("buy_use", { card: 0, reason: "buy and use c_hermit now" })), state,
  );
  assert.deepEqual(valid.actions[0].params, { card: 0 });
  assert.throws(
    () => validateBalatrobotPlan(plan(action("buy_use", { card: 1 })), state),
    /outside 0\.\.0/,
  );
  state.shop.cards[0] = card("j_joker", { set: "JOKER" });
  assert.throws(
    () => validateBalatrobotPlan(plan(action("buy_use", { card: 0 })), state),
    /must be a Tarot, Planet, or Spectral/,
  );
});

test("JS Boss reroll contract mirrors the game-side safety checks", () => {
  const state = baseState({
    state: "BLIND_SELECT",
    blinds: { boss: { type: "BOSS", status: "SELECT", name: "The Plant", score: 600 } },
    used_vouchers: { v_directors_cut: "" },
  });
  const valid = validateBalatrobotPlan(plan(action("reroll_boss")), state);
  assert.deepEqual(valid.actions[0].params, {});
  assert.equal(compactBalatrobotState(state).bossRerolled, false);
  assert.equal(compactBalatrobotState({ ...state, last_tarot_planet: "c_death" }).lastTarotPlanet, "c_death");
  assert.equal(compactBalatrobotState({ ...state, ecto_minus: 3 }).ectoMinus, 3);

  assert.throws(
    () => validateBalatrobotPlan(plan(action("reroll_boss")), { ...state, money: 9 }),
    /costs \$10/,
  );
  assert.throws(
    () => validateBalatrobotPlan(plan(action("reroll_boss")), { ...state, used_vouchers: {} }),
    /requires Director's Cut or Retcon/,
  );
  assert.throws(
    () => validateBalatrobotPlan(plan(action("reroll_boss")), { ...state, boss_rerolled: true }),
    /already rerolled/,
  );
  assert.doesNotThrow(() => validateBalatrobotPlan(
    plan(action("reroll_boss")),
    { ...state, used_vouchers: { v_retcon: "" }, boss_rerolled: true },
  ));
});

test("installer and launcher carry the same capability assets and legacy upgrade hash", () => {
  const sources = [
    read("scripts", "install-balatrobot.ps1"),
    read("scripts", "start-balatrobot.ps1"),
  ];
  for (const source of sources) {
    assert.match(source, /\$BalatroBotPreCapabilityRuntimeFingerprint = "d53fa2eb86813c48e33b9d2c9317f786ef24bef28c0c60e4b4a48bcfcb6441e2"/);
    assert.match(source, /\$useSource/);
    assert.match(source, /\$bossRerollSource/);
    assert.match(source, /\$buyUseSource/);
    assert.match(source, /openrpc-reroll-boss-method\.json/);
    assert.match(source, /src\/lua\/endpoints\/reroll_boss\.lua/);
    assert.match(source, /src\/lua\/endpoints\/buy_use\.lua/);
    assert.match(source, /Copy-Item -LiteralPath \$useSource/);
    assert.match(source, /Copy-Item -LiteralPath \$bossRerollSource/);
    assert.match(source, /Copy-Item -LiteralPath \$buyUseSource/);
  }
  const doctor = read("src", "index.mjs");
  assert.match(doctor, /"select",\s+"reroll_boss",\s+"skip"/);
  assert.match(doctor, /"buy",\s+"buy_use",\s+"sell"/);
  const metadata = JSON.parse(read("assets", "balatrobot-v1.5.2", "openrpc-reroll-boss-method.json"));
  assert.equal(metadata.name, "reroll_boss");
  assert.deepEqual(metadata.params, []);
});

test("launcher never patches the Mod on disk while Balatro is still using the old Lua in memory", () => {
  const launcher = read("scripts", "start-balatrobot.ps1");
  const processCheck = launcher.indexOf('$runningBalatroBeforePatch = @(Get-Process -Name "Balatro"');
  const legacyBranch = launcher.indexOf("$installedRuntimeFingerprint -eq $BalatroBotPreCapabilityRuntimeFingerprint");
  const patchCall = launcher.indexOf("Add-BalatroBotEndlessPatch -Root $balatroBotRoot", legacyBranch);
  assert.ok(processCheck >= 0 && processCheck < patchCall);
  assert.match(launcher, /older in-memory BalatroBot runtime/);
});
