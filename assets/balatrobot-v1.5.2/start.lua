-- src/lua/endpoints/start.lua

-- ============================================================================
-- Start Endpoint Params
-- ============================================================================

---@class Request.Endpoint.Start.Params
---@field deck Deck deck enum value (e.g., "RED", "BLUE", "YELLOW")
---@field stake Stake stake enum value (e.g., "WHITE", "RED", "GREEN", "BLACK", "BLUE", "PURPLE", "ORANGE", "GOLD")
---@field seed string? optional seed for the run

-- ============================================================================
-- Start Endpoint Utils
-- ============================================================================

local DECK_ENUM_TO_NAME = {
  RED = "Red Deck",
  BLUE = "Blue Deck",
  YELLOW = "Yellow Deck",
  GREEN = "Green Deck",
  BLACK = "Black Deck",
  MAGIC = "Magic Deck",
  NEBULA = "Nebula Deck",
  GHOST = "Ghost Deck",
  ABANDONED = "Abandoned Deck",
  CHECKERED = "Checkered Deck",
  ZODIAC = "Zodiac Deck",
  PAINTED = "Painted Deck",
  ANAGLYPH = "Anaglyph Deck",
  PLASMA = "Plasma Deck",
  ERRATIC = "Erratic Deck",
}

local STAKE_ENUM_TO_NUMBER = {
  WHITE = 1,
  RED = 2,
  GREEN = 3,
  BLACK = 4,
  BLUE = 5,
  PURPLE = 6,
  ORANGE = 7,
  GOLD = 8,
}

-- Balatro changes G.STATE to MENU at the start of the asynchronous native
-- go_to_menu transition. Calling start_run during that transition creates a
-- second screen wipe while the first wipe's no_delete events still reference
-- the global G.screenwipe, which can crash once either wipe clears it.
--
-- G.STATE_COMPLETE is not set back to true by vanilla update_menu(), so the
-- presence of the native MAIN_MENU_UI is the reliable completion signal for a
-- normal main menu. Require that concrete UI object and fail closed on every
-- other transition marker; STATE_COMPLETE is diagnostic only in MENU.
local function balatro_pilot_menu_ready()
  if not G or not G.STATES or G.STATE ~= G.STATES.MENU then
    return false, "state"
  end
  if G.MAIN_MENU_UI == nil then
    return false, "main_menu_ui"
  end
  if not G.SETTINGS or G.SETTINGS.paused == true then
    return false, "paused"
  end
  if G.screenwipe ~= nil or G.OVERLAY_MENU ~= nil then
    return false, "screenwipe_or_overlay"
  end

  local controller = G.CONTROLLER
  if not controller or controller.lock_input == true then
    return false, "controller"
  end
  local locks = controller.locks or {}
  local transition_locks = {
    "wipe",
    "load",
    "use",
    "toggle_shop",
    "skip_blind",
    "boss_reroll",
    "shop_reroll",
  }
  for _, lock_name in ipairs(transition_locks) do
    if locks[lock_name] then
      return false, "lock_" .. lock_name
    end
  end

  return true, nil
end

-- The gamestate compatibility wrapper is installed by reroll_boss.lua after
-- endpoints load. Expose the exact same predicate so state and mutation cannot
-- drift apart.
BB_GAMESTATE.balatro_pilot_menu_ready = balatro_pilot_menu_ready

-- ============================================================================
-- Start Endpoint
-- ============================================================================

