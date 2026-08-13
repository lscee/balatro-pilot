import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  SEMANTIC_REWARD_VERSION,
  semanticNormalizeFeatures,
} from "./semantic-experience.mjs";
import {
  semanticDecisionKey,
  semanticHistoricalActionKey,
} from "./semantic-prior.mjs";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function emptySnapshot(databasePath, error = null) {
  return {
    available: false,
    databasePath,
    rewardVersion: SEMANTIC_REWARD_VERSION,
    error,
    rewardIntegrity: {
      eligibleTransitions: 0,
      labeledTransitions: 0,
      missingLabels: 0,
      exactLabels: 0,
      semanticLabels: 0,
      incompatibleLabels: 0,
      terminalMismatches: 0,
      correctedLegacyTransitions: 0,
      signViolations: 0,
      invalidLabels: 0,
      integrityRate: 0,
    },
    migrationCoverage: {
      rawTransitions: 0,
      currentRewardLabels: 0,
      compatibleLabels: 0,
      incompatibleLabels: 0,
      linkedSegments: 0,
      linkedTransitions: 0,
      coverageRate: 0,
      compatibleCoverageRate: 0,
      byPolicy: [],
    },
    abstractCoverage: {
      compatibleTransitions: 0,
      uniqueBuckets: 0,
      supportedBuckets: 0,
      supportedTransitions: 0,
      supportedTransitionRate: 0,
      uniqueActionGroups: 0,
      supportedActionGroups: 0,
      priorApplicableGroups: 0,
      mixedOutcomeGroups: 0,
      winningEpisodeVotes: 0,
      losingEpisodeVotes: 0,
      independentCreditEpisodes: 0,
      minimumIndependentEpisodes: 3,
      screens: 0,
    },
  };
}

/**
 * Read-only audit of the durable learner. It is deliberately separate from
 * SemanticRagStore so dashboard refreshes can never migrate or mutate data.
 */
export class LearningDatabaseMetrics {
  constructor(projectRoot, {
    databasePath = path.join(projectRoot, "data", "semantic-experience.sqlite"),
    minimumIndependentEpisodes = 3,
    confidenceZ = 1.28,
  } = {}) {
    this.databasePath = path.resolve(databasePath);
    this.minimumIndependentEpisodes = Math.max(1, Number(minimumIndependentEpisodes) || 3);
    this.confidenceZ = Math.min(3, Math.max(0.5, Number(confidenceZ) || 1.28));
    this.cachedStamp = null;
    this.cachedSnapshot = emptySnapshot(this.databasePath);
  }

