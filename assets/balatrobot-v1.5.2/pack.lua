-- Balatro Pilot replacement for BalatroBot v1.5.2 pack endpoint.
--
-- The upstream endpoint inferred whether to wait for a hand from the first
-- offer in the pack. Mixed Celestial packs may put Black Hole first, which
-- incorrectly makes a later Jupiter/Neptune selection wait forever for a
-- hand that a Celestial pack never deals. Hand readiness is instead derived
-- from the selected card and the concrete targets supplied for that action.

---@type BB_LOGGER
local BB_LOGGER = assert(SMODS.load_file("src/lua/utils/logger.lua"))()

---@class Request.Endpoint.Pack.Params
---@field card integer? 0-based index of card to select from pack
---@field targets integer[]? 0-based indices of hand cards to target
---@field skip boolean? Skip pack selection

--- @param card_key string
--- @return table|nil
local function get_consumable_target_requirements(card_key)
  if card_key == "c_aura" then
    return { min = 1, max = 1 }
  end
  if card_key == "c_ankh" then
    return { requires_joker = true }
  end

  local center = G.P_CENTERS[card_key]
  if not center or not center.config then
    return nil
  end
  local config = center.config
  if config.max_highlighted then
    return {
      min = config.min_highlighted or 1,
      max = config.max_highlighted,
    }
  end
  return nil
end

