import {
  balatroCardDebuffed,
  balatroCardModifier,
  balatroCardRank,
  balatroCardSuit,
  balatroCards,
  balatroConsumableTargetRule,
  balatroJokerDebuffed,
  balatroRankNumber,
} from "./balatro-rules-engine.mjs";

// This module owns consumable semantics, valuation and safety.  It deliberately
// does not import the solver: callers inject the local best-play evaluator so
// the solver can use these transformations without creating an import cycle.

const TARGET_STATE = "SELECTING_HAND";
const PASSIVE_STATES = new Set(["SELECTING_HAND", "SHOP"]);

const PLANETS = Object.freeze({
  c_pluto: ["High Card", 10, 1],
  c_mercury: ["Pair", 15, 1],
  c_uranus: ["Two Pair", 20, 1],
  c_venus: ["Three of a Kind", 20, 2],
  c_saturn: ["Straight", 30, 3],
  c_jupiter: ["Flush", 15, 2],
  c_earth: ["Full House", 25, 2],
  c_mars: ["Four of a Kind", 30, 3],
  c_neptune: ["Straight Flush", 40, 4],
  c_planet_x: ["Five of a Kind", 35, 3],
  c_ceres: ["Flush House", 40, 4],
  c_eris: ["Flush Five", 50, 3],
});

const TAROT = Object.freeze({
  c_fool: descriptor("The Fool", "generate", "strategic", { target: false }),
  c_magician: descriptor("The Magician", "enhance", "exact"),
  c_high_priestess: descriptor("The High Priestess", "generate", "exact", { target: false }),
  c_empress: descriptor("The Empress", "enhance", "exact"),
  c_emperor: descriptor("The Emperor", "generate", "exact", { target: false }),
  c_heirophant: descriptor("The Hierophant", "enhance", "exact"),
  c_lovers: descriptor("The Lovers", "enhance", "exact"),
  c_chariot: descriptor("The Chariot", "enhance-held", "exact"),
  c_justice: descriptor("Justice", "glass", "strategic", { destructive: true }),
  c_hermit: descriptor("The Hermit", "money", "exact", { target: false }),
  c_wheel_of_fortune: descriptor("The Wheel of Fortune", "random-edition", "strategic", { target: false }),
  c_strength: descriptor("Strength", "rank", "exact"),
  c_hanged_man: descriptor("The Hanged Man", "remove", "strategic", { destructive: true }),
  // Death permanently overwrites the left playing card.  Its target contract
  // is exact, but it must never become an automatic/local-fallback action.
  c_death: descriptor("Death", "ordered-copy", "exact", { destructive: true }),
  c_temperance: descriptor("Temperance", "money", "exact", { target: false }),
  c_devil: descriptor("The Devil", "enhance-held", "exact"),
  c_tower: descriptor("The Tower", "stone", "strategic", { destructive: true }),
  c_star: descriptor("The Star", "suit", "exact"),
  c_moon: descriptor("The Moon", "suit", "exact"),
  c_sun: descriptor("The Sun", "suit", "exact"),
  c_judgement: descriptor("Judgement", "joker-generate", "strategic", { target: false }),
  c_world: descriptor("The World", "suit", "exact"),
});

const SPECTRAL = Object.freeze({
  c_familiar: descriptor("Familiar", "destroy-generate", "strategic", { target: false, destructive: true, needsHand: true }),
  c_grim: descriptor("Grim", "destroy-generate", "strategic", { target: false, destructive: true, needsHand: true }),
  c_incantation: descriptor("Incantation", "destroy-generate", "strategic", { target: false, destructive: true, needsHand: true }),
  c_talisman: descriptor("Talisman", "seal", "exact"),
  c_aura: descriptor("Aura", "edition", "strategic"),
  c_wraith: descriptor("Wraith", "joker-money", "strategic", { target: false, destructive: true }),
  c_sigil: descriptor("Sigil", "suit-randomize", "strategic", { target: false, destructive: true, needsHand: true }),
  c_ouija: descriptor("Ouija", "rank-randomize", "strategic", { target: false, destructive: true, needsHand: true }),
  c_ectoplasm: descriptor("Ectoplasm", "negative-joker", "strategic", { target: false, destructive: true }),
  c_immolate: descriptor("Immolate", "destroy-money", "strategic", { target: false, destructive: true, needsHand: true }),
  c_ankh: descriptor("Ankh", "copy-joker", "strategic", { target: false, destructive: true }),
  c_deja_vu: descriptor("Deja Vu", "seal", "exact"),
  c_hex: descriptor("Hex", "polychrome-joker", "strategic", { target: false, destructive: true }),
  c_trance: descriptor("Trance", "seal", "exact"),
  c_medium: descriptor("Medium", "seal", "exact"),
  c_cryptid: descriptor("Cryptid", "copy-playing-card", "exact"),
  c_soul: descriptor("The Soul", "joker-generate", "exact", { target: false }),
  c_black_hole: descriptor("Black Hole", "all-hands-upgrade", "exact", { target: false }),
});

function descriptor(label, kind, support, options = {}) {
  return Object.freeze({
    label,
    kind,
    support,
    target: options.target !== false,
    destructive: Boolean(options.destructive),
    needsHand: Boolean(options.needsHand),
    ownedUse: options.ownedUse !== false,
    packUse: options.packUse !== false,
  });
}

