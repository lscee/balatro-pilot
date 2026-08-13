import test from "node:test";
import assert from "node:assert/strict";

import { BalatrobotRpcError, BalatrobotTimeoutError } from "../src/balatrobot-client.mjs";
import { latchBalatrobotMouthLock, runBalatrobot, strategicCheckpointScope } from "../src/balatrobot-runner.mjs";

test("runner latches The Mouth's first unique hand even after another counter grows larger", () => {
  const cache = { blindKey: null, handType: null };
  const first = handState();
  first.seed = "MOUTH-LATCH";
  first.round_num = 9;
  first.blinds = { boss: { type: "BOSS", status: "CURRENT", name: "The Mouth", score: 600 } };
  first.pokerHands = { "Full House": { playedThisRound: 1 }, Pair: { playedThisRound: 0 } };
  assert.equal(latchBalatrobotMouthLock(first, cache), "Full House");

  const later = structuredClone(first);
  later.pokerHands.Pair.playedThisRound = 2;
  assert.equal(latchBalatrobotMouthLock(later, cache), "Full House");
  assert.equal(later.__mouthLockedHandType, "Full House");

  const shop = { ...later, state: "SHOP", blinds: { boss: { type: "BOSS", status: "DEFEATED", name: "The Mouth" } } };
  assert.equal(latchBalatrobotMouthLock(shop, cache), null);
  assert.equal(cache.handType, null);
});

function card(rank, suit) {
  return {
    key: `${suit}_${rank}`,
    set: "DEFAULT",
    label: `${rank}${suit}`,
    value: { rank, suit, effect: "" },
    modifier: {},
    state: {},
    cost: { buy: 0, sell: 1 },
  };
}

function handState(money = 4) {
  const cards = [card("A", "H"), card("A", "S"), card("2", "C")];
  return {
    state: "SELECTING_HAND",
    ante_num: 1,
    round_num: 1,
    money,
    round: { chips: 0, hands_left: 4, discards_left: 3 },
    hand: { count: cards.length, limit: 8, highlighted_limit: 5, cards },
    cards: { count: cards.length, limit: 52, cards },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
  };
}

function semanticAction(method, overrides = {}) {
  return {
    method,
    cards: [],
    card: null,
    voucher: null,
    pack: null,
    joker: null,
    consumable: null,
    targets: [],
    skip: null,
    hand: [],
    jokers: [],
    consumables: [],
    reason: "test action",
    ...overrides,
  };
}

function modelPlan(botAction) {
  return {
    plan: { observation: "exact", strategy: "pair", memory: "pair build", confidence: 0.95, actions: [botAction] },
    usage: {
      apiCalls: 1,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 120,
    },
    attempts: [],
  };
}

function fakeLog() {
  const events = [];
  return { dir: "C:\\tmp\\balatrobot-test", events, event(type, data) { events.push({ type, ...data }); } };
}

const config = {
  minimumConfidence: 0.7,
  balatrobotMinimumConfidence: 0.55,
  balatrobotPollMs: 0,
  balatrobotUrl: "http://127.0.0.1:12346",
  balatrobotDeck: "RED",
  balatrobotStake: "WHITE",
};

function blindSelectState() {
  return {
    state: "BLIND_SELECT",
    ante_num: 1,
    round_num: 0,
    money: 4,
    blinds: {
      small: { type: "Small", status: "Select", chips: 300 },
      big: { type: "Big", status: "Upcoming", chips: 450 },
      boss: { type: "Boss", status: "Upcoming", chips: 600 },
    },
    jokers: { count: 0, limit: 5, cards: [] },
    consumables: { count: 0, limit: 2, cards: [] },
  };
}

test("runner starts only an unlocked deck chosen from adaptive performance", async () => {
  const initial = { state: "MENU" };
  const after = { ...blindSelectState(), deck: "BLUE", stake: "WHITE", seed: "deck-test" };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const planner = { async planState() { throw new Error("menu must not call a model"); } };
  const profileReader = {
    snapshot() {
      return {
        available: true,
        profile: "1",
        signature: "deck-pool",
        unlockedJokerCount: 1,
        totalJokerCount: 1,
        unlockedJokers: [],
        lockedJokers: [],
        unlockedDeckCount: 2,
        totalDeckCount: 3,
        unlockedDecks: [
          { code: "RED", label: "Red Deck", effect: "+1 discard", order: 1 },
          { code: "BLUE", label: "Blue Deck", effect: "+1 hand", order: 2 },
        ],
        lockedDecks: [{ code: "BLACK", label: "Black Deck", effect: "+1 Joker slot", order: 5 }],
      };
    },
  };
  const experienceStore = {
    enabled: false,
    deckPerformance() { return [{ deck: "RED", trials: 2, wins: 0, averageAnte: 2, averageRound: 4 }]; },
  };
  const log = fakeLog();
  await runBalatrobot({
    projectRoot: ".",
    config: { ...config, balatrobotDeckMode: "adaptive", balatrobotDeckMinimumTrials: 1 },
    client,
    planner,
    experienceStore,
    profileReader,
    maxSteps: 1,
    log,
  });
  assert.deepEqual(calls, [{ method: "start", params: { deck: "BLUE", stake: "WHITE" } }]);
  assert.ok(log.events.some((event) => event.type === "bot_deck_selected" && event.selection.deck === "BLUE"));
});

