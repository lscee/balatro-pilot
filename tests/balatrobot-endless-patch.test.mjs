import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), "utf8");

test("pinned Endless endpoint only dismisses the native win overlay after a win", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "endless.lua");
  assert.match(endpoint, /name = "endless"/);
  assert.match(endpoint, /requires_state = \{ G\.STATES\.ROUND_EVAL \}/);
  assert.match(endpoint, /G\.GAME\.won ~= true/);
  assert.match(endpoint, /not G\.OVERLAY_MENU or not G\.SETTINGS or G\.SETTINGS\.paused ~= true/);
  assert.match(endpoint, /G\.FUNCS\.exit_overlay_menu\(\)/);
  assert.match(endpoint, /not G\.OVERLAY_MENU/);
  assert.match(endpoint, /G\.SETTINGS\.paused == false/);
});

test("pinned play endpoint distinguishes a fresh victory overlay from persistent Endless won state", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "play.lua");
  assert.match(endpoint, /pause_force\s*=\s*true/);
  assert.doesNotMatch(endpoint, /created_on_pause\s*=/);
  assert.match(endpoint, /local native_win_overlay =/);
  assert.match(endpoint, /G\.GAME\.won == true/);
  assert.match(endpoint, /G\.OVERLAY_MENU/);
  assert.match(endpoint, /G\.SETTINGS\.paused == true/);
  assert.doesNotMatch(endpoint, /if G\.GAME\.won then/);
  assert.match(endpoint, /dollar_blind1/);
  assert.match(endpoint, /cash_out_button/);
  assert.match(endpoint, /Return play\(\) - cash out UI ready/);
});

test("pinned cash-out endpoint waits for the complete payout UI before clearing round_eval", () => {
  const endpoint = read("assets", "balatrobot-v1.5.2", "cash_out.lua");
  const readiness = endpoint.indexOf("local payout_ready =");
  const nativeCall = endpoint.indexOf("G.FUNCS.cash_out({ config = {} })");
  assert.ok(readiness >= 0 && nativeCall > readiness, "native cash-out is gated behind payout readiness");
  assert.match(endpoint, /G\.round_eval:get_UIE_by_ID\("dollar_blind1"\)/);
  assert.match(endpoint, /cash_out_button_ready\(\)/);
  assert.match(endpoint, /not G\.OVERLAY_MENU/);
  assert.match(endpoint, /G\.SETTINGS\.paused == false/);
  assert.doesNotMatch(endpoint.slice(0, readiness), /G\.FUNCS\.cash_out/);
});

test("installer and launcher carry the same asset-backed Endless patch and fingerprint", () => {
  const installer = read("scripts", "install-balatrobot.ps1");
  const launcher = read("scripts", "start-balatrobot.ps1");
  const fingerprints = [installer, launcher].map((source) => {
    const match = source.match(/\$BalatroBotRuntimeFingerprint = "([a-f0-9]{64})"/);
    assert.ok(match, "pinned runtime fingerprint is present");
    return match[1];
  });
  assert.equal(fingerprints[0], fingerprints[1]);
  for (const source of [installer, launcher]) {
    assert.match(source, /function Add-BalatroBotEndlessPatch/);
    assert.match(source, /assets\\balatrobot-v1\.5\.2/);
    assert.match(source, /src\\lua\\endpoints\\endless\.lua/);
    assert.match(source, /src\\lua\\endpoints\\play\.lua/);
    assert.match(source, /src\\lua\\endpoints\\cash_out\.lua/);
    assert.match(source, /openrpc-endless-method\.json/);
    assert.match(source, /Add-BalatroBotEndlessPatch -Root/);
    assert.match(source, /G\.BALATRO_PILOT_UNSEEDED_NONCE/);
    assert.match(source, /inject entropy at the actual native seed call/);
    assert.match(source, /generate_starting_seed = function\(\)/);
    assert.match(source, /G\.BALATRO_PILOT_LAST_UNSEEDED_SEED/);
    assert.match(source, /generated_seed ~= previous_seed/);
    assert.doesNotMatch(
      source.match(/function Add-BalatroBotUnseededEntropyPatch[\s\S]*?function Add-BalatroBotEndlessPatch/)?.[0] ?? "",
      /G\.CONTROLLER\.cursor_hover\.time\s*=\s*\r?\n\s*\(G\.CONTROLLER\.cursor_hover\.time or 0\)/,
    );
    assert.doesNotMatch(source.match(/function Add-BalatroBotUnseededEntropyPatch[\s\S]*?function Add-BalatroBotEndlessPatch/)?.[0] ?? "", /BB\.UNSEEDED_RUN_NONCE =/);
  }
  assert.match(installer, /State = "patch"; Detail = "BalatroBot v\$BalatroBotVersion legacy runtime detected/);
});

test("Endless is declared in OpenRPC and required by the local doctor probe", () => {
  const method = JSON.parse(read("assets", "balatrobot-v1.5.2", "openrpc-endless-method.json"));
  assert.equal(method.name, "endless");
  assert.equal(method.params.length, 0);
  const index = read("src", "index.mjs");
  assert.match(index, /"cash_out",\s+"endless",\s+"buy"/);
});
