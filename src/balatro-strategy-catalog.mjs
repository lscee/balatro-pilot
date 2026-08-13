// State-aware strategic knowledge for mechanics that are important to a run
// but cannot honestly be reduced to the conservative hand-score equation.

function cards(area) {
  return Array.isArray(area?.cards) ? area.cards : [];
}

function keyOf(card) {
  return String(card?.key ?? "").trim().toLowerCase();
}

function finite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function stateNumber(state, camel, snake, fallback = 0) {
  return finite(state?.[camel], state?.[snake]) ?? fallback;
}

function roundNumber(state, camel, snake, fallback = 0) {
  return finite(state?.round?.[camel], state?.round?.[snake]) ?? fallback;
}

function currentAnte(state) {
  return Math.max(1, stateNumber(state, "ante", "ante_num", 1));
}

function remainingShops(state) {
  const ante = currentAnte(state);
  const round = Math.max(0, stateNumber(state, "roundNumber", "round_num", 0));
  const completedInAnte = round > 0 ? round % 3 : 0;
  return Math.max(1, (8 - ante) * 3 + Math.max(0, 3 - completedInAnte));
}

function usedVoucherKeys(state) {
  const value = state?.usedVouchers ?? state?.used_vouchers ?? {};
  if (Array.isArray(value)) return new Set(value.map((item) => keyOf(item) || String(item).toLowerCase()));
  return new Set(Object.keys(value && typeof value === "object" ? value : {}).map((key) => key.toLowerCase()));
}

function unlockedVoucherKeys(state) {
  const knowledge = state?.collection_knowledge ?? state?.collectionKnowledge ?? {};
  const raw = knowledge?.unlockedVouchers ?? knowledge?.unlocked_vouchers ?? [];
  return new Set((Array.isArray(raw) ? raw : Object.keys(raw ?? {})).map((item) => keyOf(item) || String(item).toLowerCase()));
}

function blankPurchases(state) {
  const knowledge = state?.collection_knowledge ?? state?.collectionKnowledge ?? {};
  const progress = knowledge?.voucherProgress ?? knowledge?.voucher_progress ?? state?.voucherProgress ?? state?.voucher_progress ?? {};
  if (Array.isArray(progress)) {
    const antimatter = progress.find((item) => keyOf(item) === "v_antimatter");
    const current = finite(
      antimatter?.progress?.current,
      antimatter?.current,
      antimatter?.blankPurchases,
      antimatter?.blank_purchases,
    );
    if (current != null) return current;
  }
  return finite(
    progress?.blankPurchases,
    progress?.blank_purchases,
    progress?.v_blank,
    knowledge?.blankVoucherPurchases,
    knowledge?.blank_voucher_purchases,
  );
}

function activeBlind(state) {
  return [state?.blinds?.small, state?.blinds?.big, state?.blinds?.boss]
    .filter(Boolean)
    .find((blind) => /CURRENT|SELECT/iu.test(String(blind?.status ?? ""))) ?? state?.blinds?.boss ?? null;
}

function mostPlayedHand(state) {
  const hands = state?.pokerHands ?? state?.hands ?? {};
  return Object.entries(hands).reduce((best, [name, hand]) => {
    const played = finite(hand?.played, hand?.played_total) ?? 0;
    return !best || played > best.played ? { name, played } : best;
  }, null);
}

function missingBuildLayers(state) {
  const missing = state?.highScoreTraining?.missing ?? state?.high_score_training?.missing;
  return Array.isArray(missing) ? missing.length : 0;
}

function normalizedVoucherResult(key, category, grossValue, price, rationale, details = {}) {
  const cost = Math.max(0, Number(price) || 0);
  return Object.freeze({
    key,
    known: true,
    category,
    value: Math.max(0, Math.round(grossValue - cost * 18)),
    grossValue: Math.max(0, Math.round(grossValue)),
    price: cost,
    rationale,
    requiresStrategic: true,
    ...details,
  });
}

/**
 * Estimate the run value of a voucher from exact state. This deliberately
 * evaluates utility (remaining shops, slots, actions and progression) rather
 * than pretending a voucher is immediate hand score.
 */
