import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  apiKeyEnvironment,
  balatrobotBuildPlanningContext,
  compactBalatrobotPromptState,
  extractChatOutputText,
  extractOutputText,
  kimiPromptCacheKey,
  mergeUsage,
  normalizeBalatrobotPlanShape,
  normalizeUsage,
  parsePlanJson,
  VisionPlanner,
} from "../src/planner.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("route-specific credentials override provider-native variables and vision uses the strategy slot", () => {
  const previous = {
    routine: process.env.BALATRO_ROUTINE_API_KEY,
    strategy: process.env.BALATRO_STRATEGY_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    kimi: process.env.KIMI_API_KEY,
  };
  process.env.BALATRO_ROUTINE_API_KEY = "routine-sentinel";
  process.env.BALATRO_STRATEGY_API_KEY = "strategy-sentinel";
  process.env.DEEPSEEK_API_KEY = "native-deepseek-sentinel";
  process.env.KIMI_API_KEY = "native-kimi-sentinel";
  try {
    const routine = new VisionPlanner(projectRoot, {
      provider: "deepseek-chat", plannerRole: "routine", model: "fast", goal: "Win",
    });
    const strategic = new VisionPlanner(projectRoot, {
      provider: "kimi-chat", plannerRole: "strategic", model: "k3", goal: "Win",
    });
    const vision = new VisionPlanner(projectRoot, {
      provider: "kimi-chat", plannerRole: "vision", model: "k3", goal: "Win",
    });
    assert.equal(routine.apiKey, "routine-sentinel");
    assert.equal(strategic.apiKey, "strategy-sentinel");
    assert.equal(vision.apiKey, "strategy-sentinel");
  } finally {
    for (const [name, value] of Object.entries({
      BALATRO_ROUTINE_API_KEY: previous.routine,
      BALATRO_STRATEGY_API_KEY: previous.strategy,
      DEEPSEEK_API_KEY: previous.deepseek,
      KIMI_API_KEY: previous.kimi,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Kimi prompt cache keys are stable per planner role and run seed", () => {
  assert.equal(
    kimiPromptCacheKey({ seed: "ABC 123/!?" }, { plannerRole: "strategic" }),
    "balatro-pilot:rules-v2:strategic:ABC_123",
  );
  assert.equal(
    kimiPromptCacheKey({}, { plannerRole: "routine" }),
    "balatro-pilot:rules-v2:routine:unseeded",
  );
});

test("compactBalatrobotPromptState preserves the exact remaining deck without verbose per-card objects", () => {
  const source = {
    state: "SELECTING_HAND",
    remainingDeck: {
      count: 3,
      cards: [
        { key: "H_A", rank: "A", suit: "H", hidden: true },
        { key: "D_K", rank: "K", suit: "D", enhancement: "GLASS", seal: "PURPLE", hidden: true },
        { key: "H_A", rank: "A", suit: "H", hidden: true },
      ],
    },
  };
  const compact = compactBalatrobotPromptState(source);
  assert.deepEqual(compact.remainingDeck, {
    count: 3,
    cards: ["H_A", "D_K|enh=GLASS|seal=PURPLE", "H_A"],
  });
  assert.equal(source.remainingDeck.cards[0].hidden, true);
  assert.doesNotMatch(JSON.stringify(compact), /hidden/u);
});

test("BalatroBot build context exposes phase, economy, slots, and exact Joker offers", () => {
  const context = balatrobotBuildPlanningContext({
    ante: 4,
    money: 31,
    deck: "BLACK",
    jokers: {
      count: 4,
      limit: 5,
      cards: [{ key: "j_green_joker", set: "JOKER", effect: "scales", rental: true, rentalRate: null }],
    },
    shop: {
      cards: [
        { key: "j_blueprint", set: "JOKER", label: "Blueprint", effect: "copies", buy: 10 },
        { key: "c_mercury", set: "PLANET", label: "Mercury", buy: 3 },
      ],
    },
    shopReroll: {
      target: 10_000,
      estimatedRoundCapacity: 6_200,
      reserve: 12,
      budget: 10,
      remainingDesiredRerolls: 2,
      shouldReroll: true,
    },
    stakeRules: {
      stake: "GOLD",
      appliedStakes: ["WHITE", "RED", "GREEN", "BLACK", "BLUE", "PURPLE", "ORANGE", "GOLD"],
      smallBlindReward: 0,
      scalingTier: 3,
      discardModifier: -1,
      perishableRounds: 5,
      rentalRate: 3,
      signature: "gold-rules-v1",
    },
    stickerEconomy: {
      rentalCount: 1,
      rentalRate: 3,
      rentalUpkeep: 3,
      cashAfterNextUpkeep: 28,
      eternalLockedSlots: 0,
    },
    collectionKnowledge: {
      available: true,
      profile: "1",
      signature: "pool-a",
      unlockedJokerCount: 2,
      totalJokerCount: 3,
      unlockedJokers: [
        { key: "j_green_joker", label: "Green Joker" },
        { key: "j_blueprint", label: "Blueprint" },
      ],
      lockedJokers: [{ key: "j_brainstorm", label: "Brainstorm" }],
      unlockedDecks: [
        { code: "RED", label: "Red Deck", effect: "+1 discard" },
        { code: "BLACK", label: "Black Deck", effect: "+1 Joker slot; -1 hand" },
      ],
      lockedDecks: [{ code: "MAGIC", label: "Magic Deck" }],
    },
    appearedThisRun: {
      jokers: [{ key: "j_blueprint", label: "Blueprint", sources: ["shop_offer"] }],
      consumables: [],
      vouchers: [],
    },
  });
  assert.equal(context.installedVersion, "1.0.1o");
  assert.equal(context.phase, "mid");
  assert.equal(context.defaultInterestBands, 5);
  assert.equal(context.defaultInterestReserve, 12);
  assert.equal(context.shopReroll.budget, 10);
  assert.equal(context.stakeRules.smallBlindReward, 0);
  assert.equal(context.stickerEconomy.rentalUpkeep, 3);
  assert.equal(context.ownedJokers[0].rentalRate, 3);
  assert.equal(context.ownedJokers[0].perishableTally, null);
  assert.equal(context.ownedJokers[0].perishableRounds, null);
  assert.equal(context.offeredJokers[0].rentalRate, null);
  assert.equal(context.offeredJokers[0].perishableTally, null);
  assert.equal(context.freeJokerSlots, 1);
  assert.deepEqual(context.offeredJokers.map((card) => card.key), ["j_blueprint"]);
  assert.deepEqual(context.collectionKnowledge.lockedJokers, [{
    key: "j_brainstorm",
    label: "Brainstorm",
    unlockCondition: null,
  }]);
  assert.deepEqual(context.activeDeck, {
    code: "BLACK",
    label: "Black Deck",
    effect: "+1 Joker slot; -1 hand",
  });
  assert.equal(context.collectionKnowledge.unlockedDecks.length, 2);
  assert.deepEqual(context.appearedThisRun.jokers.map((card) => card.key), ["j_blueprint"]);
  assert.match(context.decisionRequired, /temporary_bridge vs pivot/);
  assert.match(context.decisionRequired, /Eternal\+Rental/);
});

test("Gold planning context preserves debt instead of reporting it as zero cash", () => {
  const context = balatrobotBuildPlanningContext({
    ante: 3,
    money: -8,
    deck: "CHECKERED",
    jokers: { count: 1, limit: 5, cards: [{ key: "j_half", set: "JOKER", rental: true }] },
    shop: { cards: [] },
    stickerEconomy: { rentalCount: 1, rentalRate: 3, rentalUpkeep: 3, cashAfterNextUpkeep: -11 },
  });
  assert.equal(context.money, -8);
  assert.equal(context.defaultInterestBands, 0);
  assert.equal(context.stickerEconomy.cashAfterNextUpkeep, -11);
});

test("extractOutputText reads the Responses API message shape", () => {
  const text = extractOutputText({
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: '{"ok":true}' }],
      },
    ],
  });
  assert.equal(text, '{"ok":true}');
});

