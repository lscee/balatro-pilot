import fs from "node:fs";
import path from "node:path";

import { localAppDataFile, readJsonFile, writeJsonFileAtomic } from "../persistent-json.mjs";
import { mergeUsage } from "./planner.mjs";

const MODES = new Set(["local", "deepseek"]);

function defaultStatePath() {
  return localAppDataFile("routine-backend.json");
}

function normalizeMode(value, fallback = "local") {
  return MODES.has(value) ? value : fallback;
}

async function fetchJson(fetchImpl, url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Ollama request timed out")), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `${response.status} ${response.statusText}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export class RoutineBackendController {
  constructor({
    statePath = defaultStatePath(),
    defaultMode = "local",
    ollamaBaseUrl = "http://127.0.0.1:11434",
    ollamaModel = "balatro-pilot-qwen:latest",
    fetchImpl = fetch,
    localFailureCooldownMs = 60_000,
  } = {}) {
    this.statePath = path.resolve(statePath);
    this.defaultMode = normalizeMode(defaultMode);
    this.ollamaBaseUrl = ollamaBaseUrl.replace(/\/$/u, "");
    this.ollamaModel = ollamaModel;
    this.fetch = fetchImpl;
    this.localFailureCooldownMs = localFailureCooldownMs;
    this.localSuspendedUntil = 0;
    this.cachedState = null;
    this.cachedStateMtimeNs = null;
  }

  read() {
    try {
      const mtimeNs = fs.statSync(this.statePath, { bigint: true }).mtimeNs;
      if (this.cachedState && mtimeNs === this.cachedStateMtimeNs) return this.cachedState;
      const stored = readJsonFile(this.statePath, null, (value) => value && typeof value === "object");
      if (!stored) throw new Error("missing routine backend state");
      this.cachedStateMtimeNs = mtimeNs;
      this.cachedState = Object.freeze({
        mode: normalizeMode(stored.mode, this.defaultMode),
        updatedAt: stored.updatedAt ?? null,
        updatedBy: stored.updatedBy ?? null,
      });
      return this.cachedState;
    } catch {
      this.cachedStateMtimeNs = null;
      return (this.cachedState = Object.freeze({ mode: this.defaultMode, updatedAt: null, updatedBy: null }));
    }
  }

  setMode(mode, { updatedBy = "dashboard" } = {}) {
    const normalized = normalizeMode(mode, "");
    if (!normalized) throw new Error("mode must be local or deepseek");
    const state = { mode: normalized, updatedAt: new Date().toISOString(), updatedBy };
    writeJsonFileAtomic(this.statePath, state);
    this.cachedState = Object.freeze(state);
    this.cachedStateMtimeNs = null;
    if (normalized === "local") this.localSuspendedUntil = 0;
    return state;
  }

  select({ localPlanner, deepseekPlanner }) {
    const requested = this.read().mode;
    const localCoolingDown = Date.now() < this.localSuspendedUntil;
    if (requested === "local" && localPlanner && !localCoolingDown) {
      return { requested, effective: "local", planner: localPlanner, localCoolingDown: false };
    }
    return {
      requested,
      effective: "deepseek",
      planner: deepseekPlanner,
      localCoolingDown: requested === "local" && localCoolingDown,
    };
  }

  recordLocalFailure() {
    this.localSuspendedUntil = Date.now() + this.localFailureCooldownMs;
  }

  recordLocalSuccess() {
    this.localSuspendedUntil = 0;
  }

  async ollamaStatus() {
    try {
      const [tags, processes] = await Promise.all([
        fetchJson(this.fetch, `${this.ollamaBaseUrl}/api/tags`, {}, 3_000),
        fetchJson(this.fetch, `${this.ollamaBaseUrl}/api/ps`, {}, 3_000),
      ]);
      const installed = (tags?.models ?? []).some((item) => item.name === this.ollamaModel || item.model === this.ollamaModel);
      const loaded = (processes?.models ?? []).some((item) => item.name === this.ollamaModel || item.model === this.ollamaModel);
      return { reachable: true, installed, loaded, model: this.ollamaModel, error: null };
    } catch (error) {
      return { reachable: false, installed: false, loaded: false, model: this.ollamaModel, error: error.message };
    }
  }

  async loadLocalModel() {
    await fetchJson(
      this.fetch,
      `${this.ollamaBaseUrl}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.ollamaModel, prompt: "", stream: false, keep_alive: "30m" }),
      },
      120_000,
    );
    return this.ollamaStatus();
  }

  async unloadLocalModel() {
    const before = await this.ollamaStatus();
    if (!before.reachable || !before.loaded) return before;
    await fetchJson(
      this.fetch,
      `${this.ollamaBaseUrl}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.ollamaModel, prompt: "", stream: false, keep_alive: 0 }),
      },
      30_000,
    );
    return this.ollamaStatus();
  }

  async status() {
    const state = this.read();
    const ollama = await this.ollamaStatus();
    return {
      ...state,
      effective: state.mode === "local" && ollama.reachable && ollama.installed ? "local" : "deepseek",
      ollama,
    };
  }
}

