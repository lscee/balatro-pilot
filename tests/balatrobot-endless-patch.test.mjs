import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), "utf8");

test("pinned Endless endpoint only dismisses the native win overlay after a win", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "endless.lua");
  assert.match(endpoint, /name = "endless"/);
  assert.match(endpoint, /requires_state = \{ G\.STATES\.ROUND_EVAL \}/);
  assert.match(endpoint, /G\.GAME\.won ~= true/);
  assert.match(endpoint, /not G\.OVERLAY_MENU or not G\.SETTINGS or G\.SETTINGS\.paused ~= true/);
  assert.match(endpoint, /G\.FUNCS\.exit_overlay_menu\(\)/);
  assert.match(endpoint, /not G\.OVERLAY_MENU/);
  assert.match(endpoint, /G\.SETTINGS\.paused == false/);
});

test("pinned play endpoint distinguishes a fresh victory overlay from persistent Endless won state", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "play.lua");
  assert.match(endpoint, /pause_force\s*=\s*true/);
  assert.doesNotMatch(endpoint, /created_on_pause\s*=/);
  assert.match(endpoint, /local native_win_overlay =/);
  assert.match(endpoint, /G\.GAME\.won == true/);
  assert.match(endpoint, /G\.OVERLAY_MENU/);
  assert.match(endpoint, /G\.SETTINGS\.paused == true/);
  assert.doesNotMatch(endpoint, /if G\.GAME\.won then/);
  assert.match(endpoint, /dollar_blind1/);
  assert.match(endpoint, /cash_out_button/);
  assert.match(endpoint, /Return play\(\) - cash out UI ready/);
});

test("pinned hand-action endpoints submit safely without the optional button UI", () => {
  const play = read("assets", "balatrobot-v1.5.2", "play.lua");
  const discard = read("assets", "balatrobot-v1.5.2", "discard.lua");

  for (const endpoint of [play, discard]) {
    assert.doesNotMatch(endpoint, /G\.buttons\.UIRoot/);
    assert.doesNotMatch(endpoint, /UIBox:get_UIE_by_ID\("(?:play|discard)_button"/);
    assert.match(endpoint, /BB_GAMESTATE\.balatro_pilot_hand_action_in_flight = true/);
    assert.match(endpoint, /The requested cards could not be selected exactly/);
    assert.match(endpoint, /Duplicate card index/);
  }
  assert.match(play, /G\.FUNCS\.play_cards_from_highlighted\(nil\)/);
  assert.match(discard, /G\.FUNCS\.discard_cards_from_highlighted\(nil\)/);
  assert.doesNotMatch(play, /draw_to_hand and hand_played and G\.buttons/);
  assert.doesNotMatch(discard, /draw_to_hand and G\.buttons/);

  const playLock = play.indexOf("BB_GAMESTATE.balatro_pilot_hand_action_in_flight = true");
  const playSubmit = play.indexOf("G.FUNCS.play_cards_from_highlighted(nil)");
  const discardLock = discard.indexOf("BB_GAMESTATE.balatro_pilot_hand_action_in_flight = true");
  const discardSubmit = discard.indexOf("G.FUNCS.discard_cards_from_highlighted(nil)");
  assert.ok(playLock >= 0 && playSubmit > playLock, "play locks before native submission");
  assert.ok(discardLock >= 0 && discardSubmit > discardLock, "discard locks before native submission");
});

test("pinned hand-action readiness blocks transients but not deck preview", () => {
  const play = read("assets", "balatrobot-v1.5.2", "play.lua");
  const wrapper = read("assets", "balatrobot-v1.5.2", "reroll_boss.lua");
  const start = play.indexOf("local function balatro_pilot_hand_actions_ready(ignore_in_flight)");
  const end = play.indexOf("BB_GAMESTATE.balatro_pilot_hand_actions_ready =", start);
  assert.ok(start >= 0 && end > start);
  const readiness = play.slice(start, end);
  assert.match(readiness, /G\.STATE ~= G\.STATES\.SELECTING_HAND/);
  assert.match(readiness, /G\.STATE_COMPLETE ~= true/);
  assert.match(readiness, /G\.SETTINGS\.paused == true/);
  assert.match(readiness, /G\.OVERLAY_MENU/);
  assert.match(readiness, /controller\.locked == true/);
  assert.match(readiness, /controller\.lock_input == true/);
  assert.match(readiness, /balatro_pilot_hand_action_in_flight == true/);
  assert.match(readiness, /G\.GAME\.blind\.block_play/);
  assert.match(readiness, /"blind_blocks_play"/);
  assert.match(readiness, /G\.play\.cards\[1\]/);
  assert.match(readiness, /type\(G\.E_MANAGER\.add_event\) ~= "function"/);
  assert.match(readiness, /Event == nil/);
  assert.doesNotMatch(readiness, /type\(Event\) ~= "function"/);
  assert.doesNotMatch(readiness, /G\.buttons/);
  assert.doesNotMatch(readiness, /deck_preview/);
  assert.match(wrapper, /state\.hand_actions_ready = hand_actions_ready/);
  assert.match(wrapper, /state\.hand_action_in_flight =/);
});

test("pinned cash-out endpoint waits for the complete payout UI before clearing round_eval", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "cash_out.lua");
  const readiness = endpoint.indexOf("local payout_ready =");
  const nativeCall = endpoint.indexOf("G.FUNCS.cash_out({ config = {} })");
  assert.ok(readiness >= 0 && nativeCall > readiness, "native cash-out is gated behind payout readiness");
  assert.match(endpoint, /G\.round_eval:get_UIE_by_ID\("dollar_blind1"\)/);
  assert.match(endpoint, /cash_out_button_ready\(\)/);
  assert.match(endpoint, /not G\.OVERLAY_MENU/);
  assert.match(endpoint, /G\.SETTINGS\.paused == false/);
  assert.doesNotMatch(endpoint.slice(0, readiness), /G\.FUNCS\.cash_out/);
});

