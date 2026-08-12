import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { BalatroCardAssets } from "../src/balatro-card-assets.mjs";
import { createOverlayServer } from "../src/overlay-server.mjs";
import { overlayThemeForState } from "../src/overlay-theme.mjs";
import { StreamOverlayState } from "../src/stream-overlay-state.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-stream-overlay-"));
  const run = path.join(root, "runs", "2026-08-10T00-00-00-000Z-bot-run");
  fs.mkdirSync(run, { recursive: true });
  return { root, file: path.join(run, "events.ndjson") };
}

function line(type, payload = {}, at = "2026-08-10T00:00:01.000Z") {
  return JSON.stringify({ at, type, ...payload });
}

function liveState() {
  return {
    state: "SELECTING_HAND",
    seed: "STREAM1",
    ante: 2,
    roundNumber: 5,
    money: 9,
    round: { chips: 120, handsLeft: 3, discardsLeft: 2 },
    blinds: { big: { status: "CURRENT", name: "Big Blind", score: 900, effect: "" } },
    jokers: {
      count: 1,
      limit: 5,
      cards: [{ index: 0, key: "j_wily", set: "JOKER", label: "Wily Joker", effect: "+100筹码" }],
    },
    consumables: { count: 0, limit: 2, cards: [] },
    hand: { count: 2, cards: [{ index: 0, rank: "A", suit: "S", label: "Base Card" }] },
  };
}

