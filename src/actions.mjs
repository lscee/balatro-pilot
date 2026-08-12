import { normalizeDecision, normalizeLearningState } from "./learning.mjs";
import { signatureRegionDifference } from "./frame-gate.mjs";

export const ALLOWED_KEYS = new Set(["escape", "enter", "space", "tab", "left", "right", "up", "down"]);
const KEY_ALIASES = new Map([
  ["escape", "escape"],
  ["esc", "escape"],
  ["enter", "enter"],
  ["return", "enter"],
  ["space", "space"],
  ["spacebar", "space"],
  ["tab", "tab"],
  ["left", "left"],
  ["arrowleft", "left"],
  ["leftarrow", "left"],
  ["right", "right"],
  ["arrowright", "right"],
  ["rightarrow", "right"],
  ["up", "up"],
  ["arrowup", "up"],
  ["uparrow", "up"],
  ["down", "down"],
  ["arrowdown", "down"],
  ["downarrow", "down"],
]);
const ANIMATED_OVERLAY_SCREENS = new Set(["deck_view", "overlay"]);
const STATIC_LAYOUT_SCREENS = new Set(["pack", "shop"]);
const ALLOWED_TYPES = new Set(["click", "key", "wait", "stop"]);
const PRIMARY_MOUSE_BUTTONS = new Set(["left", "right"]);
const HAND_COMMIT_TARGETS = new Set(["play_hand", "discard"]);
const DIRECT_HAND_TARGETS = new Set(["play_hand", "discard", "open_deck"]);
const PACK_ACTION_KINDS = new Set(["use", "skip"]);
const HAND_LAYOUT_ASPECT_TALL = 1.54;
const HAND_LAYOUT_ASPECT_WIDE = 1.97;
const HAND_CARD_X_MIN_TALL = 0.3;
const HAND_CARD_X_MAX_TALL = 0.765;
const HAND_CARD_X_MIN_WIDE = 0.322;
const HAND_CARD_X_MAX_WIDE = 0.749;
const HAND_CARD_Y = 0.615;
const HAND_COMMIT_POINTS = Object.freeze({
  play_hand: Object.freeze({ x: 0.425, y: 0.85 }),
  discard: Object.freeze({ x: 0.66, y: 0.85 }),
});
const OPEN_DECK_POINT = Object.freeze({ x: 0.89, y: 0.8 });
const PACK_CHOICE_CENTER_X = 0.54;
const PACK_CHOICE_SPACING = 0.085;
const PACK_CHOICE_Y = 0.7;
const PACK_USE_Y = 0.805;
const PACK_CARD_Y = 0.405;
const PACK_SKIP_POINT = Object.freeze({ x: 0.675, y: 0.895 });
const PACK_TRANSITION_ACK_THRESHOLD = 0.08;
const SHOP_TARGET_POINTS = Object.freeze({
  shop_offer_left: Object.freeze({ x: 0.555, layout: "offer", purchase: true, retryable: true }),
  shop_offer_center: Object.freeze({ x: 0.61, layout: "offer", purchase: true, retryable: true }),
  shop_offer_right: Object.freeze({ x: 0.665, layout: "offer", purchase: true, retryable: true }),
  shop_offer_left_use: Object.freeze({ x: 0.555, useX: 0.61, layout: "offer_use", purchase: true, retryable: true }),
  shop_offer_center_use: Object.freeze({ x: 0.61, useX: 0.665, layout: "offer_use", purchase: true, retryable: true }),
  shop_offer_right_use: Object.freeze({ x: 0.665, useX: 0.61, layout: "offer_use", purchase: true, retryable: true }),
  shop_voucher: Object.freeze({ x: 0.44, layout: "voucher", purchase: true, retryable: false }),
  shop_pack_left: Object.freeze({ x: 0.61, layout: "pack", purchase: true, retryable: false, transition: true }),
  shop_pack_center: Object.freeze({
    x: 0.655,
    xTall: 0.668,
    xWide: 0.655,
    layout: "pack",
    purchase: true,
    retryable: false,
    transition: true,
  }),
  shop_pack_right: Object.freeze({ x: 0.715, layout: "pack", purchase: true, retryable: false, transition: true }),
  shop_reroll: Object.freeze({ x: 0.36, y: 0.55, layout: "direct", purchase: false, retryable: false }),
  shop_next_round: Object.freeze({ x: 0.36, y: 0.42, layout: "direct", purchase: false, retryable: false }),
});
const ALLOWED_SCREENS = new Set([
  "main_menu",
  "run_setup",
  "blind_select",
  "hand",
  "deck_view",
  "shop",
  "pack",
  "round_result",
  "game_over",
  "overlay",
  "unknown",
]);

function assertFiniteCoordinate(value, name) {
  if (!Number.isFinite(value) || value < 0.005 || value > 0.995) {
    throw new Error(`${name} must be a number between 0.005 and 0.995`);
  }
}

export function normalizeAllowedKey(value) {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return KEY_ALIASES.get(token) ?? null;
}

export function preActionChangeRatioThreshold(plan, config) {
  const closesAnimatedOverlay =
    ANIMATED_OVERLAY_SCREENS.has(plan?.screen) &&
    plan?.actions?.length === 1 &&
    plan.actions[0]?.type === "key" &&
    normalizeAllowedKey(plan.actions[0].key) === "escape";
  if (closesAnimatedOverlay) return config.preActionAnimatedOverlayChangeRatio;
  if (STATIC_LAYOUT_SCREENS.has(plan?.screen)) return config.preActionStaticLayoutChangeRatio;
  return config.preActionFreshnessChangeRatio;
}

