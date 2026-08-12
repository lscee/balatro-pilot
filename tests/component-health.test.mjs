import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectHealthMonitor, parseWindowsNetstatListeners } from "../src/component-health.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-health-"));
  const credentials = path.join(root, "credentials");
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(credentials, "kimi-api-key.dpapi"), "encrypted");
  fs.writeFileSync(path.join(credentials, "deepseek-api-key.dpapi"), "encrypted");
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "semantic-experience.sqlite"), "database");
  return { root, credentials };
}

function config() {
  return {
    provider: "kimi-chat",
    balatrobotProvider: "deepseek-chat",
    balatrobotStrategicProvider: "deepseek-chat",
    model: "k3-256k",
    balatrobotLocalModel: "balatro-pilot-qwen:latest",
    balatrobotStrategicModel: "deepseek-v4-flash",
    balatrobotModel: "deepseek-v4-flash",
    semanticRagEnabled: true,
    semanticRagDatabasePath: "data/semantic-experience.sqlite",
  };
}

function routeConfig() {
  return {
    ...config(),
    provider: "kimi-chat",
    balatrobotProvider: "deepseek-chat",
    balatrobotStrategicProvider: "kimi-chat",
    modelRoutes: {
      routine: { provider: "deepseek-chat" },
      strategic: { provider: "kimi-chat" },
      vision: { provider: "kimi-chat" },
    },
  };
}

