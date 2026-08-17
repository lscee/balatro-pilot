import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_REWARD_VERSION,
  semanticActionKey,
  semanticActionSummary,
  semanticActionTemplate,
  semanticDiscountedReturns,
  semanticExactFingerprint,
  semanticHighScoreTier,
  semanticPlayedHandScore,
  semanticPlayedHandScoreFromFeatures,
  semanticFeatureCompatibility,
  semanticNormalizeFeatures,
  semanticReplayFingerprint,
  semanticStateBucket,
  semanticStateFeatures,
  semanticStateSimilarity,
  semanticStakeRuleCompatibility,
  semanticStateText,
  semanticTransitionReward,
  semanticTransitionRewardFromFeatures,
} from "./semantic-experience.mjs";
import { semanticDecisionKey, semanticHistoricalActionKey } from "./semantic-prior.mjs";

const RAW_TRAJECTORY_SCHEMA_VERSION = 1;
const SEGMENT_LINK_MAX_GAP_MS = 2 * 60 * 60 * 1_000;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sourceWeight(source) {
  if (
    source === "balatrobot_model" ||
    source === "balatrobot_model_strategic" ||
    source === "balatrobot_checkpoint_sequence" ||
    source === "semantic_fast_path"
  ) return 1;
  if (source === "balatrobot_validation_fallback") return 0.5;
  if (source === "balatrobot_rpc_recovery") return 0.35;
  if (source === "balatrobot_planner_fallback") return 0.2;
  return 0.4;
}

function trustedSource(source) {
  return source === "balatrobot_model" ||
    source === "balatrobot_model_strategic" ||
    source === "balatrobot_checkpoint_sequence" ||
    source === "semantic_fast_path";
}

function durablePlanText(plan) {
  const runPlan = plan?.runPlan;
  if (runPlan && typeof runPlan === "object" && !Array.isArray(runPlan)) {
    const fields = [
      "metaAssessment",
      "buildGoal",
      "synergies",
      "economyPolicy",
      "shopPriorities",
      "pivotPolicy",
      "handPolicy",
      "nextMilestone",
      "revisionReason",
    ];
    const compact = Object.fromEntries(fields
      .map((field) => [field, String(runPlan[field] ?? "").trim()])
      .filter(([, value]) => value));
    if (Object.keys(compact).length) return JSON.stringify(compact);
  }
  return String(plan?.memory ?? "");
}

function progression(features) {
  return [Number(features?.ante) || 0, Number(features?.roundNumber) || 0];
}

function progressionNotAfter(left, right) {
  const [leftAnte, leftRound] = progression(left);
  const [rightAnte, rightRound] = progression(right);
  return leftAnte < rightAnte || (leftAnte === rightAnte && leftRound <= rightRound);
}

function baseJokerSignature(features) {
  return (features?.jokers ?? []).map((value) => String(value)).sort().join("\u0000");
}

function identityListSignature(values) {
  return (values ?? []).map((value) => String(value)).sort().join("\u0000");
}

function numericObjectSubset(subset, superset) {
  for (const [key, value] of Object.entries(subset ?? {})) {
    if ((Number(value) || 0) > (Number(superset?.[key]) || 0)) return false;
  }
  return true;
}

function sameNumericTuple(left, right) {
  return (left ?? []).length === (right ?? []).length &&
    (left ?? []).every((value, index) => (Number(value) || 0) === (Number(right?.[index]) || 0));
}

function pokerLevelSignature(features) {
  return (features?.pokerHands ?? [])
    // A restart can expose the last scored hand with `played` already
    // incremented on one side of the boundary but not the other.  Build
    // strength is unchanged, so compare the durable hand values and ignore
    // that one-frame counter.
    .map((hand) => [
      String(hand?.name ?? "?"),
      Number(hand?.level) || 0,
      Number(hand?.chips) || 0,
      Number(hand?.mult) || 0,
    ].join(":"))
    .sort()
    .join("\u0000");
}

function remainingDeckBoundaryCompatible(last, first) {
  const left = last?.remainingDeck ?? {};
  const right = first?.remainingDeck ?? {};
  const sameScreen = last?.screen === first?.screen;
  if (sameScreen) {
    return Number(left.count) === Number(right.count) &&
      JSON.stringify(left.rankCounts ?? {}) === JSON.stringify(right.rankCounts ?? {}) &&
      JSON.stringify(left.suitCounts ?? {}) === JSON.stringify(right.suitCounts ?? {}) &&
      JSON.stringify(left.modifiers ?? {}) === JSON.stringify(right.modifiers ?? {});
  }
  // On ROUND_EVAL the mod reports the reset/full deck, while the first
  // SELECTING_HAND frame already excludes every card drawn so far.  The latter
  // must therefore be a multiset subset, not an unrelated deck.
  if (last?.screen === "ROUND_EVAL" && first?.screen === "SELECTING_HAND") {
    return (Number(right.count) || 0) <= (Number(left.count) || 0) &&
      numericObjectSubset(right.rankCounts, left.rankCounts) &&
      numericObjectSubset(right.suitCounts, left.suitCounts) &&
      numericObjectSubset(right.modifiers, left.modifiers);
  }
  return false;
}

function strictBoundarySignatureCompatible(last, first) {
  if (!last || !first) return false;
  if (!(last.screen === first.screen || (last.screen === "ROUND_EVAL" && first.screen === "SELECTING_HAND"))) {
    return false;
  }
  if ((Number(last.money) || 0) !== (Number(first.money) || 0)) return false;
  if (!sameNumericTuple(last.slots?.jokers, first.slots?.jokers)) return false;
  if (!sameNumericTuple(last.slots?.consumables, first.slots?.consumables)) return false;
  if (baseJokerSignature(last) !== baseJokerSignature(first)) return false;
  if (identityListSignature(last.consumables) !== identityListSignature(first.consumables)) return false;
  if (identityListSignature(last.usedVouchers) !== identityListSignature(first.usedVouchers)) return false;
  // appearedJokers is observation history, not game state. A controller
  // restart can reconstruct all durable state yet miss one prior shop offer;
  // requiring exact equality would reject the verified 5964A4PN continuation.
  if (pokerLevelSignature(last) !== pokerLevelSignature(first)) return false;
  const leftPool = String(last.collectionSignature ?? "");
  const rightPool = String(first.collectionSignature ?? "");
  if (leftPool && rightPool && leftPool !== rightPool) return false;
  return remainingDeckBoundaryCompatible(last, first);
}

function segmentBoundaryCompatible(segment, successor) {
  const last = segment.lastFeatures;
  const first = successor.firstFeatures;
  if (!last || !first) return false;
  const lastTime = Date.parse(segment.endedAt ?? "");
  const nextTime = Date.parse(successor.startedAt ?? "");
  if (!Number.isFinite(lastTime) || !Number.isFinite(nextTime) || nextTime < lastTime) return false;
  if (nextTime - lastTime > SEGMENT_LINK_MAX_GAP_MS) return false;
  const [lastAnte, lastRound] = progression(last);
  const [nextAnte, nextRound] = progression(first);
  // Ante-1 seeds are often deliberately replayed and are therefore ambiguous.
  if (lastAnte <= 1) return false;
  if (!progressionNotAfter(last, first)) return false;
  if (nextAnte - lastAnte > 1 || nextRound - lastRound > 1) return false;
  const exactBoundary = segment.lastExactFingerprint && successor.firstExactFingerprint &&
    segment.lastExactFingerprint === successor.firstExactFingerprint;
  const replayBoundary = segment.lastReplayFingerprint && successor.firstReplayFingerprint &&
    segment.lastReplayFingerprint === successor.firstReplayFingerprint;
  return Boolean(exactBoundary || replayBoundary || strictBoundarySignatureCompatible(last, first));
}