test("extractOutputText reports refusals clearly", () => {
  assert.throws(
    () =>
      extractOutputText({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot inspect image" }] }],
      }),
    /Planner refused/,
  );
});

test("extractChatOutputText reads Kimi Chat Completions", () => {
  assert.equal(
    extractChatOutputText({ choices: [{ message: { content: '{"ok":true}' } }] }),
    '{"ok":true}',
  );
  assert.equal(
    extractChatOutputText({ choices: [{ message: { content: [{ type: "text", text: '{"array":true}' }] } }] }),
    '{"array":true}',
  );
  assert.equal(extractChatOutputText({ choices: [{ message: { output_text: '{"fallback":true}' } }] }), '{"fallback":true}');
  assert.equal(apiKeyEnvironment("kimi-chat"), "KIMI_API_KEY");
  assert.equal(apiKeyEnvironment("kimi-platform"), "MOONSHOT_API_KEY");
  assert.equal(apiKeyEnvironment("deepseek-chat"), "DEEPSEEK_API_KEY");
  assert.equal(apiKeyEnvironment("ollama-chat"), null);
});

test("VisionPlanner uses a keyless loopback Ollama chat endpoint", async () => {
  let request;
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "ollama-chat",
      plannerRole: "routine",
      model: "balatro-pilot-qwen:latest",
      goal: "Win",
      reasoningEffort: "none",
      maxOutputTokens: 512,
      imageDetail: "high",
      fallbackImageDetail: "original",
      apiBaseUrl: "http://127.0.0.1:11434/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    {
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
          id: "local-1",
          model: "balatro-pilot-qwen:latest",
          choices: [{ message: { content: "OK" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  );
  const result = await planner.probe();
  assert.equal(result.text, "OK");
  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.body.model, "balatro-pilot-qwen:latest");
  assert.equal(request.body.reasoning_effort, "none");
});

test("VisionPlanner routine ranking returns only a listed local candidate id", async () => {
  let request;
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "ollama-chat",
      plannerRole: "routine",
      model: "balatro-pilot-qwen:latest",
      goal: "Win",
      reasoningEffort: "none",
      maxOutputTokens: 512,
      imageDetail: "high",
      fallbackImageDetail: "original",
      apiBaseUrl: "http://127.0.0.1:11434/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    {
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
          id: "rank-1",
          choices: [{ message: { content: '{"candidateId":"play:0,1","reason":"对子稳定得分"}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  );
  const candidates = [
    { id: "play:0,1", action: { method: "play", cards: [0, 1] }, conservativeScore: 80 },
    { id: "discard:2", action: { method: "discard", cards: [2] }, expectedValue: 30 },
  ];
  const result = await planner.rankCandidate({
    gameState: { state: "SELECTING_HAND", seed: "RANK", hand: { cards: [] } },
    step: 1,
    candidateContext: JSON.stringify(candidates),
  });
  assert.equal(result.candidateId, "play:0,1");
  assert.equal(result.usage.totalTokens, 28);
  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.deepEqual(Object.keys(request.body.response_format), ["type"]);
  assert.match(request.body.messages[0].content, /Never return method, cards, params, actions/);
  assert.doesNotMatch(request.body.messages[0].content, /balatro_rulebook/);
});

test("parsePlanJson locally repairs code fences, surrounding text, and trailing commas", () => {
  const parsed = parsePlanJson('```json\nBefore {"screen":"hand","actions":[{"type":"wait",}],} After\n```');
  assert.equal(parsed.value.screen, "hand");
  assert.equal(parsed.value.actions[0].type, "wait");
  assert.equal(parsed.repaired, true);
});

test("usage helpers preserve cached and reasoning token accounting", () => {
  const first = normalizeUsage({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 25,
    output_tokens_details: { reasoning_tokens: 10 },
    total_tokens: 125,
  });
  assert.deepEqual(mergeUsage(first, first), {
    apiCalls: 2,
    inputTokens: 200,
    cachedInputTokens: 80,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 50,
    reasoningTokens: 20,
    totalTokens: 250,
  });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 80, completion_tokens: 20, cached_tokens: 60, reasoning_tokens: 8 }), {
    apiCalls: 1,
    inputTokens: 80,
    cachedInputTokens: 60,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    reasoningTokens: 8,
    totalTokens: 100,
  });
  const deepseekUsage = normalizeUsage({
      prompt_tokens: 120,
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 30,
      completion_tokens: 20,
      total_tokens: 140,
    });
  assert.equal(deepseekUsage.cachedInputTokens, 90);
  assert.equal(deepseekUsage.cacheMissTokens, 30);
});

test("BalatroBot plan shape repair wraps only a bare actions object", () => {
  const action = { method: "play", cards: [0, 1] };
  const repaired = normalizeBalatrobotPlanShape({ confidence: 0.9, actions: action });
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.plan.actions, [action]);
  const untouched = normalizeBalatrobotPlanShape({ confidence: 0.9, actions: [action] });
  assert.equal(untouched.repaired, false);
  assert.deepEqual(untouched.plan.actions, [action]);
});

