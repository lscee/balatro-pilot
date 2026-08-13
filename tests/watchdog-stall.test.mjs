import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("watchdog treats repeated same-state RPC uncertainty as stuck before accepting fresh log writes", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "balatro-watchdog.ps1"), "utf8");
  assert.match(source, /rpc_uncertain\|rpc_uncertain_quarantine_result/u);
  assert.match(source, /RPC \$latestMethod timed out \$\(\$rpcStreak\.Count\) times on the same exact game-state fingerprint/u);
  const detector = source.indexOf("if ($rpcUncertain.Count -ge 3)");
  const healthyReturn = source.indexOf('Reason = "run log is advancing"');
  assert.ok(detector >= 0 && detector < healthyReturn, "RPC stall detection must precede the healthy fallback");
});
