-- Balatro Pilot replacement for BalatroBot v1.5.2 cash_out endpoint.
--
-- Never remove G.round_eval while Balatro still has delayed payout-row events
-- queued against it.  The endpoint now waits for both the first payout row and
-- the native cash-out button before invoking the native callback.

---@type Endpoint
return {
  name = "cash_out",

  description = "Cash out and collect round rewards",

  schema = {},

  requires_state = { G.STATES.ROUND_EVAL },

  ---@param _ Request.Endpoint.CashOut.Params
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(_, send_response)
    sendDebugMessage("Init cash_out() - waiting for payout UI", "BB.ENDPOINTS")

    if not G.round_eval then
      send_response({
        message = "cash_out() requires an active round evaluation UI",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if G.OVERLAY_MENU or not G.SETTINGS or G.SETTINGS.paused == true then
      send_response({
        message = "cash_out() cannot run while a modal overlay is open or the game is paused",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end

    local function cash_out_button_ready()
      for _, box in ipairs(G.I and G.I.UIBOX or {}) do
        if box.get_UIE_by_ID and box:get_UIE_by_ID("cash_out_button") then
          return true
        end
      end
      return false
    end

    local function num_items(area)
      local count = 0
      if area and area.cards then
        for _, card in ipairs(area.cards) do
          if card.children.buy_button and card.children.buy_button.definition then
            count = count + 1
          end
        end
      end
      return count
    end

    local cash_out_started = false
    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      blockable = false,
      func = function()
        if not cash_out_started then
          local payout_ready = (
            G.STATE == G.STATES.ROUND_EVAL
            and G.STATE_COMPLETE
            and G.round_eval
            and not G.CONTROLLER.locked
            and not G.OVERLAY_MENU
            and G.SETTINGS
            and G.SETTINGS.paused == false
            and G.round_eval:get_UIE_by_ID("dollar_blind1") ~= nil
            and cash_out_button_ready()
          )
          if not payout_ready then
            return false
          end

          -- This is intentionally inside the readiness event.  Calling it at
          -- execute() time was the crash: it cleared G.round_eval while native
          -- payout-row events were still queued.
          cash_out_started = true
          sendDebugMessage("cash_out() payout UI ready; invoking native action", "BB.ENDPOINTS")
          G.FUNCS.cash_out({ config = {} })
          return false
        end

        if G.STATE == G.STATES.SHOP and G.STATE_COMPLETE then
          local shop_ready = (
            num_items(G.shop_booster) > 0
            or num_items(G.shop_jokers) > 0
            or num_items(G.shop_vouchers) > 0
          )
          if shop_ready then
            sendDebugMessage("Return cash_out() - reached SHOP state", "BB.ENDPOINTS")
            send_response(BB_GAMESTATE.get_gamestate())
            return true
          end
        end
        return false
      end,
    }))
  end,
}
