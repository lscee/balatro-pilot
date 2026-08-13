import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { localAppDataFile } from "./persistent-json.mjs";

const execFileAsync = promisify(execFile);

const RPC_STALL_EVENT_TYPES = new Set([
  "bot_state",
  "rpc_uncertain",
  "rpc_uncertain_quarantine_result",
]);

function latestRunEventFile(runsDirectory) {
  try {
    let latest = null;
    for (const entry of fs.readdirSync(runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(runsDirectory, entry.name, "events.ndjson");
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && (!latest || stat.mtimeMs > latest.mtimeMs)) latest = { file, mtimeMs: stat.mtimeMs };
      } catch {
        // A new run directory may not contain its event file yet.
      }
    }
    return latest?.file ?? null;
  } catch {
    return null;
  }
}

function readEventTail(file, maxBytes = 4 * 1_024 * 1_024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  if (length <= 0) return [];
  const offset = stat.size - length;
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(length);
  try {
    fs.readSync(descriptor, buffer, 0, length, offset);
  } finally {
    fs.closeSync(descriptor);
  }
  let source = buffer.toString("utf8");
  if (offset > 0) source = source.slice(Math.max(0, source.indexOf("\n") + 1));
  const events = [];
  for (const line of source.split(/\r?\n/u)) {
    if (!line.includes('"type"')) continue;
    try {
      const event = JSON.parse(line);
      if (RPC_STALL_EVENT_TYPES.has(event?.type)) events.push(event);
    } catch {
      // Ignore an incomplete line while the controller is appending it.
    }
  }
  return events;
}

export function detectRpcStall(events, {
  now = Date.now(),
  minimumTimeouts = 3,
  minimumSpanMs = 120_000,
  freshnessMs = 300_000,
} = {}) {
  let currentFingerprint = null;
  let streak = [];
  for (const event of events ?? []) {
    if (event?.type === "bot_state") {
      const fingerprint = String(event.fingerprint ?? "").trim();
      if (fingerprint && streak.length && fingerprint !== streak.at(-1).fingerprint) streak = [];
      if (fingerprint) currentFingerprint = fingerprint;
      continue;
    }
    if (event?.type === "rpc_uncertain_quarantine_result") {
      if (event.changed === true) streak = [];
      continue;
    }
    if (event?.type !== "rpc_uncertain") continue;
    const fingerprint = String(event.stateFingerprint ?? currentFingerprint ?? "").trim();
    const method = String(event.method ?? "unknown").trim() || "unknown";
    const timestamp = Date.parse(event.at ?? "");
    if (!fingerprint || !Number.isFinite(timestamp)) {
      streak = [];
      continue;
    }
    if (streak.length && (streak.at(-1).fingerprint !== fingerprint || streak.at(-1).method !== method)) streak = [];
    streak.push({ fingerprint, method, timestamp, at: event.at });
    currentFingerprint = fingerprint;
  }
  if (streak.length < minimumTimeouts) return null;
  const firstThresholdEvent = streak.at(-minimumTimeouts);
  const last = streak.at(-1);
  if (last.timestamp - firstThresholdEvent.timestamp < minimumSpanMs) return null;
  if (now - last.timestamp > freshnessMs || last.timestamp - now > 60_000) return null;
  return {
    method: last.method,
    fingerprint: last.fingerprint,
    timeoutCount: streak.length,
    spanSeconds: Math.round((last.timestamp - streak[0].timestamp) / 1_000),
    lastAt: last.at,
  };
}

export function readRecentRpcStall(runsDirectory, options = {}) {
  const file = latestRunEventFile(runsDirectory);
  if (!file) return null;
  try {
    const stall = detectRpcStall(readEventTail(file), options);
    return stall ? { ...stall, eventFile: file } : null;
  } catch {
    return null;
  }
}

function normalizedCommand(value) {
  return String(value ?? "").replaceAll("/", "\\").toLowerCase();
}

function ageSeconds(iso, now) {
  const timestamp = Date.parse(iso ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((now - timestamp) / 1_000)) : null;
}

