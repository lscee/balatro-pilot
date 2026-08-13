import fs from "node:fs";
import path from "node:path";

import { apiKeyEnvironment } from "./model-routing.mjs";

function actionSchema() {
  const nullableNumber = { type: ["number", "null"], minimum: 0, maximum: 1 };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      observation: { type: "string", maxLength: 600 },
      strategy: { type: "string", maxLength: 500 },
      memory: { type: "string", maxLength: 350 },
      screen: {
        type: "string",
        enum: [
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
        ],
      },
      state: {
        type: "object",
        additionalProperties: false,
        properties: {
          ante: { type: ["integer", "null"], minimum: 0, maximum: 99 },
          money: { type: ["number", "null"], minimum: 0 },
          score: { type: ["number", "null"], minimum: 0 },
          target: { type: ["number", "null"], minimum: 0 },
          handsLeft: { type: ["integer", "null"], minimum: 0, maximum: 99 },
          discardsLeft: { type: ["integer", "null"], minimum: 0, maximum: 99 },
          deck: { type: "string", maxLength: 80 },
          deckRemaining: { type: ["integer", "null"], minimum: 0, maximum: 999 },
          deckTotal: { type: ["integer", "null"], minimum: 0, maximum: 999 },
          deckSnapshot: { type: "string", maxLength: 240 },
          stake: { type: "string", maxLength: 80 },
          blind: { type: "string", maxLength: 120 },
          build: { type: "string", maxLength: 160 },
          outcome: { type: "string", enum: ["ongoing", "won", "lost", "unknown"] },
          features: {
            type: "array",
            maxItems: 10,
            items: { type: "string", maxLength: 80 },
          },
        },
        required: [
          "ante",
          "money",
          "score",
          "target",
          "handsLeft",
          "discardsLeft",
          "deck",
          "deckRemaining",
          "deckTotal",
          "deckSnapshot",
          "stake",
          "blind",
          "build",
          "outcome",
          "features",
        ],
      },
      decision: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", maxLength: 120 },
          selectedBefore: {
            type: "array",
            maxItems: 5,
            items: { type: "string", pattern: "^card_(?:[1-9]|1[0-9]|20)$" },
          },
          selectedAfter: {
            type: "array",
            maxItems: 5,
            items: { type: "string", pattern: "^card_(?:[1-9]|1[0-9]|20)$" },
          },
          visibleCardCount: { type: "integer", minimum: 0, maximum: 20 },
          handCapacity: { type: "integer", minimum: 0, maximum: 20 },
          visibleCards: {
            type: "array",
            maxItems: 20,
            items: { type: "string", pattern: "^(?:[2-9TJQKA][SHDC?]|\\?\\?)$" },
          },
          targetHand: {
            type: "string",
            enum: [
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
            ],
          },
          shopOfferPositions: {
            type: "array",
            maxItems: 2,
            items: { type: "string", enum: ["left", "center", "right"] },
          },
          commit: { type: "string", enum: ["play_hand", "discard", "none"] },
        },
        required: [
          "key",
          "selectedBefore",
          "selectedAfter",
          "visibleCardCount",
          "handCapacity",
          "visibleCards",
          "targetHand",
          "shopOfferPositions",
          "commit",
        ],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      finished: { type: "boolean" },
      needsDetail: { type: "boolean" },
      actions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["click", "key", "wait", "stop"] },
            x: nullableNumber,
            y: nullableNumber,
            button: { type: ["string", "null"], enum: ["left", "right", null] },
            key: {
              type: ["string", "null"],
              enum: ["escape", "enter", "space", "tab", "left", "right", "up", "down", null],
            },
            ms: { type: ["integer", "null"], minimum: 0, maximum: 5_000 },
            target: { type: ["string", "null"], maxLength: 40 },
            reason: { type: "string", maxLength: 120 },
          },
          required: ["type", "x", "y", "button", "key", "ms", "target", "reason"],
        },
      },
    },
    required: [
      "observation",
      "strategy",
      "memory",
      "screen",
      "state",
      "decision",
      "confidence",
      "finished",
      "needsDetail",
      "actions",
    ],
  };
}

function balatrobotActionSchema() {
  const nullableIndex = { type: ["integer", "null"], minimum: 0 };
  const indices = { type: "array", maxItems: 60, items: { type: "integer", minimum: 0 } };
  const runPlan = {
    type: "object",
    additionalProperties: false,
    properties: {
      metaAssessment: { type: "string", maxLength: 240 },
      buildGoal: { type: "string", maxLength: 180 },
      synergies: { type: "string", maxLength: 240 },
      economyPolicy: { type: "string", maxLength: 240 },
      shopPriorities: { type: "string", maxLength: 240 },
      pivotPolicy: { type: "string", maxLength: 240 },
      handPolicy: { type: "string", maxLength: 240 },
      nextMilestone: { type: "string", maxLength: 180 },
      revisionReason: { type: "string", maxLength: 180 },
    },
    required: [
      "metaAssessment",
      "buildGoal",
      "synergies",
      "economyPolicy",
      "shopPriorities",
      "pivotPolicy",
      "handPolicy",
      "nextMilestone",
      "revisionReason",
    ],
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      observation: { type: "string", maxLength: 600 },
      strategy: { type: "string", maxLength: 500 },
      memory: { type: "string", maxLength: 350 },
      runPlan,
      confidence: { type: "number", minimum: 0, maximum: 1 },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            method: {
              type: "string",
              enum: ["select", "skip", "play", "discard", "buy", "sell", "reroll", "next_round", "pack", "use", "rearrange"],
            },
            cards: indices,
            card: nullableIndex,
            voucher: nullableIndex,
            pack: nullableIndex,
            joker: nullableIndex,
            consumable: nullableIndex,
            targets: indices,
            skip: { type: ["boolean", "null"] },
            hand: indices,
            jokers: indices,
            consumables: indices,
            reason: { type: "string", maxLength: 160 },
          },
          required: [
            "method",
            "cards",
            "card",
            "voucher",
            "pack",
            "joker",
            "consumable",
            "targets",
            "skip",
            "hand",
            "jokers",
            "consumables",
            "reason",
          ],
        },
      },
    },
    required: ["observation", "strategy", "memory", "runPlan", "confidence", "actions"],
  };
}