test("VisionPlanner escalates image detail only when requested", async () => {
  const details = [];
  const makePlan = (needsDetail) => ({
    observation: needsDetail ? "Text is unreadable" : "Card text is readable",
    strategy: needsDetail ? "Request detail" : "Wait safely",
    memory: "Flush build",
    screen: "hand",
    confidence: needsDetail ? 0.4 : 0.9,
    finished: false,
    needsDetail,
    actions: [{ type: "wait", x: null, y: null, button: null, key: null, ms: 500, reason: "Test" }],
  });
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    details.push(body.input[1].content[1].detail);
    const plan = makePlan(details.length === 1);
    return {
      ok: true,
      json: async () => ({
        id: `response-${details.length}`,
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "openai-responses",
      model: "test-model",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      maxActionsPerTurn: 3,
      imageDetail: "high",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://example.invalid/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );
  const result = await planner.plan({
    pngBase64: "AA==",
    width: 10,
    height: 10,
    step: 1,
    imageMimeType: "image/jpeg",
    experienceContext: "similar shop choice: buy Mercury; average reward 2.1",
  });
  assert.deepEqual(details, ["high", "original"]);
  assert.equal(result.plan.needsDetail, false);
  assert.equal(result.usage.apiCalls, 2);
  assert.equal(result.usage.totalTokens, 240);
});

test("VisionPlanner sends Kimi K3 an OpenAI-compatible multimodal chat request", async () => {
  let requestUrl;
  let requestBody;
  const plan = {
    observation: "Main menu",
    strategy: "Start safely",
    memory: "",
    screen: "main_menu",
    confidence: 0.95,
    finished: false,
    needsDetail: false,
    actions: [{ type: "click", x: 0.25, y: 0.7, button: "left", key: null, ms: null, reason: "Start" }],
  };
  const fetchImpl = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        id: "kimi-response",
        model: "k3-256k",
        choices: [{ message: { content: JSON.stringify(plan) } }],
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      maxActionsPerTurn: 3,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );
  const result = await planner.plan({
    pngBase64: "AA==",
    imageMimeType: "image/jpeg",
    width: 10,
    height: 10,
    step: 1,
    roundContext: "Prior round state: 92/300, need 208, Hands 2, Discards 3.",
  });
  assert.equal(requestUrl, "https://api.kimi.com/coding/v1/chat/completions");
  assert.equal(requestBody.model, "k3-256k");
  assert.equal(requestBody.reasoning_effort, "low");
  assert.equal(requestBody.max_completion_tokens, 700);
  assert.equal("max_tokens" in requestBody, false);
  assert.equal(requestBody.response_format.type, "json_object");
  assert.equal(requestBody.messages[1].content[1].image_url.url, "data:image/jpeg;base64,AA==");
  assert.match(requestBody.messages[1].content[0].text, /Retrieved experience:/);
  assert.match(requestBody.messages[1].content[0].text, /need 208/);
  assert.match(requestBody.messages[0].content, /coordinate-independent decision key/);
  assert.match(requestBody.messages[0].content, /selectedBefore/);
  assert.match(requestBody.messages[0].content, /Balatro operational rulebook/);
  assert.match(requestBody.messages[0].content, /Extra selected cards.*normally \*\*unscored\*\*/);
  assert.match(requestBody.messages[0].content, /AA \+ JJ/);
  assert.match(requestBody.messages[0].content, /cycle fillers/);
  assert.equal(result.plan.observation, "Main menu");
  assert.equal(result.usage.inputTokens, 80);
});

test("VisionPlanner sends Kimi K3 on Open Platform its Moonshot endpoint and thinking parameter", async () => {
  let requestUrl;
  let requestBody;
  const plan = {
    observation: "Main menu",
    strategy: "Start",
    memory: "",
    screen: "main_menu",
    confidence: 0.95,
    finished: false,
    needsDetail: false,
    actions: [{ type: "click", x: 0.5, y: 0.6, button: "left", reason: "Start" }],
  };
  const fetchImpl = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        id: "moonshot-response",
        model: "kimi-k3",
        choices: [{ message: { content: JSON.stringify(plan) } }],
        usage: { prompt_tokens: 90, completion_tokens: 30, cached_tokens: 50, total_tokens: 120 },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-platform",
      model: "kimi-k3",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.moonshot.cn/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );

  const result = await planner.plan({ pngBase64: "AA==", imageMimeType: "image/jpeg", width: 10, height: 10, step: 1 });

  assert.equal(requestUrl, "https://api.moonshot.cn/v1/chat/completions");
  assert.equal(requestBody.model, "kimi-k3");
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in requestBody, false);
  assert.equal(requestBody.max_completion_tokens, 700);
  assert.equal("max_tokens" in requestBody, false);
  assert.equal(requestBody.response_format.type, "json_object");
  assert.equal(result.usage.cachedInputTokens, 50);
});

