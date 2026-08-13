import { createHash } from "node:crypto";

import { balatrobotStateFingerprint } from "./balatrobot-policy.mjs";

// Policy/trajectory versions describe how a state and action were captured.
// Reward versions are deliberately independent: changing credit assignment
// must not make an otherwise compatible historical trajectory disappear.
export const SEMANTIC_POLICY_VERSION = 5;
export const SEMANTIC_REWARD_VERSION = 6;
const ROUND_COMPLETION_STATES = new Set(["ROUND_EVAL", "SHOP"]);

function cards(area) {
  return Array.isArray(area?.cards) ? area.cards : [];
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cardIdentity(card) {
  if (!card || typeof card !== "object") return "unknown";
  const value = card.value && typeof card.value === "object" ? card.value : {};
  const modifier = card.modifier && typeof card.modifier === "object" ? card.modifier : {};
  const state = card.state && typeof card.state === "object" ? card.state : {};
  const parts = [
    String(card.key || `${value.suit ?? "?"}_${value.rank ?? "?"}`),
    modifier.enhancement ? `enh:${modifier.enhancement}` : "",
    modifier.edition ? `edition:${modifier.edition}` : "",
    modifier.seal ? `seal:${modifier.seal}` : "",
    modifier.eternal ? "eternal" : "",
    modifier.rental ? "rental" : "",
    Number.isFinite(Number(modifier.perishable)) ? `perishable:${modifier.perishable}` : "",
    state.debuff ? "debuff" : "",
  ];
  return parts.filter(Boolean).join("+");
}

function cardBaseIdentity(card) {
  if (!card || typeof card !== "object") return "unknown";
  const value = card.value && typeof card.value === "object" ? card.value : {};
  return String(card.key || `${value.suit ?? "?"}_${value.rank ?? "?"}`);
}

function cardOfferIdentity(card) {
  const cost = finite(card?.cost?.buy);
  return `${cardIdentity(card)}@${cost ?? "?"}`;
}

function activeBlind(state) {
  const values = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss].filter(Boolean);
  return values.find((blind) => String(blind.status ?? "").toUpperCase() === "CURRENT") ??
    values.find((blind) => String(blind.status ?? "").toUpperCase() === "SELECT") ??
    values.find((blind) => String(blind.status ?? "").toUpperCase() === "UPCOMING") ??
    null;
}

function deckAggregate(area) {
  const rankCounts = {};
  const suitCounts = {};
  const modifiers = {};
  for (const card of cards(area)) {
    const rank = String(card?.value?.rank ?? "?");
    const suit = String(card?.value?.suit ?? "?");
    rankCounts[rank] = (rankCounts[rank] ?? 0) + 1;
    suitCounts[suit] = (suitCounts[suit] ?? 0) + 1;
    for (const token of [card?.modifier?.enhancement, card?.modifier?.edition, card?.modifier?.seal].filter(Boolean)) {
      modifiers[token] = (modifiers[token] ?? 0) + 1;
    }
  }
  return {
    count: Number.isInteger(area?.count) ? area.count : cards(area).length,
    rankCounts,
    suitCounts,
    modifiers,
  };
}

