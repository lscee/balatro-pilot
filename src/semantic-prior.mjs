import {
  semanticActionTemplate,
  semanticNormalizeFeatures,
  semanticStateFeatures,
} from "./semantic-experience.mjs";

const DEFAULT_MINIMUM_EPISODES = 3;
const DEFAULT_CONFIDENCE_Z = 1.28;
const DEFAULT_MAXIMUM_BLEND = 0.3;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cards(area) {
  return Array.isArray(area?.cards) ? area.cards : [];
}

function baseCardIdentity(value) {
  return String(value ?? "unknown")
    .split("@")[0]
    .split("+")[0]
    .trim() || "unknown";
}

function exactCardIdentity(value) {
  return String(value ?? "unknown").trim() || "unknown";
}

function decisionStakeRuleSignature(value) {
  const rules = value && typeof value === "object" ? value : {};
  const appliedStakes = Array.isArray(rules.appliedStakes)
    ? rules.appliedStakes.map((stake) => String(stake ?? "").trim().toUpperCase()).filter(Boolean)
    : [];
  return [
    "decision-stake-rules-v1",
    `code=${String(rules.code ?? "unknown").trim().toUpperCase() || "UNKNOWN"}`,
    `applied=${appliedStakes.join(">") || "unknown"}`,
    `small=${finite(rules.smallBlindReward, 0)}`,
    `scale=${finite(rules.scalingTier, 0)}`,
    `discard=${finite(rules.discardModifier, 0)}`,
    `eternal=${Number(Boolean(rules.eternalStickers))}`,
    `perishable=${Number(Boolean(rules.perishableStickers))}:${finite(rules.perishableRounds, 5)}`,
    `rental=${Number(Boolean(rules.rentalStickers))}:${finite(rules.rentalRate, 3)}`,
  ].join("|");
}

function cardRank(identity) {
  const base = baseCardIdentity(identity);
  const match = /^[CDHS]_(.+)$/u.exec(base);
  return match?.[1] ?? base;
}

function cardSuit(identity) {
  const base = baseCardIdentity(identity);
  const match = /^([CDHS])_/u.exec(base);
  return match?.[1] ?? "?";
}

function numericRank(identity) {
  const rank = String(cardRank(identity)).toUpperCase();
  if (rank === "A") return 14;
  if (rank === "K") return 13;
  if (rank === "Q") return 12;
  if (rank === "J") return 11;
  const value = Number(rank);
  return Number.isFinite(value) ? value : 0;
}

function containsStandardStraight(identities) {
  const values = new Set((identities ?? []).map(numericRank).filter((rank) => rank >= 2 && rank <= 14));
  if (values.has(14)) values.add(1);
  const ordered = [...values].sort((left, right) => left - right);
  let run = 1;
  for (let index = 1; index < ordered.length; index++) {
    run = ordered[index] === ordered[index - 1] + 1 ? run + 1 : 1;
    if (run >= 5) return true;
  }
  return false;
}

function groupShape(identities) {
  const ranks = new Map();
  const suits = new Map();
  for (const identity of identities ?? []) {
    const rank = cardRank(identity);
    const suit = cardSuit(identity);
    ranks.set(rank, (ranks.get(rank) ?? 0) + 1);
    suits.set(suit, (suits.get(suit) ?? 0) + 1);
  }
  return {
    count: identities?.length ?? 0,
    ranks: [...ranks.values()].sort((left, right) => right - left).join("-") || "none",
    maxSuit: Math.max(0, ...suits.values()),
  };
}

function multisetSubtract(source, removed) {
  const counts = new Map();
  for (const value of removed ?? []) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (source ?? []).filter((value) => {
    const remaining = counts.get(value) ?? 0;
    if (!remaining) return true;
    counts.set(value, remaining - 1);
    return false;
  });
}

function phase(ante) {
  if (ante <= 2) return "early";
  if (ante <= 5) return "mid";
  return "late";
}

function economy(money) {
  if (money < 5) return "broke";
  if (money < 10) return "low";
  if (money < 25) return "interest";
  return "rich";
}

function pressureBand(score, target, handsLeft) {
  if (!(target > 0)) return "none";
  const deficit = Math.max(0, target - score);
  if (!deficit) return "cleared";
  const pace = handsLeft > 0 ? deficit / handsLeft : deficit;
  const targetPace = target / Math.max(1, handsLeft || 1);
  if (handsLeft <= 1) return "last-hand";
  if (pace > targetPace * 0.85) return "critical";
  if (pace > targetPace * 0.45) return "pressured";
  return "comfortable";
}