test("VisionPlanner sends exact BalatroBot state as a text-only semantic request", async () => {
  let requestBody;
  const semanticPlan = {
    observation: "Pair of Aces with one low filler",
    strategy: "Play the pair and cycle the deuce",
    memory: "Pair build",
    confidence: 0.94,
    actions: [
      {
        method: "play",
        cards: [0, 1, 2],
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
        reason: "Score pair and cycle low card",
      },
    ],
  };
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        id: "kimi-bot-response",
        choices: [{ message: { content: JSON.stringify(semanticPlan) } }],
        usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      plannerRole: "strategic",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );
  const result = await planner.planState({
    gameState: {
      seed: "SEED42",
      state: "SELECTING_HAND",
      hand: { cards: [{ index: 0, rank: "A", suit: "H" }] },
    },
    step: 4,
    memory: "Pair build",
    experienceContext: "completed-run evidence: playing the pair had positive return",
  });
  assert.equal(typeof requestBody.messages[1].content, "string");
  assert.match(requestBody.messages[1].content, /SELECTING_HAND/);
  assert.doesNotMatch(requestBody.messages[1].content, /image_url/);
  assert.match(requestBody.messages[0].content, /zero-based/);
  assert.match(requestBody.messages[0].content, /Never return coordinates/);
  assert.match(requestBody.messages[0].content, /select means CHALLENGE/);
  assert.match(requestBody.messages[0].content, /conservativeScore/);
  assert.match(requestBody.messages[0].content, /sell is destructive/);
  assert.match(requestBody.messages[0].content, /Balatro 1\.0\.1o build metagame guide/);
  assert.match(requestBody.messages[0].content, /Balatro strategic rule capsule/);
  assert.doesNotMatch(requestBody.messages[0].content, /<balatro_rulebook>/);
  assert.match(requestBody.messages[0].content, /metaAssessment.*economyPolicy.*pivotPolicy/s);
  assert.match(requestBody.messages[1].content, /<build_planning_context>/);
  assert.match(requestBody.messages[1].content, /<semantic_experience>/);
  assert.match(requestBody.messages[1].content, /playing the pair had positive return/);
  assert.equal(requestBody.prompt_cache_key, "balatro-pilot:rules-v2:strategic:SEED42");
  assert.equal(requestBody.max_completion_tokens, 700);
  assert.equal("max_tokens" in requestBody, false);
  assert.equal(result.plan.actions[0].method, "play");
  assert.equal(result.usage.totalTokens, 250);
});

