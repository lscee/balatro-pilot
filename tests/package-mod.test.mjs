import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(root, "scripts", "package-balatrobot-mod.ps1"), "utf8");

test("Mod packager verifies the pinned runtime and excludes third-party loaders", () => {
  assert.match(script, /d53fa2eb86813c48e33b9d2c9317f786ef24bef28c0c60e4b4a48bcfcb6441e2/u);
  assert.match(script, /Get-RuntimeFingerprint/u);
  assert.match(script, /"\{0\}`t\{1\}"/u);
  assert.match(script, /Lovely and Steamodded are prerequisites and are intentionally not bundled/u);
  assert.match(script, /LICENSE-BALATROBOT/u);
  assert.doesNotMatch(script, /Copy-Item[^\r\n]+Steamodded/iu);
});