test("runner detects and dismisses the unlock overlay after the no-blind RPC mismatch", async () => {
  const initial = blindSelectState();
  const after = handState();
  let selectCalls = 0;
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method) {
      assert.equal(method, "select");
      selectCalls += 1;
      if (selectCalls === 1) {
        throw new BalatrobotRpcError(
          "BalatroBot RPC select failed: select() called with no blind on deck",
          { code: -32603, method: "select", requestId: 1 },
        );
      }
      return after;
    },
  };
  const planner = { async planState() { return modelPlan(semanticAction("select")); } };
  let recoveryCalls = 0;
  const overlayController = {
    async dismissUnlockOverlay() {
      recoveryCalls += 1;
      return { detected: true, dismissed: true, x: 0.5, y: 0.775, orangeRatio: 0.35 };
    },
  };
  const log = fakeLog();

  const result = await runBalatrobot({
    projectRoot: ".",
    config,
    client,
    planner,
    overlayController,
    maxSteps: 2,
    log,
  });

  assert.equal(recoveryCalls, 1);
  assert.equal(selectCalls, 2);
  assert.equal(result.state.state, "SELECTING_HAND");
  assert.ok(log.events.some((event) => event.type === "bot_unlock_overlay_recovery" && event.dismissed));
});

test("runner stops after three unchanged RPC rejections instead of looping forever", async () => {
  const initial = blindSelectState();
  let selectCalls = 0;
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method) {
      if (method === "screenshot") return { path: "failure.png" };
      selectCalls += 1;
      throw new BalatrobotRpcError(
        "BalatroBot RPC select failed: select() called with no blind on deck",
        { code: -32603, method: "select", requestId: selectCalls },
      );
    },
  };
  const planner = { async planState() { return modelPlan(semanticAction("select")); } };
  const overlayController = {
    async dismissUnlockOverlay() { return { detected: false, dismissed: false, orangeRatio: 0.01 }; },
  };

  await assert.rejects(
    runBalatrobot({ projectRoot: ".", config, client, planner, overlayController, maxSteps: 10, log: fakeLog() }),
    /stopping instead of replaying the same RPC indefinitely/,
  );
  assert.equal(selectCalls, 3);
});

test("runner executes one validated exact-state model action", async () => {
  const initial = handState();
  const after = { ...initial, state: "ROUND_EVAL", round: { ...initial.round, chips: 120 } };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const planner = { async planState() { return modelPlan(semanticAction("play", { cards: [0, 1, 2] })); } };
  const log = fakeLog();
  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log });
  assert.deepEqual(calls, [{ method: "play", params: { cards: [0, 1, 2] } }]);
  assert.equal(result.state.state, "ROUND_EVAL");
  assert.equal(result.usage.totalTokens, 120);
  assert.ok(log.events.some((event) => event.type === "rpc_result"));
});

test("runner handles round navigation locally without spending model tokens", async () => {
  const initial = { ...handState(), state: "ROUND_EVAL" };
  const after = { ...initial, state: "SHOP" };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  let planned = false;
  const planner = { async planState() { planned = true; throw new Error("should not plan"); } };
  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log: fakeLog() });
  assert.deepEqual(calls, [{ method: "cash_out", params: {} }]);
  assert.equal(planned, false);
  assert.equal(result.usage.apiCalls, 0);
});

test("runner enters Endless once at a confirmed victory and then cashes out", async () => {
  const victory = {
    ...handState(),
    state: "ROUND_EVAL",
    won: true,
    ante_num: 9,
    round_num: 24,
    seed: "ENDLESS-WIN",
  };
  const shop = { ...victory, state: "SHOP" };
  let current = victory;
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return current; },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "cash_out") current = shop;
      return current;
    },
  };
  const planner = { async planState() { throw new Error("victory navigation must stay local"); } };
  await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 2, log: fakeLog() });
  assert.deepEqual(calls, [
    { method: "endless", params: {} },
    { method: "cash_out", params: {} },
  ]);
});

test("runner treats the guarded no-overlay Endless rejection as already dismissed", async () => {
  const victory = {
    ...handState(),
    state: "ROUND_EVAL",
    won: true,
    ante_num: 9,
    round_num: 24,
    seed: "ENDLESS-RESUME",
  };
  const shop = { ...victory, state: "SHOP" };
  let current = victory;
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return current; },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "endless") {
        throw new BalatrobotRpcError(
          "BalatroBot RPC endless failed: endless() requires the native win overlay to be open and paused",
          { code: -32003, method, requestId: 1 },
        );
      }
      current = shop;
      return current;
    },
  };
  const log = fakeLog();
  const planner = { async planState() { throw new Error("victory navigation must stay local"); } };
  await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 2, log });
  assert.deepEqual(calls, [
    { method: "endless", params: {} },
    { method: "cash_out", params: {} },
  ]);
  assert.ok(log.events.some((event) => event.type === "bot_endless_already_dismissed"));
});

test("runner requests one correction after local semantic validation rejects a candidate", async () => {
  const initial = handState();
  const after = { ...initial, state: "ROUND_EVAL" };
  const candidates = [
    modelPlan({ ...semanticAction("play", { cards: [0] }), unsupported: true }),
    modelPlan(semanticAction("play", { cards: [0, 1] })),
  ];
  const previousErrors = [];
  const planner = {
    async planState(input) {
      previousErrors.push(input.previousError);
      return candidates.shift();
    },
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log: fakeLog() });
  assert.equal(previousErrors.length, 2);
  assert.match(previousErrors[1], /unsupported key/);
  assert.deepEqual(calls[0], { method: "play", params: { cards: [0, 1] } });
  assert.equal(result.usage.totalTokens, 240);
});

