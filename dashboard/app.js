const elements = {};
let latestStats = null;

function byId(id) {
  return elements[id] ??= document.getElementById(id);
}

function compactNumber(value, digits = 0) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat("zh-CN", {
    notation: Math.abs(amount) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: digits,
  }).format(amount);
}

function fullNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function percent(value, signed = false) {
  if (value == null || !Number.isFinite(Number(value))) return "新基线";
  const amount = Number(value) * (signed ? 1 : 100);
  const sign = signed && amount > 0 ? "+" : "";
  return sign + amount.toFixed(1) + "%";
}

function delta(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const amount = Number(value);
  return (amount > 0 ? "+" : "") + amount.toFixed(digits);
}

function duration(value) {
  const milliseconds = Number(value) || 0;
  if (milliseconds < 1000) return milliseconds.toFixed(0) + " ms";
  return (milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 1 : 2) + " s";
}

function timeLabel(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function setText(id, value) {
  byId(id).textContent = value;
}

function renderLive(live) {
  const badge = byId("live-badge");
  if (!live) {
    badge.className = "live-badge";
    badge.lastChild.textContent = " 暂无精确状态";
    return;
  }
  const ageSeconds = (Date.now() - new Date(live.at).getTime()) / 1000;
  const online = ageSeconds < 90;
  badge.className = "live-badge " + (online ? "online" : "");
  badge.lastChild.textContent = online ? " 实时运行中" : " 状态已暂停";
  setText("live-state", (live.blind || "Balatro") + " · " + live.state);
  setText("live-ante", live.ante || "—");
  setText("live-round", live.round || "—");
  setText("live-score", fullNumber(live.score));
  setText("live-target", fullNumber(live.target));
  setText("live-money", "$" + fullNumber(live.money));
}

function renderOverview(stats) {
  const overview = stats.overview;
  setText("highest-score", fullNumber(overview.highestScore));
  const best = overview.highestScoreGame;
  setText(
    "highest-score-meta",
    best ? "底注 " + best.maxAnte + " · 回合 " + best.maxRound + (best.recordBlind ? " · " + best.recordBlind : "") : "尚无记录",
  );
  setText("highest-hand", fullNumber(overview.highestHandScore));
  const bestHand = overview.highestHandGame;
  setText(
    "highest-hand-meta",
    bestHand ? "底注 " + bestHand.maxAnte + " · 回合 " + bestHand.maxRound : "尚无记录",
  );
  setText("deepest-progress", "Ante " + overview.highestAnte);
  setText("deepest-meta", "历史最高回合 " + overview.highestRound);
  setText("win-rate", percent(overview.winRate));
  setText(
    "record-summary",
    overview.wins + " 胜 / " + overview.losses + " 负 / " + overview.interruptedGames + " 中断",
  );
  setText("blinds-cleared", fullNumber(overview.blindsCleared));
  setText("peak-money", "$" + fullNumber(overview.peakMoney));
  setText("peak-jokers", fullNumber(overview.peakJokers));
  const highScore = stats.highScore;
  setText("hundred-thousand-games", fullNumber(highScore.milestones.hundredThousand.games));
  setText("hundred-thousand-rate", "完整局达成率 " + percent(highScore.milestones.hundredThousand.rate));
  setText("million-games", fullNumber(highScore.milestones.million.games));
  setText("million-rate", "完整局达成率 " + percent(highScore.milestones.million.rate));
  setText("peak-xmult", "X" + Number(highScore.peakPredictedXMult || 1).toFixed(2));
  setText("peak-retriggers", "已知预计重复触发 " + fullNumber(highScore.peakKnownRetriggers));
  setText("build-ready-rate", percent(highScore.buildReadyRate));
  setText("build-ready-games", fullNumber(highScore.buildReadyGames) + " 局曾同时具备筹码/+Mult/XMult");
}

function renderImprovement(improvement) {
  setText("improvement-label", improvement.label);
  setText("improvement-description", improvement.description);
  const chip = byId("improvement-chip");
  chip.className = "trend-chip " + (improvement.status === "insufficient" ? "neutral" : improvement.status);
  chip.textContent = improvement.label;
  setText("score-change", improvement.scoreChangePercent == null ? "新基线" : percent(improvement.scoreChangePercent, true));
  setText("ante-change", delta(improvement.anteChange));
  setText("round-change", delta(improvement.roundChange));
  setText("win-change", improvement.winRateChange == null ? "—" : percent(improvement.winRateChange));
}

function canvasSetup(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawEmpty(context, width, height) {
  context.fillStyle = "#8ea89e";
  context.font = "12px Segoe UI";
  context.textAlign = "center";
  context.fillText("等待更多完整游戏记录", width / 2, height / 2);
}

function drawLineChart(canvas, series, options = {}) {
  const setup = canvasSetup(canvas);
  const context = setup.context;
  const width = setup.width;
  const height = setup.height;
  context.clearRect(0, 0, width, height);
  const count = Math.max(0, ...series.map((item) => item.values.length));
  if (!count) {
    drawEmpty(context, width, height);
    return;
  }
  const left = 48;
  const right = 14;
  const top = 14;
  const bottom = 30;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const transform = options.transform || ((value) => value);
  const allValues = series.flatMap((item) => item.values).map(transform).filter(Number.isFinite);
  const maximum = Math.max(1, ...allValues);
  const minimum = options.zero === false ? Math.min(...allValues) : 0;
  const range = Math.max(1e-9, maximum - minimum);
  context.lineWidth = 1;
  context.strokeStyle = "rgba(145, 210, 185, .11)";
  context.fillStyle = "#789087";
  context.font = "10px Segoe UI";
  context.textAlign = "right";
  for (let row = 0; row <= 4; row++) {
    const y = top + chartHeight * row / 4;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - right, y);
    context.stroke();
    const transformed = maximum - range * row / 4;
    const labelValue = options.inverse ? options.inverse(transformed) : transformed;
    context.fillText(compactNumber(labelValue, 1), left - 8, y + 3);
  }
  const xFor = (index) => left + (count === 1 ? chartWidth / 2 : chartWidth * index / (count - 1));
  const yFor = (value) => top + chartHeight - (transform(value) - minimum) / range * chartHeight;
  for (const item of series) {
    context.beginPath();
    context.lineWidth = item.width || 2;
    context.strokeStyle = item.color;
    context.setLineDash(item.dashed ? [6, 6] : []);
    item.values.forEach((value, index) => {
      const x = xFor(index);
      const y = yFor(value);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    context.setLineDash([]);
    if (!item.dashed && item.values.length <= 60) {
      context.fillStyle = item.color;
      item.values.forEach((value, index) => {
        context.beginPath();
        context.arc(xFor(index), yFor(value), 2.4, 0, Math.PI * 2);
        context.fill();
      });
    }
  }
  context.fillStyle = "#789087";
  context.textAlign = "center";
  const labels = options.labels || [];
  const labelCount = Math.min(6, count);
  for (let index = 0; index < labelCount; index++) {
    const point = Math.round((count - 1) * index / Math.max(1, labelCount - 1));
    context.fillText(labels[point] || String(point + 1), xFor(point), height - 8);
  }
}

function renderCharts(stats) {
  const trend = stats.trend;
  const scoreValues = trend.map((item) => item.maxHandScore);
  const bestValues = stats.cumulativeBestHand.map((item) => item.value);
  drawLineChart(
    byId("score-chart"),
    [
      { values: scoreValues, color: "#7ff0bd", width: 2.3 },
      { values: bestValues, color: "#ffd36a", width: 1.5, dashed: true },
    ],
    {
      labels: trend.map((item) => "#" + item.game),
      transform: (value) => Math.log10(Math.max(1, value)),
      inverse: (value) => Math.pow(10, value),
    },
  );
  drawLineChart(
    byId("progress-chart"),
    [
      { values: trend.map((item) => item.maxRound), color: "#78a8ff", width: 2.2 },
      { values: trend.map((item) => item.maxAnte), color: "#ff806c", width: 1.8 },
    ],
    { labels: trend.map((item) => "#" + item.game) },
  );
  const daily = stats.daily;
  drawLineChart(
    byId("daily-chart"),
    [
      { values: daily.map((item) => item.averagePeakScore), color: "#7ff0bd", width: 2.2 },
      { values: daily.map((item) => item.bestScore), color: "#ffd36a", width: 1.6, dashed: true },
    ],
    {
      labels: daily.map((item) => item.day.slice(5)),
      transform: (value) => Math.log10(Math.max(1, value)),
      inverse: (value) => Math.pow(10, value),
    },
  );
}

function renderActions(stats) {
  const actions = stats.gameplay.actions;
  const entries = [
    ["出牌", actions.play],
    ["弃牌", actions.discard],
    ["购买", actions.buy],
    ["开包", actions.pack],
    ["刷新", actions.reroll],
    ["使用", actions.use],
  ];
  const maximum = Math.max(1, ...entries.map((entry) => entry[1]));
  const container = byId("action-bars");
  container.replaceChildren();
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const name = document.createElement("span");
    name.textContent = label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = Math.max(1, value / maximum * 100) + "%";
    track.append(fill);
    const amount = document.createElement("span");
    amount.className = "bar-value";
    amount.textContent = fullNumber(value);
    row.append(name, track, amount);
    container.append(row);
  }
  setText("hands-per-game", stats.gameplay.averageHandsPerCompletedGame.toFixed(1));
}

function renderModel(stats) {
  const model = stats.model;
  setText("planning-median", duration(model.medianPlanningMs));
  setText("planning-p90", duration(model.p90PlanningMs));
  setText("cache-rate", percent(model.cacheRate));
  setText("api-calls", fullNumber(model.usage.apiCalls));
  setText("strategy-split", fullNumber(model.strategicPlans) + " / " + fullNumber(model.routinePlans));
  setText("fallbacks", fullNumber(model.fallbacks));
  setText("total-tokens", compactNumber(model.usage.totalTokens, 2));
}

function renderGames(stats) {
  const body = byId("games-body");
  body.replaceChildren();
  const names = { won: "胜利", lost: "失败", ongoing: "进行中", interrupted: "已中断" };
  for (const game of stats.recentGames) {
    const row = document.createElement("tr");
    const values = [
      timeLabel(game.lastAt),
      names[game.outcome] || game.outcome,
      fullNumber(game.maxHandScore) + " / " + fullNumber(game.maxScore),
      game.maxAnte,
      game.maxRound,
      game.blindsCleared,
      game.actions.play + " / " + game.actions.discard,
      duration(game.averagePlanningMs),
      game.seed || "—",
    ];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 1) {
        const badge = document.createElement("span");
        badge.className = "outcome " + game.outcome;
        badge.textContent = value;
        cell.append(badge);
      } else {
        cell.textContent = value;
      }
      if (index === 8) cell.className = "seed";
      row.append(cell);
    });
    body.append(row);
  }
}