export function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
  return {
    apiCalls: 1,
    inputTokens,
    cachedInputTokens:
      Number(
        usage.input_tokens_details?.cached_tokens ??
          usage.prompt_tokens_details?.cached_tokens ??
          usage.prompt_cache_hit_tokens ??
          usage.cached_tokens,
      ) || 0,
    cacheMissTokens: Number(usage.prompt_cache_miss_tokens) || 0,
    cacheWriteTokens:
      Number(usage.input_tokens_details?.cache_write_tokens ?? usage.prompt_tokens_details?.cache_write_tokens) || 0,
    outputTokens,
    reasoningTokens:
      Number(
        usage.output_tokens_details?.reasoning_tokens ??
          usage.completion_tokens_details?.reasoning_tokens ??
          usage.reasoning_tokens,
      ) || 0,
    totalTokens: Number(usage.total_tokens) || inputTokens + outputTokens,
  };
}

export function mergeUsage(...items) {
  const result = {
    apiCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  for (const item of items) {
    for (const key of Object.keys(result)) result[key] += Number(item?.[key]) || 0;
  }
  return result;
}

export function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const parts = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  if (!parts.length) {
    const refusal = (response?.output ?? [])
      .flatMap((item) => item?.content ?? [])
      .find((content) => content?.type === "refusal");
    if (refusal) throw new Error(`Planner refused: ${refusal.refusal ?? "unknown reason"}`);
    throw new Error("Planner response did not contain output text");
  }
  return parts.join("\n");
}

export function extractChatOutputText(response) {
  const choice = response?.choices?.[0];
  const message = choice?.message;
  const candidates = [message?.content, message?.output_text, choice?.text, response?.output_text];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (!Array.isArray(candidate)) continue;
    const text = candidate
      .flatMap((item) => {
        if (typeof item === "string") return [item];
        return [item?.text, item?.content, item?.output_text, item?.text?.value];
      })
      .filter((item) => typeof item === "string" && item.trim())
      .join("\n");
    if (text.trim()) return text;
  }
  throw new Error("Planner response did not contain chat completion text");
}

function chatResponseDiagnostics(response) {
  const choice = response?.choices?.[0];
  const message = choice?.message;
  const content = message?.content;
  return {
    responseId: response?.id ?? null,
    model: response?.model ?? null,
    choiceCount: Array.isArray(response?.choices) ? response.choices.length : 0,
    finishReason: choice?.finish_reason ?? null,
    messageKeys: message && typeof message === "object" ? Object.keys(message).sort() : [],
    contentType: Array.isArray(content) ? "array" : content === null ? "null" : typeof content,
    contentLength: typeof content === "string" ? content.length : Array.isArray(content) ? content.length : 0,
    reasoningLength: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0,
    refusal: typeof message?.refusal === "string" ? message.refusal.slice(0, 200) : null,
  };
}

function invalidChatPlanError(body, message, cause, { emptyContent = false } = {}) {
  const diagnostics = chatResponseDiagnostics(body);
  const reasoningContent = body?.choices?.[0]?.message?.reasoning_content;
  const error = new Error(`${message} (finish_reason=${diagnostics.finishReason ?? "unknown"})`, { cause });
  error.code = "PLAN_JSON_INVALID";
  error.usage = normalizeUsage(body?.usage);
  error.responseId = body?.id ?? null;
  error.finishReason = diagnostics.finishReason;
  error.emptyContent = emptyContent;
  error.diagnostics = diagnostics;
  error.reasoningContent = typeof reasoningContent === "string" ? reasoningContent : "";
  return error;
}

function parseChatPlanResponse(body, provider, { semantic = false } = {}) {
  const context = semantic ? "BalatroBot " : "";
  let text;
  try {
    text = extractChatOutputText(body);
  } catch (cause) {
    throw invalidChatPlanError(
      body,
      `${chatProviderLabel(provider)} returned no usable ${context}plan text`,
      cause,
      { emptyContent: true },
    );
  }
  try {
    const parsed = parsePlanJson(text);
    const normalized = semantic
      ? normalizeBalatrobotPlanShape(parsed.value)
      : { plan: parsed.value, repaired: false };
    return {
      plan: normalized.plan,
      usage: normalizeUsage(body.usage),
      responseId: body.id ?? null,
      jsonRepaired: parsed.repaired,
      shapeRepaired: normalized.repaired,
    };
  } catch (cause) {
    throw invalidChatPlanError(
      body,
      `${chatProviderLabel(provider)} returned incomplete or invalid ${context}plan JSON`,
      cause,
    );
  }
}

export function parsePlanJson(text) {
  const source = String(text ?? "").trim();
  try {
    return { value: JSON.parse(source), repaired: false };
  } catch (directError) {
    let repaired = source
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const firstBrace = repaired.indexOf("{");
    const lastBrace = repaired.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) repaired = repaired.slice(firstBrace, lastBrace + 1);
    repaired = repaired.replace(/,\s*([}\]])/g, "$1");
    try {
      return { value: JSON.parse(repaired), repaired: repaired !== source };
    } catch (cause) {
      const error = new Error("Planner output is not recoverable JSON", { cause: cause ?? directError });
      error.code = "PLAN_JSON_INVALID";
      throw error;
    }
  }
}

export function normalizeBalatrobotPlanShape(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { plan, repaired: false };
  if (!plan.actions || typeof plan.actions !== "object" || Array.isArray(plan.actions)) {
    return { plan, repaired: false };
  }
  return { plan: { ...plan, actions: [plan.actions] }, repaired: true };
}

export { apiKeyEnvironment } from "./model-routing.mjs";

function isChatCompletionProvider(provider) {
  return provider === "kimi-chat" || provider === "kimi-platform" || provider === "deepseek-chat" || provider === "ollama-chat";
}

function isKimiProvider(provider) {
  return provider === "kimi-chat" || provider === "kimi-platform";
}

function chatCompletionBudget(provider, maxOutputTokens) {
  return isKimiProvider(provider)
    ? { max_completion_tokens: maxOutputTokens }
    : { max_tokens: maxOutputTokens };
}

function promptCachePart(value, fallback) {
  const compact = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return compact || fallback;
}

const THINKING_EFFORTS = new Set(["medium", "high", "xhigh", "max"]);
const MAX_REASONING_EFFORTS = new Set(["xhigh", "max"]);

export function kimiPromptCacheKey(gameState, config = {}) {
  const role = promptCachePart(config.plannerRole, "exact");
  const seed = promptCachePart(gameState?.seed, "unseeded");
  return `balatro-pilot:rules-v2:${role}:${seed}`;
}

function chatReasoningParameters(config, effort = config.reasoningEffort) {
  if (config.provider === "ollama-chat") return { reasoning_effort: "none" };
  if (config.provider === "kimi-platform") {
    const thinkingEnabled = THINKING_EFFORTS.has(effort);
    return { thinking: { type: thinkingEnabled ? "enabled" : "disabled" } };
  }
  if (config.provider === "deepseek-chat") {
    const thinkingEnabled = THINKING_EFFORTS.has(effort);
    if (!thinkingEnabled) return { thinking: { type: "disabled" } };
    return {
      thinking: { type: "enabled" },
      reasoning_effort: MAX_REASONING_EFFORTS.has(effort) ? "max" : "high",
    };
  }
  return { reasoning_effort: effort };
}

