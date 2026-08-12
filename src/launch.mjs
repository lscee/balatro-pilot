#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function registryValue(name) {
  try {
    const output = execFileSync(
      "reg.exe",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "/v",
        name,
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const line = output
      .split(/\r?\n/)
      .find((item) => item.trimStart().toLowerCase().startsWith(name.toLowerCase()));
    if (!line) return null;
    const match = line.match(/^\s*\S+\s+REG_\S+\s+(.+?)\s*$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parseWindowsProxy(enabledValue, serverValue) {
  const enabled = enabledValue && Number.parseInt(enabledValue, 0) !== 0;
  if (!enabled || !serverValue?.trim()) return null;

  let server = serverValue.trim();
  if (server.includes("=")) {
    const entries = Object.fromEntries(
      server
        .split(";")
        .map((item) => {
          const [key, value] = item.split("=", 2);
          return [key?.trim().toLowerCase(), value?.trim()];
        })
        .filter((item) => item.length === 2 && item[1]),
    );
    server = entries.https ?? entries.http ?? "";
  }
  if (!server) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(server)) server = `http://${server}`;
  try {
    return new URL(server).toString();
  } catch {
    return null;
  }
}

export function detectWindowsProxy() {
  if (process.platform !== "win32") return null;
  return parseWindowsProxy(registryValue("ProxyEnable"), registryValue("ProxyServer"));
}

function safeProxyLabel(proxy) {
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "configured proxy";
  }
}

function main() {
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    console.error("Error: this project requires Node.js 24+ for built-in HTTPS proxy support.");
    process.exitCode = 1;
    return;
  }

  const env = { ...process.env };
  const noProxy = new Set(
    String(env.NO_PROXY || env.no_proxy || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  noProxy.add("127.0.0.1");
  noProxy.add("localhost");
  noProxy.add("::1");
  env.NO_PROXY = [...noProxy].join(",");
  const existingProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  const detectedProxy = existingProxy ? null : detectWindowsProxy();
  if (detectedProxy) {
    env.HTTPS_PROXY = detectedProxy;
    env.HTTP_PROXY = detectedProxy;
    console.log(`[network] Using Windows system proxy ${safeProxyLabel(detectedProxy)}`);
  } else if (existingProxy) {
    console.log(`[network] Using proxy from environment (${safeProxyLabel(existingProxy)})`);
  } else {
    console.log("[network] No proxy configured; using direct HTTPS connection");
  }

  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const child = spawnSync(
    process.execPath,
    ["--use-env-proxy", "--disable-warning=ExperimentalWarning", path.join(sourceDir, "index.mjs"), ...process.argv.slice(2)],
    { stdio: "inherit", env, windowsHide: false },
  );
  if (child.error) {
    console.error(`Error: failed to launch controller: ${child.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = child.status ?? 1;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