const STRATEGIES = Object.freeze({
  ...TAROT,
  ...Object.fromEntries(Object.entries(PLANETS).map(([key, [handType, chips, mult]]) => [
    key,
    Object.freeze({
      ...descriptor(handType, "planet", "exact", { target: false }),
      handType,
      chips,
      mult,
    }),
  ])),
  ...SPECTRAL,
});

export const BALATRO_CONSUMABLE_STRATEGIES = STRATEGIES;
export const BALATRO_CONSUMABLE_KEYS = Object.freeze(Object.keys(STRATEGIES).toSorted());

function keyOf(card) {
  return String(card?.key ?? "").trim().toLowerCase();
}

function cards(area) {
  return balatroCards(area);
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function modifier(card, name) {
  return String(balatroCardModifier(card, name) ?? "").toUpperCase();
}

function cloneCard(card) {
  return {
    ...card,
    value: card?.value ? { ...card.value } : card?.value,
    modifier: card?.modifier ? { ...card.modifier } : card?.modifier,
    state: card?.state ? { ...card.state } : card?.state,
  };
}

function stateWithHand(state, handCards) {
  return {
    ...state,
    hand: {
      ...(state?.hand ?? {}),
      count: handCards.length,
      cards: handCards,
    },
  };
}

function stateWithHands(state, hands) {
  const sourceKey = state?.hands && typeof state.hands === "object" ? "hands" : "pokerHands";
  return { ...state, [sourceKey]: hands };
}

function handSource(state) {
  return state?.hands && typeof state.hands === "object" ? state.hands : state?.pokerHands ?? {};
}

function normalizedEvaluation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const score = finite(raw.conservativeScore ?? raw.estimatedScore ?? raw.score, Number.NaN);
  if (!Number.isFinite(score)) return null;
  return { ...raw, conservativeScore: score };
}

function evaluate(evaluateBestPlay, state) {
  if (typeof evaluateBestPlay !== "function") return null;
  try {
    return normalizedEvaluation(evaluateBestPlay(state));
  } catch {
    return null;
  }
}

function combinations(count, minimum, maximum) {
  const result = [];
  const visit = (start, picked) => {
    if (picked.length >= minimum) result.push([...picked]);
    if (picked.length >= maximum) return;
    for (let index = start; index < count; index += 1) {
      picked.push(index);
      visit(index + 1, picked);
      picked.pop();
    }
  };
  visit(0, []);
  return result;
}

// Targeted consumables need alternatives for the strategic model (the best
// immediate hand is often not the best permanent deck edit), but evaluating
// every 1..N subset grows very quickly for enlarged hands.  Keep a bounded
// card pool and a bounded number of solver simulations per consumable.
const TARGETED_CARD_POOL_LIMIT = 12;
const TARGETED_EVALUATION_LIMIT = 72;
const TARGETED_TOP_K = 3;

function packArea(state) {
  return cards(cards(state?.pack).length ? state?.pack : state?.openedPack);
}

function rank(card) {
  return balatroRankNumber(balatroCardRank(card));
}

function cardQuality(card) {
  let value = rank(card) * 8;
  if (balatroCardDebuffed(card)) value -= 100;
  if (modifier(card, "enhancement")) value += 120;
  if (modifier(card, "edition")) value += 220;
  if (modifier(card, "seal")) value += 140;
  return value;
}

function enhancementOverwritePenalty(card, enhancement) {
  const current = modifier(card, "enhancement");
  if (!current || current === String(enhancement ?? "").toUpperCase()) return 0;
  // Replacing an existing enhancement is an irreversible loss. Editions and
  // seals coexist with enhancements, so they are intentionally not charged.
  return 520 + Math.max(0, rank(card)) * 12;
}

function knownDeckCards(state) {
  const deck = cards(state?.cards);
  const hand = cards(state?.hand);
  return deck.length ? [...deck, ...hand] : hand;
}

function countKnown(state, getter, value) {
  return knownDeckCards(state).filter((card) => getter(card) === value).length;
}

function jokerQuality(joker) {
  const effect = String(joker?.value?.effect ?? joker?.effect ?? "").toLowerCase();
  let value = 350 + finite(joker?.cost?.sell ?? joker?.sell) * 120;
  const edition = modifier(joker, "edition");
  if (edition.includes("POLYCHROME")) value += 1_000;
  else if (edition.includes("NEGATIVE")) value += 850;
  else if (edition.includes("HOLO")) value += 450;
  else if (edition.includes("FOIL")) value += 300;
  if (/[x×]\s*\d/iu.test(effect)) value += 850;
  if (/(?:retrigger|额外触发|重新触发|复制|copy)/iu.test(effect)) value += 650;
  if (/(?:每次|per|when).*(?:\+|increase|增加|成长)/iu.test(effect)) value += 450;
  if (joker?.modifier?.eternal) value += 250;
  return value;
}

function copyPlayingCard(target, source) {
  const copy = cloneCard(source);
  return {
    ...target,
    key: copy.key,
    rank: copy.rank,
    suit: copy.suit,
    value: copy.value,
    modifier: copy.modifier,
    state: { ...(target?.state ?? {}), debuff: false, hidden: false, highlight: false },
  };
}