test("Black Hole first does not make a target-free Jupiter selection wait for an empty hand", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "pack.lua");
  // In the observed mixed Celestial pack, cards[0] was Black Hole and
  // args.card=1 selected Jupiter. These structural assertions pin the exact
  // control flow: resolve cards[args.card], then immediately select a card
  // whose own requirements contain no concrete hand targets.
  assert.match(endpoint, /local selected_card = G\.pack_cards\.cards\[args\.card \+ 1\]/);
  assert.match(endpoint, /local selected_requirements = selected_key and get_consumable_target_requirements\(selected_key\) or nil/);
  assert.match(endpoint, /local target_count = args\.targets and #args\.targets or 0/);
  assert.match(endpoint, /local needs_hand = selected_requirements[\s\S]*target_count > 0/);
  assert.match(endpoint, /if not needs_hand then\s+select_card\(\)\s+return/);
  assert.doesNotMatch(endpoint, /G\.pack_cards\.cards\[1\][\s\S]{0,240}needs_hand/);
  assert.doesNotMatch(endpoint, /pack_key == "Tarot" or pack_key == "Spectral"/);
});

test("pinned start endpoint rejects an unstable menu before any game mutation", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "start.lua");
  assert.match(endpoint, /local function balatro_pilot_menu_ready\(\)/);
  assert.match(endpoint, /G\.STATE ~= G\.STATES\.MENU/);
  assert.match(endpoint, /G\.MAIN_MENU_UI == nil/);
  assert.match(endpoint, /G\.screenwipe ~= nil or G\.OVERLAY_MENU ~= nil/);
  assert.match(endpoint, /G\.SETTINGS\.paused == true/);
  assert.match(endpoint, /controller\.lock_input == true/);
  const readiness = endpoint.indexOf("local menu_ready, not_ready_reason = balatro_pilot_menu_ready()");
  const setupRun = endpoint.indexOf("G.FUNCS.setup_run({ config = {} })");
  const startRun = endpoint.indexOf("G.FUNCS.start_run(nil, run_params)");
  assert.ok(readiness >= 0 && setupRun > readiness && startRun > setupRun);
  const rejection = endpoint.slice(readiness, setupRun);
  assert.match(rejection, /BB_ERROR_NAMES\.INVALID_STATE/);
  assert.match(rejection, /return/);
});

test("pinned gamestate wrapper publishes the exact start menu readiness predicate", () => {
  const start = read("assets", "balatrobot-v1.5.2", "start.lua");
  const wrapper = read("assets", "balatrobot-v1.5.2", "reroll_boss.lua");
  assert.match(start, /BB_GAMESTATE\.balatro_pilot_menu_ready = balatro_pilot_menu_ready/);
  assert.match(wrapper, /type\(BB_GAMESTATE\.balatro_pilot_menu_ready\) == "function"/);
  assert.match(wrapper, /state\.menu_ready = menu_ready/);
});