test("VisionPlanner uses DeepSeek V4 Flash non-thinking JSON mode for exact-state planning", async () => {
  let requestUrl;
  let requestBody;
  const semanticPlan = {
    observation: "Pair of sixes with weak kickers",
    strategy: "Discard weak kickers and preserve the scoring pair",
    memory: "Pair build",
    confidence: 0.91,
    actions: [
      {
        method: "discard",
        cards: [2, 3, 4],
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
        reason: "Draw toward trips or two pair",
      },
    ],
  };
  const fetchImpl = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        id: "deepseek-response",
        model: "deepseek-v4-flash",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(semanticPlan) } }],
        usage: {
          prompt_tokens: 240,
          prompt_cache_hit_tokens: 180,
          prompt_cache_miss_tokens: 60,
          completion_tokens: 55,
          total_tokens: 295,
        },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "deepseek-chat",
      model: "deepseek-v4-flash",
      goal: "Win",
      reasoningEffort: "none",
      maxOutputTokens: 700,
      imageDetail: "high",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.deepseek.com",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );

  const result = await planner.planState({
    gameState: { state: "SELECTING_HAND", hand: { cards: [{ index: 0, rank: "6", suit: "H" }] } },
    step: 7,
  });

  assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(requestBody.model, "deepseek-v4-flash");
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in requestBody, false);
  assert.equal(requestBody.response_format.type, "json_object");
  assert.equal(typeof requestBody.messages[1].content, "string");
  assert.match(requestBody.messages[1].content, /SELECTING_HAND/);
  assert.equal(result.plan.actions[0].method, "discard");
  assert.equal(result.usage.cachedInputTokens, 180);
  assert.equal(result.usage.cacheMissTokens, 60);
});

