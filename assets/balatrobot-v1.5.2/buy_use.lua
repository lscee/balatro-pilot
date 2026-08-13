-- Balatro Pilot exact Buy & Use endpoint for BalatroBot v1.5.2.
--
-- This deliberately delegates the irreversible purchase/use transition to
-- Balatro's native buy_and_use callback after rechecking the current shop
-- card, price, exact target contract, and card-specific native legality.

---@type BB_LOGGER
local BB_LOGGER = assert(SMODS.load_file("src/lua/utils/logger.lua"))()

local function target_requirements(card)
  local center_key = card.config
    and (card.config.center_key or (card.config.center and card.config.center.key))
  if center_key == "c_aura" then return { required = true, min = 1, max = 1 } end
  local config = card.ability and card.ability.consumeable or {}
  if config.max_highlighted ~= nil then
    return { required = true, min = config.min_highlighted or 1, max = config.max_highlighted }
  end
  return { required = false, min = 0, max = 0 }
end

local function clear_highlights()
  if not G.hand or not G.hand.highlighted then return end
  for i = #G.hand.highlighted, 1, -1 do
    G.hand:remove_from_highlighted(G.hand.highlighted[i], true)
  end
end

local function shop_contains(card)
  if not G.shop_jokers or not G.shop_jokers.cards then return false end
  for _, offered in ipairs(G.shop_jokers.cards) do
    if offered == card then return true end
  end
  return false
end

---@type Endpoint
return {
  name = "buy_use",
  description = "Buy and immediately use the exact consumable currently offered in the shop",
  schema = {
    card = { type = "integer", required = true, description = "0-based shop-card index" },
    targets = {
      type = "array",
      required = false,
      items = "integer",
      description = "0-based hand-card indices required by a targeted consumable",
    },
  },
  requires_state = { G.STATES.SHOP },

  execute = function(args, send_response)
    sendDebugMessage("Init buy_use()", "BB.ENDPOINTS")
    if not G.shop_jokers or not G.shop_jokers.cards
      or args.card < 0 or args.card >= #G.shop_jokers.cards then
      send_response({ message = "Shop card index out of range: " .. tostring(args.card), name = BB_ERROR_NAMES.BAD_REQUEST })
      return
    end

    local card = G.shop_jokers.cards[args.card + 1]
    local set = card.ability and card.ability.set
    if not card.ability or not card.ability.consumeable
      or (set ~= "Tarot" and set ~= "Planet" and set ~= "Spectral") then
      send_response({ message = "Shop card is not a consumable that can be bought and used", name = BB_ERROR_NAMES.NOT_ALLOWED })
      return
    end

    local game = G.GAME or {}
    local available = (game.dollars or 0) - (game.bankrupt_at or 0)
    local price = card.cost or 0
    if available < price then
      send_response({ message = string.format("Consumable costs $%d, but only $%d is available", price, available), name = BB_ERROR_NAMES.NOT_ALLOWED })
      return
    end

    local req = target_requirements(card)
    local targets = args.targets or {}
    if req.required and (#targets < req.min or #targets > req.max) then
      send_response({
        message = string.format("Consumable requires %d-%d target card(s); provided: %d", req.min, req.max, #targets),
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end
    if not req.required and #targets > 0 then
      send_response({ message = "This consumable does not accept target cards", name = BB_ERROR_NAMES.BAD_REQUEST })
      return
    end

    local seen = {}
    for _, target in ipairs(targets) do
      if seen[target] or not G.hand or not G.hand.cards or target < 0 or target >= #G.hand.cards then
        send_response({ message = "Invalid or duplicate target card index: " .. tostring(target), name = BB_ERROR_NAMES.BAD_REQUEST })
        return
      end
      seen[target] = true
    end

    clear_highlights()
    for _, target in ipairs(targets) do
      G.hand:add_to_highlighted(G.hand.cards[target + 1], true)
    end

    -- The game remains the final authority for effects whose legality depends
    -- on current slots, Jokers, hand contents, or a card-specific restriction.
    if not card:can_use_consumeable() then
      clear_highlights()
      send_response({ message = "Consumable cannot be bought and used in the current state", name = BB_ERROR_NAMES.NOT_ALLOWED })
      return
    end
    if card:check_use() then
      clear_highlights()
      send_response({ message = "Consumable cannot be used because its result has insufficient space", name = BB_ERROR_NAMES.NOT_ALLOWED })
      return
    end

    local card_name = card.ability.name or "Unknown"
    sendDebugMessage(string.format("Buy & Use '%s' at shop index %d", card_name, args.card), "BB.ENDPOINTS")
    G.FUNCS.buy_from_shop({ config = { id = "buy_and_use", ref_table = card } })

    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      func = function()
        local state_restored = G.STATE == G.STATES.SHOP
        local controller_unlocked = not G.CONTROLLER.locks.use
        local no_stop_use = not (G.GAME.STOP_USE and G.GAME.STOP_USE > 0)
        if state_restored and controller_unlocked and no_stop_use and not shop_contains(card) then
          sendDebugMessage("Return buy_use()", "BB.ENDPOINTS")
          send_response(BB_GAMESTATE.get_gamestate())
          return true
        end
        return false
      end,
    }))
  end,
}