function chatProviderLabel(provider) {
  if (provider === "deepseek-chat") return "DeepSeek";
  if (provider === "ollama-chat") return "Ollama";
  return "Kimi";
}

function kimiJsonInstruction() {
  return [
    "Return only one JSON object with these exact fields:",
    "observation:string (max 240 chars), strategy:string (max 200 chars), memory:string (max 240 chars), confidence:number 0..1,",
    "screen: one of main_menu|run_setup|blind_select|hand|deck_view|shop|pack|round_result|game_over|overlay|unknown,",
    "state:object with ante, money, score, target, handsLeft, discardsLeft, deck, deckRemaining, deckTotal, deckSnapshot, stake, blind, build, outcome, features. deck is the deck name; read the bottom-right R/T counter into deckRemaining/deckTotal; deckSnapshot is a compact rank/suit summary only from deck_view, otherwise empty. Use null for unreadable numbers and empty strings/arrays for text. outcome is ongoing|won|lost|unknown. Keep features to at most 6 terse tags.",
    "decision:object with key, selectedBefore, selectedAfter, visibleCardCount, handCapacity, visibleCards, targetHand, packChoice, shopOfferPositions, commit. On a ready hand read N/C, list all N cards left-to-right as compact rank+suit codes such as AS,TC,7D, set targetHand to the hand being made/chased, and number slots card_1..card_20. selectedBefore lists raised cards now, selectedAfter the desired final 1..5 selection, packChoice is none, shopOfferPositions is empty, and commit is play_hand or discard. On shop, report the physical top-row offer layout exactly as [center] when one offer is centered, [left,right] when two offers are visible, or [] when none/unreadable. On pack, packChoice is always none; if playing-card targets are visible, list every card left-to-right, set visibleCardCount=handCapacity to that row count, selectedBefore to every currently raised playing card, and selectedAfter to the exact desired target selection. On other screens use counts 0, empty arrays, targetHand none, packChoice none, shopOfferPositions [], and commit none.",
    "finished:boolean, needsDetail:boolean, actions:array.",
    "actions must contain one or more objects, with no controller-imposed count limit. Every action must contain type, x, y, button, key, ms, target, reason.",
    "type is click|key|wait|stop; use null for fields that do not apply. For hand card clicks target is card_N and emit each required toggle exactly once; the controller derives trustworthy hand coordinates from target and N/C, so approximate x/y are ignored. To inspect the bottom-right remaining deck use one click with target open_deck; on deck_view read state.deckSnapshot and close with Escape. Commit target is play_hand or discard and must equal decision.commit. On shop, emit an ordered affordable purchase batch and use only shop_offer_left|shop_offer_center|shop_offer_right|shop_offer_left_use|shop_offer_center_use|shop_offer_right_use|shop_voucher|shop_pack_left|shop_pack_center|shop_pack_right|shop_reroll|shop_next_round according to physical position. *_use is legal only when the literal visible button says Buy & Use; never infer it from full slots. A targeted Tarot such as The Hierophant cannot use an imagined Buy & Use control when only Buy is visible: skip it, legally free a slot, or use shop_next_round. x/y/button may be null because the controller hovers, clicks, and verifies each purchase locally. Include at most one shop_offer target per batch because the remaining row recenters; shop_offer_center means one visibly centered top-row offer, not the gap between two. Booster-pack positions are relative inside the bottom-right pack box: if exactly one booster pack is visible, always use shop_pack_center even though the whole box is on the right side of the shop; use shop_pack_left or shop_pack_right only when two packs are simultaneously visible. Pack, reroll, or Next Round must be final. On pack, never click an offered card and never emit pack_choice. Use only pack_card_N_of_C for playing-card target toggles, pack_use_N_of_C for the offered card's Use/Take button, or pack_skip. N is the 1-based visible slot and C is the number of cards in that row. The controller automatically hovers the offered card to reveal Use/Take before clicking pack_use. Select any required playing-card targets first, then click pack_use as the final click. Append shop_next_round only when no pack is opened and no top-row survivor needs a fresh evaluation. Keep every reason under 40 characters.",
  ].join(" ");
}