test("DeepSeek strategic planning enables thinking, receives local candidates, and preserves a cacheable prefix", async () => {
  const requests = [];
  const bareActionPlan = {
    observation: "Pair is real",
    strategy: "Rank a locally checked pair play",
    memory: "Pair build",
    confidence: 0.93,
    actions: {
      method: "play",
      cards: [0, 1],
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
      reason: "Play verified pair",
    },
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "deepseek-chat",
      model: "deepseek-v4-flash",
      goal: "Win",
      reasoningEffort: "none",
      maxOutputTokens: 700,
      imageDetail: "high",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.deepseek.com",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    {
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return {
          ok: true,
          json: async () => ({
            id: `deepseek-strategy-${requests.length}`,
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(bareActionPlan) } }],
            usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 20 },
          }),
        };
      },
    },
  );
  const input = {
    gameState: { state: "SELECTING_HAND", hand: { cards: [{ index: 0, rank: "6" }, { index: 1, rank: "6" }] } },
    step: 8,
    candidateContext: JSON.stringify([{ action: { method: "play", cards: [0, 1] }, handType: "Pair" }]),
    reasoningEffort: "high",
  };
  const first = await planner.planState(input);
  await planner.planState({ ...input, step: 9 });
  assert.deepEqual(requests[0].thinking, { type: "enabled" });
  assert.equal(requests[0].reasoning_effort, "high");
  assert.match(requests[0].messages[0].content, /Simplified Chinese/);
  assert.match(requests[0].messages[0].content, /持有：.*核心组合：.*协同：.*打法：.*阶段目标：/s);
  assert.match(requests[0].messages[1].content, /local_action_candidates/);
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
  assert.equal(first.plan.actions[0].method, "play");
  assert.equal(first.attempts[0].shapeRepaired, true);
});

test("DeepSeek length recovery disables thinking and preserves room for complete action JSON", async () => {
  const requests = [];
  const completePlan = {
    observation: "Exact hand is unchanged",
    strategy: "Use the verified pair candidate",
    memory: "Pair build",
    confidence: 0.94,
    actions: {
      method: "play",
      cards: [0, 1],
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
      reason: "Play verified pair",
    },
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "deepseek-chat",
      model: "deepseek-v4-flash",
      goal: "Win",
      reasoningEffort: "none",
      maxOutputTokens: 1_200,
      imageDetail: "high",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.deepseek.com",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    {
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push(request);
        const first = requests.length === 1;
        return {
          ok: true,
          json: async () => ({
            id: `deepseek-recovery-${requests.length}`,
            choices: [{
              finish_reason: first ? "length" : "stop",
              message: first
                ? { content: "", reasoning_content: "reasoning consumed the completion budget" }
                : { content: JSON.stringify(completePlan) },
            }],
            usage: first
              ? { prompt_tokens: 100, completion_tokens: 1_200, completion_tokens_details: { reasoning_tokens: 1_200 } }
              : { prompt_tokens: 100, completion_tokens: 100 },
          }),
        };
      },
    },
  );

  const result = await planner.planState({
    gameState: { state: "SELECTING_HAND", hand: { cards: [{ index: 0, rank: "6" }, { index: 1, rank: "6" }] } },
    step: 8,
    reasoningEffort: "high",
    maxOutputTokens: 1_200,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 1_200);
  assert.deepEqual(requests[0].thinking, { type: "enabled" });
  assert.equal(requests[0].reasoning_effort, "high");
  assert.equal(requests[1].max_tokens, 2_400);
  assert.deepEqual(requests[1].thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in requests[1], false);
  assert.match(requests[1].messages[1].content, /strategic_reasoning_draft/);
  assert.match(requests[1].messages[1].content, /reasoning consumed the completion budget/);
  assert.equal(result.plan.actions[0].method, "play");
  assert.equal(result.usage.apiCalls, 2);
  assert.equal(result.attempts[0].reasoningEffort, "high");
  assert.equal(result.attempts[1].reasoningEffort, "none");
});

