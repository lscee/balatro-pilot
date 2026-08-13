import path from "node:path";

import {
  BalatrobotProtocolError,
  BalatrobotRpcError,
  BalatrobotTransportError,
} from "./balatrobot-client.mjs";
import {
  balatrobotStateFingerprint,
  compactBalatrobotState,
  deterministicBalatrobotAction,
  fallbackBalatrobotAction,
  legacyPlanForBalatrobot,
  sanitizeCollectionAwareRunPlan,
  validateBalatrobotPlan,
} from "./balatrobot-policy.mjs";
import {
  assertBalatrobotCandidateAction,
  balatrobotThinkingMode,
  filterBalatrobotExecutableCandidates,
  generateBalatrobotCandidates,
} from "./balatrobot-solver.mjs";
import { BalatroRunCardTracker, contextualBalatrobotState } from "./balatro-profile.mjs";
import { selectBalatroDeck } from "./balatro-deck-selector.mjs";
import { mergeUsage } from "./planner.mjs";
import { RunLog } from "./run-log.mjs";
import { semanticPlayedHandScore, semanticTerminalOutcome } from "./semantic-experience.mjs";

const LEARNABLE_METHODS = new Set([
  "select",
  "skip",
  "play",
  "discard",
  "buy",
  "sell",
  "reroll",
  "next_round",
  "use",
  "rearrange",
  "pack",
]);
const MODEL_STATES = new Set(["BLIND_SELECT", "SELECTING_HAND", "SHOP", "SMODS_BOOSTER_OPENED"]);
const STRATEGIC_SHOP_METHODS = new Set(["buy", "sell", "reroll"]);

function checkpointSegment(value, fallback = "unknown") {
  const normalized = String(value ?? "").trim().replaceAll(":", "_").replaceAll("|", "_");
  return normalized || fallback;
}

function openedPackCheckpointIdentity(state) {
  const cards = Array.isArray(state?.pack?.cards) ? state.pack.cards : [];
  const offered = cards.map((card, arrayIndex) => [
    Number.isInteger(card?.index) ? card.index : arrayIndex,
    checkpointSegment(card?.id, "no-id"),
    checkpointSegment(card?.key ?? card?.label, "unknown-card"),
  ].join("_")).join("|") || "empty";
  const count = Number.isFinite(Number(state?.pack?.count)) ? Number(state.pack.count) : cards.length;
  const limit = Number.isFinite(Number(state?.pack?.limit)) ? Number(state.pack.limit) : cards.length;
  return `${count}:${limit}:${offered}`;
}

function currentMouthBlind(state) {
  const blinds = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss].filter(Boolean);
  const blind = blinds.find((item) => String(item?.status ?? "").toUpperCase().includes("CURRENT"));
  return String(blind?.name ?? "").trim().toLowerCase() === "the mouth" ? blind : null;
}

export function latchBalatrobotMouthLock(state, cache) {
  const blind = currentMouthBlind(state);
  if (!blind) {
    cache.blindKey = null;
    cache.handType = null;
    return null;
  }
  const blindKey = [state?.seed ?? "", state?.ante_num ?? state?.ante ?? "", state?.round_num ?? state?.roundNumber ?? "", "the-mouth"].join(":");
  if (cache.blindKey !== blindKey) {
    cache.blindKey = blindKey;
    cache.handType = null;
  }
  const explicit = String(blind?.only_hand ?? blind?.onlyHand ?? "").trim();
  if (!cache.handType && explicit) cache.handType = explicit;
  if (!cache.handType) {
    const hands = new Set([...Object.keys(state?.hands ?? {}), ...Object.keys(state?.pokerHands ?? {})]);
    const positive = [...hands].filter((handType) => {
      const legacy = state?.hands?.[handType];
      const exact = state?.pokerHands?.[handType];
      return Math.max(
        Number(legacy?.played_this_round ?? legacy?.playedThisRound) || 0,
        Number(exact?.played_this_round ?? exact?.playedThisRound) || 0,
      ) > 0;
    });
    if (positive.length === 1) cache.handType = positive[0];
  }
  if (cache.handType) {
    Object.defineProperty(state, "__mouthLockedHandType", {
      value: cache.handType,
      configurable: true,
      enumerable: false,
    });
  }
  return cache.handType;
}

function abortError(signal) {
  const error = new Error(signal?.reason?.message ?? "Stopped by Ctrl+C");
  error.name = "AbortError";
  return error;
}

async function sleep(ms, signal) {
  if (!ms) return;
  if (signal?.aborted) throw abortError(signal);
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assertGameState(value, method) {
  if (!value || typeof value !== "object" || typeof value.state !== "string") {
    throw new Error(`BalatroBot ${method} did not return a GameState object`);
  }
  return value;
}

function stateLabel(state) {
  return `${state.state} | Ante ${state.ante_num ?? "?"}, Round ${state.round_num ?? "?"}, $${state.money ?? "?"}`;
}

function usageLabel(usage) {
  const cached = usage.cachedInputTokens ? `, cache hit ${usage.cachedInputTokens}` : "";
  const missed = usage.cacheMissTokens ? `, cache miss ${usage.cacheMissTokens}` : "";
  const reasoning = usage.reasoningTokens ? `, reasoning ${usage.reasoningTokens}` : "";
  return `${usage.apiCalls} call(s), input ${usage.inputTokens}${cached}${missed}, output ${usage.outputTokens}${reasoning}, total ${usage.totalTokens}`;
}

function actionLabel(action) {
  const params = Object.keys(action.params ?? {}).length ? ` ${JSON.stringify(action.params)}` : "";
  return `${action.method}${params}`;
}

function actionSignature(action) {
  return `${action.method}:${JSON.stringify(action.params ?? {})}`;
}

function candidateAction(candidate) {
  const { method, ...params } = candidate?.action ?? {};
  return method ? { method, params } : null;
}

function candidateForAction(action, candidates) {
  const signature = actionSignature(action);
  return (Array.isArray(candidates) ? candidates : []).find((candidate) => {
    const compiled = candidateAction(candidate);
    return compiled && actionSignature(compiled) === signature;
  }) ?? null;
}

function resolveApprovedShopContinuation(state, candidates, pending) {
  if (!pending || state?.state !== "SHOP") return { action: null, reason: "left approved shop scope" };
  const matches = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
    candidate.action?.method === "buy" &&
    candidate.action?.card != null &&
    (pending.id != null
      ? String(candidate.card?.id ?? "") === String(pending.id)
      : String(candidate.card?.key ?? "") === pending.key &&
        String(candidate.card?.edition ?? "") === String(pending.edition ?? "")) &&
    Number(candidate.card?.price) <= pending.maxPrice);
  if (matches.length !== 1) {
    return { action: null, reason: matches.length ? "replacement identity is ambiguous" : "replacement is absent or above approved price" };
  }
  return { action: candidateAction(matches[0]), candidate: matches[0], reason: "approved exact replacement" };
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === "AbortError";
}

function plannerBackoffMs(failures, config) {
  const base = Math.max(0, Number(config.balatrobotPollMs) || 0);
  return Math.min(5_000, base * 2 ** Math.min(Math.max(0, failures - 1), 6));
}

export function strategicCheckpointScope(state, thinkingMode) {
  if (!thinkingMode?.strategic) return null;
  const run = state?.seed ?? "unseeded";
  const ante = state?.ante_num ?? state?.ante ?? "?";
  const round = state?.round_num ?? state?.roundNumber ?? "?";
  if (state?.state === "SELECTING_HAND") {
    // One strategic package covers the whole blind. Local candidates and the
    // fast routine ranker handle later hands, including last-hand rescue, so
    // K3 cannot be called four times for the same Boss.
    return `${run}:hand:${ante}:${round}`;
  }
  if (state?.state === "SHOP") {
    // One Kimi strategy package covers ordinary purchase/sale/reroll choices
    // for the whole shop visit. The contents of a purchased booster are not
    // known yet and therefore deliberately get their own checkpoint below.
    return `${run}:shop:${ante}:${round}`;
  }
  if (state?.state === "SMODS_BOOSTER_OPENED") {
    // A booster choice is a new strategic decision, independent from the shop
    // decision that bought it. Key the scope only by the exact offered cards,
    // not the whole dynamic state, so unrelated counters cannot cause repeated
    // K3 calls. Mega packs naturally get a second checkpoint when the first
    // selection changes their remaining contents.
    return `${run}:pack:${ante}:${round}:${openedPackCheckpointIdentity(state)}`;
  }
  if (state?.state === "BLIND_SELECT") {
    const selectable = [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss]
      .filter(Boolean)
      .find((blind) => String(blind.status ?? "").toUpperCase().includes("SELECT"));
    const blindIdentity = [
      selectable?.type,
      selectable?.name,
      selectable?.tagName ?? selectable?.tag_name ?? selectable?.tag?.name,
    ]
      .map((value) => String(value ?? "").trim().replaceAll(":", "_"))
      .filter(Boolean)
      .join(":") || "unknown";
    return `${run}:blind:${ante}:${round}:${blindIdentity}`;
  }
  return `${run}:${state?.state ?? "unknown"}:${ante}:${round}`;
}