---@type Endpoint
return {
  name = "pack",
  description = "Select or skip a card from an opened booster pack",
  schema = {
    card = {
      type = "integer",
      required = false,
      description = "0-based index of card to select from pack",
    },
    targets = {
      type = "array",
      items = "integer",
      required = false,
      description = "0-based indices of hand cards to target (for consumables requiring targets)",
    },
    skip = {
      type = "boolean",
      required = false,
      description = "Skip pack selection",
    },
  },
  requires_state = { G.STATES.SMODS_BOOSTER_OPENED },

  ---@param args Request.Endpoint.Pack.Params
  ---@param send_response fun(response: Response.Endpoint)
  execute = function(args, send_response)
    sendDebugMessage("Init pack()", "BB.ENDPOINTS")

    local set = 0
    if args.card ~= nil then set = set + 1 end
    if args.skip then set = set + 1 end
    if set == 0 then
      send_response({
        message = "Invalid arguments. You must provide one of: card, skip",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end
    if set > 1 then
      send_response({
        message = "Invalid arguments. Cannot provide both card and skip",
        name = BB_ERROR_NAMES.BAD_REQUEST,
      })
      return
    end

    if not G.pack_cards or G.pack_cards.REMOVED then
      send_response({
        message = "No pack is currently open",
        name = BB_ERROR_NAMES.INVALID_STATE,
      })
      return
    end

    local function select_card()
      local pos = args.card + 1
      if not G.pack_cards.cards[pos] then
        local pack_count = G.pack_cards.config and G.pack_cards.config.card_count or 0
        send_response({
          message = "Card index out of range. Index: " .. args.card .. ", Available cards: " .. pack_count,
          name = BB_ERROR_NAMES.BAD_REQUEST,
        })
        return true
      end

      local card = G.pack_cards.cards[pos]
      local card_key = card.config and card.config.center and card.config.center.key
      if card.ability and card.ability.set == "Joker" then
        local joker_count = G.jokers and G.jokers.config and G.jokers.config.card_count or 0
        local joker_limit = G.jokers and G.jokers.config and G.jokers.config.card_limit or 0
        if joker_count >= joker_limit then
          send_response({
            message = "Cannot select joker, joker slots are full. Current: "
              .. joker_count .. ", Limit: " .. joker_limit,
            name = BB_ERROR_NAMES.NOT_ALLOWED,
          })
          return true
        end
      end

      if card_key then
        local req = get_consumable_target_requirements(card_key)
        if req then
          if req.requires_joker then
            local joker_count = G.jokers and G.jokers.config and G.jokers.config.card_count or 0
            if joker_count == 0 then
              send_response({
                message = string.format("Card '%s' requires at least 1 joker. Current: %d", card_key, joker_count),
                name = BB_ERROR_NAMES.NOT_ALLOWED,
              })
              return true
            end
          end

          local target_count = args.targets and #args.targets or 0
          if req.min and req.max and (target_count < req.min or target_count > req.max) then
            local msg
            if req.min == req.max then
              msg = string.format("Card '%s' requires exactly %d target card(s). Provided: %d", card_key, req.min, target_count)
            else
              msg = string.format("Card '%s' requires %d-%d target card(s). Provided: %d", card_key, req.min, req.max, target_count)
            end
            send_response({ message = msg, name = BB_ERROR_NAMES.BAD_REQUEST })
            return true
          end

          if args.targets and #args.targets > 0 then
            for i = #G.hand.highlighted, 1, -1 do
              G.hand:remove_from_highlighted(G.hand.highlighted[i], true)
            end
            for _, target_idx in ipairs(args.targets) do
              local hand_pos = target_idx + 1
              if not G.hand.cards[hand_pos] then
                send_response({
                  message = "Target card index out of range. Index: " .. target_idx .. ", Hand size: " .. #G.hand.cards,
                  name = BB_ERROR_NAMES.BAD_REQUEST,
                })
                return true
              end
              G.hand:add_to_highlighted(G.hand.cards[hand_pos], true)
            end
          end
        end
      end

      local card_name = card.ability and card.ability.name or "Unknown"
      local card_set = card.ability and card.ability.set or card.set or "card"
      if args.targets and #args.targets > 0 then
        local targets = BB_LOGGER.format_playing_cards(G.hand.cards, args.targets)
        sendDebugMessage(string.format("Pack: selecting %s '%s' targeting: %s", card_set, card_name, targets), "BB.ENDPOINTS")
      else
        sendDebugMessage(string.format("Pack: selecting %s '%s'", card_set, card_name), "BB.ENDPOINTS")
      end

      local btn = { config = { ref_table = card } }
      local pack_choices_before = G.GAME.pack_choices or 0
      G.FUNCS.use_card(btn)

      G.E_MANAGER:add_event(Event({
        trigger = "condition",
        blocking = false,
        func = function()
          if pack_choices_before == 2 and G.GAME.pack_choices and G.GAME.pack_choices == 1 then
            local pack_stable = G.pack_cards
              and not G.pack_cards.REMOVED
              and G.STATE_COMPLETE
              and G.STATE == G.STATES.SMODS_BOOSTER_OPENED
            if pack_stable then
              sendDebugMessage("Return pack() after selection (more choices remain)", "BB.ENDPOINTS")
              send_response(BB_GAMESTATE.get_gamestate())
              return true
            end
          else
            local pack_closed = not G.pack_cards or G.pack_cards.REMOVED
            local back_to_shop = G.STATE == G.STATES.SHOP
            if pack_closed and back_to_shop then
              sendDebugMessage("Return pack() after selection", "BB.ENDPOINTS")
              send_response(BB_GAMESTATE.get_gamestate())
              return true
            end
          end
          return false
        end,
      }))
      return true
    end

    if args.skip then
      local pack_count = G.pack_cards.config and G.pack_cards.config.card_count or 0
      sendDebugMessage(string.format("Pack: skipping (%d cards remaining)", pack_count), "BB.ENDPOINTS")
      G.FUNCS.skip_booster({})
      G.E_MANAGER:add_event(Event({
        trigger = "condition",
        blocking = false,
        func = function()
          local pack_closed = not G.pack_cards or G.pack_cards.REMOVED
          local back_to_shop = G.STATE == G.STATES.SHOP
          if pack_closed and back_to_shop then
            sendDebugMessage("Return pack() after skip", "BB.ENDPOINTS")
            send_response(BB_GAMESTATE.get_gamestate())
            return true
          end
          return false
        end,
      }))
      return
    end

    -- Decide readiness from the selected offer and this request, never from
    -- cards[1] or a broad pack category. A real hand wait is needed only when
    -- the selected consumable declares hand-card requirements and the caller
    -- supplied concrete hand targets to satisfy them.
    local selected_card = G.pack_cards.cards[args.card + 1]
    local selected_key = selected_card
      and selected_card.config
      and selected_card.config.center
      and selected_card.config.center.key
    local selected_requirements = selected_key and get_consumable_target_requirements(selected_key) or nil
    local target_count = args.targets and #args.targets or 0
    local needs_hand = selected_requirements
      and selected_requirements.min
      and selected_requirements.max
      and target_count > 0

    if not needs_hand then
      select_card()
      return
    end

    local selection_executed = false
    G.E_MANAGER:add_event(Event({
      trigger = "condition",
      blocking = false,
      func = function()
        if not G.STATE_COMPLETE then return false end

        local hand_limit = G.hand and G.hand.config and G.hand.config.card_limit or 8
        local deck_size = G.deck and G.deck.config and G.deck.config.card_count or 52
        local expected_hand_size = math.min(deck_size, hand_limit)
        local min_required = 1
        for _, target_idx in ipairs(args.targets) do
          min_required = math.max(min_required, target_idx + 1)
        end

        local hand_ready = G.hand
          and not G.hand.REMOVED
          and G.hand.cards
          and (#G.hand.cards >= expected_hand_size or #G.hand.cards >= min_required)
          and G.hand.T
          and G.hand.T.x
        local cards_positioned = hand_ready
          and G.hand.cards[1]
          and G.hand.cards[1].T
          and G.hand.cards[1].T.x
        if not hand_ready or not cards_positioned then return false end

        for _, target_idx in ipairs(args.targets) do
          local hand_pos = target_idx + 1
          if not G.hand.cards[hand_pos] then
            send_response({
              message = "Target card index out of range. Index: " .. target_idx .. ", Hand size: " .. #G.hand.cards,
              name = BB_ERROR_NAMES.BAD_REQUEST,
            })
            return true
          end
        end

        if not selection_executed then
          selection_executed = true
          return select_card()
        end
        return false
      end,
    }))
  end,
}