test("runner discards a plan when exact state changes during cloud planning", async () => {
  const initial = handState(4);
  const changed = handState(5);
  let reads = 0;
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { reads += 1; return reads === 1 ? initial : changed; },
    async call(method, params) { calls.push({ method, params }); return changed; },
  };
  const planner = { async planState() { return modelPlan(semanticAction("play", { cards: [0, 1] })); } };
  const log = fakeLog();
  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log });
  assert.deepEqual(calls, []);
  assert.equal(result.state.money, 5);
  assert.ok(log.events.some((event) => event.type === "bot_stale_plan_skipped"));
});

test("runner backs off and uses a legal fallback when exact-state planning is unavailable", async () => {
  const initial = handState();
  const after = { ...initial, state: "ROUND_EVAL" };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const plannerError = new Error("Planner API error: 429 Too Many Requests");
  plannerError.usage = { apiCalls: 1, inputTokens: 20, outputTokens: 0, totalTokens: 20 };
  const planner = { async planState() { throw plannerError; } };
  const log = fakeLog();

  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log });

  assert.deepEqual(calls, [{ method: "play", params: { cards: [0, 1] } }]);
  assert.equal(result.state.state, "ROUND_EVAL");
  assert.equal(result.usage.totalTokens, 20);
  assert.ok(log.events.some((event) => event.type === "bot_planner_fallback" && event.failure === 1));
});

test("runner reconciles an uncertain action and does not replay it on the next turn", async () => {
  const initial = handState();
  let gamestateReads = 0;
  let plannerCalls = 0;
  let actionCalls = 0;
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { gamestateReads += 1; return initial; },
    async call() {
      actionCalls += 1;
      throw new BalatrobotTimeoutError("play timed out", { method: "play", requestId: 1, timeoutMs: 10 });
    },
  };
  const planner = {
    async planState() {
      plannerCalls += 1;
      return modelPlan(semanticAction("play", { cards: [0, 1] }));
    },
  };
  const log = fakeLog();

  await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 2, log });

  assert.equal(actionCalls, 1);
  assert.equal(plannerCalls, 1);
  assert.ok(gamestateReads >= 4);
  assert.ok(log.events.some((event) => event.type === "rpc_uncertain"));
  assert.ok(log.events.some((event) => event.type === "rpc_reconciled" && event.changed === false));
  assert.ok(log.events.some((event) => event.type === "rpc_uncertain_quarantine"));
});

test("runner circuit-breaks an unchanged uncertain pack choice with one local skip", async () => {
  const initial = {
    ...handState(),
    state: "SMODS_BOOSTER_OPENED",
    seed: "PACK-CIRCUIT",
    pack: {
      cards: [
        { key: "c_jupiter", set: "PLANET", label: "Jupiter", value: { effect: "Level up Flush" }, modifier: {}, state: {}, cost: {} },
      ],
    },
  };
  const after = { ...initial, state: "SHOP", pack: { cards: [] } };
  let plannerCalls = 0;
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) {
      calls.push({ method, params });
      if (calls.length === 1) {
        throw new BalatrobotTimeoutError("pack timed out", { method, requestId: 1, timeoutMs: 10 });
      }
      return after;
    },
  };
  const planner = {
    async planState() {
      plannerCalls += 1;
      return modelPlan(semanticAction("pack", { card: 0 }));
    },
  };
  const log = fakeLog();

  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 2, log });

  assert.deepEqual(calls, [
    { method: "pack", params: { card: 0 } },
    { method: "pack", params: { skip: true } },
  ]);
  assert.equal(plannerCalls, 1);
  assert.equal(result.state.state, "SHOP");
  assert.ok(log.events.some((event) => event.type === "rpc_uncertain_circuit_breaker"));
  assert.ok(log.events.some((event) => event.type === "rpc_result" && event.method === "pack" && event.state === "SHOP"));
});

test("runner stops safely when one-shot pack skip also has no effect", async () => {
  const initial = {
    ...handState(),
    state: "SMODS_BOOSTER_OPENED",
    seed: "PACK-CIRCUIT-STOP",
    pack: {
      cards: [
        { key: "c_jupiter", set: "PLANET", label: "Jupiter", value: { effect: "Level up Flush" }, modifier: {}, state: {}, cost: {} },
      ],
    },
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) {
      calls.push({ method, params });
      if (calls.length === 1) {
        throw new BalatrobotTimeoutError("pack timed out", { method, requestId: 1, timeoutMs: 10 });
      }
      return initial;
    },
  };
  const planner = { async planState() { return modelPlan(semanticAction("pack", { card: 0 })); } };
  const log = fakeLog();

  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 3, log });

  assert.deepEqual(calls, [
    { method: "pack", params: { card: 0 } },
    { method: "pack", params: { skip: true } },
  ]);
  assert.match(result.stoppedReason, /Pack Skip remained unchanged/);
  assert.ok(log.events.some((event) => event.type === "rpc_no_effect"));
  assert.ok(log.events.some((event) => event.type === "rpc_uncertain_safe_stop"));
});

test("runner never replays a one-shot pack skip after its transport timeout", async () => {
  const initial = {
    ...handState(),
    state: "SMODS_BOOSTER_OPENED",
    seed: "PACK-CIRCUIT-SKIP-TIMEOUT",
    pack: {
      cards: [
        { key: "c_jupiter", set: "PLANET", label: "Jupiter", value: { effect: "Level up Flush" }, modifier: {}, state: {}, cost: {} },
      ],
    },
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) {
      calls.push({ method, params });
      throw new BalatrobotTimeoutError("pack timed out", { method, requestId: calls.length, timeoutMs: 10 });
    },
  };
  const planner = { async planState() { return modelPlan(semanticAction("pack", { card: 0 })); } };
  const log = fakeLog();

  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 3, log });

  assert.deepEqual(calls, [
    { method: "pack", params: { card: 0 } },
    { method: "pack", params: { skip: true } },
  ]);
  assert.match(result.stoppedReason, /Pack Skip remained unchanged/);
  assert.equal(log.events.filter((event) => event.type === "rpc_uncertain_circuit_breaker").length, 1);
  assert.equal(log.events.filter((event) => event.type === "rpc_uncertain_safe_stop").length, 1);
});

