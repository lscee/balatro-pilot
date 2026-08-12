import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { archiveEntry, findBalatroExecutable } from "./balatro-card-assets.mjs";

function readCompressedLua(filePath, readFile = fs.readFileSync) {
  const bytes = readFile(filePath);
  try {
    return inflateRawSync(bytes).toString("utf8");
  } catch {
    const text = Buffer.from(bytes).toString("utf8");
    if (/^\s*return\s*\{/u.test(text)) return text;
    throw new Error(`${path.basename(filePath)} is not a readable Balatro save table`);
  }
}

function tableBody(source, name) {
  const marker = `["${name}"]={`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return "";
  const start = source.indexOf("{", markerIndex + marker.length - 1);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  return "";
}

function trueKeys(source, name) {
  const body = tableBody(source, name);
  return new Set([...body.matchAll(/\["([^"]+)"\]=true/gu)].map((match) => match[1]));
}

function scalarNumber(source, name) {
  const match = source.match(new RegExp(`\\["${name}"\\]=(-?\\d+)`, "u"));
  return match ? Number(match[1]) : null;
}

function scalarBoolean(source, name) {
  const match = source.match(new RegExp(`\\["${name}"\\]=(true|false)`, "u"));
  return match ? match[1] === "true" : false;
}

export function parseVanillaJokerCatalog(source) {
  const jokers = [];
  for (const line of String(source ?? "").split(/\r?\n/u)) {
    const key = line.match(/^\s*(j_[a-z0-9_]+)\s*=\s*\{/iu)?.[1]?.toLowerCase();
    if (!key) continue;
    const label = line.match(/\bname\s*=\s*"([^"]+)"/u)?.[1] ?? key;
    const unlocked = line.match(/\bunlocked\s*=\s*(true|false)/u)?.[1];
    const rarity = Number(line.match(/\brarity\s*=\s*(\d+)/u)?.[1]) || null;
    if (!unlocked) continue;
    jokers.push({ key, label, rarity, defaultUnlocked: unlocked === "true" });
  }
  return jokers.sort((left, right) => left.key.localeCompare(right.key));
}

const VANILLA_DECK_EFFECTS = Object.freeze({
  b_red: "+1 discard each round",
  b_blue: "+1 hand each round",
  b_yellow: "Start with $10 extra",
  b_green: "+$2 per remaining hand and +$1 per remaining discard; no interest",
  b_black: "+1 Joker slot; -1 hand each round",
  b_magic: "Start with Crystal Ball and two copies of The Fool",
  b_nebula: "Start with Telescope; -1 consumable slot",
  b_ghost: "Spectral cards can appear in the shop; start with Hex",
  b_abandoned: "Start with no face cards",
  b_checkered: "Start with 26 Spades and 26 Hearts",
  b_zodiac: "Start with Tarot Merchant, Planet Merchant, and Overstock",
  b_painted: "+2 hand size; -1 Joker slot",
  b_anaglyph: "Gain a Double Tag after defeating each Boss Blind",
  b_plasma: "Balance Chips and Mult when scoring; Blind sizes are doubled",
  b_erratic: "Starting deck ranks and suits are randomized",
});

export function parseVanillaDeckCatalog(source) {
  const decks = [];
  for (const line of String(source ?? "").split(/\r?\n/u)) {
    const key = line.match(/^\s*(b_[a-z0-9_]+)\s*=\s*\{/iu)?.[1]?.toLowerCase();
    if (!key) continue;
    const label = line.match(/\bname\s*=\s*"([^"]+)"/u)?.[1] ?? key;
    const unlocked = line.match(/\bunlocked\s*=\s*(true|false)/u)?.[1];
    const order = Number(line.match(/\border\s*=\s*(\d+)/u)?.[1]) || null;
    const omitted = /\bomit\s*=\s*true\b/u.test(line);
    if (!unlocked || omitted || !(key in VANILLA_DECK_EFFECTS)) continue;
    decks.push({
      key,
      code: key.slice(2).toUpperCase(),
      label,
      effect: VANILLA_DECK_EFFECTS[key],
      order,
      defaultUnlocked: unlocked === "true",
    });
  }
  return decks.sort((left, right) => (left.order ?? 999) - (right.order ?? 999));
}

function collectionSignature(keys) {
  return createHash("sha256").update([...keys].sort().join("\n")).digest("hex").slice(0, 16);
}

export class BalatroProfileReader {
  constructor({
    appData = process.env.APPDATA,
    profile = null,
    executablePath,
    readFile = fs.readFileSync,
    stat = fs.statSync,
    readEntry = archiveEntry,
  } = {}) {
    this.appData = appData;
    this.profile = profile == null ? null : String(profile);
    this.executablePath = findBalatroExecutable(executablePath);
    this.readFile = readFile;
    this.stat = stat;
    this.readEntry = readEntry;
    this.catalog = null;
    this.deckCatalog = null;
    this.cached = null;
    this.cacheKey = "";
  }

  #catalog() {
    if (this.catalog) return this.catalog;
    if (!this.executablePath) throw new Error("Balatro.exe was not found, so the installed Joker pool cannot be read");
    const gameLua = this.readEntry(this.executablePath, "game.lua", "utf8");
    this.catalog = parseVanillaJokerCatalog(gameLua);
    if (!this.catalog.length) throw new Error("The installed Balatro game.lua did not contain a Joker catalog");
    return this.catalog;
  }

  #decks() {
    if (this.deckCatalog) return this.deckCatalog;
    if (!this.executablePath) throw new Error("Balatro.exe was not found, so the installed deck pool cannot be read");
    const gameLua = this.readEntry(this.executablePath, "game.lua", "utf8");
    this.deckCatalog = parseVanillaDeckCatalog(gameLua);
    if (!this.deckCatalog.length) throw new Error("The installed Balatro game.lua did not contain a deck catalog");
    return this.deckCatalog;
  }

  #selectedProfile(root) {
    if (this.profile) return this.profile;
    const settingsPath = path.join(root, "settings.jkr");
    try {
      return String(scalarNumber(readCompressedLua(settingsPath, this.readFile), "profile") ?? 1);
    } catch {
      return "1";
    }
  }

  snapshot() {
    try {
      if (!this.appData) throw new Error("APPDATA is unavailable");
      const root = path.join(this.appData, "Balatro");
      const profile = this.#selectedProfile(root);
      if (!/^\d+$/u.test(profile)) throw new Error(`invalid Balatro profile ${profile}`);
      const profileDir = path.join(root, profile);
      const metaPath = path.join(profileDir, "meta.jkr");
      const profilePath = path.join(profileDir, "profile.jkr");
      const metaStat = this.stat(metaPath);
      const profileStat = this.stat(profilePath);
      const cacheKey = `${profile}:${metaStat.size}:${metaStat.mtimeMs}:${profileStat.size}:${profileStat.mtimeMs}`;
      if (this.cached && this.cacheKey === cacheKey) return this.cached;

      const catalog = this.#catalog();
      const deckCatalog = this.#decks();
      const meta = readCompressedLua(metaPath, this.readFile);
      const profileLua = readCompressedLua(profilePath, this.readFile);
      const unlockedFromProfile = trueKeys(meta, "unlocked");
      const discoveredFromProfile = trueKeys(meta, "discovered");
      const allUnlocked = scalarBoolean(profileLua, "all_unlocked");
      const unlocked = catalog.filter((joker) => allUnlocked || joker.defaultUnlocked || unlockedFromProfile.has(joker.key));
      const locked = catalog.filter((joker) => !allUnlocked && !joker.defaultUnlocked && !unlockedFromProfile.has(joker.key));
      const unlockedKeys = unlocked.map((joker) => joker.key);
      const unlockedDecks = deckCatalog.filter(
        (deck) => allUnlocked || deck.defaultUnlocked || unlockedFromProfile.has(deck.key),
      );
      const lockedDecks = deckCatalog.filter(
        (deck) => !allUnlocked && !deck.defaultUnlocked && !unlockedFromProfile.has(deck.key),
      );
      this.cacheKey = cacheKey;
      this.cached = Object.freeze({
        available: true,
        profile,
        allUnlocked,
        signature: collectionSignature([...unlockedKeys, ...unlockedDecks.map((deck) => deck.key)]),
        unlockedJokerCount: unlocked.length,
        totalJokerCount: catalog.length,
        unlockedJokers: unlocked.map((joker) => ({
          key: joker.key,
          label: joker.label,
          rarity: joker.rarity,
          discovered: joker.defaultUnlocked || discoveredFromProfile.has(joker.key),
        })),
        lockedJokers: locked.map((joker) => ({ key: joker.key, label: joker.label, rarity: joker.rarity })),
        unlockedDeckCount: unlockedDecks.length,
        totalDeckCount: deckCatalog.length,
        unlockedDecks: unlockedDecks.map((deck) => ({ ...deck })),
        lockedDecks: lockedDecks.map((deck) => ({ ...deck })),
      });
      return this.cached;
    } catch (error) {
      return Object.freeze({
        available: false,
        profile: this.profile ?? null,
        allUnlocked: false,
        signature: "unavailable",
        unlockedJokerCount: 0,
        totalJokerCount: 0,
        unlockedJokers: [],
        lockedJokers: [],
        unlockedDeckCount: 0,
        totalDeckCount: 0,
        unlockedDecks: [],
        lockedDecks: [],
        error: error.message,
      });
    }
  }
}