export function canonicalHandCardPoint(target, visibleCardCount, handCapacity, aspectRatio = 1.82) {
  const match = /^card_(\d{1,2})$/.exec(target ?? "");
  const slot = match ? Number(match[1]) : 0;
  if (!Number.isInteger(visibleCardCount) || visibleCardCount < 1 || visibleCardCount > 20) {
    throw new Error("decision.visibleCardCount must be an integer between 1 and 20 on a hand screen");
  }
  if (!Number.isInteger(handCapacity) || handCapacity < visibleCardCount || handCapacity > 20) {
    throw new Error("decision.handCapacity must be between visibleCardCount and 20 on a hand screen");
  }
  if (slot < 1 || slot > visibleCardCount) {
    throw new Error(`${target ?? "card target"} exceeds the ${visibleCardCount} visible cards`);
  }
  const wide = Math.max(
    0,
    Math.min(1, (Number(aspectRatio) - HAND_LAYOUT_ASPECT_TALL) / (HAND_LAYOUT_ASPECT_WIDE - HAND_LAYOUT_ASPECT_TALL)),
  );
  const xMin = HAND_CARD_X_MIN_TALL + (HAND_CARD_X_MIN_WIDE - HAND_CARD_X_MIN_TALL) * wide;
  const xMax = HAND_CARD_X_MAX_TALL + (HAND_CARD_X_MAX_WIDE - HAND_CARD_X_MAX_TALL) * wide;
  const coordinate = (value) => Math.round(value * 1_000_000) / 1_000_000;
  if (handCapacity === 1) return { x: coordinate((xMin + xMax) / 2), y: HAND_CARD_Y };
  const spacing = (xMax - xMin) / (handCapacity - 1);
  const centeredOffset = (handCapacity - visibleCardCount) / 2;
  return {
    x: coordinate(xMin + (centeredOffset + slot - 1) * spacing),
    y: HAND_CARD_Y,
  };
}

export function canonicalPackTargetPoint(target, aspectRatio = 1.82) {
  if (target === "pack_skip") return { ...PACK_SKIP_POINT, kind: "skip" };

  const choice = /^pack_(choice|use)_(\d)_of_(\d)$/.exec(target ?? "");
  if (choice) {
    const kind = choice[1];
    const slot = Number(choice[2]);
    const count = Number(choice[3]);
    if (count < 1 || count > 5 || slot < 1 || slot > count) return null;
    const coordinate = (value) => Math.round(value * 1_000_000) / 1_000_000;
    return {
      x: coordinate(PACK_CHOICE_CENTER_X + (slot - (count + 1) / 2) * PACK_CHOICE_SPACING),
      y: kind === "choice" ? PACK_CHOICE_Y : PACK_USE_Y,
      kind,
      slot,
      count,
    };
  }

  const card = /^pack_card_(\d{1,2})_of_(\d{1,2})$/.exec(target ?? "");
  if (!card) return null;
  const slot = Number(card[1]);
  const count = Number(card[2]);
  if (count < 1 || count > 20 || slot < 1 || slot > count) return null;
  const point = canonicalHandCardPoint(`card_${slot}`, count, count, aspectRatio);
  return { x: point.x, y: PACK_CARD_Y, kind: "card", slot, count };
}

export function canonicalShopTargetPoint(target, aspectRatio = 1.82) {
  const base = SHOP_TARGET_POINTS[target];
  if (!base) return null;
  const coordinate = (value) => Math.round(value * 1_000_000) / 1_000_000;
  if (base.layout === "direct") {
    return {
      hoverX: base.x,
      hoverY: base.y,
      x: base.x,
      y: base.y,
      purchase: false,
      retryable: false,
      regionColumns: 1,
      regionRows: 2,
    };
  }
  const wide = Math.max(0, Math.min(1, (Number(aspectRatio) - 1.54) / (1.82 - 1.54)));
  const x = base.xTall === undefined ? base.x : coordinate(base.xTall + (base.xWide - base.xTall) * wide);
  if (base.layout === "offer") {
    return {
      hoverX: x,
      hoverY: coordinate(0.49 - 0.01 * wide),
      x,
      y: coordinate(0.56 + 0.015 * wide),
      purchase: true,
      retryable: true,
      regionColumns: 1,
      regionRows: 3,
    };
  }
  if (base.layout === "offer_use") {
    return {
      hoverX: base.x,
      hoverY: coordinate(0.49 - 0.01 * wide),
      x: base.useX,
      y: coordinate(0.44 + 0.01 * wide),
      purchase: true,
      retryable: true,
      transition: false,
      regionColumns: 2,
      regionRows: 3,
    };
  }
  if (base.layout === "pack") {
    return {
      hoverX: x,
      hoverY: coordinate(0.75 + 0.03 * wide),
      x,
      y: coordinate(0.883 + 0.042 * wide),
      purchase: true,
      retryable: false,
      transition: Boolean(base.transition),
      regionColumns: 2,
      regionRows: 3,
    };
  }
  return {
    hoverX: x,
    hoverY: coordinate(0.76 + 0.02 * wide),
    x,
    y: coordinate(0.86 + 0.04 * wide),
    purchase: true,
    retryable: false,
    regionColumns: 2,
    regionRows: 3,
  };
}

export class ShopLoopGuard {
  constructor(limit = 4) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error("ShopLoopGuard limit must be an integer of at least 2");
    this.limit = limit;
    this.count = 0;
    this.lastFiniteMoney = null;
  }

  reset() {
    this.count = 0;
    this.lastFiniteMoney = null;
  }

  observe(plan) {
    const action = plan?.screen === "shop"
      ? plan.actions?.find(
          (candidate) =>
            candidate?.type === "click" && /^shop_offer_(?:left|center|right)_use$/.test(candidate.target ?? ""),
        )
      : null;
    if (!action) {
      this.reset();
      return { recover: false, count: 0, target: null };
    }

    const money = Number.isFinite(plan?.state?.money) ? plan.state.money : null;
    if (this.count === 0 || (money !== null && this.lastFiniteMoney !== null && money !== this.lastFiniteMoney)) {
      this.count = 1;
    } else this.count += 1;
    if (money !== null) this.lastFiniteMoney = money;
    return { recover: this.count >= this.limit, count: this.count, target: action.target };
  }
}

