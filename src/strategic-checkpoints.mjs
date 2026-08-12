import path from "node:path";

import { localAppDataFile, readJsonFile, writeJsonFileAtomic } from "./persistent-json.mjs";

function defaultCheckpointPath() {
  return localAppDataFile("strategic-checkpoints.json");
}

export class StrategicCheckpointStore {
  constructor({ filePath = defaultCheckpointPath(), maxRuns = 30 } = {}) {
    this.filePath = path.resolve(filePath);
    this.maxRuns = maxRuns;
    this.data = this.#read();
  }

  #read() {
    return readJsonFile(
      this.filePath,
      { version: 1, runs: {} },
      (data) => data?.version === 1 && data.runs && typeof data.runs === "object",
    );
  }

  #run(seed, create = false) {
    const key = String(seed ?? "").trim();
    if (!key) return null;
    if (!this.data.runs[key] && create) {
      this.data.runs[key] = { scopes: [], runPlan: null, updatedAt: new Date().toISOString() };
    }
    return this.data.runs[key] ?? null;
  }

  has(seed, scope) {
    return this.#run(seed)?.scopes?.includes(scope) ?? false;
  }

  runPlan(seed) {
    return this.#run(seed)?.runPlan ?? null;
  }

  mark(seed, scope, runPlan = null) {
    const record = this.#run(seed, true);
    if (!record.scopes.includes(scope)) record.scopes.push(scope);
    if (runPlan && typeof runPlan === "object") record.runPlan = runPlan;
    record.updatedAt = new Date().toISOString();
    const ordered = Object.entries(this.data.runs)
      .sort((left, right) => String(right[1].updatedAt).localeCompare(String(left[1].updatedAt)));
    this.data.runs = Object.fromEntries(ordered.slice(0, this.maxRuns));
    writeJsonFileAtomic(this.filePath, this.data);
  }
}

export function strategicCheckpointPath() {
  return defaultCheckpointPath();
}
