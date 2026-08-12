// A single, side-effect-free rules layer shared by candidate generation,
// validation, scoring and fallbacks.  Strategy models may rank legal choices,
// but they must not redefine these mechanics.

export const BALATRO_HAND_STRENGTH = Object.freeze({
  "High Card": 0,
  Pair: 1,
  "Two Pair": 2,
  "Three of a Kind": 3,
  Straight: 4,
  Flush: 5,
  "Full House": 6,
  "Four of a Kind": 7,
  "Straight Flush": 8,
  "Five of a Kind": 9,
  "Flush House": 10,
  "Flush Five": 11,
});

export const BALATRO_RULES_VERSION = "balatro-1.0.1o-rules-v2";

const BASE_SUITS = Object.freeze(["S", "H", "D", "C"]);
const RED_SUITS = new Set(["H", "D"]);
const BLACK_SUITS = new Set(["S", "C"]);
const TARGETED_CONSUMABLE_SETS = new Set(["TAROT", "SPECTRAL"]);

// Mirrors vanilla 1.0.1o G.P_CENTERS max_highlighted/min_highlighted plus
// BalatroBot v1.5.2's Aura and Ankh special cases.  Unknown modded cards are
// deliberately reported as unknown instead of silently inventing a contract.
const CONSUMABLE_TARGET_RULES = Object.freeze({
  // Vanilla Tarot/Spectral cards which resolve immediately and never select
  // playing-card targets. Keeping these explicit lets modded cards continue
  // to fail closed instead of guessing their contracts.
  c_fool: { min: 0, max: 0, kind: "generate" },
  c_high_priestess: { min: 0, max: 0, kind: "generate" },
  c_emperor: { min: 0, max: 0, kind: "generate" },
  c_hermit: { min: 0, max: 0, kind: "money" },
  c_wheel_of_fortune: { min: 0, max: 0, kind: "random-edition" },
  c_temperance: { min: 0, max: 0, kind: "money" },
  c_judgement: { min: 0, max: 0, kind: "joker" },
  c_familiar: { min: 0, max: 0, kind: "destroy-generate" },
  c_grim: { min: 0, max: 0, kind: "destroy-generate" },
  c_incantation: { min: 0, max: 0, kind: "destroy-generate" },
  c_wraith: { min: 0, max: 0, kind: "joker-money" },
  c_sigil: { min: 0, max: 0, kind: "suit-randomize" },
  c_ouija: { min: 0, max: 0, kind: "rank-randomize" },
  c_ectoplasm: { min: 0, max: 0, kind: "joker-edition" },
  c_immolate: { min: 0, max: 0, kind: "destroy-money" },
  c_hex: { min: 0, max: 0, kind: "joker-edition" },
  c_soul: { min: 0, max: 0, kind: "joker" },
  c_magician: { min: 1, max: 2, kind: "enhance", enhancement: "LUCKY" },
  c_empress: { min: 1, max: 2, kind: "enhance", enhancement: "MULT" },
  c_heirophant: { min: 1, max: 2, kind: "enhance", enhancement: "BONUS" },
  c_lovers: { min: 1, max: 1, kind: "enhance", enhancement: "WILD" },
  c_chariot: { min: 1, max: 1, kind: "enhance", enhancement: "STEEL" },
  c_justice: { min: 1, max: 1, kind: "enhance", enhancement: "GLASS" },
  c_strength: { min: 1, max: 2, kind: "rank" },
  c_hanged_man: { min: 1, max: 2, kind: "remove" },
  c_death: { min: 2, max: 2, kind: "copy" },
  c_devil: { min: 1, max: 1, kind: "enhance-held", enhancement: "GOLD" },
  c_tower: { min: 1, max: 1, kind: "stone", enhancement: "STONE" },
  c_star: { min: 1, max: 3, kind: "suit", suit: "D" },
  c_moon: { min: 1, max: 3, kind: "suit", suit: "C" },
  c_sun: { min: 1, max: 3, kind: "suit", suit: "H" },
  c_world: { min: 1, max: 3, kind: "suit", suit: "S" },
  c_talisman: { min: 1, max: 1, kind: "seal" },
  c_aura: { min: 1, max: 1, kind: "edition" },
  c_deja_vu: { min: 1, max: 1, kind: "seal" },
  c_trance: { min: 1, max: 1, kind: "seal" },
  c_medium: { min: 1, max: 1, kind: "seal" },
  c_cryptid: { min: 1, max: 1, kind: "copy" },
  c_ankh: { min: 0, max: 0, kind: "joker", requiresJoker: true },
});

