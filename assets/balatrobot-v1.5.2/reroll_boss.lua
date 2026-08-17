-- Balatro Pilot endpoint for Director's Cut / Retcon boss rerolls.
--
-- Every destructive precondition is checked again inside the game process;
-- callers cannot bypass the voucher, one-per-Ante, or affordability rules.

-- Publish the small set of native strategy bits missing from the pinned
-- gamestate without replacing BalatroBot's large upstream state module.
-- Endpoints are loaded after BB_GAMESTATE, so this wrapper installs once and
-- applies to every later response, not only calls to reroll_boss.
local BALATRO_PILOT_STAKE_NAMES = {
  [1] = "WHITE",
  [2] = "RED",
  [3] = "GREEN",
  [4] = "BLACK",
  [5] = "BLUE",
  [6] = "PURPLE",
  [7] = "ORANGE",
  [8] = "GOLD",
}

local BALATRO_PILOT_VANILLA_BASE_DISCARDS = 3
local BALATRO_PILOT_DEFAULT_PERISHABLE_ROUNDS = 5
local BALATRO_PILOT_DEFAULT_RENTAL_RATE = 3

local function balatro_pilot_stake_identity(value)
  local level = tonumber(value)
  if level then
    return BALATRO_PILOT_STAKE_NAMES[level] or ("STAKE_" .. tostring(level)), level
  end
  if type(value) ~= "string" or value == "" then
    return nil, nil
  end
  local name = string.upper(value):gsub("^STAKE_", "")
  for candidate_level, candidate_name in pairs(BALATRO_PILOT_STAKE_NAMES) do
    if name == candidate_name then
      return candidate_name, candidate_level
    end
  end
  return name, nil
end

