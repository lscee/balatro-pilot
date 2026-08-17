import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(root, "scripts", "package-balatrobot-mod.ps1"), "utf8");

test("Mod packager verifies the pinned runtime and excludes third-party loaders", () => {
  assert.match(script, /b6da92128779742cd1a684c83b45027d603b3cf56be5d5a242c7269bb420c0d1/u);
  assert.match(script, /Get-RuntimeFingerprint/u);
  assert.match(script, /"\{0\}`t\{1\}"/u);
  assert.match(script, /canonical cumulative-Stake and sticker state/u);
  assert.match(script, /Lovely and Steamodded are prerequisites and are intentionally not bundled/u);
  assert.match(script, /LICENSE-BALATROBOT/u);
  assert.doesNotMatch(script, /Copy-Item[^\r\n]+Steamodded/iu);
});
