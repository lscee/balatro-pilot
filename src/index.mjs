#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  canonicalShopTargetPoint,
  executeActions,
  interruptibleSleep,
  preActionChangeRatioThreshold,
  ShopLoopGuard,
  validatePlan,
  waitForInputFocus,
} from "./actions.mjs";
import { BalatrobotClient, BalatrobotNetworkError } from "./balatrobot-client.mjs";
import { BalatrobotOverlayController } from "./balatrobot-overlay.mjs";
import { BalatroProfileReader } from "./balatro-profile.mjs";
import { runBalatrobot } from "./balatrobot-runner.mjs";
import { loadConfig, plannerConfigForBackend } from "./config.mjs";
import { createModelStack } from "./models/model-stack.mjs";
import { FrameGate, signatureRegionDifference, stableCellRatio } from "./frame-gate.mjs";
import { apiKeyEnvironment, mergeUsage, VisionPlanner } from "./models/planner.mjs";
import { RunLog } from "./run-log.mjs";
import { SemanticRagStore } from "./semantic-rag.mjs";
import { RoundStrategyContext } from "./round-strategy.mjs";
import { StrategicCheckpointStore } from "./strategic-checkpoints.mjs";
import { WindowsBridge } from "./windows-bridge.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDir, "..");

function usage() {
  console.log(`Balatro Pilot

Usage:
  node src/index.mjs doctor
  node src/index.mjs bot-doctor
  node src/index.mjs api-doctor
  node src/index.mjs strategic-api-doctor
  node src/index.mjs vision-api-doctor
  node src/index.mjs memory
  node src/index.mjs screenshot [--out path.png]
  node src/index.mjs click --x 0.5 --y 0.5 [--button left|right]
  node src/index.mjs run [--dry-run] [--steps N]

Emergency stop: press Ctrl+C. The vision backend also supports holding F8.`);
}

function parseCli(argv) {
  const command = argv[0] ?? "help";
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      "dry-run": { type: "boolean", default: false },
      steps: { type: "string" },
      out: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      button: { type: "string", default: "left" },
    },
    allowPositionals: false,
    strict: true,
  });
  return { command, values };
}

function concisePlan(plan) {
  return `${plan.observation}\n  screen: ${plan.screen}\n  decision: ${plan.decision.key}\n  strategy: ${plan.strategy}\n  confidence: ${plan.confidence.toFixed(2)}\n  actions: ${plan.actions
    .map((action) => {
      if (action.type === "click") return `click(${action.x.toFixed(3)},${action.y.toFixed(3)})`;
      if (action.type === "key") return `key(${action.key})`;
      if (action.type === "wait") return `wait(${action.ms}ms)`;
      return `stop(${action.reason})`;
    })
    .join(" -> ")}`;
}

function conciseUsage(usage) {
  const cached = usage.cachedInputTokens ? `, cache hit ${usage.cachedInputTokens}` : "";
  const missed = usage.cacheMissTokens ? `, cache miss ${usage.cacheMissTokens}` : "";
  const reasoning = usage.reasoningTokens ? `, reasoning ${usage.reasoningTokens}` : "";
  return `${usage.apiCalls} call(s), input ${usage.inputTokens}${cached}${missed}, output ${usage.outputTokens}${reasoning}, total ${usage.totalTokens}`;
}

function compactPlanActions(plan) {
  return `${plan.screen}: ${plan.actions
    .map((action) => {
      if (action.type === "click") return `click(${action.x.toFixed(3)},${action.y.toFixed(3)})`;
      if (action.type === "key") return `key(${action.key})`;
      return action.type;
    })
    .join(" -> ")}`;
}

function plannerRecoveryWaitPlan(memory, rejectionReason = "Planner returned no usable plan") {
  const conciseReason = String(rejectionReason).slice(0, 200);
  return {
    observation: `Planner output was rejected after one automatic retry: ${conciseReason}`,
    strategy: "Wait briefly, keep the game state unchanged, and replan from a fresh screenshot.",
    memory,
    screen: "unknown",
    state: {
      ante: null,
      money: null,
      score: null,
      target: null,
      handsLeft: null,
      discardsLeft: null,
      deck: "",
      deckRemaining: null,
      deckTotal: null,
      deckSnapshot: "",
      stake: "",
      blind: "",
      build: "",
      outcome: "unknown",
      features: ["planner-response-recovery"],
    },
    decision: {
      key: "wait_for_fresh_plan",
      selectedBefore: [],
      selectedAfter: [],
      visibleCardCount: 0,
      handCapacity: 0,
      visibleCards: [],
      targetHand: "none",
      commit: "none",
    },
    confidence: 0,
    finished: false,
    needsDetail: false,
    actions: [
      {
        type: "wait",
        x: null,
        y: null,
        button: null,
        key: null,
        ms: 750,
        target: null,
        reason: "Recover from rejected planner response",
      },
    ],
  };
}

