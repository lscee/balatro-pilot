import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PilotControlManager, createPilotPauseMonitor } from "../src/pilot-control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("PilotControlManager invokes the watchdog JSON control contract", async () => {
  const calls = [];
  const manager = new PilotControlManager(root, {
    powerShell: "pwsh-test",
    executor: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: JSON.stringify({
          desiredState: "paused",
          effectiveState: "paused",
          revision: 4,
          updatedAt: "2026-08-13T00:00:00.000Z",
          operationError: null,
          controllerPid: null,
          errorCode: null,
        }),
      };
    },
  });

  const status = await manager.operate("pause", { expectedRevision: 3 });
  assert.equal(status.revision, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "pwsh-test");
  assert.deepEqual(calls[0].args.slice(-5), ["-ControlAction", "pause", "-Json", "-ExpectedRevision", "3"]);
  assert.ok(calls[0].args.includes("-ControlAction"));
  assert.equal(calls[0].options.windowsHide, true);
});

test("PilotControlManager reports revision conflicts without exposing process arguments", async () => {
  const manager = new PilotControlManager({
    projectRoot: root,
    executor: async () => {
      const error = new Error("process failed");
      error.stdout = JSON.stringify({
        desiredState: "running",
        effectiveState: "running",
        revision: 9,
        updatedAt: "2026-08-13T00:00:00.000Z",
        operationError: "The controller state changed; refresh before trying again.",
        controllerPid: 123,
        errorCode: "REVISION_CONFLICT",
      });
      throw error;
    },
  });
  await assert.rejects(
    manager.operate("start", { expectedRevision: 8 }),
    (error) => error.code === "REVISION_CONFLICT" && error.currentStatus.revision === 9,
  );
});

test("pause monitor aborts a running controller when the control marker changes", async () => {
  const temporary = fs.mkdtempSync(path.join(root, ".pilot-control-test-"));
  const stateDirectory = path.join(temporary, "BalatroPilot");
  fs.mkdirSync(stateDirectory);
  const monitor = createPilotPauseMonitor(root, {
    intervalMs: 25,
    environment: { LOCALAPPDATA: temporary },
  });
  try {
    fs.writeFileSync(
      path.join(stateDirectory, "controller-control.json"),
      JSON.stringify({ desiredState: "paused", revision: 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(monitor.signal.aborted, true);
    assert.equal(monitor.signal.reason?.code, "PILOT_PAUSED");
  } finally {
    monitor.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("pause monitor accepts the UTF-8 BOM written by legacy Windows PowerShell", async () => {
  const temporary = fs.mkdtempSync(path.join(root, ".pilot-control-test-"));
  const stateDirectory = path.join(temporary, "BalatroPilot");
  fs.mkdirSync(stateDirectory);
  fs.writeFileSync(
    path.join(stateDirectory, "controller-control.json"),
    `\uFEFF${JSON.stringify({ desiredState: "paused", revision: 2 })}`,
    "utf8",
  );
  const monitor = createPilotPauseMonitor(root, {
    intervalMs: 25,
    environment: { LOCALAPPDATA: temporary },
  });
  try {
    assert.equal(monitor.signal.aborted, true);
    assert.equal(monitor.signal.reason?.code, "PILOT_PAUSED");
  } finally {
    monitor.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("watchdog pause/start implementation is scoped and pause-aware", () => {
  const watchdog = fs.readFileSync(path.join(root, "scripts", "balatro-watchdog.ps1"), "utf8");
  const runner = fs.readFileSync(path.join(root, "scripts", "run-balatro-pilot.ps1"), "utf8");
  assert.match(watchdog, /Local\\BalatroPilotWatchdog/u);
  assert.match(watchdog, /controller-control\.json/u);
  assert.match(watchdog, /UTF8Encoding\(\$false\)/u);
  assert.match(watchdog, /\$launchPattern/u);
  assert.match(watchdog, /-ControllerOnly/u);
  assert.doesNotMatch(watchdog, /taskkill(?:\.exe)?/iu);
  assert.match(watchdog, /Stop-Process -Id \$current\.ProcessId/u);
  assert.match(watchdog, /desiredState -eq "paused"/u);
  assert.match(runner, /ControllerOnly requires Balatro\.exe to already be running/u);
  assert.match(runner, /LocalPort 12346/u);
  const securityImport = runner.indexOf("Microsoft.PowerShell.Security.psd1");
  const credentialDecrypt = runner.indexOf("ConvertTo-SecureString");
  assert.ok(
    securityImport >= 0 && securityImport < credentialDecrypt,
    "the Windows security module must be pinned before decrypting DPAPI credentials",
  );
  const pauseGuard = watchdog.lastIndexOf('$controlState.desiredState -eq "paused"');
  const forceRestart = watchdog.lastIndexOf("if ($ForceRestart)");
  assert.ok(pauseGuard >= 0 && pauseGuard < forceRestart, "pause marker must win over ForceRestart");
});
