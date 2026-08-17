import {
  BALATRO_HAND_STRENGTH as HAND_STRENGTH,
  balatroCardDebuffed as cardDebuffed,
  balatroCardIsFace,
  balatroCardMatchesSuit,
  balatroCardModifier as cardModifier,
  balatroCardRank as cardRank,
  balatroCardSuit as cardSuit,
  balatroCards as cardsIn,
  balatroConsumableTargetRule,
  balatroFlushSize,
  balatroJokerDebuffed as jokerDebuffed,
  balatroJokerKey as jokerKey,
  balatroRankNumber as rankNumber,
  balatroRoundSurvivalBudget,
  balatroStraightSize,
  balatroStraightWindows,
  classifyBalatroHand,
} from "./balatro-rules-engine.mjs";
import {
  balatrobotJokerCapability,
  balatrobotJokerTacticalContext,
  balatrobotVoucherValue,
} from "./balatro-strategy-catalog.mjs";
import {
  balatroPackHasSafeConsumableChoice,
  generateBalatroConsumablePackCandidates,
  generateBalatroConsumableShopUseCandidates,
  generateBalatroConsumableUseCandidates,
  inspectBalatroConsumables,
} from "./balatro-consumable-strategy.mjs";

export { balatrobotJokerCapability, balatrobotJokerTacticalContext, balatrobotVoucherValue };

const BASE_HANDS = Object.freeze({
  "High Card": { chips: 5, mult: 1 },
  Pair: { chips: 10, mult: 2 },
  "Two Pair": { chips: 20, mult: 2 },
  "Three of a Kind": { chips: 30, mult: 3 },
  Straight: { chips: 30, mult: 4 },
  Flush: { chips: 35, mult: 4 },
  "Full House": { chips: 40, mult: 4 },
  "Four of a Kind": { chips: 60, mult: 7 },
  "Straight Flush": { chips: 100, mult: 8 },
  "Five of a Kind": { chips: 120, mult: 12 },
  "Flush House": { chips: 140, mult: 14 },
  "Flush Five": { chips: 160, mult: 16 },
});

const KNOWN_SCORING_JOKERS = new Set([
  "j_joker",
  "j_greedy_joker",
  "j_lusty_joker",
  "j_wrathful_joker",
  "j_gluttenous_joker",
  "j_jolly",
  "j_zany",
  "j_mad",
  "j_crazy",
  "j_droll",
  "j_sly",
  "j_wily",
  "j_clever",
  "j_devious",
  "j_crafty",
  "j_half",
  "j_stencil",
  "j_banner",
  "j_mystic_summit",
  "j_raised_fist",
  "j_fibonacci",
  "j_abstract",
  "j_gros_michel",
  "j_cavendish",
  "j_odd_todd",
  "j_even_steven",
  "j_scholar",
  "j_supernova",
  "j_ride_the_bus",
  "j_green_joker",
  "j_swashbuckler",
  "j_flash",
  "j_popcorn",
  "j_ice_cream",
  "j_square",
  "j_blue_joker",
  "j_walkie_talkie",
  "j_scary_face",
  "j_smiley",
  "j_smiley_face",
  "j_photograph",
  "j_hanging_chad",
  "j_hiker",
  "j_baron",
  "j_mime",
  "j_ramen",
  "j_acrobat",
  "j_card_sharp",
  "j_blackboard",
  "j_hologram",
  "j_vampire",
  "j_stuntman",
  "j_bootstraps",
  "j_bull",
  "j_flower_pot",
  "j_splash",
]);
const HAND_CONTAINS = Object.freeze({
  Pair: new Set(["Pair", "Two Pair", "Three of a Kind", "Full House", "Four of a Kind", "Five of a Kind", "Flush House", "Flush Five"]),
  "Two Pair": new Set(["Two Pair", "Full House", "Flush House"]),
  "Three of a Kind": new Set(["Three of a Kind", "Full House", "Four of a Kind", "Five of a Kind", "Flush House", "Flush Five"]),
  Straight: new Set(["Straight", "Straight Flush"]),
  Flush: new Set(["Flush", "Straight Flush", "Flush House", "Flush Five"]),
});
const ODD_RANKS = new Set([3, 5, 7, 9, 14]);
const EVEN_RANKS = new Set([2, 4, 6, 8, 10]);
const WALKIE_TALKIE_RANKS = new Set([4, 10]);
const FIBONACCI_RANKS = new Set([2, 3, 5, 8, 14]);
const DYNAMIC_MULT_JOKERS = new Set(["j_green_joker", "j_ride_the_bus", "j_flash", "j_popcorn"]);
const ADDITIVE_MULT_JOKERS = new Set([
  "j_joker", "j_greedy_joker", "j_lusty_joker", "j_wrathful_joker", "j_gluttenous_joker",
  "j_jolly", "j_zany", "j_mad", "j_crazy", "j_droll", "j_half", "j_mystic_summit",
  "j_raised_fist", "j_fibonacci", "j_abstract", "j_gros_michel", "j_even_steven",
  "j_walkie_talkie", "j_scholar", "j_smiley", "j_smiley_face", "j_supernova",
  "j_ride_the_bus", "j_green_joker", "j_swashbuckler", "j_flash", "j_popcorn",
  "j_bootstraps",
]);
const CHIP_JOKERS = new Set([
  "j_sly", "j_wily", "j_clever", "j_devious", "j_crafty", "j_banner", "j_odd_todd",
  "j_scary_face", "j_blue_joker", "j_stuntman", "j_bull", "j_ice_cream", "j_square",
  "j_hiker",
]);
const X_MULT_ENGINE_JOKERS = new Set([
  "j_cavendish", "j_hologram", "j_vampire", "j_ramen", "j_blackboard", "j_card_sharp",
  "j_acrobat", "j_flower_pot", "j_photograph", "j_baron", "j_constellation", "j_campfire",
  "j_madness", "j_bloodstone", "j_triboulet", "j_idol", "j_obelisk", "j_lucky_cat",
  "j_steel_joker", "j_glass_joker", "j_drivers_license", "j_ancient",
]);
const RETRIGGER_ENGINE_JOKERS = new Set([
  "j_hanging_chad", "j_mime", "j_hack", "j_sock_and_buskin", "j_dusk", "j_selzer",
]);
const COPY_ENGINE_JOKERS = new Set(["j_blueprint", "j_brainstorm"]);
// These Jokers have a positional meaning that cannot be reduced to the usual
// "flat Mult before XMult" rule.  The strategic planner must choose their
// exact target/sacrifice instead of a local stable sort silently changing it.
const POSITIONAL_JOKERS = new Set(["j_blueprint", "j_brainstorm", "j_ceremonial"]);
const SCALING_ENGINE_JOKERS = new Set([
  "j_hologram", "j_vampire", "j_constellation", "j_campfire", "j_madness", "j_lucky_cat",
  "j_wee", "j_runner", "j_square", "j_green_joker", "j_ride_the_bus", "j_flash", "j_supernova",
  "j_trousers", "j_spare_trousers", "j_red_card", "j_ceremonial", "j_rocket", "j_satellite",
]);
const RECURRING_ECONOMY_JOKERS = new Set([
  "j_business", "j_business_card", "j_cloud_9", "j_delayed_gratification", "j_faceless",
  "j_golden", "j_golden_joker", "j_mail", "j_reserved_parking", "j_rocket", "j_satellite",
  "j_to_the_moon",
]);
const FINAL_HAND_GENERATOR_KEYS = new Set(["c_fool", "c_high_priestess", "c_emperor", "c_wheel_of_fortune"]);
const PLANET_HAND_UPGRADES = new Map([
  ["c_pluto", { handType: "High Card", chips: 10, mult: 1 }],
  ["c_mercury", { handType: "Pair", chips: 15, mult: 1 }],
  ["c_uranus", { handType: "Two Pair", chips: 20, mult: 1 }],
  ["c_venus", { handType: "Three of a Kind", chips: 20, mult: 2 }],
  ["c_saturn", { handType: "Straight", chips: 30, mult: 3 }],
  ["c_jupiter", { handType: "Flush", chips: 15, mult: 2 }],
  ["c_earth", { handType: "Full House", chips: 25, mult: 2 }],
  ["c_mars", { handType: "Four of a Kind", chips: 30, mult: 3 }],
  ["c_neptune", { handType: "Straight Flush", chips: 40, mult: 4 }],
  ["c_planet_x", { handType: "Five of a Kind", chips: 35, mult: 3 }],
  ["c_ceres", { handType: "Flush House", chips: 40, mult: 4 }],
  ["c_eris", { handType: "Flush Five", chips: 50, mult: 3 }],
]);
const PLANET_SUPPORT_HANDS = new Map([
  ["Two Pair", new Set(["Pair"])],
  ["Three of a Kind", new Set(["Pair"])],
  ["Full House", new Set(["Three of a Kind", "Two Pair", "Pair"])],
  ["Four of a Kind", new Set(["Three of a Kind", "Pair"])],
  ["Five of a Kind", new Set(["Four of a Kind", "Three of a Kind", "Pair"])],
  ["Flush House", new Set(["Full House", "Flush", "Three of a Kind", "Two Pair"])],
  ["Flush Five", new Set(["Five of a Kind", "Flush", "Four of a Kind"])],
]);
const HAND_PLAN_ALIASES = new Map([
  ["High Card", ["high card", "高牌"]],
  ["Pair", ["pair", "对子"]],
  ["Two Pair", ["two pair", "两对"]],
  ["Three of a Kind", ["three of a kind", "三条"]],
  ["Straight", ["straight", "顺子"]],
  ["Flush", ["flush", "同花"]],
  ["Full House", ["full house", "葫芦"]],
  ["Four of a Kind", ["four of a kind", "四条"]],
  ["Straight Flush", ["straight flush", "同花顺"]],
  ["Five of a Kind", ["five of a kind", "五条"]],
  ["Flush House", ["flush house", "同花葫芦"]],
  ["Flush Five", ["flush five", "同花五条"]],
]);
const TARGETED_CONSUMABLE_SETS = new Set(["TAROT", "SPECTRAL"]);
// Fail closed: only the weakest deterministic Tarot currently has a sale
// path. Everything else (including all rescue/economy/generation Tarot,
// Planets, Spectrals and unknown future consumables) is retention-protected.
const CONTROLLED_CONSUMABLE_SALE_KEYS = new Set(["c_tower"]);
const CONSUMABLE_REVIEW_BLIND_AGE = 2;
const CONSUMABLE_SALE_BLIND_AGE = 2;
const DEFAULT_RENTAL_RATE = 3;
const SHOP_DOLLAR_UTILITY = 20;
const DEFAULT_PERISHABLE_BLINDS = 5;
const RED_OR_HIGHER_STAKES = new Set(["RED", "GREEN", "BLACK", "BLUE", "PURPLE", "ORANGE", "GOLD"]);
const HIGH_VALUE_BLIND_TAG_PATTERN = /(?:Investment|Economy|Negative|Polychrome|Rare|Uncommon|Voucher|Coupon|投资|经济|负片|多彩|稀有|罕见|优惠券)/iu;
const HAND_ACTION_METHODS = new Set(["play", "discard"]);
const CANDIDATE_ACTION_STATES = new Set(["BLIND_SELECT", "SHOP", "SMODS_BOOSTER_OPENED", "SELECTING_HAND"]);
const SHOP_STRATEGY_STATES = new Set(["SHOP", "SMODS_BOOSTER_OPENED"]);
const AMBIGUOUS_MOUTH_LOCK = "__AMBIGUOUS_MOUTH_LOCK__";
const MOUTH_RANK_LOCKED_HANDS = new Set([
  "Pair",
  "Two Pair",
  "Three of a Kind",
  "Full House",
  "Four of a Kind",
  "Five of a Kind",
  "Flush House",
  "Flush Five",
]);

