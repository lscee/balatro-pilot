import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonFile } from "../src/persistent-json.mjs";

test("readJsonFile accepts JSON with a UTF-8 BOM", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-json-"));
  const file = path.join(directory, "state.json");
  try {
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ mode: "paused" })}`, "utf8");
    assert.deepEqual(readJsonFile(file, null), { mode: "paused" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