test("VisionPlanner rejects screenshot planning through the text-only DeepSeek route", async () => {
  let fetchCalled = false;
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "deepseek-chat",
      model: "deepseek-v4-flash",
      goal: "Win",
      reasoningEffort: "none",
      maxOutputTokens: 700,
      imageDetail: "high",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.deepseek.com",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl: async () => { fetchCalled = true; } },
  );

  await assert.rejects(
    () => planner.plan({ pngBase64: "AA==", imageMimeType: "image/jpeg", width: 10, height: 10, step: 1 }),
    /cannot read screenshots/,
  );
  assert.equal(fetchCalled, false);
});

test("VisionPlanner retries truncated Kimi JSON with a larger output allowance", async () => {
  const limits = [];
  const completePlan = {
    observation: "Hand visible",
    strategy: "Play pair",
    memory: "Pair build",
    screen: "hand",
    confidence: 0.9,
    finished: false,
    needsDetail: false,
    actions: [{ type: "click", x: 0.5, y: 0.8, button: "left", reason: "Play Hand" }],
  };
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    limits.push(request.max_completion_tokens);
    const truncated = limits.length === 1;
    return {
      ok: true,
      json: async () => ({
        id: `kimi-${limits.length}`,
        choices: [
          {
            finish_reason: truncated ? "length" : "stop",
            message: { content: truncated ? '{"observation":"cut' : JSON.stringify(completePlan) },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: truncated ? 700 : 100, total_tokens: truncated ? 750 : 150 },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );
  const result = await planner.plan({ pngBase64: "AA==", width: 10, height: 10, step: 1 });
  assert.deepEqual(limits, [700, 1600]);
  assert.equal(result.plan.screen, "hand");
  assert.equal(result.usage.apiCalls, 2);
  assert.equal(result.usage.totalTokens, 900);
  assert.equal(result.attempts[0].truncated, true);
});

test("VisionPlanner retries a successful Kimi response whose final content is empty", async () => {
  const limits = [];
  const completePlan = {
    observation: "Blind select",
    strategy: "Choose the small blind",
    memory: "Fresh run",
    screen: "blind_select",
    confidence: 0.9,
    finished: false,
    needsDetail: false,
    actions: [{ type: "click", x: 0.5, y: 0.7, button: "left", reason: "Select blind" }],
  };
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    limits.push(request.max_completion_tokens);
    const empty = limits.length === 1;
    return {
      ok: true,
      json: async () => ({
        id: `kimi-empty-${limits.length}`,
        choices: [
          {
            finish_reason: empty ? "length" : "stop",
            message: {
              content: empty ? null : JSON.stringify(completePlan),
              reasoning_content: empty ? "Internal reasoning used the entire completion budget." : "",
            },
          },
        ],
        usage: { prompt_tokens: 60, completion_tokens: empty ? 700 : 90, total_tokens: empty ? 760 : 150 },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );
  const result = await planner.plan({ pngBase64: "AA==", width: 10, height: 10, step: 1 });
  assert.deepEqual(limits, [700, 1600]);
  assert.equal(result.plan.screen, "blind_select");
  assert.equal(result.usage.apiCalls, 2);
  assert.equal(result.usage.totalTokens, 910);
  assert.equal(result.attempts[0].emptyContent, true);
  assert.equal(result.attempts[0].diagnostics.reasoningLength, 53);
});

test("VisionPlanner preserves usage and diagnostics when both Kimi attempts are empty", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return {
      ok: true,
      json: async () => ({
        id: `kimi-empty-${call}`,
        choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking" } }],
        usage: { prompt_tokens: 50, completion_tokens: 700, total_tokens: 750 },
      }),
    };
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 0,
      apiTimeoutMs: 1_000,
    },
    { apiKey: "test-key", fetchImpl },
  );
  await assert.rejects(
    () => planner.plan({ pngBase64: "AA==", width: 10, height: 10, step: 1 }),
    (error) => {
      assert.equal(error.code, "PLAN_JSON_INVALID");
      assert.equal(error.usage.apiCalls, 2);
      assert.equal(error.usage.totalTokens, 1500);
      assert.equal(error.recoveryAttempts.length, 2);
      assert.equal(error.recoveryAttempts[1].emptyContent, true);
      return true;
    },
  );
});

test("VisionPlanner propagates caller cancellation into BalatroBot HTTP without retrying", async () => {
  const fetchSignals = [];
  let fetchCalls = 0;
  const fetchImpl = async (_url, options) => {
    fetchCalls += 1;
    fetchSignals.push(options.signal);
    return await new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("fetch aborted");
        error.name = "AbortError";
        reject(error);
      };
      options.signal.addEventListener("abort", rejectAbort, { once: true });
      if (options.signal.aborted) rejectAbort();
    });
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "low",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 2,
      apiTimeoutMs: 10_000,
    },
    { apiKey: "test-key", fetchImpl },
  );
  const controller = new AbortController();
  const pending = planner.planState({
    gameState: { state: "SELECTING_HAND", hand: { cards: [{ index: 0, rank: "A", suit: "H" }] } },
    step: 1,
    signal: controller.signal,
  });

  controller.abort(new Error("operator stop"));

  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /operator stop/);
    return true;
  });
  assert.equal(fetchCalls, 1);
  assert.equal(fetchSignals[0].aborted, true);
});