test("runner treats a changed reconciled state as an applied uncertain action", async () => {
  const initial = handState();
  const after = { ...initial, state: "ROUND_EVAL", round: { ...initial.round, chips: 120 } };
  let reads = 0;
  let actionCalls = 0;
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { reads += 1; return reads <= 2 ? initial : after; },
    async call() {
      actionCalls += 1;
      throw new BalatrobotTimeoutError("play timed out", { method: "play", requestId: 1, timeoutMs: 10 });
    },
  };
  const planner = { async planState() { return modelPlan(semanticAction("play", { cards: [0, 1] })); } };
  const log = fakeLog();

  const result = await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log });

  assert.equal(actionCalls, 1);
  assert.equal(result.state.state, "ROUND_EVAL");
  assert.ok(log.events.some((event) => event.type === "rpc_reconciled" && event.changed === true));
});

test("runner passes its cancellation signal into exact-state planning", async () => {
  const initial = handState();
  const after = { ...initial, state: "ROUND_EVAL" };
  let receivedSignal;
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call() { return after; },
  };
  const planner = {
    async planState(input) {
      receivedSignal = input.signal;
      return modelPlan(semanticAction("play", { cards: [0, 1] }));
    },
  };

  await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log: fakeLog() });

  assert.equal(typeof receivedSignal?.addEventListener, "function");
  assert.equal(receivedSignal.aborted, false);
});

test("runner sends locally enumerated hand candidates to the fast routine planner", async () => {
  const initial = handState();
  initial.round = { ...initial.round, hands_played: 0, discards_used: 0 };
  initial.jokers = { count: 1, limit: 5, cards: [{ key: "j_walkie_talkie", value: {}, modifier: {}, state: {}, cost: {} }] };
  const after = { ...initial, state: "ROUND_EVAL" };
  let plannerInput;
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call() { return after; },
  };
  const planner = {
    async planState(input) {
      plannerInput = input;
      return modelPlan(semanticAction("play", { cards: [0, 1] }));
    },
  };

  await runBalatrobot({
    projectRoot: ".",
    config: {
      ...config,
      balatrobotStrategicThinkingEnabled: true,
      balatrobotStrategicReasoningEffort: "high",
      balatrobotRoutineReasoningEffort: "none",
      balatrobotStrategicMaxOutputTokens: 1_200,
      maxOutputTokens: 1_200,
      balatrobotHandCandidateLimit: 14,
    },
    client,
    planner,
    maxSteps: 1,
    log: fakeLog(),
  });

  const candidates = JSON.parse(plannerInput.candidateContext);
  assert.equal(plannerInput.reasoningEffort, "none");
  assert.equal(plannerInput.maxOutputTokens, 1_200);
  assert.ok(candidates.some((candidate) => candidate.handType === "Pair" && candidate.action.cards.join(",") === "0,1"));
});