function cardBonusChips(card) {
  const values = [...cardEffect(card).matchAll(/\+(\d+(?:\.\d+)?)\s*(?:额外筹码|extra\s+chips?)/giu)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const visibleExtra = values.length ? Math.max(...values) : 0;
  // Bonus cards include their built-in +30 in the same "extra chips" text
  // used for permanent Hiker chips. The enhancement is applied separately.
  return cardModifier(card, "enhancement").includes("BONUS")
    ? Math.max(0, visibleExtra - 30)
    : visibleExtra;
}

function chipValue(card) {
  if (cardDebuffed(card)) return 0;
  const rank = rankNumber(cardRank(card));
  const base = rank === 14 ? 11 : Math.min(rank, 10);
  return base + cardBonusChips(card);
}

function cardEffect(card) {
  return String(card?.value?.effect ?? card?.effect ?? "");
}

function handHas(candidate, handType) {
  return HAND_CONTAINS[handType]?.has(candidate.handType) ?? candidate.handType === handType;
}

function dynamicAdditiveValue(joker) {
  const values = [...cardEffect(joker).matchAll(/\+(\d+(?:\.\d+)?)\s*(?:mult|倍率|倍|筹码|chips?)/giu)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function dynamicXValue(joker) {
  const values = [...cardEffect(joker).matchAll(/[x×]\s*(\d+(?:\.\d+)?)/giu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 1);
  return values.length ? Math.max(...values) : 1;
}

function additiveMultJoker(joker) {
  const key = jokerKey(joker);
  const edition = cardModifier(joker, "edition");
  if (ADDITIVE_MULT_JOKERS.has(key) || DYNAMIC_MULT_JOKERS.has(key)) return true;
  if (edition.includes("HOLOGRAPHIC") || edition === "HOLO") return true;
  return /\+\s*\d+(?:\.\d+)?\s*(?:mult|倍率|倍数)/iu.test(cardEffect(joker));
}

function chipJoker(joker) {
  const key = jokerKey(joker);
  const edition = cardModifier(joker, "edition");
  if (CHIP_JOKERS.has(key) || edition.includes("FOIL")) return true;
  return /\+\s*\d+(?:\.\d+)?\s*(?:筹码|chips?)/iu.test(cardEffect(joker));
}

function positionalJoker(joker) {
  if (POSITIONAL_JOKERS.has(jokerKey(joker))) return true;
  return /(?:copy|复制).{0,24}(?:right|leftmost|右|最左)|(?:destroy|摧毁|销毁).{0,24}(?:right|右)/iu.test(cardEffect(joker));
}

function jokerOrderTier(joker) {
  const key = jokerKey(joker);
  const edition = cardModifier(joker, "edition");
  const multiplicative = X_MULT_ENGINE_JOKERS.has(key) || dynamicXValue(joker) > 1 || edition.includes("POLYCHROME");
  if (multiplicative) return 3;
  if (additiveMultJoker(joker)) return 1;
  if (chipJoker(joker)) return 0;
  return 2;
}

/**
 * Return a safe, deterministic Joker rearrangement when the ordinary scoring
 * equation is being left on the table.  The permutation contains indices from
 * the current order, as required by BalatroBot's rearrange endpoint.
 *
 * Copy/adjacency/destruction Jokers deliberately opt out: their best order is
 * build-specific and remains a strategic decision rather than a blind sort.
 */
export function balatrobotJokerOrderAction(state) {
  if (!["SELECTING_HAND", "SHOP", "SMODS_BOOSTER_OPENED"].includes(state?.state)) return null;
  const jokers = cardsIn(state?.jokers);
  if (jokers.length < 2 || jokers.some(positionalJoker)) return null;
  const order = jokers
    .map((joker, index) => ({ index, tier: jokerOrderTier(joker) }))
    .toSorted((left, right) => left.tier - right.tier || left.index - right.index)
    .map(({ index }) => index);
  if (order.every((index, position) => index === position)) return null;
  const labels = order.map((index) => jokers[index]?.label || jokerKey(jokers[index]) || `#${index + 1}`);
  return {
    method: "rearrange",
    params: { jokers: order },
    reason: `Put Chips/+Mult before XMult: ${labels.join(" → ")}`.slice(0, 160),
  };
}

function addMult(score, value) {
  const amount = Number(value) || 0;
  score.mult += amount;
  score.effectiveMult += amount;
}

function applyXMult(score, value) {
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor < 1) return;
  score.effectiveMult *= factor;
  score.xMult *= factor;
}

function applyEdition(score, card) {
  const edition = cardModifier(card, "edition");
  if (edition.includes("FOIL")) score.chips += 50;
  if (edition.includes("HOLOGRAPHIC") || edition === "HOLO") addMult(score, 10);
  if (edition.includes("POLYCHROME")) applyXMult(score, 1.5);
}

function scoringJoker(joker) {
  if (jokerDebuffed(joker)) return false;
  const key = jokerKey(joker);
  if (KNOWN_SCORING_JOKERS.has(key)) return true;
  return /(?:\+\s*\d+\s*(?:筹码|倍率|倍|chips?|mult)|[x×]\s*\d+(?:\.\d+)?)/iu.test(cardEffect(joker));
}

export function balatrobotIsScoringJoker(joker) {
  return scoringJoker(joker);
}

function cardBuyPrice(card) {
  const value = Number(card?.cost?.buy ?? card?.buy);
  return Number.isFinite(value) ? Math.max(0, value) : Number.POSITIVE_INFINITY;
}

function cardSellPrice(card) {
  const value = Number(card?.cost?.sell ?? card?.sell);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function firstDefined(values) {
  return values.find((value) => value !== undefined && value !== null);
}

function finiteStickerTally(value) {
  if (typeof value === "boolean" || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function jokerStickerProfile(card) {
  const modifier = card?.modifier && typeof card.modifier === "object" ? card.modifier : {};
  const cardState = card?.state && typeof card.state === "object" ? card.state : {};
  const rawPerishable = firstDefined([
    modifier.perishable,
    modifier.isPerishable,
    modifier.is_perishable,
    cardState.perishable,
    cardState.isPerishable,
    cardState.is_perishable,
    card?.perishable,
    card?.isPerishable,
    card?.is_perishable,
  ]);
  const explicitTally = firstDefined([
    modifier.perishable_tally,
    modifier.perishableTally,
    cardState.perishable_tally,
    cardState.perishableTally,
    card?.perishable_tally,
    card?.perishableTally,
  ]);
  const perishableTally = finiteStickerTally(explicitTally) ?? finiteStickerTally(rawPerishable);
  const perishable = rawPerishable === true || perishableTally !== null;
  const rental = Boolean(modifier.rental ?? card?.rental);
  const configuredRentalRate = Number(firstDefined([
    modifier.rental_rate,
    modifier.rentalRate,
    cardState.rental_rate,
    cardState.rentalRate,
    card?.rental_rate,
    card?.rentalRate,
  ]));
  return {
    eternal: Boolean(modifier.eternal ?? card?.eternal),
    perishable,
    // Do not use a truthiness fallback here: zero is the exact expired tally.
    perishableTally,
    rental,
    rentalRate: rental && Number.isFinite(configuredRentalRate) && configuredRentalRate >= 0
      ? configuredRentalRate
      : rental ? DEFAULT_RENTAL_RATE : 0,
  };
}

function compactJokerStickers(card) {
  const stickers = jokerStickerProfile(card);
  return {
    eternal: stickers.eternal,
    perishable: stickers.perishableTally ?? (stickers.perishable ? true : null),
    perishableTally: stickers.perishableTally,
    rental: stickers.rental,
    rentalRate: stickers.rentalRate,
  };
}

function expectedJokerHoldBlinds(state, { eternal = false } = {}) {
  const configured = Number(firstDefined([
    state?.shop_strategy?.expected_hold_blinds,
    state?.shopStrategy?.expectedHoldBlinds,
    state?.expected_joker_hold_blinds,
    state?.expectedJokerHoldBlinds,
  ]));
  if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.min(24, Math.floor(configured)));
  const ante = Math.max(1, Number(state?.ante_num ?? state?.ante) || 1);
  const ordinaryHorizon = ante <= 3 ? 6 : ante <= 6 ? 4 : 2;
  if (!eternal) return ordinaryHorizon;
  // Eternal cards cannot be replaced later, so value their occupied slot over
  // at least the remainder of the Ante-8 clear objective.
  return Math.max(ordinaryHorizon, Math.min(24, (8 - Math.min(8, ante)) * 3 + 2));
}

function projectedRentalUpkeep(state, { excludeJokerIndex = null, blinds = 1 } = {}) {
  const horizon = Math.max(0, Number(blinds) || 0);
  return cardsIn(state?.jokers).reduce((total, joker, index) => {
    if (index === excludeJokerIndex) return total;
    const stickers = jokerStickerProfile(joker);
    return total + (stickers.rental ? stickers.rentalRate * horizon : 0);
  }, 0);
}

function ownedConsumableAge(consumableAges, card) {
  const rawId = card?.id;
  if (rawId == null || rawId === "") return null;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 0) return null;
  const age = consumableAges?.byId?.[id];
  if (!age?.tracked || Number(age.id) !== id) return null;
  if (String(age.key ?? "") !== String(card?.key ?? "").trim().toLowerCase()) return null;
  return age;
}

function ownedConsumableSlotFull(state) {
  const owned = cardsIn(state?.consumables);
  const limit = Number(state?.consumables?.limit);
  return Number.isInteger(limit) && limit > 0 && owned.length >= limit;
}

function decorateOwnedConsumableCandidates(state, candidates, consumableAges) {
  const owned = cardsIn(state?.consumables);
  const slotFull = ownedConsumableSlotFull(state);
  return candidates.map((candidate) => {
    const index = Number(candidate?.action?.consumable);
    if (!Number.isInteger(index) || index < 0 || index >= owned.length) return candidate;
    const card = owned[index];
    const age = ownedConsumableAge(consumableAges, card);
    const blindAge = Number(age?.blindAge) || 0;
    const strategicReview = Boolean(age) && (
      blindAge >= CONSUMABLE_REVIEW_BLIND_AGE || (slotFull && blindAge >= 1)
    );
    return {
      ...candidate,
      card: { ...candidate.card, id: card?.id ?? null },
      ownershipTracked: Boolean(age),
      heldBlindAge: blindAge,
      firstSeenRound: age?.firstSeenRound ?? null,
      consumableSlotFull: slotFull,
      consumableStrategicReview: strategicReview,
      strategicReason: strategicReview
        ? `${candidate.strategicReason}; held across ${blindAge} blind transition(s)${slotFull ? " while consumable slots are full" : ""}`
        : candidate.strategicReason,
    };
  });
}

function agedConsumableHoldReviews(state, consumableAges, useCandidates = []) {
  const represented = new Set(
    (Array.isArray(useCandidates) ? useCandidates : [])
      .map((candidate) => Number(candidate?.action?.consumable))
      .filter(Number.isInteger),
  );
  const slotFull = ownedConsumableSlotFull(state);
  return inspectBalatroConsumables(state).flatMap((entry) => {
    if (represented.has(entry.index)) return [];
    const age = ownedConsumableAge(consumableAges, entry.card);
    const blindAge = Number(age?.blindAge) || 0;
    const strategicReview = Boolean(age) && (
      blindAge >= CONSUMABLE_REVIEW_BLIND_AGE || (slotFull && blindAge >= 1)
    );
    if (!strategicReview) return [];
    return [{
      card: {
        index: entry.index,
        id: entry.card?.id ?? null,
        key: entry.card?.key ?? "",
        label: entry.card?.label ?? entry.label ?? "",
        set: String(entry.card?.set ?? "").toUpperCase(),
        effect: cardEffect(entry.card),
      },
      ownershipTracked: true,
      heldBlindAge: blindAge,
      firstSeenRound: age.firstSeenRound ?? null,
      consumableSlotFull: slotFull,
      consumableStrategicReview: true,
      blockedReason: entry.blockedReason || "no currently valid local use target",
      strategicReason: `explicit hold review: held across ${blindAge} blind transition(s)${slotFull ? " while consumable slots are full" : ""}; no exact use action is currently legal`,
    }];
  });
}

function attachConsumableHoldReviews(candidates, reviews, preferredMethod) {
  if (!reviews.length) return candidates;
  const index = candidates.findIndex((candidate) => candidate.action?.method === preferredMethod);
  if (index < 0) return candidates;
  const selected = candidates[index];
  const updated = [...candidates];
  updated[index] = {
    ...selected,
    consumableStrategicReview: true,
    consumableHoldReviews: reviews,
    strategicReason: [
      selected.strategicReason,
      `${reviews.length} aged held consumable(s) need an explicit use/hold review`,
    ].filter(Boolean).join("; "),
  };
  return updated;
}

function protectedConsumableFromSale(card) {
  const set = String(card?.set ?? "").trim().toUpperCase();
  const key = String(card?.key ?? "").trim().toLowerCase();
  const edition = cardModifier(card, "edition");
  // Planets, Spectrals, suit conversion/rescue Tarot and economy/generation
  // Tarot are never even proposed for sale. Unknown cards fail closed too.
  return !key || set !== "TAROT" || !CONTROLLED_CONSUMABLE_SALE_KEYS.has(key) || edition.includes("NEGATIVE");
}

function generateAgedConsumableSaleCandidates(state, consumableAges) {
  if (!ownedConsumableSlotFull(state)) return [];
  return cardsIn(state?.consumables).flatMap((card, index) => {
    const age = ownedConsumableAge(consumableAges, card);
    if (!age || Number(age.blindAge) < CONSUMABLE_SALE_BLIND_AGE || protectedConsumableFromSale(card)) return [];
    const sellPrice = cardSellPrice(card);
    return [{
      id: `sell:consumable:${index}`,
      action: { method: "sell", consumable: index },
      card: {
        index,
        id: card.id,
        key: card.key ?? "",
        label: card.label ?? "",
        set: String(card.set ?? "").toUpperCase(),
        effect: cardEffect(card),
        sellPrice,
      },
      expectedValue: 330 + Math.min(5, Number(age.blindAge)) * 20 + sellPrice * 10,
      ownershipTracked: true,
      heldBlindAge: Number(age.blindAge),
      firstSeenRound: age.firstSeenRound ?? null,
      consumableSlotFull: true,
      consumableStrategicReview: true,
      fallbackSafe: false,
      eligibleForEmergency: false,
      requiresStrategic: true,
      strategicReason: `optional slot-pressure sale only: tracked across ${age.blindAge} blind transitions with all consumable slots full; preserve it unless a strategist verifies lower retention value`,
    }];
  });
}

function shopBudgetMetadata(state, { excludeJokerIndex = null, additionalUpkeep = 0 } = {}) {
  const money = Number(state?.money);
  const credit = cardsIn(state?.jokers).reduce((total, joker, index) =>
    total + (index !== excludeJokerIndex && jokerKey(joker) === "j_credit_card" && !jokerDebuffed(joker) ? 20 : 0), 0);
  const rentalUpkeep = projectedRentalUpkeep(state, { excludeJokerIndex, blinds: 1 });
  const twoBlindUpkeep = projectedRentalUpkeep(state, { excludeJokerIndex, blinds: 2 });
  // Negative balances are real Gold-stake state, and multiple Credit Cards
  // stack. Keep both facts intact while reserving the next Rental payment.
  const cash = Number.isFinite(money) ? money : 0;
  const newUpkeep = Math.max(0, Number(additionalUpkeep) || 0);
  return {
    cash,
    credit,
    legalLiquidity: cash + credit,
    rentalUpkeep,
    twoBlindUpkeep,
    projectedRentalUpkeep: twoBlindUpkeep,
    operatingReserve: twoBlindUpkeep,
    additionalUpkeep: newUpkeep,
    cashAfterNextUpkeep: cash - rentalUpkeep,
    available: cash + credit - twoBlindUpkeep - newUpkeep,
  };
}

function availableShopMoney(state, options = {}) {
  return shopBudgetMetadata(state, options).available;
}

function jokerSlotOccupancy(state) {
  const visibleCards = cardsIn(state?.jokers).length;
  const reportedCount = Number(state?.jokers?.count);
  return Number.isFinite(reportedCount)
    ? Math.max(visibleCards, Math.max(0, Math.floor(reportedCount)))
    : visibleCards;
}

function shopCardCanFit(state, card) {
  const set = String(card?.set ?? "").toUpperCase();
  if (set === "JOKER") {
    // Stable BalatroBot 1.5.2 rejects even a Negative Joker when the slot count
    // is full, so candidate generation must match the RPC validator exactly.
    return jokerSlotOccupancy(state) < Number(state?.jokers?.limit ?? 5);
  }
  if (TARGETED_CONSUMABLE_SETS.has(set) || set === "PLANET") {
    return Number(state?.consumables?.count ?? cardsIn(state?.consumables).length) < Number(state?.consumables?.limit ?? 2);
  }
  return true;
}

function highScoreStage(state) {
  const ante = Math.max(0, Number(state?.ante_num ?? state?.ante) || 0);
  if (ante <= 3) return "survival";
  if (ante <= 8) return "scaling";
  return "endless";
}

function jokerEngineTraits(joker) {
  const key = jokerKey(joker);
  const edition = cardModifier(joker, "edition");
  const xMult = X_MULT_ENGINE_JOKERS.has(key) || dynamicXValue(joker) > 1 || edition.includes("POLYCHROME");
  const retrigger = RETRIGGER_ENGINE_JOKERS.has(key);
  const copy = COPY_ENGINE_JOKERS.has(key);
  const scaling = SCALING_ENGINE_JOKERS.has(key);
  return {
    key,
    xMult,
    retrigger,
    copy,
    scaling,
    flatScoring: scoringJoker(joker) && !xMult && !retrigger && !copy && !scaling,
  };
}

function jokerFutureEngineWeight(state, joker) {
  if (jokerDebuffed(joker)) return 0;
  const stickers = jokerStickerProfile(joker);
  if (!stickers.perishable) return 1;
  const horizon = expectedJokerHoldBlinds(state);
  const remaining = stickers.perishableTally ?? DEFAULT_PERISHABLE_BLINDS;
  return horizon > 0 ? Math.max(0, Math.min(1, remaining / horizon)) : 0;
}

export function balatrobotHighScoreBuildProfile(state) {
  const stage = highScoreStage(state);
  const jokers = cardsIn(state?.jokers).filter((joker) => !jokerDebuffed(joker));
  const traits = jokers.map((joker) => ({
    ...jokerEngineTraits(joker),
    futureWeight: jokerFutureEngineWeight(state, joker),
  }));
  const keys = new Set(traits.map((trait) => trait.key));
  const levels = Object.values(state?.hands ?? state?.pokerHands ?? {})
    .map((hand) => Number(hand?.level) || 0);
  const peakHandLevel = Math.max(0, ...levels);
  const flatScoringSources = traits.filter((trait) => trait.flatScoring).length;
  const xMultSources = traits.filter((trait) => trait.xMult).length;
  const retriggerSources = traits.filter((trait) => trait.retrigger).length;
  const copySources = traits.filter((trait) => trait.copy).length;
  const scalingSources = traits.filter((trait) => trait.scaling).length;
  const futureFlatScoringSources = traits.reduce((total, trait) => total + (trait.flatScoring ? trait.futureWeight : 0), 0);
  const futureXMultSources = traits.reduce((total, trait) => total + (trait.xMult ? trait.futureWeight : 0), 0);
  const futureRetriggerSources = traits.reduce((total, trait) => total + (trait.retrigger ? trait.futureWeight : 0), 0);
  const futureCopySources = traits.reduce((total, trait) => total + (trait.copy ? trait.futureWeight : 0), 0);
  const futureScalingSources = traits.reduce((total, trait) => total + (trait.scaling ? trait.futureWeight : 0), 0);
  const stageWeights = stage === "survival"
    ? { flat: 2.4, x: 2.0, retrigger: 1.3, copy: 1.5, scaling: 1.2, level: 0.45 }
    : stage === "scaling"
      ? { flat: 0.9, x: 3.8, retrigger: 3.1, copy: 3.4, scaling: 2.6, level: 0.7 }
      : { flat: 0.25, x: 5.2, retrigger: 4.8, copy: 4.8, scaling: 3.1, level: 0.9 };
  const weightForKey = (key) => Math.max(0, ...traits.filter((trait) => trait.key === key).map((trait) => trait.futureWeight));
  let synergy = 0;
  if (keys.has("j_photograph") && keys.has("j_hanging_chad")) {
    synergy += 4 * Math.min(weightForKey("j_photograph"), weightForKey("j_hanging_chad"));
  }
  if (keys.has("j_baron") && keys.has("j_mime")) {
    synergy += 4 * Math.min(weightForKey("j_baron"), weightForKey("j_mime"));
  }
  if (futureCopySources && (futureXMultSources || futureRetriggerSources)) {
    synergy += 2.5 * Math.min(1, futureCopySources, Math.max(futureXMultSources, futureRetriggerSources));
  }
  if (futureXMultSources && futureRetriggerSources) synergy += 2 * Math.min(1, futureXMultSources, futureRetriggerSources);
  const engineScore = futureFlatScoringSources * stageWeights.flat +
    futureXMultSources * stageWeights.x +
    futureRetriggerSources * stageWeights.retrigger +
    futureCopySources * stageWeights.copy +
    futureScalingSources * stageWeights.scaling +
    Math.min(12, peakHandLevel) * stageWeights.level + synergy;
  const layers = {
    base: futureFlatScoringSources >= 0.5 || peakHandLevel >= 3,
    xMult: futureXMultSources >= 0.5,
    retrigger: futureRetriggerSources >= 0.5,
    copy: futureCopySources >= 0.5,
    scaling: futureScalingSources >= 0.5 || peakHandLevel >= 5,
  };
  const missing = Object.entries(layers).filter(([, present]) => !present).map(([name]) => name);
  return {
    stage,
    engineScore: Math.round(engineScore * 100) / 100,
    millionPotential: Math.round(Math.min(1, engineScore / (stage === "endless" ? 24 : 30)) * 1_000) / 1_000,
    flatScoringSources,
    xMultSources,
    retriggerSources,
    copySources,
    scalingSources,
    futureFlatScoringSources: Math.round(futureFlatScoringSources * 1_000) / 1_000,
    futureXMultSources: Math.round(futureXMultSources * 1_000) / 1_000,
    futureRetriggerSources: Math.round(futureRetriggerSources * 1_000) / 1_000,
    futureCopySources: Math.round(futureCopySources * 1_000) / 1_000,
    futureScalingSources: Math.round(futureScalingSources * 1_000) / 1_000,
    rentalUpkeepPerBlind: projectedRentalUpkeep(state),
    projectedRentalUpkeep: projectedRentalUpkeep(state, { blinds: expectedJokerHoldBlinds(state) }),
    expiringJokers: traits.filter((trait) => trait.futureWeight < 1).length,
    peakHandLevel,
    layers,
    missing,
  };
}

function stateWithJokers(state, jokers) {
  return {
    ...state,
    jokers: { ...(state?.jokers ?? {}), count: jokers.length, cards: jokers },
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function benchmarkScoreDelta(state, beforeJokers, afterJokers, benchmarks) {
  const deltas = [];
  for (const benchmark of Array.isArray(benchmarks) ? benchmarks : []) {
    if (!benchmark?.state || benchmark?.candidate?.action?.method !== "play") continue;
    const baseState = stateWithJokers(benchmark.state, beforeJokers);
    const hypotheticalState = stateWithJokers(benchmark.state, afterJokers);
    const beforeScore = estimateBalatrobotCandidateScore(baseState, benchmark.candidate)?.conservativeScore;
    const afterScore = estimateBalatrobotCandidateScore(hypotheticalState, benchmark.candidate)?.conservativeScore;
    if (!Number.isFinite(beforeScore) || !Number.isFinite(afterScore)) continue;
    deltas.push(Math.log10(Math.max(1, afterScore)) - Math.log10(Math.max(1, beforeScore)));
  }
  const scoreLogDelta = median(deltas);
  return {
    benchmarkSamples: deltas.length,
    scoreLogDelta: Math.round(scoreLogDelta * 1_000) / 1_000,
    scoreMultiplier: Math.round(10 ** scoreLogDelta * 1_000) / 1_000,
  };
}

function nextBlindTarget(state) {
  const ordered = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss].filter(Boolean);
  const next = ordered.find((blind) => {
    const status = String(blind?.status ?? "").toUpperCase();
    return !status.includes("DEFEATED") && !status.includes("SKIPPED") && !status.includes("DISABLED");
  });
  const target = Number(next?.score ?? next?.target);
  return {
    blind: next ?? null,
    target: Number.isFinite(target) ? Math.max(0, target) : 0,
  };
}

function nextBlindHandCapacity(state, blind) {
  const blindName = String(blind?.name ?? "").trim().toLowerCase();
  if (blindName === "the needle" || blindName === "needle") return 1;
  let capacity = 4;
  const deck = String(state?.deck?.key ?? state?.deck?.name ?? state?.deck ?? "").toLowerCase();
  if (/(?:^|[_\s])blue(?:[_\s]|$)/u.test(deck)) capacity += 1;
  if (/(?:^|[_\s])black(?:[_\s]|$)/u.test(deck)) capacity -= 1;
  const voucherKeys = new Set(Object.keys(state?.used_vouchers ?? state?.usedVouchers ?? {}));
  if (voucherKeys.has("v_grabber")) capacity += 1;
  if (voucherKeys.has("v_nacho_tong")) capacity += 1;
  if (cardsIn(state?.jokers).some((joker) => jokerKey(joker) === "j_burglar")) capacity += 3;
  return Math.max(1, capacity);
}

function jokerImmediateSurvivalEvidence(state, card, benchmarks = []) {
  const owned = cardsIn(state?.jokers);
  const { blind, target } = nextBlindTarget(state);
  const beforeScores = [];
  const afterScores = [];
  for (const benchmark of Array.isArray(benchmarks) ? benchmarks : []) {
    if (!benchmark?.state || benchmark?.candidate?.action?.method !== "play") continue;
    const baseState = stateWithJokers(benchmark.state, owned);
    const hypotheticalState = stateWithJokers(benchmark.state, [...owned, card]);
    const before = estimateBalatrobotCandidateScore(baseState, benchmark.candidate)?.conservativeScore;
    const after = estimateBalatrobotCandidateScore(hypotheticalState, benchmark.candidate)?.conservativeScore;
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    beforeScores.push(before);
    afterScores.push(after);
  }
  // The next Blind owns the hand cap. Historical benchmark states may have
  // four hands, but The Needle still permits exactly one.
  const hands = nextBlindHandCapacity(state, blind);
  const beforePerHand = median(beforeScores);
  const afterPerHand = median(afterScores);
  const beforeCapacity = beforePerHand * hands;
  const afterCapacity = afterPerHand * hands;
  const bossUncertainty = String(blind?.type ?? "").toUpperCase() === "BOSS";
  const proven = !bossUncertainty && target > 0 && beforeScores.length > 0 && beforeCapacity < target && afterCapacity >= target;
  return {
    proven,
    samples: beforeScores.length,
    blind: blind?.name ?? blind?.type ?? null,
    target,
    hands,
    beforeCapacity: Math.round(beforeCapacity),
    afterCapacity: Math.round(afterCapacity),
    bossUncertainty,
  };
}

function jokerRemovalEvidence(state, removedIndex, benchmarks = []) {
  const owned = cardsIn(state?.jokers);
  const afterJokers = owned.filter((_, index) => index !== removedIndex);
  const { blind, target } = nextBlindTarget(state);
  const hands = nextBlindHandCapacity(state, blind);
  const beforeScores = [];
  const afterScores = [];
  for (const benchmark of Array.isArray(benchmarks) ? benchmarks : []) {
    if (!benchmark?.state || benchmark?.candidate?.action?.method !== "play") continue;
    const before = estimateBalatrobotCandidateScore(
      stateWithJokers(benchmark.state, owned),
      benchmark.candidate,
    )?.conservativeScore;
    const after = estimateBalatrobotCandidateScore(
      stateWithJokers(benchmark.state, afterJokers),
      benchmark.candidate,
    )?.conservativeScore;
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    beforeScores.push(before);
    afterScores.push(after);
  }
  const beforeCapacity = median(beforeScores) * hands;
  const afterCapacity = median(afterScores) * hands;
  const beforeProfile = balatrobotHighScoreBuildProfile(state);
  const afterProfile = balatrobotHighScoreBuildProfile(stateWithJokers(state, afterJokers));
  return {
    samples: beforeScores.length,
    blind: blind?.name ?? blind?.type ?? null,
    target,
    hands,
    beforeCapacity: Math.round(beforeCapacity),
    afterCapacity: Math.round(afterCapacity),
    currentLineCanClear: target > 0 && beforeScores.length > 0 && beforeCapacity >= target,
    afterRemovalCanClear: target > 0 && beforeScores.length > 0 && afterCapacity >= target,
    breaksImmediateSurvival: target > 0 && beforeScores.length > 0 && beforeCapacity >= target && afterCapacity < target,
    engineLoss: Math.round(Math.max(0, beforeProfile.engineScore - afterProfile.engineScore) * 1_000) / 1_000,
  };
}

function eternalSlotUtilityCost(state) {
  const owned = jokerSlotOccupancy(state);
  const limit = Math.max(1, Number(state?.jokers?.limit) || 5);
  const occupancy = Math.min(1, (owned + 1) / limit);
  return Math.round(80 + occupancy * 120);
}

function stickerAwareJokerValuation(state, card, baseValue, { immediateSurvival = null } = {}) {
  const stickers = jokerStickerProfile(card);
  const expectedHoldBlinds = expectedJokerHoldBlinds(state, { eternal: stickers.eternal });
  const remainingPerishableBlinds = stickers.perishable
    ? stickers.perishableTally ?? DEFAULT_PERISHABLE_BLINDS
    : null;
  const effectiveHoldBlinds = stickers.perishable
    ? Math.min(expectedHoldBlinds, remainingPerishableBlinds)
    : expectedHoldBlinds;
  const lifespanDiscount = expectedHoldBlinds > 0 ? effectiveHoldBlinds / expectedHoldBlinds : 0;
  const projectedRentalCost = stickers.rental ? stickers.rentalRate * effectiveHoldBlinds : 0;
  const eternalSlotCost = stickers.eternal ? eternalSlotUtilityCost(state) : 0;
  const upfrontCost = cardBuyPrice(card);
  const discountedBenefit = Math.max(0, Number(baseValue) || 0) * lifespanDiscount;
  const netPresentValue = discountedBenefit -
    (Number.isFinite(upfrontCost) ? upfrontCost * SHOP_DOLLAR_UTILITY : 0) -
    projectedRentalCost * SHOP_DOLLAR_UTILITY -
    eternalSlotCost;
  // Eternal+Rental is irreversible recurring debt. Local hand benchmarks do
  // not model every upcoming Boss rule (for example The Plant debuffing the
  // face card that powers Photograph), so there is no safe local exception.
  const immediateSurvivalException = false;
  return {
    ...stickers,
    baseValue: Math.round((Number(baseValue) || 0) * 100) / 100,
    expectedHoldBlinds,
    effectiveHoldBlinds,
    remainingPerishableBlinds,
    lifespanDiscount: Math.round(lifespanDiscount * 1_000) / 1_000,
    upfrontCost: Number.isFinite(upfrontCost) ? upfrontCost : null,
    projectedRentalCost,
    eternalSlotCost,
    netPresentValue: Math.round(netPresentValue * 100) / 100,
    hardRejected: stickers.eternal && stickers.rental,
    immediateSurvivalException,
    immediateSurvival: immediateSurvival ?? null,
  };
}

function jokerPurchaseCounterfactual(state, card, benchmarks = []) {
  const owned = cardsIn(state?.jokers);
  const before = balatrobotHighScoreBuildProfile(state);
  const afterJokers = [...owned, card];
  const after = balatrobotHighScoreBuildProfile(stateWithJokers(state, afterJokers));
  const capability = balatrobotJokerCapability(card, state);
  return {
    stage: before.stage,
    engineDelta: Math.round((after.engineScore - before.engineScore) * 100) / 100,
    ...benchmarkScoreDelta(state, owned, afterJokers, benchmarks),
    before,
    after,
    capability,
    immediateSurvival: jokerImmediateSurvivalEvidence(state, card, benchmarks),
  };
}

function readableBlindTag(blind) {
  const value = firstDefined([
    blind?.tag?.name,
    blind?.tagName,
    blind?.tag_name,
    blind?.tag?.effect,
    blind?.tagEffect,
    blind?.tag_effect,
  ]);
  return String(value ?? "").trim();
}

function blindSelectionEconomy(state, blind) {
  const stake = String(state?.stake ?? "WHITE").trim().toUpperCase() || "WHITE";
  const type = String(blind?.type ?? "").trim().toUpperCase();
  const fixedSmallReward = type === "SMALL" && RED_OR_HIGHER_STAKES.has(stake) ? 0 : null;
  const explicitReward = Number(firstDefined([blind?.reward, blind?.dollars, blind?.money]));
  const defaultReward = type === "SMALL" ? 3 : type === "BIG" ? 4 : type === "BOSS" ? 5 : 0;
  const blindReward = fixedSmallReward ?? (Number.isFinite(explicitReward) ? Math.max(0, explicitReward) : defaultReward);
  const hands = Math.max(0, Number(state?.round?.hands_left) || 0);
  return {
    stake,
    blindType: type || null,
    blindReward,
    smallBlindReward: type === "SMALL" ? blindReward : null,
    remainingHandDollarRate: 1,
    maximumRemainingHandMoney: hands,
    shopAccessAfterPlay: true,
    forfeitsShopOnSkip: true,
  };
}

function blindEconomyReason(blind, economy) {
  const name = blind?.name || blind?.type || "current blind";
  const smallReward = economy.blindType === "SMALL"
    ? `Small Blind fixed reward is $${economy.smallBlindReward} on ${economy.stake}`
    : `${name} fixed reward is $${economy.blindReward}`;
  return `${smallReward}; playing keeps the post-blind shop and can earn up to $${economy.maximumRemainingHandMoney} from unused hands; skipping forfeits that reward, unused-hand money, and the shop`;
}

function generateBlindSelectCandidates(state) {
  if (state?.state !== "BLIND_SELECT") return [];
  const blind = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss]
    .filter(Boolean)
    .find((item) => String(item?.status ?? "").toUpperCase().includes("SELECT"));
  const economy = blindSelectionEconomy(state, blind);
  const economyReason = blindEconomyReason(blind, economy);
  const candidates = [{
    id: "select:current",
    action: { method: "select" },
    target: `challenge ${blind?.name || blind?.type || "the current blind"}`,
    expectedValue: 1_000,
    economy,
    strategicReason: economyReason,
  }];
  const blindType = String(blind?.type ?? "").toUpperCase();
  const tag = readableBlindTag(blind);
  const ante = Number(state?.ante_num ?? state?.ante);
  const activeJokers = cardsIn(state?.jokers).filter((joker) => !jokerDebuffed(joker)).length;
  const matureBuild = activeJokers >= 3 && balatrobotScoringJokerCount(state) >= 2;
  const skipContractSatisfied = blindType !== "BOSS" &&
    Number.isFinite(ante) && ante >= 2 &&
    HIGH_VALUE_BLIND_TAG_PATTERN.test(tag) &&
    matureBuild;
  if (skipContractSatisfied) {
    candidates.push({
      id: "skip:current",
      action: { method: "skip" },
      target: `skip ${blind?.name || blind?.type || "the current blind"} for ${tag}`,
      expectedValue: 560,
      economy,
      tag,
      skipEligibility: { ante, activeJokers, scoringJokers: balatrobotScoringJokerCount(state), highValueTag: true, matureBuild },
      requiresStrategic: true,
      fallbackSafe: false,
      strategicReason: `Skipping for ${tag} requires a fresh strategic tag evaluation; ${economyReason}`,
    });
  }
  const vouchers = state?.used_vouchers && typeof state.used_vouchers === "object"
    ? state.used_vouchers
    : {};
  const hasRetcon = Object.hasOwn(vouchers, "v_retcon");
  const hasDirectorsCut = Object.hasOwn(vouchers, "v_directors_cut");
  const boss = state?.blinds?.boss ?? (String(blind?.type ?? "").toUpperCase() === "BOSS" ? blind : null);
  const bossRestriction = String(boss?.effect ?? boss?.description ?? "").trim();
  const legalLiquidity = shopBudgetMetadata(state).legalLiquidity;
  if (
    blindType === "BOSS" &&
    legalLiquidity >= 10 &&
    (hasRetcon || (hasDirectorsCut && state?.boss_rerolled !== true)) &&
    (bossRestriction || String(boss?.name ?? "").trim())
  ) {
    candidates.push({
      id: "reroll_boss:current",
      action: { method: "reroll_boss" },
      target: `spend $10 to replace ${boss?.name || "the current Boss Blind"}`,
      expectedValue: bossRestriction ? 850 : 320,
      requiresStrategic: true,
      strategicReason: `Boss reroll changes the run matchup and costs $10${bossRestriction ? `: ${bossRestriction}` : ""}`,
    });
  }
  return candidates;
}

function recurringJokerIncomePerBlind(joker) {
  const effect = cardEffect(joker);
  const matches = [
    /(?:end of (?:the )?(?:round|blind)|round ends?).{0,24}\$(\d+(?:\.\d+)?)/iu,
    /(?:每(?:个)?回合结束|回合结束时).{0,24}\$(\d+(?:\.\d+)?)/u,
    /(?:earn|gain|获得).{0,12}\$(\d+(?:\.\d+)?).{0,24}(?:round|blind|回合)/iu,
  ];
  for (const pattern of matches) {
    const value = Number(effect.match(pattern)?.[1]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function hasUnquantifiedRecurringEconomy(joker, parsedIncome) {
  if (parsedIncome > 0) return false;
  if (RECURRING_ECONOMY_JOKERS.has(jokerKey(joker))) return true;
  const effect = cardEffect(joker);
  return /(?:earn|gain|give|payout|interest|money|cash|dollars?|\$\s*\d)/iu.test(effect);
}

function generateJokerStopLossSaleCandidates(state, benchmarks = []) {
  return cardsIn(state?.jokers).flatMap((joker, index) => {
    const stickers = jokerStickerProfile(joker);
    if (stickers.eternal) return [];
    const expired = stickers.perishable && (
      stickers.perishableTally === 0 || jokerDebuffed(joker)
    );
    const nearExpiry = stickers.perishable && stickers.perishableTally !== null && stickers.perishableTally <= 1;
    if (!stickers.rental && !expired && !nearExpiry) return [];
    const expectedHoldBlinds = expectedJokerHoldBlinds(state);
    const avoidedRentalCost = stickers.rental ? stickers.rentalRate * expectedHoldBlinds : 0;
    const recurringIncome = recurringJokerIncomePerBlind(joker);
    const lostRecurringIncome = recurringIncome * expectedHoldBlinds;
    const uncertainEconomy = hasUnquantifiedRecurringEconomy(joker, recurringIncome);
    const netCashBenefit = avoidedRentalCost - lostRecurringIncome;
    const removal = jokerRemovalEvidence(state, index, benchmarks);
    if (!expired) {
      // Clearing one immediate Blind is not enough evidence to liquidate a
      // long-lived scoring/economy engine. Keep these fail-closed even when a
      // weaker line happens to clear the next target.
      if (scoringJoker(joker) || removal.engineLoss > 0.75 || uncertainEconomy) return [];
      if (lostRecurringIncome >= avoidedRentalCost) return [];
      if (removal.samples > 0 && !removal.afterRemovalCanClear) return [];
    }
    const sellPrice = cardSellPrice(joker);
    const reasons = [
      stickers.rental && `avoid about $${avoidedRentalCost} Rental upkeep over ${expectedHoldBlinds} expected blind(s)`,
      lostRecurringIncome > 0 && `lose about $${lostRecurringIncome} recurring income over the same horizon`,
      removal.engineLoss > 0 && `future engine score falls by ${removal.engineLoss}`,
      expired && "the Perishable Joker is already disabled",
      !expired && nearExpiry && `only ${stickers.perishableTally} Perishable blind remains`,
    ].filter(Boolean);
    return [{
      id: `sell:joker:${index}`,
      action: { method: "sell", joker: index },
      card: {
        index,
        id: joker?.id ?? null,
        key: joker?.key ?? "",
        label: joker?.label ?? "",
        set: "JOKER",
        effect: cardEffect(joker),
        sellPrice,
        ...compactJokerStickers(joker),
      },
      expectedValue: (expired ? 1_100 : nearExpiry ? 900 : 430) +
        netCashBenefit * 15 + sellPrice * 10 - removal.engineLoss * 180,
      stopLoss: {
        expired,
        nearExpiry,
        expectedHoldBlinds,
        avoidedRentalCost,
        lostRecurringIncome,
        uncertainEconomy,
        netCashBenefit,
        removal,
      },
      requiresStrategic: true,
      fallbackSafe: false,
      eligibleForEmergency: false,
      strategicReason: `Joker stop-loss review: ${reasons.join("; ")}`,
    }];
  });
}

function lowerQuartile(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).toSorted((left, right) => left - right);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.25)] : 0;
}

function jokerBuildSignature(state) {
  return cardsIn(state?.jokers)
    .map((joker) => [
      String(joker?.key ?? joker?.label ?? "").trim().toLowerCase(),
      cardModifier(joker, "edition").toLowerCase(),
      jokerDebuffed(joker) ? "debuff" : "active",
      cardEffect(joker).trim().toLowerCase(),
    ].join(":"))
    .filter(Boolean)
    .toSorted()
    .join("|");
}

function shopScoreEvidence(state, benchmarks) {
  const currentBuild = jokerBuildSignature(state);
  const recent = (Array.isArray(benchmarks)
    ? benchmarks
    : Array.isArray(state?.__scoreBenchmarks) ? state.__scoreBenchmarks : [])
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

function solverShopRerollBudget(state, benchmarks, shopBudget) {
  const { blind, target } = nextBlindTarget(state);
  const hands = state?.hands ?? state?.pokerHands ?? {};
  const playedHands = Object.entries(hands)
    .map(([name, hand]) => ({
      name,
      chips: Math.max(0, Number(hand?.chips) || 0),
      mult: Math.max(1, Number(hand?.mult) || 1),
      played: Math.max(0, Number(hand?.played) || 0),
    }))
    .filter((hand) => hand.played > 0);
  const repeatabilityOf = (hand) => new Map([
    ["high card", 1], ["pair", 0.9], ["two pair", 0.75], ["three of a kind", 0.65],
    ["straight", 0.45], ["flush", 0.45], ["full house", 0.35], ["four of a kind", 0.25],
    ["straight flush", 0.15], ["five of a kind", 0.2], ["flush house", 0.15], ["flush five", 0.12],
  ]).get(String(hand?.name ?? "").toLowerCase()) ?? 0.4;
  const representative = playedHands.toSorted(
    (left, right) => right.played - left.played || repeatabilityOf(right) - repeatabilityOf(left),
  )[0] ?? { name: "High Card", chips: 5, mult: 1, played: 0 };
  const scoringJokers = balatrobotScoringJokerCount(state);
  const activeJokers = cardsIn(state?.jokers).filter((joker) => !jokerDebuffed(joker)).length;
  const effectiveHands = nextBlindHandCapacity(state, blind);
  const repeatability = repeatabilityOf(representative);
  const basePerHand = Math.max(35, (representative.chips + 30) * representative.mult * repeatability);
  const recognitionFactor = 1 + Math.min(5, scoringJokers) * 0.45 + Math.max(0, activeJokers - scoringJokers) * 0.08;
  const proxyPerHand = Math.max(50, Math.round(basePerHand * recognitionFactor));
  const evidence = shopScoreEvidence(state, benchmarks);
  const estimatedPerHand = Math.max(proxyPerHand, Math.round(evidence.perHand));
  const estimatedRoundCapacity = Math.max(1, estimatedPerHand * effectiveHands);
  const pressure = target > 0 ? target / estimatedRoundCapacity : 0;
  // Debuffed/expired Perishable Jokers still occupy a physical slot. Active
  // Jokers are useful for score estimation only, never for slot accounting.
  const occupiedSlots = jokerSlotOccupancy(state);
  const openSlots = Math.max(0, (Number(state?.jokers?.limit) || occupiedSlots) - occupiedSlots);
  const rawRerollCost = firstDefined([state?.round?.reroll_cost, state?.round?.rerollCost]);
  const parsedRerollCost = Number(rawRerollCost);
  const rerollCostKnown = rawRerollCost !== undefined && rawRerollCost !== null &&
    Number.isFinite(parsedRerollCost) && parsedRerollCost >= 0;
  const rerollCost = rerollCostKnown ? parsedRerollCost : null;
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
  const voucherKeys = new Set(Object.keys(state?.used_vouchers ?? state?.usedVouchers ?? {}));
  const normalRerollCost = Math.max(
    1,
    5 - (voucherKeys.has("v_reroll_surplus") ? 2 : 0) - (voucherKeys.has("v_reroll_glut") ? 2 : 0),
  );
  const rerollsUsed = rerollCost > 0 ? Math.max(0, Math.round(rerollCost - normalRerollCost)) : 0;
  const remainingDesiredRerolls = Math.max(0, desiredRerolls - rerollsUsed);
  const survivalUrgency = Math.max(0, Math.min(1, (pressure - 0.75) / 3));
  const interestAndSafetyReserve = Math.round(15 - survivalUrgency * 10);
  const operatingReserve = shopBudget.twoBlindUpkeep;
  // Paid rerolls cannot borrow from Credit Card: match policy by using actual
  // non-negative cash after both reserves. A free reroll is the sole exception.
  const cash = Math.max(0, Number(state?.money) || 0);
  const spendable = Math.max(0, cash - interestAndSafetyReserve - operatingReserve);
  const requestedBudget = rerollCost > 0 ? remainingDesiredRerolls * rerollCost : 0;
  const budget = rerollCost > 0
    ? Math.floor(Math.min(spendable, requestedBudget) / rerollCost) * rerollCost
    : 0;
  return {
    blind: blind?.name ?? null,
    target,
    effectiveHands,
    estimatedPerHand,
    estimatedRoundCapacity,
    pressure: Math.round(pressure * 100) / 100,
    rerollCost,
    rerollCostKnown,
    desiredRerolls,
    remainingDesiredRerolls,
    interestAndSafetyReserve,
    operatingReserve,
    reserve: interestAndSafetyReserve + operatingReserve,
    spendable,
    budget,
    shouldReroll: rerollCostKnown && (rerollCost === 0 || budget >= rerollCost),
  };
}

export function generateBalatrobotShopCandidates(
  state,
  { limit = 16, benchmarks = [], includeConsumables = true, consumableAges = null } = {},
) {
  if (state?.state !== "SHOP") return [];
  const baseShopBudget = shopBudgetMetadata(state);
  const rerollDecision = solverShopRerollBudget(state, benchmarks, baseShopBudget);
  const shopBudget = {
    ...baseShopBudget,
    interestAndSafetyReserve: rerollDecision.interestAndSafetyReserve,
    reserve: rerollDecision.reserve,
    rerollBudget: rerollDecision.budget,
    rerollDecision,
  };
  const money = shopBudget.available;
  const candidates = [];
  for (const [index, card] of cardsIn(state?.shop).entries()) {
    const price = cardBuyPrice(card);
    const set = String(card?.set ?? "").toUpperCase();
    const counterfactual = set === "JOKER" ? jokerPurchaseCounterfactual(state, card, benchmarks) : null;
    const stickers = set === "JOKER" ? jokerStickerProfile(card) : null;
    const purchaseCommitment = price + (stickers?.rental ? stickers.rentalRate * 2 : 0);
    const requiredLiquidity = set === "JOKER" ? purchaseCommitment : price;
    if (requiredLiquidity > 0 && requiredLiquidity > money) continue;
    if (!shopCardCanFit(state, card)) continue;
    const baseExpectedValue = set === "JOKER"
      ? 420 + Math.max(0, counterfactual.engineDelta) * 95 +
        Math.max(0, counterfactual.scoreLogDelta) * 1_100 + (scoringJoker(card) ? 90 : 0)
      : 520;
    const stickerValuation = set === "JOKER"
      ? stickerAwareJokerValuation(state, card, baseExpectedValue, {
        immediateSurvival: counterfactual.immediateSurvival,
      })
      : null;
    if (stickerValuation?.hardRejected) continue;
    const stickerReason = stickerValuation && (stickerValuation.eternal || stickerValuation.perishable || stickerValuation.rental)
      ? [
        stickerValuation.eternal && `Eternal slot cost ${stickerValuation.eternalSlotCost}`,
        stickerValuation.perishable && `Perishable life ${stickerValuation.remainingPerishableBlinds} blind(s)`,
        stickerValuation.rental && `Rental $${stickerValuation.rentalRate}/blind, projected $${stickerValuation.projectedRentalCost}`,
      ].filter(Boolean).join("; ")
      : "";
    candidates.push({
      id: `buy:card:${index}`,
      action: { method: "buy", card: index },
      card: {
        index,
        id: card?.id ?? null,
        key: card?.key ?? "",
        label: card?.label ?? "",
        set,
        edition: cardModifier(card, "edition"),
        price,
        effect: cardEffect(card),
        ...(set === "JOKER" ? compactJokerStickers(card) : {}),
      },
      expectedValue: stickerValuation?.netPresentValue ?? baseExpectedValue,
      counterfactual,
      stickerValuation,
      shopBudget: {
        ...shopBudget,
        purchaseCommitment,
        availableAfterPurchase: money - purchaseCommitment,
      },
      requiresStrategic: true,
      fallbackSafe: false,
      tacticalConstraint: counterfactual?.capability?.constraint ?? null,
      strategicReason: [
        counterfactual?.capability
          ? `behavioral Joker requires a plan: ${counterfactual.capability.kind}`
          : "a shop purchase changes the build or economy",
        stickerReason,
      ].filter(Boolean).join("; "),
    });
  }
  if (includeConsumables) {
    const activeCredit = shopBudget.credit;
    const generatorState = shopBudget.legalLiquidity < 0
      ? { ...state, money: -activeCredit }
      : state;
    const buyUseCandidates = generateBalatroConsumableShopUseCandidates(generatorState, {
      evaluateBestPlay: (candidateState) => bestPlayCandidates(candidateState, 30)[0] ?? null,
      limit: Math.max(4, Math.min(12, Number(limit) || 16)),
    }).filter((candidate) => {
      const offered = cardsIn(state?.shop)[Number(candidate?.action?.card)];
      const price = cardBuyPrice(offered);
      return price === 0 || price <= money;
    }).map((candidate) => {
      const offered = cardsIn(state?.shop)[Number(candidate?.action?.card)];
      const price = cardBuyPrice(offered);
      return {
        ...candidate,
        card: { ...candidate.card, price },
        shopBudget: {
          ...shopBudget,
          purchaseCommitment: price,
          availableAfterPurchase: money - price,
        },
      };
    });
    candidates.push(...buyUseCandidates);
  }
  const ownedJokers = cardsIn(state?.jokers);
  const generatedStopLossSales = generateJokerStopLossSaleCandidates(state, benchmarks);
  const stopLossSaleIds = new Set(generatedStopLossSales.map((candidate) => candidate.id));
  candidates.push(...generatedStopLossSales);
  const jokerLimit = Number(state?.jokers?.limit ?? 5);
  if (ownedJokers.length >= jokerLimit) {
    const blockedOffers = cardsIn(state?.shop)
      .map((card, index) => ({ card, index, price: cardBuyPrice(card) }))
      .filter(({ card }) => String(card?.set ?? "").toUpperCase() === "JOKER");
    const currentProfile = balatrobotHighScoreBuildProfile(state);
    for (const [ownedIndex, owned] of ownedJokers.entries()) {
      if (jokerStickerProfile(owned).eternal || stopLossSaleIds.has(`sell:joker:${ownedIndex}`)) continue;
      const moneyAfterSale = availableShopMoney(state, { excludeJokerIndex: ownedIndex }) + cardSellPrice(owned);
      let bestReplacement = null;
      for (const offer of blockedOffers) {
        const offerStickers = jokerStickerProfile(offer.card);
        const immediateSurvival = jokerImmediateSurvivalEvidence(state, offer.card, benchmarks);
        if (offerStickers.eternal && offerStickers.rental) continue;
        const replacementCommitment = offer.price + (offerStickers.rental ? offerStickers.rentalRate * 2 : 0);
        if (replacementCommitment > 0 && replacementCommitment > moneyAfterSale) continue;
        const replacement = [...ownedJokers];
        replacement.splice(ownedIndex, 1, offer.card);
        const afterState = stateWithJokers(state, replacement);
        const after = balatrobotHighScoreBuildProfile(afterState);
        const gain = after.engineScore - currentProfile.engineScore;
        const scoreDelta = benchmarkScoreDelta(state, ownedJokers, replacement, benchmarks);
        const baseExpectedValue = 420 + Math.max(0, gain) * 95 + Math.max(0, scoreDelta.scoreLogDelta) * 1_100;
        const stickerValuation = stickerAwareJokerValuation(state, offer.card, baseExpectedValue, { immediateSurvival });
        const replacementValue = gain + scoreDelta.scoreLogDelta * 4 +
          (stickerValuation.netPresentValue - baseExpectedValue) / 100;
        if (!bestReplacement || replacementValue > bestReplacement.replacementValue) {
          bestReplacement = { ...offer, after, gain, replacementValue, scoreDelta, stickerValuation };
        }
      }
      if (!bestReplacement || bestReplacement.gain <= 0.75) continue;
      candidates.push({
        id: `sell:joker:${ownedIndex}`,
        action: { method: "sell", joker: ownedIndex },
        card: {
          index: ownedIndex,
          key: owned?.key ?? "",
          label: owned?.label ?? "",
          set: "JOKER",
          effect: cardEffect(owned),
          ...compactJokerStickers(owned),
        },
        replacement: {
          shopIndex: bestReplacement.index,
          id: bestReplacement.card?.id ?? null,
          key: bestReplacement.card?.key ?? "",
          label: bestReplacement.card?.label ?? "",
          edition: cardModifier(bestReplacement.card, "edition"),
          price: bestReplacement.price,
          ...compactJokerStickers(bestReplacement.card),
          engineDelta: Math.round(bestReplacement.gain * 100) / 100,
          ...bestReplacement.scoreDelta,
          stickerValuation: bestReplacement.stickerValuation,
        },
        expectedValue: 450 + bestReplacement.gain * 90,
        requiresStrategic: true,
        fallbackSafe: false,
        strategicReason: "selling a Joker is allowed only for a verified higher-ceiling replacement",
      });
    }
  }
  for (const [index, card] of cardsIn(state?.vouchers).entries()) {
    const price = cardBuyPrice(card);
    if (price > 0 && price > money) continue;
    const valuation = balatrobotVoucherValue(state, card, { price });
    candidates.push({
      id: `buy:voucher:${index}`,
      action: { method: "buy", voucher: index },
      card: { index, key: card?.key ?? "", label: card?.label ?? "", set: "VOUCHER", price, effect: cardEffect(card) },
      expectedValue: valuation.value,
      valuation,
      requiresStrategic: true,
      strategicReason: valuation.rationale,
    });
  }
  for (const [index, card] of cardsIn(state?.packs).entries()) {
    const price = cardBuyPrice(card);
    if (price > 0 && price > money) continue;
    candidates.push({
      id: `buy:pack:${index}`,
      action: { method: "buy", pack: index },
      card: { index, key: card?.key ?? "", label: card?.label ?? "", set: "BOOSTER", price, effect: cardEffect(card) },
      expectedValue: /mega/iu.test(String(card?.key ?? card?.label ?? "")) ? 700 : 480,
      requiresStrategic: true,
      strategicReason: "a booster purchase spends run economy",
    });
  }
  const rerollCost = rerollDecision.rerollCost;
  if (rerollDecision.shouldReroll) {
    candidates.push({
      id: "reroll:shop",
      action: { method: "reroll" },
      target: `search new shop offers for $${rerollCost}`,
      expectedValue: 300 + balatrobotHighScoreBuildProfile(state).missing.length * 45,
      shopBudget,
      rerollDecision,
      requiresStrategic: true,
      strategicReason: "reroll budget depends on score pressure and reserves",
    });
  }
  const hasStrategicOpportunity = candidates.some((candidate) => candidate.requiresStrategic);
  candidates.push({
    id: "next_round:shop",
    action: { method: "next_round" },
    target: "preserve money and leave the shop",
    expectedValue: 100,
    requiresStrategic: hasStrategicOpportunity,
    strategicReason: hasStrategicOpportunity ? "leaving a shop with affordable alternatives needs strategic approval" : "",
  });
  if (includeConsumables) {
    const ownedUseCandidates = decorateOwnedConsumableCandidates(state, generateBalatroConsumableUseCandidates(state, {
      evaluateBestPlay: (candidateState) => bestPlayCandidates(candidateState, 30)[0] ?? null,
      limit: Math.max(4, Math.min(12, Number(limit) || 16)),
    }), consumableAges);
    candidates.push(...ownedUseCandidates);
    candidates.push(...generateAgedConsumableSaleCandidates(state, consumableAges));
    const normalizedLimit = Math.max(1, Number(limit) || 16);
    const sorted = candidates
      .toSorted((left, right) => (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0) || left.id.localeCompare(right.id));
    const safeExit = sorted.find((candidate) => candidate.action?.method === "next_round") ?? null;
    const stopLossSales = sorted.filter((candidate) => candidate.stopLoss && candidate.action?.joker != null);
    const consumableSale = sorted.find((candidate) => candidate.action?.method === "sell" && candidate.action?.consumable != null) ?? null;
    const saleBudget = Math.max(0, normalizedLimit - 1);
    const preservedSales = [...stopLossSales, consumableSale]
      .filter((candidate, item, values) => candidate && values.indexOf(candidate) === item)
      .slice(0, saleBudget);
    const mandatory = normalizedLimit === 1
      ? [safeExit].filter(Boolean)
      : [...preservedSales, safeExit].filter((candidate, item, values) => candidate && values.indexOf(candidate) === item);
    const mandatoryIds = new Set(mandatory.map((candidate) => candidate.id));
    const selected = [
      ...sorted.filter((candidate) => !mandatoryIds.has(candidate.id)).slice(0, Math.max(0, normalizedLimit - mandatory.length)),
      ...mandatory,
    ];
    const holdReviews = agedConsumableHoldReviews(
      state,
      consumableAges,
      selected.filter((candidate) => candidate.action?.method === "use"),
    );
    return attachConsumableHoldReviews(
      selected.map((candidate) => ({ ...candidate, shopBudget: candidate.shopBudget ?? shopBudget })),
      holdReviews,
      "next_round",
    );
  }
  const normalizedLimit = Math.max(1, Number(limit) || 16);
  const sorted = candidates
    .toSorted((left, right) => (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0) || left.id.localeCompare(right.id));
  const safeExit = sorted.find((candidate) => candidate.action?.method === "next_round") ?? null;
  const preservedStopLossSales = sorted.filter((candidate) => candidate.stopLoss && candidate.action?.joker != null);
  const mandatory = normalizedLimit === 1
    ? [safeExit].filter(Boolean)
    : [...preservedStopLossSales.slice(0, normalizedLimit - 1), safeExit]
      .filter((candidate, item, values) => candidate && values.indexOf(candidate) === item);
  const mandatoryIds = new Set(mandatory.map((candidate) => candidate.id));
  return [
    ...sorted.filter((candidate) => !mandatoryIds.has(candidate.id)).slice(0, Math.max(0, normalizedLimit - mandatory.length)),
    ...mandatory,
  ].map((candidate) => ({ ...candidate, shopBudget: candidate.shopBudget ?? shopBudget }));
}

export function balatrobotScoringJokerCount(state) {
  return cardsIn(state?.jokers).filter(scoringJoker).length;
}

export function estimateBalatrobotCandidateScore(state, candidate) {
  if (!candidate || candidate.action?.method !== "play") return null;
  const cards = cardsIn(state?.hand);
  const selected = new Set(candidate.action.cards);
  const jokers = cardsIn(state?.jokers).filter((joker) => !jokerDebuffed(joker));
  const splash = jokers.some((joker) => jokerKey(joker) === "j_splash");
  const scoringIndices = splash ? candidate.action.cards : candidate.scoringCards;
  const scoring = scoringIndices.map((index) => ({ index, card: cards[index] }));
  const values = handValues(state, candidate.handType);
  const flint = String(activeBlind(state)?.name ?? "").trim().toLowerCase() === "the flint";
  const score = {
    chips: flint ? Math.max(1, Math.ceil(values.chips / 2)) : values.chips,
    mult: flint ? Math.max(1, Math.ceil(values.mult / 2)) : values.mult,
    effectiveMult: flint ? Math.max(1, Math.ceil(values.mult / 2)) : values.mult,
    xMult: 1,
    volatileXMult: 1,
    knownRetriggers: 0,
    knownRetriggerSources: new Set(),
  };
  const hangingChadCount = jokers.filter((joker) => jokerKey(joker) === "j_hanging_chad").length;
  const hackCount = jokers.filter((joker) => jokerKey(joker) === "j_hack").length;
  const sockCount = jokers.filter((joker) => jokerKey(joker) === "j_sock_and_buskin").length;
  const duskCount = Number(state?.round?.hands_left) === 1
    ? jokers.filter((joker) => jokerKey(joker) === "j_dusk").length
    : 0;
  const seltzerCount = jokers.filter((joker) => jokerKey(joker) === "j_selzer").length;
  const photographTarget = scoring.find(({ card }) => !cardDebuffed(card) && balatroCardIsFace(state, card))?.index;
  for (const { index, card } of scoring) {
    if (!card || cardDebuffed(card)) continue;
    const rank = rankNumber(cardRank(card));
    const redSeal = cardModifier(card, "seal").includes("RED") ? 1 : 0;
    const chad = index === scoring[0]?.index ? hangingChadCount * 2 : 0;
    const hack = rank >= 2 && rank <= 5 ? hackCount : 0;
    const sock = balatroCardIsFace(state, card) ? sockCount : 0;
    const repetitions = 1 + redSeal + chad + hack + sock + duskCount + seltzerCount;
    score.knownRetriggers += repetitions - 1;
    if (redSeal) score.knownRetriggerSources.add("red_seal");
    if (chad) score.knownRetriggerSources.add("j_hanging_chad");
    if (hack) score.knownRetriggerSources.add("j_hack");
    if (sock) score.knownRetriggerSources.add("j_sock_and_buskin");
    if (duskCount) score.knownRetriggerSources.add("j_dusk");
    if (seltzerCount) score.knownRetriggerSources.add("j_selzer");
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      score.chips += chipValue(card);
      const enhancement = cardModifier(card, "enhancement");
      if (enhancement.includes("BONUS")) score.chips += 30;
      if (enhancement.includes("MULT")) addMult(score, 4);
      // Glass is valuable upside, but it has repeatedly been a bad survival
      // lower bound in live runs. Keep it out of the conservative score while
      // still exposing its retriggered upside to the strategist.
      if (enhancement.includes("GLASS")) score.volatileXMult *= 2;
      applyEdition(score, card);

      for (const joker of jokers) {
        const key = jokerKey(joker);
        if (key === "j_odd_todd" && ODD_RANKS.has(rank)) score.chips += 31;
        else if (key === "j_even_steven" && EVEN_RANKS.has(rank)) addMult(score, 4);
        else if (key === "j_walkie_talkie" && WALKIE_TALKIE_RANKS.has(rank)) {
          score.chips += 10;
          addMult(score, 4);
        } else if (key === "j_fibonacci" && FIBONACCI_RANKS.has(rank)) addMult(score, 8);
        else if (key === "j_scholar" && rank === 14) {
          score.chips += 20;
          addMult(score, 4);
        } else if (key === "j_scary_face" && balatroCardIsFace(state, card)) score.chips += 30;
        else if ((key === "j_smiley" || key === "j_smiley_face") && balatroCardIsFace(state, card)) addMult(score, 5);
        else if (key === "j_photograph" && index === photographTarget) applyXMult(score, 2);
        else if (key === "j_greedy_joker" && balatroCardMatchesSuit(state, card, "D")) addMult(score, 3);
        else if (key === "j_lusty_joker" && balatroCardMatchesSuit(state, card, "H")) addMult(score, 3);
        else if (key === "j_wrathful_joker" && balatroCardMatchesSuit(state, card, "S")) addMult(score, 3);
        else if (key === "j_gluttenous_joker" && balatroCardMatchesSuit(state, card, "C")) addMult(score, 3);
      }
    }
  }

  const held = cards.filter((card, index) => !selected.has(index) && !cardDebuffed(card));
  const mimeCount = jokers.filter((joker) => jokerKey(joker) === "j_mime").length;
  for (const card of held) {
    const redSeal = cardModifier(card, "seal").includes("RED") ? 1 : 0;
    const repetitions = 1 + mimeCount + redSeal;
    score.knownRetriggers += repetitions - 1;
    if (mimeCount) score.knownRetriggerSources.add("j_mime");
    if (redSeal) score.knownRetriggerSources.add("red_seal");
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      if (cardModifier(card, "enhancement").includes("STEEL")) applyXMult(score, 1.5);
      if (rankNumber(cardRank(card)) === 13) {
        for (const joker of jokers) {
          if (jokerKey(joker) === "j_baron") applyXMult(score, 1.5);
        }
      }
    }
  }
  for (const joker of jokers) {
    const key = jokerKey(joker);
    applyEdition(score, joker);
    if (key === "j_joker") addMult(score, 4);
    else if (key === "j_jolly" && handHas(candidate, "Pair")) addMult(score, 8);
    else if (key === "j_zany" && handHas(candidate, "Three of a Kind")) addMult(score, 12);
    else if (key === "j_mad" && handHas(candidate, "Two Pair")) addMult(score, 10);
    else if (key === "j_crazy" && handHas(candidate, "Straight")) addMult(score, 12);
    else if (key === "j_droll" && handHas(candidate, "Flush")) addMult(score, 10);
    else if (key === "j_sly" && handHas(candidate, "Pair")) score.chips += 50;
    else if (key === "j_wily" && handHas(candidate, "Three of a Kind")) score.chips += 100;
    else if (key === "j_clever" && handHas(candidate, "Two Pair")) score.chips += 80;
    else if (key === "j_devious" && handHas(candidate, "Straight")) score.chips += 100;
    else if (key === "j_crafty" && handHas(candidate, "Flush")) score.chips += 80;
    else if (key === "j_half" && candidate.action.cards.length <= 3) addMult(score, 20);
    else if (key === "j_banner") score.chips += Math.max(0, Number(state?.round?.discards_left) || 0) * 30;
    else if (key === "j_mystic_summit" && Number(state?.round?.discards_left) === 0) addMult(score, 15);
    else if (key === "j_raised_fist" && held.length) {
      const heldRanks = held.map((card) => rankNumber(cardRank(card))).filter((rank) => rank > 0);
      if (heldRanks.length) addMult(score, Math.min(...heldRanks) * 2);
    } else if (key === "j_abstract") addMult(score, jokers.length * 3);
    else if (key === "j_gros_michel") addMult(score, 15);
    else if (key === "j_cavendish") applyXMult(score, 3);
    else if (key === "j_swashbuckler") {
      addMult(score, jokers.reduce(
        (sum, other) => sum + (other === joker ? 0 : Math.max(0, Number(other?.cost?.sell) || 0)),
        0,
      ));
    } else if (key === "j_blue_joker") score.chips += Math.max(0, Number(state?.cards?.count) || cardsIn(state?.cards).length) * 2;
    else if (key === "j_stuntman") score.chips += 250;
    else if (key === "j_bootstraps") addMult(score, Math.floor(Math.max(0, Number(state?.money) || 0) / 5) * 2);
    else if (key === "j_bull") score.chips += Math.max(0, Number(state?.money) || 0) * 2;
    else if (key === "j_supernova") addMult(
      score,
      Math.max(0, Number(state?.hands?.[candidate.handType]?.played) || 0) + 1,
    );
    else if (DYNAMIC_MULT_JOKERS.has(key)) {
      let value = dynamicAdditiveValue(joker);
      if (key === "j_green_joker") value += 1;
      if (key === "j_ride_the_bus") {
        value = scoring.some(({ card }) => !cardDebuffed(card) && balatroCardIsFace(state, card)) ? 0 : value + 1;
      }
      addMult(score, value);
    } else if (key === "j_ice_cream" || key === "j_square") {
      score.chips += dynamicAdditiveValue(joker) + (key === "j_square" && candidate.action.cards.length === 4 ? 4 : 0);
    }
    else if (key === "j_hologram" || key === "j_vampire" || key === "j_ramen") applyXMult(score, dynamicXValue(joker));
    else if (
      key === "j_blackboard" && held.length &&
      held.every((card) => balatroCardMatchesSuit(state, card, "S") || balatroCardMatchesSuit(state, card, "C"))
    ) applyXMult(score, 3);
    else if (key === "j_card_sharp" && Number(state?.hands?.[candidate.handType]?.played_this_round) > 0) applyXMult(score, 3);
    else if (key === "j_acrobat" && Number(state?.round?.hands_left) === 1) applyXMult(score, 3);
    else if (key === "j_flower_pot") {
      const activeCards = scoring.filter(({ card }) => !cardDebuffed(card)).map(({ card }) => card);
      if (cardsCanCoverDistinctSuits(state, activeCards, ["S", "H", "D", "C"])) {
        applyXMult(score, 3);
      }
    }
  }

  const conservativeScore = Math.max(0, Math.floor(score.chips * Math.max(0, score.effectiveMult)));
  const optimisticScore = Math.max(0, Math.floor(conservativeScore * Math.max(1, score.volatileXMult)));
  return {
    conservativeScore,
    estimatedScore: conservativeScore,
    optimisticScore,
    chips: Math.round(score.chips * 100) / 100,
    mult: Math.round(score.mult * 100) / 100,
    xMult: Math.round(score.xMult * 1_000) / 1_000,
    volatileXMult: Math.round(score.volatileXMult * 1_000) / 1_000,
    knownScoringJokers: jokers.filter((joker) => KNOWN_SCORING_JOKERS.has(jokerKey(joker))).length,
    knownRetriggers: score.knownRetriggers,
    knownRetriggerSources: [...score.knownRetriggerSources].toSorted(),
    totalActiveJokers: jokers.length,
  };
}

// Flower Pot needs four distinct scoring cards. A Wild card may stand in for
// one missing suit, but the same physical card cannot satisfy several suits.
function cardsCanCoverDistinctSuits(state, cards, suits) {
  const options = suits
    .map((suit) => ({
      suit,
      indices: cards
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => balatroCardMatchesSuit(state, card, suit))
        .map(({ index }) => index),
    }))
    .toSorted((left, right) => left.indices.length - right.indices.length);
  const used = new Set();
  const assign = (position) => {
    if (position >= options.length) return true;
    for (const index of options[position].indices) {
      if (used.has(index)) continue;
      used.add(index);
      if (assign(position + 1)) return true;
      used.delete(index);
    }
    return false;
  };
  return assign(0);
}

function combinations(count, maximum) {
  const result = [];
  const visit = (start, picked) => {
    if (picked.length) result.push([...picked]);
    if (picked.length >= maximum) return;
    for (let index = start; index < count; index++) {
      picked.push(index);
      visit(index + 1, picked);
      picked.pop();
    }
  };
  visit(0, []);
  return result;
}

function handValues(state, handType) {
  const live = state?.hands?.[handType] ?? state?.pokerHands?.[handType];
  const fallback = BASE_HANDS[handType];
  return {
    chips: Number.isFinite(Number(live?.chips)) ? Number(live.chips) : fallback.chips,
    mult: Number.isFinite(Number(live?.mult)) ? Number(live.mult) : fallback.mult,
  };
}

function playCandidate(state, cards, indices) {
  const classified = classifyBalatroHand(state, cards, indices);
  const values = handValues(state, classified.handType);
  const scoringChips = classified.scoringCards.reduce((sum, index) => sum + chipValue(cards[index]), 0);
  const fillerValue = classified.cycleFillers.reduce((sum, index) => sum + rankNumber(cardRank(cards[index])), 0);
  const candidate = {
    id: `play:${indices.join(",")}`,
    action: { method: "play", cards: indices },
    handType: classified.handType,
    scoringCards: classified.scoringCards,
    cycleFillers: classified.cycleFillers,
    rulesApplied: classified.rulesApplied,
    baseScoreBeforeEffects: (values.chips + scoringChips) * values.mult,
    debuffedScoringCards: classified.scoringCards.filter((index) => cardDebuffed(cards[index])),
    fillerValue,
  };
  return { ...candidate, ...estimateBalatrobotCandidateScore(state, candidate) };
}

function playSort(left, right) {
  return (
    (right.conservativeScore ?? right.baseScoreBeforeEffects) - (left.conservativeScore ?? left.baseScoreBeforeEffects) ||
    HAND_STRENGTH[right.handType] - HAND_STRENGTH[left.handType] ||
    left.cycleFillers.length - right.cycleFillers.length ||
    left.fillerValue - right.fillerValue ||
    left.id.localeCompare(right.id)
  );
}

function bestPlayCandidates(state, maximum) {
  const cards = cardsIn(state?.hand);
  if (!cards.length) return [];
  const highlighted = Number(state?.hand?.highlighted_limit);
  const limit = Math.min(cards.length, Number.isInteger(highlighted) && highlighted > 0 ? highlighted : 5, 5);
  const all = combinations(cards.length, limit)
    .map((indices) => playCandidate(state, cards, indices))
    .filter((candidate) => bossAllowsPlayCandidate(state, candidate));
  const byType = new Map();
  for (const candidate of all) {
    if (!byType.has(candidate.handType)) byType.set(candidate.handType, []);
    byType.get(candidate.handType).push(candidate);
  }
  const selected = [];
  const add = (candidate) => {
    if (candidate && !selected.some((item) => item.id === candidate.id)) selected.push(candidate);
  };
  for (const group of byType.values()) {
    group.sort(playSort);
    add(group[0]);
    const bestCore = group.toSorted(
      (left, right) =>
        (right.conservativeScore ?? right.baseScoreBeforeEffects) - (left.conservativeScore ?? left.baseScoreBeforeEffects) ||
        left.action.cards.length - right.action.cards.length ||
        left.fillerValue - right.fillerValue,
    )[0];
    add(bestCore);
    const bestCycle = group.toSorted(
      (left, right) =>
        (right.conservativeScore ?? right.baseScoreBeforeEffects) - (left.conservativeScore ?? left.baseScoreBeforeEffects) ||
        right.action.cards.length - left.action.cards.length ||
        left.fillerValue - right.fillerValue,
    )[0];
    add(bestCycle);
  }
  return selected.toSorted(playSort).slice(0, maximum).map(({ fillerValue: _fillerValue, ...candidate }) => candidate);
}

function playedThisRound(state, handType) {
  const values = [state?.hands?.[handType], state?.pokerHands?.[handType]]
    .filter(Boolean)
    .map((hand) => Number(hand?.played_this_round ?? hand?.playedThisRound) || 0);
  return values.length ? Math.max(...values) : 0;
}

export function balatrobotMouthLockedHandType(state) {
  const boss = String(activeBlind(state)?.name ?? "").trim().toLowerCase();
  if (boss !== "the mouth") return null;
  const explicit = String(
    activeBlind(state)?.only_hand ?? activeBlind(state)?.onlyHand ?? state?.__mouthLockedHandType ?? "",
  ).trim();
  if (explicit) return explicit;
  const handTypes = new Set([
    ...Object.keys(state?.hands ?? {}),
    ...Object.keys(state?.pokerHands ?? {}),
  ]);
  const positive = [...handTypes].filter((handType) => playedThisRound(state, handType) > 0);
  // Without an explicit/latched value, multiple positives are ambiguous: a
  // zero-score off-type play may have incremented another counter. Never infer
  // the original lock from the largest cumulative count.
  return positive.length === 1 ? positive[0] : positive.length > 1 ? AMBIGUOUS_MOUTH_LOCK : null;
}

function bossAllowsPlayCandidate(state, candidate) {
  const boss = String(activeBlind(state)?.name ?? "").trim().toLowerCase();
  if (boss === "the psychic" && candidate.action.cards.length !== 5) return false;
  if (boss === "the eye" && playedThisRound(state, candidate.handType) > 0) return false;
  if (boss === "the mouth") {
    const locked = balatrobotMouthLockedHandType(state);
    if (locked && candidate.handType !== locked) return false;
  }
  if (boss === "the cerulean bell") {
    const forced = cardsIn(state?.hand)
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => Boolean(card?.state?.highlight ?? card?.highlight))
      .map(({ index }) => index);
    if (forced.some((index) => !candidate.action.cards.includes(index))) return false;
  }
  return true;
}

function discardBuildBonus(state, target) {
  const normalized = String(target ?? "").toLowerCase();
  let bonus = 0;
  for (const joker of cardsIn(state?.jokers)) {
    const key = jokerKey(joker);
    if (key === "j_crazy" && normalized.includes("straight")) bonus += 650;
    else if (key === "j_droll" && normalized.includes("flush")) bonus += 650;
    else if (key === "j_mad" && /two-pair|full-house/.test(normalized)) bonus += 650;
    else if (key === "j_zany" && /trips|full-house|four-kind/.test(normalized)) bonus += 500;
    else if (key === "j_jolly" && /pair|two-pair|full-house|trips/.test(normalized)) bonus += 300;
    else if (key === "j_card_sharp") {
      const repeated = Object.keys(state?.hands ?? state?.pokerHands ?? {}).find((handType) => playedThisRound(state, handType) > 0);
      if (repeated && normalized.includes(repeated.toLowerCase().replaceAll(" ", "-"))) bonus += 900;
    }
  }
  return bonus;
}

function discardCandidate(state, cards, indices, target, outs, keptCards, pursuesHandTypes = []) {
  const sorted = [...indices].sort((left, right) => left - right);
  const kept = [...keptCards].sort((left, right) => left - right);
  const debuffedDiscarded = sorted.filter((index) => cardDebuffed(cards[index])).length;
  const debuffedKept = kept.filter((index) => cardDebuffed(cards[index])).length;
  let madeScore = 0;
  if (kept.length) {
    const immediate = playCandidate(state, cards, kept.slice(0, 5));
    madeScore = Number(immediate.conservativeScore) || 0;
  }
  const expectedValue = Math.round(
    madeScore * 0.2 +
    Math.max(0, Number(outs) || 0) * 55 +
    kept.reduce((sum, index) => sum + rankNumber(cardRank(cards[index])), 0) * 2 +
    debuffedDiscarded * 90 -
    debuffedKept * 120 +
    discardBuildBonus(state, target),
  );
  return {
    id: `discard:${sorted.join(",")}`,
    action: { method: "discard", cards: sorted },
    target,
    pursuesHandTypes,
    keptCards: kept,
    survivalFloorScore: madeScore,
    exactRemainingDeckOuts: outs,
    expectedValue,
    debuffedDiscarded,
    debuffedKept,
  };
}

function discardCandidates(state, maximum) {
  const cards = cardsIn(state?.hand);
  if (!cards.length || Number(state?.round?.discards_left) <= 0) return [];
  const remaining = cardsIn(state?.cards ?? state?.remainingDeck);
  const discardLimit = Math.min(5, Number(state?.hand?.highlighted_limit) || 5, Math.max(1, cards.length - 1));
  const allIndices = cards.map((_, index) => index);
  const byRank = new Map();
  for (const index of allIndices) {
    const rank = rankNumber(cardRank(cards[index]));
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(index);
  }
  const result = [];
  const addKeep = (keep, target, outs, pursuesHandTypes) => {
    const keepSet = new Set(keep);
    const discard = allIndices
      .filter((index) => !keepSet.has(index))
      .toSorted((left, right) =>
        Number(cardDebuffed(cards[right])) - Number(cardDebuffed(cards[left])) ||
        rankNumber(cardRank(cards[left])) - rankNumber(cardRank(cards[right])))
      .slice(0, discardLimit);
    if (discard.length) result.push(discardCandidate(state, cards, discard, target, outs, keep, pursuesHandTypes));
  };

  const madeGroups = [...byRank.entries()]
    .filter(([, indices]) => indices.length >= 2)
    .sort(([leftRank, left], [rightRank, right]) => right.length - left.length || rightRank - leftRank);
  const mouthLocked = balatrobotMouthLockedHandType(state);
  const rankChaseGroups = {
    Pair: 1,
    "Two Pair": 2,
    "Three of a Kind": 1,
    "Full House": 2,
    "Four of a Kind": 1,
    "Five of a Kind": 1,
    "Flush House": 2,
    "Flush Five": 1,
  };
  const chaseGroupCount = rankChaseGroups[mouthLocked];
  if (chaseGroupCount) {
    const groups = [...byRank.entries()]
      .toSorted(([leftRank, left], [rightRank, right]) =>
        right.length - left.length || rightRank - leftRank)
      .slice(0, chaseGroupCount);
    const keep = groups.flatMap(([, indices]) => indices).slice(0, 5);
    const ranks = new Set(groups.map(([rank]) => rank));
    const outs = remaining.filter((card) => ranks.has(rankNumber(cardRank(card)))).length;
    addKeep(keep, `chase The Mouth locked ${mouthLocked}`, outs, [mouthLocked]);
  }
  if (madeGroups.length) {
    const keep = madeGroups.slice(0, madeGroups[0][1].length >= 3 ? 1 : 2).flatMap(([, indices]) => indices);
    const ranks = new Set(keep.map((index) => rankNumber(cardRank(cards[index]))));
    const outs = remaining.filter((card) => ranks.has(rankNumber(cardRank(card)))).length;
    addKeep(
      keep,
      madeGroups.length >= 2 ? "improve two-pair/full-house core" : "improve pair/trips core",
      outs,
      madeGroups.length >= 2
        ? ["Two Pair", "Full House"]
        : madeGroups[0][1].length >= 3
          ? ["Three of a Kind", "Full House", "Four of a Kind", "Five of a Kind"]
          : ["Pair", "Two Pair", "Three of a Kind", "Full House", "Four of a Kind", "Five of a Kind"],
    );
  }

  const straightSize = balatroStraightSize(state);
  const windows = balatroStraightWindows(state);
  const straightDraws = windows
    .map((window) => {
      const keep = [];
      for (const rank of window) {
        const normalizedRank = rank === 1 ? 14 : rank;
        const matching = byRank.get(normalizedRank);
        if (matching?.length) keep.push(matching[0]);
      }
      const missing = window.filter((rank) => !byRank.has(rank === 1 ? 14 : rank));
      const missingSet = new Set(missing.map((rank) => (rank === 1 ? 14 : rank)));
      const outs = remaining.filter((card) => missingSet.has(rankNumber(cardRank(card)))).length;
      return { keep, outs, high: window.at(-1) };
    })
    .filter((draw) => draw.keep.length >= Math.max(2, straightSize - 2))
    .sort((left, right) => right.keep.length - left.keep.length || right.outs - left.outs || right.high - left.high);
  if (straightDraws[0]) {
    addKeep(straightDraws[0].keep, "complete a straight", straightDraws[0].outs, ["Straight", "Straight Flush"]);
  }

  const flushSize = balatroFlushSize(state);
  const flushDraws = ["S", "H", "D", "C"]
    .map((suit) => [suit, allIndices.filter((index) => balatroCardMatchesSuit(state, cards[index], suit, { flush: true }))])
    .filter(([, indices]) => indices.length >= Math.max(2, flushSize - 2))
    .sort(([, left], [, right]) => right.length - left.length);
  if (flushDraws[0]) {
    const [suit, keep] = flushDraws[0];
    addKeep(
      keep,
      `complete a ${suit} flush`,
      remaining.filter((card) => balatroCardMatchesSuit(state, card, suit, { flush: true })).length,
      ["Flush", "Straight Flush", "Flush House", "Flush Five"],
    );
  }

  if (!madeGroups.length) {
    const genericKeep = allIndices
      .toSorted((left, right) => rankNumber(cardRank(cards[right])) - rankNumber(cardRank(cards[left])))
      .slice(0, Math.max(1, cards.length - discardLimit));
    const genericRanks = new Set(genericKeep.map((index) => rankNumber(cardRank(cards[index]))));
    addKeep(
      genericKeep,
      "pair high retained ranks",
      remaining.filter((card) => genericRanks.has(rankNumber(cardRank(card)))).length,
      ["High Card", "Pair"],
    );
  }

  const unique = new Map(result.map((candidate) => [candidate.id, candidate]));
  const legal = mouthLocked
    ? [...unique.values()].filter((candidate) => candidate.pursuesHandTypes.includes(mouthLocked))
    : [...unique.values()];
  return legal
    .toSorted(
      (left, right) =>
        right.expectedValue - left.expectedValue ||
        right.exactRemainingDeckOuts - left.exactRemainingDeckOuts ||
        right.action.cards.length - left.action.cards.length ||
        left.id.localeCompare(right.id),
    )
    .slice(0, maximum);
}

function withConvertedSuits(state, targets, suit) {
  const selected = new Set(targets);
  const converted = cardsIn(state?.hand).map((card, index) => {
    if (!selected.has(index)) return card;
    return {
      ...card,
      suit,
      value: card?.value ? { ...card.value, suit } : card?.value,
    };
  });
  return { ...state, hand: { ...(state?.hand ?? {}), cards: converted } };
}

function withPlanetUpgrade(state, upgrade) {
  const sourceKey = state?.hands && typeof state.hands === "object" ? "hands" : "pokerHands";
  const source = state?.[sourceKey] && typeof state[sourceKey] === "object" ? state[sourceKey] : {};
  const current = source[upgrade.handType] && typeof source[upgrade.handType] === "object"
    ? source[upgrade.handType]
    : {};
  const values = handValues(state, upgrade.handType);
  return {
    ...state,
    [sourceKey]: {
      ...source,
      [upgrade.handType]: {
        ...current,
        chips: values.chips + upgrade.chips,
        mult: values.mult + upgrade.mult,
      },
    },
  };
}

function emergencyConsumableCandidates(state, plays) {
  const consumables = cardsIn(state?.consumables);
  if (!consumables.length) return [];
  const finalHand = Number(state?.round?.hands_left) <= 1;
  const bestPlay = [...plays].sort(playSort)[0] ?? null;
  const bestScore = Number(bestPlay?.conservativeScore) || 0;
  const scoringCards = bestPlay?.scoringCards ?? [];
  const targetSizes = new Map([
    ["c_strength", 2],
    ["c_magician", 2],
    ["c_empress", 2],
    ["c_heirophant", 2],
    ["c_lovers", 1],
    ["c_justice", 1],
    ["c_tower", 1],
  ]);
  const result = [];
  for (const [index, consumable] of consumables.entries()) {
    const key = String(consumable?.key ?? "").toLowerCase();
    const set = String(consumable?.set ?? "").toUpperCase();
    const targetRule = balatroConsumableTargetRule(consumable);
    const convertedSuit = targetRule.kind === "suit" ? targetRule.suit : null;
    if (convertedSuit) {
      const hand = cardsIn(state?.hand);
      const convertible = hand
        .map((card, cardIndex) => ({ card, cardIndex }))
        .filter(({ card }) => String(cardSuit(card) ?? "").toUpperCase() !== convertedSuit)
        .map(({ cardIndex }) => cardIndex);
      let bestConversion = null;
      for (const targets of combinations(convertible.length, Math.min(targetRule.max, convertible.length))) {
        if (targets.length < targetRule.min) continue;
        const handTargets = targets.map((targetIndex) => convertible[targetIndex]);
        const simulated = withConvertedSuits(state, handTargets, convertedSuit);
        const projectedPlay = bestPlayCandidates(simulated, 30)[0] ?? null;
        const projectedScore = Number(projectedPlay?.conservativeScore) || 0;
        if (
          projectedPlay &&
          (!bestConversion || projectedScore > bestConversion.projectedScore ||
            (projectedScore === bestConversion.projectedScore && handTargets.length < bestConversion.action.cards.length))
        ) {
          bestConversion = {
            id: `use:${index}:${handTargets.join(",")}`,
            action: { method: "use", consumable: index, cards: handTargets },
            target: `convert up to three cards to ${convertedSuit} for ${projectedPlay.handType}`,
            projectedPlay,
            projectedScore,
            scoreGain: Math.max(0, projectedScore - bestScore),
            expectedValue: projectedScore,
          };
        }
      }
      if (bestConversion && bestConversion.projectedScore > bestScore) result.push(bestConversion);
      continue;
    }
    const planetUpgrade = set === "PLANET" ? PLANET_HAND_UPGRADES.get(key) : null;
    if (finalHand && planetUpgrade && planetUpgrade.handType === bestPlay?.handType) {
      const simulated = withPlanetUpgrade(state, planetUpgrade);
      const projectedPlay = playCandidate(simulated, cardsIn(state?.hand), bestPlay.action.cards);
      const projectedScore = Number(projectedPlay?.conservativeScore) || 0;
      if (projectedScore > bestScore) {
        result.push({
          id: `use:${index}`,
          action: { method: "use", consumable: index },
          target: `upgrade ${planetUpgrade.handType} before the final hand`,
          projectedPlay,
          projectedScore,
          scoreGain: projectedScore - bestScore,
          expectedValue: projectedScore,
        });
      }
      continue;
    }
    if (finalHand && FINAL_HAND_GENERATOR_KEYS.has(key)) {
      result.push({
        id: `use:${index}`,
        action: { method: "use", consumable: index },
        target: "emergency scoring resource before the final hand",
        expectedValue: 1_000,
      });
      continue;
    }
    if (!finalHand) continue;
    const count = targetSizes.get(key);
    if (!count || !scoringCards.length) continue;
    const targets = scoringCards
      .filter((cardIndex) => !cardModifier(cardsIn(state?.hand)[cardIndex], "enhancement"))
      .slice(0, count);
    if (targets.length) {
      result.push({
        id: `use:${index}:${targets.join(",")}`,
        action: { method: "use", consumable: index, cards: targets },
        target: "improve the final scoring hand before committing it",
        expectedValue: 900,
      });
    }
  }
  return result.toSorted(
    (left, right) =>
      (Number(right.projectedScore) || 0) - (Number(left.projectedScore) || 0) ||
      (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0),
  );
}

function withRuleTransformation(state, targets, rule) {
  const selected = new Set(targets);
  const transformed = cardsIn(state?.hand).map((card, index) => {
    if (!selected.has(index)) return card;
    if (rule.kind === "suit") {
      return { ...card, suit: rule.suit, value: { ...(card?.value ?? {}), suit: rule.suit } };
    }
    if (rule.kind === "rank") {
      const rank = rankNumber(cardRank(card));
      const next = rank >= 14 ? 2 : rank + 1;
      const rankLabel = next === 14 ? "A" : next === 13 ? "K" : next === 12 ? "Q" : next === 11 ? "J" : next === 10 ? "T" : String(next);
      return { ...card, rank: rankLabel, value: { ...(card?.value ?? {}), rank: rankLabel } };
    }
    if (rule.enhancement) {
      return { ...card, modifier: { ...(card?.modifier ?? {}), enhancement: rule.enhancement } };
    }
    return card;
  });
  return { ...state, hand: { ...(state?.hand ?? {}), cards: transformed } };
}

function noTargetPackValue(state, rule) {
  if (rule.kind !== "all-hands-upgrade") return 300;
  // Black Hole applies one planet-style level to every hand. Value both the
  // routes already used this run and a smaller option value for rare hands;
  // this keeps it visible as the broad upgrade it is without hard-forcing it.
  return 900 + [...PLANET_HAND_UPGRADES.values()].reduce((sum, upgrade) => {
    const hand = state?.hands?.[upgrade.handType] ?? state?.pokerHands?.[upgrade.handType] ?? {};
    const played = Math.max(0, Number(hand?.played) || 0);
    const values = handValues(state, upgrade.handType);
    const scoreDelta = Math.max(
      0,
      (values.chips + upgrade.chips) * (values.mult + upgrade.mult) - values.chips * values.mult,
    );
    const routeWeight = 0.2 + Math.min(2, Math.log2(played + 1));
    return sum + scoreDelta * routeWeight;
  }, 0);
}

function bestPackTargets(state, offeredCard) {
  const rule = balatroConsumableTargetRule(offeredCard);
  const hand = cardsIn(state?.hand);
  if (!rule.known || (rule.requiresJoker && !cardsIn(state?.jokers).length)) return null;
  if (rule.max === 0) {
    return {
      targets: [],
      projectedScore: 0,
      scoreGain: 0,
      value: noTargetPackValue(state, rule),
      rule,
    };
  }
  // Death and Cryptid depend on selection order/copy direction.  Leave them
  // to the strategic model, but never fabricate a "safe" local fallback.
  if (rule.kind === "copy") return null;
  const basePlay = bestPlayCandidates(state, 30)[0] ?? null;
  const baseScore = Number(basePlay?.conservativeScore) || 0;
  const scoring = new Set(basePlay?.scoringCards ?? []);
  const indices = hand.map((_, index) => index);
  let options = combinations(indices.length, Math.min(rule.max, indices.length))
    .filter((targets) => targets.length >= rule.min);
  if (rule.kind === "remove" || rule.kind === "enhance-held" || rule.kind === "stone") {
    options = options.toSorted((left, right) => {
      const penalty = (targets) => targets.reduce((sum, index) =>
        sum + (scoring.has(index) ? 1_000 : 0) + rankNumber(cardRank(hand[index])) - (cardDebuffed(hand[index]) ? 100 : 0), 0);
      return penalty(left) - penalty(right);
    }).slice(0, 1);
  }
  let best = null;
  for (const targets of options) {
    const simulated = withRuleTransformation(state, targets, rule);
    const projectedPlay = bestPlayCandidates(simulated, 30)[0] ?? basePlay;
    const projectedScore = Number(projectedPlay?.conservativeScore) || baseScore;
    const strategicBonus = targets.reduce((sum, index) => {
      const card = hand[index];
      if (rule.kind === "remove") return sum + (cardDebuffed(card) ? 250 : 0) + (15 - rankNumber(cardRank(card))) * 4;
      if (rule.kind === "enhance-held") return sum + (scoring.has(index) ? 0 : 160) + (15 - rankNumber(cardRank(card))) * 2;
      if (rule.kind === "stone") return sum + (scoring.has(index) ? 0 : 120) + (15 - rankNumber(cardRank(card))) * 2;
      return sum + (scoring.has(index) ? 80 : 0);
    }, 0);
    const value = projectedScore + strategicBonus;
    if (!best || value > best.value || (value === best.value && targets.length < best.targets.length)) {
      best = { targets, projectedPlay, projectedScore, scoreGain: projectedScore - baseScore, value, rule };
    }
  }
  return best;
}

function plannedHandTypes(runPlan) {
  const text = Object.values(runPlan && typeof runPlan === "object" ? runPlan : {})
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  const matches = [];
  for (const [handType, aliases] of HAND_PLAN_ALIASES) {
    for (const alias of aliases.toSorted((left, right) => right.length - left.length)) {
      let offset = 0;
      while (offset < text.length) {
        const index = text.indexOf(alias, offset);
        if (index < 0) break;
        const latin = /^[a-z ]+$/u.test(alias);
        const before = index > 0 ? text[index - 1] : "";
        const after = text[index + alias.length] ?? "";
        if (!latin || (!/[a-z]/u.test(before) && !/[a-z]/u.test(after))) {
          matches.push({ handType, index, end: index + alias.length, length: alias.length });
        }
        offset = index + 1;
      }
    }
  }
  // Resolve compound names before their substrings: "Straight Flush" must
  // not also declare independent Straight and Flush routes.
  const selected = [];
  for (const match of matches.toSorted((left, right) => left.index - right.index || right.length - left.length)) {
    if (selected.some((item) => match.index < item.end && match.end > item.index)) continue;
    // Keep every non-overlapping occurrence as an occupied span, even if the
    // same route also appeared in another language earlier in the sentence.
    selected.push(match);
  }
  return selected
    .toSorted((left, right) => left.index - right.index)
    .map(({ handType }) => handType)
    .filter((handType, index, all) => all.indexOf(handType) === index);
}

function planetPlanValue(state, upgrade, runPlan) {
  const planned = plannedHandTypes(runPlan);
  let relevance = "unrelated";
  let planBonus = 0;
  if (planned[0] === upgrade.handType) {
    relevance = "primary";
    planBonus = 700;
  }
  const supportIndex = planned.findIndex((target) => PLANET_SUPPORT_HANDS.get(target)?.has(upgrade.handType));
  if (relevance === "unrelated" && supportIndex >= 0) {
    relevance = "support";
    planBonus = 350 - supportIndex * 20;
  }
  const secondaryIndex = planned.slice(1).indexOf(upgrade.handType);
  if (relevance === "unrelated" && secondaryIndex >= 0) {
    relevance = "secondary";
    planBonus = 220 - secondaryIndex * 20;
  }
  const hand = state?.hands?.[upgrade.handType] ?? state?.pokerHands?.[upgrade.handType] ?? {};
  const played = Math.max(0, Number(hand?.played) || 0);
  if (!planned.length) relevance = played > 0 ? "observed" : "uncommitted";
  const values = handValues(state, upgrade.handType);
  const scoreDelta = Math.max(
    0,
    (values.chips + upgrade.chips) * (values.mult + upgrade.mult) - values.chips * values.mult,
  );
  // Upgrade yield and actual use frequency are primary. The plan is a bonus,
  // so an unusually strong or established alternate remains visible.
  const priority = scoreDelta * Math.max(1, Math.log2(played + 2)) + played * 45 + planBonus;
  return { relevance, priority, planBonus, scoreDelta, played };
}

export function generateBalatrobotPackCandidates(state, { limit = 12, runPlan = null, benchmarks = [] } = {}) {
  if (state?.state !== "SMODS_BOOSTER_OPENED") return [];
  const offered = cardsIn(state?.pack);
  // Tarot and Spectral choices use the dedicated stateful evaluator. It
  // distinguishes safe upgrades from irreversible cards such as Hex, Ankh,
  // Ectoplasm and Immolate, and always keeps an explicit skip candidate.
  const consumableCandidates = generateBalatroConsumablePackCandidates(state, {
    evaluateBestPlay: (candidateState) => bestPlayCandidates(candidateState, 30)[0] ?? null,
    limit: 24,
  }).filter((candidate) =>
    candidate.action?.skip || String(candidate.card?.set ?? "").toUpperCase() !== "PLANET");
  const candidates = [...consumableCandidates.filter((candidate) => !candidate.action?.skip)];
  const activeRunPlan = runPlan ?? state?.__runPlan ?? null;
  for (const [index, card] of offered.entries()) {
    const set = String(card?.set ?? "").toUpperCase();
    // Known Tarot/Spectral cards were handled above. Unknown modded
    // consumables fail closed instead of receiving a fabricated flat value.
    if (TARGETED_CONSUMABLE_SETS.has(set)) continue;
    if (set === "JOKER" && jokerSlotOccupancy(state) >= Number(state?.jokers?.limit ?? 5)) continue;
    const planetUpgrade = set === "PLANET" ? PLANET_HAND_UPGRADES.get(String(card?.key ?? "").toLowerCase()) : null;
    const planetValue = planetUpgrade ? planetPlanValue(state, planetUpgrade, activeRunPlan) : null;
    const jokerCounterfactual = set === "JOKER" ? jokerPurchaseCounterfactual(state, card, benchmarks) : null;
    const baseExpectedValue = set === "PLANET"
      ? 200 + (planetValue?.priority ?? 0)
      : set === "JOKER" && scoringJoker(card) ? 900 : 500;
    const freePackCard = set === "JOKER"
      ? { ...card, buy: 0, cost: { ...(card?.cost ?? {}), buy: 0 } }
      : card;
    const stickerValuation = set === "JOKER"
      ? stickerAwareJokerValuation(state, freePackCard, baseExpectedValue, {
        immediateSurvival: jokerCounterfactual.immediateSurvival,
      })
      : null;
    if (stickerValuation?.hardRejected) continue;
    const hasStickerLiability = Boolean(
      stickerValuation?.eternal || stickerValuation?.perishable || stickerValuation?.rental,
    );
    const harmfulSticker = Boolean(stickerValuation && stickerValuation.netPresentValue <= 0);
    candidates.push({
      id: `pack:${index}`,
      action: { method: "pack", card: index, targets: [] },
      card: {
        index,
        id: card?.id ?? null,
        key: card?.key ?? "",
        label: card?.label ?? "",
        set,
        effect: cardEffect(card),
        ...(set === "JOKER" ? compactJokerStickers(card) : {}),
      },
      handType: planetUpgrade?.handType ?? null,
      planRelevance: planetValue?.relevance ?? null,
      upgradeScoreDelta: planetValue?.scoreDelta ?? null,
      handPlayed: planetValue?.played ?? null,
      expectedValue: stickerValuation?.netPresentValue ?? baseExpectedValue,
      counterfactual: jokerCounterfactual,
      stickerValuation,
      safeChoice: !hasStickerLiability && !harmfulSticker,
      fallbackSafe: !hasStickerLiability && !harmfulSticker,
      harmful: harmfulSticker,
      requiresStrategic: hasStickerLiability,
      strategicReason: hasStickerLiability
        ? [
          stickerValuation.eternal && `Eternal slot cost ${stickerValuation.eternalSlotCost}`,
          stickerValuation.perishable && `Perishable life ${stickerValuation.remainingPerishableBlinds} blind(s)`,
          stickerValuation.rental && `Rental $${stickerValuation.rentalRate}/blind, projected $${stickerValuation.projectedRentalCost}`,
        ].filter(Boolean).join("; ")
        : "",
    });
  }
  const skip = consumableCandidates.find((candidate) => candidate.action?.skip) ?? {
    id: "pack:skip",
    action: { method: "pack", skip: true },
    target: "skip only when every offered choice is unusable or harmful",
    expectedValue: 0,
    safeChoice: true,
  };
  const maximum = Math.max(1, Number(limit) || 12);
  const ranked = candidates
    .toSorted((left, right) => (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0) || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, maximum - 1));
  return [...ranked, skip];
}