function hotEntry(row) {
  const rawFeatures = parseJson(row.features_json, null);
  const features = semanticNormalizeFeatures(rawFeatures, { canonicalVersion: true }) ?? {};
  return {
    id: Number(row.id),
    episodeId: row.credit_episode_id || row.episode_id,
    trajectoryEpisodeId: row.episode_id,
    screen: row.screen,
    stateFingerprint: row.state_fingerprint,
    replayFingerprint: Object.keys(features).length ? semanticReplayFingerprint(features) : row.replay_fingerprint,
    stateBucket: row.state_bucket,
    stateText: row.state_text,
    features,
    actionKey: row.action_key,
    actionMethod: row.action_method,
    action: parseJson(row.action_json, null),
    actionTemplate: parseJson(row.action_template_json, {}),
    actionSummary: row.action_summary,
    source: row.policy_source,
    strategy: row.strategy,
    memory: row.memory,
    immediateReward: Number(row.immediate_reward) || 0,
    returnReward: Number(row.return_reward) || 0,
    outcome: row.terminal_outcome,
    nextStateText: row.next_state_text,
    compatibility: row.reward_compatibility,
    trajectoryPolicyVersion: Number(row.trajectory_policy_version) || 0,
    rewardVersion: Number(row.reward_version) || 0,
  };
}

