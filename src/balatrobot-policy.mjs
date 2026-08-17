import { createHash } from "node:crypto";
import {
  balatrobotIsScoringJoker,
  balatrobotHighScoreBuildProfile,
  balatrobotJokerOrderAction,
  balatrobotScoringJokerCount,
  balatrobotSurvivalAssessment,
  generateBalatrobotCandidates,
} from "./balatrobot-solver.mjs";
import {
  BALATRO_HAND_STRENGTH,
  balatroCardRank,
  balatroJokerDebuffed,
  balatroRankNumber,
  classifyBalatroHand,
  validateBalatroConsumableTargets,
} from "./balatro-rules-engine.mjs";

export const BALATROBOT_STATES = Object.freeze({
  MENU: "MENU",
  BLIND_SELECT: "BLIND_SELECT",
  SELECTING_HAND: "SELECTING_HAND",
  ROUND_EVAL: "ROUND_EVAL",
  SHOP: "SHOP",
  PACK: "SMODS_BOOSTER_OPENED",
  GAME_OVER: "GAME_OVER",
});

export function balatrobotMenuReady(state) {
  if (state?.state !== BALATROBOT_STATES.MENU) return false;
  if (typeof state.menuReady === "boolean") return state.menuReady;
  return state.menu_ready === true;
}

export function balatrobotHandActionsReady(state) {
  if (state?.state !== BALATROBOT_STATES.SELECTING_HAND) return null;
  if (typeof state.handActionsReady === "boolean") return state.handActionsReady;
  if (typeof state.hand_actions_ready === "boolean") return state.hand_actions_ready;
  // Older BalatroBot builds do not expose readiness. Keep those builds
  // compatible instead of treating an absent capability as a permanent lock.
  return null;
}

const ACTION_FIELDS = new Set([
  "method",
  "cards",
  "card",
  "voucher",
  "pack",
  "joker",
  "consumable",
  "targets",
  "skip",
  "hand",
  "jokers",
  "consumables",
  "reason",
  "params",
]);

const METHODS_BY_STATE = Object.freeze({
  BLIND_SELECT: new Set(["select", "skip", "reroll_boss"]),
  SELECTING_HAND: new Set(["play", "discard", "sell", "use", "rearrange"]),
  SHOP: new Set(["buy", "buy_use", "sell", "reroll", "next_round", "use", "rearrange"]),
  SMODS_BOOSTER_OPENED: new Set(["pack", "rearrange"]),
});
const CONSUMABLE_SETS = new Set(["TAROT", "PLANET", "SPECTRAL"]);
const GENERIC_CARD_TOKENS = new Set(["the", "and", "joker", "card", "tarot", "planet", "spectral"]);
const VANILLA_STAKE_ORDER = Object.freeze([
  "WHITE",
  "RED",
  "GREEN",
  "BLACK",
  "BLUE",
  "PURPLE",
  "ORANGE",
  "GOLD",
]);

const EMPTY_ACTION = Object.freeze({
  cards: [],
  card: null,
  voucher: null,
  pack: null,
  joker: null,
  consumable: null,
  targets: [],
  skip: null,
  hand: [],
  jokers: [],
  consumables: [],
});

function areaCards(area) {
  return Array.isArray(area?.cards) ? area.cards : [];
}

function areaOccupancy(area) {
  const visible = areaCards(area).length;
  const reported = Number(area?.count);
  return Math.max(visible, Number.isFinite(reported) && reported >= 0 ? reported : 0);
}