function packRecoverySkipPlan(memory) {
  return {
    observation: "Pack Use/Take failed to change the layout twice; local recovery is skipping this pack.",
    strategy: "Skip the unresolved pack once so autonomous play can continue.",
    memory,
    screen: "pack",
    state: {
      ante: null,
      money: null,
      score: null,
      target: null,
      handsLeft: null,
      discardsLeft: null,
      deck: "",
      deckRemaining: null,
      deckTotal: null,
      deckSnapshot: "",
      stake: "",
      blind: "",
      build: "",
      outcome: "ongoing",
      features: ["pack-transition-recovery"],
    },
    decision: {
      key: "skip_stuck_pack",
      selectedBefore: [],
      selectedAfter: [],
      visibleCardCount: 0,
      handCapacity: 0,
      visibleCards: [],
      targetHand: "none",
      packChoice: "none",
      commit: "none",
    },
    confidence: 1,
    finished: false,
    needsDetail: false,
    actions: [
      {
        type: "click",
        x: null,
        y: null,
        button: null,
        key: null,
        ms: null,
        target: "pack_skip",
        reason: "Recover from two failed Use attempts",
      },
    ],
  };
}

function shopRecoveryNextRoundPlan(memory, sourcePlan, loop) {
  return {
    observation: `Buy & Use was proposed ${loop.count} consecutive times without confirmed shop progress.`,
    strategy: "Stop retrying the unavailable control and leave the shop so autonomous play can continue.",
    memory,
    screen: "shop",
    state: sourcePlan.state,
    decision: {
      key: "leave_stuck_shop",
      selectedBefore: [],
      selectedAfter: [],
      visibleCardCount: 0,
      handCapacity: 0,
      visibleCards: [],
      targetHand: "none",
      packChoice: "none",
      shopOfferPositions: sourcePlan.decision.shopOfferPositions,
      commit: "none",
    },
    confidence: 1,
    finished: false,
    needsDetail: false,
    actions: [
      {
        type: "click",
        x: null,
        y: null,
        button: null,
        key: null,
        ms: null,
        target: "shop_next_round",
        reason: `Recover from ${loop.count} unavailable Buy & Use attempts`,
      },
    ],
  };
}

function plannerErrorLog(error) {
  return {
    message: error.message,
    code: error.code ?? null,
    responseId: error.responseId ?? null,
    finishReason: error.finishReason ?? null,
    diagnostics: error.diagnostics ?? null,
    recoveryAttempts: error.recoveryAttempts ?? [],
    usage: error.usage ?? mergeUsage(),
  };
}

async function withBridge(config, callback) {
  const bridge = new WindowsBridge(projectRoot);
  try {
    await bridge.start();
    const target = await bridge.locate(config.windowTitle);
    console.log(`Target: ${target.title} (handle ${target.handle})`);
    return await callback(bridge);
  } finally {
    await bridge.close();
  }
}

async function doctor(config) {
  const bridge = new WindowsBridge(projectRoot);
  try {
    await bridge.start();
    console.log("[ok] Windows input bridge started");
    const windows = await bridge.listWindows();
    const candidates = windows.windows.filter((item) => item.title.toLowerCase().includes(config.windowTitle.toLowerCase()));
    if (!candidates.length) {
      console.log(`[fail] No visible window contains '${config.windowTitle}'`);
      console.log("Start Balatro in windowed or borderless mode, then run doctor again.");
      process.exitCode = 2;
      return;
    }
    const target = await bridge.locate(config.windowTitle);
    console.log(`[ok] Located ${target.title}`);
    const focus = await bridge.focus();
    console.log(focus.focused ? "[ok] Focus requested" : "[warn] Windows refused foreground focus; click the game once manually");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const capture = await bridge.capture();
    if (!capture.signature) throw new Error("Windows bridge did not return a frame signature");
    const output = path.join(projectRoot, "runs", "doctor.png");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, Buffer.from(capture.pngBase64, "base64"));
    console.log(`[ok] Captured ${capture.width}x${capture.height} via ${capture.method ?? "unknown"} -> ${output}`);
    if (capture.modelImageBase64) {
      const pngBytes = Buffer.from(capture.pngBase64, "base64").length;
      const modelBytes = Buffer.from(capture.modelImageBase64, "base64").length;
      console.log(
        `[ok] Model upload image is ${capture.modelImageMimeType ?? "image/jpeg"} ` +
          `(${Math.round(modelBytes / 1024)} KiB vs ${Math.round(pngBytes / 1024)} KiB audit PNG)`,
      );
    }
    console.log(`[ok] Local frame signature is available (${Buffer.from(capture.signature, "base64").length} bytes)`);
    console.log("[ok] F8 emergency stop is available");
    const exactPlannerConfig = plannerConfigForBackend(config, "balatrobot");
    const strategicPlannerConfig = plannerConfigForBackend(config, "balatrobot-strategic");
    const keyNames = new Set([
      apiKeyEnvironment(config.provider),
      apiKeyEnvironment(exactPlannerConfig.provider),
      apiKeyEnvironment(strategicPlannerConfig.provider),
    ].filter(Boolean));
    for (const keyName of keyNames) {
      console.log(process.env[keyName] ? `[ok] ${keyName} is set` : `[info] ${keyName} is not set (needed by a configured model route)`);
    }
  } finally {
    await bridge.close();
  }
}