function setPlayingCard(card, { rank: nextRank, suit, enhancement, seal, edition } = {}) {
  const next = cloneCard(card);
  if (nextRank != null) {
    next.rank = nextRank;
    next.value = { ...(next.value ?? {}), rank: nextRank };
  }
  if (suit != null) {
    next.suit = suit;
    next.value = { ...(next.value ?? {}), suit };
  }
  next.modifier = { ...(next.modifier ?? {}) };
  if (enhancement != null) next.modifier.enhancement = enhancement;
  if (seal != null) next.modifier.seal = seal;
  if (edition != null) next.modifier.edition = edition;
  return next;
}

function strengthRank(card) {
  const value = rank(card);
  const next = value >= 14 ? 2 : value + 1;
  return next === 14 ? "A" : next === 13 ? "K" : next === 12 ? "Q" : next === 11 ? "J" : next === 10 ? "T" : String(next);
}

function sealFor(key) {
  if (key === "c_talisman") return "GOLD";
  if (key === "c_deja_vu") return "RED";
  if (key === "c_trance") return "BLUE";
  if (key === "c_medium") return "PURPLE";
  return null;
}

function transformTargets(state, key, targets, rule) {
  const hand = cards(state?.hand).map(cloneCard);
  if (key === "c_death") {
    const [target, source] = targets;
    hand[target] = copyPlayingCard(hand[target], hand[source]);
    return stateWithHand(state, hand);
  }
  if (key === "c_cryptid") {
    const source = hand[targets[0]];
    if (source) hand.push(copyPlayingCard(source, source), copyPlayingCard(source, source));
    return stateWithHand(state, hand);
  }
  if (rule.kind === "remove") {
    const removed = new Set(targets);
    return stateWithHand(state, hand.filter((_, index) => !removed.has(index)));
  }
  for (const target of targets) {
    const card = hand[target];
    if (!card) continue;
    if (rule.kind === "suit") hand[target] = setPlayingCard(card, { suit: rule.suit });
    else if (rule.kind === "rank") hand[target] = setPlayingCard(card, { rank: strengthRank(card) });
    else if (rule.kind === "stone") hand[target] = setPlayingCard(card, { enhancement: "STONE" });
    else if (rule.kind === "edition") hand[target] = setPlayingCard(card, { edition: "RANDOM_EDITION" });
    else if (rule.kind === "seal") hand[target] = setPlayingCard(card, { seal: sealFor(key) });
    else if (rule.enhancement) hand[target] = setPlayingCard(card, { enhancement: rule.enhancement });
  }
  return stateWithHand(state, hand);
}

function targetedLongTermValue(state, key, targets, rule) {
  const hand = cards(state?.hand);
  if (key === "c_death") {
    const [target, source] = targets;
    const sourceCard = hand[source];
    const targetCard = hand[target];
    const sourceCopies = countKnown(state, (card) => rank(card), rank(sourceCard));
    const targetCopies = countKnown(state, (card) => rank(card), rank(targetCard));
    return (cardQuality(sourceCard) - cardQuality(targetCard)) * 1.4
      + 300 + sourceCopies * 55 - targetCopies * 20;
  }
  if (key === "c_cryptid") {
    const sourceCard = hand[targets[0]];
    const sourceCopies = countKnown(state, (card) => rank(card), rank(sourceCard));
    return cardQuality(sourceCard) * 2 + 650 + sourceCopies * 70;
  }
  if (rule.kind === "remove") {
    return targets.reduce((sum, index) => sum + 340 - Math.max(0, cardQuality(hand[index])) * 1.25, 0);
  }
  if (rule.kind === "stone") {
    return targets.reduce((sum, index) => {
      const card = hand[index];
      return sum + 360 - rank(card) * 20 - enhancementOverwritePenalty(card, "STONE");
    }, 0);
  }
  if (rule.kind === "edition") {
    return targets.reduce((sum, index) => sum + Math.max(0, cardQuality(hand[index])) * 0.55 + 420, 0);
  }
  if (rule.kind === "seal") {
    const seal = sealFor(key);
    return targets.reduce((sum, index) => {
      const quality = Math.max(0, cardQuality(hand[index]));
      return sum + (seal === "RED" || seal === "GOLD" ? quality + 320 : 480 - quality * 0.2);
    }, 0);
  }
  if (rule.kind === "rank") {
    return targets.reduce((sum, index) => {
      const card = hand[index];
      const nextRank = balatroRankNumber(strengthRank(card));
      const nextCopies = countKnown(state, (item) => rank(item), nextRank);
      return sum + 250 + nextCopies * 90 + rank(card) * 8;
    }, 0);
  }
  if (rule.kind === "suit") {
    const suitedCards = countKnown(state, balatroCardSuit, rule.suit);
    return targets.reduce((sum, index) => {
      const card = hand[index];
      return sum + 230 + suitedCards * 22 + rank(card) * 8;
    }, 0);
  }
  if (rule.enhancement === "GLASS") {
    return targets.reduce((sum, index) => {
      const card = hand[index];
      // Glass wants a card which scores often, but editions, seals and an
      // existing enhancement make its 1-in-4 destruction risk much costlier.
      const breakRisk = rank(card) * 9
        + (modifier(card, "edition") ? 420 : 0)
        + (modifier(card, "seal") ? 220 : 0);
      return sum + 700 + rank(card) * 32 - breakRisk
        - enhancementOverwritePenalty(card, "GLASS");
    }, 0);
  }
  if (rule.enhancement === "STEEL") {
    return targets.reduce((sum, index) => {
      const card = hand[index];
      const baronRankBonus = rank(card) >= 13 ? 140 : 0;
      return sum + 560 + rank(card) * 34 + baronRankBonus
        - enhancementOverwritePenalty(card, "STEEL");
    }, 0);
  }
  if (rule.enhancement === "GOLD") {
    return targets.reduce((sum, index) => {
      const card = hand[index];
      // A low off-hand card is easier to keep through scoring and collect the
      // recurring $3 trigger from, so it is a better durable economy target.
      return sum + 600 + (14 - rank(card)) * 28
        - enhancementOverwritePenalty(card, "GOLD");
    }, 0);
  }
  if (rule.enhancement) {
    return targets.reduce((sum, index) => {
      const card = hand[index];
      return sum + 300 + rank(card) * 20
        - enhancementOverwritePenalty(card, rule.enhancement);
    }, 0);
  }
  return targets.reduce((sum, index) => sum + Math.max(40, cardQuality(hand[index]) * 0.2), 0);
}