export function balatroCards(area) {
  return Array.isArray(area?.cards) ? area.cards : [];
}

export function balatroRankNumber(rank) {
  const face = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
  return face[String(rank ?? "").toUpperCase()] ?? (Number(rank) || 0);
}

export function balatroCardRank(card) {
  return card?.value?.rank ?? card?.rank;
}

export function balatroCardSuit(card) {
  return String(card?.value?.suit ?? card?.suit ?? "").toUpperCase();
}

export function balatroCardDebuffed(card) {
  return Boolean(card?.state?.debuff ?? card?.debuff);
}

export function balatroCardModifier(card, name) {
  return String(card?.modifier?.[name] ?? card?.[name] ?? "").trim().toUpperCase().replaceAll(" ", "_");
}

export function balatroJokerKey(joker) {
  return String(joker?.key ?? "").trim().toLowerCase();
}

export function balatroJokerDebuffed(joker) {
  return Boolean(joker?.state?.debuff ?? joker?.debuff);
}

export function activeBalatroJokerKeys(state) {
  return new Set(
    balatroCards(state?.jokers)
      .filter((joker) => !balatroJokerDebuffed(joker))
      .map(balatroJokerKey)
      .filter(Boolean),
  );
}

export function balatroFlushSize(state) {
  return activeBalatroJokerKeys(state).has("j_four_fingers") ? 4 : 5;
}

export function balatroStraightSize(state) {
  return activeBalatroJokerKeys(state).has("j_four_fingers") ? 4 : 5;
}

export function balatroStraightWindows(state) {
  const jokers = activeBalatroJokerKeys(state);
  const size = balatroStraightSize(state);
  const shortcut = jokers.has("j_shortcut");
  const ordered = Array.from({ length: 14 }, (_, index) => index + 1);
  const windows = combinations(ordered, size)
    .filter((ranks) => ranks.every((rank, index) => index === 0 || rank - ranks[index - 1] <= (shortcut ? 2 : 1)))
    .map((ranks) => ranks.map((rank) => (rank === 1 ? 14 : rank)));
  const unique = new Map(windows.map((ranks) => [[...ranks].sort((left, right) => left - right).join(","), ranks]));
  return [...unique.values()];
}

function isStone(card) {
  const enhancement = balatroCardModifier(card, "enhancement");
  return enhancement.includes("STONE") || enhancement === "M_STONE";
}

function isWild(card) {
  const enhancement = balatroCardModifier(card, "enhancement");
  return enhancement.includes("WILD") || enhancement === "M_WILD";
}

export function balatroCardMatchesSuit(state, card, requestedSuit, { flush = false } = {}) {
  const suit = balatroCardSuit(card);
  const requested = String(requestedSuit ?? "").toUpperCase();
  if (!BASE_SUITS.includes(requested) || isStone(card)) return false;
  // In the game, a debuffed Wild card loses its any-suit property during
  // flush calculation, then falls back to its printed suit.
  if (isWild(card) && (!flush || !balatroCardDebuffed(card))) return true;
  const jokers = activeBalatroJokerKeys(state);
  if (jokers.has("j_smeared")) {
    if (RED_SUITS.has(suit) && RED_SUITS.has(requested)) return true;
    if (BLACK_SUITS.has(suit) && BLACK_SUITS.has(requested)) return true;
  }
  return suit === requested;
}