function kimiBalatrobotJsonInstruction() {
  return [
    "Return only one JSON object with exactly observation, strategy, memory, runPlan, confidence, actions.",
    "Hard brevity limits: observation and strategy each under 160 Chinese characters; memory under 120; every runPlan value under 90.",
    "When current_run_plan exists, preserve unchanged fields concisely, revise only fields contradicted by exact state, and use revisionReason only for the newest delta.",
    "observation, strategy, and memory are short strings; confidence is 0..1.",
    "Write observation, strategy, memory, every runPlan value, and action.reason in concise Simplified Chinese. memory is a compact viewer summary of runPlan. strategy explains how the one current action follows or safely revises that plan. Keep JSON keys, method names, card keys, and enum values unchanged.",
    "runPlan is the persistent plan for this one game and has exactly metaAssessment, buildGoal, synergies, economyPolicy, shopPriorities, pivotPolicy, handPolicy, nextMilestone, revisionReason. metaAssessment compares the exact route with strong 1.0.1o build packages without forcing a tier list. economyPolicy states a practical cash/interest reserve plus spend and reroll triggers. pivotPolicy compares keep, bridge, and pivot lines and names the concrete support, cash, slot, and timing conditions required to change routes. It must connect owned Jokers/consumables/deck changes, the repeatable poker hand being built, which shop effects or categories are highest priority, and how play/discard decisions support that build. Base it on exact current cards and offers; revise it when a stronger shop pivot appears, a purchase changes the build, or survival requires a temporary deviation.",
    "On SHOP, exact_state.shopReroll is a local score-pressure budget, not a fixed build prescription. Use its target, estimatedRoundCapacity, reserve, budget, and remainingDesiredRerolls to compare buying a visible upgrade, rerolling, or preserving cash. If shouldReroll is true, do not leave without either taking a useful visible resource or using an allowed reroll. Never require a fixed Chips/Mult/XMult composition or a named archetype when exact offers support a different route.",
    "Treat exact_state.highScoreTraining as an advisory local counterfactual profile. In survival stage, first maintain a reliable path through the next blind; in scaling stage, replace weak flat bridges with supported scaling, XMult, copy, retrigger, deck shaping, or hand-level engines. This collection-progression policy ends at the confirmed Ante 8 victory, so high-score ceiling is useful only when it improves that clear. A shop candidate counterfactual.engineDelta compares the build before and after that exact item. It is evidence, not a hard rule: use exact effects, Boss safety, price, slots, and current support to approve or reject it.",
    "Before naming a core build, read activeDeck, collectionKnowledge, and appearedThisRun inside build_planning_context. Treat the active deck effect as a run-wide rule: adapt hand targets, economy, slot usage, and shop priorities to exploit its upside and cover its downside. The save-backed activeUnlockTarget is the run objective, but a locked Joker condition is only an optional opportunity: pursue it only when the exact current state makes it reachable at negligible survival cost, never invent a hidden condition, and never weaken a winning line merely to chase it. A locked Joker is impossible as a shop/build target. buildGoal and synergies may name only owned Jokers or cards that have actually appeared in this run. Unlocked-but-unseen Jokers may appear only as optional shop priorities or explicit pivot possibilities, never as if already owned or as the current core. Prefer the strongest supported route among cards that actually appeared; remain flexible when only weak bridges have appeared.",
    "IMPORTANT: actions MUST be a JSON array containing exactly one object, never a bare object. Example: actions:[{method:\"play\",cards:[0,1],card:null,voucher:null,pack:null,joker:null,consumable:null,targets:[],skip:null,hand:[],jokers:[],consumables:[],reason:\"play pair\"}].",
    "The action has exactly these fields: method, cards, card, voucher, pack, joker, consumable, targets, skip, hand, jokers, consumables, reason.",
    "method is select|skip|play|discard|buy|sell|reroll|next_round|pack|use|rearrange.",
    "On BLIND_SELECT, select means CHALLENGE and play the currently offered blind; skip means truly forfeit that blind, its cash, and its shop. Never output skip when strategy says normal challenge, play the current blind, or do not skip. Skip is exceptional: only a clearly named high-value tag in a mature scoring build may justify it; otherwise select.",
    "The local rules engine is the sole authority for poker classification, suit equivalence, consumable target counts, legal candidates, conservativeScore, and the whole-round survival budget. rulesApplied records mechanics such as Smeared/Four Fingers/Shortcut/Wild. Never reinterpret those mechanics from prose. For SELECTING_HAND, never claim a play clears when conservativeScore is below the remaining target; when currentLineCanClear is false and a discard candidate exists, preserve the draw instead of spending a hand. Do not burn weak hands merely to reach Acrobat unless conservative arithmetic proves the full route survives.",
    "All indices are zero-based. Every array field is [] when unused; every scalar index is null when unused; skip is null when unused.",
    "play/discard use cards. buy sets exactly one of card/voucher/pack. sell sets exactly one of joker/consumable.",
    "A sell is destructive: action.reason and strategy must explicitly name the exact current label/key at that zero-based joker or consumable index. Re-read the current indexed state after every buy/sell; never reuse an earlier index or claim to sell a different item.",
    "pack uses {card,targets} for a choice or skip:true to skip. use sets consumable and optional cards.",
    "rearrange sets exactly one full permutation in hand, jokers, or consumables. Methods without parameters leave every parameter empty/null.",
    "Never return coordinates, button names, click/key/wait actions, a params wrapper, extra keys, or more than one action.",
  ].join(" ");
}

function compactPlanningCards(area) {
  return (Array.isArray(area?.cards) ? area.cards : []).map((card) => ({
    key: String(card?.key ?? ""),
    set: String(card?.set ?? ""),
    label: String(card?.label ?? ""),
    effect: String(card?.effect ?? ""),
    buy: Number.isFinite(Number(card?.buy)) ? Number(card.buy) : null,
    sell: Number.isFinite(Number(card?.sell)) ? Number(card.sell) : null,
    edition: card?.edition ?? null,
    eternal: Boolean(card?.eternal),
    perishable: card?.perishable ?? null,
    rental: Boolean(card?.rental),
  }));
}

export function balatrobotBuildPlanningContext(gameState) {
  const ante = Number(gameState?.ante ?? gameState?.ante_num);
  const money = Number(gameState?.money);
  const jokerCount = Number(gameState?.jokers?.count);
  const jokerLimit = Number(gameState?.jokers?.limit);
  const phase = Number.isFinite(ante) ? (ante <= 2 ? "early" : ante <= 5 ? "mid" : "late") : "unknown";
  const finiteMoney = Number.isFinite(money) ? Math.max(0, money) : null;
  const defaultInterestBands = finiteMoney == null ? null : Math.min(5, Math.floor(finiteMoney / 5));
  const freeJokerSlots = Number.isFinite(jokerCount) && Number.isFinite(jokerLimit)
    ? Math.max(0, jokerLimit - jokerCount)
    : null;
  const collection = gameState?.collectionKnowledge && typeof gameState.collectionKnowledge === "object"
    ? gameState.collectionKnowledge
    : null;
  const appeared = gameState?.appearedThisRun && typeof gameState.appearedThisRun === "object"
    ? gameState.appearedThisRun
    : { jokers: [], consumables: [], vouchers: [] };
  const activeDeckCode = String(gameState?.deck ?? "").toUpperCase();
  const activeDeck = collection?.unlockedDecks?.find(
    (deck) => String(deck?.code ?? "").toUpperCase() === activeDeckCode,
  ) ?? null;
  const shopReroll = gameState?.shopReroll && typeof gameState.shopReroll === "object"
    ? gameState.shopReroll
    : null;
  return {
    installedVersion: "1.0.1o",
    phase,
    money: finiteMoney,
    defaultInterestBands,
    defaultInterestReserve: shopReroll?.reserve ?? 25,
    shopReroll,
    highScoreTraining: gameState?.highScoreTraining ?? null,
    freeJokerSlots,
    ownedJokers: compactPlanningCards(gameState?.jokers),
    offeredJokers: compactPlanningCards(gameState?.shop).filter((card) => /^JOKER$/i.test(card.set)),
    activeDeck: activeDeck
      ? { code: activeDeck.code, label: activeDeck.label, effect: activeDeck.effect }
      : { code: activeDeckCode, label: activeDeckCode, effect: "" },
    collectionKnowledge: collection
      ? {
          available: Boolean(collection.available),
          profile: collection.profile ?? null,
          signature: collection.signature ?? "",
          unlockedJokerCount: collection.unlockedJokerCount ?? 0,
          totalJokerCount: collection.totalJokerCount ?? 0,
          unlockedJokers: (collection.unlockedJokers ?? []).map((joker) => joker.label || joker.key),
          lockedJokers: (collection.lockedJokers ?? []).map((joker) => ({
            key: joker.key,
            label: joker.label || joker.key,
            unlockCondition: joker.unlockCondition ?? null,
          })),
          unlockedDecks: (collection.unlockedDecks ?? []).map((deck) => ({
            code: deck.code,
            label: deck.label,
            effect: deck.effect,
          })),
          lockedDecks: (collection.lockedDecks ?? []).map((deck) => deck.label || deck.code || deck.key),
          activeUnlockTarget: collection.activeUnlockTarget ?? null,
          deckProgress: (collection.deckProgress ?? [])
            .filter((deck) => deck.unlocked)
            .map((deck) => ({
              code: deck.code,
              highestWonStake: deck.highestWonStake,
              nextStake: deck.nextStake,
              availableStakes: deck.availableStakes,
            })),
          error: collection.available === false ? collection.error ?? "unavailable" : null,
        }
      : null,
    appearedThisRun: {
      jokers: (appeared.jokers ?? []).map((card) => ({ key: card.key, label: card.label, sources: card.sources })),
      consumables: (appeared.consumables ?? []).map((card) => ({ key: card.key, label: card.label, sources: card.sources })),
      vouchers: (appeared.vouchers ?? []).map((card) => ({ key: card.key, label: card.label, sources: card.sources })),
    },
    decisionRequired:
      "use active deck, activeUnlockTarget, and exact score-pressure budget; win the selected deck/stake run; locked-Joker conditions are optional only when already reachable without reducing survival; keep build composition flexible; buildGoal/synergies use only owned or appeared cards; unlocked unseen cards are optional shop/pivot targets; compare keep_current_build vs temporary_bridge vs pivot",
  };
}