function targetChangesCard(card, key, rule) {
  if (key === "c_aura") return !modifier(card, "edition");
  if (rule.kind === "suit") return balatroCardSuit(card) !== rule.suit;
  if (rule.kind === "edition") return !modifier(card, "edition");
  if (rule.kind === "seal") return modifier(card, "seal") !== sealFor(key);
  if (rule.kind === "stone") return modifier(card, "enhancement") !== "STONE";
  if (rule.enhancement) return modifier(card, "enhancement") !== rule.enhancement;
  return true;
}

function playingCardSignature(card) {
  return [
    rank(card),
    balatroCardSuit(card),
    modifier(card, "enhancement"),
    modifier(card, "edition"),
    modifier(card, "seal"),
  ].join("|");
}

function targetedIndexPool(state, key, rule) {
  const hand = cards(state?.hand);
  let indices = hand.map((_, index) => index);
  if (key !== "c_death" && key !== "c_cryptid") {
    indices = indices.filter((index) => targetChangesCard(hand[index], key, rule));
  }
  if (indices.length <= TARGETED_CARD_POOL_LIMIT) return indices;
  if (key === "c_death") {
    const ranked = indices.toSorted((left, right) =>
      cardQuality(hand[left]) - cardQuality(hand[right]) || left - right);
    const lowCount = Math.ceil(TARGETED_CARD_POOL_LIMIT / 2);
    const selected = new Set([
      ...ranked.slice(0, lowCount),
      ...ranked.slice(-(TARGETED_CARD_POOL_LIMIT - lowCount)),
    ]);
    return [...selected].toSorted((left, right) => left - right);
  }
  return indices
    .toSorted((left, right) =>
      targetedLongTermValue(state, key, [right], rule)
      - targetedLongTermValue(state, key, [left], rule)
      || left - right)
    .slice(0, TARGETED_CARD_POOL_LIMIT)
    .toSorted((left, right) => left - right);
}

function boundedTargetSets(state, key, rule) {
  const hand = cards(state?.hand);
  const pool = targetedIndexPool(state, key, rule);
  let targetSets;
  if (key === "c_death") {
    // Vanilla ignores target request order: it finds the highlighted card with
    // the greatest screen x and copies it onto the other card.  BalatroBot's
    // hand.cards is maintained in screen-x order, so only left < right models
    // a real distinct outcome; reverse permutations would lie to the solver.
    targetSets = combinations(pool.length, 2, 2).map((targets) => targets.map((target) => pool[target]));
    targetSets = targetSets.filter(([target, source]) =>
      playingCardSignature(hand[target]) !== playingCardSignature(hand[source]));
  } else if (key === "c_cryptid") {
    targetSets = pool.map((target) => [target]);
  } else {
    targetSets = combinations(pool.length, rule.min, Math.min(rule.max, pool.length))
      .map((targets) => targets.map((target) => pool[target]));
  }
  return targetSets
    .toSorted((left, right) =>
      targetedLongTermValue(state, key, right, rule)
      - targetedLongTermValue(state, key, left, rule)
      || left.join(",").localeCompare(right.join(",")))
    .slice(0, TARGETED_EVALUATION_LIMIT);
}