function fileStatus(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() } : { exists: false };
  } catch {
    return { exists: false };
  }
}

function credentialStatus(environmentNames, filePath) {
  const stored = fileStatus(filePath);
  const names = Array.isArray(environmentNames) ? environmentNames : [environmentNames];
  return {
    configured: names.some((name) => Boolean(process.env[name]?.trim())) || stored.exists,
    encryptedFile: stored.exists,
  };
}

function routeCredential(config, provider, credentialDirectory) {
  const candidates = [
    ["strategic", config.modelRoutes?.strategic?.provider],
    ["routine", config.modelRoutes?.routine?.provider],
    ["strategic", config.modelRoutes?.vision?.provider],
  ];
  const routeName = candidates.find(([, routeProvider]) => routeProvider === provider)?.[0];
  if (routeName) {
    const semanticPath = path.join(credentialDirectory, `${routeName}-api-key.dpapi`);
    if (fileStatus(semanticPath).exists) {
      return {
        path: semanticPath,
        environments: routeName === "strategic"
          ? ["BALATRO_STRATEGY_API_KEY", provider === "deepseek-chat" ? "DEEPSEEK_API_KEY" : "KIMI_API_KEY", "MOONSHOT_API_KEY"]
          : ["BALATRO_ROUTINE_API_KEY", provider === "deepseek-chat" ? "DEEPSEEK_API_KEY" : "KIMI_API_KEY", "MOONSHOT_API_KEY"],
      };
    }
  }
  const legacyProvider = provider ?? config.balatrobotProvider;
  const legacyPath = path.join(credentialDirectory, legacyProvider === "deepseek-chat" ? "deepseek-api-key.dpapi" : "kimi-api-key.dpapi");
  const legacyEnvironment = legacyProvider === "deepseek-chat" ? "DEEPSEEK_API_KEY" : legacyProvider === "kimi-platform" ? "MOONSHOT_API_KEY" : "KIMI_API_KEY";
  return { path: legacyPath, environments: [legacyEnvironment] };
}

function healthComponent(id, label, group, status, summary, detail, metadata = {}) {
  return { id, label, group, status, summary, detail, ...metadata };
}

function normalizeSnapshot(snapshot) {
  const source = snapshot && !Array.isArray(snapshot) ? snapshot : { processes: snapshot };
  const processes = (source?.processes ?? []).map((item) => ({
    name: String(item.Name ?? item.name ?? ""),
    pid: Number(item.ProcessId ?? item.processId ?? item.pid) || null,
    parentPid: Number(item.ParentProcessId ?? item.parentProcessId ?? item.parentPid) || null,
    command: String(item.CommandLine ?? item.commandLine ?? item.command ?? ""),
  }));
  const listeners = (source?.listeners ?? []).map((item) => ({
    port: Number(item.LocalPort ?? item.localPort ?? item.port) || null,
    pid: Number(item.OwningProcess ?? item.owningProcess ?? item.pid) || null,
  }));
  return { processes, listeners };
}

export function parseWindowsNetstatListeners(output, watchedPorts = [11_434, 12_346, 4_312, 4_313]) {
  const watched = new Set(watchedPorts.map(Number));
  const listeners = [];
  const seen = new Set();
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
    if (columns[3]?.toUpperCase() !== "LISTENING") continue;
    const match = /:(\d+)$/u.exec(columns[1] ?? "");
    const port = Number(match?.[1]);
    const pid = Number(columns[4]);
    if (!watched.has(port) || !Number.isInteger(pid) || pid <= 0) continue;
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ port, pid });
  }
  return listeners;
}

export async function readWindowsComponentSnapshot() {
  if (process.platform !== "win32") return { processes: [], listeners: [] };
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$names = @('Balatro.exe','node.exe','ollama.exe','uv.exe','uvx.exe','python.exe')",
    "$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name } | Select-Object Name,ProcessId,ParentProcessId,CommandLine)",
    "$processes | ConvertTo-Json -Depth 3 -Compress",
  ].join("; ");
  const [processResult, netstatResult] = await Promise.all([
    execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 1_048_576 },
    ),
    execFileAsync(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "netstat.exe"),
      ["-ano", "-p", "tcp"],
      { encoding: "utf8", windowsHide: true, timeout: 3_000, maxBuffer: 2_097_152 },
    ),
  ]);
  const processes = JSON.parse(processResult.stdout || "[]");
  return normalizeSnapshot({
    processes: Array.isArray(processes) ? processes : processes ? [processes] : [],
    listeners: parseWindowsNetstatListeners(netstatResult.stdout),
  });
}