async function apiDoctor(config, backend = "balatrobot") {
  const plannerConfig = plannerConfigForBackend(config, backend);
  const routeLabel = {
    balatrobot: "BalatroBot routine exact state",
    "balatrobot-strategic": "BalatroBot strategic exact state",
    vision: "vision fallback",
  }[backend] ?? backend;
  console.log(`Route: ${routeLabel}`);
  console.log(`Provider: ${plannerConfig.provider}`);
  console.log(`Endpoint: ${plannerConfig.apiBaseUrl}`);
  console.log(`Requested model: ${plannerConfig.model}`);
  const planner = new VisionPlanner(projectRoot, plannerConfig);
  console.log(`Rulebook: loaded (${planner.rulebookInfo.sections} sections, ${planner.rulebookInfo.characters} characters)`);
  const result = await planner.probe();
  console.log(`[ok] Authenticated model response (${result.model}): ${result.text.slice(0, 120)}`);
  console.log(`[ok] API usage: ${conciseUsage(result.usage)}`);
}

function memoryStats(config) {
  const store = new SemanticRagStore(projectRoot, config);
  try {
    const stats = store.stats();
    if (!stats.enabled) {
      console.log("Semantic RAG learning is disabled in config.json");
      return;
    }
    console.log(`Semantic policy: v${stats.policyVersion}`);
    console.log(`Reward labels: v${stats.rewardVersion} (raw trajectory versions kept: ${stats.trajectoryVersions.map((item) => `v${item.policyVersion}:${item.transitions}`).join(", ") || "none"})`);
    console.log(
      `Episodes: ${stats.episodes} total, ${stats.completedEpisodes} completed ` +
        `(won ${stats.wonEpisodes}, lost ${stats.lostEpisodes}, interrupted ${stats.interruptedEpisodes})`,
    );
    console.log(`Transitions: ${stats.transitions} recorded, ${stats.learnedTransitions} finalized`);
    console.log(`Reward integrity: ${stats.positiveLossTransitions} losing transition(s) incorrectly positive`);
    console.log(
      `Reward migration: ${stats.rewardMigration.transitions} compatible transition(s) ` +
        `(${stats.rewardMigration.exactTransitions} exact, ${stats.rewardMigration.semanticTransitions} semantic, ` +
        `${stats.rewardMigration.incompatibleTransitions} incompatible, ` +
        `${stats.rewardMigration.correctedOutcomes ?? 0} historical false-win outcome(s) corrected for learning, ` +
        `${stats.rewardMigration.linkedSegments ?? 0} interrupted segment(s)/${stats.rewardMigration.linkedTransitions ?? 0} transition(s) linked)`
    );
    console.log(`Hot semantic index: ${stats.hot}/${config.semanticRagHotLimit}`);
    console.log(`Database: ${stats.databasePath}`);
    const top = store.topActions(10);
    if (!top.length) {
      console.log("No finalized semantic action statistics yet. Complete a live run to add retrievable experience.");
      return;
    }
    console.log("Most observed finalized semantic actions:");
    for (const item of top) {
      console.log(
        `  ${item.screen} | ${item.action} | n=${item.samples} | avgReturn=${item.averageReturn} | W/L=${item.wins}/${item.losses}`,
      );
    }
  } finally {
    store.close();
  }
}

async function screenshot(config, outputArg) {
  await withBridge(config, async (bridge) => {
    if (config.focusBeforeCapture) await bridge.focus();
    const capture = await bridge.capture();
    const output = path.resolve(projectRoot, outputArg ?? path.join("runs", "screenshot.png"));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, Buffer.from(capture.pngBase64, "base64"));
    console.log(`Saved ${capture.width}x${capture.height} screenshot to ${output}`);
  });
}

