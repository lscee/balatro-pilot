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
  "j_steel_joker", "j_glass_joker", "j_drivers_license", "j_ancient_joker",
]);
const RETRIGGER_ENGINE_JOKERS = new Set([
  "j_hanging_chad", "j_mime", "j_hack", "j_sock_and_buskin", "j_dusk", "j_seltzer",
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
const HAND_ACTION_METHODS = new Set(["play", "discard"]);
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

function availableShopMoney(state) {
  const money = Number(state?.money);
  const credit = cardsIn(state?.jokers).some((joker) => jokerKey(joker) === "j_credit_card") ? 20 : 0;
  return (Number.isFinite(money) ? money : 0) + credit;
}

function shopCardCanFit(state, card) {
  const set = String(card?.set ?? "").toUpperCase();
  if (set === "JOKER") {
    // Stable BalatroBot 1.5.2 rejects even a Negative Joker when the slot count
    // is full, so candidate generation must match the RPC validator exactly.
    return Number(state?.jokers?.count ?? cardsIn(state?.jokers).length) < Number(state?.jokers?.limit ?? 5);
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

export function balatrobotHighScoreBuildProfile(state) {
  const stage = highScoreStage(state);
  const jokers = cardsIn(state?.jokers).filter((joker) => !jokerDebuffed(joker));
  const traits = jokers.map(jokerEngineTraits);
  const keys = new Set(traits.map((trait) => trait.key));
  const levels = Object.values(state?.hands ?? state?.pokerHands ?? {})
    .map((hand) => Number(hand?.level) || 0);
  const peakHandLevel = Math.max(0, ...levels);
  const flatScoringSources = traits.filter((trait) => trait.flatScoring).length;
  const xMultSources = traits.filter((trait) => trait.xMult).length;
  const retriggerSources = traits.filter((trait) => trait.retrigger).length;
  const copySources = traits.filter((trait) => trait.copy).length;
  const scalingSources = traits.filter((trait) => trait.scaling).length;
  const stageWeights = stage === "survival"
    ? { flat: 2.4, x: 2.0, retrigger: 1.3, copy: 1.5, scaling: 1.2, level: 0.45 }
    : stage === "scaling"
      ? { flat: 0.9, x: 3.8, retrigger: 3.1, copy: 3.4, scaling: 2.6, level: 0.7 }
      : { flat: 0.25, x: 5.2, retrigger: 4.8, copy: 4.8, scaling: 3.1, level: 0.9 };
  let synergy = 0;
  if (keys.has("j_photograph") && keys.has("j_hanging_chad")) synergy += 4;
  if (keys.has("j_baron") && keys.has("j_mime")) synergy += 4;
  if (copySources && (xMultSources || retriggerSources)) synergy += 2.5;
  if (xMultSources && retriggerSources) synergy += 2;
  const engineScore = flatScoringSources * stageWeights.flat +
    xMultSources * stageWeights.x +
    retriggerSources * stageWeights.retrigger +
    copySources * stageWeights.copy +
    scalingSources * stageWeights.scaling +
    Math.min(12, peakHandLevel) * stageWeights.level + synergy;
  const layers = {
    base: flatScoringSources > 0 || peakHandLevel >= 3,
    xMult: xMultSources > 0,
    retrigger: retriggerSources > 0,
    copy: copySources > 0,
    scaling: scalingSources > 0 || peakHandLevel >= 5,
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

function jokerPurchaseCounterfactual(state, card, benchmarks = []) {
  const owned = cardsIn(state?.jokers);
  const before = balatrobotHighScoreBuildProfile(state);
  const afterJokers = [...owned, card];
  const after = balatrobotHighScoreBuildProfile(stateWithJokers(state, afterJokers));
  return {
    stage: before.stage,
    engineDelta: Math.round((after.engineScore - before.engineScore) * 100) / 100,
    ...benchmarkScoreDelta(state, owned, afterJokers, benchmarks),
    before,
    after,
  };
}

function generateBlindSelectCandidates(state) {
  if (state?.state !== "BLIND_SELECT") return [];
  const blind = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss]
    .filter(Boolean)
    .find((item) => String(item?.status ?? "").toUpperCase().includes("SELECT"));
  return [{
    id: "select:current",
    action: { method: "select" },
    target: `challenge ${blind?.name || blind?.type || "the current blind"}`,
    expectedValue: 1_000,
  }];
}

export function generateBalatrobotShopCandidates(state, { limit = 16, benchmarks = [] } = {}) {
  if (state?.state !== "SHOP") return [];
  const money = availableShopMoney(state);
  const candidates = [];
  for (const [index, card] of cardsIn(state?.shop).entries()) {
    const price = cardBuyPrice(card);
    if (price > money) continue;
    const set = String(card?.set ?? "").toUpperCase();
    const counterfactual = set === "JOKER" ? jokerPurchaseCounterfactual(state, card, benchmarks) : null;
    if (!shopCardCanFit(state, card)) continue;
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
      },
      expectedValue: set === "JOKER"
        ? 420 + Math.max(0, counterfactual.engineDelta) * 95 +
          Math.max(0, counterfactual.scoreLogDelta) * 1_100 + (scoringJoker(card) ? 90 : 0)
        : 520,
      counterfactual,
      requiresStrategic: true,
      strategicReason: "a shop purchase changes the build or economy",
    });
  }
  const ownedJokers = cardsIn(state?.jokers);
  const jokerLimit = Number(state?.jokers?.limit ?? 5);
  if (ownedJokers.length >= jokerLimit) {
    const blockedOffers = cardsIn(state?.shop)
      .map((card, index) => ({ card, index, price: cardBuyPrice(card) }))
      .filter(({ card }) => String(card?.set ?? "").toUpperCase() === "JOKER");
    const currentProfile = balatrobotHighScoreBuildProfile(state);
    for (const [ownedIndex, owned] of ownedJokers.entries()) {
      if (Boolean(owned?.modifier?.eternal)) continue;
      const remainingCredit = ownedJokers.some((joker, index) =>
        index !== ownedIndex && jokerKey(joker) === "j_credit_card") ? 20 : 0;
      const moneyAfterSale = Math.max(0, Number(state?.money) || 0) + cardSellPrice(owned) + remainingCredit;
      let bestReplacement = null;
      for (const offer of blockedOffers) {
        if (offer.price > moneyAfterSale) continue;
        const replacement = [...ownedJokers];
        replacement.splice(ownedIndex, 1, offer.card);
        const afterState = stateWithJokers(state, replacement);
        const after = balatrobotHighScoreBuildProfile(afterState);
        const gain = after.engineScore - currentProfile.engineScore;
        const scoreDelta = benchmarkScoreDelta(state, ownedJokers, replacement, benchmarks);
        const replacementValue = gain + scoreDelta.scoreLogDelta * 4;
        if (!bestReplacement || replacementValue > bestReplacement.replacementValue) {
          bestReplacement = { ...offer, after, gain, replacementValue, scoreDelta };
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
        },
        replacement: {
          shopIndex: bestReplacement.index,
          id: bestReplacement.card?.id ?? null,
          key: bestReplacement.card?.key ?? "",
          label: bestReplacement.card?.label ?? "",
          edition: cardModifier(bestReplacement.card, "edition"),
          price: bestReplacement.price,
          engineDelta: Math.round(bestReplacement.gain * 100) / 100,
          ...bestReplacement.scoreDelta,
        },
        expectedValue: 450 + bestReplacement.gain * 90,
        requiresStrategic: true,
        strategicReason: "selling a Joker is allowed only for a verified higher-ceiling replacement",
      });
    }
  }
  for (const [index, card] of cardsIn(state?.vouchers).entries()) {
    const price = cardBuyPrice(card);
    if (price > money) continue;
    candidates.push({
      id: `buy:voucher:${index}`,
      action: { method: "buy", voucher: index },
      card: { index, key: card?.key ?? "", label: card?.label ?? "", set: "VOUCHER", price, effect: cardEffect(card) },
      expectedValue: 750,
      requiresStrategic: true,
      strategicReason: "a voucher purchase changes the run economy",
    });
  }
  for (const [index, card] of cardsIn(state?.packs).entries()) {
    const price = cardBuyPrice(card);
    if (price > money) continue;
    candidates.push({
      id: `buy:pack:${index}`,
      action: { method: "buy", pack: index },
      card: { index, key: card?.key ?? "", label: card?.label ?? "", set: "BOOSTER", price, effect: cardEffect(card) },
      expectedValue: /mega/iu.test(String(card?.key ?? card?.label ?? "")) ? 700 : 480,
      requiresStrategic: true,
      strategicReason: "a booster purchase spends run economy",
    });
  }
  const rerollCost = Number(state?.round?.reroll_cost);
  if (Number.isFinite(rerollCost) && rerollCost >= 0 && rerollCost <= money) {
    candidates.push({
      id: "reroll:shop",
      action: { method: "reroll" },
      target: `search new shop offers for $${rerollCost}`,
      expectedValue: 300 + balatrobotHighScoreBuildProfile(state).missing.length * 45,
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
  return candidates
    .toSorted((left, right) => (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Number(limit) || 16));
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
  const seltzerCount = jokers.filter((joker) => jokerKey(joker) === "j_seltzer").length;
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
    if (seltzerCount) score.knownRetriggerSources.add("j_seltzer");
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

export function generateBalatrobotPackCandidates(state, { limit = 12, runPlan = null } = {}) {
  if (state?.state !== "SMODS_BOOSTER_OPENED") return [];
  const offered = cardsIn(state?.pack);
  const candidates = [];
  const activeRunPlan = runPlan ?? state?.__runPlan ?? null;
  for (const [index, card] of offered.entries()) {
    const set = String(card?.set ?? "").toUpperCase();
    if (set === "JOKER" && Number(state?.jokers?.count) >= Number(state?.jokers?.limit)) continue;
    if (TARGETED_CONSUMABLE_SETS.has(set)) {
      const target = bestPackTargets(state, card);
      if (!target) continue;
      candidates.push({
        id: `pack:${index}:${target.targets.join(",")}`,
        action: { method: "pack", card: index, targets: target.targets },
        card: { index, key: card?.key ?? "", label: card?.label ?? "", set },
        targetRule: target.rule,
        projectedPlay: target.projectedPlay ?? null,
        projectedScore: target.projectedScore,
        scoreGain: target.scoreGain,
        expectedValue: 600 + Math.max(0, target.scoreGain) + target.value,
      });
      continue;
    }
    const planetUpgrade = set === "PLANET" ? PLANET_HAND_UPGRADES.get(String(card?.key ?? "").toLowerCase()) : null;
    const planetValue = planetUpgrade ? planetPlanValue(state, planetUpgrade, activeRunPlan) : null;
    candidates.push({
      id: `pack:${index}`,
      action: { method: "pack", card: index, targets: [] },
      card: { index, key: card?.key ?? "", label: card?.label ?? "", set },
      handType: planetUpgrade?.handType ?? null,
      planRelevance: planetValue?.relevance ?? null,
      upgradeScoreDelta: planetValue?.scoreDelta ?? null,
      handPlayed: planetValue?.played ?? null,
      expectedValue: set === "PLANET"
        ? 200 + (planetValue?.priority ?? 0)
        : set === "JOKER" && scoringJoker(card) ? 900 : 500,
    });
  }
  candidates.push({
    id: "pack:skip",
    action: { method: "pack", skip: true },
    target: "skip only when every offered choice is unusable or harmful",
    expectedValue: 0,
  });
  return candidates
    .toSorted((left, right) => (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Number(limit) || 12));
}

function emergencyBossCandidates(state) {
  const boss = String(activeBlind(state)?.name ?? "").trim().toLowerCase();
  if (boss !== "verdant leaf" && boss !== "the verdant leaf") return [];
  if (!cardsIn(state?.hand).some(cardDebuffed)) return [];
  const sellable = cardsIn(state?.jokers)
    .map((joker, index) => ({ joker, index }))
    .filter(({ joker }) => !joker?.modifier?.eternal)
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
  }];
}

export function generateBalatrobotCandidates(state, { limit = 14, benchmarks = [], runPlan = null } = {}) {
  if (state?.state === "BLIND_SELECT") return generateBlindSelectCandidates(state);
  if (state?.state === "SHOP") return generateBalatrobotShopCandidates(state, { limit, benchmarks });
  if (state?.state === "SMODS_BOOSTER_OPENED") {
    return generateBalatrobotPackCandidates(state, { limit, runPlan });
  }
  if (state?.state !== "SELECTING_HAND") return [];
  const normalizedLimit = Math.max(2, Math.min(30, Number(limit) || 14));
  const discardLimit = Math.min(5, Math.max(2, Math.floor(normalizedLimit / 3)));
  const discards = discardCandidates(state, discardLimit);
  const plays = bestPlayCandidates(state, normalizedLimit - discards.length);
  const consumables = emergencyConsumableCandidates(state, plays);
  const semanticActions = [...emergencyBossCandidates(state), ...consumables];
  const handActions = [...plays, ...discards].slice(0, Math.max(0, normalizedLimit - semanticActions.length));
  let result = [...handActions, ...semanticActions].slice(0, normalizedLimit);
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
    .filter((candidate) => candidate.action?.method === "use")
    .toSorted(
      (left, right) =>
        (Number(right.projectedScore) || 0) - (Number(left.projectedScore) || 0) ||
        (Number(right.expectedValue) || 0) - (Number(left.expectedValue) || 0),
    )[0] ?? null;
  const requiredBossAction = (Array.isArray(candidates) ? candidates : []).find((candidate) => candidate.action?.method === "sell") ?? null;
  const blind = activeBlind(state);
  const discardsLeft = Number(state?.round?.discards_left);
  const bestPlay = plays[0] ?? null;
  const bestScore = Number(bestPlay?.conservativeScore) || 0;
  const budget = balatroRoundSurvivalBudget(state, bestScore);
  const { target, current, deficit, handsLeft, requiredPace } = budget;
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
    if (state?.state === "SELECTING_HAND" && HAND_ACTION_METHODS.has(action?.method)) {
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
    const safeChoice = candidates.find((candidate) => candidate.action?.method === "pack" && !candidate.action.skip);
    if (safeChoice) {
      throw new Error(
        `do not skip a pack with a locally safe choice: ${safeChoice.card?.label || safeChoice.card?.key || safeChoice.id}`,
      );
    }
    return action;
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
      return action;
    }
  }
  if (!HAND_ACTION_METHODS.has(action?.method)) return action;
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
    if (assessment.shouldResolveBoss) {
      throw new Error("Verdant Leaf is still debuffing the hand; sell the recommended non-core Joker before playing");
    }
    if (assessment.bestScore > 0 && chosenScore < assessment.bestScore * 0.72) {
      throw new Error(
        `play conservative score ${chosenScore} is far below the locally best ${assessment.bestScore}; choose the stronger candidate`,
      );
    }
    if (assessment.shouldDiscard) {
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
    const bestDiscardValue = Math.max(
      0,
      ...candidates.filter((candidate) => candidate.action?.method === "discard").map((candidate) => Number(candidate.expectedValue) || 0),
    );
    if (bestDiscardValue > 0 && (Number(selected?.expectedValue) || 0) < bestDiscardValue * 0.7) {
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
    if (assessment.bestScore >= assessment.deficit && assessment.deficit > 0 && !safeHighScoreChase) {
      throw new Error(`a local play already clears the remaining ${assessment.deficit}; do not spend a discard`);
    }
    if (
      assessment.handsLeft <= 3 &&
      assessment.requiredPace > 0 &&
      assessment.bestScore >= assessment.requiredPace * 1.35 &&
      !safeHighScoreChase
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
    return { strategic: true, effort: strategic, reason: `${state.state.toLowerCase()} changes the run build` };
  }
  if (state?.state === "BLIND_SELECT") {
    const selectable = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss]
      .filter(Boolean)
      .find((blind) => String(blind.status ?? "").toUpperCase().includes("SELECT"));
    const canSkip = selectable && String(selectable.type ?? "").toUpperCase() !== "BOSS";
    const hasSkipReward = Boolean(String(selectable?.tagName ?? selectable?.tag_name ?? "").trim());
    const developedRun = Number(state?.ante_num ?? state?.ante) >= 2;
    if (canSkip && hasSkipReward && developedRun) {
      return { strategic: true, effort: strategic, reason: "developed-run skip reward needs valuation" };
    }
    return { strategic: false, effort: routine, reason: "blind selection has a clear progress action" };
  }
  if (state?.state !== "SELECTING_HAND") return { strategic: false, effort: routine, reason: "local navigation" };
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
  if (boss || rescue) {
    const reasons = [
      boss && "one strategic package for this Boss blind",
      rescue && `consumable can clear the remaining ${survival.deficit}`,
    ].filter(Boolean);
    return { strategic: true, effort: strategic, reason: reasons.join(", "), checkpointPhase: "blind" };
  }
  const pressure = belowPace
    ? `local survival solver handles score ${bestBase} below pace ${Math.ceil(requiredPace)}`
    : discardsLeft > 0
      ? "local candidate solver ranks play versus discard"
      : "local candidate solver ranks the legal plays";
  return { strategic: false, effort: routine, reason: pressure };
}
