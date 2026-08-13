function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function performanceMap(rows) {
  return new Map((rows ?? []).map((row) => [normalizedCode(row.deck), {
    deck: normalizedCode(row.deck),
    trials: finite(row.trials),
    wins: finite(row.wins),
    averageAnte: finite(row.averageAnte),
    averageRound: finite(row.averageRound),
  }]));
}

const BREADTH_UNLOCKS = Object.freeze([
  { deck: "RED", unlocks: "MAGIC" },
  { deck: "BLUE", unlocks: "NEBULA" },
  { deck: "YELLOW", unlocks: "GHOST" },
  { deck: "GREEN", unlocks: "ABANDONED" },
  { deck: "BLACK", unlocks: "CHECKERED" },
]);

const STAKE_ORDER = Object.freeze({
  WHITE: 1,
  RED: 2,
  GREEN: 3,
  BLACK: 4,
  BLUE: 5,
  PURPLE: 6,
  ORANGE: 7,
  GOLD: 8,
});

const STAKE_UNLOCKS = Object.freeze({
  RED: "ZODIAC",
  GREEN: "PAINTED",
  BLACK: "ANAGLYPH",
  BLUE: "PLASMA",
  ORANGE: "ERRATIC",
});

function legalNextStake(progress) {
  const next = normalizedCode(progress?.nextStake);
  if (!next || !Object.hasOwn(STAKE_ORDER, next)) return "";
  const available = new Set((progress?.availableStakes ?? []).map(normalizedCode));
  const wins = progress?.winsByStake && typeof progress.winsByStake === "object"
    ? progress.winsByStake
    : {};
  const firstUnwon = Object.keys(STAKE_ORDER)
    .find((stake) => available.has(stake) && finite(wins[stake]) <= 0) ?? "";
  return next === firstUnwon ? next : "";
}

function progressMap(collectionKnowledge) {
  return new Map((collectionKnowledge?.deckProgress ?? []).map((progress) => [normalizedCode(progress?.code), progress]));
}

function legalStakeForDeck(deckCode, requestedStake, collectionKnowledge) {
  const progress = progressMap(collectionKnowledge).get(normalizedCode(deckCode));
  const available = new Set((progress?.availableStakes ?? []).map(normalizedCode));
  const requested = normalizedCode(requestedStake || "WHITE");
  if (available.has(requested)) return requested;
  if (available.has("WHITE")) return "WHITE";
  return "";
}

function performanceScore(stats) {
  const trials = Math.max(0, finite(stats?.trials));
  if (!trials) return 0;
  const winRate = finite(stats?.wins) / trials;
  const progress = Math.min(1, finite(stats?.averageAnte) / 8) + Math.min(1, finite(stats?.averageRound) / 24) * 0.35;
  return winRate * 2.5 + progress;
}

function selectUnlockDeck(unlocked, collectionKnowledge, performance) {
  const progressByDeck = progressMap(collectionKnowledge);
  const lockedCodes = new Set((collectionKnowledge?.lockedDecks ?? []).map((deck) => normalizedCode(deck?.code)));
  for (const target of BREADTH_UNLOCKS) {
    if (!lockedCodes.has(target.unlocks)) continue;
    const deck = unlocked.find((candidate) => candidate.code === target.deck);
    const progress = progressByDeck.get(target.deck);
    const stake = legalNextStake(progress);
    if (!deck || stake !== "WHITE") continue;
    return {
      deck: deck.code,
      stake,
      label: deck.label,
      effect: deck.effect,
      mode: "unlock",
      reason: `Win with ${deck.label} on White Stake to unlock ${target.unlocks} Deck`,
      targetUnlocks: [target.unlocks],
      stats: performanceMap(performance).get(deck.code) ?? null,
    };
  }

  const byDeck = performanceMap(performance);
  const candidates = unlocked.map((deck) => {
    const progress = progressByDeck.get(deck.code);
    const stake = legalNextStake(progress);
    const stats = byDeck.get(deck.code) ?? { deck: deck.code, trials: 0, wins: 0, averageAnte: 0, averageRound: 0 };
    return { ...deck, stake, stats, score: performanceScore(stats) };
  }).filter((candidate) => candidate.stake)
    .sort((left, right) => right.score - left.score || right.stats.wins - left.stats.wins || left.order - right.order);
  if (!candidates.length) return null;
  const selected = candidates[0];
  const stakeUnlock = STAKE_UNLOCKS[selected.stake];
  const targetUnlocks = stakeUnlock && lockedCodes.has(stakeUnlock) ? [stakeUnlock] : [];
  return {
    deck: selected.code,
    stake: selected.stake,
    label: selected.label,
    effect: selected.effect,
    mode: "unlock",
    reason: `Advance the strongest unlocked deck through its next legal Stake (${selected.stake})`,
    targetUnlocks,
    stats: selected.stats,
  };
}

