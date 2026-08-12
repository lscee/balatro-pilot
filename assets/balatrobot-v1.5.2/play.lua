-- Balatro Pilot replacement for BalatroBot v1.5.2 play endpoint.
--
-- G.GAME.won remains true after entering Endless.  Upstream treated that
-- persistent flag as a fresh victory after every later Blind and returned
-- before the round-evaluation UI had finished.  Only the native paused win
-- overlay is a fresh victory; ordinary Endless rounds must wait for the full
-- payout UI just like pre-victory rounds.

---@type BB_LOGGER
local BB_LOGGER = assert(SMODS.load_file("src/lua/utils/logger.lua"))()

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

    if #args.cards > G.hand.config.highlighted_limit then
      send_response({
        message = "You can only play " .. G.hand.config.highlighted_limit .. " cards",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    for _, card_index in ipairs(args.cards) do
      if not G.hand.cards[card_index + 1] then
        send_response({
          message = "Invalid card index: " .. card_index,
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return
      end
    end

    G.hand:unhighlight_all()
    for _, card_index in ipairs(args.cards) do
      G.hand.cards[card_index + 1]:click()
    end

    local card_str = BB_LOGGER.format_playing_cards(G.hand.cards, args.cards)
    sendDebugMessage(string.format("Playing %d cards: %s", #args.cards, card_str), "BB.ENDPOINTS")

    ---@diagnostic disable-next-line: undefined-field
    local play_button = UIBox:get_UIE_by_ID("play_button", G.buttons.UIRoot)
    assert(play_button ~= nil, "play() play button not found")
    G.FUNCS.play_cards_from_highlighted(play_button)

    local hand_played = false
    local draw_to_hand = false

    -- GAME_OVER pauses the event manager, so gamestate's love.update hook is
    -- still the authority for responding to a lost final hand.
    BB_GAMESTATE.on_game_over = send_response

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
            send_response(BB_GAMESTATE.get_gamestate())
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
            send_response(BB_GAMESTATE.get_gamestate())
            return true
          end
        end

        if draw_to_hand and hand_played and G.buttons and G.STATE == G.STATES.SELECTING_HAND then
          sendDebugMessage("Return play() - same round", "BB.ENDPOINTS")
          send_response(BB_GAMESTATE.get_gamestate())
          return true
        end

        return false
      end,
    }))
  end,
}
