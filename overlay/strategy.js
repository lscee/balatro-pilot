import { byId, formatNumber, setText, startOverlay } from "/overlay/common.js?v=stream-v15";

const PHASES = Object.freeze({
  MENU: "主菜单",
  BLIND_SELECT: "选择盲注",
  SELECTING_HAND: "规划手牌",
  HAND_PLAYED: "结算牌型",
  DRAW_TO_HAND: "补充手牌",
  ROUND_EVAL: "回合结算",
  SHOP: "商店构筑",
  SMODS_BOOSTER_OPENED: "选择卡包",
  GAME_OVER: "本局结束",
});

const METHODS = Object.freeze({
  play: "出牌",
  discard: "弃牌",
  select: "挑战盲注",
  skip: "跳过盲注",
  buy: "购买",
  sell: "出售",
  reroll: "刷新商店",
  pack: "选择卡包内容",
  use: "使用消耗牌",
  rearrange: "调整顺序",
  cash_out: "领取奖励",
  next_round: "进入下一回合",
  start: "开始新局",
  menu: "返回主菜单",
});

const SOURCES = Object.freeze({
  balatrobot_model: "AI 决策",
  balatrobot_local: "本地状态机",
  semantic_fast_path: "经验复用",
  balatrobot_rpc_recovery: "安全恢复",
  balatrobot_planner_fallback: "本地回退",
  balatrobot_validation_fallback: "校验回退",
});

const HANDS = Object.freeze({
  Pair: "对子",
  "Two Pair": "两对",
  "Three of a Kind": "三条",
  Straight: "顺子",
  Flush: "同花",
  "Full House": "葫芦",
  "Four of a Kind": "四条",
  "Straight Flush": "同花顺",
  "Five of a Kind": "五条",
  "Flush House": "同花葫芦",
  "Flush Five": "同花五条",
  "High Card": "高牌",
});

const SUITS = Object.freeze({ H: "♥", D: "♦", C: "♣", S: "♠" });

function cardsFromIndices(state, indices) {
  return (indices ?? []).map((index) => {
    const card = state?.hand?.cards?.find((candidate) => candidate.index === index);
    if (!card) return `第${index + 1}张`;
    const key = String(card.key ?? "").match(/^([HDCS])_([2-9TJQKA])$/u);
    const rank = card.rank || key?.[2] || "?";
    const suit = card.suit || key?.[1] || "";
    return `${rank}${SUITS[suit] ?? suit}`;
  });
}

function sameCards(left, right) {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a - b)) === JSON.stringify([...(right ?? [])].sort((a, b) => a - b));
}

function matchedCandidate(snapshot, action) {
  if (!new Set(["play", "discard"]).has(action?.method)) return null;
  return (snapshot.thinking?.candidates ?? []).find(
    (candidate) => candidate.action?.method === action.method && sameCards(candidate.action.cards, action.params?.cards),
  ) ?? null;
}

function decisionExplanation(snapshot) {
  const state = snapshot.state;
  const action = snapshot.strategy?.action;
  if (!action) return "正在等待当前状态的下一条决策。";
  const selected = cardsFromIndices(state, action.params?.cards);
  const candidate = matchedCandidate(snapshot, action);
  switch (action.method) {
    case "play": {
      const hand = HANDS[candidate?.handType] ?? candidate?.handType ?? "当前牌型";
      const fillers = candidate?.cycleFillers?.length
        ? `，并带出 ${candidate.cycleFillers.length} 张低价值散牌以压缩牌组`
        : "";
      return `准备打出 ${selected.join("、") || "所选牌"}，以${hand}计分${fillers}。`;
    }
    case "discard":
      return `弃掉 ${selected.join("、") || "所选牌"}，${candidate?.target ? `目标是${candidate.target}` : "寻找更强的组合"}。`;
    case "select":
      return `选择挑战${state?.blind?.name || "当前盲注"}，目标为 ${formatNumber(state?.blind?.score)} 分。`;
    case "skip":
      return `放弃当前盲注奖励，换取跳过标签并保存资源。`;
    case "reroll":
      return `花费资金刷新商店，继续寻找更适合当前构筑的组件。`;
    case "next_round":
      return `结束购物并保留资金，进入下一轮盲注。`;
    case "cash_out":
      return `本轮已达标，领取奖励并进入商店。`;
    case "buy":
      return `购买当前构筑最有价值的商店物品。`;
    case "pack":
      return `从卡包中选择对长期构筑提升最大的内容。`;
    case "start":
      return `开始一局新的训练与游玩。`;
    default:
      return action.reason || `执行${METHODS[action.method] ?? action.method}。`;
  }
}