function areaCards(area) {
  return Array.isArray(area?.cards) ? area.cards : [];
}

function observedCard(card, source, state) {
  const key = String(card?.key ?? "").trim().toLowerCase();
  if (!key || !/^[jcpv]_/u.test(key)) return null;
  return {
    key,
    label: String(card?.label ?? key),
    set: String(card?.set ?? ""),
    source,
    firstAnte: Number.isFinite(Number(state?.ante_num ?? state?.ante)) ? Number(state.ante_num ?? state.ante) : null,
    firstRound: Number.isFinite(Number(state?.round_num ?? state?.roundNumber))
      ? Number(state.round_num ?? state.roundNumber)
      : null,
    timesSeen: 1,
  };
}

export class BalatroRunCardTracker {
  constructor() {
    this.seed = null;
    this.cards = new Map();
  }

  reset(seed = null) {
    this.seed = seed == null ? null : String(seed);
    this.cards.clear();
  }

  observe(state) {
    const seed = state?.seed == null ? null : String(state.seed);
    if (seed && this.seed && seed !== this.seed) this.reset(seed);
    else if (seed && !this.seed) this.seed = seed;
    const sources = [
      ["owned_joker", state?.jokers],
      ["owned_consumable", state?.consumables],
      ["shop_offer", state?.shop],
      ["voucher_offer", state?.vouchers],
      ["pack_offer", state?.packs],
      ["opened_pack", state?.pack],
    ];
    for (const [source, area] of sources) {
      for (const card of areaCards(area)) {
        const observed = observedCard(card, source, state);
        if (!observed) continue;
        const previous = this.cards.get(observed.key);
        if (previous) {
          previous.timesSeen += 1;
          if (!previous.sources.includes(source)) previous.sources.push(source);
          if (observed.label && observed.label !== observed.key) previous.label = observed.label;
          if (Number.isFinite(observed.firstAnte)) {
            previous.firstAnte = Number.isFinite(previous.firstAnte)
              ? Math.min(previous.firstAnte, observed.firstAnte)
              : observed.firstAnte;
          }
          if (Number.isFinite(observed.firstRound)) {
            previous.firstRound = Number.isFinite(previous.firstRound)
              ? Math.min(previous.firstRound, observed.firstRound)
              : observed.firstRound;
          }
        } else {
          this.cards.set(observed.key, { ...observed, sources: [source] });
        }
      }
    }
    return this.snapshot();
  }

