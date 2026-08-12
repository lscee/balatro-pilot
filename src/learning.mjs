import crypto from "node:crypto";

export const LEARNING_OUTCOMES = new Set(["ongoing", "won", "lost", "unknown"]);

function shortText(value, fallback = "", maxLength = 500) {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function nullableNumber(value, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) return null;
  return number;
}

function normalizedFeatures(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    const feature = shortText(item, "", 80).toLowerCase();
    if (feature) unique.add(feature);
    if (unique.size >= 16) break;
  }
  return [...unique];
}

export function normalizeLearningState(raw, fallback = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const outcome = LEARNING_OUTCOMES.has(source.outcome) ? source.outcome : "unknown";
  return {
    summary: shortText(source.summary, shortText(fallback.observation, "Unknown visible state", 400), 400),
    ante: nullableNumber(source.ante, { integer: true, max: 99 }),
    money: nullableNumber(source.money, { max: 1_000_000 }),
    score: nullableNumber(source.score, { max: 1e18 }),
    target: nullableNumber(source.target, { max: 1e18 }),
    handsLeft: nullableNumber(source.handsLeft, { integer: true, max: 99 }),
    discardsLeft: nullableNumber(source.discardsLeft, { integer: true, max: 99 }),
    deck: shortText(source.deck, "", 80),
    deckRemaining: nullableNumber(source.deckRemaining, { integer: true, max: 999 }),
    deckTotal: nullableNumber(source.deckTotal, { integer: true, max: 999 }),
    deckSnapshot: shortText(source.deckSnapshot, "", 240),
    stake: shortText(source.stake, "", 80),
    blind: shortText(source.blind, "", 120),
    build: shortText(source.build, "", 160),
    outcome,
    features: normalizedFeatures(source.features),
  };
}

export function normalizeDecision(raw, fallback = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fallbackAction = Array.isArray(fallback.actions)
    ? fallback.actions.map((action) => shortText(action?.reason, action?.type ?? "", 80)).filter(Boolean).join(" -> ")
    : "";
  return {
    key: shortText(source.key, fallbackAction || shortText(fallback.strategy, "unknown", 120), 120).toLowerCase(),
    summary: shortText(source.summary, shortText(fallback.strategy, fallbackAction || "Unknown decision", 300), 300),
    selectedBefore: normalizedCardSlots(source.selectedBefore),
    selectedAfter: normalizedCardSlots(source.selectedAfter),
    visibleCardCount: normalizedCardCount(source.visibleCardCount),
    handCapacity: normalizedCardCount(source.handCapacity),
    visibleCards: normalizedVisibleCards(source.visibleCards),
    targetHand: normalizedTargetHand(source.targetHand),
    packChoice: normalizedPackChoice(source.packChoice),
    shopOfferPositions: normalizedShopOfferPositions(source.shopOfferPositions),
    commit: new Set(["play_hand", "discard", "none"]).has(source.commit) ? source.commit : "none",
  };
}

function normalizedPackChoice(value) {
  const choice = shortText(value, "none", 40).toLowerCase();
  return choice === "none" || /^pack_choice_[1-5]_of_[1-5]$/.test(choice) ? choice : "none";
}

function normalizedShopOfferPositions(value) {
  if (!Array.isArray(value)) return [];
  const positions = [...new Set(value.map((item) => shortText(item, "", 12).toLowerCase()))];
  if (positions.length === 1 && positions[0] === "center") return positions;
  if (positions.length === 2 && positions.includes("left") && positions.includes("right")) return ["left", "right"];
  return [];
}

function normalizedCardCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 20 ? count : 0;
}

function normalizedCardSlots(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    const slot = shortText(item, "", 20).toLowerCase();
    if (/^card_(?:[1-9]|1[0-9]|20)$/.test(slot)) unique.add(slot);
    if (unique.size >= 20) break;
  }
  return [...unique];
}

function normalizedVisibleCards(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => shortText(item, "", 3).toUpperCase())
    .map((item) => item.replace(/^10([SHDC?])$/, "T$1"))
    .filter((item) => /^(?:[2-9TJQKA][SHDC?]|\?\?)$/.test(item))
    .slice(0, 20);
}

function normalizedTargetHand(value) {
  const target = shortText(value, "none", 40).toLowerCase();
  return new Set([
    "none",
    "high_card",
    "pair",
    "two_pair",
    "three_of_a_kind",
    "straight",
    "flush",
    "full_house",
    "four_of_a_kind",
    "straight_flush",
    "five_of_a_kind",
    "flush_house",
    "flush_five",
    "other",
  ]).has(target)
    ? target
    : "other";
}

function canonicalToken(value) {
  return shortText(value, "", 160).toLowerCase();
}

