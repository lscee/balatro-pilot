-- Balatro Pilot replacement for BalatroBot v1.5.2 play endpoint.
--
-- G.GAME.won remains true after entering Endless.  Upstream treated that
-- persistent flag as a fresh victory after every later Blind and returned
-- before the round-evaluation UI had finished.  Only the native paused win
-- overlay is a fresh victory; ordinary Endless rounds must wait for the full
-- payout UI just like pre-victory rounds.

---@type BB_LOGGER
local BB_LOGGER = assert(SMODS.load_file("src/lua/utils/logger.lua"))()

-- The native play/discard callbacks do not inspect their UI element argument.
-- Treat the game model as the authority so a held deck-preview hover (which
-- intentionally removes G.buttons) cannot strand automation.  Transient game
-- states and a request already committed to the native event queue remain
-- hard blockers.
local function balatro_pilot_hand_actions_ready(ignore_in_flight)
  if not G or not G.STATES or G.STATE ~= G.STATES.SELECTING_HAND then
    return false, "not_selecting_hand"
  end
  if G.STATE_COMPLETE ~= true then
    return false, "state_incomplete"
  end
  if not G.SETTINGS or G.SETTINGS.paused == true then
    return false, "paused"
  end
  if G.OVERLAY_MENU then
    return false, "overlay_open"
  end
  if G.screenwipe then
    return false, "screenwipe_active"
  end

  local controller = G.CONTROLLER
  if not controller then
    return false, "controller_missing"
  end
  if controller.locked == true or controller.lock_input == true or controller.frame_buttonpress then
    return false, "controller_locked"
  end
  if not ignore_in_flight and BB_GAMESTATE.balatro_pilot_hand_action_in_flight == true then
    return false, "hand_action_in_flight"
  end

  if not G.GAME or not G.GAME.current_round or not G.GAME.starting_params or not G.GAME.blind then
    return false, "round_missing"
  end
  if type(G.GAME.current_round.hands_left) ~= "number"
    or type(G.GAME.current_round.discards_left) ~= "number"
    or type(G.GAME.starting_params.play_limit) ~= "number"
    or type(G.GAME.starting_params.discard_limit) ~= "number"
  then
    return false, "round_counters_missing"
  end
  if G.GAME.blind.block_play then
    return false, "blind_blocks_play"
  end
  if not G.hand or not G.hand.cards or not G.hand.highlighted or not G.hand.config then
    return false, "hand_missing"
  end
  if type(G.hand.config.highlighted_limit) ~= "number" or type(G.hand.unhighlight_all) ~= "function" then
    return false, "hand_controls_missing"
  end
  if not G.hand.cards[1] then
    return false, "hand_empty"
  end
  if not G.play or not G.play.cards or G.play.cards[1] then
    return false, "played_cards_in_flight"
  end
  if not G.discard or not G.discard.cards or not G.discard.config then
    return false, "discard_area_missing"
  end
  if type(G.discard.config.card_limit) ~= "number" then
    return false, "discard_capacity_missing"
  end
  -- Event is a callable class table in the live Balatro runtime, not a plain
  -- Lua function.  Presence is the safe invariant; add_event remains a method.
  if not G.E_MANAGER or type(G.E_MANAGER.add_event) ~= "function" or Event == nil then
    return false, "event_manager_missing"
  end
  if not G.FUNCS
    or type(G.FUNCS.play_cards_from_highlighted) ~= "function"
    or type(G.FUNCS.discard_cards_from_highlighted) ~= "function"
  then
    return false, "native_hand_action_missing"
  end
  return true, nil
end

BB_GAMESTATE.balatro_pilot_hand_actions_ready = balatro_pilot_hand_actions_ready

local function highlighted_cards_match(selected_cards)
  if #G.hand.highlighted ~= #selected_cards then return false end
  local selected = {}
  for _, card in ipairs(selected_cards) do selected[card] = true end
  for _, card in ipairs(G.hand.highlighted) do
    if not selected[card] then return false end
  end
  return true
end