export class ProjectHealthMonitor {
  constructor({
    projectRoot,
    config,
    routineBackend,
    strategicBackend = null,
    stats,
    processProvider = readWindowsComponentSnapshot,
    fetchImpl = fetch,
    credentialDirectory = localAppDataFile(),
    now = () => Date.now(),
    cacheMs = 3_000,
  }) {
    this.projectRoot = path.resolve(projectRoot);
    this.config = config;
    this.routineBackend = routineBackend;
    this.strategicBackend = strategicBackend;
    this.stats = stats;
    this.processProvider = processProvider;
    this.fetch = fetchImpl;
    this.credentialDirectory = credentialDirectory;
    this.now = now;
    this.cacheMs = cacheMs;
    this.cachedAt = 0;
    this.cached = null;
    this.pending = null;
    this.generation = 0;
    this.lastGoodSnapshot = null;
    this.lastGoodSnapshotAt = 0;
  }

  async refresh() {
    const now = this.now();
    if (this.cached && now - this.cachedAt < this.cacheMs) return this.cached;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.#read(now).then((result) => {
      if (generation === this.generation) {
        this.cached = result;
        this.cachedAt = this.now();
      }
      return result;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  invalidate() {
    this.generation += 1;
    this.cachedAt = 0;
    this.cached = null;
    this.pending = null;
  }

  async #read(now) {
    const [processResult, backendResult, strategicResult, statsResult, overlayResult] = await Promise.allSettled([
      this.processProvider(),
      this.routineBackend.status(),
      this.strategicBackend ? this.strategicBackend.status() : Promise.resolve(null),
      Promise.resolve().then(() => this.stats.refresh()),
      this.#overlayHealth(),
    ]);
    const snapshotFresh = processResult.status === "fulfilled";
    if (snapshotFresh) {
      this.lastGoodSnapshot = normalizeSnapshot(processResult.value);
      this.lastGoodSnapshotAt = now;
    }
    const snapshot = snapshotFresh
      ? this.lastGoodSnapshot
      : this.lastGoodSnapshot ?? { processes: [], listeners: [] };
    const snapshotState = snapshotFresh ? "fresh" : this.lastGoodSnapshot ? "stale" : "unavailable";
    const snapshotAgeSeconds = this.lastGoodSnapshotAt ? Math.max(0, Math.round((now - this.lastGoodSnapshotAt) / 1_000)) : null;
    const backend = backendResult.status === "fulfilled" ? backendResult.value : null;
    const strategic = strategicResult.status === "fulfilled" ? strategicResult.value : null;
    const telemetry = statsResult.status === "fulfilled" ? statsResult.value : null;
    const overlayReady = overlayResult.status === "fulfilled";
    const projectToken = normalizedCommand(this.projectRoot);
    const processBy = (predicate) => snapshot.processes.find(predicate) ?? null;
    const listener = (port) => snapshot.listeners.find((item) => item.port === port) ?? null;
    const game = processBy((item) => item.name.toLowerCase() === "balatro.exe");
    const controller = processBy((item) => {
      if (item.name.toLowerCase() !== "node.exe") return false;
      const command = normalizedCommand(item.command);
      return command.includes(projectToken) && command.includes("\\src\\index.mjs") && /\brun\b/u.test(command);
    });
    const botLauncher = processBy((item) => normalizedCommand(item.command).includes("balatrobot-serve-compat.py serve"));
    const overlayProcess = processBy((item) => normalizedCommand(item.command).includes("src\\overlay-server.mjs"));
    const ollamaProcess = processBy((item) => item.name.toLowerCase() === "ollama.exe");
    const botListener = listener(12_346);
    const dashboardListener = listener(4_312);
    const overlayListener = listener(4_313);
    const lastEventAt = telemetry?.coverage?.lastEventAt ?? telemetry?.live?.at ?? null;
    const eventAgeSeconds = ageSeconds(lastEventAt, now);
    const rpcStall = readRecentRpcStall(path.join(this.projectRoot, "runs"), { now });
    const components = [];

    const processStatus = (present) => snapshotState === "fresh" ? (present ? "healthy" : "offline") : "degraded";
    const processSummary = (present, running, stopped) => snapshotState === "fresh"
      ? (present ? running : stopped)
      : snapshotState === "stale" ? "沿用最近一次进程快照" : "进程探针暂不可用";
    const snapshotSuffix = snapshotState === "fresh"
      ? ""
      : snapshotState === "stale" ? ` · 快照约 ${snapshotAgeSeconds} 秒前` : " · 等待下一次探针";

    components.push(healthComponent(
      "dashboard", "后台页面", "观测", dashboardListener ? "healthy" : "degraded",
      dashboardListener ? "服务正常" : "页面可用，监听信息暂不可用",
      dashboardListener ? `127.0.0.1:4312 · PID ${dashboardListener.pid}${snapshotSuffix}` : `当前请求已成功${snapshotSuffix}`,
      { pid: dashboardListener?.pid ?? process.pid },
    ));
    components.push(healthComponent(
      "game", "Balatro 游戏", "核心", processStatus(game),
      processSummary(game, "窗口进程运行中", "未运行"),
      game ? `PID ${game.pid}${telemetry?.live?.state ? ` · ${telemetry.live.state}` : ""}${snapshotSuffix}` : `启动 BalatroBot 后会自动拉起游戏${snapshotSuffix}`,
      { pid: game?.pid ?? null },
    ));
    const botHealthy = Boolean(botListener && (game || botLauncher));
    components.push(healthComponent(
      "balatrobot", "BalatroBot", "核心", snapshotState === "fresh" ? (botHealthy ? "healthy" : botListener ? "degraded" : "offline") : "degraded",
      snapshotState === "fresh" ? (botHealthy ? "RPC 服务监听中" : botListener ? "端口存在，进程关系异常" : "未运行") : processSummary(botHealthy, "RPC 服务监听中", "未运行"),
      botListener
        ? `127.0.0.1:12346 · PID ${botListener.pid} · 仅检查端口，不发送游戏 RPC${snapshotSuffix}`
        : `精确游戏状态服务监听状态未知${snapshotSuffix}`,
      { pid: botListener?.pid ?? botLauncher?.pid ?? null },
    ));
    if (rpcStall) {
      Object.assign(components.at(-1), {
        status: "degraded",
        summary: "RPC 连续超时，游戏状态未推进",
        detail: `${rpcStall.method} 在同一状态连续超时 ${rpcStall.timeoutCount} 次，持续 ${rpcStall.spanSeconds} 秒`,
        rpcStall,
      });
    }
    const controllerStatus = snapshotState !== "fresh" ? "degraded" : controller
      ? rpcStall || (eventAgeSeconds !== null && eventAgeSeconds > 600) ? "degraded" : "healthy"
      : "offline";
    components.push(healthComponent(
      "controller", "AI 控制器", "核心", controllerStatus,
      snapshotState !== "fresh" ? processSummary(controller, "决策循环运行中", "未运行") : controller ? controllerStatus === "healthy" ? "决策循环运行中" : "进程存在，遥测较久未更新" : "未运行",
      controller
        ? `PID ${controller.pid}${eventAgeSeconds === null ? "" : ` · 最近事件 ${eventAgeSeconds} 秒前`}${snapshotSuffix}`
        : `运行 run-balatro-pilot.ps1 后开始控制游戏${snapshotSuffix}`,
      { pid: controller?.pid ?? null, eventAgeSeconds },
    ));
    if (rpcStall) {
      Object.assign(components.at(-1), {
        summary: "进程存在，但动作超时循环未推进",
        detail: `PID ${controller?.pid ?? "?"} · ${rpcStall.method} / ${rpcStall.fingerprint.slice(0, 12)}… · 最近仍在写入失败事件`,
        rpcStall,
      });
    }

    const localRequested = backend?.mode === "local";
    const localReady = Boolean(backend?.ollama?.reachable && backend?.ollama?.installed && backend?.ollama?.loaded);
    const ollamaStatus = localReady ? "healthy" : !localRequested && backend?.ollama?.reachable ? "idle" : "degraded";
    components.push(healthComponent(
      "ollama", "本地 Qwen", "模型", ollamaStatus,
      localReady ? "模型已加载" : !localRequested ? "DS 模式下待机" : "本地模型未就绪",
      backend?.ollama?.reachable
        ? `${backend.ollama.model ?? this.config.balatrobotLocalModel}${ollamaProcess ? ` · PID ${ollamaProcess.pid}` : ""}`
        : backend?.ollama?.error ?? "Ollama 11434 未响应",
      { pid: ollamaProcess?.pid ?? null, mode: backend?.mode ?? null },
    ));

    const strategicMode = strategic?.mode ??
      (this.config.balatrobotStrategicProvider === "deepseek-chat" ? "deepseek" : "kimi");
    const kimiRoutes = [];
    if (new Set(["kimi-chat", "kimi-platform"]).has(this.config.provider)) kimiRoutes.push("视觉回退");
    if (new Set(["kimi-chat", "kimi-platform"]).has(this.config.balatrobotProvider)) kimiRoutes.push("高频云端");
    if (strategicMode === "kimi") kimiRoutes.push("战略检查点");
    const kimiCredential = routeCredential(this.config, strategicMode === "kimi" ? this.config.balatrobotStrategicProvider : this.config.provider, this.credentialDirectory);
    const kimi = credentialStatus(kimiCredential.environments, kimiCredential.path);
    const kimiActive = kimiRoutes.length > 0;
    const kimiAvailable = kimiActive && (kimi.configured || Boolean(controller));
    const kimiModel = strategicMode === "kimi"
      ? strategic?.model ?? this.config.balatrobotStrategicModel ?? this.config.model
      : this.config.model;
    components.push(healthComponent(
      "kimi", kimiRoutes.includes("战略检查点") ? "Kimi K3 战略" : "Kimi K3 回退", "模型",
      !kimiActive ? "idle" : kimiAvailable ? "configured" : "degraded",
      !kimiActive ? "当前未参与模型路由" : kimi.configured ? "加密凭据已存储" : controller ? "由控制器启动环境提供" : "凭据状态未验证",
      kimiActive
        ? `${kimiModel} · ${kimiRoutes.join(" / ")} · 未发付费探测请求`
        : "当前配置不会调用 Kimi",
    ));
    const deepseekRoutes = [];
    if (this.config.provider === "deepseek-chat") deepseekRoutes.push("视觉回退");
    if (this.config.balatrobotProvider === "deepseek-chat") deepseekRoutes.push("高频云端回退");
    if (strategicMode === "deepseek") deepseekRoutes.push("战略检查点");
    const deepseekCredential = routeCredential(this.config, "deepseek-chat", this.credentialDirectory);
    const deepseek = credentialStatus(deepseekCredential.environments, deepseekCredential.path);
    const deepseekActive = deepseekRoutes.length > 0;
    const deepseekAvailable = deepseekActive && (deepseek.configured || Boolean(controller));
    const deepseekModel = strategicMode === "deepseek"
      ? strategic?.model ?? this.config.balatrobotModel
      : this.config.balatrobotModel;
    components.push(healthComponent(
      "deepseek", deepseekRoutes.includes("战略检查点") ? "DeepSeek Flash 战略" : "DeepSeek Flash 回退", "模型",
      !deepseekActive ? "idle" : deepseekAvailable ? "configured" : "degraded",
      !deepseekActive ? "当前未参与模型路由" : deepseek.configured ? "加密凭据已存储" : controller ? "由控制器启动环境提供" : "凭据状态未验证",
      deepseekActive
        ? `${deepseekModel} · ${deepseekRoutes.join(" / ")} · 未发付费探测请求`
        : "当前配置不会调用 DeepSeek",
    ));

    const ragPath = path.isAbsolute(this.config.semanticRagDatabasePath)
      ? this.config.semanticRagDatabasePath
      : path.join(this.projectRoot, this.config.semanticRagDatabasePath);
    const rag = fileStatus(ragPath);
    components.push(healthComponent(
      "rag", "自学习知识库", "数据", !this.config.semanticRagEnabled ? "idle" : rag.exists ? "healthy" : "degraded",
      !this.config.semanticRagEnabled ? "已禁用" : rag.exists ? "数据库可用" : "等待首次写入",
      rag.exists
        ? `${rag.bytes.toLocaleString("zh-CN")} bytes · 更新于 ${new Date(rag.modifiedAt).toLocaleString("zh-CN")}`
        : "semantic-experience.sqlite 尚未生成",
      { bytes: rag.bytes ?? 0, modifiedAt: rag.modifiedAt ?? null },
    ));
    const coverage = telemetry?.coverage;
    components.push(healthComponent(
      "telemetry", "战绩与事件索引", "数据", coverage ? "healthy" : "degraded",
      coverage ? "增量索引正常" : "读取失败",
      coverage
        ? `${coverage.totalEvents.toLocaleString("zh-CN")} 条事件 · ${coverage.runDirectories} 个运行目录${eventAgeSeconds === null ? "" : ` · 最近 ${eventAgeSeconds} 秒前`}`
        : statsResult.reason?.message ?? "无法读取 runs 目录",
      { eventAgeSeconds, totalEvents: coverage?.totalEvents ?? 0 },
    ));
    const overlayHealthy = overlayReady && Boolean(overlayListener || overlayProcess);
    components.push(healthComponent(
      "overlay", "直播叠层", "观测", overlayHealthy ? "healthy" : overlayReady ? "degraded" : "offline",
      overlayHealthy ? "两个 OBS 页面可用" : overlayReady ? "HTTP 正常，进程快照异常" : "未运行",
      overlayReady
        ? `127.0.0.1:4313 · PID ${overlayListener?.pid ?? overlayProcess?.pid ?? "?"}`
        : overlayResult.reason?.message ?? "直播叠层健康接口未响应",
      { pid: overlayListener?.pid ?? overlayProcess?.pid ?? null },
    ));

    const counts = Object.fromEntries(
      ["healthy", "configured", "idle", "degraded", "offline"].map((status) => [
        status,
        components.filter((item) => item.status === status).length,
      ]),
    );
    const activeCore = components.filter((item) => ["game", "balatrobot", "controller"].includes(item.id));
    const overallStatus = activeCore.every((item) => item.status === "offline")
      ? "idle"
      : activeCore.every((item) => item.status === "healthy") && counts.degraded === 0 && counts.offline === 0
        ? "healthy"
        : "degraded";
    return {
      ok: overallStatus === "healthy",
      checkedAt: new Date(now).toISOString(),
      overall: {
        status: overallStatus,
        label: overallStatus === "healthy" ? "全部就绪" : overallStatus === "idle" ? "项目待机" : "部分组件需关注",
        counts,
      },
      components,
      processSnapshot: {
        status: snapshotState,
        ageSeconds: snapshotAgeSeconds,
        error: processResult.status === "rejected" ? processResult.reason?.message ?? "Windows process probe failed" : null,
      },
      notes: [
        "健康检查只读取进程、端口、文件元数据和本地服务状态。",
        "Kimi 与 DeepSeek 不会因页面刷新产生 API 调用或费用。",
        ...(snapshotState === "fresh" ? [] : ["Windows 进程探针暂不可用；未将未知状态误报为离线。"]),
      ],
    };
  }

  async #overlayHealth() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    timer.unref?.();
    try {
      const response = await this.fetch("http://127.0.0.1:4313/api/health", {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Overlay HTTP ${response.status}`);
      const body = await response.json();
      if (!body?.ok) throw new Error("Overlay health response is invalid");
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}