async function click(config, values) {
  const x = Number(values.x);
  const y = Number(values.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0.005 || x > 0.995 || y < 0.005 || y > 0.995) {
    throw new Error("click requires --x and --y between 0.005 and 0.995");
  }
  if (!new Set(["left", "right"]).has(values.button)) throw new Error("--button must be left or right");
  await withBridge(config, async (bridge) => {
    await bridge.focus();
    await bridge.click(x, y, values.button);
    console.log(`Clicked (${x}, ${y}) with ${values.button} button`);
  });
}

async function runVision(config, { dryRun, steps }) {
  const maxSteps = steps === undefined ? (config.maxSteps ?? Number.POSITIVE_INFINITY) : Number(steps);
  if (maxSteps !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000)) {
    throw new Error("--steps must be an integer between 1 and 10000");
  }
  const stepLimitLabel = Number.isFinite(maxSteps) ? maxSteps : "∞";

  const planner = new VisionPlanner(projectRoot, config);
  const frameGate = new FrameGate(config);
  const roundStrategy = new RoundStrategyContext();
  const log = new RunLog(projectRoot, dryRun ? "dry-run" : "run");
  let cumulativeUsage = mergeUsage();
  const abortController = new AbortController();
  const onSigint = () => abortController.abort();
  process.once("SIGINT", onSigint);
  console.log(`Run log: ${log.dir}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no input will be sent)" : "LIVE"}. Hold F8 or press Ctrl+C to stop.`);
  console.log(`Rulebook: loaded (${planner.rulebookInfo.sections} sections, ${planner.rulebookInfo.characters} characters)`);

  try {
    await withBridge(config, async (bridge) => {
      let memory = "";
      let previousReference = null;
      let requireFrameChange = false;
      let previousPlanSummary = "";
      let previousExecutionInterruption = null;
      let packUseFailures = 0;
      let forcePackSkip = false;
      const shopLoopGuard = new ShopLoopGuard(4);
      for (let step = 1; step <= maxSteps; step++) {
        if (abortController.signal.aborted) throw new Error("Stopped by Ctrl+C");
        const stop = await bridge.stopPressed();
        if (stop.pressed) throw new Error("Emergency stop: F8 is pressed");
        if (!dryRun) {
          await waitForInputFocus({
            bridge,
            signal: abortController.signal,
            retryMs: 2_000,
            onWaiting: () => {
              log.event("focus_wait", { step });
              console.log("\nBalatro is not in the foreground. Waiting locally; click the game once to resume without API calls.");
            },
            onRestored: ({ attempts }) => {
              log.event("focus_restored", { step, attempts });
              console.log(`Balatro focus restored after ${attempts} local check(s); resuming.`);
            },
          });
        } else if (config.focusBeforeCapture) {
          await bridge.focus();
        }
        if ((!dryRun || config.focusBeforeCapture) && config.captureSettleMs) {
          await interruptibleSleep(config.captureSettleMs, bridge, abortController.signal);
        }

        const frame = await frameGate.next({
          bridge,
          previousReference,
          requireChange: requireFrameChange,
          signal: abortController.signal,
        });
        const capture = frame.capture;
        const imagePath = log.screenshot(step, capture.pngBase64);
        log.event("capture", {
          step,
          imagePath,
          width: capture.width,
          height: capture.height,
          frame: {
            changed: frame.changed,
            stable: frame.stable,
            forced: frame.forced,
            probes: frame.probes,
            waitedMs: frame.waitedMs,
            stabilityRatio: frame.stabilityRatio,
            changeRatio: frame.changeRatio,
            referenceCoverage: frame.referenceCoverage,
          },
        });
        let frameContext = frame.stable
          ? `stable after ${frame.probes} local probes; ${frame.changed ? "meaningfully changed" : "not meaningfully changed"} since the last decision`
          : `local gate timed out after ${frame.waitedMs}ms; ${frame.changed ? "changed but may still be animating" : "did not meaningfully change since the last decision"}`;
        if (!frame.changed && previousPlanSummary) {
          frameContext += previousExecutionInterruption
            ? `; previous ${previousExecutionInterruption.screen} execution stopped: ${previousExecutionInterruption.reason}. ` +
              `Inspect the current visible state and issue only actions that have not already taken effect`
            : `; previous attempted plan was ${previousPlanSummary}; do not repeat the same coordinates`;
        }
        console.log(
          `\n[${step}/${stepLimitLabel}] Planning from ${capture.width}x${capture.height} screenshot ` +
            `(${frame.stable ? "stable" : "forced"}, ${frame.probes} local probes)...`,
        );

        const planningInput = {
          pngBase64: capture.modelImageBase64 ?? capture.pngBase64,
          imageMimeType: capture.modelImageMimeType ?? "image/png",
          width: capture.width,
          height: capture.height,
          step,
          memory,
          frameContext,
          roundContext: roundStrategy.promptContext(),
        };
        const planningStartedAt = performance.now();
        let planned;
        let plan;
        let planningSource = "kimi";
        if (!plan) {
          try {
            planned = await planner.plan(planningInput);
            try {
              plan = validatePlan(planned.plan, config);
            } catch (validationError) {
              log.event("plan_rejected", { step, error: validationError.message, candidate: planned.plan, usage: planned.usage });
              console.log(`  Candidate plan rejected locally: ${validationError.message}`);
              console.log("  Requesting one corrected plan from the same screenshot...");
              let corrected;
              try {
                corrected = await planner.plan({
                  ...planningInput,
                  frameContext:
                    `${frameContext}; your previous candidate was rejected before execution: ${validationError.message}. ` +
                    "Return a corrected complete plan and do not repeat the invalid partial sequence.",
                });
              } catch (error) {
                error.usage = mergeUsage(planned.usage, error.usage);
                error.recoveryAttempts = [...planned.attempts, ...(error.recoveryAttempts ?? [])];
                throw error;
              }
              planned = {
                plan: corrected.plan,
                usage: mergeUsage(planned.usage, corrected.usage),
                attempts: [...planned.attempts, ...corrected.attempts],
              };
              try {
                plan = validatePlan(planned.plan, config);
              } catch (correctionValidationError) {
                log.event("plan_correction_rejected", {
                  step,
                  error: correctionValidationError.message,
                  candidate: planned.plan,
                  usage: planned.usage,
                });
                console.warn(
                  `  [warn] Corrected plan was also rejected locally: ${correctionValidationError.message}. ` +
                    "Waiting briefly and replanning from a fresh screenshot instead of stopping the run.",
                );
                plan = validatePlan(plannerRecoveryWaitPlan(memory, correctionValidationError.message), config);
                planningSource = "validation_recovery_wait";
              }
            }
          } catch (error) {
            if (error.code !== "PLAN_JSON_INVALID") throw error;
            const details = plannerErrorLog(error);
            log.event("planner_response_invalid", { step, ...details });
            console.warn(
              `  [warn] Kimi returned empty/incomplete plan content twice ` +
                `(finish_reason=${error.finishReason ?? "unknown"}); waiting briefly and retrying next turn.`,
            );
            plan = validatePlan(plannerRecoveryWaitPlan(memory, error.message), config);
            planned = { plan, usage: details.usage, attempts: details.recoveryAttempts };
            planningSource = "api_recovery_wait";
          }
        }
        if (plan.screen === "pack" && forcePackSkip) {
          plan = validatePlan(packRecoverySkipPlan(memory), config);
          planningSource = "pack_recovery";
        } else if (plan.screen !== "pack") {
          packUseFailures = 0;
          forcePackSkip = false;
        }
        const shopLoop = shopLoopGuard.observe(plan);
        if (shopLoop.recover) {
          plan = validatePlan(shopRecoveryNextRoundPlan(memory, plan, shopLoop), config);
          planningSource = "shop_recovery";
          shopLoopGuard.reset();
        }
        const plannerRecoveryWait = planningSource.endsWith("_recovery_wait");
        const planningMs = performance.now() - planningStartedAt;
        cumulativeUsage = mergeUsage(cumulativeUsage, planned.usage);
        log.event("plan", { step, source: planningSource, planningMs, plan, attempts: planned.attempts, usage: planned.usage });
        console.log(concisePlan(plan));
        console.log(
          `  ${new Set(["fast_path", "pack_recovery", "shop_recovery"]).has(planningSource) ? "Local planning" : "API planning"}: ` +
            `${(planningMs / 1_000).toFixed(2)}s`,
        );
        console.log(`  API usage: ${conciseUsage(planned.usage)}`);
        if (planned.attempts.some((item) => item.jsonRepaired)) {
          console.log("  repaired model JSON locally without another API call");
        }
        if (
          !plannerRecoveryWait &&
          planned.attempts.some((item) => item.truncated || item.emptyContent)
        ) {
          console.log("  recovered from empty/invalid/incomplete JSON with a larger-output retry");
        } else if (new Set(planned.attempts.map((item) => item.detail)).size > 1) {
          console.log(`  detail escalated: ${planned.attempts.map((item) => item.detail).join(" -> ")}`);
        }

        const planHasInput = plan.actions.some((action) => action.type === "click" || action.type === "key");
        if (!dryRun && planHasInput) {
          const currentFrame = await bridge.capture({ includeImage: false });
          const cellBytes = currentFrame.signatureCellBytes ?? capture.signatureCellBytes ?? 2;
          const unchangedRatio = stableCellRatio(
            capture.signature,
            currentFrame.signature,
            config.frameChangeCellThreshold,
            cellBytes,
          );
          const changedRatio = 1 - unchangedRatio;
          const changeRatioThreshold = preActionChangeRatioThreshold(plan, config);
          const handRegionDifference =
            plan.screen === "hand"
              ? signatureRegionDifference(
                  capture.signature,
                  currentFrame.signature,
                  0.52,
                  0.62,
                  12,
                  6,
                  cellBytes,
                )
              : 0;
          const shopTargetDifference =
            plan.screen === "shop"
              ? Math.max(
                  0,
                  ...plan.actions
                    .filter(
                      (action) =>
                        action.type === "click" && canonicalShopTargetPoint(action.target, capture.width / capture.height),
                    )
                    .map((action) => {
                      const point = canonicalShopTargetPoint(action.target, capture.width / capture.height);
                      return signatureRegionDifference(
                        capture.signature,
                        currentFrame.signature,
                        point.hoverX,
                        point.hoverY,
                        point.regionColumns,
                        point.regionRows,
                        cellBytes,
                      );
                    }),
                )
              : 0;
          if (
            changedRatio >= changeRatioThreshold ||
            handRegionDifference >= config.preActionHandRegionThreshold ||
            shopTargetDifference >= config.preActionShopTargetThreshold
          ) {
            log.event("stale_plan_skipped", {
              step,
              changedRatio,
              handRegionDifference,
              shopTargetDifference,
              changeRatioThreshold,
              handRegionThreshold: config.preActionHandRegionThreshold,
              shopTargetThreshold: config.preActionShopTargetThreshold,
              screen: plan.screen,
              decision: plan.decision,
            });
            console.log(
              `  Stale plan skipped: structural change ${(changedRatio * 100).toFixed(1)}%, ` +
                `hand-region difference ${handRegionDifference.toFixed(3)}, ` +
                `shop-target difference ${shopTargetDifference.toFixed(3)}. Taking a fresh screenshot; no input sent.`,
            );
            previousReference = frame.reference;
            requireFrameChange = false;
            continue;
          }
        }
        roundStrategy.observe(plan);

        const result = await executeActions(plan.actions, {
          bridge,
          delayMs: config.actionDelayMs,
          screen: plan.screen,
          cardClickDelayMs: config.cardClickDelayMs,
          cardClickRetries: config.cardClickRetries,
          cardAckThreshold: config.cardAckThreshold,
          cardAckSettleMs: config.cardAckSettleMs,
          cardHoverSettleMs: config.cardHoverSettleMs,
          commitAckSettleMs: config.commitAckSettleMs,
          commitClickRetries: config.commitClickRetries,
          commitAckThreshold: config.commitAckThreshold,
          shopHoverSettleMs: config.shopHoverSettleMs,
          shopPurchaseButtonSettleMs: config.shopPurchaseButtonSettleMs,
          shopPurchaseBaselineMs: config.shopPurchaseBaselineMs,
          shopPurchaseSettleMs: config.shopPurchaseSettleMs,
          shopPurchaseConfirmMs: config.shopPurchaseConfirmMs,
          shopPurchaseRetries: config.shopPurchaseRetries,
          shopPurchaseAckThreshold: config.shopPurchaseAckThreshold,
          shopPurchaseStabilityThreshold: config.shopPurchaseStabilityThreshold,
          shopPurchaseRetryUnchangedThreshold: config.shopPurchaseRetryUnchangedThreshold,
          shopAspectRatio: capture.width / capture.height,
          handAspectRatio: capture.width / capture.height,
          handVisibleCardCount: plan.decision.visibleCardCount,
          handCapacity: plan.decision.handCapacity,
          dryRun,
          signal: abortController.signal,
          onAction: (action) => log.event(dryRun ? "would_execute" : "execute", { step, action }),
          onVerification: (verification) => {
            if (verification.kind === "pack_action" && /^pack_use_/.test(verification.action?.target ?? "")) {
              if (verification.acknowledged) {
                packUseFailures = 0;
                forcePackSkip = false;
              } else {
                packUseFailures += 1;
                forcePackSkip = packUseFailures >= 2;
              }
            } else if (
              verification.kind === "pack_action" &&
              verification.action?.target === "pack_skip" &&
              verification.acknowledged
            ) {
              packUseFailures = 0;
              forcePackSkip = false;
            }
            const verificationEvent = verification.attempts === 0 ? "input_deferred" : "input_ack";
            log.event(verificationEvent, { step, ...verification });
            const verificationLabel =
              verification.kind === "hand_commit"
                ? "Hand commit"
                : verification.kind === "shop_purchase"
                  ? "Shop purchase"
                  : verification.kind === "pack_action"
                    ? "Pack action"
                    : "Card toggle";
            const shopCoordinates =
              verification.kind === "shop_purchase" && verification.point
                ? `, target=${verification.action.target}, click=(${verification.point.x.toFixed(3)},${verification.point.y.toFixed(3)})`
                : "";
            console.log(
              `  ${verificationLabel} ` +
                `${verificationEvent === "input_deferred" ? "deferred before click" : verification.acknowledged ? "acknowledged" : "not confirmed"} ` +
                `after ${verification.attempts} attempt(s), visual change=${verification.difference.toFixed(3)}` +
                shopCoordinates,
            );
          },
        });
        const committedHand =
          plan.screen === "hand" &&
          plan.actions.some(
            (action) => action.type === "click" && new Set(["play_hand", "discard"]).has(action.target),
          );
        if (!dryRun && committedHand && !result.stopped && !result.interrupted && config.handTransitionSettleMs > 0) {
          console.log(`  Waiting ${config.handTransitionSettleMs}ms for scoring/draw animation to finish...`);
          await interruptibleSleep(config.handTransitionSettleMs, bridge, abortController.signal);
        }
        if (!plannerRecoveryWait) {
          memory = plan.memory;
          previousPlanSummary = compactPlanActions(plan);
          previousExecutionInterruption = result.interrupted
            ? { screen: plan.screen, reason: result.reason || "input was not visually confirmed" }
            : null;
        }
        previousReference = frame.reference;
        requireFrameChange =
          !plannerRecoveryWait &&
          !result.interrupted &&
          (planHasInput || plan.actions.some((action) => action.type === "wait"));

        if (result.interrupted) {
          log.event("execution_interrupted", { step, reason: result.reason });
          console.log(`  ${result.reason}; taking a fresh screenshot before replanning.`);
        }

        if (dryRun) {
          console.log("Dry-run completed one planning turn; stopping before repeated planning on an unchanged screen.");
          return;
        }
        if (result.stopped || plan.finished) {
          console.log(`Planner stopped: ${result.reason ?? plan.strategy}`);
          return;
        }
      }
      if (Number.isFinite(maxSteps)) console.log(`Reached maxSteps=${maxSteps}; stopped safely.`);
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    log.event("summary", { usage: cumulativeUsage });
    console.log(`\nCumulative API usage: ${conciseUsage(cumulativeUsage)}`);
  }
}

const requiredBalatrobotMethods = Object.freeze([
  "health",
  "rpc.discover",
  "gamestate",
  "start",
  "menu",
  "select",
  "skip",
  "play",
  "discard",
  "cash_out",
  "endless",
  "buy",
  "sell",
  "reroll",
  "next_round",
  "use",
  "rearrange",
  "screenshot",
]);

function verifyBalatrobotDiscovery(discovery) {
  const methods = new Set(
    Array.isArray(discovery?.methods)
      ? discovery.methods.map((item) => (typeof item === "string" ? item : item?.name)).filter(Boolean)
      : [],
  );
  const missing = requiredBalatrobotMethods.filter((method) => !methods.has(method));
  if (missing.length) throw new Error(`BalatroBot API is missing required method(s): ${missing.join(", ")}`);
  // The pinned v1.5.2 runtime registers pack.lua, but its bundled OpenRPC file
  // accidentally omits `pack` (and still reports info.version 1.5.1). Do not
  // reject that known upstream metadata defect; the installer fingerprints the
  // actual v1.5.2 Lua runtime that contains the endpoint.
  return methods;
}

async function probeBalatrobot(client) {
  const health = await client.health();
  if (health?.status !== "ok") throw new Error(`BalatroBot health returned ${JSON.stringify(health)}`);
  const discovery = await client.call("rpc.discover");
  const methods = verifyBalatrobotDiscovery(discovery);
  const state = await client.gamestate();
  if (!state || typeof state !== "object" || typeof state.state !== "string") {
    throw new Error("BalatroBot gamestate did not return a valid state object");
  }
  return { health, methods, state };
}

async function botDoctor(config) {
  const client = new BalatrobotClient({ baseUrl: config.balatrobotUrl, timeoutMs: config.balatrobotTimeoutMs });
  console.log(`Endpoint: ${client.baseUrl}`);
  const probe = await probeBalatrobot(client);
  console.log(`[ok] Health: ${probe.health.status}`);
  console.log(`[ok] API contract: ${probe.methods.size} method(s), all required methods present`);
  console.log("[ok] Pack endpoint: supplied by the fingerprinted BalatroBot v1.5.2 runtime (missing from its OpenRPC metadata)");
  console.log(
    `[ok] Game state: ${probe.state.state}, Ante ${probe.state.ante_num ?? "?"}, ` +
      `Round ${probe.state.round_num ?? "?"}, $${probe.state.money ?? "?"}`,
  );
  const collection = new BalatroProfileReader().snapshot();
  if (collection.available) {
    console.log(
      `[ok] Collection: profile ${collection.profile}, ${collection.unlockedJokerCount}/` +
        `${collection.totalJokerCount} Jokers and ${collection.unlockedDeckCount}/${collection.totalDeckCount} decks unlocked ` +
        `(signature ${collection.signature})`,
    );
  } else {
    throw new Error(`Balatro collection could not be read: ${collection.error}`);
  }
}

async function run(config, options) {
  if (config.controlBackend === "vision") {
    console.log("Control backend: vision (forced by config)");
    return runVision(config, options);
  }

  const client = new BalatrobotClient({ baseUrl: config.balatrobotUrl, timeoutMs: config.balatrobotTimeoutMs });
  try {
    const probe = await probeBalatrobot(client);
    console.log(
      `Control backend: BalatroBot exact-state JSON-RPC ` +
        `(health=${probe.health.status}, state=${probe.state.state}, methods=${probe.methods.size})`,
    );
  } catch (error) {
    if (config.controlBackend === "balatrobot") {
      throw new Error(
        `BalatroBot backend is required but unavailable: ${error.message}. ` +
          "Start it with scripts\\start-balatrobot.ps1, then run npm run bot-doctor.",
        { cause: error },
      );
    }
    let cause = error;
    let causeCode = "";
    for (let depth = 0; cause && depth < 5; depth++) {
      causeCode ||= cause.code ?? "";
      cause = cause.cause;
    }
    if (error instanceof BalatrobotNetworkError && causeCode === "ECONNREFUSED") {
      console.warn(`[warn] No BalatroBot service is listening; falling back to the existing vision controller.`);
      return runVision(config, options);
    }
    throw new Error(
      `BalatroBot responded but its startup probe failed: ${error.message}. ` +
        "Vision fallback was not activated because that could create two simultaneous controllers.",
      { cause: error },
    );
  }

  const maxSteps = options.steps === undefined ? (config.maxSteps ?? Number.POSITIVE_INFINITY) : Number(options.steps);
  const modelStack = createModelStack(projectRoot, config);
  const exactPlannerConfig = modelStack.configs.routine;
  const localPlannerConfig = modelStack.configs.local;
  const strategicPlannerConfig = modelStack.configs.strategic;
  console.log(
    `Routine exact-state planner: ${exactPlannerConfig.provider} / ${exactPlannerConfig.model} ` +
      `(${exactPlannerConfig.apiBaseUrl})`,
  );
  console.log(
    `Local routine planner: ${localPlannerConfig.provider} / ${localPlannerConfig.model} ` +
      `(${localPlannerConfig.apiBaseUrl})`,
  );
  const planner = modelStack.routinePlanner;
  const strategicPlanner = modelStack.strategicPlanner;
  const strategicStatus = modelStack.strategicStatus;
  console.log(
    `Strategic exact-state planner: ${strategicStatus.provider} / ${strategicStatus.model} ` +
      `(runtime mode=${strategicStatus.mode}; dashboard-switchable)`,
  );
  const strategicCheckpointStore = new StrategicCheckpointStore();
  let experienceStore = null;
  try {
    const candidate = new SemanticRagStore(projectRoot, config);
    if (candidate.enabled) {
      experienceStore = candidate;
      const stats = candidate.stats();
      console.log(
        `Semantic RAG v${stats.policyVersion}: enabled ` +
          `(${candidate.size} finalized transition(s), ${stats.wonEpisodes} win/${stats.lostEpisodes} loss episode(s) in current policy)`,
      );
    } else {
      candidate.close();
    }
  } catch (error) {
    console.warn(`[warn] Semantic RAG disabled for this run: ${error.message}`);
  }
  const overlayController = options.dryRun
    ? null
    : new BalatrobotOverlayController(projectRoot, { windowTitle: config.windowTitle });
  const profileReader = new BalatroProfileReader();
  try {
    return await runBalatrobot({
      projectRoot,
      config,
      client,
      planner,
      strategicPlanner,
      strategicCheckpointStore,
      experienceStore,
      profileReader,
      overlayController,
      dryRun: options.dryRun,
      maxSteps,
    });
  } finally {
    await overlayController?.close();
    experienceStore?.close();
  }
}

async function main() {
  const { command, values } = parseCli(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const config = loadConfig(projectRoot);
  if (command === "doctor") return doctor(config);
  if (command === "bot-doctor") return botDoctor(config);
  if (command === "api-doctor") return apiDoctor(config, "balatrobot");
  if (command === "strategic-api-doctor") return apiDoctor(config, "balatrobot-strategic");
  if (command === "vision-api-doctor") return apiDoctor(config, "vision");
  if (command === "memory") return memoryStats(config);
  if (command === "screenshot") return screenshot(config, values.out);
  if (command === "click") return click(config, values);
  if (command === "run") return run(config, { dryRun: values["dry-run"], steps: values.steps });
  usage();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
