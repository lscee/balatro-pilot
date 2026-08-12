// Native Balatro 1.0.1o colours from game.lua/globals.lua. Small and Big
// Blind intentionally share the same table colour; each Boss owns its own.
const NORMAL_BLIND_COLOUR = "#50846e";
const WON_COLOUR = "#4f6367";

const BOSS_COLOURS = Object.freeze({
  "The Ox": "#b95b08",
  "The Hook": "#a84024",
  "The Mouth": "#ae718e",
  "The Fish": "#3e85bd",
  "The Club": "#b9cb92",
  "The Manacle": "#575757",
  "The Tooth": "#b52d2d",
  "The Wall": "#8a59a5",
  "The House": "#5186a8",
  "The Mark": "#6a3847",
  "The Wheel": "#50bf7c",
  "The Arm": "#6865f3",
  "The Psychic": "#efc03c",
  "The Goad": "#b95c96",
  "The Water": "#c6e0eb",
  "The Eye": "#4b71e4",
  "The Plant": "#709284",
  "The Needle": "#5c6e31",
  "The Head": "#ac9db4",
  "The Window": "#a9a295",
  "The Serpent": "#439a4f",
  "The Pillar": "#7e6752",
  "The Flint": "#e56a2f",
});

const SHOWDOWN_BLINDS = new Set(["Cerulean Bell", "Verdant Leaf", "Violet Vessel", "Amber Acorn", "Crimson Heart"]);
const PLAY_STATES = new Set(["SELECTING_HAND", "HAND_PLAYED", "DRAW_TO_HAND", "NEW_ROUND"]);

function rgb(hex) {
  const value = String(hex).replace(/^#/, "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function hex(values) {
  return `#${values.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

function mix(first, second, firstWeight) {
  const one = rgb(first);
  const two = rgb(second);
  return hex(one.map((value, index) => value * firstWeight + two[index] * (1 - firstWeight)));
}

function darken(colour, amount) {
  return mix(colour, "#000000", 1 - amount);
}

function alpha(colour, opacity) {
  return `${colour}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
}

function vibrant(colour) {
  const values = rgb(colour);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum;
  if (spread < 16) return "#9befff";
  const low = 78;
  const high = 245;
  return hex(values.map((value) => low + ((value - minimum) / spread) * (high - low)));
}

function palette(gameColour, specialColour = gameColour, accentColour = gameColour) {
  const accent = vibrant(accentColour);
  return Object.freeze({
    accent,
    accentBorder: alpha(accent, 0.62),
    accentFaint: alpha(accent, 0.09),
    panel: darken(gameColour, 0.89),
    panelSoft: darken(gameColour, 0.84),
    panelDeep: darken(gameColour, 0.94),
    cardStart: darken(gameColour, 0.78),
    cardEnd: darken(gameColour, 0.92),
    glow: alpha(accent, 0.2),
    specialGlow: alpha(vibrant(specialColour), specialColour === gameColour ? 0.05 : 0.08),
    line: alpha(accent, 0.38),
  });
}

function theme(id, label, gameState, gameColour, specialColour = gameColour, accentColour = gameColour) {
  return {
    id,
    label,
    gameState,
    gameColour,
    specialColour,
    accentColour,
    colors: palette(gameColour, specialColour, accentColour),
  };
}

function packTheme(state, gameState) {
  const cards = Array.isArray(state?.openedPack?.cards) ? state.openedPack.cards : [];
  const sets = new Set(cards.map((card) => String(card?.set ?? "").trim().toUpperCase()).filter(Boolean));

  // These are the exact Balatro 1.0.1o pack table colours. The final colour is
  // the neon accent; the panel base stays faithful to the pack background.
  if (sets.has("PLANET")) return theme("pack", "天体包", gameState, "#374244", "#374244", "#13afce");
  if (sets.has("TAROT")) return theme("pack", "塔罗包", gameState, "#8867a5", "#2c3536", "#a782d1");
  if (sets.has("SPECTRAL")) return theme("pack", "幽灵包", gameState, "#4584fa", "#2c3536", "#4584fa");
  if (sets.has("JOKER")) return theme("pack", "小丑包", gameState, "#ff9a00", "#374244", "#ff9a00");
  return theme("pack", "标准包", gameState, "#2c3536", "#fe5f55", "#fe5f55");
}

function currentBlind(state) {
  if (state?.blind) return state.blind;
  return Object.values(state?.blinds ?? {}).find((blind) => {
    const status = String(blind?.status ?? "").toUpperCase();
    return status.includes("CURRENT") || status.includes("SELECT");
  }) ?? null;
}

function isBoss(blind) {
  const type = String(blind?.type ?? "").trim().toUpperCase();
  const name = String(blind?.name ?? "").trim();
  return type.includes("BOSS") || BOSS_COLOURS[name] || SHOWDOWN_BLINDS.has(name);
}

function playTheme(blind, gameState) {
  const name = String(blind?.name ?? "").trim();
  if (!isBoss(blind)) return theme("normal", name || "普通盲注", gameState, NORMAL_BLIND_COLOUR);
  if (SHOWDOWN_BLINDS.has(name)) return theme("showdown", name, gameState, "#009cfd", "#ff4b40");
  const bossColour = BOSS_COLOURS[name] ?? "#b44430";
  return theme("boss", name || "Boss 盲注", gameState, bossColour);
}

/**
 * Mirror the game's actual table/background family, not the Blind-chip UI colour.
 * This remains presentation-only and makes no screenshot, model, or gameplay call.
 */
export function overlayThemeForState(state) {
  if (!state) return theme("neutral", "等待游戏", "UNKNOWN", "#374244");
  const gameState = String(state.state ?? "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
  const blind = currentBlind(state);

  // Balatro explicitly resets these screens to its ordinary green table.
  if (gameState === "SHOP") return theme("shop", "商店", gameState, NORMAL_BLIND_COLOUR);
  if (gameState === "ROUND_EVAL") return theme("result", "结算", gameState, NORMAL_BLIND_COLOUR);
  if (gameState === "BLIND_SELECT") return theme("select", "选择盲注", gameState, NORMAL_BLIND_COLOUR);
  if (gameState === "SMODS_BOOSTER_OPENED") return packTheme(state, gameState);
  if (gameState === "MENU") return theme("neutral", "主菜单", gameState, "#374244");
  if (gameState === "GAME_OVER") {
    if (state.won) return theme("won", "本局获胜", gameState, WON_COLOUR);
    return playTheme(blind, gameState);
  }
  if (PLAY_STATES.has(gameState) || blind) return playTheme(blind, gameState);
  return theme("neutral", "游戏中", gameState, "#374244");
}
