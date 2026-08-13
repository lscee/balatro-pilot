import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(root, "scripts", "package-balatrobot-mod.ps1"), "utf8");

test("Mod packager verifies the pinned runtime and excludes third-party loaders", () => {
  assert.match(script, /f5ffff76f5b0237e617a48e539ebb8cd4e007fa717cc0378987406559860964f/u);
  assert.match(script, /Get-RuntimeFingerprint/u);
  assert.match(script, /"\{0\}`t\{1\}"/u);
  assert.match(script, /Lovely and Steamodded are prerequisites and are intentionally not bundled/u);
  assert.match(script, /LICENSE-BALATROBOT/u);
  assert.doesNotMatch(script, /Copy-Item[^\r\n]+Steamodded/iu);
});