export function balatrobotVoucherValue(state, voucher, { price = null } = {}) {
  const key = keyOf(voucher);
  const buyPrice = finite(price, voucher?.cost?.buy, voucher?.buy) ?? 10;
  const shops = remainingShops(state);
  const money = Math.max(0, stateNumber(state, "money", "money", 0));
  const hands = Math.max(1, roundNumber(state, "handsLeft", "hands_left", 4));
  const discards = Math.max(0, roundNumber(state, "discardsLeft", "discards_left", 3));
  const consumables = cards(state?.consumables);
  const consumableLimit = Math.max(consumables.length, finite(state?.consumables?.limit, state?.consumables?.card_limit) ?? 2);
  const jokerCount = cards(state?.jokers).length;
  const jokerLimit = Math.max(jokerCount, finite(state?.jokers?.limit, state?.jokers?.card_limit) ?? 5);
  const primary = mostPlayedHand(state);
  const gaps = missingBuildLayers(state);
  const used = usedVoucherKeys(state);

  if (key === "v_blank") {
    const progress = blankPurchases(state);
    const antimatterUnlocked = unlockedVoucherKeys(state).has("v_antimatter") || used.has("v_antimatter");
    const gross = antimatterUnlocked ? 0 : progress == null ? 180 : 110 + Math.max(0, Math.min(9, progress)) * 105;
    const status = antimatterUnlocked
      ? "Antimatter is already unlocked; Blank has no current-run effect"
      : progress == null
        ? "Blank unlock progress is unavailable; preserve it as a collection decision"
        : `${Math.max(0, progress)}/10 Blank purchases recorded toward Antimatter`;
    return normalizedVoucherResult(key, "progression", gross, buyPrice, status, {
      progressKnown: progress != null,
      blankPurchases: progress,
      antimatterUnlocked,
    });
  }

  if (key === "v_antimatter") {
    const full = jokerCount >= jokerLimit;
    return normalizedVoucherResult(key, "joker-slot", full ? 2_100 : 1_650, buyPrice,
      `Permanent Joker slot; currently ${jokerCount}/${jokerLimit}${full ? " and immediately unlocks a blocked build slot" : ""}`);
  }

  if (["v_clearance_sale", "v_liquidation"].includes(key)) {
    const discount = key === "v_liquidation" ? 0.5 : 0.25;
    const futureSpend = Math.max(8, Math.min(30, money + 8));
    const gross = 360 + shops * futureSpend * discount * 7;
    return normalizedVoucherResult(key, "economy", gross, buyPrice,
      `${Math.round(discount * 100)}% shop discount across about ${shops} remaining shops`);
  }

  if (["v_seed_money", "v_money_tree"].includes(key)) {
    const cap = key === "v_money_tree" ? 20 : 10;
    const currentInterest = Math.min(cap, Math.floor(money / 5));
    const oldCap = key === "v_money_tree" ? 10 : 5;
    const incremental = Math.max(0, currentInterest - oldCap);
    const gross = 260 + shops * (incremental * 75 + Math.max(0, money - oldCap * 5) * 1.4);
    return normalizedVoucherResult(key, "economy", gross, buyPrice,
      `Raises the interest ceiling to $${cap}; current cash is $${money}`);
  }

  if (["v_crystal_ball", "v_omen_globe"].includes(key)) {
    const full = consumables.length >= consumableLimit;
    const gross = key === "v_crystal_ball"
      ? 620 + (full ? 520 : consumables.length * 90)
      : 680 + shops * 25 + gaps * 70;
    return normalizedVoucherResult(key, key === "v_crystal_ball" ? "consumable-slot" : "pack", gross, buyPrice,
      key === "v_crystal_ball"
        ? `Adds a consumable slot; currently ${consumables.length}/${consumableLimit}`
        : "Spectral cards in Arcana packs add high-upside build options but remain strategic");
  }

  if (["v_overstock_norm", "v_overstock_plus"].includes(key)) {
    const slots = finite(state?.shop?.limit, state?.shop?.card_limit) ?? cards(state?.shop).length;
    const gross = 520 + shops * (key === "v_overstock_plus" ? 72 : 48) + gaps * 65;
    return normalizedVoucherResult(key, "shop-slot", gross, buyPrice,
      `Adds one shop offer across about ${shops} remaining shops; current offer limit ${slots}`);
  }

  if (["v_grabber", "v_nacho_tong"].includes(key)) {
    const gross = 900 + Math.max(0, 4 - hands) * 310 + currentAnte(state) * 32;
    return normalizedVoucherResult(key, "hands", gross, buyPrice,
      `Permanent extra hand improves survival and income; current round has ${hands} hands`);
  }

  if (["v_wasteful", "v_recyclomancy"].includes(key)) {
    const gross = 620 + Math.max(0, 3 - discards) * 190 + (primary?.played ? 100 : 0);
    return normalizedVoucherResult(key, "discards", gross, buyPrice,
      `Permanent extra discard improves hand consistency; current round has ${discards} discards`);
  }

  if (["v_paint_brush", "v_palette"].includes(key)) {
    const handLimit = finite(state?.hand?.limit, state?.hand?.card_limit) ?? 8;
    const gross = 780 + Math.max(0, 8 - handLimit) * 170 + currentAnte(state) * 25;
    return normalizedVoucherResult(key, "hand-size", gross, buyPrice,
      `Permanent hand-size increase improves draw quality; current hand limit ${handLimit}`);
  }

  if (["v_telescope", "v_observatory"].includes(key)) {
    const heldMatchingPlanet = consumables.some((card) => String(card?.effect ?? "").toLowerCase().includes(String(primary?.name ?? "").toLowerCase()));
    const gross = key === "v_telescope"
      ? 560 + Math.min(12, primary?.played ?? 0) * 52
      : 760 + (heldMatchingPlanet ? 620 : 0) + Math.min(12, primary?.played ?? 0) * 28;
    return normalizedVoucherResult(key, "poker-hand", gross, buyPrice,
      `${key === "v_telescope" ? "Celestial packs guarantee" : "Held matching Planets multiply"} the established ${primary?.name ?? "most-played"} route`);
  }

  if (["v_tarot_merchant", "v_tarot_tycoon", "v_planet_merchant", "v_planet_tycoon"].includes(key)) {
    const tarot = key.includes("tarot");
    const multiplier = key.endsWith("tycoon") ? 4 : 2;
    const route = tarot ? "deck shaping and economy" : `${primary?.name ?? "primary hand"} upgrades`;
    return normalizedVoucherResult(key, "shop-pool", 430 + shops * multiplier * 28 + (tarot ? 80 : Math.min(10, primary?.played ?? 0) * 25), buyPrice,
      `${multiplier}x ${tarot ? "Tarot" : "Planet"} shop frequency supports ${route}`);
  }

  if (["v_magic_trick", "v_illusion"].includes(key)) {
    const deckBuild = cards(state?.remainingDeck ?? state?.cards).filter((card) => card?.enhancement || card?.edition || card?.seal).length;
    return normalizedVoucherResult(key, "deck-shaping", 300 + shops * 18 + deckBuild * 20, buyPrice,
      "Adds playing-card offers; useful only when the run can exploit deliberate deck shaping");
  }

  if (["v_hone", "v_glow_up"].includes(key)) {
    const editions = cards(state?.jokers).filter((card) => card?.edition || card?.modifier?.edition).length;
    const multiplier = key === "v_glow_up" ? 4 : 2;
    return normalizedVoucherResult(key, "edition", 450 + shops * multiplier * 22 + editions * 70, buyPrice,
      `${multiplier}x edition frequency improves future Joker and playing-card quality`);
  }

  if (["v_hieroglyph", "v_petroglyph"].includes(key)) {
    const penaltyResource = key === "v_hieroglyph" ? hands : discards;
    const penalty = penaltyResource <= 1 ? 850 : penaltyResource === 2 ? 420 : 160;
    const ante = currentAnte(state);
    const gross = Math.max(60, 1_350 - ante * 55 - penalty + gaps * 120);
    return normalizedVoucherResult(key, "ante", gross, buyPrice,
      `Lowers Ante by one but permanently loses one ${key === "v_hieroglyph" ? "hand" : "discard"}; current count ${penaltyResource}`,
      { destructiveTradeoff: true });
  }

  if (["v_reroll_surplus", "v_reroll_glut"].includes(key)) {
    const discount = 2;
    const rerollCost = Math.max(0, roundNumber(state, "rerollCost", "reroll_cost", 5));
    const likelyRerolls = Math.min(shops * 1.5, 3 + gaps * 2 + currentAnte(state) / 2);
    return normalizedVoucherResult(key, "reroll", 320 + discount * likelyRerolls * 62 + Math.max(0, rerollCost - 5) * 45, buyPrice,
      `Cuts rerolls by $2; current reroll is $${rerollCost} with ${gaps} missing build layers`);
  }

  if (["v_directors_cut", "v_retcon"].includes(key)) {
    const boss = state?.blinds?.boss ?? activeBlind(state);
    const dangerous = Boolean(String(boss?.effect ?? "").trim());
    const unlimited = key === "v_retcon";
    return normalizedVoucherResult(key, "boss-reroll", 520 + (dangerous ? 360 : 0) + (unlimited ? 260 : 0), buyPrice,
      `${unlimited ? "Unlimited" : "Once-per-Ante"} Boss rerolls; upcoming ${boss?.name ?? "Boss"}${dangerous ? " has an active restriction" : ""}`);
  }

  return Object.freeze({
    key,
    known: false,
    category: "unknown",
    value: Math.max(0, 300 - buyPrice * 18),
    grossValue: 300,
    price: buyPrice,
    rationale: "Unknown voucher: require strategic review and do not assume a fixed value",
    requiresStrategic: true,
  });
}