export function selectBalatroDeck({ collectionKnowledge, performance = [], config = {} } = {}) {
  const configured = normalizedCode(config.balatrobotDeck || "RED");
  const unlocked = (collectionKnowledge?.unlockedDecks ?? [])
    .filter((deck) => deck && normalizedCode(deck.code))
    .map((deck) => ({ ...deck, code: normalizedCode(deck.code) }));
  if (!unlocked.length) {
    return {
      deck: "RED",
      stake: "WHITE",
      label: "Red Deck",
      effect: "+1 discard each round",
      mode: "fallback",
      reason: "Deck unlock data is unavailable; fail safely to Red Deck on White Stake",
      stats: null,
    };
  }

  const configuredDeck = unlocked.find((deck) => deck.code === configured);
  if (config.balatrobotDeckMode === "unlock") {
    const selection = selectUnlockDeck(unlocked, collectionKnowledge, performance);
    if (selection) return selection;
  }
  if (config.balatrobotDeckMode === "fixed") {
    const selected = configuredDeck ?? unlocked[0];
    const stake = legalStakeForDeck(selected.code, config.balatrobotStake, collectionKnowledge) || "WHITE";
    return {
      deck: selected.code,
      stake,
      label: selected.label,
      effect: selected.effect,
      mode: "fixed",
      reason: configuredDeck
        ? "Use the explicitly configured unlocked deck"
        : `Configured deck ${configured} is locked; use the first unlocked deck safely`,
      stats: null,
    };
  }

  const byDeck = performanceMap(performance);
  const candidates = unlocked.map((deck) => ({
    ...deck,
    stats: byDeck.get(deck.code) ?? { deck: deck.code, trials: 0, wins: 0, averageAnte: 0, averageRound: 0 },
  }));
  const minimumTrials = Math.max(1, finite(config.balatrobotDeckMinimumTrials, 2));
  const underexplored = candidates.filter((candidate) => candidate.stats.trials < minimumTrials);
  if (underexplored.length) {
    const leastTrials = Math.min(...underexplored.map((candidate) => candidate.stats.trials));
    const tied = underexplored.filter((candidate) => candidate.stats.trials === leastTrials);
    const totalTrials = candidates.reduce((sum, candidate) => sum + candidate.stats.trials, 0);
    const selected = tied[totalTrials % tied.length];
    return {
      deck: selected.code,
      label: selected.label,
      effect: selected.effect,
      mode: "explore",
      reason: `Explore unlocked deck before exploitation (${selected.stats.trials}/${minimumTrials} completed trials)`,
      stats: selected.stats,
    };
  }

  const totalTrials = candidates.reduce((sum, candidate) => sum + candidate.stats.trials, 0);
  const exploration = Math.max(0, finite(config.balatrobotDeckExploration, 1.15));
  const ranked = candidates.map((candidate) => {
    const trials = Math.max(1, candidate.stats.trials);
    const winRate = candidate.stats.wins / trials;
    const progress = Math.min(1, candidate.stats.averageAnte / 8) + Math.min(1, candidate.stats.averageRound / 24) * 0.35;
    const uncertainty = exploration * Math.sqrt(Math.log(totalTrials + 1) / trials);
    return { ...candidate, score: winRate * 2.5 + progress + uncertainty };
  }).sort((left, right) => right.score - left.score || left.order - right.order);
  const selected = ranked[0];
  const stake = legalStakeForDeck(selected.code, config.balatrobotStake, collectionKnowledge) || "WHITE";
  return {
    deck: selected.code,
    stake,
    label: selected.label,
    effect: selected.effect,
    mode: "adaptive",
    reason: `Balance learned performance with continued exploration (score ${selected.score.toFixed(3)})`,
    stats: selected.stats,
  };
}