function pokerHandFeatures(hands) {
  if (!hands || typeof hands !== "object") return [];
  return Object.entries(hands)
    .map(([name, hand]) => ({
      name,
      level: finite(hand?.level, 0),
      chips: finite(hand?.chips, 0),
      mult: finite(hand?.mult, 0),
      played: finite(hand?.played, 0),
    }))
    .filter((hand) => hand.level > 1 || hand.played > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function strategyPhase(ante) {
  if (ante <= 2) return "early";
  if (ante <= 5) return "mid";
  return "late";
}

function economyBand(money) {
  if (money < 5) return "broke";
  if (money < 10) return "low";
  if (money < 25) return "interest";
  return "rich";
}

function handShape(area) {
  const rankCounts = {};
  const suitCounts = {};
  for (const card of cards(area)) {
    const rank = String(card?.value?.rank ?? "?");
    const suit = String(card?.value?.suit ?? "?");
    rankCounts[rank] = (rankCounts[rank] ?? 0) + 1;
    suitCounts[suit] = (suitCounts[suit] ?? 0) + 1;
  }
  return {
    rankGroups: Object.values(rankCounts).sort((left, right) => right - left),
    suitGroups: Object.values(suitCounts).sort((left, right) => right - left),
    distinctRanks: Object.keys(rankCounts).length,
    distinctSuits: Object.keys(suitCounts).length,
  };
}

function pokerTargets(pokerHands) {
  return [...pokerHands]
    .sort((left, right) => right.level - left.level || right.played - left.played || right.mult - left.mult)
    .slice(0, 4)
    .map((hand) => `${hand.name}:L${hand.level}`);
}

// Old trajectories are immutable and intentionally keep their original
// feature version.  This adapter supplies fields introduced by later policies
// so v1-v5 trajectories can still participate in semantic retrieval and reward
// relabelling without rewriting their raw JSON.
export function semanticNormalizeFeatures(value, { canonicalVersion = false } = {}) {
  if (!value || typeof value !== "object" || typeof value.screen !== "string") return null;
  const features = structuredClone(value);
  features.version = canonicalVersion ? SEMANTIC_POLICY_VERSION : finite(features.version, 1);
  features.ante = finite(features.ante, 0);
  features.roundNumber = finite(features.roundNumber, 0);
  features.money = finite(features.money, 0);
  features.deck = String(features.deck ?? "");
  features.stake = String(features.stake ?? "");
  features.blind = features.blind && typeof features.blind === "object" ? features.blind : {};
  features.blind = {
    type: String(features.blind.type ?? ""),
    name: String(features.blind.name ?? ""),
    target: finite(features.blind.target, 0),
  };
  features.round = features.round && typeof features.round === "object" ? features.round : {};
  const score = finite(features.round.score, 0);
  features.round = {
    score,
    pressure: finite(
      features.round.pressure,
      features.blind.target > 0 ? clamp(score / features.blind.target, 0, 3) : 0,
    ),
    handsLeft: finite(features.round.handsLeft, 0),
    discardsLeft: finite(features.round.discardsLeft, 0),
    rerollCost: finite(features.round.rerollCost, 0),
  };
  for (const field of [
    "hand", "jokers", "consumables", "shop", "voucherOffers", "packOffers", "openedPack",
    "usedVouchers", "appearedJokers", "pokerHands", "tokens",
  ]) {
    features[field] = Array.isArray(features[field]) ? features[field] : [];
  }
  features.collectionSignature = String(features.collectionSignature ?? "");
  features.remainingDeck = features.remainingDeck && typeof features.remainingDeck === "object"
    ? features.remainingDeck
    : {};
  features.remainingDeck = {
    count: finite(features.remainingDeck.count, 0),
    rankCounts: features.remainingDeck.rankCounts && typeof features.remainingDeck.rankCounts === "object"
      ? features.remainingDeck.rankCounts
      : {},
    suitCounts: features.remainingDeck.suitCounts && typeof features.remainingDeck.suitCounts === "object"
      ? features.remainingDeck.suitCounts
      : {},
    modifiers: features.remainingDeck.modifiers && typeof features.remainingDeck.modifiers === "object"
      ? features.remainingDeck.modifiers
      : {},
  };
  const oldStrategy = features.strategy && typeof features.strategy === "object" ? features.strategy : {};
  features.strategy = {
    phase: String(oldStrategy.phase ?? strategyPhase(features.ante)),
    economy: String(oldStrategy.economy ?? economyBand(features.money)),
    jokerKeys: Array.isArray(oldStrategy.jokerKeys)
      ? oldStrategy.jokerKeys
      : features.jokers.map((entry) => String(entry).split("+")[0]).sort(),
    pokerTargets: Array.isArray(oldStrategy.pokerTargets)
      ? oldStrategy.pokerTargets
      : pokerTargets(features.pokerHands),
    handShape: oldStrategy.handShape && typeof oldStrategy.handShape === "object"
      ? oldStrategy.handShape
      : { rankGroups: [], suitGroups: [], distinctRanks: 0, distinctSuits: 0 },
  };
  for (const field of ["rankGroups", "suitGroups"]) {
    features.strategy.handShape[field] = Array.isArray(features.strategy.handShape[field])
      ? features.strategy.handShape[field]
      : [];
  }
  return features;
}

export function semanticFeatureCompatibility(value) {
  const normalized = semanticNormalizeFeatures(value);
  if (!normalized || !normalized.screen || !Number.isFinite(normalized.ante)) return "incompatible";
  const sourceVersion = finite(value?.version, 1);
  const hasExactSafetyFields = sourceVersion >= 4 &&
    Object.hasOwn(value, "collectionSignature") &&
    Object.hasOwn(value, "appearedJokers") &&
    value.strategy && typeof value.strategy === "object";
  return hasExactSafetyFields ? "exact" : "semantic";
}

function objectTokens(prefix, value) {
  return Object.entries(value ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${prefix}:${key}:${count}`)
    .sort();
}

export function semanticStateFeatures(state) {
  if (!state || typeof state !== "object" || typeof state.state !== "string") {
    throw new Error("semantic state requires a BalatroBot GameState object");
  }
  const blind = activeBlind(state);
  const target = finite(blind?.score, 0);
  const score = finite(state.round?.chips, 0);
  const remainingDeck = deckAggregate(state.cards);
  const pokerHands = pokerHandFeatures(state.hands);
  const ante = finite(state.ante_num, 0);
  const money = finite(state.money, 0);
  const collectionKnowledge = state.collection_knowledge && typeof state.collection_knowledge === "object"
    ? state.collection_knowledge
    : {};
  const appearedJokers = (state.appeared_this_run?.jokers ?? [])
    .map((joker) => String(joker?.key ?? ""))
    .filter(Boolean)
    .sort();
  const features = {
    version: SEMANTIC_POLICY_VERSION,
    screen: state.state,
    ante,
    roundNumber: finite(state.round_num, 0),
    money,
    deck: String(state.deck ?? ""),
    stake: String(state.stake ?? ""),
    won: Boolean(state.won),
    blind: {
      type: String(blind?.type ?? ""),
      name: String(blind?.name ?? ""),
      target,
    },
    round: {
      score,
      pressure: target > 0 ? clamp(score / target, 0, 3) : 0,
      handsLeft: finite(state.round?.hands_left, 0),
      discardsLeft: finite(state.round?.discards_left, 0),
      rerollCost: finite(state.round?.reroll_cost, 0),
    },
    slots: {
      jokers: [finite(state.jokers?.count, cards(state.jokers).length), finite(state.jokers?.limit, 0)],
      consumables: [finite(state.consumables?.count, cards(state.consumables).length), finite(state.consumables?.limit, 0)],
    },
    hand: cards(state.hand).map(cardIdentity),
    jokers: cards(state.jokers).map(cardIdentity),
    consumables: cards(state.consumables).map(cardIdentity),
    shop: cards(state.shop).map(cardOfferIdentity),
    voucherOffers: cards(state.vouchers).map(cardOfferIdentity),
    packOffers: cards(state.packs).map(cardOfferIdentity),
    openedPack: cards(state.pack).map(cardIdentity),
    usedVouchers: Object.keys(state.used_vouchers ?? {}).sort(),
    collectionSignature: String(collectionKnowledge.signature ?? ""),
    appearedJokers,
    remainingDeck,
    pokerHands,
    strategy: {
      phase: strategyPhase(ante),
      economy: economyBand(money),
      jokerKeys: cards(state.jokers).map(cardBaseIdentity).sort(),
      pokerTargets: pokerTargets(pokerHands),
      handShape: handShape(state.hand),
    },
  };
  features.tokens = [
    ...features.jokers.map((value) => `joker:${value}`),
    ...features.consumables.map((value) => `consumable:${value}`),
    ...features.hand.map((value) => `hand:${value}`),
    ...features.shop.map((value) => `shop:${value}`),
    ...features.voucherOffers.map((value) => `voucher-offer:${value}`),
    ...features.packOffers.map((value) => `pack-offer:${value}`),
    ...features.openedPack.map((value) => `opened-pack:${value}`),
    ...features.usedVouchers.map((value) => `used-voucher:${value}`),
    ...(features.collectionSignature ? [`collection:${features.collectionSignature}`] : []),
    ...features.appearedJokers.map((value) => `appeared-joker:${value}`),
    ...features.pokerHands.map((hand) => `poker:${hand.name}:L${hand.level}:P${hand.played}`),
    `phase:${features.strategy.phase}`,
    `economy:${features.strategy.economy}`,
    ...features.strategy.jokerKeys.map((value) => `build-joker:${value}`),
    ...features.strategy.pokerTargets.map((value) => `build-poker:${value}`),
    ...objectTokens("rank", remainingDeck.rankCounts),
    ...objectTokens("suit", remainingDeck.suitCounts),
    ...objectTokens("deck-mod", remainingDeck.modifiers),
  ];
  return features;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function semanticReplayFingerprint(stateOrFeatures) {
  const features = typeof stateOrFeatures?.screen === "string" && "tokens" in stateOrFeatures
    ? stateOrFeatures
    : semanticStateFeatures(stateOrFeatures);
  return hashJson({
    version: features.version,
    screen: features.screen,
    ante: features.ante,
    roundNumber: features.roundNumber,
    money: features.money,
    deck: features.deck,
    stake: features.stake,
    blind: features.blind,
    round: features.round,
    slots: features.slots,
    hand: features.hand,
    jokers: features.jokers,
    consumables: features.consumables,
    shop: features.shop,
    voucherOffers: features.voucherOffers,
    packOffers: features.packOffers,
    openedPack: features.openedPack,
    usedVouchers: features.usedVouchers,
    collectionSignature: features.collectionSignature,
    appearedJokers: features.appearedJokers,
    remainingDeck: features.remainingDeck,
    pokerHands: features.pokerHands,
  });
}

function dominantPokerHand(features) {
  return [...features.pokerHands]
    .sort((left, right) => right.level - left.level || right.played - left.played || right.mult - left.mult)[0]?.name ?? "none";
}

export function semanticStateBucket(stateOrFeatures) {
  const features = typeof stateOrFeatures?.screen === "string" && "tokens" in stateOrFeatures
    ? stateOrFeatures
    : semanticStateFeatures(stateOrFeatures);
  const jokerBuild = [...features.strategy.jokerKeys].sort().join(",") || "none";
  return [
    `v${features.version}`,
    features.screen,
    `phase:${features.strategy.phase}`,
    `blind:${features.blind.type || "none"}`,
    `economy:${features.strategy.economy}`,
    `pool:${features.collectionSignature || "unknown"}`,
    `jokers:${jokerBuild}`,
    `poker:${dominantPokerHand(features)}`,
  ].join("|");
}

export function semanticStateText(stateOrFeatures) {
  const features = typeof stateOrFeatures?.screen === "string" && "tokens" in stateOrFeatures
    ? stateOrFeatures
    : semanticStateFeatures(stateOrFeatures);
  const poker = features.pokerHands.map((hand) => `${hand.name}:L${hand.level}/P${hand.played}`).join(",") || "base";
  return [
    `${features.screen} ante=${features.ante} round=${features.roundNumber}`,
    `blind=${features.blind.name || features.blind.type || "none"}`,
    `score=${features.round.score}/${features.blind.target || "?"}`,
    `hands=${features.round.handsLeft} discards=${features.round.discardsLeft}`,
    `money=${features.money}`,
    `jokers=${features.jokers.join(",") || "none"}`,
    `appearedJokers=${features.appearedJokers.join(",") || "none"}`,
    `hand=${features.hand.join(",") || "none"}`,
    `shop=${[...features.shop, ...features.voucherOffers, ...features.packOffers].join(",") || "none"}`,
    `poker=${poker}`,
    `deckRemaining=${features.remainingDeck.count}`,
  ].join("; ");
}

function jaccard(leftValues, rightValues) {
  const left = new Set(leftValues ?? []);
  const right = new Set(rightValues ?? []);
  if (!left.size && !right.size) return 1;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return common / (left.size + right.size - common || 1);
}

function numericSimilarity(left, right, scale) {
  return 1 - clamp(Math.abs(finite(left, 0) - finite(right, 0)) / scale, 0, 1);
}

export function semanticStateSimilarity(leftStateOrFeatures, rightStateOrFeatures) {
  const left = typeof leftStateOrFeatures?.screen === "string" && "tokens" in leftStateOrFeatures
    ? leftStateOrFeatures
    : semanticStateFeatures(leftStateOrFeatures);
  const right = typeof rightStateOrFeatures?.screen === "string" && "tokens" in rightStateOrFeatures
    ? rightStateOrFeatures
    : semanticStateFeatures(rightStateOrFeatures);
  if (left.screen !== right.screen) return 0;

  let score = 0;
  let weight = 0;
  const add = (value, amount) => {
    score += clamp(value, 0, 1) * amount;
    weight += amount;
  };
  add(left.deck === right.deck ? 1 : 0, 0.025);
  add(left.stake === right.stake ? 1 : 0, 0.02);
  add(left.blind.type === right.blind.type ? 1 : 0, 0.06);
  add(left.blind.name === right.blind.name ? 1 : 0, 0.025);
  add(left.strategy.phase === right.strategy.phase ? 1 : 0, 0.08);
  add(numericSimilarity(left.ante, right.ante, 4), 0.04);
  add(left.strategy.economy === right.strategy.economy ? 1 : 0, 0.06);
  add(numericSimilarity(left.money, right.money, 25), 0.03);
  add(numericSimilarity(left.round.pressure, right.round.pressure, 1.25), 0.07);
  add(numericSimilarity(left.round.handsLeft, right.round.handsLeft, 5), 0.05);
  add(numericSimilarity(left.round.discardsLeft, right.round.discardsLeft, 5), 0.05);
  add(numericSimilarity(left.remainingDeck.count, right.remainingDeck.count, 30), 0.03);
  add(jaccard(left.strategy.jokerKeys, right.strategy.jokerKeys), 0.24);
  add(jaccard(left.usedVouchers, right.usedVouchers), 0.03);
  add(
    left.collectionSignature && right.collectionSignature
      ? Number(left.collectionSignature === right.collectionSignature)
      : 0.5,
    0.04,
  );
  add(jaccard(left.appearedJokers, right.appearedJokers), 0.07);
  add(jaccard(left.strategy.pokerTargets, right.strategy.pokerTargets), 0.13);

  if (left.screen === "SELECTING_HAND") {
    add(jaccard(left.hand, right.hand), 0.1);
    add(jaccard(left.strategy.handShape.rankGroups, right.strategy.handShape.rankGroups), 0.08);
    add(jaccard(left.strategy.handShape.suitGroups, right.strategy.handShape.suitGroups), 0.04);
  }
  else if (left.screen === "SHOP") {
    add(jaccard(left.shop, right.shop), 0.08);
    add(jaccard(left.voucherOffers, right.voucherOffers), 0.04);
    add(jaccard(left.packOffers, right.packOffers), 0.04);
  } else if (left.screen === "SMODS_BOOSTER_OPENED") add(jaccard(left.openedPack, right.openedPack), 0.15);
  else add(jaccard(left.tokens, right.tokens), 0.08);

  return weight ? score / weight : 0;
}

function areaCard(state, name, index) {
  return cards(state?.[name])[index] ?? null;
}

function cardListFromIndices(state, area, indices) {
  return (Array.isArray(indices) ? indices : []).map((index) => cardIdentity(areaCard(state, area, index)));
}

export function semanticActionTemplate(state, action) {
  const method = String(action?.method ?? "");
  const params = action?.params && typeof action.params === "object" ? action.params : {};
  switch (method) {
    case "play":
    case "discard":
      return { method, cards: cardListFromIndices(state, "hand", params.cards) };
    case "buy": {
      const choice = ["card", "voucher", "pack"].find((name) => Number.isInteger(params[name]));
      const area = choice === "card" ? "shop" : choice === "voucher" ? "vouchers" : "packs";
      return { method, choice, item: cardOfferIdentity(areaCard(state, area, params[choice])) };
    }
    case "sell": {
      const choice = ["joker", "consumable"].find((name) => Number.isInteger(params[name]));
      const area = choice === "joker" ? "jokers" : "consumables";
      return { method, choice, item: cardIdentity(areaCard(state, area, params[choice])) };
    }
    case "use":
      return {
        method,
        item: cardIdentity(areaCard(state, "consumables", params.consumable)),
        cards: cardListFromIndices(state, "hand", params.cards),
      };
    case "pack":
      return params.skip
        ? { method, skip: true }
        : {
            method,
            item: cardIdentity(areaCard(state, "pack", params.card)),
            targets: cardListFromIndices(state, "hand", params.targets),
          };
    case "rearrange":
      return { method, area: Object.keys(params).find((key) => Array.isArray(params[key])) ?? "unknown" };
    default:
      return { method };
  }
}

export function semanticActionKey(state, action) {
  return JSON.stringify(semanticActionTemplate(state, action));
}

export function semanticActionSummary(state, action) {
  const template = semanticActionTemplate(state, action);
  const details = Object.entries(template)
    .filter(([key]) => key !== "method")
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
    .join(" ");
  return `${template.method}${details ? ` ${details}` : ""}`;
}

function scorePressure(state) {
  const blind = activeBlind(state);
  const target = finite(blind?.score, 0);
  return target > 0 ? clamp(finite(state?.round?.chips, 0) / target, 0, 3) : 0;
}

export function semanticTransitionReward(before, action, after) {
  return semanticTransitionRewardFromFeatures(
    semanticStateFeatures(before),
    action,
    semanticStateFeatures(after),
  );
}

export function semanticPlayedHandScoreFromFeatures(beforeValue, action, afterValue) {
  const before = semanticNormalizeFeatures(beforeValue);
  const after = semanticNormalizeFeatures(afterValue);
  if (!before || !after) return 0;
  if (action?.method !== "play") return 0;
  const beforeScore = finite(before?.round?.score, 0);
  const afterScore = finite(after?.round?.score, 0);
  const sameRound = finite(before?.roundNumber, -1) === finite(after?.roundNumber, -2);
  return sameRound && afterScore > beforeScore ? afterScore - beforeScore : 0;
}

export function semanticTransitionRewardFromFeatures(beforeValue, action, afterValue) {
  const before = semanticNormalizeFeatures(beforeValue);
  const after = semanticNormalizeFeatures(afterValue);
  if (!before || !after) return null;
  let reward = 0;
  const beforeAnte = finite(before.ante, 0);
  const afterAnte = finite(after.ante, beforeAnte);
  const beforeRound = finite(before.roundNumber, 0);
  const afterRound = finite(after.roundNumber, beforeRound);
  reward += Math.max(0, afterAnte - beforeAnte) * 1.25;
  reward += Math.max(0, afterRound - beforeRound) * 0.45;

  if (before.screen === "SELECTING_HAND") {
    reward += (after.round.pressure - before.round.pressure) * 1.5;
    if (ROUND_COMPLETION_STATES.has(after.screen)) reward += 0.8;
  }
  const handScore = semanticPlayedHandScoreFromFeatures(before, action, after);
  if (handScore > 0) {
    // Give the learner a small, smooth signal for better hands without letting
    // one hand overwhelm survival. The episode peak supplies the long-horizon
    // high-score reward at game over.
    reward += clamp((Math.log10(Math.max(100, handScore)) - 2) * 0.18, 0, 0.9);
  }
  if (action?.method === "discard") reward -= 0.025;
  if (action?.method === "skip") reward -= 0.35;
  if (action?.method === "reroll") reward -= 0.06;
  if (action?.method === "buy") reward += 0.05;
  return Math.round(clamp(reward, -4, 6) * 1_000) / 1_000;
}

export function semanticPlayedHandScore(before, action, after) {
  if (action?.method !== "play") return 0;
  const beforeScore = finite(before?.round?.chips, 0);
  const afterScore = finite(after?.round?.chips, 0);
  // BalatroBot can advance the Ante in the response to the Boss-clearing play
  // while round_num and the just-scored chip total still describe that blind.
  // Requiring the Ante to stay unchanged silently dropped the final (and often
  // largest) hand of every Boss.
  const sameRound = finite(before?.round_num, -1) === finite(after?.round_num, -2);
  return sameRound && afterScore > beforeScore ? afterScore - beforeScore : 0;
}

export function semanticHighScoreTier(score) {
  const value = Math.max(0, finite(score, 0));
  if (value >= 1_000_000) return "million";
  if (value >= 100_000) return "hundred_thousand";
  if (value >= 10_000) return "ten_thousand";
  return "developing";
}

function highScoreBonus(score) {
  const value = Math.max(0, finite(score, 0));
  if (!value) return 0;
  const logarithmic = Math.max(0, Math.log10(value) - 3) * 1.25;
  const milestones = (value >= 10_000 ? 0.75 : 0) +
    (value >= 100_000 ? 1.5 : 0) +
    (value >= 1_000_000 ? 3.5 : 0);
  return logarithmic + milestones;
}

export function semanticTerminalOutcome(
  state,
  { victoryCheckpointSeen = false, victoryCheckpointTerminal = false } = {},
) {
  // G.GAME.won is historical and is set before Balatro decides whether the
  // Ante-8 Boss hand actually cleared. Therefore GAME_OVER + won=true can be
  // an ordinary failed Boss, not a victory. ROUND_EVAL+won is the native win
  // overlay checkpoint; treat it as terminal only when the configured mode
  // leaves the run there instead of continuing into Endless.
  if (victoryCheckpointTerminal && state?.state === "ROUND_EVAL" && state?.won === true) return "won";
  if (state?.state === "GAME_OVER") return victoryCheckpointSeen ? "won" : "lost";
  return null;
}

export function semanticTerminalBonus(outcome, finalState) {
  const ante = finite(finalState?.ante_num, 0);
  const peakHand = finite(
    finalState?.trainingMaxHandScore ?? finalState?.maxHandScore ?? finalState?.max_hand_score,
    0,
  );
  const scoreBonus = highScoreBonus(peakHand);
  if (outcome === "won") return 10 + Math.min(12, ante) * 0.3 + scoreBonus;
  if (outcome === "lost") {
    const unspentMoneyPenalty = Math.min(3, Math.max(0, finite(finalState?.money, 0)) / 20);
    const earlyCollapsePenalty = Math.max(0, 5 - ante) * 0.75;
    // A failed run stays negative. High-score milestones make it less bad (and
    // therefore preserve useful ordering) but must not turn thousands of steps
    // from a losing trajectory into positive demonstrations.
    return Math.min(
      -0.5,
      -10 + Math.min(12, ante) * 0.3 + Math.min(8, scoreBonus) - unspentMoneyPenalty - earlyCollapsePenalty,
    );
  }
  return 0;
}

export function semanticDiscountedReturns(transitions, outcome, finalState, discount = 0.97) {
  const result = new Map();
  const terminal = semanticTerminalBonus(outcome, finalState);
  const gamma = clamp(discount, 0, 1);
  let localFuture = 0;
  for (let index = transitions.length - 1; index >= 0; index--) {
    const transition = transitions[index];
    // Dense per-click rewards are deliberately a bounded ranking signal. The
    // terminal outcome is propagated separately with a non-vanishing weight,
    // so a 200-step loss cannot forget that it lost merely because gamma^200
    // is tiny. Later actions receive more terminal credit/blame than early ones.
    localFuture = clamp(
      finite(transition.immediateReward, 0) * 0.12 + gamma * localFuture,
      -0.9,
      0.9,
    );
    const proximity = transitions.length <= 1 ? 1 : index / (transitions.length - 1);
    const terminalWeight = 0.5 + 0.5 * proximity;
    const denseScale = outcome === "lost" ? 0.18 : 1;
    let value = terminal * terminalWeight + localFuture * denseScale;
    if (outcome === "lost") value = Math.min(-0.05, value);
    if (outcome === "won") value = Math.max(0.05, value);
    result.set(Number(transition.id), Math.round(clamp(value, -24, 30) * 1_000) / 1_000);
  }
  return result;
}

export function semanticExactFingerprint(state) {
  return balatrobotStateFingerprint(state);
}
