import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("dashboard exposes explicit pause and start controls without implying that the game stops", () => {
  const html = fs.readFileSync(path.join(root, "dashboard", "index.html"), "utf8");
  assert.match(html, /id="pilot-control"/u);
  assert.match(html, /id="pilot-pause"[^>]*>[\s\S]*?一键暂停/u);
  assert.match(html, /id="pilot-start"[^>]*>[\s\S]*?一键启动/u);
  assert.match(html, /只暂停或启动 AI 决策与自动输入/u);
  assert.match(html, /Balatro 游戏、BalatroBot RPC 和直播页面都会继续运行/u);
});

test("dashboard control requests are single-flight, revision-aware, and refreshed independently", () => {
  const source = fs.readFileSync(path.join(root, "dashboard", "app.js"), "utf8");
  assert.match(source, /fetchWithTimeout\("\/api\/pilot-control"/u);
  assert.match(source, /method:\s*"POST"/u);
  assert.match(source, /expectedRevision/u);
  assert.match(source, /if \(pilotControlOperationPending\) return pilotControlOperationPending/u);
  assert.match(source, /if \(pilotControlReadPending\) return pilotControlReadPending/u);
  assert.match(source, /setInterval\(refreshPilotControl, 10_000\)/u);
  assert.match(source, /controlPilot\("pause"\)/u);
  assert.match(source, /controlPilot\("start"\)/u);
});