function emergencyBossCandidates(state) {
  const boss = String(activeBlind(state)?.name ?? "").trim().toLowerCase();
  if (boss !== "verdant leaf" && boss !== "the verdant leaf") return [];
  if (!cardsIn(state?.hand).some(cardDebuffed)) return [];
  const sellable = cardsIn(state?.jokers)
    .map((joker, index) => ({ joker, index }))
    .filter(({ joker }) => !jokerStickerProfile(joker).eternal)
    .sort((left, right) =>
      Number(balatrobotIsScoringJoker(left.joker)) - Number(balatrobotIsScoringJoker(right.joker)) ||
      (Number(left.joker?.cost?.sell) || 0) - (Number(right.joker?.cost?.sell) || 0));
  const selected = sellable[0];
  if (!selected) return [];
  return [{
    id: `sell:joker:${selected.index}`,
    action: { method: "sell", joker: selected.index },
    target: "disable Verdant Leaf before relying on debuffed cards",
    expectedValue: 2_000,
    requiresStrategic: true,
    fallbackSafe: false,
    strategicReason: "selling a Joker to disable Verdant Leaf is irreversible",
    destructive: true,
    requiredForSurvival: true,
  }];
}

function roundCounter(state, snakeName, camelName) {
  const value = Number(state?.round?.[snakeName] ?? state?.round?.[camelName]);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function consumableSlotOpen(state) {
  const cards = cardsIn(state?.consumables);
  const count = Number(state?.consumables?.count ?? cards.length);
  const limit = Number(state?.consumables?.limit ?? state?.consumables?.card_limit ?? 2);
  return Number.isFinite(limit) && (Number.isFinite(count) ? count : cards.length) < limit;
}

function behavioralJoker(state, key) {
  return cardsIn(state?.jokers)
    .map((joker, index) => ({ joker, index, capability: balatrobotJokerCapability(joker, state) }))
    .find(({ joker, capability }) =>
      jokerKey(joker) === key && !jokerDebuffed(joker) && capability?.activeNow) ?? null;
}

function withoutVisibleHandCards(state, removedIndices, { lockMouthToHighCard = false } = {}) {
  const removed = new Set(removedIndices);
  const simulated = {
    ...state,
    hand: {
      ...(state?.hand ?? {}),
      cards: cardsIn(state?.hand).filter((_, index) => !removed.has(index)),
    },
  };
  if (lockMouthToHighCard) simulated.__mouthLockedHandType = "High Card";
  return simulated;
}

function conservativeBehaviorSurvivalFloor(state, removedIndices, {
  setupScore = 0,
  handsSpent = 0,
} = {}) {
  const blind = activeBlind(state);
  const target = Number(blind?.score);
  const current = Number(state?.round?.chips);
  const handsLeft = roundCounter(state, "hands_left", "handsLeft");
  const handsAfter = Math.max(0, handsLeft - handsSpent);
  const bossName = String(blind?.name ?? "").trim().toLowerCase();
  // A one-card setup on The Eye consumes High Card and makes our repeat-line
  // projection invalid. Fail closed instead of pretending the next High Card
  // remains legal. The Mouth is modeled by locking subsequent plays locally.
  if (handsSpent > 0 && bossName === "the eye") {
    return {
      safe: false,
      reason: "The Eye invalidates a repeat-line estimate after a setup hand",
      target,
      current,
      handsAfter,
      postSetupBestScore: 0,
      projectedTotal: Number.isFinite(current) ? current + Math.max(0, Number(setupScore) || 0) : 0,
    };
  }
  const simulated = withoutVisibleHandCards(state, removedIndices, {
    lockMouthToHighCard: handsSpent > 0 && bossName === "the mouth" && !balatrobotMouthLockedHandType(state),
  });
  const postSetupBest = bestPlayCandidates(simulated, 30)[0] ?? null;
  const postSetupBestScore = Math.max(0, Number(postSetupBest?.conservativeScore) || 0);
  const projectedTotal = (Number.isFinite(current) ? current : 0) +
    Math.max(0, Number(setupScore) || 0) + postSetupBestScore * handsAfter;
  const safe = Number.isFinite(target) && target > 0 && handsAfter > 0 && postSetupBestScore > 0 && projectedTotal >= target;
  return {
    safe,
    reason: safe
      ? "the measured post-setup line still reaches the blind target without credit for the Joker reward or replacement draws"
      : "the measured post-setup line does not preserve the blind-clear floor",
    target,
    current: Number.isFinite(current) ? current : 0,
    handsAfter,
    setupScore: Math.max(0, Number(setupScore) || 0),
    postSetupBestScore,
    projectedTotal,
    margin: Number.isFinite(target) ? projectedTotal - target : null,
  };
}

function cardDeckValue(card) {
  const edition = cardModifier(card, "edition");
  const enhancement = cardModifier(card, "enhancement");
  const seal = cardModifier(card, "seal");
  const permanentBonus = Number(card?.perma_bonus ?? card?.permaBonus ?? card?.value?.perma_bonus) || 0;
  return (
    (edition ? 2_000 : 0) +
    (seal ? 1_200 : 0) +
    (enhancement ? 800 : 0) +
    permanentBonus * 20 +
    rankNumber(cardRank(card)) * 10
  );
}

function candidateCardsSignature(candidate) {
  const method = candidate?.action?.method;
  if (!HAND_ACTION_METHODS.has(method)) return "";
  return `${method}:${[...(candidate.action?.cards ?? [])].toSorted((left, right) => left - right).join(",")}`;
}

function dnaSetupCandidate(state) {
  const behavior = behavioralJoker(state, "j_dna");
  if (!behavior || roundCounter(state, "hands_played", "handsPlayed") !== 0 || roundCounter(state, "hands_left", "handsLeft") < 2) {
    return null;
  }
  const cards = cardsIn(state?.hand);
  return cards
    .map((card, index) => {
      const play = playCandidate(state, cards, [index]);
      if (cardDebuffed(card) || !bossAllowsPlayCandidate(state, play)) return null;
      const survivalFloor = conservativeBehaviorSurvivalFloor(state, [index], {
        setupScore: play.conservativeScore,
        handsSpent: 1,
      });
      if (!survivalFloor.safe) return null;
      return {
        ...play,
        id: `behavior:j_dna:play:${index}`,
        target: `copy ${cardRank(card) || "the selected card"} into the deck with DNA`,
        // The duplicated card's intrinsic permanent value dominates; score
        // margin is only a late tie-break and must not make an ordinary King
        // preferable to a Polychrome/Sealed Ace.
        expectedValue: 1_200 + cardDeckValue(card) + Math.min(200, Math.max(0, Number(play.conservativeScore) || 0)),
        behavioralJoker: behavior.capability,
        requiresStrategic: true,
        strategicReason: "DNA's first-hand single-card setup spends a scoring hand and changes the deck",
        survivalFloor,
      };
    })
    .filter(Boolean)
    .toSorted((left, right) =>
      right.expectedValue - left.expectedValue ||
      right.survivalFloor.margin - left.survivalFloor.margin ||
      left.id.localeCompare(right.id))[0] ?? null;
}

function sixthSenseSetupCandidate(state) {
  const behavior = behavioralJoker(state, "j_sixth_sense");
  if (
    !behavior ||
    roundCounter(state, "hands_played", "handsPlayed") !== 0 ||
    roundCounter(state, "hands_left", "handsLeft") < 2 ||
    !consumableSlotOpen(state)
  ) return null;
  const cards = cardsIn(state?.hand);
  return cards
    .map((card, index) => {
      if (rankNumber(cardRank(card)) !== 6 || cardDebuffed(card)) return null;
      const play = playCandidate(state, cards, [index]);
      if (!bossAllowsPlayCandidate(state, play)) return null;
      const survivalFloor = conservativeBehaviorSurvivalFloor(state, [index], {
        // Sixth Sense destroys the 6; do not count its displayed High Card
        // score toward survival even if the engine animation later exposes it.
        setupScore: 0,
        handsSpent: 1,
      });
      if (!survivalFloor.safe) return null;
      return {
        ...play,
        id: `behavior:j_sixth_sense:play:${index}`,
        target: "destroy one plain 6 with Sixth Sense to create a Spectral card",
        expectedValue: 1_350 - cardDeckValue(card),
        behavioralJoker: behavior.capability,
        requiresStrategic: true,
        strategicReason: "Sixth Sense destroys the first-hand 6 and spends a scoring hand",
        destructive: true,
        survivalFloor,
      };
    })
    .filter(Boolean)
    .toSorted((left, right) =>
      right.expectedValue - left.expectedValue ||
      right.survivalFloor.margin - left.survivalFloor.margin ||
      left.id.localeCompare(right.id))[0] ?? null;
}

function tradingCardDiscardCandidate(state, bestPlay) {
  const behavior = behavioralJoker(state, "j_trading");
  if (
    !behavior ||
    roundCounter(state, "discards_used", "discardsUsed") !== 0 ||
    roundCounter(state, "discards_left", "discardsLeft") <= 0
  ) return null;
  const cards = cardsIn(state?.hand);
  const scoringCore = new Set(bestPlay?.scoringCards ?? bestPlay?.action?.cards ?? []);
  return cards
    .map((card, index) => {
      const survivalFloor = conservativeBehaviorSurvivalFloor(state, [index]);
      if (!survivalFloor.safe) return null;
      const deckValue = cardDeckValue(card);
      return {
        id: `behavior:j_trading:discard:${index}`,
        action: { method: "discard", cards: [index] },
        target: "destroy one expendable card with Trading Card for $3",
        keptCards: cards.map((_, cardIndex) => cardIndex).filter((cardIndex) => cardIndex !== index),
        survivalFloorScore: survivalFloor.postSetupBestScore,
        exactRemainingDeckOuts: cardsIn(state?.cards ?? state?.remainingDeck).length,
        expectedValue: 1_500 - deckValue - (scoringCore.has(index) ? 600 : 0),
        behavioralJoker: behavior.capability,
        requiresStrategic: true,
        strategicReason: "Trading Card permanently destroys the selected card on the first discard",
        destructive: true,
        survivalFloor,
      };
    })
    .filter(Boolean)
    .toSorted((left, right) =>
      right.expectedValue - left.expectedValue ||
      right.survivalFloor.margin - left.survivalFloor.margin ||
      left.id.localeCompare(right.id))[0] ?? null;
}

function handRouteEvidence(state, handType, runPlan, bestPlay) {
  const planned = plannedHandTypes(runPlan ?? state?.__runPlan ?? null);
  const planIndex = planned.indexOf(handType);
  const live = state?.hands?.[handType] ?? state?.pokerHands?.[handType] ?? {};
  const played = Number(live?.played ?? live?.played_total ?? live?.playedTotal ?? live?.played_this_round ?? live?.playedThisRound) || 0;
  const level = Number(live?.level) || 1;
  const currentRoute = bestPlay?.handType === handType;
  if (planIndex < 0 && played <= 0 && level <= 1 && !currentRoute) return 0;
  return (planIndex >= 0 ? 2_000 - planIndex * 250 : 0) + played * 90 + Math.max(0, level - 1) * 180 +
    (currentRoute ? 450 : 0) + (HAND_STRENGTH[handType] ?? 0) * 10;
}

function burntJokerDiscardCandidate(state, bestPlay, runPlan) {
  const behavior = behavioralJoker(state, "j_burnt");
  if (
    !behavior ||
    roundCounter(state, "discards_used", "discardsUsed") !== 0 ||
    roundCounter(state, "discards_left", "discardsLeft") <= 0
  ) return null;
  const cards = cardsIn(state?.hand);
  const highlighted = Number(state?.hand?.highlighted_limit);
  const maximum = Math.min(5, Number.isInteger(highlighted) && highlighted > 0 ? highlighted : 5, Math.max(1, cards.length - 1));
  return combinations(cards.length, maximum)
    .map((indices) => {
      const classified = classifyBalatroHand(state, cards, indices);
      const routeEvidence = handRouteEvidence(state, classified.handType, runPlan, bestPlay);
      if (routeEvidence <= 0) return null;
      // Do not invent a High Card route merely because every subset classifies
      // as one. It must already be planned, played, levelled, or the only live
      // route in the current hand.
      const survivalFloor = conservativeBehaviorSurvivalFloor(state, indices);
      if (!survivalFloor.safe) return null;
      return {
        id: `behavior:j_burnt:discard:${indices.join(",")}`,
        action: { method: "discard", cards: indices },
        target: `upgrade ${classified.handType} with Burnt Joker's first discard`,
        handType: classified.handType,
        pursuesHandTypes: [classified.handType],
        keptCards: cards.map((_, index) => index).filter((index) => !indices.includes(index)),
        survivalFloorScore: survivalFloor.postSetupBestScore,
        exactRemainingDeckOuts: cardsIn(state?.cards ?? state?.remainingDeck).length,
        expectedValue: 1_100 + routeEvidence - indices.reduce((sum, index) => sum + cardDeckValue(cards[index]), 0) * 0.1,
        behavioralJoker: behavior.capability,
        requiresStrategic: true,
        strategicReason: `Burnt Joker's first discard permanently chooses a ${classified.handType} level-up route for this round`,
        survivalFloor,
      };
    })
    .filter(Boolean)
    .toSorted((left, right) =>
      right.expectedValue - left.expectedValue ||
      right.survivalFloor.margin - left.survivalFloor.margin ||
      left.action.cards.length - right.action.cards.length ||
      left.id.localeCompare(right.id))[0] ?? null;
}

function luchadorBossCandidate(state, bestPlay) {
  const behavior = behavioralJoker(state, "j_luchador");
  const blind = activeBlind(state);
  if (!behavior || String(blind?.type ?? "").toUpperCase() !== "BOSS") return null;
  if (Boolean(behavior.joker?.modifier?.eternal ?? behavior.joker?.eternal)) return null;
  const budget = balatroRoundSurvivalBudget(state, Number(bestPlay?.conservativeScore) || 0);
  const restriction = String(blind?.effect ?? blind?.description ?? blind?.name ?? "current Boss restriction").trim();
  return {
    id: `behavior:j_luchador:sell:${behavior.index}`,
    action: { method: "sell", joker: behavior.index },
    target: `sell Luchador to disable ${blind?.name ?? "the Boss blind"}`,
    expectedValue: budget.currentLineCanClear ? 500 : 1_600,
    behavioralJoker: behavior.capability,
    bossRestriction: restriction,
    requiresStrategic: true,
    fallbackSafe: false,
    strategicReason: `selling Luchador is irreversible; approve only if disabling ${blind?.name ?? "this Boss"} is worth the slot loss`,
    destructive: true,
    requiredForSurvival: false,
    survivalFloor: {
      safe: budget.currentLineCanClear,
      target: budget.target,
      current: budget.current,
      handsAfter: budget.handsLeft,
      postSetupBestScore: budget.bestScore,
      projectedTotal: budget.projectedTotal,
      margin: budget.projectedTotal - budget.target,
      reason: budget.currentLineCanClear
        ? "the measured line clears even before crediting disabled Boss effects"
        : "the score model cannot prove the line without disabling the Boss effect; strategic review is required",
    },
  };
}

function behavioralJokerCandidates(state, plays, { runPlan = null } = {}) {
  const bestPlay = [...plays].toSorted(playSort)[0] ?? null;
  return [
    dnaSetupCandidate(state),
    sixthSenseSetupCandidate(state),
    tradingCardDiscardCandidate(state, bestPlay),
    burntJokerDiscardCandidate(state, bestPlay, runPlan),
    luchadorBossCandidate(state, bestPlay),
  ].filter(Boolean);
}

export function generateBalatrobotCandidates(
  state,
  { limit = 14, benchmarks = [], runPlan = null, consumableAges = null } = {},
) {
  if (state?.state === "BLIND_SELECT") return generateBlindSelectCandidates(state);
  if (state?.state === "SHOP") return generateBalatrobotShopCandidates(state, { limit, benchmarks, consumableAges });
  if (state?.state === "SMODS_BOOSTER_OPENED") {
    return generateBalatrobotPackCandidates(state, { limit, runPlan, benchmarks });
  }
  if (state?.state !== "SELECTING_HAND") return [];
  const normalizedLimit = Math.max(2, Math.min(30, Number(limit) || 14));
  // Reserve one generation slot for a legal play before spending the bounded
  // candidate budget on discards. The former minimum of two discards made a
  // limit=2 request call bestPlayCandidates(..., 0), leaving no progress
  // action for either the routine ranker or a strategic use/hold review.
  const discardLimit = Math.min(5, Math.max(0, Math.floor(normalizedLimit / 3)), normalizedLimit - 1);
  const discards = discardLimit > 0 ? discardCandidates(state, discardLimit) : [];
  const plays = bestPlayCandidates(state, Math.max(1, normalizedLimit - discards.length));
  const jokerActions = behavioralJokerCandidates(state, plays, { runPlan });
  // A behavioral setup must not also be exposed as an unmarked routine hand
  // action. Otherwise the same cards could bypass strategic approval simply by
  // selecting the generic candidate id.
  const protectedActions = new Set(jokerActions.map(candidateCardsSignature).filter(Boolean));
  const ordinaryHandActions = [...plays, ...discards]
    .filter((candidate) => !protectedActions.has(candidateCardsSignature(candidate)));
  const consumables = decorateOwnedConsumableCandidates(state, generateBalatroConsumableUseCandidates(state, {
    evaluateBestPlay: (candidateState) => bestPlayCandidates(candidateState, 30)[0] ?? null,
    limit: Math.max(4, Math.min(10, normalizedLimit - 2)),
  }), consumableAges);
  const semanticActions = [...emergencyBossCandidates(state), ...jokerActions, ...consumables];
  // Always leave the strategic model a legal way to retain a consumable and
  // continue the blind. A large Negative-consumable inventory must not crowd
  // every play/discard action out of the bounded candidate list.
  const bestPlay = ordinaryHandActions.find((candidate) => candidate.action?.method === "play") ?? null;
  const bestDiscard = normalizedLimit >= 3
    ? ordinaryHandActions.find((candidate) => candidate.action?.method === "discard") ?? null
    : null;
  const mandatoryHandActions = [bestPlay, bestDiscard].filter(Boolean);
  const mandatoryIds = new Set(mandatoryHandActions.map((candidate) => candidate.id));
  const semanticBudget = Math.max(0, normalizedLimit - mandatoryHandActions.length);
  const reviewActions = semanticActions.filter((candidate) => candidate.consumableStrategicReview === true);
  const reviewIds = new Set(reviewActions.map((candidate) => candidate.id));
  const selectedSemantic = [
    ...reviewActions,
    ...semanticActions.filter((candidate) => !reviewIds.has(candidate.id)),
  ].slice(0, semanticBudget);
  const selectedIds = new Set([...mandatoryIds, ...selectedSemantic.map((candidate) => candidate.id)]);
  const filler = ordinaryHandActions
    .filter((candidate) => !selectedIds.has(candidate.id))
    .slice(0, Math.max(0, normalizedLimit - mandatoryHandActions.length - selectedSemantic.length));
  let result = [...mandatoryHandActions, ...selectedSemantic, ...filler].slice(0, normalizedLimit);
  const consumableHoldReviews = agedConsumableHoldReviews(
    state,
    consumableAges,
    result.filter((candidate) => candidate.action?.method === "use"),
  );
  result = attachConsumableHoldReviews(
    result,
    consumableHoldReviews,
    "play",
  );
  const mouthLocked = balatrobotMouthLockedHandType(state);
  if (
    mouthLocked &&
    Number(state?.round?.discards_left) <= 0 &&
    !result.some((candidate) => candidate.action?.method === "play")
  ) {
    const cards = cardsIn(state?.hand);
    const byRank = new Map();
    for (const [index, card] of cards.entries()) {
      const rank = rankNumber(cardRank(card));
      if (!byRank.has(rank)) byRank.set(rank, []);
      byRank.get(rank).push(index);
    }
    const coreLimit = /Two Pair|Full House|Flush House/u.test(mouthLocked) ? 2 : 1;
    const core = [...byRank.entries()]
      .toSorted(([leftRank, left], [rightRank, right]) => right.length - left.length || rightRank - leftRank)
      .slice(0, coreLimit)
      .flatMap(([, indices]) => indices)
      .slice(0, 5);
    const coreSet = new Set(MOUTH_RANK_LOCKED_HANDS.has(mouthLocked) ? core : []);
    const cycle = cards
      .map((card, index) => ({ card, index }))
      .filter(({ index }) => !coreSet.has(index))
      .toSorted((left, right) =>
        Number(cardDebuffed(right.card)) - Number(cardDebuffed(left.card)) ||
        rankNumber(cardRank(left.card)) - rankNumber(cardRank(right.card)) ||
        left.index - right.index)
      .slice(0, Math.min(5, Math.max(1, cards.length - coreSet.size)))
      .map(({ index }) => index)
    const lowestFallback = cards
      .map((card, index) => ({ card, index }))
      .toSorted((left, right) =>
        Number(cardDebuffed(right.card)) - Number(cardDebuffed(left.card)) ||
        rankNumber(cardRank(left.card)) - rankNumber(cardRank(right.card)) ||
        left.index - right.index)
      [0]?.index;
    // The forced-zero play should cycle expendable cards while leaving any
    // partial locked-hand rank core in the hand for a later draw. Only when
    // every visible card is part of that core do we sacrifice one low card.
    const indices = (cycle.length ? cycle : [lowestFallback].filter(Number.isInteger))
      .toSorted((left, right) => left - right);
    if (indices.length) {
      const actual = classifyBalatroHand(state, cards, indices);
      result = [{
        id: `play:mouth-forced-zero:${indices.join(",")}`,
        action: { method: "play", cards: indices },
        handType: actual.handType,
        scoringCards: [],
        cycleFillers: indices,
        rulesApplied: [...actual.rulesApplied, "the-mouth-forced-zero"],
        bossRule: `The Mouth is locked to ${mouthLocked}; this off-type hand scores zero`,
        forcedZero: true,
        baseScoreBeforeEffects: 0,
        conservativeScore: 0,
        estimatedScore: 0,
        optimisticScore: 0,
        chips: 0,
        mult: 0,
        xMult: 1,
        volatileXMult: 1,
        knownScoringJokers: 0,
        knownRetriggers: 0,
        knownRetriggerSources: [],
        totalActiveJokers: cardsIn(state?.jokers).length,
      }, ...semanticActions].slice(0, normalizedLimit);
    }
  }
  const assessment = balatrobotSurvivalAssessment(state, result);
  return result.map((candidate) => candidate.id === assessment.bestPlay?.id
    ? {
        ...candidate,
        survivalBudget: {
          deficit: assessment.deficit,
          handsLeft: assessment.handsLeft,
          requiredPace: assessment.requiredPace,
          projectedRemaining: assessment.projectedRemaining,
          paceShortfall: assessment.paceShortfall,
          currentLineCanClear: assessment.currentLineCanClear,
          shouldDiscard: assessment.shouldDiscard,
          mrBones: assessment.mrBones,
        },
      }
    : candidate);
}

export function balatrobotSurvivalAssessment(state, candidates) {
  const plays = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate.action?.method === "play")
    .toSorted((left, right) => (right.conservativeScore ?? 0) - (left.conservativeScore ?? 0));
  const discard = (Array.isArray(candidates) ? candidates : []).find((candidate) => candidate.action?.method === "discard") ?? null;
  const emergencyConsumable = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) =>
      candidate.action?.method === "use" &&
      candidate.eligibleForEmergency === true &&
      candidate.fallbackSafe === true)
    .toSorted(
      (left, right) =>
        (Number(right.projectedScore) || 0) - (Number(left.projectedScore) || 0) ||
        (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0),
    )[0] ?? null;
  const requiredBossAction = (Array.isArray(candidates) ? candidates : [])
    .find((candidate) => candidate.action?.method === "sell" && candidate.requiredForSurvival === true) ?? null;
  const blind = activeBlind(state);
  const discardsLeft = Number(state?.round?.discards_left);
  const bestPlay = plays[0] ?? null;
  const bestScore = Number(bestPlay?.conservativeScore) || 0;
  const budget = balatroRoundSurvivalBudget(state, bestScore);
  const { target, current, deficit, handsLeft, requiredPace } = budget;
  const mrBonesOwned = cardsIn(state?.jokers).some((joker) =>
    jokerKey(joker) === "j_mr_bones" && !jokerDebuffed(joker));
  const mrBonesThreshold = Number.isFinite(target) && target > 0 ? Math.ceil(target * 0.25) : 0;
  const mrBones = {
    owned: mrBonesOwned,
    threshold: mrBonesThreshold,
    currentReached: mrBonesOwned && mrBonesThreshold > 0 && current >= mrBonesThreshold,
    projectedReached: mrBonesOwned && mrBonesThreshold > 0 && budget.projectedTotal >= mrBonesThreshold,
    canPreventLoss: mrBonesOwned && mrBonesThreshold > 0 && !budget.currentLineCanClear && budget.projectedTotal >= mrBonesThreshold,
    destroysOnSave: mrBonesOwned,
    exactScoreSupported: false,
  };
  const canImprove = discardsLeft > 0 && Boolean(discard);
  const shouldDiscard = canImprove && deficit > 0 && (
    (handsLeft <= 1 && bestScore < deficit) ||
    (handsLeft > 1 && !budget.currentLineCanClear)
  );
  const projectedConsumableScore = Number(emergencyConsumable?.projectedScore) || 0;
  const consumableClearsBlind = deficit > bestScore && projectedConsumableScore >= deficit;
  const shouldUseConsumable = !shouldDiscard && Boolean(emergencyConsumable) && (
    consumableClearsBlind ||
    (handsLeft <= 1 && deficit > bestScore)
  );
  const shouldResolveBoss = Boolean(requiredBossAction) && deficit > bestScore;
  return {
    blind,
    target,
    current,
    deficit,
    handsLeft,
    discardsLeft,
    requiredPace,
    bestPlay,
    bestScore,
    projectedRemaining: budget.projectedRemaining,
    projectedTotal: budget.projectedTotal,
    paceShortfall: budget.paceShortfall,
    currentLineCanClear: budget.currentLineCanClear,
    mrBones,
    discard,
    shouldDiscard,
    emergencyConsumable,
    projectedConsumableScore,
    consumableClearsBlind,
    shouldUseConsumable,
    requiredBossAction,
    shouldResolveBoss,
  };
}