function validCaptureSignature(capture) {
  const cellBytes = capture?.signatureCellBytes ?? 2;
  if (!Number.isInteger(cellBytes) || cellBytes < 1) return false;
  if (typeof capture?.signature !== "string" || !capture.signature) return false;
  try {
    return Buffer.from(capture.signature, "base64").length === 32 * 24 * cellBytes;
  } catch {
    return false;
  }
}

function compatibleCaptureSignatures(...captures) {
  if (!captures.length || captures.some((capture) => !validCaptureSignature(capture))) return false;
  const cellBytes = captures[0].signatureCellBytes ?? 2;
  return captures.every((capture) => (capture.signatureCellBytes ?? 2) === cellBytes);
}

export function validatePlan(rawPlan, config) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("Plan must be an object");
  }
  if (typeof rawPlan.observation !== "string" || rawPlan.observation.length > 1_500) {
    throw new Error("Plan observation is missing or too long");
  }
  if (typeof rawPlan.strategy !== "string" || rawPlan.strategy.length > 1_500) {
    throw new Error("Plan strategy is missing or too long");
  }
  if (typeof rawPlan.memory !== "string" || rawPlan.memory.length > 500) {
    throw new Error("Plan memory is missing or too long");
  }
  if (!ALLOWED_SCREENS.has(rawPlan.screen)) {
    throw new Error("Plan screen is missing or unsupported");
  }
  if (!Number.isFinite(rawPlan.confidence) || rawPlan.confidence < 0 || rawPlan.confidence > 1) {
    throw new Error("Plan confidence must be between 0 and 1");
  }
  if (typeof rawPlan.finished !== "boolean") {
    throw new Error("Plan finished must be boolean");
  }
  if (typeof rawPlan.needsDetail !== "boolean") {
    throw new Error("Plan needsDetail must be boolean");
  }
  if (!Array.isArray(rawPlan.actions) || rawPlan.actions.length < 1) {
    throw new Error("Plan must contain at least one action");
  }

  const state = normalizeLearningState(rawPlan.state, rawPlan);
  const decision = normalizeDecision(rawPlan.decision, rawPlan);
  if (rawPlan.screen === "hand") {
    if (decision.selectedBefore.length > 5) throw new Error("A hand screen cannot have more than 5 selected cards");
    if (decision.selectedAfter.length > 5) throw new Error("Play Hand or Discard may select at most 5 cards");
  }

  const actions = rawPlan.actions.map((action, index) => {
    if (!action || typeof action !== "object" || !ALLOWED_TYPES.has(action.type)) {
      throw new Error(`Action ${index} has an unsupported type`);
    }
    const reason = typeof action.reason === "string" ? action.reason.slice(0, 500) : "";
    let target = typeof action.target === "string" ? action.target.trim().toLowerCase().slice(0, 40) : null;
    if (
      rawPlan.screen === "shop" &&
      decision.shopOfferPositions.length === 1 &&
      decision.shopOfferPositions[0] === "center" &&
      /^shop_offer_(?:left|right)(?:_use)?$/.test(target ?? "")
    ) {
      target = target.endsWith("_use") ? "shop_offer_center_use" : "shop_offer_center";
    }
    switch (action.type) {
      case "click": {
        const semanticHandClick =
          rawPlan.screen === "hand" &&
          (/^card_(?:[1-9]|1[0-9]|20)$/.test(target ?? "") || DIRECT_HAND_TARGETS.has(target));
        const shopPoint = rawPlan.screen === "shop" ? canonicalShopTargetPoint(target) : null;
        const semanticShopClick = Boolean(shopPoint);
        const packPoint = rawPlan.screen === "pack" ? canonicalPackTargetPoint(target) : null;
        const semanticPackClick = Boolean(packPoint);
        if (rawPlan.screen === "shop" && !semanticShopClick) {
          throw new Error(
            `Action ${index} on a shop screen must use shop_offer_left, shop_offer_center, shop_offer_right, ` +
              `shop_offer_left_use, shop_offer_center_use, shop_offer_right_use, shop_voucher, shop_pack_left, ` +
              `shop_pack_center, shop_pack_right, shop_reroll, or shop_next_round`,
          );
        }
        if (rawPlan.screen === "pack" && !semanticPackClick) {
          throw new Error(
            `Action ${index} on a pack screen must use pack_card_N_of_C, pack_use_N_of_C, or pack_skip`,
          );
        }
        if (!semanticHandClick && !semanticShopClick && !semanticPackClick) {
          assertFiniteCoordinate(action.x, `actions[${index}].x`);
          assertFiniteCoordinate(action.y, `actions[${index}].y`);
        }
        if (!semanticHandClick && !semanticShopClick && !semanticPackClick && !PRIMARY_MOUSE_BUTTONS.has(action.button)) {
          throw new Error(`Action ${index} has an unsupported mouse button`);
        }
        return {
          type: "click",
          x: semanticShopClick
            ? shopPoint.x
            : semanticPackClick
              ? packPoint.x
              : semanticHandClick && !Number.isFinite(action.x)
                ? 0.5
                : action.x,
          y: semanticShopClick
            ? shopPoint.y
            : semanticPackClick
              ? packPoint.y
              : semanticHandClick && !Number.isFinite(action.y)
                ? 0.5
                : action.y,
          button: semanticHandClick || semanticShopClick || semanticPackClick ? "left" : action.button,
          target,
          reason,
        };
      }
      case "key": {
        const key = normalizeAllowedKey(action.key);
        if (!key || !ALLOWED_KEYS.has(key)) {
          throw new Error(`Action ${index} has an unsupported key: ${JSON.stringify(action.key)}`);
        }
        return { type: "key", key, target, reason };
      }
      case "wait": {
        if (!Number.isInteger(action.ms) || action.ms < 100 || action.ms > 5_000) {
          throw new Error(`Action ${index} wait must be 100-5000 ms`);
        }
        return { type: "wait", ms: action.ms, target, reason };
      }
      case "stop":
        return { type: "stop", target, reason: reason || "Planner requested stop" };
      default:
        throw new Error(`Action ${index} is unsupported`);
    }
  });

  const containsInput = actions.some((action) => action.type === "click" || action.type === "key");
  if (containsInput && (rawPlan.confidence < config.minimumConfidence || rawPlan.needsDetail)) {
    return {
      observation: rawPlan.observation,
      strategy: rawPlan.needsDetail
        ? `Required visual detail is still unreadable; controller replaced input with a wait. ${rawPlan.strategy}`
        : `Low confidence (${rawPlan.confidence}); controller replaced input with a wait. ${rawPlan.strategy}`,
      memory: rawPlan.memory,
      screen: rawPlan.screen,
      state,
      decision,
      confidence: rawPlan.confidence,
      finished: false,
      needsDetail: rawPlan.needsDetail,
      actions: [
        {
          type: "wait",
          ms: 1_000,
          reason: rawPlan.needsDetail ? "Required visual detail is unreadable" : "Confidence below local threshold",
        },
      ],
    };
  }

  if (rawPlan.screen === "hand" && actions.some((action) => action.type === "click")) {
    const clickActions = actions.filter((action) => action.type === "click");
    const inspectsDeck = clickActions.some((action) => action.target === "open_deck");
    if (inspectsDeck) {
      if (actions.length !== 1 || clickActions.length !== 1 || clickActions[0].target !== "open_deck") {
        throw new Error("A deck inspection must contain only one open_deck click");
      }
      if (decision.commit !== "none") throw new Error("A deck inspection cannot commit a hand");
      if (decision.visibleCardCount < 1 || decision.visibleCardCount !== decision.handCapacity) {
        throw new Error("The hand must be fully dealt before opening the remaining-deck view");
      }
      if (decision.visibleCards.length !== decision.visibleCardCount) {
        throw new Error("decision.visibleCards must list every visible card before opening the deck view");
      }
      if (decision.visibleCards.some((card) => card.includes("?"))) {
        throw new Error("Every visible card rank and suit must be readable before opening the deck view");
      }
      const before = [...decision.selectedBefore].sort();
      const after = [...decision.selectedAfter].sort();
      if (before.join("|") !== after.join("|")) {
        throw new Error("Opening the deck view cannot change the intended card selection");
      }
      clickActions[0].x = OPEN_DECK_POINT.x;
      clickActions[0].y = OPEN_DECK_POINT.y;
    } else {
    const last = actions.at(-1);
    const commitsHand =
      last?.type === "click" &&
      (HAND_COMMIT_TARGETS.has(last.target) || /play\s*hand|discard|出牌|打出|弃牌|丢弃/i.test(last.reason ?? ""));
    if (!commitsHand) {
      throw new Error("A hand-screen click plan must end by clicking Play Hand or Discard; partial card selection is forbidden");
    }
    if (decision.selectedAfter.length < 1 || decision.selectedAfter.length > 5) {
      throw new Error("A committed Play Hand or Discard plan must declare a final selection of 1 to 5 cards");
    }
    if (decision.visibleCardCount < 1 || decision.handCapacity < decision.visibleCardCount) {
      throw new Error("A hand plan must report valid visibleCardCount and handCapacity values from the N/C counter");
    }
    if (decision.visibleCardCount !== decision.handCapacity && state.deckRemaining !== 0) {
      throw new Error("The hand is still being dealt (N/C is incomplete and cards remain in deck); wait before committing");
    }
    if (decision.visibleCards.length !== decision.visibleCardCount) {
      throw new Error("decision.visibleCards must list every visible card before committing a hand");
    }
    if (decision.visibleCards.some((card) => card.includes("?"))) {
      throw new Error("Every visible card rank and suit must be readable before committing a hand");
    }
    if (!HAND_COMMIT_TARGETS.has(last.target)) {
      throw new Error("A hand commit click must use target play_hand or discard");
    }
    if (last.target !== decision.commit) {
      throw new Error("Hand commit target conflicts with decision.commit");
    }
    const before = new Set(decision.selectedBefore);
    const after = new Set(decision.selectedAfter);
    for (const slot of [...before, ...after]) {
      canonicalHandCardPoint(slot, decision.visibleCardCount, decision.handCapacity);
    }
    const expectedToggles = new Set([...before, ...after].filter((slot) => before.has(slot) !== after.has(slot)));
    const cardClicks = actions.slice(0, -1).filter((action) => action.type === "click");
    if (cardClicks.some((action) => !/^card_(?:[1-9]|1[0-9]|20)$/.test(action.target ?? ""))) {
      throw new Error("Every hand card toggle must use a card_N target");
    }
    if (before.size || after.size) {
      const targetList = cardClicks.map((action) => action.target);
      const provided = new Set(targetList);
      if (provided.size !== targetList.length) throw new Error("Hand plan clicks the same card slot more than once");
      const missing = [...expectedToggles].filter((slot) => !provided.has(slot));
      if (missing.length) throw new Error(`Hand plan is missing required card toggles: ${missing.join(", ")}`);
      for (let index = actions.length - 2; index >= 0; index--) {
        if (actions[index].type === "click" && !expectedToggles.has(actions[index].target)) actions.splice(index, 1);
      }
      for (const action of actions.slice(0, -1)) {
        if (action.type !== "click") continue;
        const point = canonicalHandCardPoint(action.target, decision.visibleCardCount, decision.handCapacity);
        action.x = point.x;
        action.y = point.y;
      }
    }
    const commitPoint = HAND_COMMIT_POINTS[last.target];
    last.x = commitPoint.x;
    last.y = commitPoint.y;
    }
  }

  if (rawPlan.screen === "shop" && actions.some((action) => action.type === "click")) {
    if (actions.some((action) => action.type !== "click")) {
      throw new Error("A shop input plan may contain only semantic shop clicks");
    }
    const topOfferClicks = actions.filter((action) => /^shop_offer_(?:left|center|right)(?:_use)?$/.test(action.target ?? ""));
    if (
      decision.shopOfferPositions.length === 2 &&
      topOfferClicks.some((action) => /^shop_offer_center(?:_use)?$/.test(action.target ?? ""))
    ) {
      throw new Error("A two-offer shop layout must use shop_offer_left or shop_offer_right, never center");
    }
    if (topOfferClicks.length > 1) {
      throw new Error("A shop batch may buy at most one top-row offer because the remaining offers re-center");
    }
    const layoutChangingTargets = new Set([
      "shop_pack_left",
      "shop_pack_center",
      "shop_pack_right",
      "shop_reroll",
      "shop_next_round",
    ]);
    const firstLayoutChange = actions.findIndex((action) => layoutChangingTargets.has(action.target));
    if (firstLayoutChange >= 0 && firstLayoutChange !== actions.length - 1) {
      throw new Error("A shop pack, reroll, or Next Round click must be the final action because it changes the layout");
    }
  }

  if (rawPlan.screen === "pack" && actions.some((action) => action.type === "click")) {
    const clicks = actions.filter((action) => action.type === "click");
    const choices = clicks.filter((action) => /^pack_choice_/.test(action.target ?? ""));
    const cardClicks = clicks.filter((action) => /^pack_card_/.test(action.target ?? ""));
    const uses = clicks.filter((action) => /^pack_use_/.test(action.target ?? ""));
    const skips = clicks.filter((action) => action.target === "pack_skip");
    if (choices.length) {
      throw new Error("Do not click a pack offer card; use pack_use_N_of_C so the controller reveals and clicks Use/Take");
    }
    if (uses.length > 1) throw new Error("A pack plan may click Use at most once");
    if (skips.length && clicks.length !== 1) throw new Error("pack_skip must be the only click in a pack plan");
    if (uses.length && clicks.at(-1) !== uses[0]) throw new Error("pack_use_N_of_C must be the final click in a pack plan");
    const hasCardSelection =
      cardClicks.length > 0 || decision.selectedBefore.length > 0 || decision.selectedAfter.length > 0;
    if (hasCardSelection) {
      if (decision.visibleCardCount < 1 || decision.handCapacity !== decision.visibleCardCount) {
        throw new Error("A pack target plan must report the complete visible playing-card row");
      }
      if (decision.visibleCards.length !== decision.visibleCardCount || decision.visibleCards.some((card) => card.includes("?"))) {
        throw new Error("A pack target plan must list every readable visible playing card");
      }
      if (decision.selectedBefore.length > 5 || decision.selectedAfter.length > 5) {
        throw new Error("A pack effect cannot target more than 5 playing cards");
      }
      const before = new Set(decision.selectedBefore);
      const after = new Set(decision.selectedAfter);
      const expected = new Set([...before, ...after].filter((slot) => before.has(slot) !== after.has(slot)));
      const providedSlots = cardClicks.map((action) => {
        const match = /^pack_card_(\d{1,2})_of_(\d{1,2})$/.exec(action.target);
        if (Number(match?.[2]) !== decision.visibleCardCount) {
          throw new Error("Every pack_card target count must match decision.visibleCardCount");
        }
        return `card_${Number(match[1])}`;
      });
      if (new Set(providedSlots).size !== providedSlots.length) {
        throw new Error("A pack plan clicks the same playing-card slot more than once");
      }
      const missing = [...expected].filter((slot) => !providedSlots.includes(slot));
      const extra = providedSlots.filter((slot) => !expected.has(slot));
      if (missing.length || extra.length) {
        throw new Error(
          `Pack playing-card toggles must match selectedBefore/selectedAfter` +
            `${missing.length ? `; missing ${missing.join(", ")}` : ""}` +
            `${extra.length ? `; extra ${extra.join(", ")}` : ""}`,
        );
      }
    }
  }

  return {
    observation: rawPlan.observation,
    strategy: rawPlan.strategy,
    memory: rawPlan.memory,
    screen: rawPlan.screen,
    state,
    decision,
    confidence: rawPlan.confidence,
    finished: rawPlan.finished,
    needsDetail: rawPlan.needsDetail,
    actions,
  };
}

