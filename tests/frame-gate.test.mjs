import test from "node:test";
import assert from "node:assert/strict";

import { FrameGate, frameDifference, signatureRegionDifference } from "../src/frame-gate.mjs";

function signature(value) {
  return Buffer.alloc(32 * 24 * 2, value).toString("base64");
}

test("frameDifference reports normalized RGB distance", () => {
  assert.equal(frameDifference(signature(10), signature(10)), 0);
  assert.ok(Math.abs(frameDifference(signature(0), signature(255)) - 1) < 1e-9);
});

test("signatureRegionDifference measures only the cells around a click", () => {
  const left = Buffer.alloc(32 * 24 * 2, 10);
  const right = Buffer.from(left);
  const centerOffset = (12 * 32 + 16) * 2;
  right[centerOffset] = 110;
  const local = signatureRegionDifference(left.toString("base64"), right.toString("base64"), 0.5, 0.5, 1, 1, 2);
  assert.ok(local > 0);
  const far = signatureRegionDifference(left.toString("base64"), right.toString("base64"), 0.05, 0.05, 1, 1, 2);
  assert.equal(far, 0);
});

test("FrameGate waits for a changed stable frame before returning a PNG", async () => {
  const oldFrame = signature(10);
  const newFrame = signature(80);
  const requests = [];
  const captures = [
    { signature: newFrame, signatureCellBytes: 2, pngBase64: null },
    { signature: newFrame, signatureCellBytes: 2, pngBase64: null },
    { signature: newFrame, signatureCellBytes: 2, pngBase64: null },
    { signature: newFrame, signatureCellBytes: 2, pngBase64: "image", width: 10, height: 10 },
  ];
  const bridge = {
    stopPressed: async () => ({ pressed: false }),
    capture: async (options = {}) => {
      requests.push(options.includeImage ?? true);
      return captures.shift();
    },
  };
  const gate = new FrameGate({
    frameGateEnabled: true,
    frameProbeMs: 1,
    frameStableSamples: 2,
    frameStableThreshold: 0.012,
    frameStableRatio: 0.45,
    frameChangeCellThreshold: 0.06,
    frameChangeThreshold: 0.08,
    frameGateTimeoutMs: 1_000,
  });
  const result = await gate.next({ bridge });
  assert.equal(result.changed, true);
  assert.equal(result.stable, true);
  assert.equal(result.capture.pngBase64, "image");
  assert.deepEqual(requests, [false, false, false, true]);
});

test("FrameGate reports an unchanged frame even when change is not required", async () => {
  const sameFrame = signature(30);
  const captures = [
    { signature: sameFrame, signatureCellBytes: 2 },
    { signature: sameFrame, signatureCellBytes: 2 },
    { signature: sameFrame, signatureCellBytes: 2, pngBase64: "image", width: 10, height: 10 },
  ];
  const bridge = {
    stopPressed: async () => ({ pressed: false }),
    capture: async () => captures.shift(),
  };
  const gate = new FrameGate({
    frameGateEnabled: true,
    frameProbeMs: 1,
    frameStableSamples: 1,
    frameStableThreshold: 0.012,
    frameStableRatio: 0.45,
    frameChangeCellThreshold: 0.06,
    frameChangeThreshold: 0.08,
    frameGateTimeoutMs: 1_000,
  });
  const previousReference = {
    values: Buffer.alloc(32 * 24 * 2, 30),
    stable: new Uint8Array(32 * 24).fill(1),
    cellBytes: 2,
  };
  const result = await gate.next({ bridge, previousReference, requireChange: false });
  assert.equal(result.changed, false);
  assert.equal(result.stable, true);
});