---@type Endpoint
return {

  name = "start",

  description = "Start a new game run with specified deck and stake",

  schema = {
    deck = {
      type = "string",
      required = true,
      description = "Deck enum value (e.g., 'RED', 'BLUE', 'YELLOW')",
    },
    stake = {
      type = "string",
      required = true,
      description = "Stake enum value (e.g., 'WHITE', 'RED', 'GREEN', 'BLACK', 'BLUE', 'PURPLE', 'ORANGE', 'GOLD')",
    },
    seed = {
      type = "string",
      required = false,
      description = "Optional seed for the run",
    },
  },

  requires_state = { G.STATES.MENU },

  ---@param args Request.Endpoint.Start.Params
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(args, send_response)
    sendDebugMessage("Init start()", "BB.ENDPOINTS")

    -- Recheck native transition readiness inside the endpoint immediately
    -- before any setup_run/start_run mutation. Dispatcher state validation by
    -- itself is insufficient because G.STATE becomes MENU too early.
    local menu_ready, not_ready_reason = balatro_pilot_menu_ready()
    if not menu_ready then
      sendDebugMessage(
        "start() rejected while main menu is transitioning: " .. tostring(not_ready_reason),
        "BB.ENDPOINTS"
      )
      send_response({
        message = "Main menu is still transitioning; retry after gamestate.menu_ready is true ("
          .. tostring(not_ready_reason)
          .. ")",
        name = BB_ERROR_NAMES.INVALID_STATE,
      })
      return
    end

    -- Validate and map stake enum
    local stake_number = STAKE_ENUM_TO_NUMBER[args.stake]
    if not stake_number then
      sendDebugMessage("start() called with invalid stake enum: " .. tostring(args.stake), "BB.ENDPOINTS")
      send_response({
        message = "Invalid stake enum. Must be one of: WHITE, RED, GREEN, BLACK, BLUE, PURPLE, ORANGE, GOLD. Got: "
          .. tostring(args.stake),
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    -- Validate and map deck enum
    local deck_name = DECK_ENUM_TO_NAME[args.deck]
    if not deck_name then
      sendDebugMessage("start() called with invalid deck enum: " .. tostring(args.deck), "BB.ENDPOINTS")
      send_response({
        message = "Invalid deck enum. Must be one of: RED, BLUE, YELLOW, GREEN, BLACK, MAGIC, NEBULA, GHOST, ABANDONED, CHECKERED, ZODIAC, PAINTED, ANAGLYPH, PLASMA, ERRATIC. Got: "
          .. tostring(args.deck),
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    -- Reset the game (setup_run and exit_overlay_menu)
    G.FUNCS.setup_run({ config = {} })
    G.FUNCS.exit_overlay_menu()

    -- Find and set the deck using the mapped deck name
    local deck_found = false
    if G.P_CENTER_POOLS and G.P_CENTER_POOLS.Back then
      for _, deck_data in pairs(G.P_CENTER_POOLS.Back) do
        if deck_data.name == deck_name then
          sendDebugMessage("Setting deck to: " .. deck_data.name .. " (from enum: " .. args.deck .. ")", "BB.ENDPOINTS")
          G.GAME.selected_back:change_to(deck_data)
          G.GAME.viewed_back:change_to(deck_data)
          deck_found = true
          break
        end
      end
    end

    if not deck_found then
      sendDebugMessage("start() deck not found in game data: " .. deck_name, "BB.ENDPOINTS")
      send_response({
        message = "Deck not found in game data: " .. deck_name,
        name = BB_ERROR_NAMES.INTERNAL_ERROR,
      })
      return
    end

    -- Balatro Pilot: inject entropy at the actual native seed call.
    -- G.FUNCS.start_run is asynchronous and cursor_hover.time is rewritten every
    -- frame, so changing it before start_run races with Controller:set_cursor_hover().
    -- run_params.seed remains nil, preserving normal unlocks and statistics.
    if not args.seed and type(generate_starting_seed) == "function" then
      G.BALATRO_PILOT_UNSEEDED_NONCE = (G.BALATRO_PILOT_UNSEEDED_NONCE or 0) + 1
      local native_generate_starting_seed = generate_starting_seed
      local wall_clock = os.time and os.time() or 0
      local high_res_clock = love and love.timer and love.timer.getTime and love.timer.getTime()
        or (os.clock and os.clock() or 0)
      local entropy = (
        (wall_clock % 2147483647)
        + math.floor((high_res_clock % 4096) * 1000000)
        + G.BALATRO_PILOT_UNSEEDED_NONCE * 104729
      ) % 2147483647
      local previous_seed = G.BALATRO_PILOT_LAST_UNSEEDED_SEED

      generate_starting_seed = function()
        generate_starting_seed = native_generate_starting_seed
        local previous_cursor_time = G.CONTROLLER and G.CONTROLLER.cursor_hover
          and G.CONTROLLER.cursor_hover.time or nil
        local generated_seed = nil
        for attempt = 0, 7 do
          if G.CONTROLLER and G.CONTROLLER.cursor_hover then
            G.CONTROLLER.cursor_hover.time = entropy + attempt * 104729
          end
          generated_seed = native_generate_starting_seed()
          if generated_seed ~= previous_seed then break end
        end
        if G.CONTROLLER and G.CONTROLLER.cursor_hover then
          G.CONTROLLER.cursor_hover.time = previous_cursor_time
        end
        G.BALATRO_PILOT_LAST_UNSEEDED_SEED = generated_seed
        return generated_seed
      end
    end
    -- Start the run with stake number and optional seed
    local run_params = { stake = stake_number }
    if args.seed then
      run_params.seed = args.seed
    end

    sendDebugMessage(
      "Starting run with stake="
        .. tostring(stake_number)
        .. " ("
        .. args.stake
        .. "), seed="
        .. tostring(args.seed or "none"),
      "BB.ENDPOINTS"
    )
    G.FUNCS.start_run(nil, run_params)

    -- Wait for run to start using Balatro's Event Manager
    G.E_MANAGER:add_event(Event({
      no_delete = true,
      trigger = "condition",
      blocking = false,
      func = function()
        local done = (
          G.GAME.blind_on_deck ~= nil
          and G.blind_select_opts ~= nil
          and G.blind_select_opts["small"]:get_UIE_by_ID("tag_Small") ~= nil
        )
        if done then
          sendDebugMessage("Return start()", "BB.ENDPOINTS")
          local state_data = BB_GAMESTATE.get_gamestate()
          send_response(state_data)
        end

        return done
      end,
    }))
  end,
}