function targetedCandidates(state, card, index, descriptorValue, { evaluateBestPlay, origin }) {
  const key = keyOf(card);
  const rule = balatroConsumableTargetRule(card);
  const hand = cards(state?.hand);
  if (!rule.known || !hand.length || rule.max <= 0) return [];
  const targetSets = boundedTargetSets(state, key, rule);
  const base = evaluate(evaluateBestPlay, state);
  const options = [];
  for (const targets of targetSets) {
    const simulated = transformTargets(state, key, targets, rule);
    const projected = evaluate(evaluateBestPlay, simulated);
    const baseScore = base?.conservativeScore ?? null;
    const projectedScore = projected?.conservativeScore ?? null;
    const scoreGain = baseScore == null || projectedScore == null ? null : projectedScore - baseScore;
    const longTermValue = targetedLongTermValue(state, key, targets, rule);
    const overwritesEnhancement = Boolean(rule.enhancement) && targets.some((target) => {
      const current = modifier(hand[target], "enhancement");
      return Boolean(current) && current !== rule.enhancement;
    });
    const expectedValue = (scoreGain ?? 0) + longTermValue;
    const harmful = (scoreGain != null && scoreGain < 0) || longTermValue <= 0 || overwritesEnhancement;
    options.push(makeCandidate({
      origin,
      index,
      card,
      targets,
      descriptorValue,
      expectedValue,
      longTermValue,
      harmful,
      projected,
      projectedScore,
      scoreGain,
      assessment: key === "c_death"
        ? `${descriptorValue.label}: copy card ${targets[1]} onto card ${targets[0]}; long-term ${Math.round(longTermValue)}`
        : `${descriptorValue.label}: simulate ${rule.kind} on [${targets.join(",")}]; long-term ${Math.round(longTermValue)}${overwritesEnhancement ? "; replaces an existing enhancement" : ""}`,
    }));
  }
  return options
    .toSorted((left, right) => right.expectedValue - left.expectedValue || left.id.localeCompare(right.id))
    .slice(0, TARGETED_TOP_K);
}

function withPlanetUpgrade(state, descriptorValue) {
  const source = handSource(state);
  const current = source?.[descriptorValue.handType] ?? {};
  const upgraded = {
    ...current,
    chips: finite(current.chips) + descriptorValue.chips,
    mult: finite(current.mult, 1) + descriptorValue.mult,
    level: finite(current.level, 1) + 1,
  };
  return stateWithHands(state, { ...source, [descriptorValue.handType]: upgraded });
}

function jokerCapacity(state) {
  return Math.max(0, finite(state?.jokers?.limit, 5) - cards(state?.jokers).length);
}

function consumableCapacity(state, sourceFreesSlot) {
  const occupied = cards(state?.consumables).length - (sourceFreesSlot ? 1 : 0);
  return Math.max(0, finite(state?.consumables?.limit, 2) - Math.max(0, occupied));
}

function jokerIsEternal(joker) {
  return Boolean(joker?.modifier?.eternal ?? joker?.eternal);
}

function editionlessJokers(jokers) {
  return jokers.filter((joker) => !modifier(joker, "edition"));
}

function ectoplasmHandPenalty(state, card) {
  const exact = finite(state?.ecto_minus ?? state?.ectoMinus, NaN);
  if (Number.isInteger(exact) && exact > 0) return exact;
  const effect = String(card?.value?.effect ?? card?.effect ?? "");
  const matches = [
    ...effect.matchAll(/(?:hand\s*size|手牌上限)[^\d-]*-\s*(\d+)/giu),
  ];
  return Math.max(1, finite(matches.at(-1)?.[1], 1));
}

