import fs from "node:fs";
import path from "node:path";

const INITIAL_TAIL_BYTES = 8 * 1024 * 1024;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function activeBlind(state) {
  return Object.values(state?.blinds ?? {}).find((blind) => {
    const status = String(blind?.status ?? "").toUpperCase();
    return status.includes("CURRENT") || status.includes("SELECT");
  }) ?? null;
}

function copyCards(area) {
  return (area?.cards ?? []).map((card) => ({
    index: card.index,
    key: card.key ?? "",
    set: card.set ?? "",
    label: card.label ?? card.key ?? "Unknown",
    rank: card.rank ?? card.value?.rank ?? "",
    suit: card.suit ?? card.value?.suit ?? "",
    effect: card.effect ?? "",
    enhancement: card.enhancement ?? null,
    edition: card.edition ?? null,
    seal: card.seal ?? null,
    eternal: Boolean(card.eternal),
    perishable: card.perishable ?? null,
    rental: Boolean(card.rental),
    debuff: Boolean(card.debuff),
    highlight: Boolean(card.highlight),
    buy: card.buy ?? null,
    sell: card.sell ?? null,
  }));
}

function copyArea(area) {
  return {
    count: number(area?.count, area?.cards?.length ?? 0),
    limit: number(area?.limit, 0),
    cards: copyCards(area),
  };
}

function compactLiveState(state) {
  if (!state) return null;
  const blind = activeBlind(state);
  return {
    state: state.state ?? "UNKNOWN",
    seed: state.seed ?? "",
    ante: number(state.ante),
    round: number(state.roundNumber),
    money: number(state.money),
    won: Boolean(state.won),
    deck: state.deck ?? "",
    stake: state.stake ?? "",
    score: number(state.round?.chips),
    handsLeft: number(state.round?.handsLeft),
    discardsLeft: number(state.round?.discardsLeft),
    blind: blind
      ? {
          type: blind.type ?? "",
          name: blind.name ?? blind.type ?? "",
          effect: blind.effect ?? "",
          score: number(blind.score),
          status: blind.status ?? "",
          tagName: blind.tagName ?? "",
          tagEffect: blind.tagEffect ?? "",
        }
      : null,
    blinds: state.blinds ?? {},
    jokers: copyArea(state.jokers),
    consumables: copyArea(state.consumables),
    hand: { count: number(state.hand?.count), cards: copyCards(state.hand) },
    shop: copyArea(state.shop),
    vouchers: copyArea(state.vouchers),
    packs: copyArea(state.packs),
    openedPack: state.openedPack
      ? { count: number(state.openedPack.count), limit: number(state.openedPack.limit), cards: copyCards(state.openedPack) }
      : null,
  };
}

export class StreamOverlayState {
  constructor(projectRoot, { runsDirectory = path.join(projectRoot, "runs"), staleMs = 20_000 } = {}) {
    this.runsDirectory = runsDirectory;
    this.staleMs = staleMs;
    this.file = null;
    this.runId = null;
    this.offset = 0;
    this.remainder = "";
    this.lastEventAt = null;
    this.state = null;
    this.stateStep = null;
    this.stateAt = null;
    this.thinking = null;
    this.strategy = null;
    this.runMemory = "";
    this.runPlan = null;
    this.pendingAction = null;
    this.lastResult = null;
    this.lastError = null;
  }

