import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const archive = path.resolve("release", "balatrobot-pilot-v1.5.2.zip");

test("the committed Mod release matches its checksum and contains no private runtime data", () => {
  const expected = fs.readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/u)[0];
  const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  assert.equal(actual, expected);

  const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  assert.ok(entries.length >= 40);
  assert.ok(entries.every((entry) => entry.startsWith("balatrobot/")));
  assert.ok(entries.includes("balatrobot/LICENSE-BALATROBOT"));
  assert.ok(entries.includes("balatrobot/BALATRO-PILOT-PROVENANCE.txt"));
  assert.equal(entries.some((entry) => /(?:\.dpapi|\.sqlite|config\.json|runs\/|Lovely|Steamodded)/iu.test(entry)), false);
});