test("VisionPlanner hands off after one bounded provider timeout without retrying", async () => {
  let fetchCalls = 0;
  const fetchImpl = async (_url, options) => {
    fetchCalls += 1;
    return await new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("fetch aborted");
        error.name = "AbortError";
        reject(error);
      };
      options.signal.addEventListener("abort", rejectAbort, { once: true });
      if (options.signal.aborted) rejectAbort();
    });
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "medium",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 2,
      apiTimeoutMs: 20,
    },
    { apiKey: "test-key", fetchImpl },
  );

  await assert.rejects(
    () =>
      planner.planState({
        gameState: { state: "SELECTING_HAND", hand: { cards: [{ index: 0, rank: "A", suit: "H" }] } },
        step: 1,
      }),
    (error) => {
      assert.match(error.message, /timed out after 20ms/i);
      assert.equal(error.code, "PLANNER_TIMEOUT");
      assert.equal(error.timeoutMs, 20);
      assert.equal(error.provider, "kimi-chat");
      assert.equal(error.model, "k3-256k");
      assert.ok(error.elapsedMs >= 15);
      return true;
    },
  );
  assert.equal(fetchCalls, 1);
});

test("VisionPlanner preserves first-attempt usage when JSON recovery times out", async () => {
  let fetchCalls = 0;
  const fetchImpl = async (_url, options) => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return {
        ok: true,
        json: async () => ({
          id: "invalid-first",
          choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "unfinished" } }],
          usage: { prompt_tokens: 100, completion_tokens: 700, total_tokens: 800 },
        }),
      };
    }
    return await new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("fetch aborted");
        error.name = "AbortError";
        reject(error);
      };
      options.signal.addEventListener("abort", rejectAbort, { once: true });
      if (options.signal.aborted) rejectAbort();
    });
  };
  const planner = new VisionPlanner(
    projectRoot,
    {
      provider: "kimi-chat",
      model: "k3-256k",
      goal: "Win",
      reasoningEffort: "medium",
      maxOutputTokens: 700,
      imageDetail: "original",
      fallbackImageDetail: "original",
      apiBaseUrl: "https://api.kimi.com/coding/v1",
      apiRetries: 0,
      apiTimeoutMs: 20,
    },
    { apiKey: "test-key", fetchImpl },
  );

  await assert.rejects(
    () => planner.planState({ gameState: { state: "SELECTING_HAND" }, step: 1 }),
    (error) => {
      assert.equal(error.code, "PLANNER_TIMEOUT");
      assert.equal(error.usage.apiCalls, 1);
      assert.equal(error.usage.totalTokens, 800);
      assert.equal(error.recoveryAttempts.length, 2);
      assert.equal(error.recoveryAttempts[0].invalid, true);
      assert.equal(error.recoveryAttempts[1].timedOut, true);
      return true;
    },
  );
  assert.equal(fetchCalls, 2);
});
