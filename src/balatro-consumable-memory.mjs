function runtimeCardId(card) {
  const rawId = card?.id;
  if (rawId == null || rawId === "") return null;
  const id = Number(rawId);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function roundNumber(state) {
  const round = Number(state?.round_num ?? state?.roundNumber);
  return Number.isInteger(round) && round >= 0 ? round : null;
}

function seedValue(state) {
  const seed = String(state?.seed ?? "").trim();
  return seed || null;
}

/**
 * Process-local, fail-closed ownership age for consumables.
 *
 * Runtime card ids are the only stable identity: area indices move and keys
 * can repeat. Age advances once when the global round number advances while
 * the same exact card remains owned. It is deliberately not hydrated from
 * historical runs, because a repeated seed is still a new ownership attempt.
 */
export class BalatroOwnedConsumableAgeTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.seed = null;
    this.lastRound = null;
    this.entries = new Map();
    return this.snapshot();
  }

  observe(state) {
    if (state?.state === "MENU") return this.reset();

    const seed = seedValue(state);
    if (seed && this.seed && seed !== this.seed) this.reset();
    if (seed) this.seed = seed;
    if (!this.seed) return this.snapshot();

    const round = roundNumber(state);
    if (round != null && this.lastRound != null && round < this.lastRound) {
      // Same-seed restarts can bypass MENU. A backwards global round is a
      // conservative new-attempt signal; never carry sale age across it.
      const currentSeed = seed ?? this.seed;
      this.reset();
      this.seed = currentSeed;
    }

    const area = state?.consumables;
    if (!area || !Array.isArray(area.cards)) {
      if (round != null) this.lastRound = round;
      return this.snapshot();
    }

    const idCounts = new Map();
    for (const card of area.cards) {
      const id = runtimeCardId(card);
      if (id != null) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }

    const next = new Map();
    for (const card of area.cards) {
      const id = runtimeCardId(card);
      if (id == null || idCounts.get(id) !== 1) continue;
      const key = String(card?.key ?? "").trim().toLowerCase();
      const set = String(card?.set ?? "").trim().toUpperCase();
      const previous = this.entries.get(id);
      const sameCard = previous && previous.key === key && previous.set === set;
      const blindAge = sameCard && round != null && previous.lastSeenRound != null && round > previous.lastSeenRound
        ? previous.blindAge + 1
        : sameCard
          ? previous.blindAge
          : 0;
      next.set(id, {
        id,
        key,
        set,
        blindAge,
        firstSeenRound: sameCard ? previous.firstSeenRound : round,
        firstSeenAnte: sameCard ? previous.firstSeenAnte : Number(state?.ante_num ?? state?.ante) || null,
        lastSeenRound: round ?? previous?.lastSeenRound ?? null,
      });
    }
    this.entries = next;
    if (round != null) this.lastRound = round;
    return this.snapshot();
  }

  snapshot() {
    const byId = {};
    for (const [id, entry] of this.entries) byId[id] = Object.freeze({ ...entry, tracked: true });
    return Object.freeze({
      seed: this.seed,
      roundNumber: this.lastRound,
      byId: Object.freeze(byId),
    });
  }
}