test("component health recognizes semantic route credentials without provider-native variables", async () => {
  const { root, credentials } = fixture();
  fs.writeFileSync(path.join(credentials, "routine-api-key.dpapi"), "encrypted");
  fs.writeFileSync(path.join(credentials, "strategic-api-key.dpapi"), "encrypted");
  const monitor = new ProjectHealthMonitor({
    projectRoot: root,
    config: routeConfig(),
    credentialDirectory: credentials,
    processProvider: async () => ({ processes: [], listeners: [{ LocalPort: 4312, OwningProcess: 1 }] }),
    routineBackend: { async status() { return { mode: "deepseek", ollama: { reachable: false } }; } },
    strategicBackend: { status() { return { mode: "kimi", provider: "kimi-chat", model: "k3" }; } },
    stats: { refresh() { return { coverage: { totalEvents: 0, runDirectories: 0 } }; } },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  try {
    const result = await monitor.refresh();
    assert.equal(result.components.find((item) => item.id === "kimi").status, "configured");
    assert.equal(result.components.find((item) => item.id === "deepseek").status, "configured");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("netstat listener parser keeps only watched TCP listeners", () => {
  const listeners = parseWindowsNetstatListeners(`
    Proto  Local Address          Foreign Address        State           PID
    TCP    127.0.0.1:4312         0.0.0.0:0              LISTENING       101
    TCP    [::1]:4313             [::]:0                 LISTENING       102
    TCP    127.0.0.1:12346        127.0.0.1:50000        ESTABLISHED     103
    TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       104
    UDP    127.0.0.1:11434        *:*                                    105
    TCP    127.0.0.1:4312         0.0.0.0:0              LISTENING       101
  `);
  assert.deepEqual(listeners, [
    { port: 4_312, pid: 101 },
    { port: 4_313, pid: 102 },
  ]);
});

test("component health reports the live stack without probing paid model APIs", async () => {
  const { root, credentials } = fixture();
  let processReads = 0;
  const fetched = [];
  const commandRoot = root.replaceAll("/", "\\");
  const monitor = new ProjectHealthMonitor({
    projectRoot: root,
    config: config(),
    credentialDirectory: credentials,
    now: () => Date.parse("2026-08-11T10:00:10.000Z"),
    processProvider: async () => {
      processReads += 1;
      return {
        processes: [
          { Name: "Balatro.exe", ProcessId: 101, CommandLine: "Balatro.exe" },
          { Name: "node.exe", ProcessId: 102, CommandLine: `node ${commandRoot}\\src\\index.mjs run` },
          { Name: "node.exe", ProcessId: 103, CommandLine: "node src/overlay-server.mjs" },
          { Name: "ollama.exe", ProcessId: 104, CommandLine: "ollama serve" },
          { Name: "python.exe", ProcessId: 105, CommandLine: "python balatrobot-serve-compat.py serve" },
        ],
        listeners: [
          { LocalPort: 4312, OwningProcess: 100 },
          { LocalPort: 4313, OwningProcess: 103 },
          { LocalPort: 11434, OwningProcess: 104 },
          { LocalPort: 12346, OwningProcess: 101 },
        ],
      };
    },
    routineBackend: {
      async status() {
        return {
          mode: "local",
          ollama: { reachable: true, installed: true, loaded: true, model: "balatro-pilot-qwen:latest" },
        };
      },
    },
    strategicBackend: {
      status() { return { mode: "kimi", effective: "kimi", provider: "kimi-chat", model: "k3-256k" }; },
    },
    stats: {
      refresh() {
        return {
          live: { at: "2026-08-11T10:00:08.000Z", state: "SELECTING_HAND" },
          coverage: { lastEventAt: "2026-08-11T10:00:08.000Z", totalEvents: 12_345, runDirectories: 42 },
        };
      },
    },
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    const first = await monitor.refresh();
    const second = await monitor.refresh();
    assert.equal(first.overall.status, "healthy");
    assert.equal(first.components.length, 10);
    assert.equal(first.components.find((item) => item.id === "controller").status, "healthy");
    assert.equal(first.components.find((item) => item.id === "balatrobot").status, "healthy");
    assert.equal(first.components.find((item) => item.id === "kimi").status, "configured");
    assert.equal(first.components.find((item) => item.id === "deepseek").status, "configured");
    assert.equal(first.components.find((item) => item.id === "kimi").label, "Kimi K3 战略");
    assert.match(first.components.find((item) => item.id === "kimi").detail, /战略检查点/);
    assert.equal(first.components.find((item) => item.id === "deepseek").label, "DeepSeek Flash 回退");
    assert.doesNotMatch(first.components.find((item) => item.id === "deepseek").detail, /战略检查点/);
    assert.equal(first.components.find((item) => item.id === "rag").status, "healthy");
    assert.deepEqual(fetched, ["http://127.0.0.1:4313/api/health"]);
    assert.equal(processReads, 1);
    assert.strictEqual(second, first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("component health fails independently and marks a stopped project as idle", async () => {
  const { root, credentials } = fixture();
  fs.rmSync(path.join(credentials, "kimi-api-key.dpapi"));
  fs.rmSync(path.join(credentials, "deepseek-api-key.dpapi"));
  const monitor = new ProjectHealthMonitor({
    projectRoot: root,
    config: config(),
    credentialDirectory: credentials,
    processProvider: async () => ({ processes: [], listeners: [{ LocalPort: 4312, OwningProcess: 100 }] }),
    routineBackend: {
      async status() { throw new Error("Ollama unavailable"); },
    },
    stats: {
      refresh() { throw new Error("runs unavailable"); },
    },
    fetchImpl: async () => { throw new Error("overlay unavailable"); },
  });
  try {
    const result = await monitor.refresh();
    assert.equal(result.overall.status, "idle");
    assert.equal(result.components.find((item) => item.id === "game").status, "offline");
    assert.equal(result.components.find((item) => item.id === "controller").status, "offline");
    assert.equal(result.components.find((item) => item.id === "ollama").status, "degraded");
    assert.equal(result.components.find((item) => item.id === "telemetry").status, "degraded");
    assert.equal(result.components.find((item) => item.id === "overlay").status, "offline");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("component health preserves the last good process snapshot when the Windows probe fails", async () => {
  const { root, credentials } = fixture();
  let now = Date.parse("2026-08-11T10:00:10.000Z");
  let failProbe = false;
  const commandRoot = root.replaceAll("/", "\\");
  const monitor = new ProjectHealthMonitor({
    projectRoot: root,
    config: config(),
    credentialDirectory: credentials,
    now: () => now,
    cacheMs: 0,
    processProvider: async () => {
      if (failProbe) throw new Error("Windows probe timed out");
      return {
        processes: [
          { Name: "Balatro.exe", ProcessId: 101, CommandLine: "Balatro.exe" },
          { Name: "node.exe", ProcessId: 102, CommandLine: `node ${commandRoot}\\src\\index.mjs run` },
          { Name: "node.exe", ProcessId: 103, CommandLine: "node src/overlay-server.mjs" },
          { Name: "python.exe", ProcessId: 104, CommandLine: "python balatrobot-serve-compat.py serve" },
        ],
        listeners: [
          { LocalPort: 4_312, OwningProcess: 100 },
          { LocalPort: 4_313, OwningProcess: 103 },
          { LocalPort: 12_346, OwningProcess: 101 },
        ],
      };
    },
    routineBackend: {
      async status() { return { mode: "deepseek", ollama: { reachable: true, installed: true, loaded: false } }; },
    },
    strategicBackend: { status() { return { mode: "kimi", model: "k3-256k" }; } },
    stats: {
      refresh() { return { coverage: { lastEventAt: new Date(now).toISOString(), totalEvents: 1, runDirectories: 1 } }; },
    },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });
  try {
    const fresh = await monitor.refresh();
    assert.equal(fresh.processSnapshot.status, "fresh");
    assert.equal(fresh.components.find((item) => item.id === "game").status, "healthy");

    failProbe = true;
    now += 5_000;
    const stale = await monitor.refresh();
    assert.equal(stale.processSnapshot.status, "stale");
    assert.equal(stale.processSnapshot.ageSeconds, 5);
    assert.match(stale.processSnapshot.error, /timed out/);
    assert.equal(stale.components.find((item) => item.id === "game").status, "degraded");
    assert.notEqual(stale.components.find((item) => item.id === "game").status, "offline");
    assert.match(stale.notes.at(-1), /未将未知状态误报为离线/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("component health invalidation does not reuse an in-flight pre-switch strategic route", async () => {
  const { root, credentials } = fixture();
  let mode = "kimi";
  let processReads = 0;
  let releaseFirstRead;
  const firstReadBlocked = new Promise((resolve) => { releaseFirstRead = resolve; });
  const monitor = new ProjectHealthMonitor({
    projectRoot: root,
    config: config(),
    credentialDirectory: credentials,
    processProvider: async () => {
      processReads += 1;
      if (processReads === 1) await firstReadBlocked;
      return { processes: [], listeners: [{ LocalPort: 4312, OwningProcess: 100 }] };
    },
    routineBackend: {
      async status() { return { mode: "deepseek", ollama: { reachable: true, installed: true, loaded: false } }; },
    },
    strategicBackend: {
      status() {
        return {
          mode,
          provider: mode === "kimi" ? "kimi-chat" : "deepseek-chat",
          model: mode === "kimi" ? "k3-256k" : "deepseek-v4-flash",
        };
      },
    },
    stats: { refresh() { return { coverage: { totalEvents: 0, runDirectories: 0 } }; } },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });
  try {
    const stale = monitor.refresh();
    mode = "deepseek";
    monitor.invalidate();
    const fresh = monitor.refresh();
    releaseFirstRead();
    await stale;
    const result = await fresh;
    assert.equal(processReads, 2);
    assert.equal(result.components.find((item) => item.id === "deepseek").label, "DeepSeek Flash 战略");
    assert.match(result.components.find((item) => item.id === "deepseek").detail, /战略检查点/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
