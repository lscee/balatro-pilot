import { WindowsBridge } from "./windows-bridge.mjs";

function abortError(signal) {
  const error = new Error(signal?.reason?.message ?? "Stopped by Ctrl+C");
  error.name = "AbortError";
  return error;
}

export class BalatrobotOverlayController {
  constructor(projectRoot, { windowTitle = "Balatro", bridgeFactory } = {}) {
    this.windowTitle = windowTitle;
    this.bridgeFactory = bridgeFactory ?? (() => new WindowsBridge(projectRoot));
    this.bridge = null;
  }

  async #getBridge() {
    if (this.bridge) return this.bridge;
    const bridge = this.bridgeFactory();
    this.bridge = bridge;
    try {
      await bridge.start();
      await bridge.locate(this.windowTitle);
      return bridge;
    } catch (error) {
      this.bridge = null;
      await bridge.close().catch(() => {});
      throw error;
    }
  }

  async dismissUnlockOverlay({ signal } = {}) {
    if (signal?.aborted) throw abortError(signal);
    const bridge = await this.#getBridge();
    const detection = await bridge.detectUnlockOverlay();
    if (!detection.detected) {
      return { detected: false, dismissed: false, orangeRatio: detection.orangeRatio ?? 0 };
    }
    const stopped = await bridge.stopPressed();
    if (stopped.pressed) throw abortError({ reason: new Error("Emergency stop is active (F8)") });
    const focus = await bridge.focus();
    if (!focus.focused) {
      return {
        detected: true,
        dismissed: false,
        orangeRatio: detection.orangeRatio ?? 0,
        reason: "Balatro could not be focused safely",
      };
    }
    if (signal?.aborted) throw abortError(signal);
    const x = Number.isFinite(detection.buttonX) ? detection.buttonX : 0.5;
    const y = Number.isFinite(detection.buttonY) ? detection.buttonY : 0.775;
    await bridge.click(x, y);
    return { detected: true, dismissed: true, x, y, orangeRatio: detection.orangeRatio ?? 0 };
  }

  async close() {
    const bridge = this.bridge;
    this.bridge = null;
    await bridge?.close();
  }
}