export function stateHash(screen, state) {
  const canonical = JSON.stringify({
    screen,
    ante: state.ante,
    money: state.money,
    score: state.score,
    target: state.target,
    handsLeft: state.handsLeft,
    discardsLeft: state.discardsLeft,
    deck: canonicalToken(state.deck),
    deckRemaining: state.deckRemaining,
    deckTotal: state.deckTotal,
    deckSnapshot: canonicalToken(state.deckSnapshot),
    stake: canonicalToken(state.stake),
    blind: canonicalToken(state.blind),
    build: canonicalToken(state.build),
    outcome: state.outcome,
    features: [...state.features].sort(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function stateBucket(screen, state) {
  const moneyBand = state.money === null ? "?" : Math.floor(state.money / 5) * 5;
  const progressBand =
    state.score === null || state.target === null || state.target <= 0
      ? "?"
      : Math.min(100, Math.floor((state.score / state.target) * 4) * 25);
  const pressure = roundPressure(state);
  const pressureBand = pressure === null || !Number.isFinite(pressure) ? "?" : Math.min(20, Math.floor(pressure * 20));
  const durable = [state.deck, state.stake, state.blind, state.build]
    .map(canonicalToken)
    .filter(Boolean)
    .join("|");
  const features = [...state.features].sort().slice(0, 6).join("|");
  return (
    `v2|${screen}|a${state.ante ?? "?"}|m${moneyBand}|p${progressBand}|q${pressureBand}|` +
    `h${state.handsLeft ?? "?"}|d${state.discardsLeft ?? "?"}|r${state.deckRemaining ?? "?"}|${durable}|${features}`
  ).slice(0, 500);
}

export function stateText(plan) {
  const state = plan.state;
  return [
    `screen:${plan.screen}`,
    state.ante === null ? "" : `ante:${state.ante}`,
    state.money === null ? "" : `money:${state.money}`,
    state.score === null || state.target === null ? "" : `score:${state.score}/${state.target}`,
    state.score === null || state.target === null ? "" : `need:${Math.max(0, state.target - state.score)}`,
    state.handsLeft === null ? "" : `hands:${state.handsLeft}`,
    state.discardsLeft === null ? "" : `discards:${state.discardsLeft}`,
    state.deck && `deck:${state.deck}`,
    state.deckRemaining === null ? "" : `deck-count:${state.deckRemaining}/${state.deckTotal ?? "?"}`,
    state.deckSnapshot && `remaining:${state.deckSnapshot}`,
    state.stake && `stake:${state.stake}`,
    state.blind && `blind:${state.blind}`,
    state.build && `build:${state.build}`,
    state.summary,
    state.features.join(" "),
    plan.memory,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1_500);
}

export function roundPressure(state) {
  if (
    state?.score === null ||
    state?.score === undefined ||
    state?.target === null ||
    state?.target === undefined ||
    state?.handsLeft === null ||
    state?.handsLeft === undefined ||
    !Number.isFinite(state.score) ||
    !Number.isFinite(state.target) ||
    !Number.isFinite(state.handsLeft) ||
    state.target <= 0
  ) {
    return null;
  }
  const deficit = Math.max(0, state.target - state.score);
  if (deficit === 0) return 0;
  if (state.handsLeft <= 0) return Number.POSITIVE_INFINITY;
  return deficit / (state.target * state.handsLeft);
}

const SCREEN_PROGRESS = new Map([
  ["main_menu>run_setup", 0.5],
  ["run_setup>blind_select", 1],
  ["blind_select>hand", 1],
  ["hand>round_result", 4],
  ["round_result>shop", 1],
  ["shop>blind_select", 1],
  ["game_over>main_menu", 0.2],
  ["run_setup>main_menu", -3],
]);

export function transitionReward(previousPlan, nextPlan, { frameChanged = true } = {}) {
  let reward = frameChanged ? 0.1 : -1.5;
  reward += SCREEN_PROGRESS.get(`${previousPlan.screen}>${nextPlan.screen}`) ?? 0;

  const previous = previousPlan.state;
  const next = nextPlan.state;
  if (previous.ante !== null && next.ante !== null && next.ante > previous.ante) {
    reward += Math.min(5, next.ante - previous.ante) * 12;
  }
  if (previousPlan.screen === "hand" && nextPlan.screen === "hand" && previous.target && next.target === previous.target) {
    const previousPressure = roundPressure(previous);
    const nextPressure = roundPressure(next);
    if (previousPressure !== null && nextPressure !== null) {
      if (!Number.isFinite(nextPressure)) reward -= 3;
      else if (Number.isFinite(previousPressure)) {
        reward += Math.max(-3, Math.min(3, (previousPressure - nextPressure) * 6));
      }
    }
  }
  if (previous.money !== null && next.money !== null && next.money > previous.money) {
    reward += Math.min(0.5, (next.money - previous.money) * 0.05);
  }
  if (!frameChanged && previousPlan.decision.key === nextPlan.decision.key) reward -= 1.5;
  if (next.outcome === "won") reward += 100;
  if (next.outcome === "lost" || nextPlan.screen === "game_over") reward -= 25;
  return Math.round(reward * 1_000) / 1_000;
}

export function isTerminalPlan(plan) {
  return plan.finished || plan.screen === "game_over" || plan.state.outcome === "won" || plan.state.outcome === "lost";
}