  hydrateFromRuns(projectRoot, seed, { maximumRuns = 20 } = {}) {
    const normalizedSeed = String(seed ?? "").trim();
    if (!normalizedSeed || !projectRoot) return this.snapshot();
    const runsRoot = path.join(projectRoot, "runs");
    let directories;
    try {
      directories = fs.readdirSync(runsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const directory = path.join(runsRoot, entry.name);
          return { directory, mtimeMs: fs.statSync(directory).mtimeMs };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
    } catch {
      return this.snapshot();
    }
    let matchingRuns = 0;
    for (const { directory } of directories) {
      if (matchingRuns >= maximumRuns) break;
      const eventPath = path.join(directory, "events.ndjson");
      let matched = false;
      let source;
      try {
        source = fs.readFileSync(eventPath, "utf8");
      } catch {
        continue;
      }
      for (const line of source.split(/\r?\n/u)) {
        if (!line.includes('"type":"bot_state"') || !line.includes(normalizedSeed)) continue;
        try {
          const event = JSON.parse(line);
          if (String(event?.state?.seed ?? "") !== normalizedSeed) continue;
          this.observe(event.state);
          matched = true;
        } catch {
          // Keep the rest of an append-only run log usable after one partial line.
        }
      }
      if (matched) matchingRuns += 1;
    }
    return this.snapshot();
  }

  snapshot() {
    const values = [...this.cards.values()]
      .map(({ source: _source, ...card }) => ({ ...card }))
      .sort((left, right) => left.key.localeCompare(right.key));
    return {
      seed: this.seed,
      jokers: values.filter((card) => card.key.startsWith("j_")),
      consumables: values.filter((card) => card.key.startsWith("c_") || card.key.startsWith("p_")),
      vouchers: values.filter((card) => card.key.startsWith("v_")),
    };
  }
}

export function contextualBalatrobotState(state, collectionKnowledge, appearedThisRun) {
  return {
    ...state,
    collection_knowledge: collectionKnowledge ?? null,
    appeared_this_run: appearedThisRun ?? null,
  };
}
