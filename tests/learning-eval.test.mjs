import test from "node:test";
import assert from "node:assert/strict";

import {
  createFixedSeedEvaluationPlan,
  summarizeFixedSeedEvaluation,
} from "../src/learning-eval.mjs";

test("fixed-seed learning eval creates paired and counterbalanced trials", () => {
  const plan = createFixedSeedEvaluationPlan({ seeds: ["ABC", "XYZ"], decks: ["RED"], repeats: 2 });
  assert.equal(plan.pairs, 4);
  assert.equal(plan.trials.length, 8);
  for (const pairId of new Set(plan.trials.map((trial) => trial.pairId))) {
    const pair = plan.trials.filter((trial) => trial.pairId === pairId);
    assert.deepEqual(new Set(pair.map((trial) => trial.variantId)), new Set(["baseline", "learner"]));
    assert.deepEqual(pair[0].startParams, pair[1].startParams);
  }
  assert.deepEqual(plan.trials.slice(0, 4).map((trial) => trial.variantId), [
    "baseline", "learner", "learner", "baseline",
  ]);
});

test("fixed-seed learning eval reports only complete paired deltas", () => {
  const plan = createFixedSeedEvaluationPlan({ seeds: ["ABC", "XYZ"] });
  const result = summarizeFixedSeedEvaluation(plan, [
    { trialId: "RED:ABC:1:baseline", outcome: "lost", maxAnte: 3, maxRound: 8, maxHandScore: 1_000 },
    { trialId: "RED:ABC:1:learner", outcome: "won", maxAnte: 8, maxRound: 24, maxHandScore: 10_000 },
    { trialId: "RED:XYZ:1:baseline", outcome: "lost", maxAnte: 4, maxRound: 11, maxHandScore: 2_000 },
  ]);
  assert.equal(result.completePairs, 1);
  assert.equal(result.completionRate, 0.5);
  assert.equal(result.comparison.pairedDelta.winRate, 1);
  assert.equal(result.comparison.pairedDelta.maxAnte, 5);
  assert.equal(result.comparison.pairedDelta.maxHandScore, 9_000);
});