function dominantPokerTarget(features) {
  const targets = Array.isArray(features?.strategy?.pokerTargets) ? features.strategy.pokerTargets : [];
  return String(targets[0] ?? "none").split(":L")[0];
}

function buildRoles(jokerKeys) {
  const keys = (jokerKeys ?? []).map((value) => baseCardIdentity(value).toLowerCase());
  const roles = new Set();
  for (const key of keys) {
    if (/blueprint|brainstorm/u.test(key)) roles.add("copy");
    if (/hanging_chad|mime|hack|sock_and_buskin|dusk|seltzer/u.test(key)) roles.add("retrigger");
    if (/cavendish|hologram|vampire|ramen|blackboard|card_sharp|photograph|baron|constellation|campfire/u.test(key)) roles.add("xmult");
    if (/rocket|satellite|to_the_moon|golden_joker|cloud_9/u.test(key)) roles.add("economy");
    if (/green_joker|ride_the_bus|flash|supernova|runner|square|wee|trousers/u.test(key)) roles.add("scaling");
  }
  return [...roles].sort();
}

function normalizeFeatures(stateOrFeatures) {
  if (stateOrFeatures?.screen && !stateOrFeatures?.state) {
    return semanticNormalizeFeatures(stateOrFeatures, { canonicalVersion: true }) ?? stateOrFeatures;
  }
  return semanticStateFeatures(stateOrFeatures);
}

/**
 * A reusable decision state deliberately excludes seed, round id, exact card
 * indices and exact-state fingerprints. Those values remain useful for RPC
 * reconciliation and legality checks, but must not fragment learning.
 */
export function semanticDecisionState(stateOrFeatures) {
  const features = normalizeFeatures(stateOrFeatures);
  const screen = String(features?.screen ?? "unknown");
  const hand = Array.isArray(features?.hand) ? features.hand : [];
  const handShape = groupShape(hand);
  const blindType = String(features?.blind?.type ?? "none").toUpperCase() || "NONE";
  const handsLeft = finite(features?.round?.handsLeft, 0);
  const discardsLeft = finite(features?.round?.discardsLeft, 0);
  const jokerKeys = Array.isArray(features?.strategy?.jokerKeys)
    ? features.strategy.jokerKeys
    : features?.jokers ?? [];
  return {
    screen,
    phase: String(features?.strategy?.phase ?? phase(finite(features?.ante, 0))),
    deck: String(features?.deck ?? "unknown").toUpperCase() || "UNKNOWN",
    stake: String(features?.stakeRules?.code ?? features?.stake ?? "unknown").toUpperCase() || "UNKNOWN",
    // Prior buckets use only the cumulative, decision-relevant Stake rules.
    // Older trajectories can derive this core from their Stake code, while
    // runtime provenance and deck-specific ante scaling must not fragment the
    // same Stake. A changed reward, scaling, discard, sticker, lifetime, or
    // rental-rate rule still produces a different bucket.
    stakeRuleSignature: decisionStakeRuleSignature(features?.stakeRules),
    rentalCount: finite(features?.stickerEconomy?.rentalCount, 0),
    rentalUpkeep: finite(features?.stickerEconomy?.rentalUpkeep, 0),
    perishableTtls: Array.isArray(features?.stickerEconomy?.perishableTtls)
      ? [...features.stickerEconomy.perishableTtls]
      : [],
    perishableExpired: finite(features?.stickerEconomy?.perishableExpired, 0),
    eternalLockedSlots: finite(features?.stickerEconomy?.eternalLockedSlots, 0),
    blind: blindType === "BOSS" ? `BOSS:${String(features?.blind?.name ?? "unknown")}` : blindType,
    economy: String(features?.strategy?.economy ?? economy(finite(features?.money, 0))),
    pressure: pressureBand(
      finite(features?.round?.score, 0),
      finite(features?.blind?.target, 0),
      handsLeft,
    ),
    hands: handsLeft <= 1 ? "last" : handsLeft <= 3 ? "few" : "many",
    discards: discardsLeft <= 0 ? "none" : discardsLeft === 1 ? "one" : "many",
    poker: dominantPokerTarget(features),
    roles: buildRoles(jokerKeys),
    handShape: screen === "SELECTING_HAND"
      ? `${handShape.ranks}|s${handShape.maxSuit}|n${handShape.count}`
      : "n/a",
  };
}

