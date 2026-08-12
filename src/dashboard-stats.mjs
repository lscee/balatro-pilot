import fs from "node:fs";
import path from "node:path";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function localDay(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "unknown";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function activeBlind(state) {
  return Object.values(state?.blinds ?? {}).find((blind) => {
    const status = String(blind?.status ?? "").toUpperCase();
    return status.includes("CURRENT") || status.includes("SELECT");
  }) ?? null;
}

function createUsage() {
  return {
    apiCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target, usage) {
  if (!usage) return;
  for (const key of Object.keys(target)) target[key] += number(usage[key]);
}

function createActions() {
  return {
    total: 0,
    play: 0,
    discard: 0,
    buy: 0,
    sell: 0,
    reroll: 0,
    pack: 0,
    skip: 0,
    select: 0,
    use: 0,
    navigation: 0,
  };
}

function createGame(id, source = "exact", seed = id) {
  return {
    id,
    source,
    seed: source === "exact" ? seed : null,
    runIds: new Set(),
    startedAt: null,
    lastAt: null,
    endedAt: null,
    outcome: "ongoing",
    maxScore: 0,
    maxCompletedScore: 0,
    maxHandScore: 0,
    maxPredictedXMult: 1,
    maxKnownRetriggers: 0,
    buildReadySeen: false,
    maxAnte: 0,
    maxRound: 0,
    maxMoney: 0,
    maxJokers: 0,
    bestBuild: [],
    recordAt: null,
    recordBlind: "",
    clearedRounds: new Set(),
    roundScores: new Map(),
    actions: createActions(),
    usage: createUsage(),
    planningTimes: [],
    strategicPlans: 0,
    routinePlans: 0,
    plannerErrors: 0,
    fallbacks: 0,
    latestState: null,
    victoryCheckpointSeen: false,
  };
}

function serializeGame(game) {
  return {
    id: game.id,
    source: game.source,
    seed: game.seed,
    startedAt: game.startedAt,
    lastAt: game.lastAt,
    endedAt: game.endedAt,
    outcome: game.outcome,
    maxScore: game.maxScore,
    maxCompletedScore: game.maxCompletedScore,
    maxHandScore: game.maxHandScore,
    maxPredictedXMult: game.maxPredictedXMult,
    maxKnownRetriggers: game.maxKnownRetriggers,
    buildReadySeen: game.buildReadySeen,
    maxAnte: game.maxAnte,
    maxRound: game.maxRound,
    maxMoney: game.maxMoney,
    maxJokers: game.maxJokers,
    bestBuild: game.bestBuild,
    recordAt: game.recordAt,
    recordBlind: game.recordBlind,
    blindsCleared: game.clearedRounds.size,
    actions: { ...game.actions },
    usage: { ...game.usage },
    averagePlanningMs: average(game.planningTimes),
    p90PlanningMs: percentile(game.planningTimes, 0.9),
    strategicPlans: game.strategicPlans,
    routinePlans: game.routinePlans,
    plannerErrors: game.plannerErrors,
    fallbacks: game.fallbacks,
    latestState: game.latestState,
    durationMs:
      game.startedAt && (game.endedAt || game.lastAt)
        ? Math.max(0, new Date(game.endedAt || game.lastAt) - new Date(game.startedAt))
        : 0,
  };
}

function gameWindowStats(games) {
  return {
    count: games.length,
    averagePeakScore: average(games.map((game) => game.maxScore)),
    averageAnte: average(games.map((game) => game.maxAnte)),
    averageRound: average(games.map((game) => game.maxRound)),
    winRate: games.length ? games.filter((game) => game.outcome === "won").length / games.length : 0,
  };
}

function changePercent(before, after) {
  if (!before) return after ? null : 0;
  return ((after - before) / Math.abs(before)) * 100;
}

function improvementSummary(completed) {
  const windowSize = Math.min(10, Math.floor(completed.length / 2));
  if (windowSize < 2) {
    return {
      status: "insufficient",
      label: "数据积累中",
      description: "至少需要 4 局完整精确记录才能比较趋势。",
      windowSize,
      previous: gameWindowStats([]),
      recent: gameWindowStats(completed.slice(-windowSize)),
      scoreChangePercent: null,
      anteChange: null,
      roundChange: null,
      winRateChange: null,
    };
  }
  const previous = gameWindowStats(completed.slice(-windowSize * 2, -windowSize));
  const recent = gameWindowStats(completed.slice(-windowSize));
  const scoreChangePercent = changePercent(previous.averagePeakScore, recent.averagePeakScore);
  const anteChange = recent.averageAnte - previous.averageAnte;
  const roundChange = recent.averageRound - previous.averageRound;
  const winRateChange = recent.winRate - previous.winRate;
  const signals = [
    (scoreChangePercent ?? 0) > 5,
    anteChange > 0.15,
    roundChange > 0.4,
    winRateChange > 0.05,
  ];
  const regressions = [
    (scoreChangePercent ?? 0) < -5,
    anteChange < -0.15,
    roundChange < -0.4,
    winRateChange < -0.05,
  ];
  const positive = signals.filter(Boolean).length;
  const negative = regressions.filter(Boolean).length;
  const status =
    positive >= 2 && negative === 0
      ? "improving"
      : negative >= 2 && positive === 0
        ? "declining"
        : positive > 0 && negative > 0
          ? "mixed"
          : "stable";
  const label =
    status === "improving"
      ? "近期在进步"
      : status === "declining"
        ? "近期有回落"
        : status === "mixed"
          ? "近期表现有进有退"
          : "近期基本稳定";
  return {
    status,
    label,
    description: "比较最近 " + windowSize + " 局与此前 " + windowSize + " 局的精确记录。",
    windowSize,
    previous,
    recent,
    scoreChangePercent,
    anteChange,
    roundChange,
    winRateChange,
  };
}

export class DashboardStats {
  constructor(projectRoot, { runsDirectory = path.join(projectRoot, "runs") } = {}) {
    this.projectRoot = projectRoot;
    this.runsDirectory = runsDirectory;
    this.reset();
  }

  reset() {
    this.files = new Map();
    this.runs = new Map();
    this.games = new Map();
    this.episodeToGame = new Map();
    this.globalUsage = createUsage();
    this.globalActions = createActions();
    this.planningTimes = [];
    this.totalEvents = 0;
    this.malformedLines = 0;
    this.liveState = null;
    this.liveAt = null;
    this.lastEventAt = null;
    this.legacyInputAcknowledged = 0;
    this.legacyInputFailed = 0;
    this.plannerErrors = 0;
    this.fallbacks = 0;
    this.strategicPlans = 0;
    this.routinePlans = 0;
  }

  runFor(runId) {
    if (!this.runs.has(runId)) {
      this.runs.set(runId, {
        id: runId,
        dryRun: runId.includes("dry-run"),
        startedAt: null,
        lastAt: null,
        currentEpisodeId: null,
        currentGameKey: null,
        pendingRpcMethod: null,
        scorePredictions: new Map(),
        exact: runId.includes("bot-run") || runId.includes("bot-dry-run"),
      });
    }
    return this.runs.get(runId);
  }

  gameFor(id, source = "exact", seed = id) {
    if (!this.games.has(id)) this.games.set(id, createGame(id, source, seed));
    return this.games.get(id);
  }

  gameForExactState(seed, stateName, run, eventAt) {
    const current = run.currentGameKey ? this.games.get(run.currentGameKey) : null;
    if (current?.source === "exact" && current.seed === seed) {
      const terminal = current.outcome === "won" || current.outcome === "lost";
      const overlapsCompletedAttempt = terminal && eventAt && current.endedAt && eventAt <= current.endedAt;
      if (!terminal || stateName === "GAME_OVER" || overlapsCompletedAttempt) return current;
    }

    const attempts = [...this.games.values()]
      .filter((game) => game.source === "exact" && game.seed === seed)
      .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
    const latest = attempts.at(-1);
    if (latest?.endedAt && eventAt && eventAt <= latest.endedAt) return latest;
    if (latest?.outcome === "ongoing" || (latest && stateName === "GAME_OVER")) return latest;

    const attempt = attempts.length + 1;
    const id = attempt === 1 ? seed : seed + "#" + attempt;
    return this.gameFor(id, "exact", seed);
  }

  refresh() {
    if (!fs.existsSync(this.runsDirectory)) return this.snapshot();
    const eventFiles = fs
      .readdirSync(this.runsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        runId: entry.name,
        file: path.join(this.runsDirectory, entry.name, "events.ndjson"),
      }))
      .filter((entry) => fs.existsSync(entry.file))
      .sort((left, right) => left.runId.localeCompare(right.runId));

    const truncated = eventFiles.some(({ file }) => {
      const cached = this.files.get(file);
      return cached && fs.statSync(file).size < cached.offset;
    });
    if (truncated) this.reset();

    for (const { runId, file } of eventFiles) this.readAppended(runId, file);
    return this.snapshot();
  }

  readAppended(runId, file) {
    const stat = fs.statSync(file);
    const cached = this.files.get(file) ?? { offset: 0, remainder: "" };
    if (stat.size === cached.offset) return;
    const length = stat.size - cached.offset;
    const descriptor = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(length);
    try {
      fs.readSync(descriptor, buffer, 0, length, cached.offset);
    } finally {
      fs.closeSync(descriptor);
    }
    const source = cached.remainder + buffer.toString("utf8");
    const lines = source.split(/\r?\n/);
    const remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.ingest(runId, JSON.parse(line));
      } catch {
        this.malformedLines += 1;
      }
    }
    this.files.set(file, { offset: stat.size, remainder });
  }

  ingest(runId, event) {
    this.totalEvents += 1;
    const run = this.runFor(runId);
    run.startedAt ||= event.at ?? null;
    run.lastAt = event.at ?? run.lastAt;
    if (event.at && (!this.lastEventAt || event.at > this.lastEventAt)) this.lastEventAt = event.at;
    if (run.dryRun) return;

    if (event.type === "bot_session") run.exact = true;
    if (event.type === "semantic_episode_started") {
      run.currentEpisodeId = event.episodeId ?? null;
    }

    if (event.type === "bot_state" && event.state?.seed) {
      const state = event.state;
      const seed = String(state.seed);
      const game = this.gameForExactState(seed, state.state, run, event.at);
      run.currentGameKey = game.id;
      game.runIds.add(runId);
      game.startedAt = !game.startedAt || event.at < game.startedAt ? event.at : game.startedAt;
      game.lastAt = !game.lastAt || event.at > game.lastAt ? event.at : game.lastAt;
      if (run.currentEpisodeId) this.episodeToGame.set(run.currentEpisodeId, game.id);
      this.updateExactGame(game, state, event, run);
      if (!this.liveAt || event.at >= this.liveAt) {
        const blind = activeBlind(state);
        this.liveAt = event.at;
        this.liveState = {
          gameId: game.id,
          state: state.state,
          ante: number(state.ante),
          round: number(state.roundNumber),
          score: number(state.round?.chips),
          target: number(blind?.score),
          blind: blind?.name ?? blind?.type ?? "",
          money: number(state.money),
          handsLeft: number(state.round?.handsLeft),
          discardsLeft: number(state.round?.discardsLeft),
          jokers: (state.jokers?.cards ?? []).map((card) => card.label ?? card.key).filter(Boolean),
          at: event.at,
        };
      }
      return;
    }

    if (event.type === "semantic_episode_completed") {
      const gameKey = this.episodeToGame.get(event.episodeId) ?? run.currentGameKey;
      const game = gameKey ? this.games.get(gameKey) : null;
      if (game) {
        game.outcome = event.outcome === "won" ? "won" : "lost";
        game.endedAt = event.at;
      }
      return;
    }

    const game = run.currentGameKey ? this.games.get(run.currentGameKey) : null;
    if (event.type === "rpc_execute") {
      this.addAction(this.globalActions, event.method);
      if (game) this.addAction(game.actions, event.method);
      run.pendingRpcMethod = event.method ?? null;
    } else if (event.type === "bot_score_prediction") {
      run.scorePredictions.set(Number(event.step), {
        xMult: Math.max(1, number(event.xMult, 1)),
        knownRetriggers: Math.max(0, number(event.knownRetriggers)),
        engineReady: Boolean(event.predictedEngineReady),
      });
      if (run.scorePredictions.size > 24) run.scorePredictions.delete(run.scorePredictions.keys().next().value);
    } else if (event.type === "bot_score_result") {
      const actual = number(event.actual, NaN);
      const prediction = run.scorePredictions.get(Number(event.step));
      if (game && Number.isFinite(actual) && actual >= 0) game.maxHandScore = Math.max(game.maxHandScore, actual);
      if (game && prediction) {
        game.maxPredictedXMult = Math.max(game.maxPredictedXMult, prediction.xMult);
        game.maxKnownRetriggers = Math.max(game.maxKnownRetriggers, prediction.knownRetriggers);
        game.buildReadySeen ||= prediction.engineReady;
      }
      run.scorePredictions.delete(Number(event.step));
    } else if (event.type === "plan") {
      addUsage(this.globalUsage, event.usage);
      if (game) addUsage(game.usage, event.usage);
      const planningMs = number(event.planningMs, NaN);
      if (Number.isFinite(planningMs)) {
        this.planningTimes.push(planningMs);
        if (game) game.planningTimes.push(planningMs);
      }
      if (!game && event.plan?.state && !run.exact) {
        const legacy = this.gameFor("legacy:" + runId, "legacy");
        legacy.runIds.add(runId);
        legacy.startedAt ||= event.at;
        legacy.lastAt = event.at;
        this.updateLegacyGame(legacy, event.plan, event);
      }
    } else if (event.type === "bot_strategy_mode") {
      if (event.strategic) {
        this.strategicPlans += 1;
        if (game) game.strategicPlans += 1;
      } else {
        this.routinePlans += 1;
        if (game) game.routinePlans += 1;
      }
    } else if (event.type === "bot_planner_error") {
      this.plannerErrors += 1;
      if (game) game.plannerErrors += 1;
    } else if (event.type === "bot_planner_fallback") {
      this.fallbacks += 1;
      if (game) game.fallbacks += 1;
    } else if (event.type === "input_ack") {
      if (event.acknowledged) this.legacyInputAcknowledged += 1;
      else this.legacyInputFailed += 1;
    }
  }

  addAction(target, method) {
    target.total += 1;
    if (Object.hasOwn(target, method)) target[method] += 1;
    else if (new Set(["start", "menu", "cash_out", "next_round"]).has(method)) target.navigation += 1;
  }

  updateExactGame(game, state, event, run) {
    const ante = number(state.ante);
    const round = number(state.roundNumber);
    const score = number(state.round?.chips);
    const money = number(state.money);
    const jokerCards = state.jokers?.cards ?? [];
    const blind = activeBlind(state);
    game.maxAnte = Math.max(game.maxAnte, ante);
    game.maxRound = Math.max(game.maxRound, round);
    game.maxMoney = Math.max(game.maxMoney, money);
    game.maxJokers = Math.max(game.maxJokers, number(state.jokers?.count, jokerCards.length));
    game.latestState = state.state;

    if (score > game.maxScore) {
      game.maxScore = score;
      game.recordAt = event.at;
      const defeatedBlind = Object.values(state.blinds ?? {})
        .filter((candidate) => String(candidate?.status ?? "").toUpperCase() === "DEFEATED")
        .toSorted((left, right) => number(right?.score) - number(left?.score))[0];
      game.recordBlind = blind?.name ?? blind?.type ?? defeatedBlind?.name ?? defeatedBlind?.type ?? "";
      game.bestBuild = jokerCards.map((card) => card.label ?? card.key).filter(Boolean);
    }

    const roundKey = ante + ":" + round;
    const previousScore = game.roundScores.get(roundKey);
    if (previousScore != null && score > previousScore && run.pendingRpcMethod === "play") {
      game.maxHandScore = Math.max(game.maxHandScore, score - previousScore);
    }
    game.roundScores.set(roundKey, Math.max(previousScore ?? 0, score));
    run.pendingRpcMethod = null;

    if (state.state === "ROUND_EVAL" && score > 0) {
      game.maxCompletedScore = Math.max(game.maxCompletedScore, score);
      game.clearedRounds.add(roundKey);
      if (state.won === true) game.victoryCheckpointSeen = true;
    }
    if (state.state === "GAME_OVER") {
      // `won` is historical in Balatro and may be set before an Ante-8 Boss
      // failure enters GAME_OVER. Only an observed ROUND_EVAL+won checkpoint
      // proves that the run actually cleared the win Ante.
      game.outcome = game.victoryCheckpointSeen ? "won" : "lost";
      game.endedAt = event.at;
    }
  }

  updateLegacyGame(game, plan, event) {
    const state = plan.state ?? {};
    game.maxScore = Math.max(game.maxScore, number(state.score));
    game.maxAnte = Math.max(game.maxAnte, number(state.ante));
    game.maxRound = Math.max(game.maxRound, number(state.round));
    game.maxMoney = Math.max(game.maxMoney, number(state.money));
    game.latestState = plan.screen ?? "unknown";
    if (state.outcome === "won" || state.outcome === "lost") {
      game.outcome = state.outcome;
      game.endedAt = event.at;
    }
  }

  snapshot() {
    const exact = [...this.games.values()]
      .filter((game) => game.source === "exact")
      .map(serializeGame)
      .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
    for (const game of exact) {
      if (game.outcome === "ongoing" && game.id !== this.liveState?.gameId) {
        game.outcome = "interrupted";
      }
    }
    const legacy = [...this.games.values()].filter((game) => game.source === "legacy").map(serializeGame);
    const completed = exact.filter((game) => game.outcome === "won" || game.outcome === "lost");
    const interrupted = exact.filter((game) => game.outcome === "interrupted");
    const wins = completed.filter((game) => game.outcome === "won").length;
    const bestScoreGame = exact.toSorted((left, right) => right.maxScore - left.maxScore)[0] ?? null;
    const bestHandGame = exact.toSorted((left, right) => right.maxHandScore - left.maxHandScore)[0] ?? null;
    const deepestGame = exact.toSorted(
      (left, right) => right.maxAnte - left.maxAnte || right.maxRound - left.maxRound || right.maxScore - left.maxScore,
    )[0] ?? null;
    const cumulativeBest = [];
    const cumulativeBestHand = [];
    let record = 0;
    let handRecord = 0;
    for (const game of completed) {
      record = Math.max(record, game.maxScore);
      handRecord = Math.max(handRecord, game.maxHandScore);
      cumulativeBest.push({ at: game.endedAt ?? game.lastAt, value: record });
      cumulativeBestHand.push({ at: game.endedAt ?? game.lastAt, value: handRecord });
    }
    const milestone = (threshold) => {
      const achieved = completed.filter((game) => game.maxHandScore >= threshold);
      return {
        games: achieved.length,
        rate: completed.length ? achieved.length / completed.length : 0,
        firstAt: achieved[0]?.endedAt ?? achieved[0]?.lastAt ?? null,
      };
    };
    const dailyMap = new Map();
    for (const game of completed) {
      const day = localDay(game.endedAt ?? game.lastAt);
      if (!dailyMap.has(day)) dailyMap.set(day, []);
      dailyMap.get(day).push(game);
    }
    const daily = [...dailyMap.entries()].map(([day, games]) => {
      const stats = gameWindowStats(games);
      return {
        day,
        games: games.length,
        wins: games.filter((game) => game.outcome === "won").length,
        averagePeakScore: stats.averagePeakScore,
        averageAnte: stats.averageAnte,
        averageRound: stats.averageRound,
        bestScore: Math.max(...games.map((game) => game.maxScore)),
      };
    });
    const recentGames = exact
      .toSorted((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)))
      .slice(0, 30);
    const legacyMax = {
      score: Math.max(0, ...legacy.map((game) => game.maxScore)),
      ante: Math.max(0, ...legacy.map((game) => game.maxAnte)),
      round: Math.max(0, ...legacy.map((game) => game.maxRound)),
      sessions: legacy.length,
    };
    const cacheRate = this.globalUsage.inputTokens
      ? this.globalUsage.cachedInputTokens / this.globalUsage.inputTokens
      : 0;
    const actionTotal = this.legacyInputAcknowledged + this.legacyInputFailed;
    const completedHands = completed.reduce((sum, game) => sum + game.actions.play, 0);
    const completedDiscards = completed.reduce((sum, game) => sum + game.actions.discard, 0);
    return {
      generatedAt: new Date().toISOString(),
      overview: {
        exactGames: exact.length,
        completedGames: completed.length,
        ongoingGames: exact.filter((game) => game.outcome === "ongoing").length,
        interruptedGames: interrupted.length,
        wins,
        losses: completed.length - wins,
        winRate: completed.length ? wins / completed.length : 0,
        highestScore: bestScoreGame?.maxScore ?? 0,
        highestScoreGame: bestScoreGame,
        highestCompletedScore: Math.max(0, ...exact.map((game) => game.maxCompletedScore)),
        highestHandScore: bestHandGame?.maxHandScore ?? 0,
        highestHandGame: bestHandGame,
        highestAnte: deepestGame?.maxAnte ?? 0,
        highestRound: Math.max(0, ...exact.map((game) => game.maxRound)),
        deepestGame,
        blindsCleared: exact.reduce((sum, game) => sum + game.blindsCleared, 0),
        peakMoney: Math.max(0, ...exact.map((game) => game.maxMoney)),
        peakJokers: Math.max(0, ...exact.map((game) => game.maxJokers)),
      },
      live: this.liveState,
      improvement: improvementSummary(completed),
      trend: completed.map((game, index) => ({
        game: index + 1,
        at: game.endedAt ?? game.lastAt,
        outcome: game.outcome,
        maxScore: game.maxScore,
        maxHandScore: game.maxHandScore,
        cumulativeBestHand: Math.max(0, ...completed.slice(0, index + 1).map((item) => item.maxHandScore)),
        maxPredictedXMult: game.maxPredictedXMult,
        maxKnownRetriggers: game.maxKnownRetriggers,
        buildReadySeen: game.buildReadySeen,
        maxAnte: game.maxAnte,
        maxRound: game.maxRound,
        blindsCleared: game.blindsCleared,
        averagePlanningMs: game.averagePlanningMs,
      })),
      cumulativeBest,
      cumulativeBestHand,
      highScore: {
        milestones: {
          tenThousand: milestone(10_000),
          hundredThousand: milestone(100_000),
          million: milestone(1_000_000),
        },
        peakPredictedXMult: Math.max(1, ...exact.map((game) => game.maxPredictedXMult)),
        peakKnownRetriggers: Math.max(0, ...exact.map((game) => game.maxKnownRetriggers)),
        buildReadyGames: completed.filter((game) => game.buildReadySeen).length,
        buildReadyRate: completed.length
          ? completed.filter((game) => game.buildReadySeen).length / completed.length
          : 0,
      },
      daily,
      recentGames,
      gameplay: {
        actions: { ...this.globalActions },
        averageHandsPerCompletedGame: completed.length
          ? completedHands / completed.length
          : 0,
        averageDiscardsPerCompletedGame: completed.length
          ? completedDiscards / completed.length
          : 0,
      },
      model: {
        usage: { ...this.globalUsage },
        cacheRate,
        averagePlanningMs: average(this.planningTimes),
        medianPlanningMs: percentile(this.planningTimes, 0.5),
        p90PlanningMs: percentile(this.planningTimes, 0.9),
        strategicPlans: this.strategicPlans,
        routinePlans: this.routinePlans,
        plannerErrors: this.plannerErrors,
        fallbacks: this.fallbacks,
      },
      reliability: {
        legacyInputAcknowledged: this.legacyInputAcknowledged,
        legacyInputFailed: this.legacyInputFailed,
        legacyInputAckRate: actionTotal ? this.legacyInputAcknowledged / actionTotal : 0,
      },
      coverage: {
        runDirectories: this.runs.size,
        eventFiles: this.files.size,
        totalEvents: this.totalEvents,
        malformedLines: this.malformedLines,
        indexedBytes: [...this.files.values()].reduce((sum, item) => sum + item.offset, 0),
        lastEventAt: this.lastEventAt,
        legacy: legacyMax,
      },
    };
  }
}
