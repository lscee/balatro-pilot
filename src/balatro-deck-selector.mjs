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

export function selectBalatroDeck({ collectionKnowledge, performance = [], config = {} } = {}) {
  const configured = normalizedCode(config.balatrobotDeck || "RED");
  const unlocked = (collectionKnowledge?.unlockedDecks ?? [])
    .filter((deck) => deck && normalizedCode(deck.code))
    .map((deck) => ({ ...deck, code: normalizedCode(deck.code) }));
  if (!unlocked.length) {
    return {
      deck: configured,
      label: configured,
      effect: "Deck collection unavailable",
      mode: "fallback",
      reason: "Deck unlock data is unavailable; use the configured deck",
      stats: null,
    };
  }

  const configuredDeck = unlocked.find((deck) => deck.code === configured);
  if (config.balatrobotDeckMode === "fixed") {
    const selected = configuredDeck ?? unlocked[0];
    return {
      deck: selected.code,
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
  return {
    deck: selected.code,
    label: selected.label,
    effect: selected.effect,
    mode: "adaptive",
    reason: `Balance learned performance with continued exploration (score ${selected.score.toFixed(3)})`,
    stats: selected.stats,
  };
}