export function semanticDecisionKey(stateOrFeatures) {
  return JSON.stringify(semanticDecisionState(stateOrFeatures));
}

function normalizeCandidateAction(candidate) {
  const { method, ...params } = candidate?.action ?? {};
  return method ? { method, params } : null;
}

function inferredPlayType(template) {
  const identities = template?.cards ?? [];
  const shape = groupShape(identities);
  const straight = containsStandardStraight(identities);
  const flush = shape.maxSuit >= 5;
  if (shape.ranks.startsWith("5")) return "Five of a Kind";
  if (shape.ranks.startsWith("4")) return "Four of a Kind";
  if (shape.ranks.startsWith("3-2")) return "Full House";
  if (straight && flush) return "Straight Flush";
  if (flush) return "Flush";
  if (straight) return "Straight";
  if (shape.ranks.startsWith("3")) return "Three of a Kind";
  if (shape.ranks.startsWith("2-2")) return "Two Pair";
  if (shape.ranks.startsWith("2")) return "Pair";
  return "High Card";
}

function abstractTemplate(features, template, candidate = null) {
  const method = String(template?.method ?? candidate?.action?.method ?? "unknown");
  if (method === "play") {
    const count = Array.isArray(template?.cards) ? template.cards.length : finite(candidate?.action?.cards?.length, 0);
    const handType = String(candidate?.handType ?? inferredPlayType(template));
    const inferredScoringCounts = {
      "High Card": 1,
      Pair: 2,
      "Two Pair": 4,
      "Three of a Kind": 3,
      Straight: 5,
      Flush: 5,
      "Full House": 5,
      "Four of a Kind": 4,
      "Straight Flush": 5,
      "Five of a Kind": 5,
      "Flush House": 5,
      "Flush Five": 5,
    };
    const scoringCount = Array.isArray(candidate?.scoringCards)
      ? candidate.scoringCards.length
      : Math.min(count, inferredScoringCounts[handType] ?? count);
    return { method, handType, count, cycle: Math.max(0, count - scoringCount) > 0 };
  }
  if (method === "discard") {
    const hand = Array.isArray(features?.hand) ? features.hand : [];
    const kept = multisetSubtract(hand, template?.cards ?? []);
    const shape = groupShape(kept);
    return { method, keptRanks: shape.ranks, keptSuit: Math.min(5, shape.maxSuit), keptCount: shape.count };
  }
  if (method === "buy") return { method, choice: template?.choice ?? "unknown", item: exactCardIdentity(template?.item) };
  if (method === "sell") return { method, choice: template?.choice ?? "unknown", item: exactCardIdentity(template?.item) };
  if (method === "pack") return template?.skip
    ? { method, skip: true }
    : { method, item: exactCardIdentity(template?.item), targets: finite(template?.targets?.length, 0) };
  if (method === "use") return {
    method,
    item: exactCardIdentity(template?.item),
    targets: finite(template?.cards?.length, 0),
  };
  if (method === "rearrange") return { method, area: String(template?.area ?? "unknown") };
  return { method };
}

export function semanticCandidateActionTemplate(state, candidate) {
  const action = normalizeCandidateAction(candidate);
  if (!action) return { method: "unknown" };
  const features = semanticStateFeatures(state);
  const exactTemplate = semanticActionTemplate(state, action);
  return abstractTemplate(features, exactTemplate, candidate);
}

export function semanticCandidateActionKey(state, candidate) {
  return JSON.stringify(semanticCandidateActionTemplate(state, candidate));
}

export function semanticHistoricalActionKey(evidence) {
  return JSON.stringify(abstractTemplate(evidence?.features ?? {}, evidence?.actionTemplate ?? {}));
}

function normalizedPriorEvidence(item) {
  const decisionKey = item?.decisionKey ?? (item?.features ? semanticDecisionKey(item.features) : null);
  const actionKey = item?.actionKey ?? (item?.actionTemplate ? semanticHistoricalActionKey(item) : null);
  if (!item?.episodeId || !decisionKey || !actionKey) return null;
  return { ...item, decisionKey, actionKey };
}

