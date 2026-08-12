import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import {
  BalatrobotAbortError,
  BalatrobotClient,
  BalatrobotHttpError,
  BalatrobotNetworkError,
  BalatrobotProtocolError,
  BalatrobotRpcError,
  BalatrobotTimeoutError,
} from "../src/balatrobot-client.mjs";

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startServer(t, handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error.stack);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("health, gamestate, and call send JSON-RPC 2.0 requests and return results", async (t) => {
  const requests = [];
  const baseUrl = await startServer(t, async (request, response) => {
    const body = await readJson(request);
    requests.push({ body, headers: request.headers, method: request.method });
    const results = {
      health: { status: "ok" },
      gamestate: { state: "SELECTING_HAND", dollars: 7 },
      play: { state: "SELECTING_HAND", hands: 3 },
    };
    writeJson(response, 200, { jsonrpc: "2.0", result: results[body.method], id: body.id });
  });
  const client = new BalatrobotClient({ baseUrl, timeoutMs: 1_000 });

  assert.deepEqual(await client.health(), { status: "ok" });
  assert.deepEqual(await client.gamestate(), { state: "SELECTING_HAND", dollars: 7 });
  assert.deepEqual(await client.call("play", { cards: [0, 2] }), { state: "SELECTING_HAND", hands: 3 });

  assert.deepEqual(
    requests.map(({ body }) => body),
    [
      { jsonrpc: "2.0", method: "health", id: 1 },
      { jsonrpc: "2.0", method: "gamestate", id: 2 },
      { jsonrpc: "2.0", method: "play", id: 3, params: { cards: [0, 2] } },
    ],
  );
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.accept, "application/json");
  assert.equal(requests[0].headers["content-type"], "application/json");
});

test("call exposes JSON-RPC errors with their code and data", async (t) => {
  const baseUrl = await startServer(t, async (request, response) => {
    const body = await readJson(request);
    writeJson(response, 200, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Cannot play outside SELECTING_HAND", data: { name: "INVALID_STATE" } },
      id: body.id,
    });
  });
  const client = new BalatrobotClient({ baseUrl });

  await assert.rejects(client.call("play", { cards: [0] }), (error) => {
    assert.ok(error instanceof BalatrobotRpcError);
    assert.equal(error.code, -32001);
    assert.deepEqual(error.data, { name: "INVALID_STATE" });
    assert.equal(error.method, "play");
    assert.equal(error.requestId, 1);
    return true;
  });
});

test("call distinguishes HTTP and malformed JSON-RPC responses", async (t) => {
  const baseUrl = await startServer(t, async (request, response) => {
    const body = await readJson(request);
    if (body.method === "unavailable") {
      writeJson(response, 503, { error: { message: "Balatro is starting" } });
      return;
    }
    if (body.method === "bad_json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{not-json");
      return;
    }
    writeJson(response, 200, { jsonrpc: "2.0", result: {}, id: body.id + 1 });
  });
  const client = new BalatrobotClient({ baseUrl });

  await assert.rejects(client.call("unavailable"), (error) => {
    assert.ok(error instanceof BalatrobotHttpError);
    assert.equal(error.status, 503);
    assert.match(error.message, /Balatro is starting/);
    return true;
  });
  await assert.rejects(client.call("bad_json"), (error) => {
    assert.ok(error instanceof BalatrobotProtocolError);
    assert.match(error.message, /invalid JSON/);
    return true;
  });
  await assert.rejects(client.call("wrong_id"), (error) => {
    assert.ok(error instanceof BalatrobotProtocolError);
    assert.match(error.message, /did not match/);
    return true;
  });
});

test("call separates timeouts from caller-initiated AbortSignal cancellation", async (t) => {
  const baseUrl = await startServer(t, async (request, response) => {
    const body = await readJson(request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!response.destroyed) writeJson(response, 200, { jsonrpc: "2.0", result: {}, id: body.id });
  });
  const client = new BalatrobotClient({ baseUrl, timeoutMs: 1_000 });

  await assert.rejects(client.call("slow", undefined, { timeoutMs: 20 }), (error) => {
    assert.ok(error instanceof BalatrobotTimeoutError);
    assert.equal(error.timeoutMs, 20);
    assert.equal(error.method, "slow");
    return true;
  });

  const controller = new AbortController();
  const pending = client.call("cancel_me", undefined, { signal: controller.signal });
  controller.abort(new Error("test cancellation"));
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof BalatrobotAbortError);
    assert.equal(error.name, "AbortError");
    assert.match(error.cause.message, /test cancellation/);
    return true;
  });
});

test("call wraps fetch failures as network errors", async () => {
  const client = new BalatrobotClient({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(client.health(), (error) => {
    assert.ok(error instanceof BalatrobotNetworkError);
    assert.equal(error.method, "health");
    assert.match(error.cause.message, /fetch failed/);
    return true;
  });
});

test("client serializes concurrent calls for BalatroBot's single-client server", async () => {
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (_url, options) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const request = JSON.parse(options.body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { method: request.method } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new BalatrobotClient({ fetchImpl, timeoutMs: 1_000 });
  const results = await Promise.all([client.call("health"), client.call("gamestate"), client.call("rpc.discover")]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(results.map((item) => item.method), ["health", "gamestate", "rpc.discover"]);
});