function firstFinite(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function canonicalStakeName(value) {
  const name = String(value?.key ?? value?.name ?? value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^STAKE_/, "")
    .replace(/(?:_|\s+)STAKE$/, "");
  return VANILLA_STAKE_ORDER.includes(name) ? name : "";
}

/**
 * Normalize the exact Mod-provided run rules while keeping old BalatroBot
 * builds useful. The fallback is deliberately limited to the installed
 * vanilla 1.0.1o Stake chain; explicit runtime values always win.
 */
export function balatrobotStakeRules(state) {
  const raw = state?.stakeRules ?? state?.stake_rules ?? state?.runModifiers ?? state?.run_modifiers ?? {};
  const stake = canonicalStakeName(raw.stake ?? state?.stake);
  const stakeIndex = VANILLA_STAKE_ORDER.indexOf(stake);
  const inferredApplied = stakeIndex >= 0 ? VANILLA_STAKE_ORDER.slice(0, stakeIndex + 1) : [];
  const suppliedApplied = raw.appliedStakes ?? raw.applied_stakes;
  const appliedStakes = Array.isArray(suppliedApplied)
    ? suppliedApplied.map(canonicalStakeName).filter(Boolean)
    : inferredApplied;
  const applied = new Set(appliedStakes);
  const smallBlindReward = firstFinite(raw.smallBlindReward, raw.small_blind_reward);
  const smallBlindBaseReward = firstFinite(raw.smallBlindBaseReward, raw.small_blind_base_reward);
  const scalingTier = firstFinite(raw.scalingTier, raw.scaling_tier, raw.scaling);
  const discardModifier = firstFinite(raw.discardModifier, raw.discard_modifier, raw.discardsDelta, raw.discards_delta);
  const rentalRate = firstFinite(raw.rentalRate, raw.rental_rate);
  const perishableRounds = firstFinite(raw.perishableRounds, raw.perishable_rounds);
  const anteScaling = firstFinite(raw.anteScaling, raw.ante_scaling);
  const normalized = {
    stake: stake || String(state?.stake ?? raw.stake ?? ""),
    stakeLevel: firstFinite(raw.stakeLevel, raw.stake_level) ?? (stakeIndex >= 0 ? stakeIndex + 1 : null),
    appliedStakes,
    smallBlindBaseReward: smallBlindBaseReward ?? 3,
    smallBlindReward: smallBlindReward ?? (applied.has("RED") ? 0 : 3),
    noSmallBlindReward: raw.noSmallBlindReward === true || raw.no_small_blind_reward === true || applied.has("RED"),
    scalingTier: scalingTier ?? (applied.has("PURPLE") ? 3 : applied.has("GREEN") ? 2 : 1),
    anteScaling,
    baseDiscards: firstFinite(raw.baseDiscards, raw.base_discards, raw.vanillaBaseDiscards, raw.vanilla_base_discards),
    preStakeDiscards: firstFinite(raw.preStakeDiscards, raw.pre_stake_discards),
    actualDiscards: firstFinite(
      raw.actualDiscards,
      raw.actual_discards,
      raw.startingDiscards,
      raw.starting_discards,
    ),
    discardModifier: discardModifier ?? (applied.has("BLUE") ? -1 : 0),
    stakeDiscardPenalty: firstFinite(raw.stakeDiscardPenalty, raw.stake_discard_penalty) ?? (applied.has("BLUE") ? 1 : 0),
    eternalStickers: raw.eternalStickers === true || raw.eternal_stickers === true || applied.has("BLACK"),
    perishableStickers: raw.perishableStickers === true || raw.perishable_stickers === true || applied.has("ORANGE"),
    rentalStickers: raw.rentalStickers === true || raw.rental_stickers === true || applied.has("GOLD"),
    perishableRounds: perishableRounds ?? 5,
    rentalRate: rentalRate ?? 3,
  };
  normalized.signature = [
    normalized.appliedStakes.join(">"),
    `small=${normalized.smallBlindReward}`,
    `scale=${normalized.scalingTier}`,
    `discard=${normalized.discardModifier}`,
    `eternal=${Number(normalized.eternalStickers)}`,
    `perishable=${Number(normalized.perishableStickers)}:${normalized.perishableRounds}`,
    `rental=${Number(normalized.rentalStickers)}:${normalized.rentalRate}`,
  ].join("|");
  return normalized;
}

export function balatrobotStickerEconomy(state) {
  const rules = balatrobotStakeRules(state);
  const jokers = areaCards(state?.jokers);
  const rentals = jokers.filter((joker) => Boolean(joker?.modifier?.rental ?? joker?.rental));
  const perishable = jokers.filter((joker) => {
    const modifier = joker?.modifier ?? joker ?? {};
    return modifier.isPerishable === true || modifier.is_perishable === true ||
      (modifier.perishable !== undefined && modifier.perishable !== null && modifier.perishable !== false);
  });
  const expiredPerishables = perishable.filter((joker) => {
    const modifier = joker?.modifier ?? joker ?? {};
    const tally = firstFinite(modifier.perishableTally, modifier.perishable_tally, modifier.perishable);
    return tally !== null && tally <= 0 || Boolean(joker?.state?.debuff ?? joker?.debuff);
  });
  const eternalLockedSlots = jokers.filter((joker) => Boolean(joker?.modifier?.eternal ?? joker?.eternal)).length;
  const rentalRate = Math.max(0, rules.rentalRate ?? 3);
  const rentalUpkeep = rentals.length * rentalRate;
  const money = firstFinite(state?.money) ?? 0;
  const activeCredit = jokers.reduce((total, joker) =>
    total + (joker?.key === "j_credit_card" && !balatroJokerDebuffed(joker) ? 20 : 0), 0);
  return {
    rentalCount: rentals.length,
    rentalRate,
    rentalUpkeep,
    twoBlindUpkeep: rentalUpkeep * 2,
    perishableCount: perishable.length,
    expiredPerishableCount: expiredPerishables.length,
    eternalLockedSlots,
    money,
    activeCredit,
    legalLiquidity: money + activeCredit,
    cashAfterNextUpkeep: money - rentalUpkeep,
  };
}

function compactCard(card, index) {
  if (!card || typeof card !== "object") return { index, label: "unknown" };
  const value = card.value && typeof card.value === "object" ? card.value : {};
  const modifier = card.modifier && typeof card.modifier === "object" ? card.modifier : {};
  const cardState = card.state && typeof card.state === "object" ? card.state : {};
  const cost = card.cost && typeof card.cost === "object" ? card.cost : {};
  return {
    index,
    id: Number.isInteger(card.id) ? card.id : null,
    key: typeof card.key === "string" ? card.key : "",
    set: typeof card.set === "string" ? card.set : "",
    label: typeof card.label === "string" ? card.label : "",
    rank: value.rank ?? null,
    suit: value.suit ?? null,
    effect: typeof value.effect === "string" ? value.effect : "",
    enhancement: modifier.enhancement ?? null,
    edition: modifier.edition ?? null,
    seal: modifier.seal ?? null,
    eternal: Boolean(modifier.eternal),
    isPerishable: modifier.isPerishable === true || modifier.is_perishable === true ||
      (modifier.perishable !== undefined && modifier.perishable !== null && modifier.perishable !== false),
    perishable: modifier.perishable ?? null,
    perishableTally: Number.isFinite(Number(modifier.perishableTally ?? modifier.perishable_tally ?? modifier.perishable))
      ? Number(modifier.perishableTally ?? modifier.perishable_tally ?? modifier.perishable)
      : null,
    perishableRounds: Number.isFinite(Number(modifier.perishable_rounds ?? modifier.perishableRounds))
      ? Number(modifier.perishable_rounds ?? modifier.perishableRounds)
      : null,
    rental: Boolean(modifier.rental),
    rentalRate: Number.isFinite(Number(modifier.rental_rate ?? modifier.rentalRate))
      ? Number(modifier.rental_rate ?? modifier.rentalRate)
      : null,
    debuff: Boolean(cardState.debuff),
    hidden: Boolean(cardState.hidden),
    highlight: Boolean(cardState.highlight),
    buy: Number.isFinite(cost.buy) ? cost.buy : null,
    sell: Number.isFinite(cost.sell) ? cost.sell : null,
  };
}

function compactArea(area, { fullCards = true } = {}) {
  if (!area || typeof area !== "object") return null;
  const cards = areaCards(area);
  return {
    count: Number.isInteger(area.count) ? area.count : cards.length,
    limit: Number.isInteger(area.limit) ? area.limit : null,
    highlightedLimit: Number.isInteger(area.highlighted_limit) ? area.highlighted_limit : null,
    cards: fullCards ? cards.map(compactCard) : [],
  };
}

function compactHands(hands) {
  if (!hands || typeof hands !== "object") return {};
  return Object.fromEntries(
    Object.entries(hands).map(([name, hand]) => [
      name,
      {
        level: hand?.level ?? null,
        chips: hand?.chips ?? null,
        mult: hand?.mult ?? null,
        played: hand?.played ?? null,
        playedThisRound: hand?.played_this_round ?? null,
      },
    ]),
  );
}

function compactBlind(blind) {
  if (!blind || typeof blind !== "object") return null;
  return {
    type: blind.type ?? null,
    status: blind.status ?? null,
    name: blind.name ?? "",
    effect: blind.effect ?? "",
    score: blind.score ?? null,
    reward: firstFinite(blind.reward, blind.dollars, blind.money),
    noReward: blind.noReward === true || blind.no_reward === true,
    tagName: blind.tag_name ?? null,
    tagEffect: blind.tag_effect ?? null,
  };
}

function deckInventory(area) {
  const cards = areaCards(area);
  return {
    count: Number.isInteger(area?.count) ? area.count : cards.length,
    cards: cards.map((card, index) => {
      const compact = compactCard(card, index);
      return {
        index,
        key: compact.key,
        rank: compact.rank,
        suit: compact.suit,
        enhancement: compact.enhancement,
        edition: compact.edition,
        seal: compact.seal,
        debuff: compact.debuff,
        hidden: compact.hidden,
      };
    }),
  };
}

export function compactBalatrobotState(state) {
  if (!state || typeof state !== "object" || typeof state.state !== "string") {
    throw new Error("BalatroBot gamestate must be an object with a state string");
  }
  const round = state.round && typeof state.round === "object" ? state.round : {};
  const highScoreTraining = balatrobotHighScoreBuildProfile(state);
  return {
    state: state.state,
    ...(state.state === BALATROBOT_STATES.MENU
      ? {
          menuReady: typeof state.menuReady === "boolean"
            ? state.menuReady
            : (typeof state.menu_ready === "boolean" ? state.menu_ready : null),
        }
      : {}),
    ...(state.state === BALATROBOT_STATES.SELECTING_HAND
      ? { handActionsReady: balatrobotHandActionsReady(state) }
      : {}),
    ante: state.ante_num ?? null,
    roundNumber: state.round_num ?? null,
    money: state.money ?? null,
    won: state.won ?? null,
    deck: state.deck ?? null,
    stake: state.stake ?? null,
    stakeRules: balatrobotStakeRules(state),
    stickerEconomy: balatrobotStickerEconomy(state),
    seed: state.seed ?? null,
    bossRerolled: Boolean(state.boss_rerolled),
    lastTarotPlanet: typeof state.last_tarot_planet === "string" ? state.last_tarot_planet : null,
    ectoMinus: Number.isInteger(state.ecto_minus) && state.ecto_minus > 0 ? state.ecto_minus : null,
    round: {
      chips: round.chips ?? null,
      handsLeft: round.hands_left ?? null,
      handsPlayed: round.hands_played ?? null,
      discardsLeft: round.discards_left ?? null,
      discardsUsed: round.discards_used ?? null,
      rerollCost: round.reroll_cost ?? null,
    },
    blinds: {
      small: compactBlind(state.blinds?.small),
      big: compactBlind(state.blinds?.big),
      boss: compactBlind(state.blinds?.boss),
    },
    pokerHands: compactHands(state.hands),
    jokers: compactArea(state.jokers),
    consumables: compactArea(state.consumables),
    hand: compactArea(state.hand),
    remainingDeck: deckInventory(state.cards),
    shop: compactArea(state.shop),
    vouchers: compactArea(state.vouchers),
    packs: compactArea(state.packs),
    openedPack: compactArea(state.pack),
    usedVouchers: state.used_vouchers && typeof state.used_vouchers === "object" ? state.used_vouchers : {},
    shopReroll: state.state === BALATROBOT_STATES.SHOP ? balatrobotShopRerollBudget(state) : null,
    highScoreTraining,
  };
}

export function balatrobotStateFingerprint(state) {
  return createHash("sha256").update(JSON.stringify(compactBalatrobotState(state))).digest("hex");
}

function asIndex(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function uniqueIndices(value, label, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length < min || value.length > max) throw new Error(`${label} must contain ${min}..${max} indices`);
  const result = value.map((item, index) => asIndex(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicate indices`);
  return result;
}

function assertAreaIndex(state, areaName, index, label = areaName) {
  const cards = areaCards(state?.[areaName]);
  if (index >= cards.length) throw new Error(`${label} index ${index} is outside 0..${Math.max(0, cards.length - 1)}`);
  return cards[index];
}

function assertIndicesInArea(state, areaName, indices, label) {
  const count = areaCards(state?.[areaName]).length;
  for (const index of indices) {
    if (index >= count) throw new Error(`${label} index ${index} is outside 0..${Math.max(0, count - 1)}`);
  }
}

function availableMoney(state) {
  return balatrobotStickerEconomy(state).legalLiquidity;
}

function actionNamesCard(card, text) {
  const normalizedText = String(text ?? "").toLowerCase().replaceAll("_", " ");
  const identities = [card?.label, String(card?.key ?? "").replace(/^j_|^c_|^p_|^v_/iu, "")]
    .map((value) => String(value ?? "").trim().toLowerCase().replaceAll("_", " "))
    .filter(Boolean);
  if (identities.some((identity) => normalizedText.includes(identity))) return true;
  const distinctive = identities
    .flatMap((identity) => identity.split(/[^\p{L}\p{N}]+/u))
    .filter((token) => token.length >= 3 && !GENERIC_CARD_TOKENS.has(token));
  return distinctive.some((token) => normalizedText.includes(token));
}

function paramsFromAction(candidate) {
  const nested = candidate.params && typeof candidate.params === "object" && !Array.isArray(candidate.params)
    ? candidate.params
    : {};
  return {
    ...EMPTY_ACTION,
    ...nested,
    ...Object.fromEntries(
      Object.entries(candidate).filter(([key, value]) => key in EMPTY_ACTION && value !== undefined),
    ),
  };
}

function assertNoParams(params, method) {
  const populated = Object.entries(params).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : value !== null && value !== false,
  );
  if (populated.length) throw new Error(`${method} does not accept action parameters`);
}

function rpcParams(method, params, state) {
  switch (method) {
    case "select":
    case "reroll_boss":
    case "next_round":
      assertNoParams(params, method);
      if (method === "reroll_boss") {
        const vouchers = state.used_vouchers && typeof state.used_vouchers === "object"
          ? state.used_vouchers
          : {};
        const hasRetcon = Object.hasOwn(vouchers, "v_retcon");
        const hasDirectorsCut = Object.hasOwn(vouchers, "v_directors_cut");
        if (!hasRetcon && !hasDirectorsCut) {
          throw new Error("Boss reroll requires Director's Cut or Retcon");
        }
        if (!hasRetcon && state.boss_rerolled === true) {
          throw new Error("Director's Cut has already rerolled this Ante's Boss Blind");
        }
        if (availableMoney(state) < 10) {
          throw new Error(`Boss reroll costs $10, but only $${availableMoney(state)} is available`);
        }
      }
      return {};
    case "skip": {
      assertNoParams(params, method);
      if (String(activeBlind(state)?.type ?? "").toUpperCase() === "BOSS") {
        throw new Error("cannot skip the Boss Blind");
      }
      return {};
    }
    case "reroll": {
      assertNoParams(params, method);
      const cost = Number(state.round?.reroll_cost);
      // Credit Card liquidity is reserved for an exact lifesaving purchase or
      // Boss reroll. A speculative paid shop reroll must be funded by cash;
      // native $0 rerolls remain legal even while the balance is negative.
      const cash = Math.max(0, Number.isFinite(Number(state?.money)) ? Number(state.money) : 0);
      if (Number.isFinite(cost) && cost > 0 && cost > cash) {
        throw new Error(`reroll costs $${cost}, but only $${cash} cash is available`);
      }
      return {};
    }
    case "play": {
      if (balatrobotHandActionsReady(state) === false) {
        throw new Error("play is temporarily unavailable because native hand actions are not ready");
      }
      const configuredLimit = Number(state.hand?.highlighted_limit);
      const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 5;
      const cards = uniqueIndices(params.cards, "play.cards", { min: 1, max: limit });
      assertIndicesInArea(state, "hand", cards, "play.cards");
      if (String(activeBlind(state)?.name ?? "").trim().toLowerCase() === "the psychic" && cards.length !== 5) {
        throw new Error("The Psychic requires exactly 5 played cards");
      }
      return { cards };
    }
    case "discard": {
      if (balatrobotHandActionsReady(state) === false) {
        throw new Error("discard is temporarily unavailable because native hand actions are not ready");
      }
      const limit = Math.min(5, Number(state.hand?.highlighted_limit) || 5);
      const cards = uniqueIndices(params.cards, "discard.cards", { min: 1, max: limit });
      assertIndicesInArea(state, "hand", cards, "discard.cards");
      if (Number.isFinite(state.round?.discards_left) && state.round.discards_left <= 0) {
        throw new Error("discard is unavailable because no discards remain");
      }
      return { cards };
    }
    case "buy": {
      const choices = ["card", "voucher", "pack"].filter((name) => params[name] !== null);
      if (choices.length !== 1) throw new Error("buy requires exactly one of card, voucher, or pack");
      const choice = choices[0];
      const index = asIndex(params[choice], `buy.${choice}`);
      const areaName = choice === "card" ? "shop" : choice === "voucher" ? "vouchers" : "packs";
      const card = assertAreaIndex(state, areaName, index, `buy.${choice}`);
      const price = card?.cost?.buy;
      const money = availableMoney(state);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(money) && price > money) {
        throw new Error(`buy.${choice} costs $${price}, but only $${money} is available`);
      }
      if (choice === "card") {
        const set = String(card?.set ?? "").toUpperCase();
        // BalatroBot v1.5.2 rejects full-slot purchases even for Negative cards (upstream #208).
        // Match the stable server contract here so the planner does not enter an RPC retry loop.
        if (set === "JOKER" && areaOccupancy(state.jokers) >= state.jokers?.limit) {
          throw new Error("cannot buy this Joker while Joker slots are full; sell first or choose another action");
        }
        if (CONSUMABLE_SETS.has(set) && areaOccupancy(state.consumables) >= state.consumables?.limit) {
          throw new Error("cannot buy this consumable while consumable slots are full; use/sell first or choose another action");
        }
      }
      return { [choice]: index };
    }
    case "buy_use": {
      const card = asIndex(params.card, "buy_use.card");
      const offeredCard = assertAreaIndex(state, "shop", card, "buy_use.card");
      const set = String(offeredCard?.set ?? "").toUpperCase();
      if (!CONSUMABLE_SETS.has(set)) {
        throw new Error("buy_use.card must be a Tarot, Planet, or Spectral consumable");
      }
      const price = offeredCard?.cost?.buy;
      const money = availableMoney(state);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(money) && price > money) {
        throw new Error(`buy_use.card costs $${price}, but only $${money} is available`);
      }
      const targets = uniqueIndices(params.targets, "buy_use.targets", { min: 0, max: 5 });
      assertIndicesInArea(state, "hand", targets, "buy_use.targets");
      validateBalatroConsumableTargets(offeredCard, targets, state, "buy_use.card");
      if (String(offeredCard?.key ?? "").toLowerCase() === "c_aura" &&
          targets.some((index) => state.hand?.cards?.[index]?.modifier?.edition)) {
        throw new Error("Aura requires one playing card without an existing edition");
      }
      return targets.length ? { card, targets } : { card };
    }
    case "sell": {
      const choices = ["joker", "consumable"].filter((name) => params[name] !== null);
      if (choices.length !== 1) throw new Error("sell requires exactly one of joker or consumable");
      const choice = choices[0];
      const index = asIndex(params[choice], `sell.${choice}`);
      const card = assertAreaIndex(state, choice === "joker" ? "jokers" : "consumables", index, `sell.${choice}`);
      if (choice === "joker" && card?.modifier?.eternal) throw new Error("an Eternal Joker cannot be sold");
      return { [choice]: index };
    }
    case "pack": {
      if (params.skip === true) {
        if (params.card !== null || params.targets.length) throw new Error("pack skip cannot include card or targets");
        return { skip: true };
      }
      const card = asIndex(params.card, "pack.card");
      const offeredCard = assertAreaIndex(state, "pack", card, "pack.card");
      if (
        String(offeredCard?.set ?? "").toUpperCase() === "JOKER" &&
        areaOccupancy(state.jokers) >= state.jokers?.limit
      ) {
        throw new Error("cannot select this Joker from the pack while Joker slots are full");
      }
      const targets = uniqueIndices(params.targets, "pack.targets", { min: 0, max: 5 });
      assertIndicesInArea(state, "hand", targets, "pack.targets");
      validateBalatroConsumableTargets(offeredCard, targets, state, "pack.card");
      return targets.length ? { card, targets } : { card };
    }
    case "use": {
      const consumable = asIndex(params.consumable, "use.consumable");
      const consumableCard = assertAreaIndex(state, "consumables", consumable, "use.consumable");
      const cards = uniqueIndices(params.cards, "use.cards", { min: 0, max: 5 });
      assertIndicesInArea(state, "hand", cards, "use.cards");
      const targetRule = validateBalatroConsumableTargets(consumableCard, cards, state, "use.consumable");
      if (targetRule.max > 0 && state.state !== BALATROBOT_STATES.SELECTING_HAND) {
        throw new Error(`use.consumable ${targetRule.key} requires hand-card selection and cannot be used from ${state.state}`);
      }
      if (targetRule.key === "c_aura" && cards.some((index) => state.hand?.cards?.[index]?.modifier?.edition)) {
        throw new Error("Aura requires one playing card without an existing edition");
      }
      return cards.length ? { consumable, cards } : { consumable };
    }
    case "rearrange": {
      const choices = ["hand", "jokers", "consumables"].filter((name) => params[name].length > 0);
      if (choices.length !== 1) throw new Error("rearrange requires exactly one complete order");
      const choice = choices[0];
      const areaName = choice === "hand" ? "hand" : choice;
      const count = areaCards(state[areaName]).length;
      const order = uniqueIndices(params[choice], `rearrange.${choice}`, { min: count, max: count });
      if (order.some((index) => index >= count)) throw new Error(`rearrange.${choice} must be a permutation of 0..${count - 1}`);
      return { [choice]: order };
    }
    default:
      throw new Error(`unsupported BalatroBot method: ${method}`);
  }
}

const SUIT_ALIASES = Object.freeze({
  "红桃": "H",
  "红心": "H",
  "方块": "D",
  "方片": "D",
  "梅花": "C",
  "黑桃": "S",
});

function narrativeIntent(prefix) {
  const intents = [
    { intent: "keep", regex: /保留|留下|留住|keep|hold/giu },
    { intent: "discard", regex: /弃掉|弃牌|丢掉|舍弃|discard/giu },
    { intent: "play", regex: /打出|出牌|打这|play/giu },
  ];
  let best = null;
  for (const entry of intents) {
    for (const match of prefix.matchAll(entry.regex)) {
      const position = match.index ?? -1;
      if (!best || position > best.position) best = { intent: entry.intent, position };
    }
  }
  return best?.intent ?? null;
}

function handCardReferences(state, text) {
  const hand = areaCards(state?.hand);
  const source = String(text ?? "");
  const matches = [];
  for (const match of source.matchAll(/(红桃|红心|方块|方片|梅花|黑桃)\s*(10|[AKQJT2-9])/giu)) {
    matches.push({ suit: SUIT_ALIASES[match[1]], rank: match[2] === "10" ? "T" : match[2].toUpperCase(), index: match.index });
  }
  for (const match of source.matchAll(/\b([SHDC])_(10|[AKQJT2-9])\b/giu)) {
    matches.push({ suit: match[1].toUpperCase(), rank: match[2] === "10" ? "T" : match[2].toUpperCase(), index: match.index });
  }
  return matches.flatMap((reference) => {
    const indices = hand
      .map((card, index) => ({ card, index }))
      .filter(({ card }) =>
        String(card?.value?.suit ?? "").toUpperCase() === reference.suit &&
        String(card?.value?.rank ?? "").toUpperCase() === reference.rank)
      .map(({ index }) => index);
    if (indices.length !== 1) return [];
    const prefix = source.slice(Math.max(0, reference.index - 36), reference.index);
    return [{ ...reference, handIndex: indices[0], intent: narrativeIntent(prefix) }];
  });
}

function assertHandNarrativeMatchesAction(state, method, cards, rationale) {
  const selected = new Set(cards);
  for (const reference of handCardReferences(state, rationale)) {
    if (method === "discard" && reference.intent === "keep" && selected.has(reference.handIndex)) {
      throw new Error(`discard indices contradict the written plan to keep ${reference.suit}_${reference.rank}`);
    }
    if (method === "discard" && reference.intent === "discard" && !selected.has(reference.handIndex)) {
      throw new Error(`discard indices omit ${reference.suit}_${reference.rank}, which the written plan says to discard`);
    }
    if (method === "play" && reference.intent === "play" && !selected.has(reference.handIndex)) {
      throw new Error(`play indices omit ${reference.suit}_${reference.rank}, which the written plan says to play`);
    }
  }
}

function immediateScoringShopOffers(state) {
  const openSlots = Math.max(0, Number(state?.jokers?.limit) - areaOccupancy(state?.jokers));
  if (openSlots <= 0) return [];
  const stickerEconomy = balatrobotStickerEconomy(state);
  const money = Math.max(0, stickerEconomy.legalLiquidity - stickerEconomy.twoBlindUpkeep);
  return areaCards(state?.shop)
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => String(card?.set ?? "").toUpperCase() === "JOKER")
    // Fallback is deliberately unable to accept Sticker liabilities. Those
    // offers require the full strategic NPV path even when their printed
    // purchase price is low and their immediate scoring text looks useful.
    .filter(({ card }) => {
      const modifier = card?.modifier ?? card ?? {};
      const hasPerishable = modifier.isPerishable === true || modifier.is_perishable === true ||
        (modifier.perishable !== undefined && modifier.perishable !== null && modifier.perishable !== false);
      return !modifier.eternal && !modifier.rental && !hasPerishable;
    })
    .filter(({ card }) => Number(card?.cost?.buy) <= money)
    .filter(({ card }) => balatrobotIsScoringJoker(card));
}

function finiteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

// This is deliberately a pressure curve, not a prescribed build recipe. It
// estimates how far the current run is from the next blind and converts only
// the affordable part of that gap into a shop-search budget. The strategist
// remains free to buy a Joker, voucher or pack instead of rerolling.
function lowerQuartile(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).toSorted((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.floor((sorted.length - 1) * 0.25)];
}

function jokerBuildSignature(state) {
  return areaCards(state?.jokers)
    .map((joker) => {
      const identity = String(joker?.key ?? joker?.label ?? "").trim().toLowerCase();
      const edition = String(joker?.modifier?.edition ?? joker?.edition ?? "").trim().toLowerCase();
      const effect = String(joker?.value?.effect ?? joker?.effect ?? "").trim().toLowerCase();
      const debuffed = Boolean(joker?.state?.debuff ?? joker?.debuff);
      return `${identity}@${edition}:${debuffed ? "debuff" : "active"}:${effect}`;
    })
    .filter(Boolean)
    .toSorted()
    .join("|");
}

function shopScoreEvidence(state, benchmarks) {
  const currentBuild = jokerBuildSignature(state);
  const recent = (Array.isArray(benchmarks) ? benchmarks : Array.isArray(state?.__scoreBenchmarks) ? state.__scoreBenchmarks : [])
    .filter((benchmark) => benchmark?.state && jokerBuildSignature(benchmark.state) === currentBuild)
    .slice(-8);
  const actual = recent.map((benchmark) => Number(benchmark?.actualScore)).filter((value) => value > 0);
  if (actual.length) return { perHand: lowerQuartile(actual), source: "recent_actual", samples: actual.length };
  const predicted = recent
    .map((benchmark) => Number(benchmark?.candidate?.conservativeScore))
    .filter((value) => value > 0);
  return predicted.length
    ? { perHand: lowerQuartile(predicted) * 0.7, source: "local_candidate", samples: predicted.length }
    : { perHand: 0, source: "hand_level_proxy", samples: 0 };
}

function nextBlindHandCapacity(state, blindName) {
  if (blindName === "the needle" || blindName === "needle") return 1;
  let capacity = 4;
  const deck = String(state?.deck?.key ?? state?.deck?.name ?? state?.deck ?? "").toLowerCase();
  if (/(?:^|[_\s])blue(?:[_\s]|$)/u.test(deck)) capacity += 1;
  if (/(?:^|[_\s])black(?:[_\s]|$)/u.test(deck)) capacity -= 1;
  const voucherKeys = new Set(Object.keys(state?.used_vouchers ?? state?.usedVouchers ?? {}));
  if (voucherKeys.has("v_grabber")) capacity += 1;
  if (voucherKeys.has("v_nacho_tong")) capacity += 1;
  if (areaCards(state?.jokers).some((joker) => String(joker?.key ?? "").toLowerCase() === "j_burglar")) capacity += 3;
  return Math.max(1, capacity);
}

export function balatrobotShopRerollBudget(state, { benchmarks = null } = {}) {
  const blind = activeBlind(state);
  const target = Math.max(0, finiteNumber(blind?.score) ?? 0);
  const hands = state?.hands ?? state?.pokerHands ?? {};
  const playedHands = Object.entries(hands)
    .map(([name, hand]) => ({
      name,
      chips: Math.max(0, finiteNumber(hand?.chips) ?? 0),
      mult: Math.max(1, finiteNumber(hand?.mult) ?? 1),
      played: Math.max(0, finiteNumber(hand?.played) ?? 0),
    }))
    .filter((hand) => hand.played > 0);
  const handRepeatability = new Map([
    ["high card", 1],
    ["pair", 0.9],
    ["two pair", 0.75],
    ["three of a kind", 0.65],
    ["straight", 0.45],
    ["flush", 0.45],
    ["full house", 0.35],
    ["four of a kind", 0.25],
    ["straight flush", 0.15],
    ["five of a kind", 0.2],
    ["flush house", 0.15],
    ["flush five", 0.12],
  ]);
  const repeatabilityOf = (hand) => handRepeatability.get(String(hand?.name ?? "").toLowerCase()) ?? 0.4;
  // A single spectacular historic hand is not a reliable shop forecast. Use
  // the line the run has actually repeated most often, then discount hands
  // that require increasingly specific draws.
  const representative = playedHands.toSorted(
    (left, right) => right.played - left.played || repeatabilityOf(right) - repeatabilityOf(left),
  )[0] ?? { name: "High Card", chips: 5, mult: 1, played: 0 };
  const scoringJokers = balatrobotScoringJokerCount(state);
  const activeJokers = areaCards(state?.jokers).filter((joker) => !balatroJokerDebuffed(joker)).length;
  const blindName = String(blind?.name ?? "").trim().toLowerCase();
  // SHOP.hands_left belongs to the blind that just ended. Forecast the next
  // blind from the run's actual hand allowance instead of that stale value.
  const handCapacity = nextBlindHandCapacity(state, blindName);
  const repeatability = repeatabilityOf(representative);
  const basePerHand = Math.max(35, (representative.chips + 30) * representative.mult * repeatability);
  // Recognized scoring cards improve the estimate smoothly. This is only a
  // capacity proxy; it does not require Chips/Mult/XMult slots or any named
  // archetype, and unknown effects remain a reason to let the model decide.
  const recognitionFactor = 1 + Math.min(5, scoringJokers) * 0.45 + Math.max(0, activeJokers - scoringJokers) * 0.08;
  const proxyPerHand = Math.max(50, Math.round(basePerHand * recognitionFactor));
  const evidence = shopScoreEvidence(state, benchmarks);
  // Recent confirmed scores are a conservative capacity floor. They prevent
  // a partially modelled Joker engine from being mistaken for a 50-chip run.
  const estimatedPerHand = Math.max(proxyPerHand, Math.round(evidence.perHand));
  const estimatedRoundCapacity = Math.max(1, estimatedPerHand * handCapacity);
  const pressure = target > 0 ? target / estimatedRoundCapacity : 0;
  // Debuffed and expired Perishable Jokers still occupy physical slots. Use
  // the area's actual occupancy for shop capacity; activeJokers is only a
  // scoring-strength signal.
  const occupiedJokerSlots = areaCards(state?.jokers).length;
  const openSlots = Math.max(
    0,
    (finiteNumber(state?.jokers?.limit) ?? occupiedJokerSlots) - occupiedJokerSlots,
  );
  const rawRerollCost = finiteNumber(state?.round?.reroll_cost, state?.round?.rerollCost);
  const rerollCost = Math.max(0, rawRerollCost ?? 0);
  const explicitFreeReroll = rawRerollCost === 0;
  const stickerEconomy = balatrobotStickerEconomy(state);
  const cash = Math.max(0, finiteNumber(state?.money) ?? 0);

  let desiredRerolls = target > 0
    ? Math.max(
        0,
        Math.ceil(Math.log2(Math.max(1, pressure))),
        Math.ceil(Math.max(0, pressure - 1) * 2),
      )
    : 0;
  if (openSlots > 0 && pressure >= 0.65) desiredRerolls += 1;
  if (pressure >= 2.5) desiredRerolls = Math.max(desiredRerolls, 2);
  if (pressure >= 5) desiredRerolls = Math.max(desiredRerolls, 3);
  desiredRerolls = Math.min(5, desiredRerolls);

  const usedVouchers = state?.used_vouchers ?? state?.usedVouchers ?? {};
  const voucherKeys = new Set(Object.keys(usedVouchers));
  const normalRerollCost = Math.max(
    1,
    5 - (voucherKeys.has("v_reroll_surplus") ? 2 : 0) - (voucherKeys.has("v_reroll_glut") ? 2 : 0),
  );
  // Balatro raises the displayed price after each paid reroll, which gives us
  // a local, restart-safe count for this shop visit. A free Chaos reroll is
  // deliberately extra and does not consume the paid search allowance.
  const rerollsUsed = rerollCost > 0 ? Math.max(0, Math.round(rerollCost - normalRerollCost)) : 0;
  const remainingDesiredRerolls = Math.max(0, desiredRerolls - rerollsUsed);

  const survivalUrgency = Math.max(0, Math.min(1, (pressure - 0.75) / 3));
  const interestAndSafetyReserve = Math.round(15 - survivalUrgency * 10);
  // Rental is charged after every completed Blind, including while debuffed.
  // Protect two payments so a superficially cheap $1 Sticker cannot silently
  // consume the search budget and force the run further into debt.
  const operatingReserve = stickerEconomy.twoBlindUpkeep;
  const reserve = interestAndSafetyReserve + operatingReserve;
  const spendable = Math.max(0, cash - reserve);
  const requestedBudget = rerollCost > 0 ? remainingDesiredRerolls * rerollCost : 0;
  const budget = rerollCost > 0
    ? Math.floor(Math.min(spendable, requestedBudget) / rerollCost) * rerollCost
    : 0;
  const maxRerolls = rerollCost > 0
    ? Math.floor(budget / rerollCost)
    : (explicitFreeReroll ? 1 : 0);
  return {
    blind: blind?.name ?? null,
    target,
    representativeHand: representative.name,
    repeatability,
    effectiveHands: handCapacity,
    estimatedPerHand,
    scoreEvidenceSource: evidence.source,
    scoreEvidenceSamples: evidence.samples,
    estimatedRoundCapacity,
    pressure: Math.round(pressure * 100) / 100,
    reserve,
    interestAndSafetyReserve,
    operatingReserve,
    rentalCount: stickerEconomy.rentalCount,
    rentalRate: stickerEconomy.rentalRate,
    rentalUpkeep: stickerEconomy.rentalUpkeep,
    cashAfterNextUpkeep: stickerEconomy.cashAfterNextUpkeep,
    cash,
    legalLiquidity: stickerEconomy.legalLiquidity,
    emergencyCredit: stickerEconomy.activeCredit,
    creditReservedForSurvival: stickerEconomy.activeCredit > 0,
    spendableCash: spendable,
    rerollCost,
    explicitFreeReroll,
    budget,
    maxRerolls,
    desiredRerolls,
    rerollsUsed,
    remainingDesiredRerolls,
    openSlots,
    scoringJokers,
    shouldReroll: explicitFreeReroll || (rerollCost > 0 && maxRerolls > 0),
  };
}

function assertBuyNarrativeMatchesAction(state, params, actionReason, strategy) {
  const choices = [
    ["card", "shop"],
    ["voucher", "vouchers"],
    ["pack", "packs"],
  ];
  const selected = choices.find(([choice]) => Number.isInteger(params?.[choice]));
  if (!selected) return;
  const [selectedChoice, selectedArea] = selected;
  const selectedIndex = params[selectedChoice];
  const target = areaCards(state?.[selectedArea])[selectedIndex];
  const namedAlternative = (text) => {
    for (const [choice, areaName] of choices) {
      for (const [index, alternative] of areaCards(state?.[areaName]).entries()) {
        if (choice === selectedChoice && index === selectedIndex) continue;
        if (actionNamesCard(alternative, text)) return { choice, index, alternative };
      }
    }
    return null;
  };
  const reasonAlternative = namedAlternative(actionReason);
  if (reasonAlternative && !actionNamesCard(target, actionReason)) {
    throw new Error(
      `buy.${selectedChoice} index ${selectedIndex} is ${target?.label || target?.key || "unknown"}, ` +
        `but the action reason names ${reasonAlternative.alternative?.label || reasonAlternative.alternative?.key || "a different shop item"} ` +
        `at buy.${reasonAlternative.choice} ${reasonAlternative.index}`,
    );
  }
  const rationale = `${strategy ?? ""} ${actionReason ?? ""}`;
  if (actionNamesCard(target, rationale)) return;
  const alternative = namedAlternative(rationale);
  if (alternative) {
    throw new Error(
      `buy.${selectedChoice} index ${selectedIndex} is ${target?.label || target?.key || "unknown"}, ` +
        `but the written strategy names ${alternative.alternative?.label || alternative.alternative?.key || "a different shop item"} ` +
        `at buy.${alternative.choice} ${alternative.index}`,
    );
  }
}

function assertShopResourcesConverted(state, method, params, { allowTrustedShopExit = false } = {}) {
  if (state?.state !== "SHOP") return;
  if (method === "next_round") {
    if (allowTrustedShopExit) return;
    const decision = balatrobotShopRerollBudget(state);
    if (decision.shouldReroll) {
      throw new Error(
        `shop survival budget allows ${decision.maxRerolls || 1} reroll(s) before ${decision.blind || "the next blind"} ` +
          `(target ${decision.target}, estimated round capacity ${decision.estimatedRoundCapacity}, reserve $${decision.reserve}); ` +
          "buy a useful visible resource or reroll before leaving",
      );
    }
  }
}

function normalizedJokerNames(joker) {
  const key = String(joker?.key ?? "").trim().toLowerCase();
  const label = String(joker?.label ?? "").trim().toLowerCase();
  return [key, key.replace(/^j_/u, "").replaceAll("_", " "), label]
    .filter((value) => value.length >= 4 && value !== "joker" && value !== "j joker");
}

function textNamesJoker(text, joker) {
  const source = String(text ?? "").toLowerCase().replaceAll("_", " ");
  return normalizedJokerNames(joker).some((name) => source.includes(name.replaceAll("_", " ")));
}

function assertCollectionAwareRunPlan(runPlan, collectionKnowledge, appearedThisRun, state) {
  if (!collectionKnowledge?.available) return;
  const coreText = `${runPlan.buildGoal} ${runPlan.synergies}`;
  const locked = Array.isArray(collectionKnowledge.lockedJokers) ? collectionKnowledge.lockedJokers : [];
  const lockedNamed = locked.find((joker) => textNamesJoker(coreText, joker));
  if (lockedNamed) {
    throw new Error(`runPlan core names locked Joker ${lockedNamed.label || lockedNamed.key}`);
  }
  const appearedKeys = new Set((appearedThisRun?.jokers ?? []).map((joker) => String(joker?.key ?? "").toLowerCase()));
  const ownedKeys = new Set(areaCards(state?.jokers).map((joker) => String(joker?.key ?? "").toLowerCase()));
  const unlocked = Array.isArray(collectionKnowledge.unlockedJokers) ? collectionKnowledge.unlockedJokers : [];
  const unseenNamed = unlocked.find((joker) => {
    const key = String(joker?.key ?? "").toLowerCase();
    return !appearedKeys.has(key) && !ownedKeys.has(key) && textNamesJoker(coreText, joker);
  });
  if (unseenNamed) {
    throw new Error(
      `runPlan core names unlocked but unseen Joker ${unseenNamed.label || unseenNamed.key}; keep it in shopPriorities or pivotPolicy until it appears`,
    );
  }
}

export function sanitizeCollectionAwareRunPlan(runPlan, collectionKnowledge, appearedThisRun, state) {
  const source = runPlan && typeof runPlan === "object" && !Array.isArray(runPlan) ? runPlan : null;
  if (!source || !collectionKnowledge?.available) {
    return { runPlan: source, changed: false, removed: [] };
  }

  const coreText = `${source.buildGoal ?? ""} ${source.synergies ?? ""}`;
  const appearedKeys = new Set((appearedThisRun?.jokers ?? []).map((joker) => String(joker?.key ?? "").toLowerCase()));
  const owned = areaCards(state?.jokers);
  const ownedKeys = new Set(owned.map((joker) => String(joker?.key ?? "").toLowerCase()));
  const locked = Array.isArray(collectionKnowledge.lockedJokers) ? collectionKnowledge.lockedJokers : [];
  const unlocked = Array.isArray(collectionKnowledge.unlockedJokers) ? collectionKnowledge.unlockedJokers : [];
  const removed = [
    ...locked.filter((joker) => textNamesJoker(coreText, joker)),
    ...unlocked.filter((joker) => {
      const key = String(joker?.key ?? "").toLowerCase();
      return !appearedKeys.has(key) && !ownedKeys.has(key) && textNamesJoker(coreText, joker);
    }),
  ].filter((joker, index, all) => {
    const key = String(joker?.key ?? joker?.label ?? "").toLowerCase();
    return all.findIndex((candidate) => String(candidate?.key ?? candidate?.label ?? "").toLowerCase() === key) === index;
  });
  if (!removed.length) return { runPlan: source, changed: false, removed: [] };

  const ownedNames = owned
    .map((joker) => String(joker?.label ?? joker?.key ?? "").trim())
    .filter(Boolean);
  const removedNames = removed.map((joker) => joker?.label || joker?.key).filter(Boolean);
  return {
    runPlan: {
      ...source,
      buildGoal: ownedNames.length ? `Current owned build: ${ownedNames.join(", ")}` : "No committed Joker core yet",
      synergies: ownedNames.length > 1
        ? `Use only verified synergies among owned Jokers: ${ownedNames.join(", ")}`
        : "Do not assume an unseen or locked Joker synergy",
      revisionReason: `Removed unavailable core assumption: ${removedNames.join(", ")}`.slice(0, 180),
    },
    changed: true,
    removed: removedNames,
  };
}

export function validateBalatrobotPlan(
  candidate,
  state,
  {
    minimumConfidence = 0,
    allowBlindSkip = false,
    allowTrustedShopExit = false,
    collectionKnowledge = null,
    appearedThisRun = null,
  } = {},
) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("BalatroBot planner result must be an object");
  }
  if (!Array.isArray(candidate.actions) || candidate.actions.length !== 1) {
    throw new Error("BalatroBot planner must return exactly one semantic action");
  }
  const rawAction = candidate.actions[0];
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    throw new Error("BalatroBot action must be an object");
  }
  const unsupported = Object.keys(rawAction).filter((key) => !ACTION_FIELDS.has(key));
  if (unsupported.length) throw new Error(`BalatroBot action has unsupported key(s): ${unsupported.join(", ")}`);
  const method = typeof rawAction.method === "string" ? rawAction.method.trim() : "";
  const allowed = METHODS_BY_STATE[state?.state];
  if (!allowed) throw new Error(`state ${state?.state ?? "unknown"} is transitional and must not use model actions`);
  if (!allowed.has(method)) throw new Error(`${method || "missing method"} is not allowed in ${state.state}`);
  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  if (confidence < minimumConfidence) {
    throw new Error(`confidence ${confidence.toFixed(2)} is below minimum ${minimumConfidence.toFixed(2)}`);
  }
  const params = paramsFromAction(rawAction);
  const normalizedParams = rpcParams(method, params, state);
  const rationale = `${candidate.strategy ?? ""} ${rawAction.reason ?? ""}`;
  if (method === "play" || method === "discard") {
    assertHandNarrativeMatchesAction(state, method, normalizedParams.cards, rationale);
  }
  if (method === "buy" || method === "buy_use") {
    assertBuyNarrativeMatchesAction(state, normalizedParams, rawAction.reason, candidate.strategy);
  }
  assertShopResourcesConverted(state, method, normalizedParams, { allowTrustedShopExit });
  if (method === "sell") {
    const choice = Number.isInteger(normalizedParams.joker) ? "joker" : "consumable";
    const areaName = choice === "joker" ? "jokers" : "consumables";
    const index = normalizedParams[choice];
    const target = assertAreaIndex(state, areaName, index, `sell.${choice}`);
    if (!actionNamesCard(target, rationale)) {
      throw new Error(
        `sell.${choice} index ${index} is ${target?.label || target?.key || "unknown"}, but the written strategy does not name that exact item`,
      );
    }
  }
  if (method === "skip") {
    const blind = activeBlind(state);
    const tag = String(blind?.tagName ?? blind?.tag_name ?? blind?.tag?.name ?? blind?.tagEffect ?? blind?.tag_effect ?? "").trim();
    const explicitlySkips = /(?:跳过|skip)/iu.test(rationale);
    const contradictsSkip = /(?:不跳过|正常挑战|挑战当前|打当前|进入当前|play\s+(?:the\s+)?current\s+blind)/iu.test(rationale);
    const highValueTag = /(?:Investment|Economy|Negative|Polychrome|Rare|Uncommon|Voucher|Coupon|投资|经济|负片|多彩|稀有|罕见|优惠券)/iu.test(tag);
    const matureBuild = areaCards(state?.jokers).filter((joker) => !balatroJokerDebuffed(joker)).length >= 3 &&
      balatrobotScoringJokerCount(state) >= 2;
    if (!allowBlindSkip) throw new Error("blind skip is disabled outside a fresh strategic tag evaluation");
    if (confidence < 0.9) throw new Error("blind skip requires confidence of at least 0.90");
    if (Number(state?.ante_num ?? state?.ante) < 2) throw new Error("blind skip is disabled before Ante 2");
    if (!tag || !highValueTag) throw new Error(`blind skip tag is not on the conservative high-value allowlist: ${tag || "unreadable"}`);
    if (!matureBuild) throw new Error("blind skip requires at least 3 active Jokers including 2 recognized scoring Jokers");
    if (!explicitlySkips || contradictsSkip) {
      throw new Error("skip action contradicts or is not explicitly supported by the written strategy");
    }
  }
  const sourceRunPlan = candidate.runPlan && typeof candidate.runPlan === "object" && !Array.isArray(candidate.runPlan)
    ? candidate.runPlan
    : {};
  const runPlan = {
    metaAssessment: String(sourceRunPlan.metaAssessment ?? "").slice(0, 240),
    buildGoal: String(sourceRunPlan.buildGoal ?? "").slice(0, 180),
    synergies: String(sourceRunPlan.synergies ?? "").slice(0, 240),
    economyPolicy: String(sourceRunPlan.economyPolicy ?? "").slice(0, 240),
    shopPriorities: String(sourceRunPlan.shopPriorities ?? "").slice(0, 240),
    pivotPolicy: String(sourceRunPlan.pivotPolicy ?? "").slice(0, 240),
    handPolicy: String(sourceRunPlan.handPolicy ?? "").slice(0, 240),
    nextMilestone: String(sourceRunPlan.nextMilestone ?? "").slice(0, 180),
    revisionReason: String(sourceRunPlan.revisionReason ?? "").slice(0, 180),
  };
  assertCollectionAwareRunPlan(runPlan, collectionKnowledge, appearedThisRun, state);
  return {
    observation: String(candidate.observation ?? "").slice(0, 600),
    strategy: String(candidate.strategy ?? "").slice(0, 500),
    memory: String(candidate.memory ?? "").slice(0, 350),
    runPlan,
    confidence,
    actions: [
      {
        method,
        params: normalizedParams,
        reason: String(rawAction.reason ?? "").slice(0, 160),
      },
    ],
  };
}

export function deterministicBalatrobotAction(state, config = {}) {
  const jokerOrderAction = balatrobotJokerOrderAction(state);
  if (jokerOrderAction) return jokerOrderAction;
  switch (state?.state) {
    case BALATROBOT_STATES.MENU:
      if (!balatrobotMenuReady(state)) return null;
      return {
        method: "start",
        params: { deck: config.balatrobotDeck ?? "RED", stake: config.balatrobotStake ?? "WHITE" },
        reason: "Start the next run locally",
      };
    case BALATROBOT_STATES.ROUND_EVAL:
      if (state?.won !== true) {
        return { method: "cash_out", params: {}, reason: "Collect round rewards locally" };
      }
      if (String(config.balatrobotPostWinMode ?? "menu").toLowerCase() !== "endless") {
        return { method: "menu", params: {}, reason: "Finish the confirmed victory and return to menu" };
      }
      return config.balatrobotVictoryOverlayDismissed !== true
        ? { method: "endless", params: {}, reason: "Dismiss the confirmed victory overlay and continue into Endless mode" }
        : { method: "cash_out", params: {}, reason: "Collect round rewards locally" };
    case BALATROBOT_STATES.GAME_OVER:
      return { method: "menu", params: {}, reason: "Return to menu for the next run" };
    default:
      return null;
  }
}

function combinations(items, maximum = 5) {
  const result = [];
  const visit = (start, picked) => {
    if (picked.length) result.push([...picked]);
    if (picked.length === maximum) return;
    for (let index = start; index < items.length; index++) {
      picked.push(items[index]);
      visit(index + 1, picked);
      picked.pop();
    }
  };
  visit(0, []);
  return result;
}

function pokerScore(state, indices, cards) {
  const classified = classifyBalatroHand(state, cards, indices);
  const ranks = indices.map((index) => balatroRankNumber(balatroCardRank(cards[index])));
  return BALATRO_HAND_STRENGTH[classified.handType] * 1_000_000 + ranks.reduce((sum, rank) => sum + rank, 0) * 100 + indices.length;
}

export function fallbackBalatrobotAction(state) {
  switch (state?.state) {
    case BALATROBOT_STATES.BLIND_SELECT:
      return { method: "select", params: {}, reason: "Fallback: play the current blind" };
    case BALATROBOT_STATES.SELECTING_HAND: {
      if (balatrobotHandActionsReady(state) === false) return null;
      const candidates = generateBalatrobotCandidates(state);
      const assessment = balatrobotSurvivalAssessment(state, candidates);
      if (assessment.shouldResolveBoss && assessment.requiredBossAction) {
        const required = assessment.requiredBossAction.action;
        return {
          method: "sell",
          params: { joker: required.joker },
          reason: "Fallback: sell the least valuable non-Eternal Joker to disable Verdant Leaf",
        };
      }
      if (assessment.shouldDiscard) {
        return {
          method: "discard",
          params: { cards: assessment.discard.action.cards },
          reason: `Fallback: improve a hand below survival pace ${Math.ceil(assessment.requiredPace)}`,
        };
      }
      if (assessment.shouldUseConsumable && assessment.emergencyConsumable) {
        const emergency = assessment.emergencyConsumable.action;
        const params = { consumable: emergency.consumable };
        if (Array.isArray(emergency.cards) && emergency.cards.length) params.cards = emergency.cards;
        return {
          method: "use",
          params,
          reason: "Fallback: use an available scoring consumable before the final hand",
        };
      }
      const solved = assessment.bestPlay;
      if (solved) {
        return {
          method: "play",
          params: { cards: solved.action.cards },
          reason: `Fallback: play locally solved ${solved.handType}`,
        };
      }
      const cards = areaCards(state.hand);
      const options = combinations(cards.map((_, index) => index), Math.min(5, cards.length));
      options.sort((left, right) => pokerScore(state, right, cards) - pokerScore(state, left, cards));
      return { method: "play", params: { cards: options[0] ?? [0] }, reason: "Fallback: play the strongest visible poker hand" };
    }
    case BALATROBOT_STATES.SHOP:
      {
        const rerollDecision = balatrobotShopRerollBudget(state);
        const scoringOffer = immediateScoringShopOffers(state)[0];
        if (scoringOffer && rerollDecision.pressure >= 0.85) {
          return {
            method: "buy",
            params: { card: scoringOffer.index },
            reason:
              `Fallback: buy ${scoringOffer.card.label || scoringOffer.card.key} under ` +
              `${rerollDecision.pressure.toFixed(2)}x next-blind score pressure`,
          };
        }
        if (rerollDecision.shouldReroll) {
          return {
            method: "reroll",
            params: {},
            reason:
              `Fallback: use the $${rerollDecision.budget} dynamic search budget for ` +
              `${rerollDecision.blind || "the next blind"} (${rerollDecision.target} target)`,
          };
        }
        return { method: "next_round", params: {}, reason: "Fallback: leave an unresolved shop" };
      }
    case BALATROBOT_STATES.PACK:
      {
        const choice = generateBalatrobotCandidates(state).find((candidate) =>
          candidate.action?.method === "pack" &&
          !candidate.action.skip &&
          candidate.fallbackSafe === true &&
          candidate.safeChoice === true &&
          !candidate.destructive &&
          !candidate.harmful);
        if (choice) {
          const params = { card: choice.action.card };
          if (choice.action.targets?.length) params.targets = choice.action.targets;
          return { method: "pack", params, reason: `Fallback: take locally validated ${choice.card?.label || choice.card?.key || "pack choice"}` };
        }
        return { method: "pack", params: { skip: true }, reason: "Fallback: skip because no locally safe pack choice exists" };
      }
    default:
      return deterministicBalatrobotAction(state);
  }
}

function activeBlind(state) {
  const entries = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss].filter(Boolean);
  return entries.find((blind) => String(blind.status ?? "").toUpperCase().includes("CURRENT")) ??
    entries.find((blind) => String(blind.status ?? "").toUpperCase().includes("SELECT")) ??
    entries.find((blind) => String(blind.status ?? "").toUpperCase().includes("UPCOMING")) ??
    null;
}

export function legacyPlanForBalatrobot(state, action, details = {}) {
  const blind = activeBlind(state);
  const screen = {
    MENU: "main_menu",
    BLIND_SELECT: "blind_select",
    SELECTING_HAND: "hand",
    ROUND_EVAL: "round_result",
    SHOP: "shop",
    SMODS_BOOSTER_OPENED: "pack",
    GAME_OVER: "game_over",
  }[state.state] ?? "unknown";
  return {
    observation: details.observation ?? `Exact BalatroBot state: ${state.state}`,
    strategy: details.strategy ?? action.reason,
    memory: details.memory ?? "",
    runPlan: details.runPlan ?? null,
    screen,
    state: {
      ante: state.ante_num ?? null,
      money: state.money ?? null,
      score: state.round?.chips ?? null,
      target: blind?.score ?? null,
      handsLeft: state.round?.hands_left ?? null,
      discardsLeft: state.round?.discards_left ?? null,
      deck: state.deck ?? "",
      deckRemaining: state.cards?.count ?? null,
      deckTotal: state.cards?.limit ?? null,
      deckSnapshot: "",
      stake: state.stake ?? "",
      blind: blind?.name ?? "",
      build: areaCards(state.jokers).map((card) => card.label || card.key).join(", ").slice(0, 160),
      // Balatro can preserve won=true on a failed Ante-8 Boss. The runner
      // records a victory only after observing the real ROUND_EVAL win
      // checkpoint, so a bare GAME_OVER frame must never claim success here.
      outcome: state.state === "GAME_OVER" ? "lost" : "ongoing",
      features: ["balatrobot-exact-state"],
    },
    decision: {
      key: `rpc_${action.method}`,
      selectedBefore: [],
      selectedAfter: [],
      visibleCardCount: areaCards(state.hand).length,
      handCapacity: state.hand?.limit ?? 0,
      visibleCards: [],
      targetHand: "none",
      shopOfferPositions: [],
      commit: action.method === "play" ? "play_hand" : action.method === "discard" ? "discard" : "none",
    },
    confidence: details.confidence ?? 1,
    finished: false,
    needsDetail: false,
    actions: [{ type: "rpc", method: action.method, params: action.params, reason: action.reason }],
  };
}