function occurrencePriority(item) {
  const similarity = clamp(finite(item?.similarity, 0), 0, 1);
  // Match aggregateCandidateEvidence's "most relevant occurrence" rule. A
  // full-history row has no retrieval similarity, so equal zero-priority rows
  // retain deterministic database order.
  return similarity * sourceWeight(item?.source) * Math.max(0.25, similarity);
}

function addPriorEvidence(index, item) {
  const bucket = index.get(item.decisionKey) ?? [];
  const duplicateIndex = bucket.findIndex((existing) =>
    String(existing.episodeId) === String(item.episodeId) && existing.actionKey === item.actionKey);
  if (duplicateIndex < 0) {
    bucket.push(item);
  } else if (occurrencePriority(item) > occurrencePriority(bucket[duplicateIndex])) {
    bucket[duplicateIndex] = item;
  }
  index.set(item.decisionKey, bucket);
}

/**
 * Incrementally merge a completed canonical trajectory into an existing
 * full-history index without a whole-database JSON parse. Within a
 * decision/action bucket, one canonical episode is kept as one vote regardless
 * of how many transitions or linked raw segments it contains.
 */
export function appendSemanticPriorEvidence(index, evidence) {
  const target = index instanceof Map ? index : new Map();
  const normalized = (Array.isArray(evidence) ? evidence : [])
    .map(normalizedPriorEvidence)
    .filter(Boolean);
  for (const item of normalized) addPriorEvidence(target, item);
  return target;
}

/** Build once at controller startup; episode boundaries append deltas. */
export function buildSemanticPriorIndex(evidence) {
  const index = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const normalized = normalizedPriorEvidence(item);
    if (normalized) addPriorEvidence(index, normalized);
  }
  return index;
}

export function semanticPriorEvidenceForState(index, stateOrFeatures) {
  if (!(index instanceof Map)) return [];
  return index.get(semanticDecisionKey(stateOrFeatures)) ?? [];
}

function sourceWeight(source) {
  if (new Set([
    "balatrobot_model",
    "balatrobot_model_strategic",
    "balatrobot_checkpoint_sequence",
    "semantic_fast_path",
  ]).has(source)) return 1;
  if (source === "balatrobot_validation_fallback") return 0.55;
  if (source === "balatrobot_rpc_recovery") return 0.4;
  if (source === "balatrobot_planner_fallback") return 0.25;
  return 0.45;
}

function normalizedEpisodeReturn(evidence) {
  let value = Math.tanh(finite(evidence?.returnReward, 0) / 4);
  // Old reward versions occasionally assigned positive transition returns to
  // a run that ultimately died. Such rows remain useful negative evidence but
  // must never become a positive prior merely because they are numerous.
  if (evidence?.outcome === "lost") value = Math.min(0, value);
  return clamp(value, -1, 1);
}

function confidenceInterval(samples, z) {
  const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const squareWeight = samples.reduce((sum, sample) => sum + sample.weight ** 2, 0);
  const effectiveEpisodes = weight > 0 && squareWeight > 0 ? weight ** 2 / squareWeight : 0;
  const mean = weight > 0
    ? samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight
    : 0;
  const variance = weight > 0
    ? samples.reduce((sum, sample) => sum + sample.weight * (sample.value - mean) ** 2, 0) / weight
    : 0;
  // The 0.25 prior variance prevents tiny, perfectly consistent samples from
  // pretending to have certainty. More independent episodes shrink it.
  const radius = effectiveEpisodes > 0
    ? z * Math.sqrt((variance + 0.25) / effectiveEpisodes)
    : 1;
  return {
    mean,
    effectiveEpisodes,
    lower: clamp(mean - radius, -1, 1),
    upper: clamp(mean + radius, -1, 1),
  };
}