function applyStrategicCheckpoint(state, thinkingMode, completedScopes, config, checkpointStore = null) {
  const scope = strategicCheckpointScope(state, thinkingMode);
  if (!scope) return thinkingMode;
  const persisted = checkpointStore?.has?.(state?.seed, scope) ?? false;
  if (!completedScopes.has(scope) && !persisted) {
    return { ...thinkingMode, checkpointScope: scope };
  }
  return {
    strategic: false,
    effort: config.balatrobotRoutineReasoningEffort ?? config.balatrobotReasoningEffort ?? "none",
    reason: "strategic checkpoint already established for this state phase",
    checkpointScope: scope,
    reusedCheckpoint: true,
  };
}

function isUncertainActionError(error) {
  return error instanceof BalatrobotTransportError || error instanceof BalatrobotProtocolError;
}

function validatedStuckPackSkip(state) {
  const plan = validateBalatrobotPlan(
    {
      observation: "The same open pack state remained unchanged after two independent RPC outcome checks.",
      strategy: "Use the pack's local Skip action once instead of replaying another uncertain card choice.",
      confidence: 1,
      actions: [{ method: "pack", skip: true, reason: "Circuit breaker: skip a stuck open pack once" }],
    },
    state,
  );
  return { action: plan.actions[0], plan };
}

async function reconcileGamestate({ client, config, log, step, signal }) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return assertGameState(await client.gamestate({ signal }), "gamestate reconciliation");
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      lastError = error;
      log.event("rpc_reconcile_read_error", { step, attempt, error: error.message });
      if (attempt < 3) {
        const delayMs = Math.min(2_000, Math.max(100, Number(config.balatrobotPollMs) || 0) * 2 ** (attempt - 1));
        await sleep(delayMs, signal);
      }
    }
  }
  throw new Error("Could not reconcile BalatroBot state after an uncertain RPC outcome; stopping to avoid replay", {
    cause: lastError,
  });
}

function planningErrorEvent(error) {
  return {
    message: error.message,
    code: error.code ?? null,
    provider: error.provider ?? null,
    model: error.model ?? null,
    timeoutMs: error.timeoutMs ?? null,
    elapsedMs: error.elapsedMs ?? null,
    attempt: error.attempt ?? null,
    responseId: error.responseId ?? null,
    finishReason: error.finishReason ?? null,
    usage: error.usage ?? mergeUsage(),
  };
}

async function planSemanticAction({
  planner,
  state,
  compactState,
  step,
  memory,
  runPlan,
  previousError,
  experienceContext,
  candidates,
  thinkingMode,
  collectionKnowledge,
  appearedThisRun,
  config,
  log,
  signal,
}) {
  const startedAt = performance.now();
  const minimumConfidence = config.balatrobotMinimumConfidence ?? config.minimumConfidence;
  const primaryMaxOutputTokens = thinkingMode.strategic
    ? config.balatrobotStrategicMaxOutputTokens
    : config.maxOutputTokens;
  let first;
  try {
    first = await planner.planState({
      gameState: compactState,
      step,
      memory,
      runPlan,
      previousError,
      experienceContext,
      candidateContext: candidates.length ? JSON.stringify(candidates) : "",
      reasoningEffort: thinkingMode.effort,
      maxOutputTokens: primaryMaxOutputTokens,
      signal,
    });
  } catch (error) {
    log.event("bot_planner_error", { step, ...planningErrorEvent(error) });
    throw error;
  }
  let usage = first.usage;
  try {
    const plan = validateBalatrobotPlan(first.plan, state, {
      minimumConfidence,
      allowBlindSkip: Boolean(thinkingMode.strategic),
      collectionKnowledge,
      appearedThisRun,
    });
    assertBalatrobotCandidateAction(plan.actions[0], candidates, state);
    return { plan, usage, attempts: first.attempts, planningMs: performance.now() - startedAt, corrected: false };
  } catch (validationError) {
    log.event("bot_plan_rejected", { step, error: validationError.message, candidate: first.plan, usage: first.usage });
    console.log(`  Candidate semantic action rejected locally: ${validationError.message}`);
    console.log("  Requesting one corrected semantic action from the same exact state...");
    let corrected;
    try {
      corrected = await planner.planState({
        gameState: compactState,
        step,
        memory,
        runPlan,
        previousError: validationError.message,
        experienceContext,
        candidateContext: candidates.length ? JSON.stringify(candidates) : "",
        reasoningEffort: thinkingMode.strategic
          ? thinkingMode.effort
          : config.balatrobotRoutineReasoningEffort ?? "none",
        maxOutputTokens: config.maxOutputTokens,
        signal,
      });
      usage = mergeUsage(usage, corrected.usage);
      const plan = validateBalatrobotPlan(corrected.plan, state, {
        minimumConfidence,
        allowBlindSkip: Boolean(thinkingMode.strategic),
        collectionKnowledge,
        appearedThisRun,
      });
      assertBalatrobotCandidateAction(plan.actions[0], candidates, state);
      return {
        plan,
        usage,
        attempts: [...(first.attempts ?? []), ...(corrected.attempts ?? [])],
        planningMs: performance.now() - startedAt,
        corrected: true,
      };
    } catch (correctionError) {
      if (isAbort(correctionError, signal)) throw correctionError;
      if (corrected?.usage) usage = mergeUsage(first.usage, corrected.usage);
      log.event("bot_plan_correction_rejected", {
        step,
        error: correctionError.message,
        candidate: corrected?.plan ?? null,
        usage,
      });
      if (!corrected) {
        correctionError.usage = mergeUsage(first.usage, correctionError.usage);
        throw correctionError;
      }
      const fallback = fallbackBalatrobotAction(state);
      if (!fallback) throw correctionError;
      console.warn(`  [warn] Corrected semantic action was invalid: ${correctionError.message}`);
      console.warn(`  Using legal local fallback: ${actionLabel(fallback)}`);
      return {
        plan: {
          observation: "Two model actions were rejected locally; using a legal progress fallback.",
          strategy: fallback.reason,
          memory,
          runPlan,
          confidence: 1,
          actions: [fallback],
        },
        usage,
        attempts: [...(first.attempts ?? []), ...(corrected?.attempts ?? [])],
        planningMs: performance.now() - startedAt,
        corrected: false,
        fallback: true,
      };
    }
  }
}

function compiledCandidateReason(candidate) {
  const action = candidate?.action ?? {};
  const label = candidate?.card?.label || candidate?.card?.key || candidate?.id || "本地候选";
  switch (action.method) {
    case "play":
      return `选择本地已验证的${candidate.handType || "出牌"}候选`;
    case "discard":
      return "选择本地已验证的换牌候选";
    case "buy":
      return `购买${label}`;
    case "pack":
      return action.skip ? "没有安全选项，跳过卡包" : `选择${label}`;
    case "reroll":
      return "按生存预算重掷商店";
    case "next_round":
      return "保留资金并进入下一回合";
    case "select":
      return "挑战当前盲注";
    default:
      return `执行本地已验证候选${candidate?.id || ""}`.slice(0, 80);
  }
}

function strategicUnavailableShopExit({ memory, runPlan, usage, attempts = [], planningMs = 0, reason = "" } = {}) {
  const action = {
    method: "next_round",
    params: {},
    reason: "Strategic approval unavailable; preserve money and leave the shop",
  };
  return {
    plan: {
      observation: "A build-changing shop action cannot execute without the strategic planner.",
      strategy: action.reason,
      memory,
      runPlan,
      confidence: 1,
      actions: [action],
    },
    usage: mergeUsage(usage),
    attempts,
    planningMs,
    safeStrategicExit: true,
    blockedReason: String(reason || "strategic approval unavailable").slice(0, 300),
  };
}

