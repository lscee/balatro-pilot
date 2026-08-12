import test from "node:test";
import assert from "node:assert/strict";

import { parseWindowsProxy } from "../src/launch.mjs";

test("parseWindowsProxy reads a simple host and port", () => {
  assert.equal(parseWindowsProxy("0x1", "127.0.0.1:7897"), "http://127.0.0.1:7897/");
});

test("parseWindowsProxy prefers an HTTPS protocol mapping", () => {
  assert.equal(
    parseWindowsProxy("0x1", "http=127.0.0.1:7890;https=127.0.0.1:7897"),
    "http://127.0.0.1:7897/",
  );
});

test("parseWindowsProxy ignores a disabled proxy", () => {
  assert.equal(parseWindowsProxy("0x0", "127.0.0.1:7897"), null);
});