function aggregateCandidateEvidence(state, candidate, evidence, options) {
  const decisionKey = semanticDecisionKey(state);
  const actionKey = semanticCandidateActionKey(state, candidate);
  const byEpisode = new Map();
  for (const item of evidence) {
    if (!item?.episodeId) continue;
    const historicalDecisionKey = item.decisionKey ?? (item.features ? semanticDecisionKey(item.features) : null);
    const historicalActionKey = item.actionKey ?? (item.actionTemplate ? semanticHistoricalActionKey(item) : null);
    if (historicalDecisionKey !== decisionKey) continue;
    if (historicalActionKey !== actionKey) continue;
    const similarity = clamp(finite(item.similarity, 0), 0, 1);
    const weight = sourceWeight(item.source) * Math.max(0.25, similarity);
    const sample = {
      episodeId: String(item.episodeId),
      outcome: String(item.outcome ?? "unknown"),
      value: normalizedEpisodeReturn(item),
      weight,
      similarity,
    };
    const previous = byEpisode.get(sample.episodeId);
    // One episode is one vote. Keep its most relevant occurrence so repeatedly
    // taking an action in a long run cannot swamp independent runs.
    if (!previous || sample.similarity * sample.weight > previous.similarity * previous.weight) {
      byEpisode.set(sample.episodeId, sample);
    }
  }
  const samples = [...byEpisode.values()];
  if (!samples.length) return null;
  const interval = confidenceInterval(samples, options.confidenceZ);
  const independentEpisodes = samples.length;
  const applied = independentEpisodes >= options.minimumEpisodes && interval.effectiveEpisodes >= options.minimumEpisodes * 0.75;
  const signal = !applied
    ? 0
    : interval.lower > 0
      ? interval.lower
      : interval.upper < 0
        ? interval.upper
        : 0;
  return {
    decisionKey,
    actionKey,
    independentEpisodes,
    effectiveEpisodes: Math.round(interval.effectiveEpisodes * 100) / 100,
    winningEpisodes: samples.filter((sample) => sample.outcome === "won").length,
    losingEpisodes: samples.filter((sample) => sample.outcome === "lost").length,
    meanReturn: Math.round(interval.mean * 1_000) / 1_000,
    lowerConfidenceBound: Math.round(interval.lower * 1_000) / 1_000,
    upperConfidenceBound: Math.round(interval.upper * 1_000) / 1_000,
    signal: Math.round(signal * 1_000) / 1_000,
    applied: applied && signal !== 0,
  };
}

/**
 * Calibrate the existing local candidate order with cross-seed experience.
 * This function never creates an action. The caller must continue to validate
 * the selected action against the original exact-state candidate set.
 */
export function applySemanticCandidatePriors(state, candidates, retrieval, options = {}) {
  const source = Array.isArray(candidates) ? candidates : [];
  const evidence = retrieval?.priorIndex instanceof Map
    ? semanticPriorEvidenceForState(retrieval.priorIndex, state)
    : Array.isArray(retrieval?.evidence) ? retrieval.evidence : [];
  const settings = {
    minimumEpisodes: Math.max(2, finite(options.minimumEpisodes, DEFAULT_MINIMUM_EPISODES)),
    confidenceZ: clamp(finite(options.confidenceZ, DEFAULT_CONFIDENCE_Z), 0.5, 3),
    maximumBlend: clamp(finite(options.maximumBlend, DEFAULT_MAXIMUM_BLEND), 0, 0.5),
  };
  const enriched = source.map((candidate, index) => {
    const baselinePriority = source.length <= 1 ? 1 : 1 - index / (source.length - 1);
    const prior = aggregateCandidateEvidence(state, candidate, evidence, settings);
    const blend = prior?.applied
      ? Math.min(settings.maximumBlend, 0.1 * Math.log2(prior.independentEpisodes + 1))
      : 0;
    const calibratedPriority = baselinePriority + (prior?.signal ?? 0) * blend;
    return {
      ...candidate,
      ...(prior ? { experiencePrior: { ...prior, blend: Math.round(blend * 1_000) / 1_000 } } : {}),
      calibratedPriority: Math.round(calibratedPriority * 1_000) / 1_000,
      localBaselinePriority: Math.round(baselinePriority * 1_000) / 1_000,
      __originalIndex: index,
    };
  });
  const ranked = enriched
    .toSorted((left, right) => right.calibratedPriority - left.calibratedPriority || left.__originalIndex - right.__originalIndex)
    .map(({ __originalIndex, ...candidate }, calibratedIndex) => ({
      ...candidate,
      baselineRank: __originalIndex + 1,
      calibratedRank: calibratedIndex + 1,
      rankChanged: __originalIndex !== calibratedIndex,
    }));
  return {
    candidates: ranked,
    evidenceCount: evidence.length,
    matchedCandidates: ranked.filter((candidate) => candidate.experiencePrior).length,
    appliedCandidates: ranked.filter((candidate) => candidate.experiencePrior?.applied).length,
    rankChanged: ranked.some((candidate) => candidate.rankChanged),
    baselineTopCandidateId: source[0]?.id ?? null,
    calibratedTopCandidateId: ranked[0]?.id ?? null,
  };
}