export async function interruptibleSleep(ms, bridge, signal) {
  let remaining = ms;
  while (remaining > 0) {
    if (signal?.aborted) throw new Error("Stopped by Ctrl+C");
    const check = await bridge.stopPressed();
    if (check.pressed) throw new Error("Emergency stop: F8 is pressed");
    const chunk = Math.min(remaining, 200);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

export async function waitForInputFocus({
  bridge,
  signal,
  retryMs = 1_000,
  onWaiting = () => {},
  onRestored = () => {},
}) {
  if (!Number.isFinite(retryMs) || retryMs < 0) throw new Error("retryMs must be a non-negative number");
  let attempts = 0;
  let waited = false;
  while (true) {
    if (signal?.aborted) throw new Error("Stopped by Ctrl+C");
    const stop = await bridge.stopPressed();
    if (stop.pressed) throw new Error("Emergency stop: F8 is pressed");
    const focus = await bridge.focus();
    attempts += 1;
    if (focus.focused) {
      if (waited) onRestored({ attempts });
      return { focused: true, attempts, waited };
    }
    if (!waited) {
      waited = true;
      onWaiting({ attempts });
    }
    await interruptibleSleep(retryMs, bridge, signal);
  }
}

async function executeVerifiedCardClick(
  action,
  {
    bridge,
    signal,
    cardClickDelayMs,
    cardClickRetries,
    cardAckThreshold,
    cardAckSettleMs,
    cardHoverSettleMs,
    onVerification,
    verificationKind = "card_toggle",
  },
) {
  await bridge.move(action.x, action.y);
  if (cardHoverSettleMs > 0) await interruptibleSleep(cardHoverSettleMs, bridge, signal);
  const before = await bridge.capture({ includeImage: false });
  const attempts = 1;
  let observations = 0;
  let difference = 0;
  let acknowledged = false;
  await bridge.click(action.x, action.y, action.button, 1);
  if (cardClickDelayMs > 0) await interruptibleSleep(cardClickDelayMs, bridge, signal);
  for (let observation = 0; observation <= cardClickRetries; observation++) {
    if (observation > 0 && cardAckSettleMs > 0) {
      await interruptibleSleep(cardAckSettleMs, bridge, signal);
    }
    const after = await bridge.capture({ includeImage: false });
    observations += 1;
    if (!compatibleCaptureSignatures(before, after)) continue;
    const observedDifference = signatureRegionDifference(
      before.signature,
      after.signature,
      action.x,
      action.y,
      2,
      3,
      after.signatureCellBytes ?? before.signatureCellBytes ?? 2,
    );
    difference = Math.max(difference, observedDifference);
    if (difference >= cardAckThreshold) {
      acknowledged = true;
      break;
    }
  }
  onVerification({ kind: verificationKind, action, acknowledged, attempts, observations, difference });
  return { acknowledged, attempts, observations, difference };
}

async function executeVerifiedPackTransition(
  action,
  {
    bridge,
    signal,
    cardClickDelayMs,
    cardClickRetries,
    cardAckThreshold,
    cardAckSettleMs,
    cardHoverSettleMs,
    onVerification,
  },
) {
  const point = canonicalPackTargetPoint(action.target);
  if (!point || !PACK_ACTION_KINDS.has(point.kind)) {
    throw new Error(`Unknown semantic pack transition target: ${action.target}`);
  }
  if (point.kind === "use") {
    const hover = canonicalPackTargetPoint(`pack_choice_${point.slot}_of_${point.count}`);
    await bridge.move(hover.x, hover.y);
    await interruptibleSleep(Math.max(300, cardHoverSettleMs), bridge, signal);
  }
  await bridge.move(point.x, point.y);
  await interruptibleSleep(Math.max(200, cardHoverSettleMs), bridge, signal);
  const before = await bridge.capture({ includeImage: false });
  let observations = 0;
  let difference = 0;
  let acknowledged = false;
  await bridge.click(point.x, point.y, "left", 1);
  if (cardClickDelayMs > 0) await interruptibleSleep(cardClickDelayMs, bridge, signal);
  for (let observation = 0; observation <= cardClickRetries; observation++) {
    if (observation > 0 && cardAckSettleMs > 0) {
      await interruptibleSleep(cardAckSettleMs, bridge, signal);
    }
    const after = await bridge.capture({ includeImage: false });
    observations += 1;
    if (!compatibleCaptureSignatures(before, after)) continue;
    const observedDifference = signatureRegionDifference(
      before.signature,
      after.signature,
      0.57,
      0.62,
      13,
      10,
      after.signatureCellBytes ?? before.signatureCellBytes ?? 2,
    );
    difference = Math.max(difference, observedDifference);
    if (difference >= Math.max(PACK_TRANSITION_ACK_THRESHOLD, cardAckThreshold)) {
      acknowledged = true;
      break;
    }
  }
  onVerification({
    kind: "pack_action",
    action,
    point,
    acknowledged,
    attempts: 1,
    observations,
    difference,
    transition: true,
  });
  return { acknowledged, attempts: 1, observations, difference };
}

async function executeVerifiedHandCommit(
  action,
  {
    bridge,
    signal,
    cardHoverSettleMs,
    commitAckSettleMs,
    commitClickRetries,
    commitAckThreshold,
    onVerification,
  },
) {
  await bridge.move(action.x, action.y);
  if (cardHoverSettleMs > 0) await interruptibleSleep(cardHoverSettleMs, bridge, signal);
  let before = await bridge.capture({ includeImage: false });
  let attempts = 0;
  let difference = 0;
  let acknowledged = false;
  while (attempts <= commitClickRetries) {
    attempts += 1;
    await bridge.click(action.x, action.y, action.button, 1);
    if (commitAckSettleMs > 0) await interruptibleSleep(commitAckSettleMs, bridge, signal);
    const after = await bridge.capture({ includeImage: false });
    difference = signatureRegionDifference(
      before.signature,
      after.signature,
      0.52,
      0.68,
      11,
      5,
      after.signatureCellBytes ?? before.signatureCellBytes ?? 2,
    );
    if (difference >= commitAckThreshold) {
      acknowledged = true;
      break;
    }
    before = after;
  }
  onVerification({ kind: "hand_commit", action, acknowledged, attempts, difference });
  return { acknowledged, attempts, difference };
}

async function executeVerifiedShopPurchase(
  action,
  {
    bridge,
    signal,
    shopHoverSettleMs,
    shopPurchaseButtonSettleMs,
    shopPurchaseBaselineMs,
    shopPurchaseSettleMs,
    shopPurchaseConfirmMs,
    shopPurchaseRetries,
    shopPurchaseAckThreshold,
    shopPurchaseStabilityThreshold,
    shopPurchaseRetryUnchangedThreshold,
    shopAspectRatio,
    onVerification,
  },
) {
  const point = canonicalShopTargetPoint(action.target, shopAspectRatio);
  if (!point?.purchase) throw new Error(`Unknown semantic shop purchase target: ${action.target}`);
  const allowedRetries = point.retryable ? shopPurchaseRetries : 0;
  let initialBaseline = null;
  let attempts = 0;
  let difference = 0;
  let afterDifference = 0;
  let confirmedDifference = 0;
  let retryBaselineDifference = 0;
  let retryAborted = false;
  let postStabilityDifference = 1;
  let preStabilityDifference = 0;
  let baselineChecks = 0;
  let baselineUnstable = false;
  let signatureInvalid = false;
  let acknowledged = false;
  while (attempts <= allowedRetries) {
    await bridge.move(point.hoverX, point.hoverY);
    if (shopHoverSettleMs > 0) await interruptibleSleep(shopHoverSettleMs, bridge, signal);
    await bridge.move(point.x, point.y);
    if (shopPurchaseButtonSettleMs > 0) await interruptibleSleep(shopPurchaseButtonSettleMs, bridge, signal);
    let before = await bridge.capture({ includeImage: false });
    if (!validCaptureSignature(before)) {
      signatureInvalid = true;
      break;
    }
    if (shopPurchaseBaselineMs > 0) {
      let stableBaseline = false;
      for (let check = 0; check < 2; check++) {
        await interruptibleSleep(shopPurchaseBaselineMs, bridge, signal);
        const candidate = await bridge.capture({ includeImage: false });
        baselineChecks += 1;
        if (!compatibleCaptureSignatures(before, candidate)) {
          signatureInvalid = true;
          break;
        }
        preStabilityDifference = signatureRegionDifference(
          before.signature,
          candidate.signature,
          point.x,
          point.y,
          0,
          1,
          candidate.signatureCellBytes ?? before.signatureCellBytes ?? 2,
        );
        before = candidate;
        if (preStabilityDifference <= shopPurchaseStabilityThreshold) {
          stableBaseline = true;
          break;
        }
      }
      if (signatureInvalid) break;
      if (!stableBaseline) {
        baselineUnstable = true;
        break;
      }
    }
    if (!initialBaseline) {
      initialBaseline = before;
    } else {
      retryBaselineDifference = signatureRegionDifference(
        initialBaseline.signature,
        before.signature,
        point.hoverX,
        point.hoverY,
        point.regionColumns,
        point.regionRows,
        before.signatureCellBytes ?? initialBaseline.signatureCellBytes ?? 2,
      );
      if (retryBaselineDifference >= shopPurchaseRetryUnchangedThreshold) {
        retryAborted = true;
        break;
      }
    }
    attempts += 1;
    await bridge.click(point.x, point.y, "left", 1);
    if (shopPurchaseSettleMs > 0) await interruptibleSleep(shopPurchaseSettleMs, bridge, signal);
    const after = await bridge.capture({ includeImage: false });
    if (!compatibleCaptureSignatures(before, after)) {
      signatureInvalid = true;
      break;
    }
    afterDifference = signatureRegionDifference(
      before.signature,
      after.signature,
      point.hoverX,
      point.hoverY,
      point.regionColumns,
      point.regionRows,
      after.signatureCellBytes ?? before.signatureCellBytes ?? 2,
    );
    if (shopPurchaseConfirmMs > 0) await interruptibleSleep(shopPurchaseConfirmMs, bridge, signal);
    const confirmed = await bridge.capture({ includeImage: false });
    if (!compatibleCaptureSignatures(before, after, confirmed)) {
      signatureInvalid = true;
      break;
    }
    confirmedDifference = signatureRegionDifference(
      before.signature,
      confirmed.signature,
      point.hoverX,
      point.hoverY,
      point.regionColumns,
      point.regionRows,
      confirmed.signatureCellBytes ?? before.signatureCellBytes ?? 2,
    );
    postStabilityDifference = signatureRegionDifference(
      after.signature,
      confirmed.signature,
      point.hoverX,
      point.hoverY,
      point.regionColumns,
      point.regionRows,
      confirmed.signatureCellBytes ?? after.signatureCellBytes ?? 2,
    );
    difference = Math.min(afterDifference, confirmedDifference);
    const stableConfirmation = postStabilityDifference <= shopPurchaseStabilityThreshold;
    if (difference >= shopPurchaseAckThreshold && (stableConfirmation || point.transition)) {
      acknowledged = true;
      break;
    }
  }
  onVerification({
    kind: "shop_purchase",
    action,
    point,
    acknowledged,
    attempts,
    difference,
    afterDifference,
    confirmedDifference,
    postStabilityDifference,
    preStabilityDifference,
    baselineChecks,
    baselineUnstable,
    retryBaselineDifference,
    retryAborted,
    signatureInvalid,
  });
  return { acknowledged, attempts, difference };
}

export async function executeActions(
  actions,
  {
    bridge,
    delayMs,
    dryRun,
    signal,
    screen = "unknown",
    cardClickDelayMs = 450,
    cardClickRetries = 1,
    cardAckThreshold = 0.018,
    cardAckSettleMs = 250,
    cardHoverSettleMs = 180,
    commitAckSettleMs = 700,
    commitClickRetries = 1,
    commitAckThreshold = 0.015,
    shopHoverSettleMs = 300,
    shopPurchaseButtonSettleMs = 250,
    shopPurchaseBaselineMs = 0,
    shopPurchaseSettleMs = 900,
    shopPurchaseConfirmMs = 250,
    shopPurchaseRetries = 1,
    shopPurchaseAckThreshold = 0.055,
    shopPurchaseStabilityThreshold = 0.04,
    shopPurchaseRetryUnchangedThreshold = 0.02,
    shopAspectRatio = 1.82,
    handAspectRatio = 1.82,
    handVisibleCardCount = null,
    handCapacity = null,
    onAction = () => {},
    onVerification = () => {},
  },
) {
  if (!dryRun && actions.some((action) => action.type === "click" || action.type === "key")) {
    let focus = await bridge.focus();
    if (!focus.focused) {
      await interruptibleSleep(200, bridge, signal);
      focus = await bridge.focus();
    }
    if (!focus.focused) {
      return { stopped: false, interrupted: true, reason: "Balatro could not be focused before input" };
    }
    await interruptibleSleep(100, bridge, signal);
  }
  for (const [index, plannedAction] of actions.entries()) {
    if (signal?.aborted) throw new Error("Stopped by Ctrl+C");
    const stop = await bridge.stopPressed();
    if (stop.pressed) throw new Error("Emergency stop: F8 is pressed");
    const shouldRemapHandCard =
      screen === "hand" &&
      plannedAction.type === "click" &&
      /^card_(?:[1-9]|1[0-9]|20)$/.test(plannedAction.target ?? "") &&
      Number.isInteger(handVisibleCardCount) &&
      Number.isInteger(handCapacity);
    const livePackPoint =
      screen === "pack" && plannedAction.type === "click"
        ? canonicalPackTargetPoint(plannedAction.target, handAspectRatio)
        : null;
    const action = shouldRemapHandCard
      ? {
          ...plannedAction,
          ...canonicalHandCardPoint(plannedAction.target, handVisibleCardCount, handCapacity, handAspectRatio),
        }
      : livePackPoint
        ? { ...plannedAction, x: livePackPoint.x, y: livePackPoint.y }
        : plannedAction;
    onAction(action);
    if (dryRun) continue;

    const verifiedCardToggle = screen === "hand" && action.type === "click" && /^card_(?:[1-9]|1[0-9]|20)$/.test(action.target ?? "");
    if (verifiedCardToggle) {
      const verification = await executeVerifiedCardClick(action, {
        bridge,
        signal,
        cardClickDelayMs,
        cardClickRetries,
        cardAckThreshold,
        cardAckSettleMs,
        cardHoverSettleMs,
        onVerification,
      });
      if (!verification.acknowledged) {
        return {
          stopped: false,
          interrupted: true,
          reason: "A card click was not visually confirmed; skipped the remaining toggles and commit",
        };
      }
      continue;
    } else if (
      screen === "pack" &&
      action.type === "click" &&
      PACK_ACTION_KINDS.has(canonicalPackTargetPoint(action.target)?.kind)
    ) {
      const verification = await executeVerifiedPackTransition(action, {
        bridge,
        signal,
        cardClickDelayMs,
        cardClickRetries,
        cardAckThreshold,
        cardAckSettleMs,
        cardHoverSettleMs,
        onVerification,
      });
      if (!verification.acknowledged) {
        return {
          stopped: false,
          interrupted: true,
          reason: "Pack Use/Take/Skip did not produce a layout transition; taking a fresh screenshot",
        };
      }
      continue;
    } else if (screen === "pack" && action.type === "click" && canonicalPackTargetPoint(action.target)) {
      const verification = await executeVerifiedCardClick(action, {
        bridge,
        signal,
        cardClickDelayMs,
        cardClickRetries,
        cardAckThreshold,
        cardAckSettleMs,
        cardHoverSettleMs,
        onVerification,
        verificationKind: "pack_action",
      });
      if (!verification.acknowledged) {
        return {
          stopped: false,
          interrupted: true,
          reason: "A semantic pack click was not visually confirmed; taking a fresh screenshot",
        };
      }
      continue;
    } else if (
      screen === "hand" &&
      action.type === "click" &&
      HAND_COMMIT_TARGETS.has(action.target)
    ) {
      const verification = await executeVerifiedHandCommit(action, {
        bridge,
        signal,
        cardHoverSettleMs,
        commitAckSettleMs,
        commitClickRetries,
        commitAckThreshold,
        onVerification,
      });
      if (!verification.acknowledged) {
        return {
          stopped: false,
          interrupted: true,
          reason: "Play Hand/Discard click was not visually confirmed; preserving selection for a fresh plan",
        };
      }
      continue;
    } else if (
      screen === "shop" &&
      action.type === "click" &&
      canonicalShopTargetPoint(action.target)?.purchase
    ) {
      const verification = await executeVerifiedShopPurchase(action, {
        bridge,
        signal,
        shopHoverSettleMs,
        shopPurchaseButtonSettleMs,
        shopPurchaseBaselineMs,
        shopPurchaseSettleMs,
        shopPurchaseConfirmMs,
        shopPurchaseRetries,
        shopPurchaseAckThreshold,
        shopPurchaseStabilityThreshold,
        shopPurchaseRetryUnchangedThreshold,
        shopAspectRatio,
        onVerification,
      });
      if (!verification.acknowledged) {
        return {
          stopped: false,
          interrupted: true,
          reason: "Shop purchase was not visually confirmed; no follow-up action was sent",
        };
      }
      continue;
    } else if (action.type === "click") {
      await bridge.click(action.x, action.y, action.button, 1);
    } else if (action.type === "key") {
      await bridge.key(action.key);
    } else if (action.type === "wait") {
      await interruptibleSleep(action.ms, bridge, signal);
      continue;
    } else if (action.type === "stop") {
      return { stopped: true, reason: action.reason };
    }

    if (delayMs > 0) await interruptibleSleep(delayMs, bridge, signal);
  }
  return { stopped: false, interrupted: false };
}