export const voucherValue = balatrobotVoucherValue;

const BEHAVIORAL_JOKERS = Object.freeze({
  j_dna: Object.freeze({
    kind: "first-hand-deck-copy",
    phase: "first-hand",
    constraint: "DNA triggers only when the first hand of the round contains exactly one card; take the setup hand only when the remaining hands still clear the blind.",
  }),
  j_burnt: Object.freeze({
    kind: "first-discard-hand-upgrade",
    phase: "first-discard",
    constraint: "Burnt Joker upgrades the poker hand represented by the first discard; choose that discard deliberately for the build, then re-evaluate survival.",
  }),
  j_trading: Object.freeze({
    kind: "first-discard-destroy-economy",
    phase: "first-discard",
    constraint: "Trading Card requires the first discard to contain exactly one card; prefer a low-value deck cut only when losing it does not damage the build.",
  }),
  j_sixth_sense: Object.freeze({
    kind: "first-hand-six-to-spectral",
    phase: "first-hand",
    constraint: "Sixth Sense requires the first hand to be exactly one 6 and needs consumable space; spend that setup hand only with enough score margin.",
  }),
  j_vagabond: Object.freeze({
    kind: "low-cash-tarot-generation",
    phase: "play",
    constraint: "Vagabond generates Tarot only while cash is $4 or less and a consumable slot is open; compare the Tarot value against interest and shop purchasing power.",
  }),
  j_luchador: Object.freeze({
    kind: "sell-disable-boss",
    phase: "boss",
    constraint: "Luchador can be sold to disable the current Boss blind; selling is destructive and requires strategic approval based on the exact Boss restriction.",
  }),
  j_mr_bones: Object.freeze({
    kind: "quarter-score-loss-prevention",
    phase: "play",
    constraint: "Mr. Bones prevents defeat only after reaching at least 25% of the blind target and then destroys itself; treat that threshold as a survival floor, not scoring.",
  }),
  j_selzer: Object.freeze({
    kind: "temporary-played-card-retrigger",
    phase: "play",
    constraint: "Seltzer retriggers every played card for a limited number of hands; exploit scoring-card effects while it remains, but do not project it as permanent.",
  }),
  j_ancient: Object.freeze({
    kind: "round-suit-xmult",
    phase: "play",
    constraint: "Ancient Joker grants XMult only to the currently named suit and changes suit each round; the visible current suit must be checked before choosing a hand.",
  }),
});

