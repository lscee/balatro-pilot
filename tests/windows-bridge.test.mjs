import test from "node:test";
import assert from "node:assert/strict";

import { WindowsBridge } from "../src/windows-bridge.mjs";

test("listWindows normalizes PowerShell C# property casing", async () => {
  const bridge = new WindowsBridge("C:\\unused");
  bridge.request = async () => ({
    ok: true,
    windows: [{ Handle: 123, Title: "Balatro" }],
  });
  const result = await bridge.listWindows();
  assert.deepEqual(result.windows, [{ handle: 123, title: "Balatro" }]);
});

test("capture can request a signature without PNG data", async () => {
  const bridge = new WindowsBridge("C:\\unused");
  let payload;
  bridge.request = async (value) => {
    payload = value;
    return { ok: true, signature: "AA==", pngBase64: null };
  };
  const result = await bridge.capture({ includeImage: false });
  assert.equal(payload.includeImage, false);
  assert.equal(result.pngBase64, null);
});

test("move sends a normalized pointer-only command", async () => {
  const bridge = new WindowsBridge("C:\\unused");
  let payload;
  bridge.request = async (value) => {
    payload = value;
    return { ok: true };
  };
  await bridge.move(0.4, 0.7);
  assert.deepEqual(payload, { command: "move", x: 0.4, y: 0.7 });
});

test("unlock overlay detection uses the native visual classifier", async () => {
  const bridge = new WindowsBridge("C:\\unused");
  let payload;
  bridge.request = async (value) => {
    payload = value;
    return { ok: true, detected: true, buttonX: 0.5, buttonY: 0.775, orangeRatio: 0.35 };
  };
  const result = await bridge.detectUnlockOverlay();
  assert.deepEqual(payload, { command: "detect_unlock_overlay" });
  assert.equal(result.detected, true);
});
