import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DashboardStats } from "./dashboard-stats.mjs";
import { ProjectHealthMonitor } from "./component-health.mjs";
import { loadConfig, plannerConfigForBackend } from "./config.mjs";
import { LearningDatabaseMetrics } from "./learning-metrics.mjs";
import { RoutineBackendController } from "./models/routine-router.mjs";
import { StrategicBackendController, strategicModeForProvider } from "./models/strategic-router.mjs";

const modulePath = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(modulePath);
const defaultProjectRoot = path.resolve(moduleDirectory, "..");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const STATIC_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
});

function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

function sendJson(response, status, value, headers = {}) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value), headers);
}

function parseArguments(argv) {
  const result = { host: "127.0.0.1", port: 4312 };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--host") result.host = argv[++index];
    else if (token === "--port") result.port = Number(argv[++index]);
    else throw new Error("Unknown dashboard option: " + token);
  }
  if (!LOOPBACK_HOSTS.has(result.host)) {
    throw new Error("Dashboard host must be a loopback address");
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65_535) {
    throw new Error("Dashboard port must be an integer between 1 and 65535");
  }
  return result;
}

function readJson(request, limit = 4_096) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("request_too_large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

export function createDashboardServer({
  projectRoot = defaultProjectRoot,
  routineBackend = null,
  strategicBackend = null,
  componentHealth = null,
} = {}) {
  const dashboardDirectory = path.join(projectRoot, "dashboard");
  const config = loadConfig(projectRoot);
  const stats = new DashboardStats(projectRoot, {
    learningMetrics: new LearningDatabaseMetrics(projectRoot, {
      databasePath: path.resolve(projectRoot, config.semanticRagDatabasePath),
      minimumIndependentEpisodes: config.semanticPriorMinimumEpisodes,
      confidenceZ: config.semanticPriorConfidenceZ,
    }),
  });
  if (!routineBackend) {
    const local = plannerConfigForBackend(config, "balatrobot-local");
    routineBackend = new RoutineBackendController({
      defaultMode: config.balatrobotRoutineBackendDefault,
      ollamaBaseUrl: new URL(local.apiBaseUrl).origin,
      ollamaModel: local.model,
    });
  }
  const availableStrategicModes = [
    ["kimi-chat", "kimi-platform"].includes(config.modelRoutes.strategic.provider) ||
      ["kimi-chat", "kimi-platform"].includes(config.modelRoutes.routine.provider) ? "kimi" : null,
    config.modelRoutes.strategic.provider === "deepseek-chat" ||
      config.modelRoutes.routine.provider === "deepseek-chat" ? "deepseek" : null,
  ].filter(Boolean);
  strategicBackend ??= new StrategicBackendController({
    defaultMode: strategicModeForProvider(config.balatrobotStrategicProvider),
    availableModes: availableStrategicModes,
  });
  componentHealth ??= new ProjectHealthMonitor({ projectRoot, config, routineBackend, strategicBackend, stats });
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/routine-backend" && request.method === "GET") {
      try {
        sendJson(response, 200, await routineBackend.status(), {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        sendJson(response, 500, { error: "backend_status_failed", message: error.message });
      }
      return;
    }
    if (url.pathname === "/api/routine-backend" && request.method === "POST") {
      try {
        const body = await readJson(request);
        const state = routineBackend.setMode(body.mode, { updatedBy: "dashboard" });
        componentHealth.invalidate?.();
        let ollama;
        let operationError = null;
        try {
          ollama = state.mode === "local"
            ? await routineBackend.loadLocalModel()
            : await routineBackend.unloadLocalModel();
        } catch (error) {
          operationError = error.message;
          ollama = await routineBackend.ollamaStatus();
        }
        sendJson(response, 200, {
          ok: !operationError,
          ...state,
          effective: state.mode === "local" && ollama.reachable && ollama.loaded ? "local" : "deepseek",
          ollama,
          operationError,
        }, { "Cache-Control": "no-store" });
      } catch (error) {
        sendJson(response, 400, { error: "backend_switch_failed", message: error.message });
      }
      return;
    }
    if (url.pathname === "/api/strategic-backend" && request.method === "GET") {
      try {
        sendJson(response, 200, strategicBackend.status(), {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        sendJson(response, 500, { error: "strategic_backend_status_failed", message: error.message });
      }
      return;
    }
    if (url.pathname === "/api/strategic-backend" && request.method === "POST") {
      try {
        const body = await readJson(request);
        const state = strategicBackend.setMode(body.mode, { updatedBy: "dashboard" });
        componentHealth.invalidate?.();
        sendJson(response, 200, {
          ok: true,
          ...strategicBackend.status(),
          ...state,
        }, { "Cache-Control": "no-store" });
      } catch (error) {
        sendJson(response, 400, { error: "strategic_backend_switch_failed", message: error.message });
      }
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/stats") {
      try {
        sendJson(response, 200, stats.refresh(), { "Cache-Control": "no-store" });
      } catch (error) {
        sendJson(response, 500, { error: "stats_failed", message: error.message });
      }
      return;
    }
    if (url.pathname === "/api/components") {
      try {
        sendJson(response, 200, await componentHealth.refresh(), { "Cache-Control": "no-store" });
      } catch (error) {
        sendJson(response, 500, { error: "component_health_failed", message: error.message });
      }
      return;
    }
    const asset = STATIC_FILES[url.pathname];
    if (!asset) {
      send(response, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    const [fileName, contentType] = asset;
    try {
      send(
        response,
        200,
        contentType,
        fs.readFileSync(path.join(dashboardDirectory, fileName)),
        {
          "Cache-Control": "no-cache",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
        },
      );
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Dashboard asset missing");
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  const options = parseArguments(process.argv.slice(2));
  const server = createDashboardServer({ projectRoot: defaultProjectRoot });
  server.listen(options.port, options.host, () => {
    console.log("Balatro Pilot dashboard: http://" + options.host + ":" + options.port);
    console.log("Reading: " + path.join(defaultProjectRoot, "runs"));
    console.log("Press Ctrl+C to stop.");
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