test("runner compiles a routine candidate id locally without accepting model RPC fields", async () => {
  const initial = handState();
  const after = { ...initial, state: "ROUND_EVAL", round: { ...initial.round, chips: 50 } };
  let rankedInput;
  let fullPlanCalls = 0;
  const planner = {
    config: { provider: "ollama-chat", model: "local" },
    async rankCandidate(input) {
      rankedInput = input;
      return {
        candidateId: "play:0,1",
        reason: "选择对子",
        usage: { apiCalls: 1, inputTokens: 30, outputTokens: 5, totalTokens: 35 },
        attempts: [],
      };
    },
    async planState() { fullPlanCalls += 1; throw new Error("full action schema must not be used"); },
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const log = fakeLog();
  await runBalatrobot({ projectRoot: ".", config, client, planner, maxSteps: 1, log });
  assert.deepEqual(calls, [{ method: "play", params: { cards: [0, 1] } }]);
  assert.equal(fullPlanCalls, 0);
  assert.ok(JSON.parse(rankedInput.candidateContext).some((candidate) => candidate.id === "play:0,1"));
  assert.ok(log.events.some((event) => event.type === "bot_candidate_ranked" && event.candidateId === "play:0,1"));
});

test("runner escalates a routine shop purchase to the strategic planner", async () => {
  const initial = {
    state: "SHOP",
    seed: "SHOP-APPROVAL",
    ante_num: 2,
    round_num: 4,
    money: 12,
    round: { chips: 0, hands_left: 4, discards_left: 3, reroll_cost: 5 },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 1200 } },
    hand: { count: 0, limit: 8, cards: [] },
    cards: { count: 52, limit: 52, cards: [] },
    jokers: { count: 1, limit: 5, cards: [{ key: "j_joker", set: "JOKER", label: "Joker", value: { effect: "+4 Mult" }, modifier: {}, state: {}, cost: { buy: 0, sell: 1 } }] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { count: 1, limit: 2, cards: [{ key: "j_jolly", set: "JOKER", label: "Jolly Joker", value: { effect: "+8 Mult" }, modifier: {}, state: {}, cost: { buy: 4, sell: 2 } }] },
    vouchers: { count: 0, limit: 1, cards: [] },
    packs: { count: 0, limit: 2, cards: [] },
  };
  const after = { ...initial, money: 8, shop: { count: 0, limit: 2, cards: [] } };
  let routinePlans = 0;
  let strategicPlans = 0;
  const routinePlanner = {
    config: { provider: "ollama-chat", model: "local" },
    async rankCandidate() {
      return { candidateId: "buy:card:0", reason: "买入计分牌", usage: { apiCalls: 1, totalTokens: 5 }, attempts: [] };
    },
    async planState() { routinePlans += 1; throw new Error("routine full plan must not run"); },
  };
  const strategicPlanner = {
    config: { provider: "kimi-chat", model: "k3-256k" },
    async planState() {
      strategicPlans += 1;
      return modelPlan({ ...semanticAction("buy", { card: 0 }), reason: "购买 Jolly Joker" });
    },
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const log = fakeLog();
  await runBalatrobot({
    projectRoot: ".",
    config: { ...config, balatrobotStrategicThinkingEnabled: true, balatrobotStrategicReasoningEffort: "high" },
    client,
    planner: routinePlanner,
    strategicPlanner,
    strategicCheckpointStore: { has() { return true; }, runPlan() { return null; }, mark() {} },
    maxSteps: 1,
    log,
  });
  assert.deepEqual(calls, [{ method: "buy", params: { card: 0 } }]);
  assert.equal(routinePlans, 0);
  assert.equal(strategicPlans, 1);
  assert.ok(log.events.some((event) => event.type === "bot_candidate_escalated" && event.candidateId === "buy:card:0"));
  assert.ok(log.events.some((event) => event.type === "bot_planner_route" && event.route === "strategic-approval"));
});

test("one strategic sell approval completes its exact replacement buy without a second model call", async () => {
  const weakJoker = (key, label) => ({
    id: key,
    key,
    set: "JOKER",
    label,
    value: { effect: "+4 Mult" },
    modifier: {},
    state: {},
    cost: { buy: 0, sell: 1 },
  });
  const replacement = {
    id: "offer-cavendish",
    key: "j_cavendish",
    set: "JOKER",
    label: "Cavendish",
    value: { effect: "X3 Mult" },
    modifier: { edition: "" },
    state: {},
    cost: { buy: 4, sell: 2 },
  };
  const initial = {
    state: "SHOP",
    seed: "SHOP-REPLACEMENT",
    ante_num: 5,
    round_num: 13,
    money: 4,
    round: { chips: 0, hands_left: 4, discards_left: 3, reroll_cost: 5 },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 40_000 } },
    hand: { count: 0, limit: 8, cards: [] },
    cards: { count: 52, limit: 52, cards: [] },
    jokers: { count: 2, limit: 2, cards: [weakJoker("j_joker", "Joker"), weakJoker("j_jolly", "Jolly Joker")] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { count: 1, limit: 2, cards: [replacement] },
    vouchers: { count: 0, limit: 1, cards: [] },
    packs: { count: 0, limit: 2, cards: [] },
  };
  const afterSell = {
    ...initial,
    money: 5,
    jokers: { count: 1, limit: 2, cards: initial.jokers.cards.slice(1) },
  };
  const afterBuy = {
    ...afterSell,
    money: 1,
    jokers: { count: 2, limit: 2, cards: [...afterSell.jokers.cards, replacement] },
    shop: { count: 0, limit: 2, cards: [] },
  };
  let current = initial;
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return current; },
    async call(method, params) {
      calls.push({ method, params });
      current = method === "sell" ? afterSell : afterBuy;
      return current;
    },
  };
  let strategicPlans = 0;
  const strategicPlanner = {
    config: { provider: "kimi-chat", model: "k3-256k" },
    async planState() {
      strategicPlans += 1;
      return modelPlan({ ...semanticAction("sell", { joker: 0 }), reason: "replace a weak flat Joker with Cavendish" });
    },
  };
  const routinePlanner = {
    config: { provider: "deepseek-chat", model: "deepseek-v4-flash" },
    async rankCandidate() { throw new Error("approved continuation must bypass routine ranking"); },
    async planState() { throw new Error("approved continuation must bypass routine planning"); },
  };
  const log = fakeLog();
  await runBalatrobot({
    projectRoot: ".",
    config: {
      ...config,
      balatrobotStrategicThinkingEnabled: true,
      balatrobotStrategicReasoningEffort: "high",
      balatrobotRoutineReasoningEffort: "none",
    },
    client,
    planner: routinePlanner,
    strategicPlanner,
    strategicCheckpointStore: { has() { return false; }, runPlan() { return null; }, mark() {} },
    maxSteps: 2,
    log,
  });

  assert.equal(strategicPlans, 1);
  assert.deepEqual(calls, [
    { method: "sell", params: { joker: 0 } },
    { method: "buy", params: { card: 0 } },
  ]);
  assert.ok(log.events.some((event) => event.type === "bot_shop_sequence_approved" && event.key === "j_cavendish"));
  assert.ok(log.events.some((event) => event.type === "bot_shop_sequence_resolved"));
  assert.ok(log.events.some((event) => event.type === "bot_shop_sequence_completed"));
});

