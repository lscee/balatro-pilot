import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BalatroCardAssets } from "./balatro-card-assets.mjs";
import { overlayThemeForState } from "./overlay-theme.mjs";
import { StreamOverlayState } from "./stream-overlay-state.mjs";

const modulePath = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(modulePath);
const defaultProjectRoot = path.resolve(moduleDirectory, "..");
const OVERLAY_UI_VERSION = "stream-v15";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const STATIC_FILES = Object.freeze({
  "/overlay/cards": ["cards.html", "text/html; charset=utf-8"],
  "/overlay/cards/": ["cards.html", "text/html; charset=utf-8"],
  "/overlay/strategy": ["strategy.html", "text/html; charset=utf-8"],
  "/overlay/strategy/": ["strategy.html", "text/html; charset=utf-8"],
  "/overlay/common.js": ["common.js", "text/javascript; charset=utf-8"],
  "/overlay/cards.js": ["cards.js", "text/javascript; charset=utf-8"],
  "/overlay/strategy.js": ["strategy.js", "text/javascript; charset=utf-8"],
  "/overlay/styles.css": ["styles.css", "text/css; charset=utf-8"],
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

function decorateArea(area, assets) {
  if (!area) return area;
  return { ...area, cards: (area.cards ?? []).map((card) => assets.decorateCard(card)) };
}

function decorateSnapshot(snapshot, assets) {
  const theme = overlayThemeForState(snapshot.state);
  if (!snapshot.state) return { ...snapshot, theme, uiVersion: OVERLAY_UI_VERSION };
  return {
    ...snapshot,
    theme,
    uiVersion: OVERLAY_UI_VERSION,
    state: {
      ...snapshot.state,
      jokers: decorateArea(snapshot.state.jokers, assets),
      consumables: decorateArea(snapshot.state.consumables, assets),
    },
  };
}

function parseArguments(argv) {
  const result = { host: "127.0.0.1", port: 4313 };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--host") result.host = argv[++index];
    else if (token === "--port") result.port = Number(argv[++index]);
    else throw new Error(`Unknown overlay option: ${token}`);
  }
  if (!LOOPBACK_HOSTS.has(result.host)) {
    throw new Error("Overlay host must be a loopback address");
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65_535) {
    throw new Error("Overlay port must be an integer between 1 and 65535");
  }
  return result;
}

export function createOverlayServer({ projectRoot = defaultProjectRoot, stateReader, cardAssets } = {}) {
  const overlayDirectory = path.join(projectRoot, "overlay");
  const reader = stateReader ?? new StreamOverlayState(projectRoot);
  const assets = cardAssets ?? new BalatroCardAssets();
  let cache = null;
  let cacheAt = 0;

  const currentSnapshot = () => {
    const now = Date.now();
    if (cache && now - cacheAt < 250) return cache;
    cache = decorateSnapshot(reader.refresh(), assets);
    cacheAt = now;
    return cache;
  };

  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET") {
      send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (url.pathname === "/api/health") {
      send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, readOnly: true }));
      return;
    }
    if (url.pathname === "/api/overlay") {
      try {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(currentSnapshot()), {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        send(
          response,
          500,
          "application/json; charset=utf-8",
          JSON.stringify({ error: "overlay_state_failed", message: error.message }),
        );
      }
      return;
    }
    const atlasMatch = url.pathname.match(/^\/assets\/game\/(jokers|tarots)\.png$/);
    if (atlasMatch) {
      try {
        const asset = assets.getAsset(atlasMatch[1]);
        if (!asset) {
          send(response, 404, "text/plain; charset=utf-8", "Card art unavailable");
          return;
        }
        send(response, 200, "image/png", asset.buffer, { "Cache-Control": "public, max-age=86400, immutable" });
      } catch (error) {
        send(response, 500, "text/plain; charset=utf-8", `Card art unavailable: ${error.message}`);
      }
      return;
    }
    const asset = STATIC_FILES[url.pathname];
    if (!asset) {
      send(response, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    try {
      send(response, 200, asset[1], fs.readFileSync(path.join(overlayDirectory, asset[0])), {
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
          "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' obs:;",
      });
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Overlay asset missing");
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  const options = parseArguments(process.argv.slice(2));
  const server = createOverlayServer({ projectRoot: defaultProjectRoot });
  server.listen(options.port, options.host, () => {
    console.log(`Balatro stream cards:    http://${options.host}:${options.port}/overlay/cards`);
    console.log(`Balatro stream strategy: http://${options.host}:${options.port}/overlay/strategy`);
    console.log("Read-only mode: events.ndjson + local Balatro card textures; no model or game RPC calls.");
    console.log("Press Ctrl+C to stop.");
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