function noTargetAssessment(state, card, descriptorValue, { evaluateBestPlay, forPack, sourceFreesSlot = !forPack }) {
  const key = keyOf(card);
  const jokers = cards(state?.jokers);
  const hand = cards(state?.hand);
  const money = Math.max(0, finite(state?.money));
  const handLimit = Math.max(0, finite(state?.hand?.limit, hand.length));
  const capacity = consumableCapacity(state, sourceFreesSlot);
  let expectedValue = 0;
  let harmful = false;
  let valid = true;
  let reason = descriptorValue.label;
  let projected = null;
  let projectedScore = null;
  let scoreGain = null;

  if (descriptorValue.kind === "planet") {
    const base = evaluate(evaluateBestPlay, state);
    projected = evaluate(evaluateBestPlay, withPlanetUpgrade(state, descriptorValue));
    projectedScore = projected?.conservativeScore ?? null;
    scoreGain = base && projected ? projected.conservativeScore - base.conservativeScore : null;
    const played = finite(handSource(state)?.[descriptorValue.handType]?.played);
    expectedValue = 250 + (scoreGain ?? 0) + Math.log2(played + 1) * 120;
    reason = `Upgrade ${descriptorValue.handType}`;
    // During a live hand, a Planet is an emergency scoring action only when
    // it upgrades the hand the solver will actually play. In SHOP it remains
    // available as a strategic long-term upgrade and to free a consumable
    // slot.
    if (!forPack && state?.state === TARGET_STATE) {
      valid = projected?.handType === descriptorValue.handType && Number(scoreGain) > 0;
    }
  } else if (key === "c_black_hole") {
    expectedValue = 2_500 + Object.values(handSource(state)).reduce((sum, value) => sum + finite(value?.played) * 15, 0);
    reason = "Upgrade every poker hand";
  } else if (key === "c_hex" || key === "c_ankh") {
    const eligible = editionlessJokers(jokers);
    const deletable = jokers.filter((joker) => !jokerIsEternal(joker));
    valid = key === "c_hex"
      ? eligible.length > 0
      : jokers.length > 0 && finite(state?.jokers?.limit, 5) > 1 && jokerCapacity(state) > 0;
    const qualities = jokers.map(jokerQuality);
    if (key === "c_hex") {
      const outcomes = eligible.map((selected) => 1_000 - deletable
        .filter((joker) => joker !== selected)
        .reduce((sum, joker) => sum + jokerQuality(joker), 0));
      expectedValue = outcomes.length
        ? outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length
        : 0;
      harmful = expectedValue <= 0 || outcomes.some((value) => value < 0);
      reason = jokers.length === 1
        ? `Polychrome the sole editionless Joker ${jokers[0]?.label ?? jokers[0]?.key ?? ""}`
        : `Polychrome one of ${eligible.length} editionless Jokers; destroy other non-Eternal Jokers (up to ${deletable.length})`;
    } else {
      const outcomes = jokers.map((selected) => {
        const negativeCopyPenalty = modifier(selected, "edition").includes("NEGATIVE") ? 850 : 0;
        const destroyed = deletable
          .filter((joker) => joker !== selected)
          .reduce((sum, joker) => sum + jokerQuality(joker), 0);
        return jokerQuality(selected) - negativeCopyPenalty - destroyed;
      });
      expectedValue = outcomes.length
        ? outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length
        : 0;
      harmful = expectedValue <= 0 || outcomes.some((value) => value < 0);
      const eternalCount = jokers.filter(jokerIsEternal).length;
      reason = jokers.length === 1
        ? `Copy the sole Joker ${jokers[0]?.label ?? jokers[0]?.key ?? ""}`
        : `Randomly copy one of ${jokers.length} Jokers; preserve ${eternalCount} Eternal and destroy other non-Eternal Jokers`;
    }
  } else if (key === "c_ectoplasm") {
    const eligible = editionlessJokers(jokers);
    valid = eligible.length > 0;
    const penalty = ectoplasmHandPenalty(state, card);
    const slotGain = jokerCapacity(state) === 0 ? 1_500 : 650;
    const resultingLimit = Math.max(0, handLimit - penalty);
    const handPenalty = penalty * (resultingLimit <= 4 ? 2_000 : resultingLimit === 5 ? 1_300 : 850);
    expectedValue = slotGain - handPenalty;
    harmful = expectedValue <= 0 || resultingLimit <= 4;
    reason = `Random editionless Joker becomes Negative; hand size ${handLimit} -> ${resultingLimit}`;
  } else if (key === "c_immolate") {
    valid = hand.length >= 5;
    const average = hand.length ? hand.reduce((sum, item) => sum + Math.max(0, cardQuality(item)), 0) / hand.length : 0;
    expectedValue = 2_000 - average * 2.5;
    harmful = average >= 650;
    reason = `Destroy 5 random visible cards for $20 (average card value ${Math.round(average)})`;
  } else if (key === "c_wraith") {
    valid = jokerCapacity(state) > 0;
    expectedValue = 1_600 - money * 100;
    harmful = expectedValue <= 0;
    reason = `Create a Rare Joker and set $${money} to $0`;
  } else if (["c_familiar", "c_grim", "c_incantation"].includes(key)) {
    valid = hand.length > 0;
    const generated = key === "c_familiar" ? 3 : key === "c_grim" ? 2 : 4;
    expectedValue = generated * 260 - (hand.length ? hand.reduce((sum, item) => sum + cardQuality(item), 0) / hand.length : 0);
    harmful = expectedValue < 0;
    reason = `Destroy a random hand card and generate ${generated} enhanced card(s)`;
  } else if (key === "c_sigil") {
    valid = hand.length > 0;
    const base = evaluate(evaluateBestPlay, state);
    const suitScores = ["S", "H", "D", "C"].map((suit) => {
      const transformed = stateWithHand(state, hand.map((item) => setPlayingCard(item, { suit })));
      return evaluate(evaluateBestPlay, transformed)?.conservativeScore ?? null;
    }).filter(Number.isFinite);
    projectedScore = suitScores.length ? suitScores.reduce((sum, score) => sum + score, 0) / suitScores.length : null;
    scoreGain = base && projectedScore != null ? projectedScore - base.conservativeScore : null;
    expectedValue = (scoreGain ?? 0) + 250;
    harmful = scoreGain != null && scoreGain < -Math.max(100, base.conservativeScore * 0.2);
    reason = "Randomize the entire visible hand to one suit";
  } else if (key === "c_ouija") {
    valid = hand.length > 0 && handLimit > 1;
    const base = evaluate(evaluateBestPlay, state);
    const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    const scores = ranks.map((nextRank) => {
      const transformed = stateWithHand(state, hand.map((item) => setPlayingCard(item, { rank: nextRank })));
      return evaluate(evaluateBestPlay, transformed)?.conservativeScore ?? null;
    }).filter(Number.isFinite);
    projectedScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
    scoreGain = base && projectedScore != null ? projectedScore - base.conservativeScore : null;
    expectedValue = (scoreGain ?? 0) + 650 - (handLimit <= 6 ? 900 : 500);
    harmful = expectedValue <= 0;
    reason = `Randomize visible ranks; hand size ${handLimit} -> ${Math.max(0, handLimit - 1)}`;
  } else if (key === "c_hermit") {
    expectedValue = Math.min(20, money) * 100;
    harmful = expectedValue <= 0;
    reason = `Double $${money}, capped at +$20`;
  } else if (key === "c_temperance") {
    const payout = Math.min(50, jokers.reduce((sum, joker) => sum + finite(joker?.cost?.sell ?? joker?.sell), 0));
    expectedValue = payout * 100;
    harmful = payout <= 0;
    reason = `Gain $${payout} from Joker sell values`;
  } else if (key === "c_judgement" || key === "c_soul") {
    valid = jokerCapacity(state) > 0;
    expectedValue = key === "c_soul" ? 3_500 : 900;
    reason = key === "c_soul" ? "Create a Legendary Joker" : "Create a random Joker";
  } else if (key === "c_wheel_of_fortune") {
    valid = editionlessJokers(jokers).length > 0;
    expectedValue = 320;
    reason = "25% chance to add a Joker edition";
  } else if (key === "c_high_priestess") {
    valid = capacity > 0;
    expectedValue = 500 + Math.min(2, capacity) * 180;
    reason = `Create up to ${Math.min(2, capacity)} Planet card(s)`;
  } else if (key === "c_emperor") {
    valid = capacity > 0;
    expectedValue = 550 + Math.min(2, capacity) * 200;
    reason = `Create up to ${Math.min(2, capacity)} Tarot card(s)`;
  } else if (key === "c_fool") {
    const last = state?.last_tarot_planet ?? state?.lastTarotPlanet ?? state?.lastTarotOrPlanet;
    valid = Boolean(last) && String(last).toLowerCase() !== "c_fool" && capacity > 0;
    expectedValue = 480;
    reason = valid
      ? `Recreate ${last}`
      : "Last used Tarot/Planet is not exposed; fail closed";
  } else {
    valid = false;
    reason = `No safe no-target evaluator for ${key}`;
  }

  if (descriptorValue.needsHand && !hand.length) valid = false;
  if (!forPack && descriptorValue.needsHand && state?.state !== TARGET_STATE) valid = false;
  return { valid, expectedValue, harmful, reason, projected, projectedScore, scoreGain };
}