function consumableHasSpace(state) {
  const count = cards(state?.consumables).length;
  const limit = finite(state?.consumables?.limit, state?.consumables?.card_limit) ?? 2;
  return count < limit;
}

function behavioralJokerActive(key, state) {
  const handsPlayed = Math.max(0, roundNumber(state, "handsPlayed", "hands_played", 0));
  const discardsUsed = Math.max(0, roundNumber(state, "discardsUsed", "discards_used", 0));
  const discardsLeft = Math.max(0, roundNumber(state, "discardsLeft", "discards_left", 0));
  if (["j_dna", "j_sixth_sense"].includes(key)) return handsPlayed === 0;
  if (["j_burnt", "j_trading"].includes(key)) return discardsUsed === 0 && discardsLeft > 0;
  if (key === "j_vagabond") return stateNumber(state, "money", "money", 0) <= 4 && consumableHasSpace(state);
  if (key === "j_luchador") return String(activeBlind(state)?.type ?? "").toUpperCase() === "BOSS";
  if (key === "j_mr_bones") return Boolean(activeBlind(state));
  return true;
}

export function balatrobotJokerCapability(joker, state = {}) {
  const key = keyOf(joker);
  const definition = BEHAVIORAL_JOKERS[key];
  if (!definition) return null;
  return Object.freeze({
    key,
    label: String(joker?.label ?? key),
    ...definition,
    activeNow: behavioralJokerActive(key, state),
    requiresStrategic: !["j_selzer", "j_ancient"].includes(key),
    exactScoreSupported: false,
  });
}

export function balatrobotJokerTacticalContext(state) {
  const capabilities = cards(state?.jokers)
    .map((joker) => balatrobotJokerCapability(joker, state))
    .filter(Boolean);
  const active = capabilities.filter((capability) => capability.activeNow);
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    active: Object.freeze(active),
    constraints: Object.freeze(active.map((capability) => capability.constraint)),
    requiresStrategic: active.some((capability) => capability.requiresStrategic),
  });
}
