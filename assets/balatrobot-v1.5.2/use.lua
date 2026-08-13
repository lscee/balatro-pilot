-- Balatro Pilot replacement for BalatroBot v1.5.2 use endpoint.
--
-- Aura is a vanilla special case: unlike ordinary targeted consumables its
-- center config does not declare max_highlighted, even though the game only
-- permits it with exactly one editionless hand card highlighted.  Treat that
-- contract explicitly before delegating the final legality check to Balatro.

---@type BB_LOGGER
local BB_LOGGER = assert(SMODS.load_file("src/lua/utils/logger.lua"))()

---@class Request.Endpoint.Use.Params
---@field consumable integer 0-based index of consumable to use
---@field cards integer[]? 0-based indices of cards to target

--- @param card table
--- @return table
local function get_target_requirements(card)
  local config = card.ability and card.ability.consumeable or {}
  local center_key = card.config
    and (card.config.center_key or (card.config.center and card.config.center.key))
  if center_key == "c_aura" then
    return { requires_cards = true, min = 1, max = 1 }
  end
  if config.max_highlighted ~= nil then
    return {
      requires_cards = true,
      min = config.min_highlighted or 1,
      max = config.max_highlighted,
    }
  end
  return { requires_cards = false }
end

---@type Endpoint
return {
  name = "use",
  description = "Use a consumable card with optional target cards",
  schema = {
    consumable = {
      type = "integer",
      required = true,
      description = "0-based index of consumable to use",
    },
    cards = {
      type = "array",
      required = false,
      description = "0-based indices of cards to target (required only if consumable requires cards)",
      items = "integer",
    },
  },
  requires_state = { G.STATES.SELECTING_HAND, G.STATES.SHOP },

  ---@param args Request.Endpoint.Use.Params
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(args, send_response)
    sendDebugMessage("Init use()", "BB.ENDPOINTS")

    if args.consumable < 0 or args.consumable >= #G.consumeables.cards then
      send_response({
        message = "Consumable index out of range: " .. args.consumable,
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    local consumable_card = G.consumeables.cards[args.consumable + 1]
    local requirements = get_target_requirements(consumable_card)

    if requirements.requires_cards and G.STATE ~= G.STATES.SELECTING_HAND then
      send_response({
        message = "Consumable '"
          .. consumable_card.ability.name
          .. "' requires card selection and can only be used in SELECTING_HAND state",
        name = BB_ERROR_NAMES.INVALID_STATE,
      })
      return
    end

    if requirements.requires_cards then
      if not args.cards or #args.cards == 0 then
        send_response({
          message = "Consumable '" .. consumable_card.ability.name .. "' requires card selection",
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return
      end

      for _, card_idx in ipairs(args.cards) do
        if card_idx < 0 or card_idx >= #G.hand.cards then
          send_response({
            message = "Card index out of range: " .. card_idx,
            name = BB_ERROR_NAMES.BAD_REQUEST,
          })
          return
        end
      end

      local card_count = #args.cards
      if requirements.min == requirements.max and card_count ~= requirements.min then
        send_response({
          message = string.format(
            "Consumable '%s' requires exactly %d card%s (provided: %d)",
            consumable_card.ability.name,
            requirements.min,
            requirements.min == 1 and "" or "s",
            card_count
          ),
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return
      end
      if card_count < requirements.min then
        send_response({
          message = string.format(
            "Consumable '%s' requires at least %d card%s (provided: %d)",
            consumable_card.ability.name,
            requirements.min,
            requirements.min == 1 and "" or "s",
            card_count
          ),
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return
      end
      if card_count > requirements.max then
        send_response({
          message = string.format(
            "Consumable '%s' requires at most %d card%s (provided: %d)",
            consumable_card.ability.name,
            requirements.max,
            requirements.max == 1 and "" or "s",
            card_count
          ),
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return
      end
    elseif args.cards and #args.cards > 0 then
      send_response({
        message = "Consumable '" .. consumable_card.ability.name .. "' does not accept target cards",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    if requirements.requires_cards then
      for i = #G.hand.highlighted, 1, -1 do
        G.hand:remove_from_highlighted(G.hand.highlighted[i], true)
      end
      for _, card_idx in ipairs(args.cards) do
        G.hand:add_to_highlighted(G.hand.cards[card_idx + 1], true)
      end
    end

    local cons_name = consumable_card.ability.name
    if args.cards and #args.cards > 0 then
      local targets = BB_LOGGER.format_playing_cards(G.hand.cards, args.cards)
      sendDebugMessage(string.format("Using '%s' on: %s", cons_name, targets), "BB.ENDPOINTS")
    else
      sendDebugMessage(string.format("Using '%s' (no targets)", cons_name), "BB.ENDPOINTS")
    end

    -- Balatro is the final authority here.  In particular, Aura rejects a
    -- target which already has an edition, even after the RPC-level arity and
    -- index checks above have passed.
    if not consumable_card:can_use_consumeable() then
      send_response({
        message = "Consumable '" .. consumable_card.ability.name .. "' cannot be used at this time",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end
    if consumable_card:check_use() then
      send_response({
        message = "Cannot use consumable '" .. consumable_card.ability.name .. "': insufficient space",
        name = BB_ERROR_NAMES.NOT_ALLOWED,
      })
      return
    end

    G.FUNCS.use_card({ config = { ref_table = consumable_card } }, true, true)

    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      func = function()
        local state_restored = G.STATE == G.STATES.SELECTING_HAND or G.STATE == G.STATES.SHOP
        local controller_unlocked = not G.CONTROLLER.locks.use
        local no_stop_use = not (G.GAME.STOP_USE and G.GAME.STOP_USE > 0)
        if state_restored and controller_unlocked and no_stop_use then
          sendDebugMessage("Return use()", "BB.ENDPOINTS")
          send_response(BB_GAMESTATE.get_gamestate())
          return true
        end
        return false
      end,
    }))
  end,
}