export function compactBalatrobotPromptState(gameState) {
  if (!gameState || typeof gameState !== "object") return gameState;
  const remaining = gameState.remainingDeck && typeof gameState.remainingDeck === "object"
    ? gameState.remainingDeck
    : { count: 0, cards: [] };
  const cards = Array.isArray(remaining.cards) ? remaining.cards : [];
  const compactCards = cards.map((card) => {
    if (typeof card === "string") return card;
    const key = String(card?.key || `${card?.rank ?? "?"}${card?.suit ?? "?"}`);
    const modifiers = [
      card?.enhancement ? `enh=${card.enhancement}` : "",
      card?.edition ? `edition=${card.edition}` : "",
      card?.seal ? `seal=${card.seal}` : "",
      card?.debuff ? "debuff" : "",
    ].filter(Boolean);
    return modifiers.length ? `${key}|${modifiers.join("|")}` : key;
  });
  return {
    ...gameState,
    remainingDeck: {
      count: Number.isInteger(remaining.count) ? remaining.count : compactCards.length,
      cards: compactCards,
    },
  };
}

export class VisionPlanner {
  constructor(projectRoot, config, { apiKey, fetchImpl = fetch } = {}) {
    const keyName = apiKeyEnvironment(config.provider);
    const routeKeyName = config.plannerRole === "strategic" || config.plannerRole === "vision"
      ? "BALATRO_STRATEGY_API_KEY"
      : config.plannerRole === "routine"
        ? "BALATRO_ROUTINE_API_KEY"
        : null;
    if (routeKeyName) apiKey ??= process.env[routeKeyName];
    if (keyName) apiKey ??= process.env[keyName];
    if (keyName && !apiKey) {
      throw new Error(`${routeKeyName ?? keyName} is required for ${config.provider} mode. Keep it in the environment, not config.json.`);
    }
    this.config = config;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    const prompt = fs.readFileSync(path.join(projectRoot, "prompts", "balatro-agent.md"), "utf8");
    const botPrompt = fs.readFileSync(path.join(projectRoot, "prompts", "balatrobot-agent.md"), "utf8");
    const rulebook = fs.readFileSync(path.join(projectRoot, "prompts", "balatro-rules.md"), "utf8").trim();
    const strategicRules = fs.readFileSync(path.join(projectRoot, "prompts", "balatro-strategic-rules.md"), "utf8").trim();
    const metaGuide = fs.readFileSync(path.join(projectRoot, "prompts", "balatro-meta-1.0.1o.md"), "utf8").trim();
    if (!rulebook) throw new Error("Balatro rulebook is empty");
    if (!strategicRules) throw new Error("Balatro strategic rule capsule is empty");
    if (!metaGuide) throw new Error("Balatro metagame guide is empty");
    this.rulebookInfo = {
      characters: rulebook.length,
      sections: (rulebook.match(/^## /gm) ?? []).length,
    };
    this.metaGuideInfo = {
      version: "1.0.1o",
      characters: metaGuide.length,
      sections: (metaGuide.match(/^## /gm) ?? []).length,
    };
    this.systemPrompt = [
      prompt.trim(),
      "The trusted rulebook below is mandatory. Read it completely before taking any in-game action.",
      `<balatro_rulebook>\n${rulebook}\n</balatro_rulebook>`,
      "The version-specific strategic prior below is mandatory but subordinate to exact visible effects.",
      `<balatro_metagame version="1.0.1o">\n${metaGuide}\n</balatro_metagame>`,
      `Run goal: ${config.goal}`,
    ].join("\n\n");
    const compactExactStatePrompt = config.plannerRole === "strategic" || config.provider === "ollama-chat";
    const exactStateRules = compactExactStatePrompt
      ? [
          "Use this compact strategic rule capsule. Detailed operational legality is supplied by exact state, local candidates, and controller validation.",
          `<balatro_strategic_rules>\n${strategicRules}\n</balatro_strategic_rules>`,
        ]
      : [
          "The trusted rulebook below is mandatory. Apply it to the exact structured state.",
          `<balatro_rulebook>\n${rulebook}\n</balatro_rulebook>`,
        ];
    this.balatrobotSystemPrompt = [
      botPrompt.trim(),
      ...exactStateRules,
      ...(config.provider === "ollama-chat"
        ? [
            "This is the fast routine ranker. Trust local_action_candidates and the current_run_plan; do not invent a new metagame route. Strategic K3 checkpoints own build pivots.",
          ]
        : [
            "Apply this installed-version strategic prior, while allowing exact state evidence to override it.",
            `<balatro_metagame version="1.0.1o">\n${metaGuide}\n</balatro_metagame>`,
          ]),
      `Run goal: ${config.goal}`,
    ].join("\n\n");
  }

  async #post(pathname, payload, { signal, timeoutMs = this.config.apiTimeoutMs } = {}) {
    const requestTimeoutMs = Math.max(1, Number(timeoutMs) || this.config.apiTimeoutMs);
    let lastError;
    for (let attempt = 0; attempt <= this.config.apiRetries; attempt++) {
      if (signal?.aborted) {
        const error = new Error(signal.reason?.message ?? "Planner API request aborted", { cause: signal.reason });
        error.name = "AbortError";
        throw error;
      }
      const controller = new AbortController();
      let timedOut = false;
      const requestStartedAt = Date.now();
      const relayAbort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", relayAbort, { once: true });
      if (signal?.aborted) relayAbort();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Planner API request timed out", "TimeoutError"));
      }, requestTimeoutMs);
      try {
        const headers = { "Content-Type": "application/json" };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        if (this.config.provider === "kimi-chat" || this.config.provider === "kimi-platform") {
          headers["User-Agent"] = "balatro-pilot/1.0";
        }
        const response = await this.fetch(`${this.config.apiBaseUrl.replace(/\/$/, "")}${pathname}`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const message = body?.error?.message || `${response.status} ${response.statusText}`;
          const error = new Error(`Planner API error: ${message}`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        return body;
      } catch (error) {
        if (signal?.aborted) {
          const aborted = new Error(signal.reason?.message ?? "Planner API request aborted", {
            cause: signal.reason ?? error,
          });
          aborted.name = "AbortError";
          throw aborted;
        }
        if (timedOut || error.name === "AbortError") {
          lastError = new Error(`Planner API request timed out after ${requestTimeoutMs}ms`);
          lastError.code = "PLANNER_TIMEOUT";
          lastError.timeoutMs = requestTimeoutMs;
          lastError.elapsedMs = Date.now() - requestStartedAt;
          lastError.provider = this.config.provider;
          lastError.model = this.config.model;
          lastError.attempt = attempt + 1;
        } else if (error instanceof TypeError) {
          const code = error.cause?.code ? ` ${error.cause.code}` : "";
          const detail = error.cause?.message || error.message;
          lastError = new Error(`Planner network request failed${code}: ${detail}. Check the Windows proxy/VPN.`);
        } else {
          lastError = error;
        }
        // A bounded timeout is a hand-off signal. Retrying the same provider
        // here would spend another full timeout window before the runner can
        // route the unchanged exact state to its fast fallback planner.
        const retryable = !timedOut && (error.retryable || error.name === "AbortError" || error instanceof TypeError);
        if (!retryable || attempt >= this.config.apiRetries) break;
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            const aborted = new Error(signal?.reason?.message ?? "Planner API request aborted", {
              cause: signal?.reason,
            });
            aborted.name = "AbortError";
            reject(aborted);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 500 * 2 ** attempt);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relayAbort);
      }
    }
    throw lastError;
  }

  async #request({
    pngBase64,
    imageMimeType = "image/png",
    width,
    height,
    step,
    memory,
    frameContext,
    experienceContext,
    roundContext,
    detail,
    maxOutputTokens = this.config.maxOutputTokens,
    extraInstruction = "",
    signal,
  }) {
    const turnText = [
      `Turn: ${step}. Screenshot size: ${width}x${height}.`,
      `Persistent state: ${memory || "none"}`,
      `Local frame check: ${frameContext}`,
      `Round strategy context: ${roundContext || "none"}`,
      experienceContext ? `Retrieved experience:\n<experience>\n${experienceContext}\n</experience>` : "Retrieved experience: none",
      `Image detail: ${detail}. Use null for action fields that do not apply.`,
      extraInstruction,
    ].join("\n");

    if (this.config.provider === "deepseek-chat") {
      throw new Error(
        "DeepSeek Chat is configured for text-only BalatroBot state planning and cannot read screenshots; use the vision provider for this route.",
      );
    }

    if (isChatCompletionProvider(this.config.provider)) {
      const body = await this.#post("/chat/completions", {
        model: this.config.model,
        messages: [
          { role: "system", content: `${this.systemPrompt}\n\n${kimiJsonInstruction()}` },
          {
            role: "user",
            content: [
              { type: "text", text: turnText },
              { type: "image_url", image_url: { url: `data:${imageMimeType};base64,${pngBase64}` } },
            ],
          },
        ],
        ...chatReasoningParameters(this.config),
        ...chatCompletionBudget(this.config.provider, maxOutputTokens),
        response_format: { type: "json_object" },
      }, { signal });
      const parsed = parseChatPlanResponse(body, this.config.provider);
      return {
        ...parsed,
        detail,
      };
    }

    const body = await this.#post("/responses", {
      model: this.config.model,
      store: false,
      reasoning: { effort: this.config.reasoningEffort },
      max_output_tokens: maxOutputTokens,
      input: [
        { role: "system", content: this.systemPrompt },
        {
          role: "user",
          content: [
            { type: "input_text", text: turnText },
            {
              type: "input_image",
              image_url: `data:${imageMimeType};base64,${pngBase64}`,
              detail,
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "balatro_action_plan",
          strict: true,
          schema: actionSchema(),
        },
      },
    }, { signal });
    return {
      plan: parsePlanJson(extractOutputText(body)).value,
      usage: normalizeUsage(body.usage),
      responseId: body.id ?? null,
      detail,
    };
  }

  async #requestWithJsonRecovery(args) {
    try {
      return await this.#request(args);
    } catch (error) {
      if (error.code !== "PLAN_JSON_INVALID") throw error;
      const retryLimit = Math.min(5_000, Math.max(1_600, this.config.maxOutputTokens * 2));
      const failedAttempt = {
        detail: args.detail,
        responseId: error.responseId,
        truncated: error.finishReason === "length",
        emptyContent: Boolean(error.emptyContent),
        finishReason: error.finishReason,
        maxOutputTokens: args.maxOutputTokens ?? this.config.maxOutputTokens,
        diagnostics: error.diagnostics,
      };
      let retried;
      try {
        retried = await this.#request({
          ...args,
          maxOutputTokens: retryLimit,
          extraInstruction:
            "The previous response was empty, incomplete, or invalid JSON. Return a much shorter complete JSON object. Keep observation, strategy, memory, and reasons terse; preserve the full executable action sequence.",
        });
      } catch (retryError) {
        if (retryError.code === "PLAN_JSON_INVALID") {
          retryError.usage = mergeUsage(error.usage, retryError.usage);
          retryError.recoveryAttempts = [
            failedAttempt,
            {
              detail: args.detail,
              responseId: retryError.responseId,
              truncated: retryError.finishReason === "length",
              emptyContent: Boolean(retryError.emptyContent),
              finishReason: retryError.finishReason,
              maxOutputTokens: retryLimit,
              diagnostics: retryError.diagnostics,
            },
          ];
        }
        throw retryError;
      }
      retried.usage = mergeUsage(error.usage, retried.usage);
      retried.recoveryAttempts = [failedAttempt];
      return retried;
    }
  }

  async #requestBalatrobot({
    gameState,
    step,
    memory = "",
    runPlan = null,
    previousError = "",
    experienceContext = "",
    candidateContext = "",
    reasoningEffort = this.config.reasoningEffort,
    maxOutputTokens = this.config.maxOutputTokens,
    requestTimeoutMs = this.config.apiTimeoutMs,
    extraInstruction = "",
    signal,
  }) {
    const promptState = compactBalatrobotPromptState(gameState);
    const turnText = [
      `Turn: ${step}. Exact BalatroBot state follows.`,
      `Persistent strategy memory: ${memory || "none"}`,
      `<build_planning_context>\n${JSON.stringify(balatrobotBuildPlanningContext(gameState))}\n</build_planning_context>`,
      runPlan
        ? `<current_run_plan>\n${JSON.stringify(runPlan)}\n</current_run_plan>\nKeep it unless the exact state supplies a concrete reason to revise it.`
        : "Current run plan: none; establish one from the exact owned cards, shop offers, poker-hand levels, and economy.",
      previousError ? `Previous action was rejected before execution: ${previousError}` : "Previous action error: none",
      experienceContext
        ? `<semantic_experience>\n${experienceContext}\n</semantic_experience>`
        : "Semantic experience: none yet",
      candidateContext
        ? `<local_action_candidates>\n${candidateContext}\n</local_action_candidates>\nUse the local rules engine as authoritative. For play or discard, copy method and cards exactly from one candidate. For an opened pack, obey each targetRule and prefer a locally generated safe choice over skip; never omit required targets. conservativeScore includes the controller's supported Joker, hand-level, enhancement, edition and debuff rules, while optimisticScore keeps volatile upside separate. Other locally legal methods remain available when required by an effect.`
        : "Local action candidates: none",
      "In game_state.remainingDeck.cards, each exact remaining card is encoded compactly as key|optional modifiers; duplicates are intentional.",
      `<game_state>\n${JSON.stringify(promptState)}\n</game_state>`,
      extraInstruction,
    ].join("\n");

    if (isChatCompletionProvider(this.config.provider)) {
      const body = await this.#post("/chat/completions", {
        model: this.config.model,
        messages: [
          { role: "system", content: `${this.balatrobotSystemPrompt}\n\n${kimiBalatrobotJsonInstruction()}` },
          { role: "user", content: turnText },
        ],
        ...chatReasoningParameters(this.config, reasoningEffort),
        ...chatCompletionBudget(this.config.provider, maxOutputTokens),
        ...(isKimiProvider(this.config.provider)
          ? { prompt_cache_key: kimiPromptCacheKey(gameState, this.config) }
          : {}),
        response_format: { type: "json_object" },
      }, { signal, timeoutMs: requestTimeoutMs });
      return parseChatPlanResponse(body, this.config.provider, { semantic: true });
    }

    const body = await this.#post("/responses", {
      model: this.config.model,
      store: false,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: maxOutputTokens,
      input: [
        { role: "system", content: this.balatrobotSystemPrompt },
        { role: "user", content: turnText },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "balatrobot_semantic_plan",
          strict: true,
          schema: balatrobotActionSchema(),
        },
      },
    }, { signal, timeoutMs: requestTimeoutMs });
    try {
      const parsed = parsePlanJson(extractOutputText(body));
      const normalized = normalizeBalatrobotPlanShape(parsed.value);
      return {
        plan: normalized.plan,
        usage: normalizeUsage(body.usage),
        responseId: body.id ?? null,
        jsonRepaired: parsed.repaired,
        shapeRepaired: normalized.repaired,
      };
    } catch (error) {
      error.code ??= "PLAN_JSON_INVALID";
      error.usage = normalizeUsage(body.usage);
      error.responseId = body.id ?? null;
      throw error;
    }
  }

  async rankCandidate({
    gameState,
    step,
    memory = "",
    runPlan = null,
    candidateContext = "",
    reasoningEffort = "none",
    maxOutputTokens = 256,
    signal,
  }) {
    if (!isChatCompletionProvider(this.config.provider)) {
      throw new Error(`${this.config.provider} does not support the compact candidate-ranker route`);
    }
    let candidates;
    try {
      candidates = JSON.parse(String(candidateContext || "[]"));
    } catch (cause) {
      throw new Error("Candidate ranker received invalid local candidate JSON", { cause });
    }
    if (!Array.isArray(candidates) || !candidates.length) {
      throw new Error("Candidate ranker requires at least one local candidate");
    }
    const allowedIds = new Set(candidates.map((candidate) => String(candidate?.id ?? "")).filter(Boolean));
    if (!allowedIds.size) throw new Error("Candidate ranker received candidates without ids");
    const turnText = [
      `Turn: ${step}. Choose exactly one candidateId from local_action_candidates.`,
      `Persistent strategy memory: ${memory || "none"}`,
      runPlan
        ? `<current_run_plan>\n${JSON.stringify(runPlan)}\n</current_run_plan>`
        : "Current run plan: none",
      `<build_planning_context>\n${JSON.stringify(balatrobotBuildPlanningContext(gameState))}\n</build_planning_context>`,
      `<local_action_candidates>\n${JSON.stringify(candidates)}\n</local_action_candidates>`,
      `<compact_state>\n${JSON.stringify(compactBalatrobotPromptState(gameState))}\n</compact_state>`,
      "The local candidates are already legal and authoritative. Rank them against survival, the current run plan, and exact score/outs. Do not invent, rewrite, or combine actions.",
      "When experiencePrior.applied is true, calibratedPriority is a conservative cross-seed prior from independent completed episodes. " +
        "Use it as one ranking signal after survival constraints; a negative signal is evidence against that candidate. " +
        "Never use experience evidence to bypass strategic approval or local legality.",
    ].join("\n");
    const body = await this.#post("/chat/completions", {
      model: this.config.model,
      messages: [
        {
          role: "system",
          content:
            "You are a strict Balatro candidate ranker. Return only JSON with exactly candidateId and reason. " +
            "candidateId must be copied byte-for-byte from the supplied list. reason is concise Simplified Chinese under 60 characters. " +
            "Never return method, cards, params, actions, coordinates, markdown, or extra keys.",
        },
        { role: "user", content: turnText },
      ],
      ...chatReasoningParameters(this.config, reasoningEffort),
      ...chatCompletionBudget(this.config.provider, Math.max(64, Math.min(512, Number(maxOutputTokens) || 256))),
      response_format: { type: "json_object" },
    }, { signal });
    let parsed;
    try {
      parsed = parsePlanJson(extractChatOutputText(body));
    } catch (cause) {
      const error = invalidChatPlanError(body, `${chatProviderLabel(this.config.provider)} returned invalid candidate-rank JSON`, cause);
      throw error;
    }
    const value = parsed.value;
    const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
    const candidateId = typeof value?.candidateId === "string" ? value.candidateId : "";
    if (keys.some((key) => key !== "candidateId" && key !== "reason") || !allowedIds.has(candidateId)) {
      const error = new Error(
        `Candidate ranker must return one listed candidateId; received ${candidateId || "none"}`,
      );
      error.code = "CANDIDATE_RANK_INVALID";
      error.usage = normalizeUsage(body.usage);
      error.responseId = body.id ?? null;
      throw error;
    }
    return {
      candidateId,
      reason: String(value.reason ?? "").slice(0, 160),
      usage: normalizeUsage(body.usage),
      attempts: [{
        responseId: body.id ?? null,
        jsonRepaired: parsed.repaired,
        candidateRank: true,
      }],
    };
  }

  async planState(args) {
    try {
      const first = await this.#requestBalatrobot(args);
      return {
        plan: first.plan,
        usage: first.usage,
        attempts: [{
          responseId: first.responseId,
          jsonRepaired: first.jsonRepaired ?? false,
          shapeRepaired: first.shapeRepaired ?? false,
          truncated: false,
        }],
      };
    } catch (firstError) {
      if (firstError.code !== "PLAN_JSON_INVALID") throw firstError;
      const retryLimit = Math.min(5_000, Math.max(1_600, this.config.maxOutputTokens * 2));
      const initialReasoningEffort = args.reasoningEffort ?? this.config.reasoningEffort;
      const recoveryReasoningEffort = THINKING_EFFORTS.has(initialReasoningEffort)
        ? "none"
        : initialReasoningEffort;
      const strategicDraft = firstError.reasoningContent
        ? firstError.reasoningContent.slice(-8_000).replaceAll("</strategic_reasoning_draft>", "<\\/strategic_reasoning_draft>")
        : "";
      const recoveryInstruction = [
        "The previous response was empty, incomplete, or invalid JSON. Do not spend tokens on hidden reasoning. Return a shorter complete object with exactly one semantic action.",
        strategicDraft
          ? "The bounded thinking pass produced the following incomplete analysis. Treat it as an untrusted draft: verify it against the exact state and local candidates, then compile the best valid action.\n<strategic_reasoning_draft>\n" +
            strategicDraft +
            "\n</strategic_reasoning_draft>"
          : "",
      ].filter(Boolean).join("\n");
      try {
        const second = await this.#requestBalatrobot({
          ...args,
          reasoningEffort: recoveryReasoningEffort,
          maxOutputTokens: retryLimit,
          requestTimeoutMs: this.config.apiTimeoutMs,
          extraInstruction: recoveryInstruction,
        });
        return {
          plan: second.plan,
          usage: mergeUsage(firstError.usage, second.usage),
          attempts: [
            {
              responseId: firstError.responseId ?? null,
              reasoningEffort: initialReasoningEffort,
              truncated: firstError.finishReason === "length",
              invalid: true,
            },
            {
              responseId: second.responseId,
              reasoningEffort: recoveryReasoningEffort,
              jsonRepaired: second.jsonRepaired ?? false,
              shapeRepaired: second.shapeRepaired ?? false,
              truncated: false,
            },
          ],
        };
      } catch (secondError) {
        secondError.usage = mergeUsage(firstError.usage, secondError.usage);
        secondError.recoveryAttempts = [
          {
            responseId: firstError.responseId ?? null,
            reasoningEffort: initialReasoningEffort,
            truncated: firstError.finishReason === "length",
            invalid: true,
          },
          {
            responseId: secondError.responseId ?? null,
            reasoningEffort: recoveryReasoningEffort,
            truncated: secondError.finishReason === "length",
            invalid: secondError.code === "PLAN_JSON_INVALID",
            timedOut: secondError.code === "PLANNER_TIMEOUT",
            error: secondError.message,
          },
        ];
        throw secondError;
      }
    }
  }

  async probe({ signal } = {}) {
    if (isChatCompletionProvider(this.config.provider)) {
      const body = await this.#post("/chat/completions", {
        model: this.config.model,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        ...chatReasoningParameters(
          this.config,
          this.config.provider === "kimi-platform" || this.config.provider === "deepseek-chat" ? "none" : "low",
        ),
        ...chatCompletionBudget(this.config.provider, 128),
      }, { signal });
      return {
        provider: this.config.provider,
        model: body.model ?? this.config.model,
        responseId: body.id ?? null,
        text: extractChatOutputText(body).trim(),
        usage: normalizeUsage(body.usage),
      };
    }

    const body = await this.#post("/responses", {
      model: this.config.model,
      reasoning: { effort: "low" },
      max_output_tokens: 64,
      input: "Reply with exactly OK.",
    }, { signal });
    return {
      provider: this.config.provider,
      model: body.model ?? this.config.model,
      responseId: body.id ?? null,
      text: extractOutputText(body).trim(),
      usage: normalizeUsage(body.usage),
    };
  }

  async plan({
    pngBase64,
    imageMimeType = "image/png",
    width,
    height,
    step,
    memory = "",
    frameContext = "stable",
    experienceContext = "",
    roundContext = "",
    signal,
  }) {
    const first = await this.#requestWithJsonRecovery({
      pngBase64,
      imageMimeType,
      width,
      height,
      step,
      memory,
      frameContext,
      experienceContext,
      roundContext,
      detail: this.config.imageDetail,
      signal,
    });
    const fallback = this.config.fallbackImageDetail;
    if (this.config.provider !== "openai-responses" || !first.plan.needsDetail || fallback === this.config.imageDetail) {
      return {
        plan: first.plan,
        usage: first.usage,
        attempts: [
          ...(first.recoveryAttempts ?? []),
          { detail: first.detail, responseId: first.responseId, truncated: false, jsonRepaired: first.jsonRepaired ?? false },
        ],
      };
    }

    const second = await this.#requestWithJsonRecovery({
      pngBase64,
      imageMimeType,
      width,
      height,
      step,
      memory,
      frameContext: `${frameContext}; retrying at ${fallback} detail because the first pass could not safely read required UI text`,
      experienceContext,
      roundContext,
      detail: fallback,
      signal,
    });
    return {
      plan: second.plan,
      usage: mergeUsage(first.usage, second.usage),
      attempts: [
        ...(first.recoveryAttempts ?? []),
        { detail: first.detail, responseId: first.responseId, truncated: false, jsonRepaired: first.jsonRepaired ?? false },
        ...(second.recoveryAttempts ?? []),
        { detail: second.detail, responseId: second.responseId, truncated: false, jsonRepaired: second.jsonRepaired ?? false },
      ],
    };
  }
}