export function balatroCardIsFace(state, card) {
  if (activeBalatroJokerKeys(state).has("j_pareidolia")) return true;
  return new Set([11, 12, 13]).has(balatroRankNumber(balatroCardRank(card)));
}

function combinations(values, size) {
  const result = [];
  const visit = (start, picked) => {
    if (picked.length === size) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index <= values.length - (size - picked.length); index++) {
      picked.push(values[index]);
      visit(index + 1, picked);
      picked.pop();
    }
  };
  visit(0, []);
  return result;
}

function bestStraight(selected, required, shortcut) {
  const byRank = new Map();
  for (const item of selected) {
    const rank = balatroRankNumber(balatroCardRank(item.card));
    if (rank < 2 || rank > 14 || isStone(item.card)) continue;
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(item);
  }
  const values = [...byRank.keys()];
  if (values.includes(14)) values.push(1);
  const normalized = [...new Set(values)].sort((left, right) => left - right);
  let best = null;
  for (const chain of combinations(normalized, required)) {
    if (chain.some((rank, index) => index > 0 && rank - chain[index - 1] > (shortcut ? 2 : 1))) continue;
    const high = chain.at(-1) === 14 && chain[0] === 10 ? 14 : chain.at(-1);
    if (!best || high > best.high) best = { chain, high };
  }
  if (!best) return [];
  const ranks = new Set(best.chain.map((rank) => (rank === 1 ? 14 : rank)));
  return selected.filter((item) => ranks.has(balatroRankNumber(balatroCardRank(item.card))));
}

function bestFlush(state, selected, required) {
  return BASE_SUITS
    .map((suit) => ({
      suit,
      cards: selected.filter((item) => balatroCardMatchesSuit(state, item.card, suit, { flush: true })),
    }))
    .filter((candidate) => candidate.cards.length >= required)
    .sort((left, right) =>
      right.cards.length - left.cards.length ||
      right.cards.reduce((sum, item) => sum + balatroRankNumber(balatroCardRank(item.card)), 0) -
        left.cards.reduce((sum, item) => sum + balatroRankNumber(balatroCardRank(item.card)), 0))[0]?.cards ?? [];
}