  refresh() {
    const stamp = [
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
    ].map(fileStamp).join("|");
    if (stamp === this.cachedStamp) return this.cachedSnapshot;
    this.cachedStamp = stamp;
    if (!fs.existsSync(this.databasePath)) {
      this.cachedSnapshot = emptySnapshot(this.databasePath);
      return this.cachedSnapshot;
    }

    let database;
    try {
      database = new DatabaseSync(this.databasePath, { readOnly: true });
      const tables = new Set(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all().map((row) => String(row.name)));
      if (!["semantic_episodes", "semantic_experiences", "semantic_reward_labels"].every((name) => tables.has(name))) {
        throw new Error("semantic learning schema is incomplete");
      }
      const rewardLabelColumns = new Set(database.prepare(
        "PRAGMA table_info(semantic_reward_labels)",
      ).all().map((column) => String(column.name)));
      // credit_episode_id was added after the original reward-label schema.
      // Keeping this query compatible lets the dashboard inspect an old DB
      // before the writer has had a chance to migrate its schema.
      const creditEpisodeExpression = rewardLabelColumns.has("credit_episode_id")
        ? "NULLIF(labels.credit_episode_id, '')"
        : "NULL";
      const rows = database.prepare(`
        SELECT experiences.episode_id AS episodeId,
               COALESCE(${creditEpisodeExpression}, experiences.episode_id) AS creditEpisodeId,
               experiences.screen,
               experiences.features_json AS featuresJson,
               experiences.action_template_json AS actionTemplateJson,
               experiences.policy_version AS policyVersion,
               episodes.outcome AS episodeOutcome,
               credited_episodes.outcome AS creditEpisodeOutcome,
               labels.terminal_outcome AS labelOutcome,
               labels.return_reward AS returnReward,
               labels.compatibility
        FROM semantic_experiences experiences
        JOIN semantic_episodes episodes ON episodes.episode_id = experiences.episode_id
        LEFT JOIN semantic_reward_labels labels
          ON labels.experience_id = experiences.id AND labels.reward_version = ?
        LEFT JOIN semantic_episodes credited_episodes
          ON credited_episodes.episode_id = ${creditEpisodeExpression}
        WHERE episodes.outcome IN ('won', 'lost') OR (
          episodes.outcome = 'interrupted'
          AND ${creditEpisodeExpression} <> experiences.episode_id
          AND credited_episodes.outcome IN ('won', 'lost')
          AND labels.terminal_outcome IN ('won', 'lost')
        )
      `).all(SEMANTIC_REWARD_VERSION);

      let labeledTransitions = 0;
      let exactLabels = 0;
      let semanticLabels = 0;
      let incompatibleLabels = 0;
      let terminalMismatches = 0;
      let correctedLegacyTransitions = 0;
      let signViolations = 0;
      let compatibleTransitions = 0;
      const buckets = new Map();
      const actionGroups = new Map();
      const policies = new Map();
      const screens = new Set();
      const creditEpisodes = new Set();
      const linkedSegments = new Set();
      let linkedTransitions = 0;

      for (const row of rows) {
        const labeled = row.labelOutcome === "won" || row.labelOutcome === "lost";
        const episodeId = String(row.episodeId);
        const creditEpisodeId = String(row.creditEpisodeId || row.episodeId);
        const linked = creditEpisodeId !== episodeId;
        if (linked) {
          linkedSegments.add(episodeId);
          linkedTransitions += 1;
        }
        const policyVersion = finite(row.policyVersion, 0);
        const policy = policies.get(policyVersion) ?? {
          policyVersion,
          transitions: 0,
          labeledTransitions: 0,
          exactLabels: 0,
          semanticLabels: 0,
          incompatibleLabels: 0,
        };
        policy.transitions += 1;
        policies.set(policyVersion, policy);
        if (!labeled) continue;
        policy.labeledTransitions += 1;
        labeledTransitions += 1;
        if (row.compatibility === "exact") {
          exactLabels += 1;
          policy.exactLabels += 1;
        } else if (row.compatibility === "semantic") {
          semanticLabels += 1;
          policy.semanticLabels += 1;
        } else {
          incompatibleLabels += 1;
          policy.incompatibleLabels += 1;
        }
        const creditedOutcome = linked ? row.creditEpisodeOutcome : row.episodeOutcome;
        if (row.labelOutcome !== creditedOutcome) {
          terminalMismatches += 1;
          // Old policy versions could label GAME_OVER + G.GAME.won as a win
          // even when the Ante-8 Boss target was missed. Reward migration
          // deliberately corrects those labels without mutating raw history.
          if (creditedOutcome === "won" && row.labelOutcome === "lost") correctedLegacyTransitions += 1;
        }
        const reward = finite(row.returnReward, 0);
        if ((row.labelOutcome === "lost" && reward > 0) || (row.labelOutcome === "won" && reward < 0)) {
          signViolations += 1;
        }
        if (row.compatibility !== "exact" && row.compatibility !== "semantic") continue;
        const features = semanticNormalizeFeatures(parseJson(row.featuresJson), { canonicalVersion: true });
        if (!features) continue;
        let bucketKey;
        let actionKey;
        try {
          bucketKey = semanticDecisionKey(features);
          actionKey = semanticHistoricalActionKey({
            features,
            actionTemplate: parseJson(row.actionTemplateJson),
          });
        } catch {
          continue;
        }
        compatibleTransitions += 1;
        creditEpisodes.add(creditEpisodeId);
        screens.add(String(row.screen ?? features.screen ?? "unknown"));
        const bucket = buckets.get(bucketKey) ?? { transitions: 0, episodes: new Set() };
        bucket.transitions += 1;
        // A resumed/linked front segment and its terminal successor are one
        // real game, not two independent votes. Crediting both by their raw
        // trajectory IDs would falsely make the prior look better supported.
        bucket.episodes.add(creditEpisodeId);
        buckets.set(bucketKey, bucket);

        const groupKey = `${bucketKey}\u0000${actionKey}`;
        const group = actionGroups.get(groupKey) ?? {
          transitions: 0,
          episodes: new Map(),
        };
        group.transitions += 1;
        const vote = group.episodes.get(creditEpisodeId) ?? {
          outcome: String(row.labelOutcome),
          returnSum: 0,
          samples: 0,
        };
        vote.returnSum += Math.tanh(reward / 4);
        vote.samples += 1;
        group.episodes.set(creditEpisodeId, vote);
        actionGroups.set(groupKey, group);
      }

      const supported = [...buckets.values()].filter(
        (bucket) => bucket.episodes.size >= this.minimumIndependentEpisodes,
      );
      const supportedTransitions = supported.reduce((sum, bucket) => sum + bucket.transitions, 0);
      const supportedActionGroups = [...actionGroups.values()].filter(
        (group) => group.episodes.size >= this.minimumIndependentEpisodes,
      );
      let priorApplicableGroups = 0;
      let mixedOutcomeGroups = 0;
      let winningEpisodeVotes = 0;
      let losingEpisodeVotes = 0;
      for (const group of supportedActionGroups) {
        const votes = [...group.episodes.values()].map((vote) => ({
          outcome: vote.outcome,
          value: vote.returnSum / Math.max(1, vote.samples),
        }));
        const wins = votes.filter((vote) => vote.outcome === "won").length;
        const losses = votes.filter((vote) => vote.outcome === "lost").length;
        winningEpisodeVotes += wins;
        losingEpisodeVotes += losses;
        if (wins && losses) mixedOutcomeGroups += 1;
        const mean = average(votes.map((vote) => vote.value));
        const variance = average(votes.map((vote) => (vote.value - mean) ** 2));
        const radius = this.confidenceZ * Math.sqrt((variance + 0.25) / votes.length);
        if (mean - radius > 0 || mean + radius < 0) priorApplicableGroups += 1;
      }
      const missingLabels = Math.max(0, rows.length - labeledTransitions);
      const invalidLabels = rows.filter((row) => {
        const labeled = row.labelOutcome === "won" || row.labelOutcome === "lost";
        if (!labeled) return false;
        const reward = finite(row.returnReward, 0);
        const linked = String(row.creditEpisodeId || row.episodeId) !== String(row.episodeId);
        const creditedOutcome = linked ? row.creditEpisodeOutcome : row.episodeOutcome;
        const unexplainedOutcomeMismatch = row.labelOutcome !== creditedOutcome &&
          !(creditedOutcome === "won" && row.labelOutcome === "lost");
        return unexplainedOutcomeMismatch ||
          (row.labelOutcome === "lost" && reward > 0) ||
          (row.labelOutcome === "won" && reward < 0);
      }).length;
      const compatibleLabels = exactLabels + semanticLabels;
      this.cachedSnapshot = {
        available: true,
        databasePath: this.databasePath,
        rewardVersion: SEMANTIC_REWARD_VERSION,
        error: null,
        rewardIntegrity: {
          eligibleTransitions: rows.length,
          labeledTransitions,
          missingLabels,
          exactLabels,
          semanticLabels,
          incompatibleLabels,
          terminalMismatches,
          correctedLegacyTransitions,
          signViolations,
          invalidLabels,
          integrityRate: ratio(labeledTransitions - invalidLabels, rows.length),
        },
        migrationCoverage: {
          rawTransitions: rows.length,
          currentRewardLabels: labeledTransitions,
          compatibleLabels,
          incompatibleLabels,
          linkedSegments: linkedSegments.size,
          linkedTransitions,
          coverageRate: ratio(labeledTransitions, rows.length),
          compatibleCoverageRate: ratio(compatibleLabels, rows.length),
          byPolicy: [...policies.values()]
            .map((policy) => ({
              ...policy,
              coverageRate: ratio(policy.labeledTransitions, policy.transitions),
              compatibleCoverageRate: ratio(
                policy.exactLabels + policy.semanticLabels,
                policy.transitions,
              ),
            }))
            .sort((left, right) => left.policyVersion - right.policyVersion),
        },
        abstractCoverage: {
          compatibleTransitions,
          uniqueBuckets: buckets.size,
          supportedBuckets: supported.length,
          supportedTransitions,
          supportedTransitionRate: ratio(supportedTransitions, compatibleTransitions),
          uniqueActionGroups: actionGroups.size,
          supportedActionGroups: supportedActionGroups.length,
          priorApplicableGroups,
          mixedOutcomeGroups,
          winningEpisodeVotes,
          losingEpisodeVotes,
          independentCreditEpisodes: creditEpisodes.size,
          minimumIndependentEpisodes: this.minimumIndependentEpisodes,
          screens: screens.size,
        },
      };
    } catch (error) {
      this.cachedSnapshot = emptySnapshot(this.databasePath, error.message);
    } finally {
      database?.close();
    }
    return this.cachedSnapshot;
  }
}