test("StreamOverlayState incrementally exposes cards, strategy, and action status", () => {
  const item = fixture();
  try {
    fs.writeFileSync(item.file, [
      line("bot_state", { step: 7, state: liveState() }),
      line("bot_strategy_mode", { step: 7, strategic: true, reasoningEffort: "high", reason: "critical blind", candidates: [] }),
      line("plan", {
        step: 7,
        source: "balatrobot_model",
        planningMs: 1234,
        plan: {
          observation: "Pair available",
          strategy: "Build around trips",
          memory: "持有：Wily Joker；核心组合：对子；协同：对子增益；打法：优先对子；阶段目标：稳定过盲",
          runPlan: {
            buildGoal: "对子转三条",
            synergies: "Wily Joker强化三条",
            shopPriorities: "寻找成长小丑",
            handPolicy: "保留对子并积极弃牌",
            nextMilestone: "过当前盲注",
            revisionReason: "首个计分小丑已确定方向",
          },
          confidence: 0.9,
        },
        botAction: { method: "play", params: { cards: [0] }, reason: "score" },
      }),
      line("rpc_execute", { step: 7, method: "play", params: { cards: [0] }, reason: "score" }),
    ].join("\n") + "\n");
    const reader = new StreamOverlayState(item.root, { staleMs: Number.MAX_SAFE_INTEGER });
    const before = reader.refresh();
    assert.equal(before.connected, true);
    assert.equal(before.state.jokers.cards[0].key, "j_wily");
    assert.equal(before.strategy.action.method, "play");
    assert.match(before.strategy.memory, /核心组合：对子/);
    assert.equal(before.strategy.runPlan.shopPriorities, "寻找成长小丑");
    assert.equal(before.strategy.stateSnapshot.round, 5);
    assert.equal(before.strategy.stateSnapshot.hand.cards[0].rank, "A");
    assert.equal(before.strategy.stateSnapshot.hand.cards[0].suit, "S");
    assert.equal(before.thinking.strategic, true);
    assert.equal(before.pendingAction.method, "play");

    fs.appendFileSync(item.file, line("rpc_result", { step: 7, method: "play", state: "HAND_PLAYED" }, "2026-08-10T00:00:02.000Z") + "\n");
    const after = reader.refresh();
    assert.equal(after.pendingAction, null);
    assert.equal(after.lastResult.state, "HAND_PLAYED");

    fs.appendFileSync(
      item.file,
      line("bot_state", { step: 8, state: { ...liveState(), roundNumber: 6 } }, "2026-08-10T00:00:03.000Z") + "\n",
    );
    const next = reader.refresh();
    assert.equal(next.step, 8);
    assert.equal(next.state.round, 6);
    assert.equal(next.strategy.step, 7);
    assert.equal(next.strategy.stateSnapshot.round, 5);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("strategy overlay keeps exactly the three requested panels and prioritizes the run plan", () => {
  const html = fs.readFileSync(path.join(projectRoot, "overlay", "strategy.html"), "utf8");
  assert.equal((html.match(/<section\b/g) ?? []).length, 3);
  assert.match(html, /当前决策/);
  assert.match(html, /AI 完整思路/);
  assert.match(html, /本局构筑计划/);
  assert.match(html, /id="run-plan-list"/);
  assert.match(html, /data-overlay-version="stream-v15"/);
  assert.doesNotMatch(html, /overlay-header|phase-panel|metric-grid|strategy-footer/);
});

test("overlay theme follows exact game phase and active blind", () => {
  assert.equal(overlayThemeForState(null).id, "neutral");
  assert.equal(overlayThemeForState({ state: "SHOP" }).gameColour, "#50846e");
  assert.equal(overlayThemeForState({ state: "SMODS_BOOSTER_OPENED" }).id, "pack");
  assert.equal(overlayThemeForState({ state: "ROUND_EVAL" }).gameColour, "#50846e");
  assert.equal(overlayThemeForState({ state: "BLIND_SELECT" }).gameColour, "#50846e");
  const small = overlayThemeForState({ state: "SELECTING_HAND", blind: { type: "SMALL", name: "Small Blind" } });
  const big = overlayThemeForState({ state: "HAND_PLAYED", blind: { type: "BIG", name: "Big Blind" } });
  assert.equal(small.id, "normal");
  assert.equal(big.id, "normal");
  assert.equal(small.gameColour, "#50846e");
  assert.equal(big.gameColour, "#50846e");
  const manacle = overlayThemeForState({ state: "SELECTING_HAND", blind: { type: "BOSS", name: "The Manacle" } });
  assert.equal(manacle.id, "boss");
  assert.equal(manacle.gameColour, "#575757");
  assert.match(manacle.colors.panel, /^#[0-9a-f]{6}$/u);
  const water = overlayThemeForState({ state: "DRAW_TO_HAND", blind: { type: "BOSS", name: "The Water" } });
  assert.equal(water.gameColour, "#c6e0eb");
  const showdown = overlayThemeForState({ state: "SELECTING_HAND", blind: { type: "BOSS", name: "Violet Vessel" } });
  assert.equal(showdown.id, "showdown");
  assert.equal(showdown.specialColour, "#ff4b40");
});

test("opened booster packs use their native table colour and a crisp set accent", () => {
  const pack = (set) => overlayThemeForState({
    state: "SMODS_BOOSTER_OPENED",
    openedPack: { cards: [{ set }] },
  });

  const planet = pack("PLANET");
  assert.equal(planet.id, "pack");
  assert.equal(planet.gameColour, "#374244");
  assert.equal(planet.accentColour, "#13afce");

  const tarot = pack("TAROT");
  assert.equal(tarot.gameColour, "#8867a5");
  assert.equal(tarot.accentColour, "#a782d1");

  assert.equal(pack("SPECTRAL").gameColour, "#4584fa");
  assert.equal(pack("JOKER").gameColour, "#ff9a00");

  const standard = pack("DEFAULT");
  assert.equal(standard.gameColour, "#2c3536");
  assert.equal(standard.accentColour, "#fe5f55");
});

test("BalatroCardAssets maps local atlas coordinates without writing extracted files", () => {
  const item = fixture();
  const executable = path.join(item.root, "Balatro.exe");
  fs.writeFileSync(executable, "fixture");
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(1420, 16);
  png.writeUInt32BE(3040, 20);
  const assets = new BalatroCardAssets({
    executablePath: executable,
    readEntry(_exe, entry, encoding) {
      if (entry === "game.lua") return "j_wily={name='Wily', set='Joker', pos={x=1,y=14}},\n";
      return encoding ? png.toString(encoding) : png;
    },
  });
  try {
    const card = assets.decorateCard({ key: "j_wily", label: "Wily Joker" });
    assert.deepEqual(card.art, { url: "/assets/game/jokers.png", x: 1, y: 14, columns: 10, rows: 16 });
    assert.equal(assets.getAsset("jokers").buffer, png);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("overlay server exposes two OBS pages, read-only state, and local card art", async () => {
  const item = fixture();
  const overlayDirectory = path.join(item.root, "overlay");
  fs.mkdirSync(overlayDirectory);
  for (const file of ["cards.html", "strategy.html", "common.js", "cards.js", "strategy.js", "styles.css"]) {
    fs.writeFileSync(path.join(overlayDirectory, file), file.endsWith(".html") ? `<title>${file}</title>` : "fixture");
  }
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const stateReader = { refresh: () => ({ connected: true, state: liveState(), strategy: null, thinking: null }) };
  const cardAssets = {
    decorateCard: (card) => ({ ...card, art: { url: "/assets/game/jokers.png", x: 1, y: 14, columns: 10, rows: 16 } }),
    getAsset: () => ({ buffer: png }),
  };
  const server = createOverlayServer({ projectRoot: item.root, stateReader, cardAssets });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const get = (pathname) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathname}`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.headers }));
    }).on("error", reject);
  });
  try {
    const cards = await get("/overlay/cards");
    const strategy = await get("/overlay/strategy");
    const data = await get("/api/overlay");
    const art = await get("/assets/game/jokers.png");
    assert.equal(cards.status, 200);
    assert.equal(strategy.status, 200);
    assert.equal(strategy.headers["cache-control"], "no-store, max-age=0, must-revalidate");
    const snapshot = JSON.parse(data.body);
    assert.equal(snapshot.state.jokers.cards[0].art.x, 1);
    assert.equal(snapshot.theme.id, "normal");
    assert.equal(snapshot.theme.gameColour, "#50846e");
    assert.equal(snapshot.uiVersion, "stream-v15");
    assert.equal(data.headers["cache-control"], "no-store");
    assert.equal(art.headers["content-type"], "image/png");
    assert.deepEqual(art.body, png);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