function actionLine(snapshot) {
  const action = snapshot.strategy?.action;
  if (!action) return "尚未生成动作";
  const previous = snapshot.step != null && snapshot.strategy?.step != null && snapshot.strategy.step !== snapshot.step;
  const pending = snapshot.pendingAction?.method === action.method ? "执行中" : previous ? "上一动作" : "计划动作";
  const cards = cardsFromIndices(snapshot.state, action.params?.cards);
  const suffix = cards.length ? ` · ${cards.join(" ")}` : "";
  return `${pending}｜${METHODS[action.method] ?? action.method}${suffix}`;
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value ?? ""));
}

function chineseText(value, fallback) {
  const text = String(value ?? "").trim();
  return text && containsChinese(text) ? text : fallback;
}

function observationFallback(snapshot) {
  const state = snapshot.state;
  if (!state) return "正在读取游戏状态。";
  const phase = PHASES[state.state] ?? "当前阶段";
  if (state.blind?.score) {
    return `当前处于${phase}，已有 ${formatNumber(state.score)} 分，目标 ${formatNumber(state.blind.score)} 分。`;
  }
  return `当前处于${phase}，正在读取可用资源与合法动作。`;
}

function runPlanFields(snapshot) {
  const state = snapshot.state;
  const jokers = (state?.jokers?.cards ?? []).map((card) => card.label || card.key).filter(Boolean);
  const consumables = (state?.consumables?.cards ?? []).map((card) => card.label || card.key).filter(Boolean);
  const components = [
    jokers.length ? `小丑牌：${jokers.join("、")}` : "",
    consumables.length ? `消耗牌：${consumables.join("、")}` : "",
  ].filter(Boolean).join("；");
  const memory = chineseText(snapshot.strategy?.memory, "");
  const runPlan = snapshot.strategy?.runPlan;
  if (runPlan && typeof runPlan === "object" && Object.values(runPlan).some((value) => String(value ?? "").trim())) {
    const merge = (...values) => values.map((value) => String(value ?? "").trim()).filter(Boolean).join("；");
    const fields = [
      ["版本与方向", merge(runPlan.metaAssessment, runPlan.buildGoal)],
      ["当前协同", runPlan.synergies],
      ["经济与商店", merge(runPlan.economyPolicy, runPlan.shopPriorities)],
      ["转型条件", runPlan.pivotPolicy],
      ["出牌与弃牌", runPlan.handPolicy],
      ["下一目标", merge(runPlan.nextMilestone, runPlan.revisionReason)],
    ].filter(([, value]) => String(value ?? "").trim());
    return fields;
  }
  if (/持有：.*核心组合：.*协同：.*打法：.*阶段目标：/su.test(memory)) return [["本局计划", memory]];
  if (components && memory) return [["当前组件", components], ["本局计划", memory]];
  if (memory) return [["本局计划", memory]];
  if (components) return [["当前组件", components], ["本局计划", "正在根据现有组件建立核心牌型、协同与打法。"]];
  return [["构筑状态", "正在建立当前牌组的核心组合、协同关系和出牌方向。"]];
}

function renderRunPlan(snapshot) {
  const list = byId("run-plan-list");
  if (!list) return;
  const rows = runPlanFields(snapshot).map(([label, value]) => {
    const row = document.createElement("div");
    row.className = "run-plan-row";
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = String(value ?? "");
    row.append(term, detail);
    return row;
  });
  list.replaceChildren(...rows);
}

function fullAiThought(snapshot) {
  const observation = chineseText(snapshot.strategy?.observation, observationFallback(snapshot));
  const reasoning = chineseText(snapshot.strategy?.strategy, decisionExplanation(snapshot));
  const actionReason = chineseText(snapshot.strategy?.action?.reason, "");
  return [
    observation ? `局面判断：${observation}` : "",
    reasoning ? `决策推理：${reasoning}` : "",
    actionReason && actionReason !== reasoning ? `执行目的：${actionReason}` : "",
  ].filter(Boolean).join("\n") || "正在根据当前商品、持有物、手牌和盲注压力形成完整思路。";
}

function render(snapshot) {
  const currentStrategy = snapshot.strategy ?? null;
  const currentThinking = snapshot.thinking?.step === snapshot.step ? snapshot.thinking : null;
  const previousStrategy = currentStrategy?.step != null && snapshot.step != null && currentStrategy.step !== snapshot.step;
  const view = {
    ...snapshot,
    state: currentStrategy?.stateSnapshot ?? snapshot.state,
    strategy: currentStrategy,
    thinking: currentThinking,
  };
  const action = currentStrategy?.action;
  const source = SOURCES[currentStrategy?.source] ?? "等待决策";
  setText("decision-source", previousStrategy ? `${source} · 上一步` : source);
  setText("decision-title", action ? METHODS[action.method] ?? action.method : "正在读取策略…");
  setText("decision-explanation", chineseText(currentStrategy?.strategy, decisionExplanation(view)));
  setText("action-line", actionLine(view));
  setText("strategy-text", fullAiThought(view));
  renderRunPlan(view);
}

startOverlay(render);