test("runner leaves the shop without destructive fallback when strategic approval is unavailable", async () => {
  const initial = {
    state: "SHOP",
    seed: "SHOP-FAIL-CLOSED",
    ante_num: 2,
    round_num: 4,
    money: 12,
    round: { chips: 0, hands_left: 4, discards_left: 3, reroll_cost: 5 },
    blinds: { big: { type: "BIG", status: "UPCOMING", name: "Big Blind", score: 1200 } },
    hand: { count: 0, limit: 8, cards: [] },
    cards: { count: 52, limit: 52, cards: [] },
    jokers: { count: 1, limit: 5, cards: [{ key: "j_joker", set: "JOKER", label: "Joker", value: { effect: "+4 Mult" }, modifier: {}, state: {}, cost: { buy: 0, sell: 1 } }] },
    consumables: { count: 0, limit: 2, cards: [] },
    shop: { count: 1, limit: 2, cards: [{ key: "j_jolly", set: "JOKER", label: "Jolly Joker", value: { effect: "+8 Mult" }, modifier: {}, state: {}, cost: { buy: 4, sell: 2 } }] },
    vouchers: { count: 0, limit: 1, cards: [] },
    packs: { count: 0, limit: 2, cards: [] },
  };
  const after = { ...initial, state: "BLIND_SELECT" };
  let routineFullPlans = 0;
  const routinePlanner = {
    config: { provider: "ollama-chat", model: "local" },
    async rankCandidate() {
      return { candidateId: "buy:card:0", reason: "buy bridge Joker", usage: { apiCalls: 1, totalTokens: 5 }, attempts: [] };
    },
    async planState() { routineFullPlans += 1; throw new Error("routine planner must not approve shop spending"); },
  };
  const quotaError = new Error("strategic usage limit reached");
  quotaError.usage = { apiCalls: 1, inputTokens: 10, outputTokens: 0, totalTokens: 10 };
  const strategicPlanner = {
    config: { provider: "kimi-chat", model: "k3-256k" },
    async planState() { throw quotaError; },
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const log = fakeLog();

  await runBalatrobot({
    projectRoot: ".",
    config: { ...config, balatrobotStrategicThinkingEnabled: true, balatrobotStrategicReasoningEffort: "high" },
    client,
    planner: routinePlanner,
    strategicPlanner,
    strategicCheckpointStore: { has() { return true; }, runPlan() { return null; }, mark() {} },
    maxSteps: 1,
    log,
  });

  assert.deepEqual(calls, [{ method: "next_round", params: {} }]);
  assert.equal(routineFullPlans, 0);
  assert.ok(log.events.some((event) => event.type === "bot_strategic_unavailable_safe_exit"));
  assert.equal(log.events.find((event) => event.type === "plan").source, "balatrobot_strategic_unavailable_safe_exit");

  const invalidCalls = [];
  const invalidLog = fakeLog();
  const invalidStrategicPlanner = {
    config: { provider: "kimi-chat", model: "k3-256k" },
    async planState() {
      return modelPlan({ ...semanticAction("buy", { card: 0 }), unsupported: true });
    },
  };
  await runBalatrobot({
    projectRoot: ".",
    config: { ...config, balatrobotStrategicThinkingEnabled: true, balatrobotStrategicReasoningEffort: "high" },
    client: {
      baseUrl: config.balatrobotUrl,
      async gamestate() { return initial; },
      async call(method, params) { invalidCalls.push({ method, params }); return after; },
    },
    planner: routinePlanner,
    strategicPlanner: invalidStrategicPlanner,
    strategicCheckpointStore: { has() { return true; }, runPlan() { return null; }, mark() {} },
    maxSteps: 1,
    log: invalidLog,
  });
  assert.deepEqual(invalidCalls, [{ method: "next_round", params: {} }]);
  assert.ok(invalidLog.events.some((event) => event.type === "bot_unapproved_shop_action_blocked"));
});

test("runner injects save-backed unlocks and cards seen this run into build planning", async () => {
  const initial = handState();
  initial.seed = "collection-seed";
  initial.jokers = {
    count: 1,
    limit: 5,
    cards: [{
      key: "j_green_joker",
      set: "JOKER",
      label: "Green Joker",
      value: { effect: "scales" },
      modifier: {},
      state: {},
      cost: { buy: 4, sell: 2 },
    }],
  };
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call() { return { ...initial, round: { ...initial.round, chips: 50 } }; },
  };
  let planningState;
  const planner = {
    async planState(args) {
      planningState = args.gameState;
      return modelPlan(semanticAction("play", { cards: [0, 1] }));
    },
  };
  const profileReader = {
    snapshot() {
      return {
        available: true,
        profile: "1",
        signature: "pool-a",
        unlockedJokerCount: 2,
        totalJokerCount: 3,
        unlockedJokers: [{ key: "j_green_joker", label: "Green Joker" }],
        lockedJokers: [{ key: "j_blueprint", label: "Blueprint" }],
      };
    },
  };
  await runBalatrobot({
    projectRoot: "C:\\tmp\\balatrobot-empty-project",
    config,
    client,
    planner,
    profileReader,
    maxSteps: 1,
    log: fakeLog(),
  });
  assert.equal(planningState.collectionKnowledge.signature, "pool-a");
  assert.deepEqual(planningState.appearedThisRun.jokers.map((joker) => joker.key), ["j_green_joker"]);
  assert.equal(Object.keys(planningState).includes("collectionKnowledge"), false, "knowledge stays out of raw game-state JSON");
});

