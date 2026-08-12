-- Balatro Pilot extension for the pinned BalatroBot v1.5.2 runtime.
--
-- Continue a completed run into Balatro's Endless mode.  This deliberately
-- does not emulate a button click or alter game state: it only dismisses the
-- native win overlay when the game has already recorded a real victory.

---@type Endpoint
return {
  name = "endless",

  description = "Continue a won run into Endless mode from the win overlay",

  schema = {},

  requires_state = { G.STATES.ROUND_EVAL },

  ---@param _ table
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(_, send_response)
    sendDebugMessage("Init endless()", "BB.ENDPOINTS")

    -- The Round Eval state alone is also used for ordinary cash-out.  Require
    -- every native win-overlay invariant before unpausing anything.
    if not G.GAME or G.GAME.won ~= true then
      send_response({
        message = "endless() requires a completed winning run",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if not G.OVERLAY_MENU or not G.SETTINGS or G.SETTINGS.paused ~= true then
      send_response({
        message = "endless() requires the native win overlay to be open and paused",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if not G.FUNCS or type(G.FUNCS.exit_overlay_menu) ~= "function" then
      send_response({
        message = "endless() could not access the native overlay dismiss action",
        name = BB_ERROR_NAMES.INTERNAL_ERROR,
      })
      return
    end

    -- This is the same callback used by Balatro's blue "Endless" button.
    G.FUNCS.exit_overlay_menu()

    -- Wait one event tick so callers only receive the unpaused, stable game
    -- state, not the transient overlay state that initiated the action.
    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      func = function()
        local ready = (
          G.STATE == G.STATES.ROUND_EVAL
          and G.GAME
          and G.GAME.won == true
          and not G.OVERLAY_MENU
          and G.SETTINGS
          and G.SETTINGS.paused == false
        )
        if ready then
          sendDebugMessage("Return endless() - continuing won run", "BB.ENDPOINTS")
          send_response(BB_GAMESTATE.get_gamestate())
        end
        return ready
      end,
    }))
  end,
}