function makeCandidate({
  origin,
  index,
  card,
  targets = [],
  descriptorValue,
  expectedValue,
  longTermValue = null,
  harmful,
  projected = null,
  projectedScore = null,
  scoreGain = null,
  assessment,
}) {
  const key = keyOf(card);
  const destructive = descriptorValue.destructive;
  const method = origin === "pack" ? "pack" : origin === "shop" ? "buy_use" : "use";
  const action = origin === "pack"
    ? { method, card: index, targets: [...targets] }
    : origin === "shop"
      ? { method, card: index, ...(targets.length ? { targets: [...targets] } : {}) }
      : { method, consumable: index, ...(targets.length ? { cards: [...targets] } : {}) };
  // A purchase is never eligible for routine/local fallback even when the
  // underlying consumable effect itself is exact and non-destructive.
  const fallbackSafe = origin !== "shop" && !destructive && descriptorValue.support === "exact" && !harmful;
  return {
    id: `${method}:${index}${targets.length ? `:${targets.join(",")}` : ""}`,
    action,
    card: {
      index,
      key,
      label: card?.label ?? descriptorValue.label,
      set: String(card?.set ?? "").toUpperCase(),
    },
    support: descriptorValue.support,
    destructive,
    harmful: Boolean(harmful),
    fallbackSafe,
    safeChoice: origin === "pack" && fallbackSafe,
    eligibleForEmergency: origin !== "shop" && !harmful && !destructive && Number(scoreGain) > 0,
    requiresStrategic: true,
    strategicReason: destructive
      ? `${descriptorValue.label} can permanently destroy or weaken the run`
      : `${descriptorValue.label} consumes a finite run resource`,
    expectedValue: Math.round(finite(expectedValue)),
    longTermValue: longTermValue == null ? null : Math.round(finite(longTermValue)),
    projectedPlay: projected,
    projectedScore: projectedScore == null ? null : Math.round(projectedScore),
    scoreGain: scoreGain == null ? null : Math.round(scoreGain),
    assessment,
    targetRule: descriptorValue.kind === "all-hands-upgrade"
      ? { kind: "all-hands-upgrade" }
      : null,
  };
}

export function balatroConsumableStrategy(cardOrKey) {
  const key = typeof cardOrKey === "string" ? cardOrKey.trim().toLowerCase() : keyOf(cardOrKey);
  const strategy = STRATEGIES[key];
  return strategy
    ? { key, known: true, ...strategy }
    : {
        key,
        known: false,
        label: key || "unknown",
        kind: "unknown",
        support: "unsupported",
        target: false,
        destructive: true,
        needsHand: false,
        ownedUse: false,
        packUse: false,
      };
}

export function inspectBalatroConsumables(state) {
  return cards(state?.consumables).map((card, index) => {
    const strategy = balatroConsumableStrategy(card);
    let executable = strategy.known && strategy.ownedUse;
    let blockedReason = "";
    if (!strategy.known) blockedReason = "unknown consumable fails closed";
    else if (!strategy.ownedUse) blockedReason = `${strategy.label} is not safe through the pinned owned-use RPC`;
    else if (strategy.target && state?.state !== TARGET_STATE) blockedReason = `${strategy.label} needs SELECTING_HAND targets`;
    else if (!strategy.target && !PASSIVE_STATES.has(state?.state)) blockedReason = `${strategy.label} cannot be used from ${state?.state}`;
    if (blockedReason) executable = false;
    return { index, card, ...strategy, executable, blockedReason };
  });
}

