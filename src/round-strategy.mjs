function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

const ROUND_RESET_SCREENS = new Set(["main_menu", "run_setup", "round_result", "game_over"]);
const ROUND_TRACKING_SCREENS = new Set(["blind_select", "hand"]);
const DECK_OVERLAY_SCREENS = new Set(["deck_view", "overlay"]);

export function roundMetrics(state = {}) {
  const score = finiteNumber(state.score);
  const target = finiteNumber(state.target);
  const handsLeft = finiteNumber(state.handsLeft);
  const discardsLeft = finiteNumber(state.discardsLeft);
  if (score === null || target === null || target <= 0 || handsLeft === null) return null;
  const deficit = Math.max(0, target - score);
  return {
    score,
    target,
    deficit,
    handsLeft,
    discardsLeft,
    neededPerHand: deficit === 0 ? 0 : handsLeft > 0 ? Math.ceil(deficit / handsLeft) : Number.POSITIVE_INFINITY,
  };
}

export class RoundStrategyContext {
  constructor() {
    this.reset();
  }

  reset() {
    this.identity = "";
    this.state = null;
    this.deckInspectionPending = false;
    this.deckInspected = false;
    this.deckSnapshot = "";
  }

  observe(plan) {
    if (!plan || typeof plan !== "object") return;
    if (ROUND_RESET_SCREENS.has(plan.screen)) {
      this.reset();
      return;
    }

    const state = plan.state ?? {};
    if (Number.isFinite(state.target) && state.target > 0 && ROUND_TRACKING_SCREENS.has(plan.screen)) {
      const identity = `${state.ante ?? "?"}|${state.target}`;
      if (this.identity && identity !== this.identity) this.reset();
      this.identity = identity;
      this.state = {
        ante: state.ante ?? null,
        blind: state.blind ?? "",
        score: state.score ?? null,
        target: state.target,
        handsLeft: state.handsLeft ?? null,
        discardsLeft: state.discardsLeft ?? null,
        deckRemaining: state.deckRemaining ?? null,
        deckTotal: state.deckTotal ?? null,
      };
    }

    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (plan.screen === "hand" && actions.some((action) => action?.type === "click" && action.target === "open_deck")) {
      this.deckInspectionPending = true;
    }

    if (DECK_OVERLAY_SCREENS.has(plan.screen) && this.deckInspectionPending) {
      const closesDeck = actions.some(
        (action) =>
          (action?.type === "key" && action.key === "escape") ||
          (action?.type === "click" && action.target === "close_deck"),
      );
      const snapshot = typeof state.deckSnapshot === "string" ? state.deckSnapshot.trim().slice(0, 240) : "";
      if (snapshot) this.deckSnapshot = snapshot;
      if (closesDeck) {
        this.deckInspected = true;
        this.deckInspectionPending = false;
      }
    }
  }

  promptContext() {
    if (!this.state) {
      return "Round continuity: no prior blind state is available; read the current target, score, Hands, and Discards from the screenshot.";
    }
    const metrics = roundMetrics(this.state);
    const round = metrics
      ? `Prior round state: ${metrics.score}/${metrics.target}, need ${metrics.deficit}, Hands ${metrics.handsLeft}, ` +
        `Discards ${metrics.discardsLeft ?? "?"}, deck ${this.state.deckRemaining ?? "?"}/${this.state.deckTotal ?? "?"}, ` +
        `required average ${Number.isFinite(metrics.neededPerHand) ? metrics.neededPerHand : "impossible"} per remaining Hand.`
      : "Prior round counters were incomplete; reread all counters from the screenshot.";
    const deck = this.deckInspectionPending
      ? "Remaining-deck overlay was requested: read its rank/suit counts into state.deckSnapshot, then close it with Escape."
      : this.deckInspected
        ? `Remaining deck inspected this blind: ${this.deckSnapshot || "counts were unreadable"}. Do not reopen it unless deck composition changed materially.`
        : "Remaining deck has not been inspected this blind. Inspect it before a high-leverage draw decision when exact outs would change play versus discard.";
    return `Controller continuity only; the current screenshot overrides stale values. ${round} ${deck}`;
  }
}