export class SemanticRagStore {
  constructor(projectRoot, config) {
    this.enabled = config.semanticRagEnabled;
    this.topK = config.semanticRagTopK;
    this.hotLimit = config.semanticRagHotLimit;
    this.searchBudgetMs = config.semanticRagSearchBudgetMs;
    this.minimumSimilarity = config.semanticRagMinimumSimilarity;
    this.maxContextChars = config.semanticRagMaxContextChars;
    this.minimumSamples = config.semanticRagMinimumSamples;
    this.semanticFastPathEnabled = config.semanticFastPathEnabled;
    this.semanticFastPathMinimumSamples = config.semanticFastPathMinimumSamples;
    this.semanticFastPathMinimumWinningEpisodes = config.semanticFastPathMinimumWinningEpisodes ?? 3;
    this.semanticFastPathMinimumAverageReturn = config.semanticFastPathMinimumAverageReturn;
    this.semanticFastPathMinimumPositiveRate = config.semanticFastPathMinimumPositiveRate;
    this.discount = config.semanticEpisodeDiscount;
    this.db = null;
    this.hot = [];
    this.cache = new Map();
    this.cacheLimit = 64;
    this.retrievalStats = { requests: 0, hits: 0, injected: 0, fastPaths: 0 };
    if (!this.enabled) return;

    const databasePath = path.resolve(projectRoot, config.semanticRagDatabasePath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS semantic_episodes (
        episode_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        seed TEXT,
        deck TEXT,
        stake TEXT,
        outcome TEXT,
        max_ante INTEGER NOT NULL DEFAULT 0,
        max_round INTEGER NOT NULL DEFAULT 0,
        transition_count INTEGER NOT NULL DEFAULT 0,
        policy_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS semantic_experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        screen TEXT NOT NULL,
        state_fingerprint TEXT NOT NULL,
        replay_fingerprint TEXT NOT NULL,
        state_bucket TEXT NOT NULL,
        state_text TEXT NOT NULL,
        features_json TEXT NOT NULL,
        action_key TEXT NOT NULL,
        action_method TEXT NOT NULL,
        action_json TEXT NOT NULL,
        action_template_json TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        policy_source TEXT NOT NULL,
        strategy TEXT NOT NULL,
        memory TEXT NOT NULL,
        immediate_reward REAL NOT NULL,
        return_reward REAL,
        next_state_fingerprint TEXT NOT NULL,
        next_replay_fingerprint TEXT NOT NULL,
        next_state_text TEXT NOT NULL,
        next_features_json TEXT NOT NULL,
        terminal_outcome TEXT,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        policy_version INTEGER NOT NULL,
        FOREIGN KEY(episode_id) REFERENCES semantic_episodes(episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_screen ON semantic_experiences(screen, id DESC);
      CREATE INDEX IF NOT EXISTS idx_semantic_replay ON semantic_experiences(replay_fingerprint, action_key);
      CREATE INDEX IF NOT EXISTS idx_semantic_bucket ON semantic_experiences(state_bucket, action_key);
      CREATE INDEX IF NOT EXISTS idx_semantic_episode ON semantic_experiences(episode_id, id);
      CREATE INDEX IF NOT EXISTS idx_semantic_return ON semantic_experiences(return_reward, id DESC);
      CREATE TABLE IF NOT EXISTS semantic_reward_labels (
        experience_id INTEGER NOT NULL,
        reward_version INTEGER NOT NULL,
        immediate_reward REAL NOT NULL,
        return_reward REAL NOT NULL,
        terminal_outcome TEXT NOT NULL,
        compatibility TEXT NOT NULL,
        credit_episode_id TEXT NOT NULL DEFAULT '',
        relabeled_at TEXT NOT NULL,
        PRIMARY KEY(experience_id, reward_version),
        FOREIGN KEY(experience_id) REFERENCES semantic_experiences(id)
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_reward_hot
        ON semantic_reward_labels(reward_version, terminal_outcome, experience_id DESC);
      CREATE TABLE IF NOT EXISTS semantic_reward_migrations (
        reward_version INTEGER PRIMARY KEY,
        reward_signature TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        episodes INTEGER NOT NULL,
        transitions INTEGER NOT NULL,
        exact_transitions INTEGER NOT NULL,
        semantic_transitions INTEGER NOT NULL,
        incompatible_transitions INTEGER NOT NULL,
        corrected_outcomes INTEGER NOT NULL DEFAULT 0,
        linked_segments INTEGER NOT NULL DEFAULT 0,
        linked_transitions INTEGER NOT NULL DEFAULT 0
      );
    `);
    const episodeColumns = new Set(
      this.db.prepare("PRAGMA table_info(semantic_episodes)").all().map((column) => String(column.name)),
    );
    if (!episodeColumns.has("max_hand_score")) {
      this.db.exec("ALTER TABLE semantic_episodes ADD COLUMN max_hand_score REAL NOT NULL DEFAULT 0");
    }
    const migrationColumns = new Set(
      this.db.prepare("PRAGMA table_info(semantic_reward_migrations)").all().map((column) => String(column.name)),
    );
    if (!migrationColumns.has("reward_signature")) {
      this.db.exec("ALTER TABLE semantic_reward_migrations ADD COLUMN reward_signature TEXT NOT NULL DEFAULT ''");
    }
    if (!migrationColumns.has("corrected_outcomes")) {
      this.db.exec("ALTER TABLE semantic_reward_migrations ADD COLUMN corrected_outcomes INTEGER NOT NULL DEFAULT 0");
    }
    if (!migrationColumns.has("linked_segments")) {
      this.db.exec("ALTER TABLE semantic_reward_migrations ADD COLUMN linked_segments INTEGER NOT NULL DEFAULT 0");
    }
    if (!migrationColumns.has("linked_transitions")) {
      this.db.exec("ALTER TABLE semantic_reward_migrations ADD COLUMN linked_transitions INTEGER NOT NULL DEFAULT 0");
    }
    const labelColumns = new Set(
      this.db.prepare("PRAGMA table_info(semantic_reward_labels)").all().map((column) => String(column.name)),
    );
    if (!labelColumns.has("credit_episode_id")) {
      this.db.exec("ALTER TABLE semantic_reward_labels ADD COLUMN credit_episode_id TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_reward_credit
        ON semantic_reward_labels(reward_version, credit_episode_id, experience_id)
    `);
    this.rewardMigration = this.migrateRewards();
    this.#loadHot();
  }

  #loadHot() {
    if (!this.db) return;
    const rows = this.db.prepare(`
      SELECT e.id, e.episode_id, e.screen, e.state_fingerprint, e.replay_fingerprint, e.state_bucket, e.state_text, e.features_json,
             action_key, action_method, action_json, action_template_json, action_summary, policy_source,
             strategy, memory, labels.immediate_reward, labels.return_reward, labels.terminal_outcome, next_state_text,
             labels.compatibility AS reward_compatibility, labels.credit_episode_id,
             e.policy_version AS trajectory_policy_version,
             labels.reward_version
      FROM semantic_experiences e
      JOIN semantic_reward_labels labels ON labels.experience_id = e.id
      WHERE labels.reward_version = ?
        AND labels.terminal_outcome IN ('won', 'lost')
        AND labels.compatibility IN ('exact', 'semantic')
      ORDER BY e.id DESC
      LIMIT ?
    `).all(SEMANTIC_REWARD_VERSION, this.hotLimit);
    this.hot = rows.map(hotEntry);
    this.cache.clear();
  }

  get size() {
    return this.hot.length;
  }

  migrateRewards({ force = false } = {}) {
    if (!this.db) return { enabled: false, rewardVersion: SEMANTIC_REWARD_VERSION };
    const completedEpisodes = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM semantic_episodes WHERE outcome IN ('won', 'lost')
    `).get().count) || 0;
    const allEpisodes = this.db.prepare(`
      SELECT episodes.episode_id, episodes.seed, episodes.deck, episodes.stake,
             episodes.started_at, episodes.ended_at, episodes.outcome,
             episodes.max_ante, episodes.max_round, episodes.max_hand_score,
             first.features_json AS first_features_json,
             first.state_fingerprint AS first_exact_fingerprint,
             first.replay_fingerprint AS first_replay_fingerprint,
             last.next_features_json AS last_features_json,
             last.next_state_fingerprint AS last_exact_fingerprint,
             last.next_replay_fingerprint AS last_replay_fingerprint
      FROM semantic_episodes episodes
      LEFT JOIN semantic_experiences first ON first.id = (
        SELECT id FROM semantic_experiences WHERE episode_id = episodes.episode_id ORDER BY id LIMIT 1
      )
      LEFT JOIN semantic_experiences last ON last.id = (
        SELECT id FROM semantic_experiences WHERE episode_id = episodes.episode_id ORDER BY id DESC LIMIT 1
      )
      ORDER BY episodes.started_at, episodes.episode_id
    `).all().map((episode) => ({
      ...episode,
      firstFeatures: semanticNormalizeFeatures(parseJson(episode.first_features_json, null)),
      lastFeatures: semanticNormalizeFeatures(parseJson(episode.last_features_json, null)),
      startedAt: episode.started_at,
      endedAt: episode.ended_at,
      firstExactFingerprint: episode.first_exact_fingerprint,
      firstReplayFingerprint: episode.first_replay_fingerprint,
      lastExactFingerprint: episode.last_exact_fingerprint,
      lastReplayFingerprint: episode.last_replay_fingerprint,
    }));
    const creditByEpisode = new Map();
    const completed = allEpisodes.filter((episode) => new Set(["won", "lost"]).has(episode.outcome));
    const linkCandidates = [];
    for (const segment of allEpisodes.filter((episode) => episode.outcome === "interrupted")) {
      for (const successor of completed.filter((successor) =>
        successor.seed && successor.seed === segment.seed &&
        successor.deck === segment.deck && successor.stake === segment.stake &&
        segmentBoundaryCompatible(segment, successor)
      )) {
        linkCandidates.push({
          segment,
          successor,
          gapMs: Date.parse(successor.startedAt) - Date.parse(segment.endedAt),
        });
      }
    }
    // Enforce a one-to-one restart boundary.  Greedy nearest-neighbour is
    // deterministic and prevents several interrupted attempts from voting as
    // prefixes of one later terminal run.
    const assignedSegments = new Set();
    const assignedSuccessors = new Set();
    for (const candidate of linkCandidates.sort((left, right) =>
      left.gapMs - right.gapMs ||
      left.segment.episode_id.localeCompare(right.segment.episode_id) ||
      left.successor.episode_id.localeCompare(right.successor.episode_id)
    )) {
      if (assignedSegments.has(candidate.segment.episode_id) ||
          assignedSuccessors.has(candidate.successor.episode_id)) continue;
      assignedSegments.add(candidate.segment.episode_id);
      assignedSuccessors.add(candidate.successor.episode_id);
      creditByEpisode.set(candidate.segment.episode_id, candidate.successor.episode_id);
    }
    const eligibleEpisodeIds = new Set([...completed.map((episode) => episode.episode_id), ...creditByEpisode.keys()]);
    const eligibleTransitions = eligibleEpisodeIds.size
      ? Number(this.db.prepare(`SELECT COUNT(*) AS count FROM semantic_experiences WHERE episode_id IN (${[...eligibleEpisodeIds].map(() => "?").join(",")})`).get(...eligibleEpisodeIds).count) || 0
      : 0;
    const existingLabels = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM semantic_reward_labels WHERE reward_version = ?
    `).get(SEMANTIC_REWARD_VERSION).count) || 0;
    const rewardSignature = `v${SEMANTIC_REWARD_VERSION}:outcome-anchor-2:segment-link-3:` +
      `cash-delta=0.035[-0.7,0.7]:rental-liability=-0.1[-0.6,0.6]:` +
      `perishable-expiry=-0.65x3:legacy-boundary-only:no-buy-bonus:gamma=${this.discount}`;
    const previous = this.db.prepare(`
      SELECT * FROM semantic_reward_migrations WHERE reward_version = ?
    `).get(SEMANTIC_REWARD_VERSION);
    const staleLabels = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM semantic_reward_labels labels
      JOIN semantic_experiences e ON e.id = labels.experience_id
      JOIN semantic_episodes episodes ON episodes.episode_id = e.episode_id
      WHERE labels.reward_version = ? AND (
        (episodes.outcome IN ('won', 'lost') AND labels.credit_episode_id <> episodes.episode_id) OR
        (episodes.outcome = 'lost' AND labels.terminal_outcome <> 'lost') OR
        (episodes.outcome = 'interrupted' AND labels.credit_episode_id = episodes.episode_id)
      )
    `).get(SEMANTIC_REWARD_VERSION).count) || 0;
    const currentCredits = this.db.prepare(`
      SELECT e.episode_id,
             MIN(labels.credit_episode_id) AS minimum_credit,
             MAX(labels.credit_episode_id) AS maximum_credit
      FROM semantic_reward_labels labels
      JOIN semantic_experiences e ON e.id = labels.experience_id
      WHERE labels.reward_version = ?
      GROUP BY e.episode_id
    `).all(SEMANTIC_REWARD_VERSION);
    const completedEpisodeIds = new Set(completed.map((episode) => episode.episode_id));
    const staleCreditAssignments = currentCredits.filter((row) => {
      const expected = completedEpisodeIds.has(row.episode_id)
        ? row.episode_id
        : creditByEpisode.get(row.episode_id);
      return !expected || row.minimum_credit !== expected || row.maximum_credit !== expected;
    }).length;
    const fullRelabel = force || staleLabels > 0 || staleCreditAssignments > 0 ||
      existingLabels > eligibleTransitions || (previous && previous.reward_signature !== rewardSignature);
    if (!fullRelabel && existingLabels === eligibleTransitions && previous?.reward_signature === rewardSignature) {
      return {
        rewardVersion: SEMANTIC_REWARD_VERSION,
        episodes: completedEpisodes,
        transitions: existingLabels,
        exactTransitions: Number(previous?.exact_transitions) || 0,
        semanticTransitions: Number(previous?.semantic_transitions) || 0,
        incompatibleTransitions: Number(previous?.incompatible_transitions) || 0,
        correctedOutcomes: Number(previous?.corrected_outcomes) || 0,
        linkedSegments: Number(previous?.linked_segments) || 0,
        linkedTransitions: Number(previous?.linked_transitions) || 0,
        changed: false,
      };
    }

    const episodes = this.db.prepare(`
      SELECT episode_id, outcome, max_ante, max_round, max_hand_score,
             COALESCE((SELECT MAX(money) FROM (
               SELECT CAST(json_extract(features_json, '$.money') AS REAL) AS money
               FROM semantic_experiences e2 WHERE e2.episode_id = semantic_episodes.episode_id
               ORDER BY id DESC LIMIT 1
             )), 0) AS final_money
      FROM semantic_episodes
      WHERE outcome IN ('won', 'lost')
      ORDER BY started_at, episode_id
    `).all();
    for (const [segmentEpisodeId, creditEpisodeId] of creditByEpisode) {
      const segment = allEpisodes.find((episode) => episode.episode_id === segmentEpisodeId);
      const successor = allEpisodes.find((episode) => episode.episode_id === creditEpisodeId);
      episodes.push({
        episode_id: segmentEpisodeId,
        outcome: successor.outcome,
        max_ante: successor.max_ante,
        max_round: successor.max_round,
        // The best hand can live in the interrupted prefix (5964A4PN is a
        // production example: 100565 in the prefix vs 53955 in the tail).
        max_hand_score: Math.max(
          Number(segment?.max_hand_score) || 0,
          Number(successor.max_hand_score) || 0,
        ),
        final_money: Number(successor.lastFeatures?.money) || 0,
        credit_episode_id: creditEpisodeId,
        linked: true,
      });
    }
    const groups = new Map();
    for (const episode of episodes) {
      const creditEpisodeId = episode.credit_episode_id || episode.episode_id;
      const group = groups.get(creditEpisodeId) ?? {
        creditEpisodeId,
        trajectories: [],
      };
      group.trajectories.push(episode);
      groups.set(creditEpisodeId, group);
    }
    for (const group of groups.values()) {
      group.trajectories.sort((left, right) => {
        const leftTerminal = left.episode_id === group.creditEpisodeId ? 1 : 0;
        const rightTerminal = right.episode_id === group.creditEpisodeId ? 1 : 0;
        if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
        const leftAt = allEpisodes.find((episode) => episode.episode_id === left.episode_id)?.startedAt ?? "";
        const rightAt = allEpisodes.find((episode) => episode.episode_id === right.episode_id)?.startedAt ?? "";
        return leftAt.localeCompare(rightAt) || left.episode_id.localeCompare(right.episode_id);
      });
    }
    const incrementalRelabel = !fullRelabel && Boolean(previous) &&
      previous.reward_signature === rewardSignature && existingLabels < eligibleTransitions;
    let groupsToRelabel = [...groups.values()];
    if (incrementalRelabel) {
      const eligibleIds = [...eligibleEpisodeIds];
      const missingEpisodeIds = eligibleIds.length
        ? this.db.prepare(`
            SELECT DISTINCT e.episode_id
            FROM semantic_experiences e
            LEFT JOIN semantic_reward_labels labels
              ON labels.experience_id = e.id AND labels.reward_version = ?
            WHERE e.episode_id IN (${eligibleIds.map(() => "?").join(",")})
              AND labels.experience_id IS NULL
          `).all(SEMANTIC_REWARD_VERSION, ...eligibleIds)
          .map((row) => row.episode_id)
        : [];
      const affectedCredits = new Set(missingEpisodeIds.map((episodeId) =>
        completedEpisodeIds.has(episodeId) ? episodeId : creditByEpisode.get(episodeId)
      ).filter(Boolean));
      groupsToRelabel = groupsToRelabel.filter((group) => affectedCredits.has(group.creditEpisodeId));
    }
    const transitionQuery = this.db.prepare(`
      SELECT id, action_json, features_json, next_features_json
      FROM semantic_experiences WHERE episode_id = ? ORDER BY id
    `);
    const upsert = this.db.prepare(`
      INSERT INTO semantic_reward_labels (
        experience_id, reward_version, immediate_reward, return_reward,
        terminal_outcome, compatibility, credit_episode_id, relabeled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experience_id, reward_version) DO UPDATE SET
        immediate_reward=excluded.immediate_reward,
        return_reward=excluded.return_reward,
        terminal_outcome=excluded.terminal_outcome,
        compatibility=excluded.compatibility,
        credit_episode_id=excluded.credit_episode_id,
        relabeled_at=excluded.relabeled_at
    `);
    const now = new Date().toISOString();
    let transitions = 0;
    let exactTransitions = 0;
    let semanticTransitions = 0;
    let incompatibleTransitions = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A signature or credit change invalidates the whole reward version. A
      // newly completed episode only relabels its complete canonical group,
      // so a linked prefix and terminal tail still share one backward-return
      // pass without rewriting every prior episode at each game over.
      if (!incrementalRelabel) {
        this.db.prepare("DELETE FROM semantic_reward_labels WHERE reward_version = ?").run(SEMANTIC_REWARD_VERSION);
      }
      for (const group of groupsToRelabel) {
        const terminalEpisode = group.trajectories.find((episode) => episode.episode_id === group.creditEpisodeId);
        if (!terminalEpisode) continue;
        const rewardable = [];
        let reconstructedMaxHandScore = 0;
        let lastFeatures = null;
        for (const trajectory of group.trajectories) {
          for (const row of transitionQuery.all(trajectory.episode_id)) {
            const before = parseJson(row.features_json, null);
            const after = parseJson(row.next_features_json, null);
            lastFeatures = semanticNormalizeFeatures(after);
            const beforeCompatibility = semanticFeatureCompatibility(before);
            const afterCompatibility = semanticFeatureCompatibility(after);
            const compatibility = beforeCompatibility === "incompatible" || afterCompatibility === "incompatible"
              ? "incompatible"
              : beforeCompatibility === "exact" && afterCompatibility === "exact" ? "exact" : "semantic";
            const action = parseJson(row.action_json, null);
            reconstructedMaxHandScore = Math.max(
              reconstructedMaxHandScore,
              semanticPlayedHandScoreFromFeatures(before, action, after),
            );
            const immediateReward = compatibility === "incompatible"
              ? 0
              : semanticTransitionRewardFromFeatures(before, action, after);
            rewardable.push({ id: Number(row.id), immediateReward: Number(immediateReward) || 0, compatibility });
          }
        }
        const finalState = {
          ante_num: Number(terminalEpisode.max_ante) || 0,
          round_num: Number(terminalEpisode.max_round) || 0,
          trainingMaxHandScore: Math.max(...group.trajectories.map((episode) => Number(episode.max_hand_score) || 0)),
          money: Number(terminalEpisode.final_money) || 0,
        };
        finalState.trainingMaxHandScore = Math.max(finalState.trainingMaxHandScore, reconstructedMaxHandScore);
        const lastScore = Number(lastFeatures?.round?.score) || 0;
        const lastTarget = Number(lastFeatures?.blind?.target) || 0;
        const provenWin = terminalEpisode.outcome === "won" && (
          Number(terminalEpisode.max_ante) > 8 ||
          (lastFeatures?.screen === "ROUND_EVAL" && lastFeatures?.won === true && lastTarget > 0 && lastScore >= lastTarget)
        );
        const rewardOutcome = terminalEpisode.outcome === "won" && !provenWin ? "lost" : terminalEpisode.outcome;
        const returns = semanticDiscountedReturns(rewardable, rewardOutcome, finalState, this.discount);
        for (const transition of rewardable) {
          const returnReward = returns.get(transition.id) ?? 0;
          upsert.run(
            transition.id,
            SEMANTIC_REWARD_VERSION,
            transition.immediateReward,
            returnReward,
            rewardOutcome,
            transition.compatibility,
            group.creditEpisodeId,
            now,
          );
          transitions += 1;
          if (transition.compatibility === "exact") exactTransitions += 1;
          else if (transition.compatibility === "semantic") semanticTransitions += 1;
          else incompatibleTransitions += 1;
        }
      }
      const totals = this.db.prepare(`
        SELECT COUNT(*) AS transitions,
               SUM(CASE WHEN compatibility = 'exact' THEN 1 ELSE 0 END) AS exact_transitions,
               SUM(CASE WHEN compatibility = 'semantic' THEN 1 ELSE 0 END) AS semantic_transitions,
               SUM(CASE WHEN compatibility = 'incompatible' THEN 1 ELSE 0 END) AS incompatible_transitions
        FROM semantic_reward_labels WHERE reward_version = ?
      `).get(SEMANTIC_REWARD_VERSION);
      const correctedOutcomeTotal = Number(this.db.prepare(`
        SELECT COUNT(DISTINCT e.episode_id) AS count
        FROM semantic_reward_labels labels
        JOIN semantic_experiences e ON e.id = labels.experience_id
        JOIN semantic_episodes episodes ON episodes.episode_id = e.episode_id
        WHERE labels.reward_version = ? AND episodes.outcome = 'won'
          AND labels.terminal_outcome = 'lost'
      `).get(SEMANTIC_REWARD_VERSION).count) || 0;
      const linkedTotals = this.db.prepare(`
        SELECT COUNT(DISTINCT e.episode_id) AS segments, COUNT(*) AS transitions
        FROM semantic_reward_labels labels
        JOIN semantic_experiences e ON e.id = labels.experience_id
        WHERE labels.reward_version = ? AND labels.credit_episode_id <> e.episode_id
      `).get(SEMANTIC_REWARD_VERSION);
      this.db.prepare(`
        INSERT INTO semantic_reward_migrations (
          reward_version, reward_signature, completed_at, episodes, transitions, exact_transitions,
          semantic_transitions, incompatible_transitions, corrected_outcomes,
          linked_segments, linked_transitions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(reward_version) DO UPDATE SET
          reward_signature=excluded.reward_signature, completed_at=excluded.completed_at, episodes=excluded.episodes,
          transitions=excluded.transitions, exact_transitions=excluded.exact_transitions,
          semantic_transitions=excluded.semantic_transitions,
          incompatible_transitions=excluded.incompatible_transitions,
          corrected_outcomes=excluded.corrected_outcomes,
          linked_segments=excluded.linked_segments,
          linked_transitions=excluded.linked_transitions
      `).run(
        SEMANTIC_REWARD_VERSION, rewardSignature, now, completedEpisodes, Number(totals.transitions) || 0,
        Number(totals.exact_transitions) || 0, Number(totals.semantic_transitions) || 0,
        Number(totals.incompatible_transitions) || 0, correctedOutcomeTotal,
        Number(linkedTotals.segments) || 0, Number(linkedTotals.transitions) || 0,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const migrationTotals = this.db.prepare(`
      SELECT transitions, exact_transitions, semantic_transitions, incompatible_transitions, corrected_outcomes,
             linked_segments, linked_transitions
      FROM semantic_reward_migrations WHERE reward_version = ?
    `).get(SEMANTIC_REWARD_VERSION);
    return {
      rewardVersion: SEMANTIC_REWARD_VERSION,
      episodes: completedEpisodes,
      transitions: Number(migrationTotals.transitions) || 0,
      exactTransitions: Number(migrationTotals.exact_transitions) || 0,
      semanticTransitions: Number(migrationTotals.semantic_transitions) || 0,
      incompatibleTransitions: Number(migrationTotals.incompatible_transitions) || 0,
      correctedOutcomes: Number(migrationTotals.corrected_outcomes) || 0,
      linkedSegments: Number(migrationTotals.linked_segments) || 0,
      linkedTransitions: Number(migrationTotals.linked_transitions) || 0,
      relabeledTransitions: transitions,
      changed: true,
    };
  }

  rewardMigrationStatus() {
    if (!this.db) return { enabled: false, rewardVersion: SEMANTIC_REWARD_VERSION };
    return {
      ...this.rewardMigration,
      rawTrajectorySchemaVersion: RAW_TRAJECTORY_SCHEMA_VERSION,
      rawTrajectoriesImmutable: true,
    };
  }

  beginEpisode({ episodeId, runId, state }) {
    if (!this.db) return null;
    this.db.prepare(`
      INSERT INTO semantic_episodes (
        episode_id, run_id, started_at, seed, deck, stake, max_ante, max_round, policy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(episode_id) DO NOTHING
    `).run(
      episodeId,
      runId,
      new Date().toISOString(),
      String(state?.seed ?? ""),
      String(state?.deck ?? ""),
      String(state?.stake ?? ""),
      Number(state?.ante_num) || 0,
      Number(state?.round_num) || 0,
      SEMANTIC_POLICY_VERSION,
    );
    return episodeId;
  }

  resumeEpisode({ runId, state }) {
    if (!this.db || !runId || !state) return null;
    const seed = String(state.seed ?? "");
    if (!seed) return null;
    const deck = String(state.deck ?? "");
    const stake = String(state.stake ?? "");
    const ante = Number(state.ante_num) || 0;
    const round = Number(state.round_num) || 0;
    const currentFeatures = semanticStateFeatures(state);
    const currentExactFingerprint = semanticExactFingerprint(state);
    const currentReplayFingerprint = semanticReplayFingerprint(currentFeatures);
    const earliestEndedAt = new Date(Date.now() - SEGMENT_LINK_MAX_GAP_MS).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.db.prepare(`
        SELECT episodes.episode_id, episodes.run_id, episodes.ended_at, episodes.outcome,
               latest.run_id AS latest_run_id,
               latest.next_features_json, latest.next_state_fingerprint,
               latest.next_replay_fingerprint,
               COALESCE(episodes.ended_at, latest.created_at, episodes.started_at) AS boundary_at
        FROM semantic_episodes episodes
        LEFT JOIN semantic_experiences latest ON latest.id = (
          SELECT id FROM semantic_experiences
          WHERE episode_id = episodes.episode_id ORDER BY id DESC LIMIT 1
        )
        WHERE (
          episodes.outcome = 'interrupted' OR
          (episodes.outcome IS NULL AND latest.run_id = episodes.run_id)
        )
          AND episodes.seed = ? AND episodes.deck = ? AND episodes.stake = ?
          AND episodes.run_id <> ?
          AND COALESCE(episodes.ended_at, latest.created_at, episodes.started_at) >= ?
        ORDER BY boundary_at DESC, episodes.started_at DESC
      `).all(seed, deck, stake, runId, earliestEndedAt);
      const matches = [];
      for (const candidate of candidates) {
        const latest = semanticNormalizeFeatures(parseJson(candidate.next_features_json, null));
        if (!latest) continue;
        const exactMatch = candidate.next_state_fingerprint &&
          candidate.next_state_fingerprint === currentExactFingerprint;
        const replayMatch = candidate.next_replay_fingerprint &&
          candidate.next_replay_fingerprint === currentReplayFingerprint;
        // Completed/interrupted Ante 1 attempts may be deliberate fixed-seed
        // replays, so never infer continuity for them.  A managed process kill
        // can, however, leave the currently owned episode open.  Recover that
        // narrow case only when the exact state fingerprint is unchanged;
        // semantic/replay similarity is intentionally insufficient here.
        const isForcedOpen = candidate.outcome == null;
        if ((Number(latest.ante) || 0) <= 1 && !(isForcedOpen && exactMatch)) continue;
        const notEarlier = ante > latest.ante || (ante === latest.ante && round >= latest.roundNumber);
        if (!notEarlier) continue;
        if (!exactMatch && !replayMatch && !strictBoundarySignatureCompatible(latest, currentFeatures)) continue;
        matches.push({ candidate, latest });
      }
      // Multiple indistinguishable historical attempts are ambiguous.  Never
      // pick one merely because it happens to sort first.
      if (matches.length !== 1) {
        this.db.exec("COMMIT");
        return null;
      }
      const selected = matches[0];
      const updated = this.db.prepare(`
        UPDATE semantic_episodes
        SET run_id = ?, outcome = NULL, ended_at = NULL,
            max_ante = MAX(max_ante, ?), max_round = MAX(max_round, ?)
        WHERE episode_id = ? AND (outcome = 'interrupted' OR outcome IS NULL)
      `).run(runId, ante, round, selected.candidate.episode_id);
      if (Number(updated.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      // A forced Windows process-tree restart cannot run the old Node
      // process's finally block.  If an earlier restart already created an
      // empty or superseded open episode for this same game, close it now so
      // it cannot remain an ambiguous live trajectory forever.  Non-empty
      // segments stay intact and can be linked conservatively at reward time.
      this.db.prepare(`
        UPDATE semantic_episodes
        SET ended_at = COALESCE(ended_at, ?), outcome = 'interrupted'
        WHERE outcome IS NULL AND episode_id <> ? AND run_id <> ?
          AND seed = ? AND deck = ? AND stake = ?
          AND transition_count = 0 AND started_at >= ?
      `).run(
        new Date().toISOString(),
        selected.candidate.episode_id,
        runId,
        seed,
        deck,
        stake,
        earliestEndedAt,
      );
      this.db.exec("COMMIT");
      return {
        episodeId: selected.candidate.episode_id,
        previousRunId: selected.candidate.run_id,
        runId,
        lastAnte: selected.latest.ante,
        lastRound: selected.latest.roundNumber,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  allRewardEvidence({ includeFeatures = true } = {}) {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT e.episode_id, labels.credit_episode_id, labels.terminal_outcome, labels.return_reward,
             e.policy_source, e.action_key, e.action_template_json,
             e.features_json, labels.compatibility, e.policy_version
      FROM semantic_experiences e
      JOIN semantic_reward_labels labels ON labels.experience_id = e.id
      WHERE labels.reward_version = ? AND labels.compatibility IN ('exact', 'semantic')
      ORDER BY e.id
    `).all(SEMANTIC_REWARD_VERSION).map((row) => {
      const features = semanticNormalizeFeatures(parseJson(row.features_json, null), { canonicalVersion: true });
      const actionTemplate = parseJson(row.action_template_json, {});
      const evidence = {
        episodeId: row.credit_episode_id || row.episode_id,
        trajectoryEpisodeId: row.episode_id,
        outcome: row.terminal_outcome,
        returnReward: Number(row.return_reward) || 0,
        source: row.policy_source,
        decisionKey: features ? semanticDecisionKey(features) : null,
        actionKey: features ? semanticHistoricalActionKey({ features, actionTemplate }) : row.action_key,
        actionTemplate,
        compatibility: row.compatibility,
        trajectoryPolicyVersion: Number(row.policy_version) || 0,
      };
      if (includeFeatures) evidence.features = features;
      return evidence;
    });
  }

  /**
   * Return only the rows whose current reward migration credits the completed
   * canonical episode. This is the episode-boundary delta consumed by the
   * in-memory semantic-prior index; it avoids re-reading and JSON-parsing the
   * entire historical table after every game.
   */
  rewardEvidenceForCreditEpisode(episodeId, { includeFeatures = true } = {}) {
    if (!this.db || !episodeId) return [];
    return this.db.prepare(`
      SELECT e.episode_id, labels.credit_episode_id, labels.terminal_outcome, labels.return_reward,
             e.policy_source, e.action_key, e.action_template_json,
             e.features_json, labels.compatibility, e.policy_version
      FROM semantic_reward_labels labels
      JOIN semantic_experiences e ON e.id = labels.experience_id
      WHERE labels.reward_version = ? AND labels.credit_episode_id = ?
        AND labels.compatibility IN ('exact', 'semantic')
      ORDER BY e.id
    `).all(SEMANTIC_REWARD_VERSION, episodeId).map((row) => {
      const features = semanticNormalizeFeatures(parseJson(row.features_json, null), { canonicalVersion: true });
      const actionTemplate = parseJson(row.action_template_json, {});
      const evidence = {
        episodeId: row.credit_episode_id || row.episode_id,
        trajectoryEpisodeId: row.episode_id,
        outcome: row.terminal_outcome,
        returnReward: Number(row.return_reward) || 0,
        source: row.policy_source,
        decisionKey: features ? semanticDecisionKey(features) : null,
        actionKey: features ? semanticHistoricalActionKey({ features, actionTemplate }) : row.action_key,
        actionTemplate,
        compatibility: row.compatibility,
        trajectoryPolicyVersion: Number(row.policy_version) || 0,
      };
      if (includeFeatures) evidence.features = features;
      return evidence;
    });
  }

  recordTransition({ runId, episodeId, step, state, action, nextState, source, plan, usage, handScore: measuredHandScore }) {
    if (!this.db) return null;
    const features = semanticStateFeatures(state);
    const nextFeatures = semanticStateFeatures(nextState);
    const immediateReward = semanticTransitionReward(state, action, nextState);
    const inferredHandScore = semanticPlayedHandScore(state, action, nextState);
    const handScore = Number.isFinite(Number(measuredHandScore))
      ? Math.max(0, Number(measuredHandScore))
      : inferredHandScore;
    const actionKey = semanticActionKey(state, action);
    const actionTemplate = semanticActionTemplate(state, action);
    const result = this.db.prepare(`
      INSERT INTO semantic_experiences (
        run_id, episode_id, step, created_at, screen, state_fingerprint, replay_fingerprint,
        state_bucket, state_text, features_json, action_key, action_method, action_json,
        action_template_json, action_summary, policy_source, strategy, memory, immediate_reward,
        next_state_fingerprint, next_replay_fingerprint, next_state_text, next_features_json,
        total_tokens, policy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      episodeId,
      step,
      new Date().toISOString(),
      state.state,
      semanticExactFingerprint(state),
      semanticReplayFingerprint(features),
      semanticStateBucket(features),
      semanticStateText(features),
      JSON.stringify(features),
      actionKey,
      action.method,
      JSON.stringify(action),
      JSON.stringify(actionTemplate),
      semanticActionSummary(state, action),
      String(source ?? "unknown"),
      String(plan?.strategy ?? "").slice(0, 1_000),
      durablePlanText(plan).slice(0, 1_500),
      immediateReward,
      semanticExactFingerprint(nextState),
      semanticReplayFingerprint(nextFeatures),
      semanticStateText(nextFeatures),
      JSON.stringify(nextFeatures),
      Number(usage?.totalTokens) || 0,
      SEMANTIC_POLICY_VERSION,
    );
    this.db.prepare(`
      UPDATE semantic_episodes
      SET max_ante = MAX(max_ante, ?), max_round = MAX(max_round, ?),
          max_hand_score = MAX(max_hand_score, ?), transition_count = transition_count + 1
      WHERE episode_id = ?
    `).run(Number(nextState?.ante_num) || 0, Number(nextState?.round_num) || 0, handScore, episodeId);
    return { id: Number(result.lastInsertRowid), immediateReward, handScore };
  }

  finalizeEpisode(episodeId, outcome, finalState) {
    if (!this.db || !episodeId || !new Set(["won", "lost"]).has(outcome)) return null;
    const episode = this.db.prepare(
      "SELECT outcome, max_hand_score AS maxHandScore FROM semantic_episodes WHERE episode_id = ?",
    ).get(episodeId);
    if (!episode || episode.outcome) return null;
    const transitions = this.db.prepare(`
      SELECT id, immediate_reward AS immediateReward
      FROM semantic_experiences WHERE episode_id = ? ORDER BY id
    `).all(episodeId);
    const maxHandScore = Math.max(0, Number(episode.maxHandScore) || 0);
    const trainingFinalState = { ...finalState, trainingMaxHandScore: maxHandScore };
    const returns = semanticDiscountedReturns(transitions, outcome, trainingFinalState, this.discount);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(`
        UPDATE semantic_experiences SET return_reward = ?, terminal_outcome = ? WHERE id = ?
      `);
      for (const [id, value] of returns) update.run(value, outcome, id);
      this.db.prepare(`
        UPDATE semantic_episodes
        SET ended_at = ?, outcome = ?, max_ante = MAX(max_ante, ?), max_round = MAX(max_round, ?)
        WHERE episode_id = ?
      `).run(now, outcome, Number(finalState?.ante_num) || 0, Number(finalState?.round_num) || 0, episodeId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.rewardMigration = this.migrateRewards();
    this.#loadHot();
    return {
      episodeId,
      outcome,
      transitions: transitions.length,
      maxHandScore,
      highScoreTier: semanticHighScoreTier(maxHandScore),
    };
  }

  markEpisodeInterrupted(episodeId) {
    if (!this.db || !episodeId) return;
    this.db.prepare(`
      UPDATE semantic_episodes SET ended_at = COALESCE(ended_at, ?), outcome = COALESCE(outcome, 'interrupted')
      WHERE episode_id = ?
    `).run(new Date().toISOString(), episodeId);
  }

  retrieve(state, { topK = this.topK, budgetMs = this.searchBudgetMs } = {}) {
    const startedAt = performance.now();
    this.retrievalStats.requests += 1;
    if (!this.db || !this.hot.length) {
      return {
        items: [],
        groups: [],
        replayFingerprint: semanticReplayFingerprint(state),
        elapsedMs: performance.now() - startedAt,
        searched: 0,
        truncated: false,
        cached: false,
        evidence: [],
        policyVersion: SEMANTIC_POLICY_VERSION,
      };
    }
    const features = semanticNormalizeFeatures(semanticStateFeatures(state), { canonicalVersion: true });
    const replayFingerprint = semanticReplayFingerprint(features);
    const cacheKey = `${replayFingerprint}\u0000${topK}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      if (cached.items.length) this.retrievalStats.hits += 1;
      return { ...cached, elapsedMs: performance.now() - startedAt, cached: true };
    }

    const candidates = [];
    let searched = 0;
    let scanned = 0;
    let truncated = false;
    for (const entry of this.hot) {
      if ((scanned++ & 63) === 0 && performance.now() - startedAt >= budgetMs) {
        truncated = true;
        break;
      }
      if (entry.screen !== state.state) continue;
      if (semanticStakeRuleCompatibility(features, entry.features) === "incompatible") continue;
      searched += 1;
      const similarity = semanticStateSimilarity(features, entry.features);
      if (similarity < this.minimumSimilarity) continue;
      candidates.push({ entry, similarity });
    }
    candidates.sort((left, right) => right.similarity - left.similarity || right.entry.id - left.entry.id);
    const evidence = candidates.slice(0, 256).map(({ entry, similarity }) => ({
      episodeId: entry.episodeId,
      outcome: entry.outcome,
      returnReward: entry.returnReward,
      similarity: Math.round(similarity * 1_000) / 1_000,
      actionTemplate: entry.actionTemplate,
      source: entry.source,
      features: entry.features,
    }));

    // A restarted run can contribute transitions on both sides of the
    // boundary.  Keep transition-level evidence for inspection above, but let
    // each canonical episode cast at most one vote for an action group.
    const votingCandidates = [];
    const seenEpisodeActions = new Set();
    for (const candidate of candidates) {
      const voteKey = `${candidate.entry.episodeId}\u0000${candidate.entry.actionKey}`;
      if (seenEpisodeActions.has(voteKey)) continue;
      seenEpisodeActions.add(voteKey);
      votingCandidates.push(candidate);
    }

    const groupMap = new Map();
    for (const candidate of votingCandidates) {
      const entry = candidate.entry;
      const group = groupMap.get(entry.actionKey) ?? {
        actionKey: entry.actionKey,
        actionMethod: entry.actionMethod,
        actionSummary: entry.actionSummary,
        action: entry.action,
        actionTemplate: entry.actionTemplate,
        samples: 0,
        trustedSamples: 0,
        weight: 0,
        returnSum: 0,
        positive: 0,
        wins: 0,
        losses: 0,
        winningEpisodeIds: new Set(),
        losingEpisodeIds: new Set(),
        exactReplaySamples: 0,
        exactReplayTrustedSamples: 0,
        exactReturnWeight: 0,
        exactReturnSum: 0,
        exactPositive: 0,
        exactWinningEpisodeIds: new Set(),
        exactLosingEpisodeIds: new Set(),
        similarity: 0,
        representativeState: entry.stateText,
        representativeNextState: entry.nextStateText,
        representativeSource: entry.source,
        representativePlan: entry.memory,
      };
      const weight = sourceWeight(entry.source);
      group.samples += 1;
      group.trustedSamples += trustedSource(entry.source) ? 1 : 0;
      group.weight += weight;
      group.returnSum += entry.returnReward * weight;
      group.positive += entry.returnReward > 0 ? 1 : 0;
      group.wins += entry.outcome === "won" ? 1 : 0;
      group.losses += entry.outcome === "lost" ? 1 : 0;
      if (entry.outcome === "won") group.winningEpisodeIds.add(entry.episodeId);
      if (entry.outcome === "lost") group.losingEpisodeIds.add(entry.episodeId);
      if (entry.compatibility === "exact" && entry.replayFingerprint === replayFingerprint) {
        group.exactReplaySamples += 1;
        group.exactReplayTrustedSamples += trustedSource(entry.source) && entry.compatibility === "exact" ? 1 : 0;
        group.exactReturnWeight += weight;
        group.exactReturnSum += entry.returnReward * weight;
        group.exactPositive += entry.returnReward > 0 ? 1 : 0;
        if (entry.outcome === "won") group.exactWinningEpisodeIds.add(entry.episodeId);
        if (entry.outcome === "lost") group.exactLosingEpisodeIds.add(entry.episodeId);
      }
      if (candidate.similarity > group.similarity) {
        group.similarity = candidate.similarity;
        group.action = entry.action;
        group.representativeState = entry.stateText;
        group.representativeNextState = entry.nextStateText;
        group.representativeSource = entry.source;
        group.representativePlan = entry.memory;
      }
      groupMap.set(entry.actionKey, group);
    }
    const groups = [...groupMap.values()].map((group) => {
      const {
        winningEpisodeIds,
        losingEpisodeIds,
        exactWinningEpisodeIds,
        exactLosingEpisodeIds,
        ...plain
      } = group;
      return {
        ...plain,
        similarity: Math.round(group.similarity * 1_000) / 1_000,
        averageReturn: Math.round((group.returnSum / (group.weight || 1)) * 1_000) / 1_000,
        positiveRate: Math.round((group.positive / group.samples) * 1_000) / 1_000,
        winningEpisodes: winningEpisodeIds.size,
        losingEpisodes: losingEpisodeIds.size,
        exactAverageReturn: group.exactReplaySamples
          ? Math.round((group.exactReturnSum / (group.exactReturnWeight || 1)) * 1_000) / 1_000
          : null,
        exactPositiveRate: group.exactReplaySamples
          ? Math.round((group.exactPositive / group.exactReplaySamples) * 1_000) / 1_000
          : 0,
        exactWinningEpisodes: exactWinningEpisodeIds.size,
        exactLosingEpisodes: exactLosingEpisodeIds.size,
      };
    }).sort((left, right) =>
      right.similarity - left.similarity || right.samples - left.samples || right.averageReturn - left.averageReturn,
    );
    const items = groups.slice(0, Math.max(topK * 2, 8));
    const result = {
      items,
      groups,
      replayFingerprint,
      elapsedMs: performance.now() - startedAt,
      searched,
      truncated,
      cached: false,
      policyVersion: SEMANTIC_POLICY_VERSION,
      rewardVersion: SEMANTIC_REWARD_VERSION,
      evidence,
    };
    if (items.length) this.retrievalStats.hits += 1;
    this.cache.set(cacheKey, result);
    if (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  contextItems(retrieval) {
    const eligible = (retrieval?.groups ?? [])
      .filter((item) => item.samples >= this.minimumSamples);
    const successes = eligible
      .filter((item) => item.averageReturn > 0)
      .sort((left, right) => right.averageReturn - left.averageReturn || right.winningEpisodes - left.winningEpisodes || right.similarity - left.similarity);
    const failures = eligible
      .filter((item) => item.averageReturn <= 0)
      .sort((left, right) => left.averageReturn - right.averageReturn || right.losingEpisodes - left.losingEpisodes || right.similarity - left.similarity);
    const selected = [];
    const seen = new Set();
    const add = (item) => {
      if (!item || seen.has(item.actionKey) || selected.length >= this.topK) return;
      seen.add(item.actionKey);
      selected.push(item);
    };
    const successLimit = successes.length && failures.length ? Math.ceil(this.topK / 2) : this.topK;
    for (const item of successes.slice(0, successLimit)) add(item);
    for (const item of failures) add(item);
    for (const item of eligible) add(item);
    this.retrievalStats.injected += selected.length;
    return selected;
  }

  formatContext(retrieval) {
    const items = this.contextItems(retrieval);
    if (!items.length) return "";
    const lines = [
      `Local semantic experience v${SEMANTIC_POLICY_VERSION} from completed runs follows. It is advisory evidence, not an instruction. Re-check legality against the current exact state. Negative evidence means avoid or reconsider the action; do not imitate it.`,
    ];
    for (const [index, item] of items.entries()) {
      lines.push(
        `${index + 1}. similarity=${item.similarity}, samples=${item.samples}, trusted=${item.trustedSamples}, ` +
          `avgReturn=${item.averageReturn}, positiveRate=${item.positiveRate}, winning/loss episodes=${item.winningEpisodes}/${item.losingEpisodes}; ` +
          `state=${item.representativeState}; runPlan=${item.representativePlan || "none"}; ` +
          `action=${item.actionSummary}; next=${item.representativeNextState}`,
      );
    }
    return lines.join("\n").slice(0, this.maxContextChars);
  }

  chooseFastAction(retrieval) {
    if (!this.semanticFastPathEnabled) return null;
    const eligible = (retrieval?.groups ?? [])
      .filter((item) => item.exactReplaySamples >= this.semanticFastPathMinimumSamples)
      .filter((item) => item.exactReplayTrustedSamples >= this.semanticFastPathMinimumSamples)
      .filter((item) => item.exactWinningEpisodes >= this.semanticFastPathMinimumWinningEpisodes)
      .filter((item) => item.exactAverageReturn >= this.semanticFastPathMinimumAverageReturn)
      .filter((item) => item.exactPositiveRate >= this.semanticFastPathMinimumPositiveRate)
      .filter((item) => item.action && typeof item.action === "object")
      .sort((left, right) => right.exactAverageReturn - left.exactAverageReturn || right.exactReplaySamples - left.exactReplaySamples);
    if (!eligible.length) return null;
    const best = eligible[0];
    const rival = eligible[1];
    if (rival && rival.averageReturn >= best.averageReturn - 0.05 && rival.actionKey !== best.actionKey) return null;
    this.retrievalStats.fastPaths += 1;
    return {
      action: best.action,
      evidence: {
        samples: best.samples,
        trustedSamples: best.exactReplayTrustedSamples,
        winningEpisodes: best.exactWinningEpisodes,
        losingEpisodes: best.exactLosingEpisodes,
        averageReturn: best.exactAverageReturn,
        positiveRate: best.exactPositiveRate,
      },
    };
  }

  stats() {
    if (!this.db) return { enabled: false, policyVersion: SEMANTIC_POLICY_VERSION, episodes: 0, completedEpisodes: 0, transitions: 0, learnedTransitions: 0, hot: 0 };
    const episodes = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN outcome IN ('won', 'lost') THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN outcome = 'won' THEN 1 ELSE 0 END) AS won,
             SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
             SUM(CASE WHEN outcome = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
             MAX(max_hand_score) AS highest_hand_score,
             SUM(CASE WHEN outcome IN ('won', 'lost') AND max_hand_score >= 10000 THEN 1 ELSE 0 END) AS ten_thousand,
             SUM(CASE WHEN outcome IN ('won', 'lost') AND max_hand_score >= 100000 THEN 1 ELSE 0 END) AS hundred_thousand,
             SUM(CASE WHEN outcome IN ('won', 'lost') AND max_hand_score >= 1000000 THEN 1 ELSE 0 END) AS million
      FROM semantic_episodes
    `).get();
    const transitions = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN return_reward IS NOT NULL THEN 1 ELSE 0 END) AS learned,
             SUM(CASE WHEN terminal_outcome = 'won' THEN 1 ELSE 0 END) AS won,
             SUM(CASE WHEN terminal_outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
             SUM(CASE WHEN terminal_outcome = 'lost' AND return_reward > 0 THEN 1 ELSE 0 END) AS positiveLosses
      FROM semantic_reward_labels
      WHERE reward_version = ?
    `).get(SEMANTIC_REWARD_VERSION);
    const trajectoryVersions = this.db.prepare(`
      SELECT policy_version AS policyVersion, COUNT(*) AS transitions
      FROM semantic_experiences GROUP BY policy_version ORDER BY policy_version
    `).all().map((row) => ({
      policyVersion: Number(row.policyVersion),
      transitions: Number(row.transitions) || 0,
    }));
    return {
      enabled: true,
      policyVersion: SEMANTIC_POLICY_VERSION,
      rewardVersion: SEMANTIC_REWARD_VERSION,
      episodes: Number(episodes.total) || 0,
      completedEpisodes: Number(episodes.completed) || 0,
      wonEpisodes: Number(episodes.won) || 0,
      lostEpisodes: Number(episodes.lost) || 0,
      interruptedEpisodes: Number(episodes.interrupted) || 0,
      transitions: Number(transitions.total) || 0,
      learnedTransitions: Number(transitions.learned) || 0,
      wonTransitions: Number(transitions.won) || 0,
      lostTransitions: Number(transitions.lost) || 0,
      positiveLossTransitions: Number(transitions.positiveLosses) || 0,
      highestHandScore: Number(episodes.highest_hand_score) || 0,
      tenThousandEpisodes: Number(episodes.ten_thousand) || 0,
      hundredThousandEpisodes: Number(episodes.hundred_thousand) || 0,
      millionEpisodes: Number(episodes.million) || 0,
      hot: this.hot.length,
      retrievals: { ...this.retrievalStats },
      databasePath: this.databasePath,
      trajectoryVersions,
      rewardMigration: { ...this.rewardMigration },
    };
  }

  deckPerformance(stake = "") {
    if (!this.db) return [];
    const normalizedStake = String(stake ?? "").trim().toUpperCase();
    const rows = this.db.prepare(`
      SELECT UPPER(deck) AS deck,
             COUNT(*) AS trials,
             SUM(CASE WHEN outcome = 'won' THEN 1 ELSE 0 END) AS wins,
             AVG(max_ante) AS average_ante,
             AVG(max_round) AS average_round
      FROM semantic_episodes
      WHERE outcome IN ('won', 'lost')
        AND deck <> ''
        AND (? = '' OR UPPER(stake) = ?)
      GROUP BY UPPER(deck)
      ORDER BY UPPER(deck)
    `).all(normalizedStake, normalizedStake);
    return rows.map((row) => ({
      deck: row.deck,
      trials: Number(row.trials) || 0,
      wins: Number(row.wins) || 0,
      averageAnte: Number(row.average_ante) || 0,
      averageRound: Number(row.average_round) || 0,
    }));
  }

  topActions(limit = 10) {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT screen, action_method AS method, action_summary AS action,
             COUNT(*) AS samples,
             ROUND(AVG(labels.return_reward), 3) AS averageReturn,
             SUM(CASE WHEN labels.terminal_outcome = 'won' THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN labels.terminal_outcome = 'lost' THEN 1 ELSE 0 END) AS losses
      FROM semantic_experiences e
      JOIN semantic_reward_labels labels ON labels.experience_id = e.id
      WHERE labels.reward_version = ? AND labels.compatibility IN ('exact', 'semantic')
      GROUP BY e.screen, e.action_key
      ORDER BY samples DESC, averageReturn DESC
      LIMIT ?
    `).all(SEMANTIC_REWARD_VERSION, limit);
  }

  close() {
    this.db?.close();
    this.db = null;
    this.hot = [];
    this.cache.clear();
  }
}