  #latestRun() {
    if (!fs.existsSync(this.runsDirectory)) return null;
    let latest = null;
    for (const entry of fs.readdirSync(this.runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith("-bot-run")) continue;
      const file = path.join(this.runsDirectory, entry.name, "events.ndjson");
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { runId: entry.name, file, mtimeMs: stat.mtimeMs };
    }
    return latest;
  }

  #reset(latest) {
    this.file = latest?.file ?? null;
    this.runId = latest?.runId ?? null;
    this.offset = 0;
    this.remainder = "";
    this.lastEventAt = null;
    this.state = null;
    this.stateStep = null;
    this.stateAt = null;
    this.thinking = null;
    this.strategy = null;
    this.runMemory = "";
    this.runPlan = null;
    this.pendingAction = null;
    this.lastResult = null;
    this.lastError = null;
  }

  #readAppended() {
    if (!this.file) return;
    const stat = fs.statSync(this.file);
    if (stat.size < this.offset) this.#reset({ file: this.file, runId: this.runId });
    if (stat.size === this.offset) return;
    const initialTail = this.offset === 0 && stat.size > INITIAL_TAIL_BYTES;
    const start = initialTail ? stat.size - INITIAL_TAIL_BYTES : this.offset;
    const length = stat.size - start;
    const descriptor = fs.openSync(this.file, "r");
    const buffer = Buffer.allocUnsafe(length);
    try {
      fs.readSync(descriptor, buffer, 0, length, start);
    } finally {
      fs.closeSync(descriptor);
    }
    let source = this.remainder + buffer.toString("utf8");
    if (initialTail) {
      const firstBreak = source.indexOf("\n");
      source = firstBreak >= 0 ? source.slice(firstBreak + 1) : "";
    }
    const lines = source.split(/\r?\n/);
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.#ingest(JSON.parse(line));
      } catch {
        // A partially written or historic malformed event must not stop the read-only overlay.
      }
    }
    this.offset = stat.size;
  }

  #ingest(event) {
    if (event.at && (!this.lastEventAt || event.at >= this.lastEventAt)) this.lastEventAt = event.at;
    if (event.type === "bot_state") {
      this.state = event.state ?? null;
      this.stateStep = event.step ?? null;
      this.stateAt = event.at ?? this.stateAt;
      this.pendingAction = null;
      this.lastError = null;
      return;
    }
    if (event.type === "bot_strategy_mode") {
      this.thinking = {
        step: event.step ?? null,
        strategic: Boolean(event.strategic),
        reasoningEffort: event.reasoningEffort ?? "none",
        reason: event.reason ?? "",
        checkpointScope: event.checkpointScope ?? null,
        reusedCheckpoint: Boolean(event.reusedCheckpoint),
        candidates: Array.isArray(event.candidates) ? event.candidates : [],
        at: event.at ?? null,
      };
      return;
    }
    if (event.type === "plan") {
      const nextMemory = String(event.plan?.memory ?? "").trim();
      if (nextMemory) this.runMemory = nextMemory;
      const nextRunPlan = event.plan?.runPlan;
      if (nextRunPlan && typeof nextRunPlan === "object" && Object.values(nextRunPlan).some((value) => String(value ?? "").trim())) {
        this.runPlan = nextRunPlan;
      }
      this.strategy = {
        step: event.step ?? null,
        source: event.source ?? "unknown",
        observation: event.plan?.observation ?? "",
        strategy: event.plan?.strategy ?? "",
        memory: this.runMemory,
        runPlan: this.runPlan,
        confidence: event.plan?.confidence ?? null,
        action: event.botAction ?? null,
        stateSnapshot: compactLiveState(this.state),
        planningMs: number(event.planningMs),
        usage: event.usage ?? null,
        at: event.at ?? null,
      };
      return;
    }
    if (event.type === "rpc_execute") {
      this.pendingAction = {
        step: event.step ?? null,
        method: event.method ?? "",
        params: event.params ?? {},
        reason: event.reason ?? "",
        at: event.at,
      };
      return;
    }
    if (event.type === "rpc_result") {
      this.lastResult = { method: event.method ?? "", state: event.state ?? "", at: event.at };
      this.pendingAction = null;
      return;
    }
    if (event.type === "rpc_rejected" || event.type === "bot_planner_error") {
      this.lastError = { type: event.type, message: event.error ?? event.message ?? "", at: event.at };
    }
  }

  refresh() {
    const latest = this.#latestRun();
    if (!latest) {
      this.#reset(null);
      return this.snapshot();
    }
    if (latest.file !== this.file) this.#reset(latest);
    this.#readAppended();
    return this.snapshot();
  }

  snapshot() {
    const state = compactLiveState(this.state);
    const activityAt = this.lastEventAt ?? this.stateAt;
    const ageMs = activityAt ? Math.max(0, Date.now() - new Date(activityAt).getTime()) : null;
    return {
      generatedAt: new Date().toISOString(),
      connected: ageMs != null && ageMs <= this.staleMs,
      ageMs,
      runId: this.runId,
      step: this.stateStep,
      state,
      thinking: this.thinking,
      strategy: this.strategy,
      pendingAction: this.pendingAction,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }
}