---@type Endpoint
return {
  name = "play",

  description = "Play a card from the hand",

  schema = {
    cards = {
      type = "array",
      required = true,
      items = "integer",
      description = "0-based indices representing cards to play",
    },
  },

  requires_state = { G.STATES.SELECTING_HAND },

  ---@param args Request.Endpoint.Play.Params
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(args, send_response)
    sendDebugMessage("Init play()", "BB.ENDPOINTS")
    if #args.cards == 0 then
      send_response({
        message = "Must provide at least one card to play",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    local hand_actions_ready, not_ready_reason = balatro_pilot_hand_actions_ready(false)
    if not hand_actions_ready then
      send_response({
        message = "Hand actions are not ready: " .. tostring(not_ready_reason),
        name = BB_ERROR_NAMES.INVALID_STATE,
      })
      return
    end

    local native_play_limit = math.max(G.GAME.starting_params.play_limit or 0, 1)
    if #args.cards > G.hand.config.highlighted_limit or #args.cards > native_play_limit then
      send_response({
        message = "You can only play " .. math.min(G.hand.config.highlighted_limit, native_play_limit) .. " cards",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    local selected_cards = {}
    local seen_indices = {}
    for _, card_index in ipairs(args.cards) do
      if seen_indices[card_index] then
        send_response({
          message = "Duplicate card index: " .. card_index,
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return
      end
      seen_indices[card_index] = true
      if not G.hand.cards[card_index + 1] then
        send_response({
          message = "Invalid card index: " .. card_index,
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return
      end
      if type(G.hand.cards[card_index + 1].click) ~= "function" then
        send_response({
          message = "Card is not selectable: " .. card_index,
          name = BB_ERROR_NAMES.INVALID_STATE,
        })
        return
      end
      selected_cards[#selected_cards + 1] = G.hand.cards[card_index + 1]
    end

    if G.GAME.current_round.hands_left <= 0 then
      send_response({
        message = "No hands left",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if G.GAME.blind.block_play then
      send_response({
        message = "The current Blind blocks playing this hand",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end

    G.hand:unhighlight_all()
    for _, card in ipairs(selected_cards) do
      if not card.highlighted then card:click() end
    end
    if not highlighted_cards_match(selected_cards) then
      G.hand:unhighlight_all()
      send_response({
        message = "The requested cards could not be selected exactly",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end

    local card_str = BB_LOGGER.format_playing_cards(G.hand.cards, args.cards)
    sendDebugMessage(string.format("Playing %d cards: %s", #args.cards, card_str), "BB.ENDPOINTS")

    local hand_played = false
    local draw_to_hand = false
    local response_sent = false
    local game_over_callback = nil

    local function finish()
      BB_GAMESTATE.balatro_pilot_hand_action_in_flight = false
      if BB_GAMESTATE.on_game_over == game_over_callback then
        BB_GAMESTATE.on_game_over = nil
      end
      if not response_sent then
        response_sent = true
        send_response(BB_GAMESTATE.get_gamestate())
      end
    end

    -- GAME_OVER pauses the event manager, so gamestate's love.update hook is
    -- still the authority for responding to a lost final hand.
    game_over_callback = function(_)
      finish()
    end
    BB_GAMESTATE.on_game_over = game_over_callback
    BB_GAMESTATE.balatro_pilot_hand_action_in_flight = true

    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      blockable = false,
      -- Event() derives its internal created_on_pause flag from pause_force.
      -- This lets the pending play RPC observe the native victory overlay
      -- after win_game() pauses the engine.
      pause_force = true,
      func = function()
        if G.STATE == G.STATES.HAND_PLAYED then
          hand_played = true
        end
        if G.STATE == G.STATES.DRAW_TO_HAND then
          draw_to_hand = true
        end

        if G.STATE == G.STATES.ROUND_EVAL then
          if not G.round_eval or not G.STATE_COMPLETE or G.CONTROLLER.locked then
            return false
          end

          -- A fresh victory is identified by the native paused overlay, not
          -- by G.GAME.won alone: that flag intentionally persists in Endless.
          local native_win_overlay = (
            G.GAME
            and G.GAME.won == true
            and G.OVERLAY_MENU
            and G.SETTINGS
            and G.SETTINGS.paused == true
          )
          if native_win_overlay then
            sendDebugMessage("Return play() - won with native overlay", "BB.ENDPOINTS")
            finish()
            return true
          end

          local has_blind1 = G.round_eval:get_UIE_by_ID("dollar_blind1") ~= nil
          local has_cash_out_button = false
          for _, box in ipairs(G.I and G.I.UIBOX or {}) do
            if box.get_UIE_by_ID and box:get_UIE_by_ID("cash_out_button") then
              has_cash_out_button = true
              break
            end
          end

          -- Waiting for both ends of the payout UI ensures no queued
          -- add_round_eval_row event can still reference G.round_eval after
          -- the controller proceeds to cash_out.
          if has_blind1 and has_cash_out_button then
            sendDebugMessage("Return play() - cash out UI ready", "BB.ENDPOINTS")
            finish()
            return true
          end
        end

        local next_hand_ready = balatro_pilot_hand_actions_ready(true)
        if draw_to_hand and hand_played and next_hand_ready then
          sendDebugMessage("Return play() - same round", "BB.ENDPOINTS")
          finish()
          return true
        end

        return false
      end,
    }))

    -- Vanilla's callback accepts an event argument for UI dispatch symmetry,
    -- but never reads it.  Passing nil avoids coupling RPC safety to G.buttons;
    -- the in-flight flag is set first so a concurrent retry cannot submit twice.
    local submitted, submit_error = pcall(function()
      G.FUNCS.play_cards_from_highlighted(nil)
    end)
    if not submitted then
      -- Native side effects may already have begun.  Report uncertainty but
      -- intentionally retain the in-flight lock until a state transition (or
      -- restart) proves that another submission cannot duplicate the hand.
      response_sent = true
      send_response({
        message = "Native play submission failed with an uncertain outcome: " .. tostring(submit_error),
        name = BB_ERROR_NAMES.INTERNAL_ERROR,
      })
    end
  end,
}
