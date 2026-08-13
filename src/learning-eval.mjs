import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LearningDatabaseMetrics } from "./learning-metrics.mjs";

function list(value, fallback = []) {
  const values = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Produce a paired, counterbalanced manifest without starting Balatro or
 * calling a model. A dedicated harness can later consume startParams when
 * deterministic seed control is explicitly enabled.
 */
export function createFixedSeedEvaluationPlan({
  seeds,
  decks = ["RED"],
  stake = "WHITE",
  repeats = 1,
  variants = [
    { id: "baseline", semanticPriorEnabled: false },
    { id: "learner", semanticPriorEnabled: true },
  ],
  planId = "fixed-seed-learning-eval",
} = {}) {
  const normalizedSeeds = [...new Set((seeds ?? []).map((seed) => String(seed).trim()).filter(Boolean))];
  const normalizedDecks = [...new Set((decks ?? []).map((deck) => String(deck).trim().toUpperCase()).filter(Boolean))];
  if (!normalizedSeeds.length) throw new Error("fixed-seed evaluation requires at least one seed");
  if (!normalizedDecks.length) throw new Error("fixed-seed evaluation requires at least one deck");
  if (variants.length !== 2 || new Set(variants.map((variant) => variant.id)).size !== 2) {
    throw new Error("fixed-seed evaluation requires exactly two uniquely named variants");
  }
  const trials = [];
  let pairIndex = 0;
  for (let repeat = 1; repeat <= Math.max(1, Math.floor(finite(repeats, 1))); repeat += 1) {
    for (const deck of normalizedDecks) {
      for (const seed of normalizedSeeds) {
        pairIndex += 1;
        const pairId = `${deck}:${seed}:${repeat}`;
        const orderedVariants = pairIndex % 2 === 0 ? [...variants].reverse() : variants;
        for (const variant of orderedVariants) {
          trials.push({
            trialId: `${pairId}:${variant.id}`,
            pairId,
            repeat,
            variantId: variant.id,
            policy: { ...variant },
            startParams: { deck, stake: String(stake).toUpperCase(), seed },
          });
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    planId,
    design: "paired-counterbalanced",
    seeds: normalizedSeeds,
    decks: normalizedDecks,
    stake: String(stake).toUpperCase(),
    variants: variants.map((variant) => ({ ...variant })),
    pairs: pairIndex,
    trials,
  };
}

export function summarizeFixedSeedEvaluation(plan, results = []) {
  const byTrial = new Map(results.map((result) => [String(result.trialId), result]));
  const variantIds = plan.variants.map((variant) => variant.id);
  const discoveredPairs = new Map();
  for (const trial of plan.trials) {
    const result = byTrial.get(trial.trialId);
    if (!result) continue;
    const pair = discoveredPairs.get(trial.pairId) ?? new Map();
    pair.set(trial.variantId, result);
    discoveredPairs.set(trial.pairId, pair);
  }
  const pairs = [...discoveredPairs.entries()]
    .filter(([, pair]) => variantIds.every((variantId) => pair.has(variantId)))
    .map(([pairId, pair]) => ({ pairId, pair }));
  const metrics = ["maxAnte", "maxRound", "maxHandScore"];
  const variants = Object.fromEntries(variantIds.map((variantId) => {
    const values = pairs.map(({ pair }) => pair.get(variantId));
    return [variantId, {
      trials: values.length,
      winRate: average(values.map((value) => value.outcome === "won" ? 1 : 0)),
      ...Object.fromEntries(metrics.map((metric) => [metric, average(values.map((value) => finite(value[metric])))])),
    }];
  }));
  const [baselineId, treatmentId] = variantIds;
  const pairedDelta = {
    winRate: variants[treatmentId].winRate - variants[baselineId].winRate,
    ...Object.fromEntries(metrics.map((metric) => [
      metric,
      average(pairs.map(({ pair }) => finite(pair.get(treatmentId)[metric]) - finite(pair.get(baselineId)[metric]))),
    ])),
  };
  return {
    planId: plan.planId,
    completePairs: pairs.length,
    expectedPairs: plan.pairs,
    completionRate: plan.pairs ? pairs.length / plan.pairs : 0,
    variants,
    comparison: { baselineId, treatmentId, pairedDelta },
  };
}

function args(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    output[token.slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index] ?? true;
  }
  return output;
}

export function runLearningEvaluationCli(argv = process.argv.slice(2), projectRoot = process.cwd()) {
  const options = args(argv);
  const metrics = new LearningDatabaseMetrics(projectRoot, {
    ...(options.database ? { databasePath: path.resolve(projectRoot, String(options.database)) } : {}),
    minimumIndependentEpisodes: finite(options["minimum-episodes"], 3),
  }).refresh();
  const report = { generatedAt: new Date().toISOString(), metrics };
  if (options.seeds) {
    report.fixedSeedPlan = createFixedSeedEvaluationPlan({
      seeds: list(options.seeds),
      decks: list(options.decks, ["RED"]),
      stake: options.stake ?? "WHITE",
      repeats: finite(options.repeats, 1),
    });
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) fs.writeFileSync(path.resolve(projectRoot, String(options.output)), serialized, "utf8");
  else process.stdout.write(serialized);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLearningEvaluationCli();
}