test("runner reuses one strategic package throughout the same Boss blind", async () => {
  const initial = handState();
  initial.seed = "CHECKPOINT";
  initial.round = { ...initial.round, hands_played: 0, discards_used: 0 };
  initial.blinds = { boss: { type: "BOSS", status: "CURRENT", score: 300 } };
  const afterDiscard = {
    ...initial,
    round: { ...initial.round, hands_left: 1, discards_left: 0, discards_used: 1 },
  };
  const afterPlay = { ...afterDiscard, state: "ROUND_EVAL" };
  const efforts = [];
  const plans = [
    modelPlan(semanticAction("discard", { cards: [2] })),
    modelPlan(semanticAction("play", { cards: [0, 1] })),
  ];
  const planner = {
    async planState(input) {
      efforts.push(input.reasoningEffort);
      return plans.shift();
    },
  };
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method) { return method === "discard" ? afterDiscard : afterPlay; },
  };

  await runBalatrobot({
    projectRoot: ".",
    config: {
      ...config,
      balatrobotStrategicThinkingEnabled: true,
      balatrobotStrategicReasoningEffort: "high",
      balatrobotRoutineReasoningEffort: "none",
      balatrobotStrategicMaxOutputTokens: 1_200,
      maxOutputTokens: 1_200,
      balatrobotHandCandidateLimit: 14,
    },
    client,
    planner,
    maxSteps: 2,
    log: fakeLog(),
  });

  assert.deepEqual(efforts, ["high", "none"]);
});

test("shop purchases and opened packs share one strategic checkpoint", () => {
  const thinking = { strategic: true };
  const shop = { state: "SHOP", seed: "SHOP-CHECKPOINT", ante_num: 2, round_num: 5 };
  const changedShop = { ...shop, money: 2, jokers: { cards: [{ key: "j_blueprint" }] } };
  const pack = { ...changedShop, state: "SMODS_BOOSTER_OPENED", pack: { cards: [{ key: "c_mercury" }] } };
  assert.equal(strategicCheckpointScope(shop, thinking), "SHOP-CHECKPOINT:shop:2:5");
  assert.equal(strategicCheckpointScope(changedShop, thinking), strategicCheckpointScope(shop, thinking));
  assert.equal(strategicCheckpointScope(pack, thinking), strategicCheckpointScope(shop, thinking));
  assert.notEqual(
    strategicCheckpointScope({ ...shop, round_num: 6 }, thinking),
    strategicCheckpointScope(shop, thinking),
  );
});

test("blind strategic checkpoints are distinct for each offered blind and tag", () => {
  const thinking = { strategic: true };
  const small = {
    state: "BLIND_SELECT",
    seed: "BLIND-CHECKPOINT",
    ante_num: 3,
    round_num: 6,
    blinds: { small: { type: "SMALL", status: "SELECT", name: "Small Blind", tagName: "Investment Tag" } },
  };
  const big = {
    ...small,
    blinds: { big: { type: "BIG", status: "SELECT", name: "Big Blind", tagName: "Economy Tag" } },
  };
  assert.match(strategicCheckpointScope(small, thinking), /SMALL:Small Blind:Investment Tag$/);
  assert.notEqual(strategicCheckpointScope(small, thinking), strategicCheckpointScope(big, thinking));
});

test("runner routes strategic checkpoints to Kimi and routine ranking to DeepSeek", async () => {
  const initial = handState();
  initial.seed = "DUAL-ROUTE";
  initial.round = { ...initial.round, hands_played: 0, discards_used: 0 };
  initial.blinds = { boss: { type: "BOSS", status: "CURRENT", score: 300 } };
  const afterDiscard = {
    ...initial,
    round: { ...initial.round, discards_left: 2, discards_used: 1 },
  };
  const afterPlay = { ...afterDiscard, state: "ROUND_EVAL" };
  const routes = [];
  const planner = {
    config: { provider: "deepseek-chat", model: "deepseek-v4-flash" },
    async planState(input) {
      routes.push({ route: "routine", effort: input.reasoningEffort });
      return modelPlan(semanticAction("play", { cards: [0, 1] }));
    },
  };
  const strategicPlanner = {
    config: { provider: "kimi-chat", model: "k3-256k" },
    async planState(input) {
      routes.push({ route: "strategic", effort: input.reasoningEffort });
      return modelPlan(semanticAction("discard", { cards: [2] }));
    },
  };
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method) { return method === "discard" ? afterDiscard : afterPlay; },
  };
  const log = fakeLog();

  await runBalatrobot({
    projectRoot: ".",
    config: {
      ...config,
      balatrobotStrategicThinkingEnabled: true,
      balatrobotStrategicReasoningEffort: "high",
      balatrobotRoutineReasoningEffort: "none",
      balatrobotStrategicMaxOutputTokens: 1_200,
      maxOutputTokens: 1_200,
      balatrobotHandCandidateLimit: 14,
    },
    client,
    planner,
    strategicPlanner,
    maxSteps: 2,
    log,
  });

  assert.deepEqual(routes, [
    { route: "strategic", effort: "high" },
    { route: "routine", effort: "none" },
    { route: "routine", effort: "none" },
  ]);
  assert.deepEqual(
    log.events.filter((event) => event.type === "bot_planner_route").map((event) => [event.route, event.provider]),
    [["strategic", "kimi-chat"], ["routine", "deepseek-chat"]],
  );
});