function unionItems(...groups) {
  const byIndex = new Map();
  for (const item of groups.flat()) byIndex.set(item.index, item);
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

export function classifyBalatroHand(state, cards, indices) {
  const selected = indices.map((index) => ({ index, card: cards[index] })).filter((item) => item.card);
  if (!selected.length) return { handType: "High Card", scoringCards: [], cycleFillers: [], rulesApplied: [] };
  const jokerKeys = activeBalatroJokerKeys(state);
  const fourFingers = jokerKeys.has("j_four_fingers");
  const shortcut = jokerKeys.has("j_shortcut");
  const required = fourFingers ? 4 : 5;
  const byRank = new Map();
  for (const item of selected) {
    const rank = balatroRankNumber(balatroCardRank(item.card));
    if (rank <= 0 || isStone(item.card)) continue;
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(item);
  }
  const groups = [...byRank.entries()].sort(
    ([leftRank, left], [rightRank, right]) => right.length - left.length || rightRank - leftRank,
  );
  const counts = groups.map(([, items]) => items.length);
  const flush = bestFlush(state, selected, required);
  const straight = selected.length >= required ? bestStraight(selected, required, shortcut) : [];
  const fiveKind = counts[0] === 5;
  const fullHouse = counts[0] === 3 && counts[1] === 2;
  let handType;
  let scoring;
  if (fiveKind && flush.length) {
    handType = "Flush Five";
    scoring = groups[0][1];
  } else if (fullHouse && flush.length) {
    handType = "Flush House";
    scoring = unionItems(groups[0][1], groups[1][1]);
  } else if (fiveKind) {
    handType = "Five of a Kind";
    scoring = groups[0][1];
  } else if (straight.length && flush.length) {
    // This intentionally mirrors Balatro's evaluator: with Four Fingers the
    // straight and flush subsets may differ; their union is the scoring hand.
    handType = "Straight Flush";
    scoring = unionItems(straight, flush);
  } else if (counts[0] === 4) {
    handType = "Four of a Kind";
    scoring = groups[0][1];
  } else if (fullHouse) {
    handType = "Full House";
    scoring = unionItems(groups[0][1], groups[1][1]);
  } else if (flush.length) {
    handType = "Flush";
    scoring = flush;
  } else if (straight.length) {
    handType = "Straight";
    scoring = straight;
  } else if (counts[0] === 3) {
    handType = "Three of a Kind";
    scoring = groups[0][1];
  } else if (counts[0] === 2 && counts[1] === 2) {
    handType = "Two Pair";
    scoring = unionItems(groups[0][1], groups[1][1]);
  } else if (counts[0] === 2) {
    handType = "Pair";
    scoring = groups[0][1];
  } else {
    handType = "High Card";
    scoring = [selected.toSorted(
      (left, right) => balatroRankNumber(balatroCardRank(right.card)) - balatroRankNumber(balatroCardRank(left.card)),
    )[0]];
  }
  const scoringCards = scoring.map((item) => item.index).sort((left, right) => left - right);
  const scoringSet = new Set(scoringCards);
  return {
    handType,
    scoringCards,
    cycleFillers: indices.filter((index) => !scoringSet.has(index)),
    rulesApplied: [
      jokerKeys.has("j_smeared") && "smeared-suits",
      fourFingers && "four-fingers",
      shortcut && "shortcut",
      selected.some(({ card }) => isWild(card)) && "wild-suit",
    ].filter(Boolean),
  };
}

export function balatroConsumableTargetRule(card) {
  const key = String(card?.key ?? "").trim().toLowerCase();
  const rule = CONSUMABLE_TARGET_RULES[key];
  if (rule) return { key, known: true, ...rule };
  const set = String(card?.set ?? "").toUpperCase();
  if (!TARGETED_CONSUMABLE_SETS.has(set)) {
    return { key, known: true, min: 0, max: 0, kind: "none" };
  }
  return { key, known: false, min: 0, max: 5, kind: "unknown" };
}

export function validateBalatroConsumableTargets(card, targets, state, label = "consumable") {
  const rule = balatroConsumableTargetRule(card);
  const count = Array.isArray(targets) ? targets.length : 0;
  if (!rule.known) {
    if (count > 0) return rule;
    throw new Error(`${label} ${rule.key || "unknown"} has an unknown target contract; do not guess or omit targets`);
  }
  if (rule.requiresJoker && balatroCards(state?.jokers).length < 1) {
    throw new Error(`${label} ${rule.key} requires at least one Joker`);
  }
  if (count < rule.min || count > rule.max) {
    const expected = rule.min === rule.max ? `exactly ${rule.min}` : `${rule.min}-${rule.max}`;
    throw new Error(`${label} ${rule.key} requires ${expected} target card(s); provided ${count}`);
  }
  return rule;
}

export function balatroRoundSurvivalBudget(state, bestScore) {
  const entries = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss].filter(Boolean);
  const blind = entries.find((item) => String(item.status ?? "").toUpperCase().includes("CURRENT")) ?? null;
  const target = Number(blind?.score);
  const current = Number(state?.round?.chips);
  const handsLeft = Number(state?.round?.hands_left);
  const deficit = Number.isFinite(target) && Number.isFinite(current) ? Math.max(0, target - current) : 0;
  const requiredPace = deficit > 0 && handsLeft > 0 ? deficit / handsLeft : 0;
  const score = Math.max(0, Number(bestScore) || 0);
  const projectedRemaining = score * Math.max(0, handsLeft || 0);
  return {
    blind,
    target,
    current,
    deficit,
    handsLeft,
    requiredPace,
    bestScore: score,
    projectedRemaining,
    projectedTotal: Number.isFinite(current) ? current + projectedRemaining : projectedRemaining,
    paceShortfall: Math.max(0, deficit - projectedRemaining),
    canClearNow: deficit > 0 && score >= deficit,
    currentLineCanClear: deficit === 0 || projectedRemaining >= deficit,
  };
}