export class DynamicRoutinePlanner {
  constructor({ controller, localPlanner, deepseekPlanner }) {
    if (!controller || !localPlanner || !deepseekPlanner) {
      throw new TypeError("DynamicRoutinePlanner requires controller, localPlanner, and deepseekPlanner");
    }
    this.controller = controller;
    this.localPlanner = localPlanner;
    this.deepseekPlanner = deepseekPlanner;
    this.lastSelection = null;
  }

  get config() {
    return this.controller.select({
      localPlanner: this.localPlanner,
      deepseekPlanner: this.deepseekPlanner,
    }).planner.config;
  }

  async planState(input) {
    const selection = this.controller.select({
      localPlanner: this.localPlanner,
      deepseekPlanner: this.deepseekPlanner,
    });
    this.lastSelection = selection;
    try {
      const planned = await selection.planner.planState(input);
      if (selection.effective === "local") this.controller.recordLocalSuccess();
      return { ...planned, routineBackend: selection.effective, routineBackendRequested: selection.requested };
    } catch (error) {
      if (selection.effective !== "local") throw error;
      this.controller.recordLocalFailure();
      const fallback = await this.deepseekPlanner.planState({
        ...input,
        previousError: [input.previousError, `Local planner unavailable: ${error.message}`].filter(Boolean).join(" | ").slice(0, 300),
      });
      return {
        ...fallback,
        routineBackend: "deepseek",
        routineBackendRequested: "local",
        routineBackendFallback: error.message,
        recoveryAttempts: [
          ...(error.recoveryAttempts ?? []),
          ...(fallback.recoveryAttempts ?? []),
        ],
      };
    }
  }

  async rankCandidate(input) {
    const selection = this.controller.select({
      localPlanner: this.localPlanner,
      deepseekPlanner: this.deepseekPlanner,
    });
    this.lastSelection = selection;
    try {
      const ranked = await selection.planner.rankCandidate(input);
      if (selection.effective === "local") this.controller.recordLocalSuccess();
      return { ...ranked, routineBackend: selection.effective, routineBackendRequested: selection.requested };
    } catch (error) {
      if (selection.effective !== "local") throw error;
      this.controller.recordLocalFailure();
      const fallback = await this.deepseekPlanner.rankCandidate(input);
      return {
        ...fallback,
        usage: mergeUsage(error.usage, fallback.usage),
        routineBackend: "deepseek",
        routineBackendRequested: "local",
        routineBackendFallback: error.message,
        attempts: [
          ...(error.recoveryAttempts ?? []),
          ...(fallback.attempts ?? []),
        ],
      };
    }
  }
}

export function routineBackendStatePath() {
  return defaultStatePath();
}