test("runner uses the DeepSeek routine route when the Kimi strategic route is unavailable", async () => {
  const initial = handState();
  initial.round = { ...initial.round, hands_played: 0, discards_used: 0 };
  initial.blinds = { boss: { type: "BOSS", status: "CURRENT", score: 300 } };
  const after = { ...initial, state: "ROUND_EVAL" };
  const routineInputs = [];
  const planner = {
    config: { provider: "deepseek-chat", model: "deepseek-v4-flash" },
    async planState(input) {
      routineInputs.push(input);
      return modelPlan(semanticAction("play", { cards: [0, 1] }));
    },
  };
  const strategicError = new Error("Kimi temporarily unavailable");
  strategicError.usage = { apiCalls: 1, inputTokens: 20, outputTokens: 0, totalTokens: 20 };
  const strategicPlanner = {
    config: { provider: "kimi-chat", model: "k3-256k" },
    async planState() { throw strategicError; },
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const log = fakeLog();

  const result = await runBalatrobot({
    projectRoot: ".",
    config: {
      ...config,
      balatrobotStrategicThinkingEnabled: true,
      balatrobotStrategicReasoningEffort: "high",
      balatrobotRoutineReasoningEffort: "none",
      balatrobotStrategicMaxOutputTokens: 1_200,
      maxOutputTokens: 1_200,
      balatrobotHandCandidateLimit: 14,
    },
    client,
    planner,
    strategicPlanner,
    maxSteps: 1,
    log,
  });

  assert.deepEqual(calls, [{ method: "discard", params: { cards: [2] } }]);
  assert.equal(routineInputs.length, 2);
  assert.ok(routineInputs.every((input) => input.reasoningEffort === "high"));
  assert.match(routineInputs[0].previousError, /Strategic route unavailable/);
  assert.equal(result.usage.totalTokens, 260);
  assert.ok(log.events.some((event) => event.type === "bot_strategic_planner_fallback"));
});

test("runner does not mislabel GAME_OVER won history as a confirmed victory", async () => {
  const initial = handState();
  const won = { ...initial, state: "GAME_OVER", won: true, ante_num: 8, round_num: 24 };
  const lifecycle = [];
  let plannerInput;
  const experienceStore = {
    enabled: true,
    beginEpisode(input) { lifecycle.push({ type: "begin", ...input }); },
    retrieve() { return { items: [{ actionKey: "play" }], groups: [], searched: 7, elapsedMs: 0.4, truncated: false, cached: false }; },
    contextItems(retrieval) { return retrieval.items; },
    formatContext() { return "similar completed run preferred playing the pair"; },
    chooseFastAction() { return null; },
    recordTransition(input) { lifecycle.push({ type: "record", ...input }); return { id: 11, immediateReward: 4 }; },
    finalizeEpisode(episodeId, outcome, finalState) {
      lifecycle.push({ type: "finalize", episodeId, outcome, finalState });
      return { episodeId, outcome, transitions: 1 };
    },
    markEpisodeInterrupted(episodeId) { lifecycle.push({ type: "interrupt", episodeId }); },
  };
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call() { return won; },
  };
  const planner = {
    async planState(input) {
      plannerInput = input;
      return modelPlan(semanticAction("play", { cards: [0, 1] }));
    },
  };
  const log = fakeLog();

  await runBalatrobot({ projectRoot: ".", config, client, planner, experienceStore, maxSteps: 1, log });

  assert.equal(plannerInput.experienceContext, "similar completed run preferred playing the pair");
  assert.deepEqual(lifecycle.map((item) => item.type), ["begin", "record", "finalize"]);
  assert.equal(lifecycle[1].source, "balatrobot_model");
  assert.equal(lifecycle[2].outcome, "lost");
  assert.ok(log.events.some((event) => event.type === "semantic_transition_recorded"));
  assert.ok(log.events.some((event) => event.type === "semantic_episode_completed"));
});

test("runner uses an exact semantic fast path without calling the planner", async () => {
  const initial = handState();
  const after = { ...initial, state: "ROUND_EVAL", round: { ...initial.round, chips: 120 } };
  let plannerCalls = 0;
  const writes = [];
  const experienceStore = {
    enabled: true,
    beginEpisode() {},
    retrieve() { return { items: [{}], groups: [{}], searched: 3, elapsedMs: 0.1, truncated: false, cached: false }; },
    contextItems() { return []; },
    formatContext() { return ""; },
    chooseFastAction() {
      return {
        action: { method: "play", params: { cards: [0, 1] }, reason: "learned pair" },
        evidence: { samples: 4, trustedSamples: 4, averageReturn: 2.5, positiveRate: 1 },
      };
    },
    recordTransition(input) { writes.push(input); return { id: 1, immediateReward: 0.5 }; },
    finalizeEpisode() { return null; },
    markEpisodeInterrupted() {},
  };
  const calls = [];
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call(method, params) { calls.push({ method, params }); return after; },
  };
  const planner = { async planState() { plannerCalls += 1; throw new Error("should not plan"); } };
  const log = fakeLog();

  await runBalatrobot({ projectRoot: ".", config, client, planner, experienceStore, maxSteps: 1, log });

  assert.equal(plannerCalls, 0);
  assert.deepEqual(calls, [{ method: "play", params: { cards: [0, 1] } }]);
  assert.equal(writes[0].source, "semantic_fast_path");
  assert.ok(log.events.some((event) => event.type === "semantic_fast_path"));
});

test("dry-run semantic retrieval never writes episode or transition data", async () => {
  const initial = handState();
  const writes = [];
  const experienceStore = {
    enabled: true,
    beginEpisode() { writes.push("begin"); },
    retrieve() { return { items: [], groups: [], searched: 0, elapsedMs: 0, truncated: false, cached: false }; },
    contextItems() { return []; },
    formatContext() { return ""; },
    chooseFastAction() { return null; },
    recordTransition() { writes.push("record"); },
    finalizeEpisode() { writes.push("finalize"); },
    markEpisodeInterrupted() { writes.push("interrupt"); },
  };
  const client = {
    baseUrl: config.balatrobotUrl,
    async gamestate() { return initial; },
    async call() { throw new Error("dry-run must not call"); },
  };
  const planner = { async planState() { return modelPlan(semanticAction("play", { cards: [0, 1] })); } };

  await runBalatrobot({ projectRoot: ".", config, client, planner, experienceStore, dryRun: true, maxSteps: 1, log: fakeLog() });

  assert.deepEqual(writes, []);
});