export function generateBalatroConsumableUseCandidates(state, { evaluateBestPlay = null, limit = 24 } = {}) {
  const result = [];
  for (const entry of inspectBalatroConsumables(state)) {
    if (!entry.executable) continue;
    if (entry.target) {
      result.push(...targetedCandidates(state, entry.card, entry.index, entry, {
        evaluateBestPlay,
        origin: "use",
      }));
      continue;
    }
    const assessment = noTargetAssessment(state, entry.card, entry, { evaluateBestPlay, forPack: false });
    if (!assessment.valid) continue;
    result.push(makeCandidate({
      origin: "use",
      index: entry.index,
      card: entry.card,
      descriptorValue: entry,
      expectedValue: assessment.expectedValue,
      harmful: assessment.harmful,
      projected: assessment.projected,
      projectedScore: assessment.projectedScore,
      scoreGain: assessment.scoreGain,
      assessment: assessment.reason,
    }));
  }
  return result
    .toSorted((left, right) => right.expectedValue - left.expectedValue || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, finite(limit, 24)));
}

export function generateBalatroConsumablePackCandidates(state, { evaluateBestPlay = null, limit = 24 } = {}) {
  if (state?.state !== "SMODS_BOOSTER_OPENED") return [];
  const result = [];
  for (const [index, card] of packArea(state).entries()) {
    const strategy = balatroConsumableStrategy(card);
    if (!strategy.known || !strategy.packUse) continue;
    if (strategy.target) {
      result.push(...targetedCandidates(state, card, index, strategy, { evaluateBestPlay, origin: "pack" }));
      continue;
    }
    const assessment = noTargetAssessment(state, card, strategy, { evaluateBestPlay, forPack: true });
    if (!assessment.valid) continue;
    result.push(makeCandidate({
      origin: "pack",
      index,
      card,
      descriptorValue: strategy,
      expectedValue: assessment.expectedValue,
      harmful: assessment.harmful,
      projected: assessment.projected,
      projectedScore: assessment.projectedScore,
      scoreGain: assessment.scoreGain,
      assessment: assessment.reason,
    }));
  }
  result.push({
    id: "pack:skip",
    action: { method: "pack", skip: true },
    target: "skip when every offered consumable is unsupported, harmful, or lower value",
    support: "exact",
    destructive: false,
    harmful: false,
    fallbackSafe: true,
    safeChoice: true,
    eligibleForEmergency: false,
    requiresStrategic: false,
    expectedValue: 0,
  });
  const normalizedLimit = Math.max(1, finite(limit, 24));
  const choices = result
    .filter((candidate) => !candidate.action?.skip)
    .toSorted((left, right) => right.expectedValue - left.expectedValue || left.id.localeCompare(right.id));
  const skip = result.find((candidate) => candidate.action?.skip);
  return normalizedLimit === 1
    ? [skip]
    : [...choices.slice(0, normalizedLimit - 1), skip];
}

export function generateBalatroConsumableShopUseCandidates(state, { evaluateBestPlay = null, limit = 24 } = {}) {
  if (state?.state !== "SHOP") return [];
  const result = [];
  const activeCredit = cards(state?.jokers).reduce((total, joker) =>
    total + (keyOf(joker) === "j_credit_card" && !balatroJokerDebuffed(joker) ? 20 : 0), 0);
  const money = finite(state?.money) + activeCredit;
  for (const [index, card] of cards(state?.shop).entries()) {
    const set = String(card?.set ?? "").toUpperCase();
    if (!new Set(["TAROT", "PLANET", "SPECTRAL"]).has(set)) continue;
    const price = finite(card?.cost?.buy ?? card?.buy, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(price) || price > money) continue;
    const strategy = balatroConsumableStrategy(card);
    if (!strategy.known || !strategy.packUse) continue;
    if (strategy.target) {
      result.push(...targetedCandidates(state, card, index, strategy, { evaluateBestPlay, origin: "shop" }));
      continue;
    }
    // Unlike owned use, Buy & Use does not free an existing consumable slot.
    // This makes generators such as Emperor/Fool fail closed at full capacity,
    // while money cards and Planets can still be bought and used immediately.
    const assessment = noTargetAssessment(state, card, strategy, {
      evaluateBestPlay,
      forPack: false,
      sourceFreesSlot: false,
    });
    if (!assessment.valid) continue;
    result.push(makeCandidate({
      origin: "shop",
      index,
      card,
      descriptorValue: strategy,
      expectedValue: assessment.expectedValue - price * 100,
      harmful: assessment.harmful,
      projected: assessment.projected,
      projectedScore: assessment.projectedScore,
      scoreGain: assessment.scoreGain,
      assessment: `${assessment.reason}; costs $${price}`,
    }));
  }
  return result
    .toSorted((left, right) => right.expectedValue - left.expectedValue || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, finite(limit, 24)));
}

export function balatroConsumableCandidateFallbackSafe(candidate) {
  return Boolean(candidate?.fallbackSafe) && !candidate?.destructive && !candidate?.harmful;
}

export function balatroPackHasSafeConsumableChoice(candidates) {
  return (Array.isArray(candidates) ? candidates : []).some(
    (candidate) => candidate?.action?.method === "pack" && !candidate?.action?.skip && candidate?.safeChoice === true,
  );
}
