import test from "node:test";
import assert from "node:assert/strict";

import { BalatrobotOverlayController } from "../src/balatrobot-overlay.mjs";

function fakeBridge(detection, focus = true) {
  const calls = [];
  return {
    calls,
    async start() { calls.push(["start"]); },
    async locate(title) { calls.push(["locate", title]); },
    async detectUnlockOverlay() { calls.push(["detect"]); return detection; },
    async stopPressed() { calls.push(["stop"]); return { pressed: false }; },
    async focus() { calls.push(["focus"]); return { focused: focus }; },
    async click(x, y) { calls.push(["click", x, y]); },
    async close() { calls.push(["close"]); },
  };
}

test("overlay controller clicks only a visually detected unlock Continue button", async () => {
  const bridge = fakeBridge({ detected: true, buttonX: 0.5, buttonY: 0.775, orangeRatio: 0.35 });
  const controller = new BalatrobotOverlayController(".", { windowTitle: "Balatro", bridgeFactory: () => bridge });
  const result = await controller.dismissUnlockOverlay();
  assert.equal(result.dismissed, true);
  assert.deepEqual(bridge.calls, [
    ["start"],
    ["locate", "Balatro"],
    ["detect"],
    ["stop"],
    ["focus"],
    ["click", 0.5, 0.775],
  ]);
  await controller.close();
  assert.deepEqual(bridge.calls.at(-1), ["close"]);
});

test("overlay controller does not focus or click when the modal is absent", async () => {
  const bridge = fakeBridge({ detected: false, orangeRatio: 0.01 });
  const controller = new BalatrobotOverlayController(".", { bridgeFactory: () => bridge });
  const result = await controller.dismissUnlockOverlay();
  assert.deepEqual(result, { detected: false, dismissed: false, orangeRatio: 0.01 });
  assert.equal(bridge.calls.some(([name]) => name === "click"), false);
  assert.equal(bridge.calls.some(([name]) => name === "focus"), false);
});