local function balatro_pilot_applied_stakes(game)
  local entries = {}
  local seen = {}
  for _, value in ipairs(game and game.applied_stakes or {}) do
    local name, level = balatro_pilot_stake_identity(value)
    if name and not seen[name] then
      entries[#entries + 1] = { name = name, level = level }
      seen[name] = true
    end
  end

  local _, current_level = balatro_pilot_stake_identity(game and game.stake)
  -- Upstream Balatro does not publish applied_stakes; its eight vanilla
  -- Stakes are cumulative by level, so retain an exact fallback there.
  if #entries == 0 and current_level then
    for level = 1, math.min(current_level, #BALATRO_PILOT_STAKE_NAMES) do
      local name = BALATRO_PILOT_STAKE_NAMES[level]
      entries[#entries + 1] = { name = name, level = level }
    end
  end

  table.sort(entries, function(left, right)
    local left_level = left.level or 999
    local right_level = right.level or 999
    if left_level == right_level then
      return left.name < right.name
    end
    return left_level < right_level
  end)

  local names = {}
  local levels = {}
  local lookup = {}
  for _, entry in ipairs(entries) do
    names[#names + 1] = entry.name
    levels[#levels + 1] = entry.level
    lookup[entry.name] = true
  end
  return names, levels, lookup
end

local function balatro_pilot_small_blind_reward(game, no_reward)
  local resets = game and game.round_resets or {}
  local choices = resets.blind_choices or {}
  local key = choices.Small or "bl_small"
  local center = G.P_BLINDS and G.P_BLINDS[key] or nil
  local base_reward = tonumber(center and center.dollars) or 3
  return base_reward, no_reward and 0 or base_reward
end

local function balatro_pilot_run_rules(state)
  local game = G.GAME or {}
  local modifiers = game.modifiers or {}
  local starting = game.starting_params or {}
  local no_blind_reward = modifiers.no_blind_reward or {}
  local applied_stakes, applied_stake_levels, applied_lookup = balatro_pilot_applied_stakes(game)
  local stake_name, stake_level = balatro_pilot_stake_identity(game.stake)
  stake_name = state.stake or stake_name

  local small_no_reward = no_blind_reward.Small == true
  local small_base_reward, small_reward = balatro_pilot_small_blind_reward(game, small_no_reward)
  local scaling_tier = tonumber(modifiers.scaling) or 1
  local ante_scaling = tonumber(starting.ante_scaling) or 1
  local actual_discards = tonumber(starting.discards) or BALATRO_PILOT_VANILLA_BASE_DISCARDS
  local stake_discard_penalty = applied_lookup.BLUE and 1 or 0
  local pre_stake_discards = actual_discards + stake_discard_penalty
  local perishable_rounds = tonumber(game.perishable_rounds) or BALATRO_PILOT_DEFAULT_PERISHABLE_ROUNDS
  local rental_rate = tonumber(game.rental_rate) or BALATRO_PILOT_DEFAULT_RENTAL_RATE

  local stake_rules = {
    stake = stake_name,
    stakeLevel = stake_level,
    stake_level = stake_level,
    appliedStakes = applied_stakes,
    applied_stakes = applied_stakes,
    appliedStakeLevels = applied_stake_levels,
    applied_stake_levels = applied_stake_levels,
    noSmallBlindReward = small_no_reward,
    no_small_blind_reward = small_no_reward,
    smallBlindNoReward = small_no_reward,
    small_blind_no_reward = small_no_reward,
    smallBlindBaseReward = small_base_reward,
    small_blind_base_reward = small_base_reward,
    smallBlindReward = small_reward,
    small_blind_reward = small_reward,
    scalingTier = scaling_tier,
    scaling_tier = scaling_tier,
    anteScaling = ante_scaling,
    ante_scaling = ante_scaling,
    baseDiscards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    base_discards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    vanillaBaseDiscards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    vanilla_base_discards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    preStakeDiscards = pre_stake_discards,
    pre_stake_discards = pre_stake_discards,
    startingDiscards = actual_discards,
    starting_discards = actual_discards,
    actualDiscards = actual_discards,
    actual_discards = actual_discards,
    discardModifier = -stake_discard_penalty,
    discard_modifier = -stake_discard_penalty,
    stakeDiscardPenalty = stake_discard_penalty,
    stake_discard_penalty = stake_discard_penalty,
    eternalStickers = modifiers.enable_eternals_in_shop == true,
    eternal_stickers = modifiers.enable_eternals_in_shop == true,
    eternal_in_shop = modifiers.enable_eternals_in_shop == true,
    perishableStickers = modifiers.enable_perishables_in_shop == true,
    perishable_stickers = modifiers.enable_perishables_in_shop == true,
    perishable_in_shop = modifiers.enable_perishables_in_shop == true,
    rentalStickers = modifiers.enable_rentals_in_shop == true,
    rental_stickers = modifiers.enable_rentals_in_shop == true,
    rental_in_shop = modifiers.enable_rentals_in_shop == true,
    perishableRounds = perishable_rounds,
    perishable_rounds = perishable_rounds,
    rentalRate = rental_rate,
    rental_rate = rental_rate,
  }
  local run_modifiers = {
    noBlindReward = {
      Small = no_blind_reward.Small == true,
      Big = no_blind_reward.Big == true,
      Boss = no_blind_reward.Boss == true,
    },
    no_blind_reward = {
      Small = no_blind_reward.Small == true,
      Big = no_blind_reward.Big == true,
      Boss = no_blind_reward.Boss == true,
    },
    noSmallBlindReward = small_no_reward,
    no_small_blind_reward = small_no_reward,
    smallBlindReward = small_reward,
    small_blind_reward = small_reward,
    scalingTier = scaling_tier,
    scaling_tier = scaling_tier,
    anteScaling = ante_scaling,
    ante_scaling = ante_scaling,
    baseDiscards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    base_discards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    vanillaBaseDiscards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    vanilla_base_discards = BALATRO_PILOT_VANILLA_BASE_DISCARDS,
    preStakeDiscards = pre_stake_discards,
    pre_stake_discards = pre_stake_discards,
    startingDiscards = actual_discards,
    starting_discards = actual_discards,
    actualDiscards = actual_discards,
    actual_discards = actual_discards,
    discardModifier = -stake_discard_penalty,
    discard_modifier = -stake_discard_penalty,
    stakeDiscardPenalty = stake_discard_penalty,
    stake_discard_penalty = stake_discard_penalty,
    enableEternalsInShop = modifiers.enable_eternals_in_shop == true,
    enable_eternals_in_shop = modifiers.enable_eternals_in_shop == true,
    enablePerishablesInShop = modifiers.enable_perishables_in_shop == true,
    enable_perishables_in_shop = modifiers.enable_perishables_in_shop == true,
    enableRentalsInShop = modifiers.enable_rentals_in_shop == true,
    enable_rentals_in_shop = modifiers.enable_rentals_in_shop == true,
    perishableRounds = perishable_rounds,
    perishable_rounds = perishable_rounds,
    rentalRate = rental_rate,
    rental_rate = rental_rate,
  }
  return stake_rules, run_modifiers
end

local function balatro_pilot_augment_card(extracted_card, native_card, run_modifiers)
  if type(extracted_card) ~= "table" then
    return
  end
  local modifier = extracted_card.modifier
  if type(modifier) ~= "table" then
    modifier = {}
    extracted_card.modifier = modifier
  end
  local ability = native_card and native_card.ability or nil
  if ability and ability.perishable then
    local tally = tonumber(ability.perish_tally)
    if tally == nil then
      tally = run_modifiers.perishable_rounds
    end
    -- Keep the legacy numeric field, including zero, while also making the
    -- identity/tally contract explicit for new consumers.
    modifier.perishable = tally
    modifier.isPerishable = true
    modifier.is_perishable = true
    modifier.perishableTally = tally
    modifier.perishable_tally = tally
    modifier.perishableRounds = run_modifiers.perishable_rounds
    modifier.perishable_rounds = run_modifiers.perishable_rounds
  elseif modifier.perishable ~= nil then
    modifier.isPerishable = true
    modifier.is_perishable = true
    modifier.perishableTally = tonumber(modifier.perishable)
    modifier.perishable_tally = tonumber(modifier.perishable)
    modifier.perishableRounds = run_modifiers.perishable_rounds
    modifier.perishable_rounds = run_modifiers.perishable_rounds
  end
  if ability and ability.rental then
    modifier.rental = true
    modifier.rentalRate = run_modifiers.rental_rate
    modifier.rental_rate = run_modifiers.rental_rate
  elseif modifier.rental then
    modifier.rentalRate = run_modifiers.rental_rate
    modifier.rental_rate = run_modifiers.rental_rate
  end
end

local function balatro_pilot_augment_area(extracted_area, native_area, run_modifiers)
  local extracted_cards = type(extracted_area) == "table" and extracted_area.cards or nil
  local native_cards = native_area and native_area.cards or nil
  if type(extracted_cards) ~= "table" then
    return
  end
  for index, extracted_card in ipairs(extracted_cards) do
    balatro_pilot_augment_card(extracted_card, native_cards and native_cards[index] or nil, run_modifiers)
  end
end

if not BB_GAMESTATE.balatro_pilot_boss_reroll_state then
  local get_native_gamestate = BB_GAMESTATE.get_gamestate
  BB_GAMESTATE.get_gamestate = function(...)
    local state = get_native_gamestate(...)
    local stake_rules, run_modifiers = balatro_pilot_run_rules(state)
    -- camelCase is the canonical controller interface; snake_case aliases keep
    -- the raw BalatroBot naming convention available to older integrations.
    state.stakeRules = stake_rules
    state.runModifiers = run_modifiers
    state.stake_rules = stake_rules
    state.run_modifiers = run_modifiers
    balatro_pilot_augment_area(state.jokers, G.jokers, run_modifiers)
    balatro_pilot_augment_area(state.consumables, G.consumeables, run_modifiers)
    balatro_pilot_augment_area(state.cards, G.deck, run_modifiers)
    balatro_pilot_augment_area(state.hand, G.hand, run_modifiers)
    balatro_pilot_augment_area(state.shop, G.shop_jokers, run_modifiers)
    balatro_pilot_augment_area(state.vouchers, G.shop_vouchers, run_modifiers)
    balatro_pilot_augment_area(state.packs, G.shop_booster, run_modifiers)
    balatro_pilot_augment_area(state.pack, G.pack_cards, run_modifiers)
    state.boss_rerolled = G.GAME
      and G.GAME.round_resets
      and G.GAME.round_resets.boss_rerolled == true
      or false
    state.last_tarot_planet = G.GAME and G.GAME.last_tarot_planet or nil
    -- Vanilla initializes this counter to 1 immediately before the first
    -- Ectoplasm use, then increments it after applying the hand-size loss.
    -- Always expose the next exact penalty as a positive integer.
    state.ecto_minus = G.GAME and G.GAME.ecto_minus or 1
    local menu_ready = false
    if type(BB_GAMESTATE.balatro_pilot_menu_ready) == "function" then
      menu_ready = BB_GAMESTATE.balatro_pilot_menu_ready() == true
    end
    state.menu_ready = menu_ready
    local hand_actions_ready = false
    local hand_actions_blocked_reason = "readiness_unavailable"
    if type(BB_GAMESTATE.balatro_pilot_hand_actions_ready) == "function" then
      local readiness_ok, ready, blocked_reason = pcall(BB_GAMESTATE.balatro_pilot_hand_actions_ready, false)
      if readiness_ok then
        hand_actions_ready = ready == true
        hand_actions_blocked_reason = blocked_reason
      else
        hand_actions_blocked_reason = "readiness_error"
      end
    end
    state.hand_actions_ready = hand_actions_ready
    state.hand_actions_blocked_reason = hand_actions_blocked_reason
    state.hand_action_in_flight = BB_GAMESTATE.balatro_pilot_hand_action_in_flight == true
    return state
  end
  BB_GAMESTATE.balatro_pilot_boss_reroll_state = true
end

---@type Endpoint
return {
  name = "reroll_boss",
  description = "Reroll the current Ante's Boss Blind with Director's Cut or Retcon",
  schema = {},
  requires_state = { G.STATES.BLIND_SELECT },

  ---@param _ table
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(_, send_response)
    sendDebugMessage("Init reroll_boss()", "BB.ENDPOINTS")

    local game = G.GAME
    local resets = game and game.round_resets
    local vouchers = game and game.used_vouchers or {}
    local has_retcon = vouchers["v_retcon"] ~= nil
    local has_directors_cut = vouchers["v_directors_cut"] ~= nil
    local available = game and ((game.dollars or 0) - (game.bankrupt_at or 0)) or 0

    if not resets or not G.blind_select_opts or not G.blind_select_opts.boss then
      send_response({
        message = "Boss Blind selection is not ready",
        name = BB_ERROR_NAMES.INVALID_STATE,
      })
      return
    end
    if available < 10 then
      send_response({
        message = string.format("Boss reroll costs $10, but only $%d is available", available),
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if not has_retcon and not has_directors_cut then
      send_response({
        message = "Boss reroll requires Director's Cut or Retcon",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if not has_retcon and resets.boss_rerolled then
      send_response({
        message = "Director's Cut has already rerolled this Ante's Boss Blind",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if G.CONTROLLER.locks.boss_reroll then
      send_response({
        message = "A Boss Blind reroll is already in progress",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end

    local old_boss_ui = G.blind_select_opts.boss
    local old_boss_key = resets.blind_choices and resets.blind_choices.Boss or "unknown"
    sendDebugMessage(string.format("Rerolling Boss Blind '%s'", tostring(old_boss_key)), "BB.ENDPOINTS")
    G.FUNCS.reroll_boss({})

    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      func = function()
        local replacement_ready = G.STATE == G.STATES.BLIND_SELECT
          and G.blind_select_opts
          and G.blind_select_opts.boss
          and G.blind_select_opts.boss ~= old_boss_ui
          and not G.CONTROLLER.locks.boss_reroll
        if replacement_ready then
          local new_boss_key = G.GAME.round_resets.blind_choices.Boss or "unknown"
          sendDebugMessage(
            string.format("Return reroll_boss(): '%s' -> '%s'", tostring(old_boss_key), tostring(new_boss_key)),
            "BB.ENDPOINTS"
          )
          send_response(BB_GAMESTATE.get_gamestate())
          return true
        end
        return false
      end,
    }))
  end,
}