async function planRankedCandidate({
  planner,
  state,
  compactState,
  step,
  memory,
  runPlan,
  candidates,
  thinkingMode,
  collectionKnowledge,
  appearedThisRun,
  config,
  log,
  signal,
}) {
  const startedAt = performance.now();
  let ranked;
  try {
    ranked = await planner.rankCandidate({
      gameState: compactState,
      step,
      memory,
      runPlan,
      candidateContext: JSON.stringify(candidates),
      reasoningEffort: thinkingMode.effort,
      maxOutputTokens: Math.min(256, Number(config.maxOutputTokens) || 256),
      signal,
    });
  } catch (error) {
    log.event("bot_candidate_rank_error", { step, ...planningErrorEvent(error) });
    throw error;
  }
  const selectedCandidate = candidates.find((candidate) => candidate.id === ranked.candidateId);
  if (!selectedCandidate) {
    const error = new Error(`Candidate ranker returned an unknown id: ${ranked.candidateId || "none"}`);
    error.usage = ranked.usage;
    throw error;
  }
  const { method, ...params } = selectedCandidate.action ?? {};
  const reason = compiledCandidateReason(selectedCandidate);
  const rawAction = { method, ...params, reason };
  const plan = validateBalatrobotPlan(
    {
      observation: `高频模型只排序本地合法候选，选择 ${selectedCandidate.id}。`,
      strategy: reason,
      memory,
      runPlan,
      confidence: 1,
      actions: [rawAction],
    },
    state,
    {
      minimumConfidence: config.balatrobotMinimumConfidence ?? config.minimumConfidence,
      allowBlindSkip: false,
      collectionKnowledge,
      appearedThisRun,
    },
  );
  assertBalatrobotCandidateAction(plan.actions[0], candidates, state);
  log.event("bot_candidate_ranked", {
    step,
    candidateId: selectedCandidate.id,
    reason: ranked.reason ?? "",
    requiresStrategic: Boolean(selectedCandidate.requiresStrategic),
  });
  return {
    plan,
    usage: ranked.usage ?? mergeUsage(),
    attempts: ranked.attempts ?? [],
    planningMs: performance.now() - startedAt,
    corrected: false,
    candidateRank: true,
    selectedCandidate,
    rankReason: ranked.reason ?? "",
  };
}

async function captureFailureScreenshot(client, log, step, signal) {
  const screenshotPath = path.join(log.dir, `failure-${String(step).padStart(4, "0")}.png`);
  try {
    const result = await client.call("screenshot", { path: screenshotPath }, { signal });
    log.event("bot_failure_screenshot", { step, path: result?.path ?? screenshotPath });
    return result?.path ?? screenshotPath;
  } catch (error) {
    log.event("bot_failure_screenshot_error", { step, error: error.message });
    return null;
  }
}

function isUnlockOverlayMismatch(state, action, error) {
  return (
    state?.state === "BLIND_SELECT" &&
    action?.method === "select" &&
    /select\(\) called with no blind on deck/i.test(String(error?.message ?? ""))
  );
}