test("pinned gamestate wrapper publishes canonical cumulative Stake and sticker state", () => {
  const wrapper = read("assets", "balatrobot-v1.5.2", "reroll_boss.lua");
  for (const [level, stake] of [
    [1, "WHITE"], [2, "RED"], [3, "GREEN"], [4, "BLACK"],
    [5, "BLUE"], [6, "PURPLE"], [7, "ORANGE"], [8, "GOLD"],
  ]) {
    assert.match(wrapper, new RegExp(`\\[${level}\\] = "${stake}"`));
  }
  assert.match(wrapper, /game and game\.applied_stakes or \{\}/);
  assert.match(wrapper, /state\.stakeRules = stake_rules/);
  assert.match(wrapper, /state\.runModifiers = run_modifiers/);
  assert.match(wrapper, /state\.stake_rules = stake_rules/);
  assert.match(wrapper, /state\.run_modifiers = run_modifiers/);
  for (const field of [
    "appliedStakes", "noSmallBlindReward", "smallBlindBaseReward", "smallBlindReward",
    "scalingTier", "anteScaling", "baseDiscards", "preStakeDiscards", "actualDiscards",
    "discardModifier", "eternalStickers", "perishableStickers", "rentalStickers",
    "perishableRounds", "rentalRate",
  ]) {
    assert.match(wrapper, new RegExp(`${field} =`));
  }
  for (const field of [
    "applied_stakes", "small_blind_no_reward", "small_blind_base_reward", "small_blind_reward",
    "no_small_blind_reward", "scaling_tier", "ante_scaling", "base_discards",
    "pre_stake_discards", "actual_discards", "discard_modifier", "stake_discard_penalty",
    "eternal_stickers", "perishable_stickers", "rental_stickers", "perishable_rounds", "rental_rate",
  ]) {
    assert.match(wrapper, new RegExp(`${field} =`));
  }
  assert.match(wrapper, /applied_lookup\.BLUE and 1 or 0/);
  assert.match(wrapper, /discardModifier = -stake_discard_penalty/);
  assert.match(wrapper, /discard_modifier = -stake_discard_penalty/);
  assert.match(wrapper, /no_blind_reward = \{[\s\S]*Small = no_blind_reward\.Small == true/);
  assert.match(wrapper, /enable_eternals_in_shop = modifiers\.enable_eternals_in_shop == true/);
  assert.match(wrapper, /enable_perishables_in_shop = modifiers\.enable_perishables_in_shop == true/);
  assert.match(wrapper, /enable_rentals_in_shop = modifiers\.enable_rentals_in_shop == true/);

  const cardAugment = wrapper.slice(
    wrapper.indexOf("local function balatro_pilot_augment_card"),
    wrapper.indexOf("local function balatro_pilot_augment_area"),
  );
  assert.match(cardAugment, /ability and ability\.perishable/);
  assert.match(cardAugment, /tonumber\(ability\.perish_tally\)/);
  assert.match(cardAugment, /modifier\.perishable = tally/);
  assert.match(cardAugment, /modifier\.isPerishable = true/);
  assert.match(cardAugment, /modifier\.is_perishable = true/);
  assert.match(cardAugment, /modifier\.perishableTally = tally/);
  assert.match(cardAugment, /modifier\.perishable_tally = tally/);
  assert.match(cardAugment, /modifier\.rentalRate = run_modifiers\.rental_rate/);
  assert.match(cardAugment, /modifier\.rental_rate = run_modifiers\.rental_rate/);
  assert.doesNotMatch(cardAugment, /perish_tally\s*>\s*0/);
  for (const area of ["jokers", "consumables", "cards", "hand", "shop", "vouchers", "packs", "pack"]) {
    assert.match(wrapper, new RegExp(`balatro_pilot_augment_area\\(state\\.${area},`));
  }
});

test("installer and launcher carry the same asset-backed Endless patch and fingerprint", () => {
  const installer = read("scripts", "install-balatrobot.ps1");
  const launcher = read("scripts", "start-balatrobot.ps1");
  const fingerprints = [installer, launcher].map((source) => {
    const match = source.match(/\$BalatroBotRuntimeFingerprint = "([a-f0-9]{64})"/);
    assert.ok(match, "pinned runtime fingerprint is present");
    return match[1];
  });
  assert.equal(fingerprints[0], fingerprints[1]);
  for (const source of [installer, launcher]) {
    assert.match(source, /function Add-BalatroBotEndlessPatch/);
    assert.match(source, /assets\\balatrobot-v1\.5\.2/);
    assert.match(source, /src\\lua\\endpoints\\endless\.lua/);
    assert.match(source, /src\\lua\\endpoints\\play\.lua/);
    assert.match(source, /src\\lua\\endpoints\\discard\.lua/);
    assert.match(source, /src\\lua\\endpoints\\cash_out\.lua/);
    assert.match(source, /src\\lua\\endpoints\\pack\.lua/);
    assert.match(source, /src\\lua\\endpoints\\start\.lua/);
    assert.match(source, /openrpc-endless-method\.json/);
    assert.match(source, /Add-BalatroBotEndlessPatch -Root/);
    assert.match(source, /G\.BALATRO_PILOT_UNSEEDED_NONCE/);
    assert.match(source, /inject entropy at the actual native seed call/);
    assert.match(source, /generate_starting_seed = function\(\)/);
    assert.match(source, /G\.BALATRO_PILOT_LAST_UNSEEDED_SEED/);
    assert.match(source, /generated_seed ~= previous_seed/);
    assert.doesNotMatch(
      source.match(/function Add-BalatroBotUnseededEntropyPatch[\s\S]*?function Add-BalatroBotEndlessPatch/)?.[0] ?? "",
      /G\.CONTROLLER\.cursor_hover\.time\s*=\s*\r?\n\s*\(G\.CONTROLLER\.cursor_hover\.time or 0\)/,
    );
    assert.doesNotMatch(source.match(/function Add-BalatroBotUnseededEntropyPatch[\s\S]*?function Add-BalatroBotEndlessPatch/)?.[0] ?? "", /BB\.UNSEEDED_RUN_NONCE =/);
  }
  assert.match(installer, /State = "patch"; Detail = "BalatroBot v\$BalatroBotVersion legacy runtime detected/);
  assert.match(installer, /\$BalatroBotPrePackRuntimeFingerprint = "a5b67a53b06fd4a949b3031d870bea87c6280b8bb7e13a1ad0b9d79e9145603d"/);
  assert.match(installer, /\$BalatroBotPreHandActionsReadyRuntimeFingerprint = "8f84fc808d786c0be5e8be1c53b364fc569dbac18b57e6145f2f260abf08ca25"/);
  assert.match(launcher, /\$BalatroBotPreHandActionsReadyRuntimeFingerprint = "8f84fc808d786c0be5e8be1c53b364fc569dbac18b57e6145f2f260abf08ca25"/);
  assert.match(installer, /\$fingerprint -eq \$BalatroBotPreHandActionsReadyRuntimeFingerprint/);
  assert.match(launcher, /\$installedRuntimeFingerprint -eq \$BalatroBotPreHandActionsReadyRuntimeFingerprint/);
  assert.match(installer, /\$BalatroBotOverstrictEventGuardRuntimeFingerprint = "16a24175f4e827e758875d94622a46a4a91074beacc37fff2f4463950b7b9943"/);
  assert.match(launcher, /\$BalatroBotOverstrictEventGuardRuntimeFingerprint = "16a24175f4e827e758875d94622a46a4a91074beacc37fff2f4463950b7b9943"/);
  assert.match(installer, /\$fingerprint -eq \$BalatroBotOverstrictEventGuardRuntimeFingerprint/);
  assert.match(launcher, /\$installedRuntimeFingerprint -eq \$BalatroBotOverstrictEventGuardRuntimeFingerprint/);
  assert.match(installer, /\$BalatroBotPreGoldRulesRuntimeFingerprint = "a8bc8486f0bd37ecddd6cb5cd42447a0d6bbb8d2ce7d75e95140fc38f0e0d48d"/);
  assert.match(launcher, /\$BalatroBotPreGoldRulesRuntimeFingerprint = "a8bc8486f0bd37ecddd6cb5cd42447a0d6bbb8d2ce7d75e95140fc38f0e0d48d"/);
  assert.match(installer, /\$fingerprint -eq \$BalatroBotPreGoldRulesRuntimeFingerprint/);
  assert.match(launcher, /\$installedRuntimeFingerprint -eq \$BalatroBotPreGoldRulesRuntimeFingerprint/);
});

test("installer, launcher, and packager pin the selected-card pack runtime", () => {
  const sources = [
    read("scripts", "install-balatrobot.ps1"),
    read("scripts", "start-balatrobot.ps1"),
    read("scripts", "package-balatrobot-mod.ps1"),
  ];
  const fingerprints = sources.map((source) => {
    const match = source.match(/(?:\$BalatroBotRuntimeFingerprint|\$expectedFingerprint) = "([a-f0-9]{64})"/);
    assert.ok(match);
    return match[1];
  });
  assert.deepEqual(new Set(fingerprints).size, 1);
  for (const source of sources.slice(0, 2)) {
    assert.match(source, /assets\\balatrobot-v1\.5\.2/);
    assert.match(source, /packSource/);
    assert.match(source, /Copy-Item -LiteralPath \$packSource/);
    assert.match(source, /Copy-Item -LiteralPath \$discardSource/);
    assert.match(source, /Copy-Item -LiteralPath \$startSource/);
  }
  assert.match(sources[2], /selected-card pack patches/);
  assert.match(sources[2], /canonical cumulative-Stake and sticker state/);
});

test("Endless is declared in OpenRPC and required by the local doctor probe", () => {
  const method = JSON.parse(read("assets", "balatrobot-v1.5.2", "openrpc-endless-method.json"));
  assert.equal(method.name, "endless");
  assert.equal(method.params.length, 0);
  const index = read("src", "index.mjs");
  assert.match(index, /"cash_out",\s+"endless",\s+"buy"/);
});
