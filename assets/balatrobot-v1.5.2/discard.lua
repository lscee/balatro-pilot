-- Balatro Pilot replacement for BalatroBot v1.5.2 discard endpoint.
--
-- Vanilla discard_cards_from_highlighted(e, hook) never reads e.  The
-- upstream endpoint nevertheless looked up discard_button through G.buttons,
-- so a persistent deck preview could reject an otherwise valid discard.

---@type BB_LOGGER
local BB_LOGGER = assert(SMODS.load_file("src/lua/utils/logger.lua"))()

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
  name = "discard",

  description = "Discard cards from the hand",

  schema = {
    cards = {
      type = "array",
      required = true,
      items = "integer",
      description = "0-based indices of cards to discard",
    },
  },

  requires_state = { G.STATES.SELECTING_HAND },

  ---@param args Request.Endpoint.Discard.Params
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(args, send_response)
    sendDebugMessage("Init discard()", "BB.ENDPOINTS")
    if #args.cards == 0 then
      send_response({
        message = "Must provide at least one card to discard",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    local readiness = BB_GAMESTATE.balatro_pilot_hand_actions_ready
    if type(readiness) ~= "function" then
      send_response({
        message = "Hand-action readiness is not initialized",
        name = BB_ERROR_NAMES.INVALID_STATE,
      })
      return
    end
    local hand_actions_ready, not_ready_reason = readiness(false)
    if not hand_actions_ready then
      send_response({
        message = "Hand actions are not ready: " .. tostring(not_ready_reason),
        name = BB_ERROR_NAMES.INVALID_STATE,
      })
      return
    end

    if G.GAME.current_round.discards_left <= 0 then
      send_response({
        message = "No discards left",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end

    local native_discard_limit = math.max(G.GAME.starting_params.discard_limit or 0, 0)
    if #args.cards > G.hand.config.highlighted_limit or #args.cards > native_discard_limit then
      send_response({
        message = "You can only discard " .. math.min(G.hand.config.highlighted_limit, native_discard_limit) .. " cards",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end
    local discard_capacity = (G.discard.config.card_limit or 0) - #G.play.cards
    if #args.cards > discard_capacity then
      send_response({
        message = "The discard area cannot accept the requested cards yet",
        name = BB_ERROR_NAMES.INVALID_STATE,
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
    local remaining = G.GAME.current_round.discards_left - 1
    sendDebugMessage(
      string.format("Discarding %d cards: %s (%d discards left)", #args.cards, card_str, remaining),
      "BB.ENDPOINTS"
    )

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

    game_over_callback = function(_)
      finish()
    end
    BB_GAMESTATE.on_game_over = game_over_callback
    BB_GAMESTATE.balatro_pilot_hand_action_in_flight = true

    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      blockable = false,
      pause_force = true,
      func = function()
        if G.STATE == G.STATES.DRAW_TO_HAND then
          draw_to_hand = true
        end

        local next_hand_ready = readiness(true)
        if draw_to_hand and next_hand_ready then
          sendDebugMessage("Return discard()", "BB.ENDPOINTS")
          finish()
          return true
        end
        return false
      end,
    }))

    -- Vanilla accepts a UI element for callback symmetry but never reads it.
    -- The shared in-flight flag is set before this call, preventing a retry
    -- from committing a second discard while native events are pending.
    local submitted, submit_error = pcall(function()
      G.FUNCS.discard_cards_from_highlighted(nil)
    end)
    if not submitted then
      response_sent = true
      send_response({
        message = "Native discard submission failed with an uncertain outcome: " .. tostring(submit_error),
        name = BB_ERROR_NAMES.INTERNAL_ERROR,
      })
    end
  end,
}