export function assertBalatrobotCandidateAction(action, candidates, state = null) {
  if (!Array.isArray(candidates) || !candidates.length) {
    if (CANDIDATE_ACTION_STATES.has(state?.state)) {
      const locked = balatrobotMouthLockedHandType(state);
      throw new Error(
        locked
          ? `The Mouth is locked to ${locked}, but no locally enumerated legal ${action.method} candidate exists`
          : `no locally enumerated legal ${action.method} candidate exists`,
      );
    }
    return action;
  }
  if (state?.state === "SMODS_BOOSTER_OPENED" && action?.method === "pack" && action?.params?.skip === true) {
    const safeChoice = balatroPackHasSafeConsumableChoice(candidates) || candidates.some(
      (candidate) => candidate.action?.method === "pack" && !candidate.action.skip && candidate.safeChoice === true,
    );
    if (safeChoice) {
      throw new Error(
        "do not skip a pack with a locally safe choice",
      );
    }
  }
  if (state?.state === "SELECTING_HAND") {
    const assessment = balatrobotSurvivalAssessment(state, candidates);
    if (assessment.shouldResolveBoss && action?.method !== "sell") {
      throw new Error("Verdant Leaf is still debuffing the hand; sell the recommended non-core Joker before another action");
    }
    if (assessment.shouldUseConsumable) {
      const expected = assessment.emergencyConsumable?.action;
      const actualCards = [...(action?.params?.cards ?? [])].sort((left, right) => left - right);
      const expectedCards = [...(expected?.cards ?? [])].sort((left, right) => left - right);
      if (
        action?.method !== "use" ||
        action?.params?.consumable !== expected?.consumable ||
        actualCards.join(",") !== expectedCards.join(",")
      ) {
        throw new Error(
          `use lifesaving emergency consumable ${expected?.consumable} on [${expectedCards.join(",")}] before any weaker action`,
        );
      }
    }
  }
  if (!HAND_ACTION_METHODS.has(action?.method)) {
    const normalizedValue = (value, key = "") => {
      if (Array.isArray(value)) {
        const items = value.map((item) => normalizedValue(item));
        return key === "cards" || key === "targets"
          ? items.toSorted((left, right) => Number(left) - Number(right))
          : items;
      }
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([itemKey, item]) =>
            item !== undefined &&
            !(Array.isArray(item) && item.length === 0 && (itemKey === "cards" || itemKey === "targets")))
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([itemKey, item]) => [itemKey, normalizedValue(item, itemKey)]),
      );
    };
    const signature = JSON.stringify({
      method: action?.method,
      params: normalizedValue(action?.params ?? {}),
    });
    const allowed = candidates.some((candidate) => {
      const { method, ...params } = candidate.action ?? {};
      return JSON.stringify({ method, params: normalizedValue(params) }) === signature;
    });
    if (!allowed) {
      const allowedIds = candidates
        .filter((candidate) => candidate.action?.method === action?.method)
        .map((candidate) => candidate.id)
        .join(", ");
      throw new Error(
        `${action?.method || "action"}.params must exactly match one locally enumerated candidate` +
          (allowedIds ? `: ${allowedIds}` : ""),
      );
    }
    return action;
  }
  const signature = `${action.method}:${[...(action.params?.cards ?? [])].sort((left, right) => left - right).join(",")}`;
  const allowed = candidates.some((candidate) => {
    const cards = [...(candidate.action?.cards ?? [])].sort((left, right) => left - right);
    return `${candidate.action?.method}:${cards.join(",")}` === signature;
  });
  if (!allowed) {
    throw new Error(
      `${action.method}.cards must exactly match one locally enumerated candidate: ` +
        candidates.filter((candidate) => candidate.action?.method === action.method).map((candidate) => `[${candidate.action.cards}]`).join(" "),
    );
  }
  if (state && action.method === "play") {
    const assessment = balatrobotSurvivalAssessment(state, candidates);
    const chosen = candidates.find((candidate) => {
      if (candidate.action?.method !== "play") return false;
      const cards = [...(candidate.action.cards ?? [])].sort((left, right) => left - right);
      return `play:${cards.join(",")}` === signature;
    });
    const chosenScore = Number(chosen?.conservativeScore) || 0;
    const approvedBehaviorSetup = Boolean(chosen?.behavioralJoker && chosen?.requiresStrategic && chosen?.survivalFloor?.safe);
    if (assessment.shouldResolveBoss) {
      throw new Error("Verdant Leaf is still debuffing the hand; sell the recommended non-core Joker before playing");
    }
    if (!approvedBehaviorSetup && assessment.bestScore > 0 && chosenScore < assessment.bestScore * 0.72) {
      throw new Error(
        `play conservative score ${chosenScore} is far below the locally best ${assessment.bestScore}; choose the stronger candidate`,
      );
    }
    if (!approvedBehaviorSetup && assessment.shouldDiscard) {
      throw new Error(
        `best conservative play ${assessment.bestScore} cannot maintain the survival pace ` +
          `${Math.ceil(assessment.requiredPace)} with ${assessment.discardsLeft} discard(s) available; discard to improve first`,
      );
    }
    if (assessment.shouldUseConsumable) {
      throw new Error(
        `best conservative play ${assessment.bestScore} is below the final-hand deficit ${assessment.deficit}; ` +
          "use the available emergency consumable before committing the last hand",
      );
    }
  }
  if (state && action.method === "discard") {
    const assessment = balatrobotSurvivalAssessment(state, candidates);
    const selected = candidates.find((candidate) => {
      if (candidate.action?.method !== "discard") return false;
      const cards = [...(candidate.action.cards ?? [])].sort((left, right) => left - right);
      return `discard:${cards.join(",")}` === signature;
    });
    const approvedBehaviorDiscard = Boolean(selected?.behavioralJoker && selected?.requiresStrategic && selected?.survivalFloor?.safe);
    const bestDiscardValue = Math.max(
      0,
      ...candidates.filter((candidate) => candidate.action?.method === "discard").map((candidate) => Number(candidate.expectedValue) || 0),
    );
    if (!approvedBehaviorDiscard && bestDiscardValue > 0 && (Number(selected?.expectedValue) || 0) < bestDiscardValue * 0.7) {
      throw new Error(`discard expected value ${selected?.expectedValue ?? 0} is far below the locally best ${bestDiscardValue}`);
    }
    const highScoreProfile = balatrobotHighScoreBuildProfile(state);
    const survivalFloorScore = Math.max(0, Number(selected?.survivalFloorScore) || 0);
    const target = Math.max(0, Number(assessment.target) || 0);
    const current = Math.max(0, Number(assessment.current) || 0);
    // After the early survival phase, an already-safe line may spend a discard
    // to search for a multiplicative/retrigger hand, but only when the kept
    // cards still form a measured scoring floor that can clear the blind with
    // the remaining hands. This removes the old hard ceiling without turning
    // high-score training into reckless early deaths.
    const safeHighScoreChase = highScoreProfile.stage !== "survival" &&
      assessment.handsLeft >= 2 &&
      Number(selected?.exactRemainingDeckOuts) > 0 &&
      survivalFloorScore > 0 &&
      target > 0 &&
      current + survivalFloorScore * assessment.handsLeft >= target * 1.1;
    if (assessment.bestScore >= assessment.deficit && assessment.deficit > 0 && !safeHighScoreChase && !approvedBehaviorDiscard) {
      throw new Error(`a local play already clears the remaining ${assessment.deficit}; do not spend a discard`);
    }
    if (
      assessment.handsLeft <= 3 &&
      assessment.requiredPace > 0 &&
      assessment.bestScore >= assessment.requiredPace * 1.35 &&
      !safeHighScoreChase &&
      !approvedBehaviorDiscard
    ) {
      throw new Error(
        `local play ${assessment.bestScore} safely exceeds the per-hand pace ${Math.ceil(assessment.requiredPace)}; ` +
          "bank the score instead of over-chasing with another discard",
      );
    }
  }
  return action;
}