function render(stats) {
  latestStats = stats;
  renderLive(stats.live);
  renderOverview(stats);
  renderImprovement(stats.improvement);
  renderCharts(stats);
  renderActions(stats);
  renderModel(stats);
  renderGames(stats);
  setText(
    "coverage-note",
    stats.overview.exactGames + " 局精确记录 · " + stats.coverage.legacy.sessions + " 个旧视觉会话",
  );
  setText(
    "data-health",
    fullNumber(stats.coverage.totalEvents) + " 条事件 · " +
      (stats.coverage.indexedBytes / 1024 / 1024).toFixed(1) + " MB · 异常行 " + stats.coverage.malformedLines,
  );
  setText("updated-at", "更新于 " + new Date(stats.generatedAt).toLocaleTimeString("zh-CN"));
}

const componentStatusLabels = Object.freeze({
  healthy: "正常",
  configured: "已配置",
  idle: "待机",
  degraded: "需注意",
  offline: "离线",
});

function renderComponentHealth(health) {
  const summary = byId("component-summary");
  summary.className = "health-summary " + health.overall.status;
  summary.textContent = health.overall.label;
  const grid = byId("component-health");
  grid.replaceChildren();
  for (const component of health.components) {
    const card = document.createElement("article");
    card.className = "health-card " + component.status;

    const top = document.createElement("div");
    top.className = "health-card-top";
    const identity = document.createElement("div");
    identity.className = "health-identity";
    const dot = document.createElement("span");
    dot.className = "health-dot";
    const label = document.createElement("strong");
    label.textContent = component.label;
    identity.append(dot, label);
    const badge = document.createElement("span");
    badge.className = "health-state";
    badge.textContent = componentStatusLabels[component.status] ?? component.status;
    top.append(identity, badge);

    const summaryLine = document.createElement("p");
    summaryLine.className = "health-card-summary";
    summaryLine.textContent = component.summary;
    const detail = document.createElement("p");
    detail.className = "health-card-detail";
    detail.textContent = component.detail;
    const group = document.createElement("span");
    group.className = "health-group";
    group.textContent = component.group;
    card.append(top, summaryLine, detail, group);
    grid.append(card);
  }
  setText("component-note", (health.notes ?? []).join(" · "));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let pilotControlState = null;
let pilotControlReadPending = null;
let pilotControlOperationPending = null;

function normalizedPilotControlState(status) {
  const effectiveState = String(status?.effectiveState ?? status?.state ?? "unknown").toLowerCase();
  const desiredState = String(status?.desiredState ?? effectiveState).toLowerCase();
  return { effectiveState, desiredState };
}

function setPilotControlButtons({ pending = false } = {}) {
  const pause = byId("pilot-pause");
  const start = byId("pilot-start");
  const panel = byId("pilot-control");
  const { effectiveState, desiredState } = normalizedPilotControlState(pilotControlState);
  const unreadable = !pilotControlState;
  const transitional =
    effectiveState === "pausing" ||
    effectiveState === "starting" ||
    (desiredState !== "unknown" && effectiveState !== "unknown" && desiredState !== effectiveState);
  pause.disabled = pending || unreadable || transitional || effectiveState === "paused";
  start.disabled = pending || unreadable || transitional || effectiveState === "running";
  panel.setAttribute("aria-busy", String(pending || transitional));
}

function renderPilotControl(status) {
  pilotControlState = status;
  const badge = byId("pilot-control-status");
  const detail = byId("pilot-control-detail");
  const { effectiveState, desiredState } = normalizedPilotControlState(status);
  const operationError = String(status?.operationError ?? "").trim();
  const controllerPid = Number(status?.controllerPid) || null;

  if (operationError) {
    badge.className = "pilot-control-status error";
    badge.textContent = "操作未完成";
    detail.textContent = `${operationError} · 游戏与直播页面未被关闭。`;
  } else if (effectiveState === "running") {
    badge.className = "pilot-control-status running";
    badge.textContent = "AI 正在运行";
    detail.textContent = `AI 正在读取游戏状态并自动决策${controllerPid ? ` · 控制器 PID ${controllerPid}` : ""}。暂停只会停止 AI，不会关闭游戏。`;
  } else if (effectiveState === "paused") {
    badge.className = "pilot-control-status paused";
    badge.textContent = "AI 已暂停";
    detail.textContent = "AI 不会继续规划、调用模型或发送游戏操作；Balatro 游戏、BalatroBot RPC 和直播页面仍保持运行。";
  } else if (effectiveState === "starting" || desiredState === "running") {
    badge.className = "pilot-control-status starting";
    badge.textContent = "正在启动 AI…";
    detail.textContent = "正在从当前游戏状态恢复自动控制，请勿重复点击。";
  } else if (effectiveState === "pausing" || desiredState === "paused") {
    badge.className = "pilot-control-status pausing";
    badge.textContent = "正在暂停 AI…";
    detail.textContent = "正在安全停止决策循环；游戏、RPC 和直播页面不会关闭。";
  } else {
    badge.className = "pilot-control-status error";
    badge.textContent = "状态未知";
    detail.textContent = "暂时无法确认 AI 控制器状态，已禁用操作以避免误触；游戏本身未受影响。";
  }
  setPilotControlButtons({ pending: Boolean(pilotControlOperationPending) });
}

function renderPilotControlError(error) {
  const badge = byId("pilot-control-status");
  badge.className = "pilot-control-status error";
  badge.textContent = "控制接口不可用";
  setText("pilot-control-detail", `${error.message} · 游戏和直播页面未受影响。`);
  if (!pilotControlState) setPilotControlButtons({ pending: true });
}

function refreshPilotControl() {
  if (pilotControlOperationPending) return pilotControlOperationPending;
  if (pilotControlReadPending) return pilotControlReadPending;
  pilotControlReadPending = (async () => {
    try {
      const response = await fetchWithTimeout("/api/pilot-control", { cache: "no-store" });
      const status = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(status.message || `AI 控制状态 HTTP ${response.status}`);
      renderPilotControl(status);
      return status;
    } catch (error) {
      renderPilotControlError(error);
      return null;
    }
  })().finally(() => {
    pilotControlReadPending = null;
  });
  return pilotControlReadPending;
}

function controlPilot(action) {
  if (pilotControlOperationPending) return pilotControlOperationPending;
  pilotControlOperationPending = (async () => {
    setPilotControlButtons({ pending: true });
    const badge = byId("pilot-control-status");
    badge.className = `pilot-control-status ${action === "pause" ? "pausing" : "starting"}`;
    badge.textContent = action === "pause" ? "正在暂停 AI…" : "正在启动 AI…";
    setText(
      "pilot-control-detail",
      action === "pause"
        ? "正在安全停止决策循环；不会关闭 Balatro 游戏、RPC 或直播页面。"
        : "正在读取当前游戏状态并恢复自动控制，请勿重复点击。",
    );
    try {
      if (pilotControlReadPending) await pilotControlReadPending;
      const expectedRevision = pilotControlState?.revision;
      const body = { action };
      if (expectedRevision !== undefined && expectedRevision !== null) body.expectedRevision = expectedRevision;
      const response = await fetchWithTimeout("/api/pilot-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 20_000);
      const status = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(status.message || `AI 控制操作 HTTP ${response.status}`);
      renderPilotControl(status);
      void refreshComponentHealth();
      return status;
    } catch (error) {
      renderPilotControlError(error);
      return null;
    }
  })().finally(() => {
    pilotControlOperationPending = null;
    setPilotControlButtons();
  });
  return pilotControlOperationPending;
}

let componentHealthPending = null;
function refreshComponentHealth() {
  if (componentHealthPending) return componentHealthPending;
  componentHealthPending = (async () => {
    try {
      const response = await fetchWithTimeout("/api/components", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      renderComponentHealth(await response.json());
    } catch (error) {
      const summary = byId("component-summary");
      summary.className = "health-summary degraded";
      summary.textContent = "状态暂不可用";
      setText("component-note", `${error.message} · 保留上一次成功的组件状态`);
    }
  })().finally(() => {
    componentHealthPending = null;
  });
  return componentHealthPending;
}

let dashboardRefreshPending = null;
function refresh() {
  if (dashboardRefreshPending) return dashboardRefreshPending;
  dashboardRefreshPending = (async () => {
  const button = byId("refresh-button");
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    const response = await fetchWithTimeout("/api/stats", { cache: "no-store" }, 15_000);
    if (!response.ok) throw new Error("HTTP " + response.status);
    render(await response.json());
    await Promise.allSettled([refreshBackend(), refreshStrategicBackend()]);
  } catch (error) {
    const badge = byId("live-badge");
    badge.className = "live-badge error";
    badge.lastChild.textContent = " 读取失败";
    setText("updated-at", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "立即刷新";
  }
  })().finally(() => {
    dashboardRefreshPending = null;
  });
  return dashboardRefreshPending;
}

function renderBackend(status) {
  const local = byId("backend-local");
  const deepseek = byId("backend-deepseek");
  local.classList.toggle("active", status.mode === "local");
  deepseek.classList.toggle("active", status.mode === "deepseek");
  const badge = byId("backend-status");
  const localReady = status.ollama?.reachable && status.ollama?.loaded;
  if (status.mode === "local" && localReady) {
    badge.className = "backend-status ready";
    badge.textContent = "本地模型已加载";
    setText("backend-detail", "Qwen 9B 负责高频出牌；战略模型由下方独立开关控制。切换 DS 会立即卸载本地模型。");
  } else if (status.mode === "local") {
    badge.className = "backend-status error";
    badge.textContent = "本地未就绪 · 自动回退 DS";
    setText("backend-detail", status.operationError || status.ollama?.error || "本地模型尚未加载，控制器会安全回退 DeepSeek。" );
  } else {
    badge.className = "backend-status ready";
    badge.textContent = status.ollama?.loaded ? "DS 已启用 · 正在卸载" : "DS 已启用 · 显存已释放";
    setText("backend-detail", "高频决策由 DeepSeek 完成，本地模型不占显存；战略模型由下方独立开关控制。" );
  }
}

async function refreshBackend() {
  const response = await fetchWithTimeout("/api/routine-backend", { cache: "no-store" });
  if (!response.ok) throw new Error("后端状态 HTTP " + response.status);
  renderBackend(await response.json());
}

async function switchBackend(mode) {
  const buttons = [byId("backend-local"), byId("backend-deepseek")];
  buttons.forEach((button) => { button.disabled = true; });
  const badge = byId("backend-status");
  badge.className = "backend-status";
  badge.textContent = mode === "local" ? "正在加载本地模型…" : "正在卸载并释放显存…";
  try {
    const response = await fetch("/api/routine-backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const status = await response.json();
    if (!response.ok) throw new Error(status.message || "切换失败");
    renderBackend(status);
  } catch (error) {
    badge.className = "backend-status error";
    badge.textContent = "切换失败";
    setText("backend-detail", error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function renderStrategicBackend(status) {
  const kimi = byId("strategic-kimi");
  const deepseek = byId("strategic-deepseek");
  const available = new Set(status.availableModes ?? ["kimi", "deepseek"]);
  kimi.dataset.available = String(available.has("kimi"));
  deepseek.dataset.available = String(available.has("deepseek"));
  kimi.disabled = !available.has("kimi");
  deepseek.disabled = !available.has("deepseek");
  kimi.title = available.has("kimi") ? "" : "当前配置未提供 Kimi 战略路由";
  deepseek.title = available.has("deepseek") ? "" : "当前配置未提供 DeepSeek 战略路由";
  kimi.classList.toggle("active", status.mode === "kimi");
  deepseek.classList.toggle("active", status.mode === "deepseek");
  const badge = byId("strategic-status");
  badge.className = "backend-status ready";
  if (status.mode === "kimi") {
    badge.textContent = "Kimi K3 已启用";
    setText("strategic-detail", "商店构筑、购买/出售/重掷、关键盲注与战略审批由 Kimi K3 完成。");
  } else {
    badge.textContent = "DS Flash 已启用";
    setText("strategic-detail", "商店构筑、购买/出售/重掷、关键盲注与战略审批由 DeepSeek Flash 完成。");
  }
}

async function refreshStrategicBackend() {
  const response = await fetchWithTimeout("/api/strategic-backend", { cache: "no-store" });
  if (!response.ok) throw new Error("战略后端状态 HTTP " + response.status);
  renderStrategicBackend(await response.json());
}

async function switchStrategicBackend(mode) {
  const buttons = [byId("strategic-kimi"), byId("strategic-deepseek")];
  buttons.forEach((button) => { button.disabled = true; });
  const badge = byId("strategic-status");
  badge.className = "backend-status";
  badge.textContent = mode === "kimi" ? "正在切换到 Kimi…" : "正在切换到 DS Flash…";
  try {
    const response = await fetch("/api/strategic-backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const status = await response.json();
    if (!response.ok) throw new Error(status.message || "战略模型切换失败");
    renderStrategicBackend(status);
    await refreshComponentHealth();
  } catch (error) {
    badge.className = "backend-status error";
    badge.textContent = "切换失败";
    setText("strategic-detail", error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = button.dataset.available === "false"; });
  }
}

byId("refresh-button").addEventListener("click", refresh);
byId("pilot-pause").addEventListener("click", () => controlPilot("pause"));
byId("pilot-start").addEventListener("click", () => controlPilot("start"));
byId("backend-local").addEventListener("click", () => switchBackend("local"));
byId("backend-deepseek").addEventListener("click", () => switchBackend("deepseek"));
byId("strategic-kimi").addEventListener("click", () => switchStrategicBackend("kimi"));
byId("strategic-deepseek").addEventListener("click", () => switchStrategicBackend("deepseek"));
window.addEventListener("resize", () => {
  if (latestStats) renderCharts(latestStats);
});
refreshComponentHealth();
refreshPilotControl();
refresh();
setInterval(refreshComponentHealth, 10_000);
setInterval(refreshPilotControl, 10_000);
setInterval(refresh, 10_000);
