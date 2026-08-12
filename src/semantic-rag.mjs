import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  SEMANTIC_POLICY_VERSION,
  semanticActionKey,
  semanticActionSummary,
  semanticActionTemplate,
  semanticDiscountedReturns,
  semanticExactFingerprint,
  semanticHighScoreTier,
  semanticPlayedHandScore,
  semanticReplayFingerprint,
  semanticStateBucket,
  semanticStateFeatures,
  semanticStateSimilarity,
  semanticStateText,
  semanticTransitionReward,
} from "./semantic-experience.mjs";

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

function hotEntry(row) {
  return {
    id: Number(row.id),
    episodeId: row.episode_id,
    screen: row.screen,
    stateFingerprint: row.state_fingerprint,
    replayFingerprint: row.replay_fingerprint,
    stateBucket: row.state_bucket,
    stateText: row.state_text,
    features: parseJson(row.features_json, {}),
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
    `);
    const episodeColumns = new Set(
      this.db.prepare("PRAGMA table_info(semantic_episodes)").all().map((column) => String(column.name)),
    );
    if (!episodeColumns.has("max_hand_score")) {
      this.db.exec("ALTER TABLE semantic_episodes ADD COLUMN max_hand_score REAL NOT NULL DEFAULT 0");
    }
    this.#loadHot();
  }

  #loadHot() {
    if (!this.db) return;
    const rows = this.db.prepare(`
      SELECT id, episode_id, screen, state_fingerprint, replay_fingerprint, state_bucket, state_text, features_json,
             action_key, action_method, action_json, action_template_json, action_summary, policy_source,
             strategy, memory, immediate_reward, return_reward, terminal_outcome, next_state_text
      FROM semantic_experiences
      WHERE return_reward IS NOT NULL
        AND terminal_outcome IN ('won', 'lost')
        AND policy_version = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(SEMANTIC_POLICY_VERSION, this.hotLimit);
    this.hot = rows.map(hotEntry);
    this.cache.clear();
  }

  get size() {
    return this.hot.length;
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
        policyVersion: SEMANTIC_POLICY_VERSION,
      };
    }
    const features = semanticStateFeatures(state);
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
    let truncated = false;
    for (const entry of this.hot) {
      if (entry.screen !== state.state) continue;
      if ((searched & 63) === 0 && performance.now() - startedAt >= budgetMs) {
        truncated = true;
        break;
      }
      searched += 1;
      const similarity = semanticStateSimilarity(features, entry.features);
      if (similarity < this.minimumSimilarity) continue;
      candidates.push({ entry, similarity });
    }
    candidates.sort((left, right) => right.similarity - left.similarity || right.entry.id - left.entry.id);

    const groupMap = new Map();
    for (const candidate of candidates) {
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
      if (entry.replayFingerprint === replayFingerprint) {
        group.exactReplaySamples += 1;
        group.exactReplayTrustedSamples += trustedSource(entry.source) ? 1 : 0;
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
      WHERE policy_version = ?
    `).get(SEMANTIC_POLICY_VERSION);
    const transitions = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN return_reward IS NOT NULL THEN 1 ELSE 0 END) AS learned,
             SUM(CASE WHEN terminal_outcome = 'won' THEN 1 ELSE 0 END) AS won,
             SUM(CASE WHEN terminal_outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
             SUM(CASE WHEN terminal_outcome = 'lost' AND return_reward > 0 THEN 1 ELSE 0 END) AS positiveLosses
      FROM semantic_experiences
      WHERE policy_version = ?
    `).get(SEMANTIC_POLICY_VERSION);
    return {
      enabled: true,
      policyVersion: SEMANTIC_POLICY_VERSION,
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
      WHERE policy_version = ?
        AND outcome IN ('won', 'lost')
        AND deck <> ''
        AND (? = '' OR UPPER(stake) = ?)
      GROUP BY UPPER(deck)
      ORDER BY UPPER(deck)
    `).all(SEMANTIC_POLICY_VERSION, normalizedStake, normalizedStake);
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
             ROUND(AVG(return_reward), 3) AS averageReturn,
             SUM(CASE WHEN terminal_outcome = 'won' THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN terminal_outcome = 'lost' THEN 1 ELSE 0 END) AS losses
      FROM semantic_experiences
      WHERE return_reward IS NOT NULL AND policy_version = ?
      GROUP BY screen, action_key
      ORDER BY samples DESC, averageReturn DESC
      LIMIT ?
    `).all(SEMANTIC_POLICY_VERSION, limit);
  }

  close() {
    this.db?.close();
    this.db = null;
    this.hot = [];
    this.cache.clear();
  }
}