export async function runBalatrobot({
  projectRoot,
  config,
  client,
  planner,
  strategicPlanner = planner,
  strategicCheckpointStore = null,
  experienceStore = null,
  profileReader = null,
  runCardTracker = new BalatroRunCardTracker(),
  overlayController = null,
  dryRun = false,
  maxSteps = Number.POSITIVE_INFINITY,
  signal: externalSignal,
  log = new RunLog(projectRoot, dryRun ? "bot-dry-run" : "bot-run"),
} = {}) {
  if (!client || typeof client.gamestate !== "function" || typeof client.call !== "function") {
    throw new TypeError("runBalatrobot requires a BalatrobotClient-compatible client");
  }
  if (!planner || typeof planner.planState !== "function") {
    throw new TypeError("runBalatrobot requires a planner with planState()");
  }
  if (!strategicPlanner || typeof strategicPlanner.planState !== "function") {
    throw new TypeError("runBalatrobot requires a strategicPlanner with planState()");
  }
  if (maxSteps !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000)) {
    throw new Error("--steps must be an integer between 1 and 10000");
  }

  const controller = new AbortController();
  const relayAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", relayAbort, { once: true });
  if (externalSignal?.aborted) relayAbort();
  const onSigint = () => controller.abort(new Error("Stopped by Ctrl+C"));
  if (!externalSignal) process.once("SIGINT", onSigint);
  const signal = controller.signal;
  let cumulativeUsage = mergeUsage();
  let memory = "";
  let runPlan = null;
  let previousError = "";
  let repeatedRpcFailureKey = "";
  let repeatedRpcFailures = 0;
  let plannerFailures = 0;
  let uncertainAction = null;
  let transitionState = "";
  let transitionStartedAt = 0;
  let transitionPolls = 0;
  let state = null;
  const mouthLockCache = { blindKey: null, handType: null };
  let collectionKnowledge = null;
  let appearedThisRun = runCardTracker.snapshot();
  let scoreBenchmarks = [];
  const scoreBenchmarkKeys = new Set();
  const strategicCheckpointScopes = new Set();
  const runId = path.basename(log.dir);
  let episodeIndex = 1;
  let episodeId = null;
  let victoryCheckpointSeen = false;
  let victoryOverlayDismissed = false;
  let approvedShopContinuation = null;

  const stopAfterUncertainRpc = async ({ step, method, fingerprint, reason, params = null }) => {
    log.event("rpc_uncertain_safe_stop", {
      step,
      method,
      params,
      stateFingerprint: fingerprint,
      reason,
    });
    console.warn(`  [warn] ${reason} Controller stopped safely without replaying ${method}.`);
    return { state, usage: cumulativeUsage, logDir: log.dir, stoppedReason: reason };
  };

  const refreshRunKnowledge = (currentState) => {
    collectionKnowledge = profileReader?.snapshot?.() ?? collectionKnowledge;
    appearedThisRun = runCardTracker.observe(currentState);
    return contextualBalatrobotState(currentState, collectionKnowledge, appearedThisRun);
  };

  const beginEpisode = (episodeState) => {
    if (!episodeState) return;
    if (episodeState.state === "MENU" || semanticTerminalOutcome(episodeState, { victoryCheckpointSeen })) return;
    if (!episodeId) strategicCheckpointScopes.clear();
    if (dryRun || !experienceStore?.enabled || episodeId) return;
    episodeId = `${runId}:${episodeIndex}`;
    try {
      experienceStore.beginEpisode({ episodeId, runId, state: episodeState });
      log.event("semantic_episode_started", { episodeId, state: episodeState.state });
    } catch (error) {
      console.warn(`[warn] Semantic episode could not be started: ${error.message}`);
      episodeId = null;
    }
  };

  const finalizeEpisode = (episodeState) => {
    if (dryRun || !experienceStore?.enabled || !episodeId) return;
    const outcome = semanticTerminalOutcome(episodeState, { victoryCheckpointSeen });
    if (!outcome) return;
    try {
      const completed = experienceStore.finalizeEpisode(episodeId, outcome, episodeState);
      if (completed) {
        log.event("semantic_episode_completed", completed);
        console.log(`  Learning: finalized ${outcome} episode with ${completed.transitions} confirmed transition(s).`);
      }
    } catch (error) {
      console.warn(`[warn] Semantic episode finalization failed: ${error.message}`);
      return;
    }
    episodeId = null;
    episodeIndex += 1;
  };

  const recordTransition = ({ step, beforeState, action, afterState, source, plan, usage, handScore }) => {
    if (dryRun || !experienceStore?.enabled || !episodeId || !LEARNABLE_METHODS.has(action.method)) return;
    if (balatrobotStateFingerprint(beforeState) === balatrobotStateFingerprint(afterState)) return;
    try {
      const recorded = experienceStore.recordTransition({
        runId,
        episodeId,
        step,
        state: beforeState,
        action,
        nextState: afterState,
        source,
        plan,
        usage,
        handScore,
      });
      if (recorded) log.event("semantic_transition_recorded", { step, episodeId, ...recorded, source });
    } catch (error) {
      console.warn(`[warn] Semantic transition write failed and was skipped: ${error.message}`);
    }
  };

  const commitAppliedAction = ({ step, beforeState, action, afterState, source, plan, usage, checkpointScope, selectedCandidate }) => {
    const afterSemanticState = refreshRunKnowledge(afterState);
    if (afterState?.state === "ROUND_EVAL" && afterState?.won === true) victoryCheckpointSeen = true;
    if (action.method === "endless") victoryOverlayDismissed = true;
    if (action.method === "start") beginEpisode(afterSemanticState);
    const handScore = semanticPlayedHandScore(beforeState, action, afterSemanticState);
    recordTransition({ step, beforeState, action, afterState: afterSemanticState, source, plan, usage, handScore });
    finalizeEpisode(afterSemanticState);
    memory = String(plan.memory || memory).slice(0, 350);
    runPlan = plan.runPlan ?? runPlan;
    // A strategic checkpoint is real only after its approved RPC changed the
    // exact game state. Marking it while still planning caused stale/rejected
    // actions and safe shop exits to suppress the next required K3 decision.
    if (checkpointScope && source === "balatrobot_model_strategic") {
      strategicCheckpointScopes.add(checkpointScope);
      try {
        strategicCheckpointStore?.mark?.(afterState?.seed, checkpointScope, runPlan);
        log.event("bot_strategic_checkpoint_committed", { step, checkpointScope, method: action.method });
      } catch (error) {
        log.event("bot_strategic_checkpoint_write_error", { step, error: error.message });
      }
    }
    if (
      beforeState?.state === "SHOP" &&
      action.method === "sell" &&
      source === "balatrobot_model_strategic" &&
      selectedCandidate?.replacement?.key
    ) {
      approvedShopContinuation = {
        scope: checkpointScope,
        id: selectedCandidate.replacement.id ?? null,
        key: String(selectedCandidate.replacement.key),
        edition: String(selectedCandidate.replacement.edition ?? ""),
        maxPrice: Number(selectedCandidate.replacement.price),
        approvedAtStep: step,
      };
      log.event("bot_shop_sequence_approved", { step, ...approvedShopContinuation });
    } else if (source === "balatrobot_checkpoint_sequence" && action.method === "buy") {
      approvedShopContinuation = null;
      log.event("bot_shop_sequence_completed", { step, method: action.method });
    }
    if (afterState?.state !== "SHOP") approvedShopContinuation = null;
    if (action.method === "menu" || action.method === "start") {
      memory = "";
      runPlan = null;
      scoreBenchmarks = [];
      scoreBenchmarkKeys.clear();
      victoryCheckpointSeen = false;
      victoryOverlayDismissed = false;
    }
    previousError = "";
    repeatedRpcFailureKey = "";
    repeatedRpcFailures = 0;
  };
  const stepLimitLabel = Number.isFinite(maxSteps) ? maxSteps : "∞";

  try {
    state = assertGameState(await client.gamestate({ signal }), "gamestate");
    if (profileReader) runCardTracker.hydrateFromRuns?.(projectRoot, state.seed);
    const initialSemanticState = refreshRunKnowledge(state);
    // Recover the victory checkpoint after a controller restart without
    // trusting GAME_OVER.won at Ante 8 (Balatro sets that flag before it
    // decides whether the Boss was actually cleared).
    victoryCheckpointSeen = initialSemanticState?.won === true && (
      initialSemanticState.state !== "GAME_OVER" || Number(initialSemanticState?.ante_num) > 8
    );
    // ROUND_EVAL does not expose overlay/paused state in stock gamestate. Try
    // the guarded endpoint once after a restart; if the overlay was already
    // dismissed, its precise NOT_ALLOWED response switches us to cash-out.
    victoryOverlayDismissed = victoryCheckpointSeen && initialSemanticState.state !== "ROUND_EVAL";
    console.log(`Run log: ${log.dir}`);
    console.log(`Mode: ${dryRun ? "DRY RUN (no game-changing RPC will be sent)" : "LIVE BalatroBot JSON-RPC"}. Press Ctrl+C to stop.`);
    console.log(`BalatroBot endpoint: ${client.baseUrl ?? config.balatrobotUrl}`);
    console.log(`Initial state: ${stateLabel(state)}`);
    const semanticStats = experienceStore?.enabled && typeof experienceStore.stats === "function"
      ? experienceStore.stats()
      : null;
    log.event("bot_session", {
      backend: "balatrobot",
      dryRun,
      endpoint: client.baseUrl ?? config.balatrobotUrl,
      semanticLearning: semanticStats
        ? {
            policyVersion: semanticStats.policyVersion,
            completedEpisodes: semanticStats.completedEpisodes,
            wonEpisodes: semanticStats.wonEpisodes,
            lostEpisodes: semanticStats.lostEpisodes,
            learnedTransitions: semanticStats.learnedTransitions,
          }
        : null,
      collectionKnowledge: collectionKnowledge
        ? {
            available: collectionKnowledge.available,
            profile: collectionKnowledge.profile,
            signature: collectionKnowledge.signature,
            unlockedJokerCount: collectionKnowledge.unlockedJokerCount,
            totalJokerCount: collectionKnowledge.totalJokerCount,
            unlockedDeckCount: collectionKnowledge.unlockedDeckCount ?? collectionKnowledge.unlockedDecks?.length ?? 0,
            totalDeckCount: collectionKnowledge.totalDeckCount ?? collectionKnowledge.unlockedDecks?.length ?? 0,
            unlockedDecks: collectionKnowledge.unlockedDecks?.map((deck) => deck.code) ?? [],
            error: collectionKnowledge.available ? null : collectionKnowledge.error,
          }
        : null,
      appearedThisRun: {
        jokers: appearedThisRun.jokers.map((card) => card.key),
        consumables: appearedThisRun.consumables.map((card) => card.key),
        vouchers: appearedThisRun.vouchers.map((card) => card.key),
      },
    });
    if (collectionKnowledge?.available) {
      console.log(
        `Collection: profile ${collectionKnowledge.profile}, ${collectionKnowledge.unlockedJokerCount}/` +
          `${collectionKnowledge.totalJokerCount} Jokers and ` +
          `${collectionKnowledge.unlockedDeckCount ?? collectionKnowledge.unlockedDecks?.length ?? 0}/` +
          `${collectionKnowledge.totalDeckCount ?? collectionKnowledge.unlockedDecks?.length ?? 0} decks unlocked ` +
          `(signature ${collectionKnowledge.signature}).`,
      );
      console.log(
        `Unlocked decks: ${collectionKnowledge.unlockedDecks?.map((deck) => `${deck.label} (${deck.effect})`).join("; ") || "none"}.`,
      );
      console.log(
        `Run card history: ${appearedThisRun.jokers.length} Joker(s), ` +
          `${appearedThisRun.consumables.length} consumable(s), ${appearedThisRun.vouchers.length} voucher(s) seen.`,
      );
    } else if (profileReader) {
      console.warn(`[warn] Balatro collection knowledge unavailable: ${collectionKnowledge?.error ?? "unknown error"}`);
    }
    beginEpisode(initialSemanticState);

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) throw abortError(signal);
      latchBalatrobotMouthLock(state, mouthLockCache);
      const semanticState = refreshRunKnowledge(state);
      if (!runPlan && state?.seed) {
        runPlan = strategicCheckpointStore?.runPlan?.(state.seed) ?? null;
      }
      const sanitizedRunPlan = sanitizeCollectionAwareRunPlan(
        runPlan,
        collectionKnowledge,
        appearedThisRun,
        state,
      );
      if (sanitizedRunPlan.changed) {
        runPlan = sanitizedRunPlan.runPlan;
        log.event("bot_stale_run_plan_sanitized", {
          step,
          removed: sanitizedRunPlan.removed,
          reason: runPlan.revisionReason,
        });
      }
      const exactFingerprint = balatrobotStateFingerprint(state);
      Object.defineProperties(state, {
        __scoreBenchmarks: { value: scoreBenchmarks, configurable: true },
        __runPlan: { value: runPlan, configurable: true },
      });
      const compactState = compactBalatrobotState(state);
      Object.defineProperties(compactState, {
        collectionKnowledge: { value: collectionKnowledge, enumerable: false },
        appearedThisRun: { value: appearedThisRun, enumerable: false },
      });
      log.event("bot_state", { step, fingerprint: exactFingerprint, state: compactState });
      console.log(`\n[${step}/${stepLimitLabel}] ${stateLabel(state)}`);
      finalizeEpisode(semanticState);

      let circuitRecovery = null;
      if (uncertainAction) {
        if (uncertainAction.fingerprint === exactFingerprint) {
          const delayMs = Math.min(2_000, Math.max(100, Number(config.balatrobotPollMs) || 0));
          log.event("rpc_uncertain_quarantine", {
            step,
            method: uncertainAction.method,
            stateFingerprint: exactFingerprint,
            delayMs,
          });
          console.warn(`  [warn] Rechecking state before reconsidering uncertain ${uncertainAction.method}; no RPC will be replayed this turn.`);
          await sleep(delayMs, signal);
          const checked = await reconcileGamestate({ client, config, log, step, signal });
          const checkedFingerprint = balatrobotStateFingerprint(checked);
          log.event("rpc_uncertain_quarantine_result", {
            step,
            method: uncertainAction.method,
            previousFingerprint: exactFingerprint,
            currentFingerprint: checkedFingerprint,
            changed: checkedFingerprint !== exactFingerprint,
          });
          state = checked;
          if (checkedFingerprint !== exactFingerprint) {
            uncertainAction = null;
            previousError = "";
            continue;
          }

          const unchangedChecks = (uncertainAction.unchangedChecks ?? 1) + 1;
          if (
            state?.state === "SMODS_BOOSTER_OPENED" &&
            uncertainAction.method === "pack" &&
            uncertainAction.params?.skip !== true
          ) {
            let recovery;
            try {
              recovery = validatedStuckPackSkip(state);
            } catch (error) {
              const pending = uncertainAction;
              uncertainAction = null;
              return await stopAfterUncertainRpc({
                step,
                method: pending.method,
                params: pending.params ?? null,
                fingerprint: exactFingerprint,
                reason: `The stuck pack could not be skipped safely: ${error.message}`,
              });
            }
            circuitRecovery = {
              ...recovery,
              originalSignature: uncertainAction.signature,
              unchangedChecks,
            };
            log.event("rpc_uncertain_circuit_breaker", {
              step,
              method: uncertainAction.method,
              originalParams: uncertainAction.params ?? null,
              recovery: recovery.action,
              stateFingerprint: exactFingerprint,
              unchangedChecks,
            });
            console.warn("  [warn] The open pack was unchanged after two checks; bypassing the model and trying local Pack Skip once.");
            uncertainAction = null;
            previousError = "The previous pack choice had no visible effect after two checks; local circuit breaker is skipping it once.";
          } else {
            const pending = uncertainAction;
            const reason =
              state?.state === "SMODS_BOOSTER_OPENED" && pending.params?.skip === true
                ? "Pack Skip remained unchanged after two independent checks."
                : `${pending.method} remained unchanged after two independent checks.`;
            uncertainAction = null;
            return await stopAfterUncertainRpc({
              step,
              method: pending.method,
              params: pending.params ?? null,
              fingerprint: exactFingerprint,
              reason,
            });
          }
        }
        if (!circuitRecovery) uncertainAction = null;
      }

      let deckSelection = null;
      if (state.state === "MENU") {
        let deckPerformance = [];
        try {
          deckPerformance = experienceStore?.deckPerformance?.(config.balatrobotStake) ?? [];
        } catch (error) {
          log.event("bot_deck_performance_error", { step, error: error.message });
          console.warn(`[warn] Deck performance history could not be read; exploration will use unlocked decks only: ${error.message}`);
        }
        deckSelection = selectBalatroDeck({
          collectionKnowledge,
          performance: deckPerformance,
          config,
        });
        log.event("bot_deck_selected", {
          step,
          stake: config.balatrobotStake,
          selection: deckSelection,
          candidates: collectionKnowledge?.unlockedDecks?.map((deck) => ({
            code: deck.code,
            label: deck.label,
            effect: deck.effect,
          })) ?? [],
          performance: deckPerformance,
        });
        console.log(
          `  Deck selection: ${deckSelection.label} [${deckSelection.mode}] — ${deckSelection.effect}. ` +
            `${deckSelection.reason}.`,
        );
      }
      let action = circuitRecovery?.action ?? deterministicBalatrobotAction(
        state,
        {
          ...config,
          ...(deckSelection ? { balatrobotDeck: deckSelection.deck } : {}),
          balatrobotVictoryOverlayDismissed: victoryOverlayDismissed,
        },
      );
      if (action?.method === "start" && deckSelection) {
        action = {
          ...action,
          reason: `Start ${deckSelection.label}: ${deckSelection.effect}`.slice(0, 160),
        };
      }
      let planDetails = circuitRecovery
        ? {
            ...circuitRecovery.plan,
            memory,
            runPlan,
          }
        : undefined;
      let source = circuitRecovery ? "balatrobot_rpc_circuit_breaker" : "balatrobot_local";
      let planned = { usage: mergeUsage(), attempts: [], planningMs: 0 };
      let actionCandidates = [];
      let approvedCheckpointScope = null;
      let selectedActionCandidate = null;

      const failureKeyPrefix = `${exactFingerprint}:`;
      if (!action && repeatedRpcFailures >= 2 && repeatedRpcFailureKey.startsWith(failureKeyPrefix)) {
        action = fallbackBalatrobotAction(state);
        if (action) {
          source = "balatrobot_rpc_recovery";
          planDetails = {
            observation: "The same exact-state RPC action was rejected twice.",
            strategy: action.reason,
            memory,
            runPlan,
            confidence: 1,
          };
        }
      }

      if (!action) {
        if (!MODEL_STATES.has(state.state)) {
          if (transitionState !== state.state) {
            transitionState = state.state;
            transitionStartedAt = Date.now();
            transitionPolls = 0;
          }
          transitionPolls += 1;
          const transitionMs = Date.now() - transitionStartedAt;
          if (transitionPolls === 1 || transitionPolls % 10 === 0) {
            log.event("bot_transition_wait", { step, state: state.state, transitionMs, polls: transitionPolls });
            console.log(`  Transitional state ${state.state}; polling locally without an API-model call.`);
          }
          if (transitionMs >= config.balatrobotTransitionTimeoutMs) {
            await captureFailureScreenshot(client, log, step, signal);
            throw new Error(
              `BalatroBot remained in transitional state ${state.state} for ${transitionMs}ms ` +
                `(limit ${config.balatrobotTransitionTimeoutMs}ms)`,
            );
          }
          await sleep(config.balatrobotPollMs, signal);
          state = assertGameState(await client.gamestate({ signal }), "gamestate");
          step -= 1;
          continue;
        }
        const planningStartedAt = performance.now();
        const generatedCandidates = generateBalatrobotCandidates(state, {
          limit: config.balatrobotHandCandidateLimit,
          benchmarks: scoreBenchmarks,
          runPlan,
        });
        if (state.state === "SELECTING_HAND") {
          for (const candidate of generatedCandidates.filter((item) => item.action?.method === "play").slice(0, 5)) {
            const key = `${exactFingerprint}:${candidate.id}`;
            if (scoreBenchmarkKeys.has(key)) continue;
            scoreBenchmarkKeys.add(key);
            scoreBenchmarks.push({ state, candidate });
          }
          if (scoreBenchmarks.length > 12) scoreBenchmarks = scoreBenchmarks.slice(-12);
          if (scoreBenchmarkKeys.size > 40) {
            scoreBenchmarkKeys.clear();
            for (const benchmark of scoreBenchmarks) {
              scoreBenchmarkKeys.add(`${balatrobotStateFingerprint(benchmark.state)}:${benchmark.candidate.id}`);
            }
          }
        }
        const candidates = filterBalatrobotExecutableCandidates(state, generatedCandidates);
        if (candidates.length !== generatedCandidates.length) {
          log.event("bot_candidate_filter", {
            step,
            generated: generatedCandidates.length,
            executable: candidates.length,
            removedIds: generatedCandidates
              .filter((candidate) => !candidates.some((kept) => kept.id === candidate.id))
              .map((candidate) => candidate.id),
          });
        }
        actionCandidates = candidates;
        let thinkingMode = applyStrategicCheckpoint(
          state,
          balatrobotThinkingMode(state, candidates, config),
          strategicCheckpointScopes,
          config,
          strategicCheckpointStore,
        );
        approvedCheckpointScope = thinkingMode.checkpointScope ?? null;
        log.event("bot_strategy_mode", {
          step,
          strategic: thinkingMode.strategic,
          reasoningEffort: thinkingMode.effort,
          reason: thinkingMode.reason,
          checkpointScope: approvedCheckpointScope,
          reusedCheckpoint: Boolean(thinkingMode.reusedCheckpoint),
          candidateCount: candidates.length,
          candidates,
        });
        console.log(
          `  Strategy: ${thinkingMode.strategic ? "strategic thinking" : "routine ranking"} ` +
            `(${thinkingMode.effort}; ${candidates.length} local candidate(s)) — ${thinkingMode.reason}.`,
        );
        let selectedPlanner = thinkingMode.strategic ? strategicPlanner : planner;
        let selectedRoute = thinkingMode.strategic ? "strategic" : "routine";
        let selectedPlannerConfig = selectedPlanner.config ?? {};
        log.event("bot_planner_route", {
          step,
          route: selectedRoute,
          provider: selectedPlannerConfig.provider ?? null,
          model: selectedPlannerConfig.model ?? null,
        });
        console.log(
          `  Model route: ${selectedRoute} -> ` +
            `${selectedPlannerConfig.provider ?? "configured planner"} / ${selectedPlannerConfig.model ?? "unknown model"}.`,
        );
        let experienceContext = "";
        if (experienceStore?.enabled) {
          try {
            const retrieval = experienceStore.retrieve(semanticState);
            experienceContext = experienceStore.formatContext(retrieval);
            const fastCandidate = experienceStore.chooseFastAction(retrieval);
            log.event("semantic_retrieval", {
              step,
              candidates: retrieval.items.length,
              injected: experienceStore.contextItems(retrieval).length,
              searched: retrieval.searched,
              elapsedMs: retrieval.elapsedMs,
              truncated: retrieval.truncated,
              cached: retrieval.cached,
              policyVersion: retrieval.policyVersion,
              fastEvidence: fastCandidate?.evidence ?? null,
            });
            if (retrieval.items.length) {
              console.log(
                `  Semantic RAG: ${retrieval.items.length} candidate(s), searched ${retrieval.searched} in ` +
                  `${retrieval.elapsedMs.toFixed(1)}ms${retrieval.cached ? " (cache)" : retrieval.truncated ? " (budget reached)" : ""}.`,
              );
            }
            if (fastCandidate) {
              try {
                const fastPlan = validateBalatrobotPlan(
                  {
                    observation: "Exact semantic state matches the same action across multiple independent winning runs.",
                    strategy: "Reuse a locally learned exact-state action after legality validation.",
                    memory,
                    runPlan,
                    confidence: 1,
                    actions: [fastCandidate.action],
                  },
                  state,
                  {
                    minimumConfidence: config.minimumConfidence,
                    collectionKnowledge,
                    appearedThisRun,
                  },
                );
                assertBalatrobotCandidateAction(fastPlan.actions[0], candidates, state);
                planned = {
                  plan: fastPlan,
                  usage: mergeUsage(),
                  attempts: [],
                  planningMs: performance.now() - planningStartedAt,
                };
                action = fastPlan.actions[0];
                planDetails = fastPlan;
                source = "semantic_fast_path";
                log.event("semantic_fast_path", { step, action, evidence: fastCandidate.evidence });
                console.log(
                  `  Semantic fast path: ${actionLabel(action)} from ${fastCandidate.evidence.trustedSamples} trusted sample(s).`,
                );
              } catch (error) {
                log.event("semantic_fast_path_rejected", { step, error: error.message, candidate: fastCandidate.action });
              }
            }
          } catch (error) {
            console.warn(`[warn] Semantic RAG retrieval failed and was skipped: ${error.message}`);
          }
        }
        if (!action && approvedShopContinuation) {
          if (approvedShopContinuation.scope !== approvedCheckpointScope) {
            log.event("bot_shop_sequence_invalidated", {
              step,
              reason: "strategic scope changed",
              approvedScope: approvedShopContinuation.scope,
              currentScope: approvedCheckpointScope,
            });
            approvedShopContinuation = null;
          } else {
            const continuation = resolveApprovedShopContinuation(state, candidates, approvedShopContinuation);
            if (continuation.action) {
              action = continuation.action;
              selectedActionCandidate = continuation.candidate;
              source = "balatrobot_checkpoint_sequence";
              planDetails = {
                observation: "The strategic planner approved this exact replacement before selling the previous Joker.",
                strategy: `Complete the approved replacement with ${continuation.candidate.card?.label || continuation.candidate.card?.key}.`,
                memory,
                runPlan,
                confidence: 1,
                actions: [action],
              };
              planned = { usage: mergeUsage(), attempts: [], planningMs: performance.now() - planningStartedAt };
              log.event("bot_shop_sequence_resolved", {
                step,
                scope: approvedShopContinuation.scope,
                candidateId: continuation.candidate.id,
                maxPrice: approvedShopContinuation.maxPrice,
              });
            } else {
              log.event("bot_shop_sequence_invalidated", { step, reason: continuation.reason, ...approvedShopContinuation });
              approvedShopContinuation = null;
            }
          }
        }
        try {
          if (!action) {
            planned = !thinkingMode.strategic && candidates.length && typeof selectedPlanner.rankCandidate === "function"
              ? await planRankedCandidate({
                  planner: selectedPlanner,
                  state,
                  compactState,
                  step,
                  memory,
                  runPlan,
                  candidates,
                  thinkingMode,
                  collectionKnowledge,
                  appearedThisRun,
                  config,
                  log,
                  signal,
                })
              : await planSemanticAction({
                  planner: selectedPlanner,
                  state,
                  compactState,
                  step,
                  memory,
                  runPlan,
                  previousError,
                  experienceContext,
                  candidates,
                  thinkingMode,
                  collectionKnowledge,
                  appearedThisRun,
                  config,
                  log,
                  signal,
                });
            if (
              planned.selectedCandidate?.requiresStrategic &&
              selectedPlanner !== strategicPlanner
            ) {
              const proposed = planned.selectedCandidate;
              log.event("bot_candidate_escalated", {
                step,
                candidateId: proposed.id,
                method: proposed.action?.method ?? null,
                reason: proposed.strategicReason ?? "build-changing action",
              });
              console.log(
                `  Strategic approval: ${proposed.id} changes the build/economy; asking the strategic planner before execution.`,
              );
              thinkingMode = {
                ...thinkingMode,
                strategic: true,
                effort: config.balatrobotStrategicReasoningEffort ?? "high",
                reason: proposed.strategicReason ?? "build-changing action requires approval",
              };
              selectedPlanner = strategicPlanner;
              selectedRoute = "strategic-approval";
              selectedPlannerConfig = selectedPlanner.config ?? {};
              log.event("bot_planner_route", {
                step,
                route: selectedRoute,
                provider: selectedPlannerConfig.provider ?? null,
                model: selectedPlannerConfig.model ?? null,
                proposedCandidateId: proposed.id,
              });
              planned = await planSemanticAction({
                planner: selectedPlanner,
                state,
                compactState,
                step,
                memory,
                runPlan,
                previousError: `Routine ranker proposed ${proposed.id}; approve it or choose a safer legal action.`,
                experienceContext,
                candidates,
                thinkingMode,
                collectionKnowledge,
                appearedThisRun,
                config,
                log,
                signal,
              });
              planned.strategicRoute = planned.fallback !== true;
            }
            if (thinkingMode.strategic && planned.fallback !== true) {
              planned.strategicRoute = true;
            }
            plannerFailures = 0;
            action = planned.plan.actions[0];
            planDetails = planned.plan;
            source = planned.fallback
              ? "balatrobot_validation_fallback"
              : planned.strategicRoute
                ? "balatrobot_model_strategic"
                : "balatrobot_model";
          }
        } catch (error) {
          if (isAbort(error, signal)) throw error;
          if (thinkingMode.strategic && selectedPlanner !== planner) {
            const strategicError = error;
            const routinePlannerConfig = planner.config ?? {};
            log.event("bot_strategic_planner_fallback", {
              step,
              provider: selectedPlannerConfig.provider ?? null,
              model: selectedPlannerConfig.model ?? null,
              fallbackProvider: routinePlannerConfig.provider ?? null,
              fallbackModel: routinePlannerConfig.model ?? null,
              ...planningErrorEvent(strategicError),
            });
            console.warn(
              `  [warn] Strategic planner failed; retrying once through the routine route: ${strategicError.message}`,
            );
            if (state?.state === "SHOP") {
              planned = strategicUnavailableShopExit({
                memory,
                runPlan,
                usage: strategicError.usage,
                attempts: strategicError.recoveryAttempts ?? [],
                planningMs: performance.now() - planningStartedAt,
                reason: strategicError.message,
              });
              plannerFailures = 0;
              action = planned.plan.actions[0];
              planDetails = planned.plan;
              source = "balatrobot_strategic_unavailable_safe_exit";
              log.event("bot_strategic_unavailable_safe_exit", {
                step,
                blockedReason: planned.blockedReason,
                action,
              });
            } else try {
              const routineCandidates = state?.state === "SHOP"
                ? candidates.filter((candidate) => !candidate.requiresStrategic)
                : candidates;
              const routineMode = {
                ...thinkingMode,
                strategic: false,
                effort: config.balatrobotRoutineReasoningEffort ?? "none",
                reason: `strategic provider unavailable; rank only locally legal candidates for ${thinkingMode.reason ?? "critical state"}`,
              };
              planned = routineCandidates.length && typeof planner.rankCandidate === "function"
                ? await planRankedCandidate({
                    planner,
                    state,
                    compactState,
                    step,
                    memory,
                    runPlan,
                    candidates: routineCandidates,
                    thinkingMode: routineMode,
                    collectionKnowledge,
                    appearedThisRun,
                    config,
                    log,
                    signal,
                  })
                : await planSemanticAction({
                    planner,
                    state,
                    compactState,
                    step,
                    memory,
                    runPlan,
                    previousError: `Strategic route unavailable: ${strategicError.message}`.slice(0, 300),
                    experienceContext,
                    candidates,
                    thinkingMode: {
                      ...thinkingMode,
                      strategic: true,
                      effort: thinkingMode.effort ?? config.balatrobotStrategicReasoningEffort ?? "high",
                      reason: `strategic provider unavailable; reason through ${thinkingMode.reason ?? "critical state"}`,
                    },
                    collectionKnowledge,
                    appearedThisRun,
                    config,
                    log,
                    signal,
                  });
              planned.usage = mergeUsage(strategicError.usage, planned.usage);
              planned.attempts = [
                ...(strategicError.recoveryAttempts ?? []),
                ...(planned.attempts ?? []),
              ];
              plannerFailures = 0;
              action = planned.plan.actions[0];
              planDetails = planned.plan;
              source = planned.fallback ? "balatrobot_validation_fallback" : "balatrobot_model_routine_fallback";
            } catch (routineError) {
              if (isAbort(routineError, signal)) throw routineError;
              routineError.usage = mergeUsage(strategicError.usage, routineError.usage);
              routineError.recoveryAttempts = [
                ...(strategicError.recoveryAttempts ?? []),
                ...(routineError.recoveryAttempts ?? []),
              ];
              error = routineError;
            }
          }
          if (!action) {
            plannerFailures += 1;
            const usage = mergeUsage(error.usage);
            const delayMs = plannerBackoffMs(plannerFailures, config);
            const fallback = fallbackBalatrobotAction(state);
            log.event("bot_planner_fallback", {
              step,
              failure: plannerFailures,
              delayMs,
              fallback,
              ...planningErrorEvent(error),
            });
            console.warn(`  [warn] Exact-state planning failed: ${error.message}`);
            if (delayMs) {
              console.warn(`  Backing off ${delayMs}ms before using a legal local fallback.`);
              await sleep(delayMs, signal);
            }
            planned = {
              usage,
              attempts: error.recoveryAttempts ?? [],
              planningMs: performance.now() - planningStartedAt,
              fallback: true,
            };
            action = fallback;
            planDetails = fallback
              ? {
                  observation: "The planning service was unavailable; using a legal exact-state fallback.",
                  strategy: fallback.reason,
                  memory,
                  runPlan,
                  confidence: 1,
                }
              : null;
            source = "balatrobot_planner_fallback";
            previousError = `Planning failed: ${error.message}`.slice(0, 300);
          }
        }
        if (
          state?.state === "SHOP" &&
          STRATEGIC_SHOP_METHODS.has(action?.method) &&
          source !== "balatrobot_model_strategic" &&
          source !== "balatrobot_checkpoint_sequence"
        ) {
          const proposedAction = action;
          const proposedSource = source;
          planned = strategicUnavailableShopExit({
            memory,
            runPlan,
            usage: planned.usage,
            attempts: planned.attempts,
            planningMs: planned.planningMs,
            reason: `unapproved ${proposedSource} ${proposedAction.method}`,
          });
          action = planned.plan.actions[0];
          planDetails = planned.plan;
          source = "balatrobot_strategic_unavailable_safe_exit";
          log.event("bot_unapproved_shop_action_blocked", {
            step,
            proposedAction,
            proposedSource,
            replacement: action,
          });
        }
        transitionState = "";
        transitionStartedAt = 0;
        transitionPolls = 0;
        selectedActionCandidate ??= candidateForAction(action, actionCandidates);
        cumulativeUsage = mergeUsage(cumulativeUsage, planned.usage);

        const current = assertGameState(await client.gamestate({ signal }), "gamestate");
        const currentFingerprint = balatrobotStateFingerprint(current);
        if (currentFingerprint !== exactFingerprint) {
          log.event("bot_stale_plan_skipped", {
            step,
            plannedFingerprint: exactFingerprint,
            currentFingerprint,
            action,
          });
          console.log("  Exact state changed while the model was planning; stale action skipped with no input sent.");
          state = current;
          previousError = "The exact game state changed during planning; re-evaluate the new state.";
          continue;
        }
        if (!action) {
          state = current;
          await sleep(plannerBackoffMs(plannerFailures, config), signal);
          continue;
        }
      } else {
        planDetails ??= {
          observation: `Exact state ${state.state} has a deterministic navigation action.`,
          strategy: action.reason,
          memory,
          runPlan,
          confidence: 1,
        };
      }

      const legacyPlan = legacyPlanForBalatrobot(state, action, planDetails);
      log.event("plan", {
        step,
        source,
        planningMs: planned.planningMs,
        plan: legacyPlan,
        botAction: action,
        attempts: planned.attempts,
        usage: planned.usage,
        stateFingerprint: exactFingerprint,
      });
      console.log(`  Decision: ${actionLabel(action)} — ${action.reason}`);
      if (source === "balatrobot_model") console.log(`  Exact-state API planning: ${(planned.planningMs / 1_000).toFixed(2)}s`);
      if (planned.usage.apiCalls) console.log(`  API usage: ${usageLabel(planned.usage)}`);

      if (dryRun) {
        console.log("Dry-run completed one exact-state planning turn; no game-changing RPC was sent.");
        return { state, usage: cumulativeUsage, logDir: log.dir };
      }

      log.event("rpc_execute", { step, method: action.method, params: action.params, reason: action.reason });
      const beforeState = state;
      const beforeSemanticState = contextualBalatrobotState(beforeState, collectionKnowledge, appearedThisRun);
      const scorePrediction = action.method === "play"
        ? (actionCandidates.length ? actionCandidates : generateBalatrobotCandidates(beforeState)).find((candidate) => {
            if (candidate.action?.method !== "play") return false;
            const expected = [...(candidate.action.cards ?? [])].sort((left, right) => left - right).join(",");
            const actual = [...(action.params?.cards ?? [])].sort((left, right) => left - right).join(",");
            return expected === actual;
          }) ?? null
        : null;
      if (scorePrediction) {
        log.event("bot_score_prediction", {
          step,
          cards: action.params.cards,
          handType: scorePrediction.handType,
          conservativeScore: scorePrediction.conservativeScore,
          chips: scorePrediction.chips,
          mult: scorePrediction.mult,
          xMult: scorePrediction.xMult,
          knownRetriggers: scorePrediction.knownRetriggers ?? 0,
          knownRetriggerSources: scorePrediction.knownRetriggerSources ?? [],
          predictedEngineReady:
            Number(scorePrediction.chips) >= 100 &&
            Number(scorePrediction.mult) >= 20 &&
            Number(scorePrediction.xMult) > 1,
          knownScoringJokers: scorePrediction.knownScoringJokers,
          totalActiveJokers: scorePrediction.totalActiveJokers,
        });
      }
      try {
        state = assertGameState(await client.call(action.method, action.params, { signal }), action.method);
        const resultFingerprint = balatrobotStateFingerprint(state);
        log.event("rpc_result", {
          step,
          method: action.method,
          state: state.state,
          fingerprint: resultFingerprint,
        });
        if (
          beforeState?.state === "SMODS_BOOSTER_OPENED" &&
          action.method === "pack" &&
          resultFingerprint === exactFingerprint
        ) {
          uncertainAction = {
            fingerprint: exactFingerprint,
            signature: actionSignature(action),
            method: action.method,
            params: action.params,
            unchangedChecks: 1,
          };
          previousError = "The pack RPC returned successfully but the exact pack state did not change; do not replay it.";
          log.event("rpc_no_effect", {
            step,
            method: action.method,
            params: action.params,
            source,
            stateFingerprint: exactFingerprint,
          });
          console.warn("  [warn] Pack RPC returned without changing the exact state; quarantining it before any recovery.");
          await sleep(config.balatrobotPollMs, signal);
          continue;
        }
        if (scorePrediction) {
          const beforeChips = Number(beforeState?.round?.chips);
          const afterChips = Number(state?.round?.chips);
          const actualScore = Number.isFinite(beforeChips) && Number.isFinite(afterChips)
            ? Math.max(0, afterChips - beforeChips)
            : null;
          if (Number.isFinite(actualScore) && actualScore > 0) {
            const benchmark = [...scoreBenchmarks].reverse().find((entry) => entry.candidate === scorePrediction);
            if (benchmark) benchmark.actualScore = actualScore;
          }
          log.event("bot_score_result", {
            step,
            predicted: scorePrediction.conservativeScore,
            actual: actualScore,
            error: Number.isFinite(actualScore) ? actualScore - scorePrediction.conservativeScore : null,
            nextState: state.state,
          });
        }
        commitAppliedAction({
          step,
          beforeState: beforeSemanticState,
          action,
          afterState: state,
          source,
          plan: planDetails,
          usage: planned.usage,
          checkpointScope: approvedCheckpointScope,
          selectedCandidate: selectedActionCandidate,
        });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (error instanceof BalatrobotRpcError) {
          if (
            action.method === "endless" &&
            beforeState?.state === "ROUND_EVAL" &&
            beforeState?.won === true &&
            /requires (?:the )?native win overlay|overlay.*(?:open|paused)/iu.test(error.message)
          ) {
            // A controller restart can land after the native Endless button
            // was already dismissed. Stock gamestate has no overlay flag, so
            // the guarded endpoint is the authority; this precise rejection
            // means the next legal action is cash_out, never another retry.
            victoryCheckpointSeen = true;
            victoryOverlayDismissed = true;
            repeatedRpcFailureKey = "";
            repeatedRpcFailures = 0;
            previousError = "Victory overlay was already dismissed; collect the completed round reward.";
            log.event("bot_endless_already_dismissed", { step, code: error.code, error: error.message });
            state = assertGameState(await client.gamestate({ signal }), "gamestate after Endless overlay check");
            continue;
          }
          if (source === "balatrobot_rpc_circuit_breaker") {
            state = assertGameState(await client.gamestate({ signal }), "gamestate after rejected pack circuit breaker");
            return await stopAfterUncertainRpc({
              step,
              method: action.method,
              params: action.params,
              fingerprint: balatrobotStateFingerprint(state),
              reason: `The one-shot stuck-pack recovery was rejected: ${error.message}`,
            });
          }
          const key = `${exactFingerprint}:${action.method}:${JSON.stringify(action.params)}`;
          repeatedRpcFailures = key === repeatedRpcFailureKey ? repeatedRpcFailures + 1 : 1;
          repeatedRpcFailureKey = key;
          previousError = `${action.method} was rejected by BalatroBot: ${error.message}`.slice(0, 300);
          log.event("rpc_rejected", {
            step,
            method: action.method,
            params: action.params,
            code: error.code,
            data: error.data ?? null,
            error: error.message,
            repeated: repeatedRpcFailures,
          });
          console.warn(`  [warn] ${previousError}`);
          if (overlayController && isUnlockOverlayMismatch(state, action, error)) {
            try {
              const recovery = await overlayController.dismissUnlockOverlay({ signal });
              log.event("bot_unlock_overlay_recovery", { step, ...recovery });
              if (recovery.dismissed) {
                console.log("  Unlock overlay detected; clicked its Continue button once.");
                repeatedRpcFailureKey = "";
                repeatedRpcFailures = 0;
                previousError = "Unlock overlay was dismissed; re-read exact state before selecting the blind.";
                await sleep(Math.max(250, Number(config.balatrobotPollMs) || 0), signal);
                state = assertGameState(await client.gamestate({ signal }), "gamestate after unlock overlay");
                continue;
              }
            } catch (overlayError) {
              if (isAbort(overlayError, signal)) throw overlayError;
              log.event("bot_unlock_overlay_recovery_error", { step, error: overlayError.message });
              console.warn(`  [warn] Unlock overlay recovery failed safely: ${overlayError.message}`);
            }
          }
          if (repeatedRpcFailures >= 3) await captureFailureScreenshot(client, log, step, signal);
          state = assertGameState(await client.gamestate({ signal }), "gamestate");
          if (repeatedRpcFailures >= 3) {
            throw new Error(
              `BalatroBot repeatedly rejected unchanged ${action.method} state (${repeatedRpcFailures} times); ` +
                "stopping instead of replaying the same RPC indefinitely",
            );
          }
        } else if (isUncertainActionError(error)) {
          log.event("rpc_uncertain", {
            step,
            method: action.method,
            params: action.params,
            error: error.message,
            errorType: error.constructor.name,
            stateFingerprint: exactFingerprint,
          });
          console.warn(`  [warn] ${action.method} returned an uncertain transport/protocol result; reconciling gamestate before any retry.`);
          const reconciled = await reconcileGamestate({ client, config, log, step, signal });
          const reconciledFingerprint = balatrobotStateFingerprint(reconciled);
          const changed = reconciledFingerprint !== exactFingerprint;
          log.event("rpc_reconciled", {
            step,
            method: action.method,
            previousFingerprint: exactFingerprint,
            currentFingerprint: reconciledFingerprint,
            changed,
          });
          state = reconciled;
          if (changed) {
            commitAppliedAction({
              step,
              beforeState: beforeSemanticState,
              action,
              afterState: state,
              source,
              plan: planDetails,
              usage: planned.usage,
              checkpointScope: approvedCheckpointScope,
              selectedCandidate: selectedActionCandidate,
            });
            uncertainAction = null;
            console.warn("  State changed, so the action is treated as applied; it will not be sent again.");
          } else {
            uncertainAction = {
              fingerprint: exactFingerprint,
              signature: actionSignature(action),
              method: action.method,
              params: action.params,
              unchangedChecks: 1,
            };
            previousError = `${action.method} had an uncertain result and no state change was observed; do not blindly repeat it.`.slice(0, 300);
            console.warn("  No state change is visible yet; the next turn is reserved for a second reconciliation with no RPC sent.");
          }
        } else {
          throw error;
        }
      }
      await sleep(config.balatrobotPollMs, signal);
    }
    if (Number.isFinite(maxSteps)) console.log(`Reached maxSteps=${maxSteps}; stopped safely.`);
    return { state, usage: cumulativeUsage, logDir: log.dir };
  } finally {
    if (!dryRun && experienceStore?.enabled && episodeId) {
      try {
        experienceStore.markEpisodeInterrupted(episodeId);
        log.event("semantic_episode_interrupted", { episodeId });
      } catch (error) {
        console.warn(`[warn] Semantic episode interruption marker failed: ${error.message}`);
      }
    }
    externalSignal?.removeEventListener("abort", relayAbort);
    if (!externalSignal) process.removeListener("SIGINT", onSigint);
    log.event("summary", {
      backend: "balatrobot",
      usage: cumulativeUsage,
      finalState: state ? compactBalatrobotState(state) : null,
    });
    console.log(`\nCumulative API usage: ${usageLabel(cumulativeUsage)}`);
  }
}
