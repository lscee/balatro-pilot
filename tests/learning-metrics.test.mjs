import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LearningDatabaseMetrics } from "../src/learning-metrics.mjs";
import { SEMANTIC_REWARD_VERSION } from "../src/semantic-experience.mjs";

function features() {
  return {
    version: 6,
    screen: "SELECTING_HAND",
    ante: 2,
    roundNumber: 4,
    money: 10,
    deck: "RED",
    stake: "WHITE",
    blind: { type: "BIG", name: "Big Blind", target: 1200 },
    round: { score: 0, pressure: 0, handsLeft: 4, discardsLeft: 3, rerollCost: 5 },
    hand: ["H_A", "D_A", "C_7"],
    jokers: ["j_joker"],
    consumables: [],
    shop: [],
    voucherOffers: [],
    packOffers: [],
    openedPack: [],
    usedVouchers: [],
    appearedJokers: [],
    pokerHands: [],
    tokens: [],
    strategy: {
      phase: "early",
      economy: "interest",
      jokerKeys: ["j_joker"],
      pokerTargets: ["Pair:L1"],
      handShape: { rankGroups: [2, 1], suitGroups: [1, 1, 1], distinctRanks: 2, distinctSuits: 3 },
    },
  };
}

function createLearningDatabase(root) {
  const databasePath = path.join(root, "learning.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE semantic_episodes (
      episode_id TEXT PRIMARY KEY,
      outcome TEXT
    );
    CREATE TABLE semantic_experiences (
      id INTEGER PRIMARY KEY,
      episode_id TEXT NOT NULL,
      screen TEXT NOT NULL,
      features_json TEXT NOT NULL,
      action_template_json TEXT NOT NULL,
      policy_version INTEGER NOT NULL
    );
    CREATE TABLE semantic_reward_labels (
      experience_id INTEGER NOT NULL,
      reward_version INTEGER NOT NULL,
      terminal_outcome TEXT NOT NULL,
      return_reward REAL NOT NULL,
      compatibility TEXT NOT NULL
    );
  `);
  const insertEpisode = database.prepare("INSERT INTO semantic_episodes VALUES (?, ?)");
  const insertExperience = database.prepare("INSERT INTO semantic_experiences VALUES (?, ?, ?, ?, ?, ?)");
  const insertLabel = database.prepare("INSERT INTO semantic_reward_labels VALUES (?, ?, ?, ?, ?)");
  const action = JSON.stringify({ method: "play", cards: ["H_A", "D_A"] });
  const policies = [1, 1, 2, 2, 6, 6, 6];
  for (let index = 0; index < 7; index += 1) {
    const id = index + 1;
    const outcome = id === 6 ? "lost" : "won";
    insertEpisode.run(`episode-${id}`, outcome);
    insertExperience.run(
      id,
      `episode-${id}`,
      "SELECTING_HAND",
      JSON.stringify(features()),
      action,
      policies[index],
    );
    if (id === 7) continue;
    insertLabel.run(
      id,
      SEMANTIC_REWARD_VERSION,
      outcome,
      outcome === "won" ? 4 : -4,
      id <= 3 ? "semantic" : "exact",
    );
  }
  database.close();
  return databasePath;
}

test("LearningDatabaseMetrics audits reward migration and cross-policy abstract prior coverage read-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-learning-metrics-"));
  try {
    const databasePath = createLearningDatabase(root);
    const metrics = new LearningDatabaseMetrics(root, { databasePath, minimumIndependentEpisodes: 3 });
    const snapshot = metrics.refresh();

    assert.equal(snapshot.available, true);
    assert.equal(snapshot.rewardVersion, SEMANTIC_REWARD_VERSION);
    assert.equal(snapshot.rewardIntegrity.eligibleTransitions, 7);
    assert.equal(snapshot.rewardIntegrity.labeledTransitions, 6);
    assert.equal(snapshot.rewardIntegrity.missingLabels, 1);
    assert.equal(snapshot.rewardIntegrity.invalidLabels, 0);
    assert.equal(snapshot.rewardIntegrity.integrityRate, 6 / 7);
    assert.equal(snapshot.migrationCoverage.coverageRate, 6 / 7);
    assert.equal(snapshot.migrationCoverage.compatibleCoverageRate, 6 / 7);
    assert.deepEqual(
      snapshot.migrationCoverage.byPolicy.map((entry) => [entry.policyVersion, entry.transitions, entry.labeledTransitions]),
      [[1, 2, 2], [2, 2, 2], [6, 3, 2]],
    );
    assert.equal(snapshot.abstractCoverage.uniqueBuckets, 1);
    assert.equal(snapshot.abstractCoverage.supportedBuckets, 1);
    assert.equal(snapshot.abstractCoverage.uniqueActionGroups, 1);
    assert.equal(snapshot.abstractCoverage.supportedActionGroups, 1);
    assert.equal(snapshot.abstractCoverage.priorApplicableGroups, 1);
    assert.equal(snapshot.abstractCoverage.mixedOutcomeGroups, 1);
    assert.equal(snapshot.abstractCoverage.winningEpisodeVotes, 5);
    assert.equal(snapshot.abstractCoverage.losingEpisodeVotes, 1);

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM semantic_reward_labels").get().count, 6);
    verify.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearningDatabaseMetrics includes linked interrupted history and counts its credited game only once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-learning-linked-"));
  try {
    const databasePath = createLearningDatabase(root);
    const database = new DatabaseSync(databasePath);
    database.exec("ALTER TABLE semantic_reward_labels ADD COLUMN credit_episode_id TEXT NOT NULL DEFAULT ''");
    database.prepare("INSERT INTO semantic_episodes VALUES (?, ?)").run("front-segment", "interrupted");
    database.prepare("INSERT INTO semantic_experiences VALUES (?, ?, ?, ?, ?, ?)").run(
      8,
      "front-segment",
      "SELECTING_HAND",
      JSON.stringify(features()),
      JSON.stringify({ method: "play", cards: ["H_A", "D_A"] }),
      1,
    );
    database.prepare(`
      INSERT INTO semantic_reward_labels (
        experience_id, reward_version, terminal_outcome, return_reward, compatibility, credit_episode_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(8, SEMANTIC_REWARD_VERSION, "won", 4, "semantic", "episode-1");
    database.close();

    const snapshot = new LearningDatabaseMetrics(root, {
      databasePath,
      minimumIndependentEpisodes: 3,
    }).refresh();
    assert.equal(snapshot.rewardIntegrity.eligibleTransitions, 8);
    assert.equal(snapshot.rewardIntegrity.labeledTransitions, 7);
    assert.equal(snapshot.rewardIntegrity.missingLabels, 1);
    assert.equal(snapshot.rewardIntegrity.invalidLabels, 0);
    assert.equal(snapshot.migrationCoverage.linkedSegments, 1);
    assert.equal(snapshot.migrationCoverage.linkedTransitions, 1);
    assert.equal(snapshot.migrationCoverage.byPolicy[0].transitions, 3);
    assert.equal(snapshot.abstractCoverage.compatibleTransitions, 7);
    assert.equal(snapshot.abstractCoverage.independentCreditEpisodes, 6);
    // episode-1 and front-segment are one real run. The extra front transition
    // enriches episode-1's vote but must not inflate independent support.
    assert.equal(snapshot.abstractCoverage.winningEpisodeVotes, 5);
    assert.equal(snapshot.abstractCoverage.losingEpisodeVotes, 1);

    const strict = new LearningDatabaseMetrics(root, {
      databasePath,
      minimumIndependentEpisodes: 7,
    }).refresh();
    assert.equal(strict.abstractCoverage.supportedBuckets, 0);
    assert.equal(strict.abstractCoverage.supportedActionGroups, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearningDatabaseMetrics cache stamp includes the SQLite shared-memory sidecar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-learning-shm-stamp-"));
  try {
    const databasePath = createLearningDatabase(root);
    const metrics = new LearningDatabaseMetrics(root, { databasePath });
    assert.equal(metrics.refresh().available, true);
    // A sentinel makes cache reuse observable without relying on filesystem
    // timestamp resolution or mutating the learning database itself.
    metrics.cachedSnapshot = { sentinel: true };
    fs.writeFileSync(`${databasePath}-shm`, "new shared-memory generation", "utf8");
    const refreshed = metrics.refresh();
    assert.equal(refreshed.sentinel, undefined);
    assert.equal(refreshed.available, true);
    assert.equal(refreshed.rewardIntegrity.eligibleTransitions, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearningDatabaseMetrics reports a missing database without creating it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balatro-learning-missing-"));
  try {
    const databasePath = path.join(root, "absent.sqlite");
    const snapshot = new LearningDatabaseMetrics(root, { databasePath }).refresh();
    assert.equal(snapshot.available, false);
    assert.equal(fs.existsSync(databasePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
