import fs from "node:fs";
import path from "node:path";

import { localAppDataFile, readJsonFile, writeJsonFileAtomic } from "../persistent-json.mjs";

const MODES = new Set(["kimi", "deepseek"]);

function defaultStatePath() {
  return localAppDataFile("strategic-backend.json");
}

function normalizeMode(value, fallback = "kimi") {
  return MODES.has(value) ? value : fallback;
}

export function strategicModeForProvider(provider) {
  return provider === "deepseek-chat" ? "deepseek" : "kimi";
}

export class StrategicBackendController {
  constructor({ statePath = defaultStatePath(), defaultMode = "kimi", availableModes = ["kimi", "deepseek"] } = {}) {
    this.statePath = path.resolve(statePath);
    this.defaultMode = normalizeMode(defaultMode);
    this.availableModes = new Set(availableModes.filter((mode) => MODES.has(mode)));
    if (this.availableModes.size === 0) this.availableModes.add(this.defaultMode);
    if (!this.availableModes.has(this.defaultMode)) this.defaultMode = this.availableModes.values().next().value;
    this.cachedState = null;
    this.cachedStateMtimeNs = null;
  }

  read() {
    try {
      const mtimeNs = fs.statSync(this.statePath, { bigint: true }).mtimeNs;
      if (this.cachedState && mtimeNs === this.cachedStateMtimeNs) return this.cachedState;
      const stored = readJsonFile(this.statePath, null, (value) => value && typeof value === "object");
      if (!stored) throw new Error("missing strategic backend state");
      this.cachedStateMtimeNs = mtimeNs;
      this.cachedState = Object.freeze({
        mode: this.availableModes.has(stored.mode) ? stored.mode : this.defaultMode,
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
    if (!normalized) throw new Error("mode must be kimi or deepseek");
    if (!this.availableModes.has(normalized)) throw new Error(`${normalized} strategic backend is not configured`);
    const state = { mode: normalized, updatedAt: new Date().toISOString(), updatedBy };
    writeJsonFileAtomic(this.statePath, state);
    this.cachedState = Object.freeze(state);
    this.cachedStateMtimeNs = null;
    return state;
  }

  select({ kimiPlanner, deepseekPlanner }) {
    const state = this.read();
    const planner = state.mode === "deepseek" ? deepseekPlanner : kimiPlanner;
    if (!planner) throw new Error(`${state.mode} strategic planner is unavailable`);
    return { ...state, effective: state.mode, planner };
  }

  status({ kimiPlanner = null, deepseekPlanner = null } = {}) {
    const state = this.read();
    const planner = state.mode === "deepseek" ? deepseekPlanner : kimiPlanner;
    return {
      ...state,
      effective: state.mode,
      provider: planner?.config?.provider ?? (state.mode === "deepseek" ? "deepseek-chat" : "kimi-chat"),
      model: planner?.config?.model ?? (state.mode === "deepseek" ? "deepseek-v4-flash" : "k3-256k"),
      availableModes: [...this.availableModes],
    };
  }
}

export class DynamicStrategicPlanner {
  constructor({ controller, kimiPlanner, deepseekPlanner }) {
    if (!controller || (!kimiPlanner && !deepseekPlanner)) {
      throw new TypeError("DynamicStrategicPlanner requires a controller and at least one strategic planner");
    }
    this.controller = controller;
    this.kimiPlanner = kimiPlanner;
    this.deepseekPlanner = deepseekPlanner;
  }

  #selection() {
    return this.controller.select({
      kimiPlanner: this.kimiPlanner,
      deepseekPlanner: this.deepseekPlanner,
    });
  }

  get config() {
    return this.#selection().planner.config;
  }

  async planState(input) {
    const selection = this.#selection();
    const planned = await selection.planner.planState(input);
    return {
      ...planned,
      strategicBackend: selection.effective,
    };
  }
}

export function strategicBackendStatePath() {
  return defaultStatePath();
}
