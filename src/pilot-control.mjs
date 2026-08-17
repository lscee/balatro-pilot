import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { readJsonFile } from "./persistent-json.mjs";

const execFile = promisify(execFileCallback);
const CONTROL_FILE = path.join("BalatroPilot", "controller-control.json");

function resolveProjectRoot(input) {
  const value = typeof input === "string" ? input : input?.projectRoot;
  if (!value || typeof value !== "string") throw new TypeError("PilotControlManager requires projectRoot");
  return path.resolve(value);
}

function defaultExecutor(file, args, options) {
  return execFile(file, args, options);
}

function parseControlOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw Object.assign(new Error("Pilot control returned no result"), { code: "CONTROL_OPERATION_FAILED" });
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw Object.assign(new Error("Pilot control returned an invalid result", { cause }), {
      code: "CONTROL_OPERATION_FAILED",
    });
  }
}

export class PilotControlManager {
  constructor(input, options = {}) {
    const settings = typeof input === "object" && input !== null ? input : options;
    this.projectRoot = resolveProjectRoot(input);
    this.scriptPath = path.resolve(
      settings.scriptPath ?? path.join(this.projectRoot, "scripts", "balatro-watchdog.ps1"),
    );
    this.executor = settings.executor ?? defaultExecutor;
    this.powerShell = settings.powerShell ?? "powershell.exe";
  }

  async #invoke(action, expectedRevision) {
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
      "-ProjectRoot",
      this.projectRoot,
      "-ControlAction",
      action,
      "-Json",
    ];
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw Object.assign(new TypeError("expectedRevision must be a non-negative integer"), {
          code: "INVALID_REVISION",
        });
      }
      args.push("-ExpectedRevision", String(expectedRevision));
    }

    try {
      const result = await this.executor(this.powerShell, args, {
        cwd: this.projectRoot,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      const status = parseControlOutput(result?.stdout ?? result);
      if (status.errorCode) {
        const error = new Error(status.operationError || "Pilot control operation failed");
        error.code = status.errorCode;
        error.currentStatus = status;
        throw error;
      }
      return status;
    } catch (cause) {
      if (cause?.currentStatus || cause?.code === "REVISION_CONFLICT" || cause?.code === "INVALID_ACTION") throw cause;
      const stdout = cause?.stdout;
      if (stdout) {
        try {
          const status = parseControlOutput(stdout);
          if (status.errorCode) {
            const error = new Error(status.operationError || "Pilot control operation failed", { cause });
            error.code = status.errorCode;
            error.currentStatus = status;
            throw error;
          }
        } catch (parsedError) {
          if (parsedError?.currentStatus) throw parsedError;
        }
      }
      const error = new Error("Pilot control operation failed", { cause });
      error.code = "CONTROL_OPERATION_FAILED";
      throw error;
    }
  }

  async status() {
    return this.#invoke("status");
  }

  async operate(action, { expectedRevision } = {}) {
    if (!new Set(["pause", "start"]).has(action)) {
      throw Object.assign(new Error(`Unsupported pilot control action: ${action}`), { code: "INVALID_ACTION" });
    }
    return this.#invoke(action, expectedRevision);
  }
}

export function pilotControlPath(environment = process.env) {
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData) return null;
  return path.join(localAppData, CONTROL_FILE);
}

export function readPilotControlState(environment = process.env) {
  const controlPath = pilotControlPath(environment);
  if (!controlPath) return null;
  return readJsonFile(
    controlPath,
    null,
    (value) => value && ["running", "paused"].includes(value.desiredState),
  );
}

export function createPilotPauseMonitor(projectRoot, { intervalMs = 500, environment = process.env } = {}) {
  resolveProjectRoot(projectRoot);
  const controlPath = pilotControlPath(environment);
  const controller = new AbortController();
  let timer = null;

  const inspect = () => {
    if (controller.signal.aborted || !controlPath) return;
    try {
      const state = readPilotControlState(environment);
      if (state?.desiredState === "paused") {
        const reason = new Error("Paused by dashboard control");
        reason.code = "PILOT_PAUSED";
        controller.abort(reason);
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error instanceof SyntaxError) {
        // A writer replaces the file atomically. A transient malformed legacy
        // file is ignored so it cannot terminate a live controller.
      }
    }
  };

  inspect();
  if (!controller.signal.aborted) {
    timer = setInterval(inspect, Math.max(100, Number(intervalMs) || 500));
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