export function filterBalatrobotExecutableCandidates(state, candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  return source.filter((candidate) => {
    const { method, ...params } = candidate?.action ?? {};
    if (!method) return false;
    try {
      assertBalatrobotCandidateAction({ method, params }, source, state);
      return true;
    } catch {
      return false;
    }
  });
}

function activeBlind(state) {
  const blinds = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss].filter(Boolean);
  return blinds.find((blind) => String(blind.status ?? "").toUpperCase().includes("CURRENT")) ?? null;
}

export function balatrobotThinkingMode(state, candidates, config = {}) {
  const routine = config.balatrobotRoutineReasoningEffort ?? config.balatrobotReasoningEffort ?? "none";
  const strategic = config.balatrobotStrategicReasoningEffort ?? "high";
  if (config.balatrobotStrategicThinkingEnabled === false) {
    return { strategic: false, effort: routine, reason: "strategic thinking disabled" };
  }
  if (SHOP_STRATEGY_STATES.has(state?.state)) {
    const consumableReview = candidates.some((candidate) => candidate.consumableStrategicReview === true);
    return {
      strategic: true,
      effort: strategic,
      reason: consumableReview
        ? `${state.state.toLowerCase()} changes the run build; an aged or full-slot consumable needs an explicit use/hold review`
        : `${state.state.toLowerCase()} changes the run build`,
      ignorePersistedCheckpoint: consumableReview,
    };
  }
  if (state?.state === "BLIND_SELECT") {
    if (candidates.some((candidate) => candidate.action?.method === "reroll_boss" && candidate.requiresStrategic)) {
      return { strategic: true, effort: strategic, reason: "Boss reroll needs strategic approval" };
    }
    const selectable = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss]
      .filter(Boolean)
      .find((blind) => String(blind.status ?? "").toUpperCase().includes("SELECT"));
    const canSkip = selectable && String(selectable.type ?? "").toUpperCase() !== "BOSS";
    const hasSkipReward = Boolean(readableBlindTag(selectable));
    const developedRun = Number(state?.ante_num ?? state?.ante) >= 2;
    if (canSkip && hasSkipReward && developedRun) {
      return { strategic: true, effort: strategic, reason: "developed-run skip reward needs valuation" };
    }
    return { strategic: false, effort: routine, reason: "blind selection has a clear progress action" };
  }
  if (state?.state !== "SELECTING_HAND") return { strategic: false, effort: routine, reason: "local navigation" };
  const jokerTactics = balatrobotJokerTacticalContext(state);
  const blind = activeBlind(state);
  const boss = String(blind?.type ?? "").toUpperCase() === "BOSS";
  const handsLeft = Number(state?.round?.hands_left);
  const discardsLeft = Number(state?.round?.discards_left);
  const scoreNeeded = Math.max(0, Number(blind?.score) - Number(state?.round?.chips));
  const bestBase = candidates.find((candidate) => candidate.action?.method === "play")?.conservativeScore ?? 0;
  const requiredPace = scoreNeeded > 0 && handsLeft > 0 ? scoreNeeded / handsLeft : 0;
  const belowPace = requiredPace > 0 && bestBase < requiredPace;
  const survival = balatrobotSurvivalAssessment(state, candidates);
  const rescue = survival.shouldUseConsumable && survival.consumableClearsBlind;
  const consumableReview = candidates.some((candidate) => candidate.consumableStrategicReview === true);
  if (boss || rescue || jokerTactics.requiresStrategic || consumableReview) {
    const reasons = [
      boss && "one strategic package for this Boss blind",
      rescue && `consumable can clear the remaining ${survival.deficit}`,
      jokerTactics.requiresStrategic && "an active behavioral Joker changes hand/discard sequencing",
      consumableReview && "an aged or full-slot consumable needs an explicit use/hold review",
    ].filter(Boolean);
    return {
      strategic: true,
      effort: strategic,
      reason: reasons.join(", "),
      checkpointPhase: "blind",
      ignorePersistedCheckpoint: consumableReview,
    };
  }
  const pressure = belowPace
    ? `local survival solver handles score ${bestBase} below pace ${Math.ceil(requiredPace)}`
    : discardsLeft > 0
      ? "local candidate solver ranks play versus discard"
      : "local candidate solver ranks the legal plays";
  return { strategic: false, effort: routine, reason: pressure };
}
