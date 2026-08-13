-- Balatro Pilot endpoint for Director's Cut / Retcon boss rerolls.
--
-- Every destructive precondition is checked again inside the game process;
-- callers cannot bypass the voucher, one-per-Ante, or affordability rules.

-- Publish the small set of native strategy bits missing from the pinned
-- gamestate without replacing BalatroBot's large upstream state module.
-- Endpoints are loaded after BB_GAMESTATE, so this wrapper installs once and
-- applies to every later response, not only calls to reroll_boss.
if not BB_GAMESTATE.balatro_pilot_boss_reroll_state then
  local get_native_gamestate = BB_GAMESTATE.get_gamestate
  BB_GAMESTATE.get_gamestate = function(...)
    local state = get_native_gamestate(...)
    state.boss_rerolled = G.GAME
      and G.GAME.round_resets
      and G.GAME.round_resets.boss_rerolled == true
      or false
    state.last_tarot_planet = G.GAME and G.GAME.last_tarot_planet or nil
    -- Vanilla initializes this counter to 1 immediately before the first
    -- Ectoplasm use, then increments it after applying the hand-size loss.
    -- Always expose the next exact penalty as a positive integer.
    state.ecto_minus = G.GAME and G.GAME.ecto_minus or 1
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
