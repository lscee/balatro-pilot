import { byId, drawCardArt, setConnection, setText, startOverlay } from "/overlay/common.js?v=stream-v15";

function typeLabel(card) {
  const set = String(card.set ?? "").toUpperCase();
  if (set === "JOKER") return "JOKER";
  if (set === "TAROT") return "TAROT";
  if (set === "PLANET") return "PLANET";
  if (set === "SPECTRAL") return "SPECTRAL";
  return set || "CARD";
}

function createCard(card) {
  const tile = document.createElement("article");
  tile.className = `build-card ${String(card.set ?? "card").toLowerCase()}`;

  const badge = document.createElement("span");
  badge.className = "card-kind";
  badge.textContent = typeLabel(card);

  const artFrame = document.createElement("div");
  artFrame.className = "card-art-frame";
  const canvas = document.createElement("canvas");
  canvas.className = "card-art";
  canvas.width = 142;
  canvas.height = 190;
  canvas.setAttribute("aria-label", `${card.label} 卡图`);
  if (!drawCardArt(canvas, card)) {
    artFrame.classList.add("art-missing");
    const fallback = document.createElement("strong");
    fallback.textContent = String(card.label ?? "?").slice(0, 1);
    artFrame.append(fallback);
  } else {
    artFrame.append(canvas);
  }

  const name = document.createElement("h2");
  name.textContent = card.label || card.key || "未知卡牌";
  const effect = document.createElement("p");
  effect.textContent = card.effect || "暂无效果说明";

  const tags = document.createElement("div");
  tags.className = "card-tags";
  for (const value of [card.edition, card.enhancement, card.eternal ? "永恒" : null, card.rental ? "租用" : null].filter(Boolean)) {
    const tag = document.createElement("span");
    tag.textContent = value;
    tags.append(tag);
  }

  tile.append(badge, artFrame, name, effect, tags);
  return tile;
}

function render(snapshot) {
  setConnection(byId("cards-status"), snapshot);
  const state = snapshot.state;
  const jokers = state?.jokers?.cards ?? [];
  const consumables = state?.consumables?.cards ?? [];
  setText("joker-count", `${jokers.length} / ${state?.jokers?.limit ?? 5}`);
  setText("consumable-count", `${consumables.length} / ${state?.consumables?.limit ?? 2}`);

  const grid = byId("card-grid");
  grid.replaceChildren();
  const cards = [...jokers, ...consumables];
  grid.className = `card-grid count-${Math.min(8, Math.max(1, cards.length))}`;
  if (!cards.length) {
    const empty = document.createElement("div");
    empty.className = "empty-build";
    const title = document.createElement("strong");
    title.textContent = state ? "当前没有持有小丑牌或消耗牌" : "正在读取当前牌组";
    const detail = document.createElement("span");
    detail.textContent = state ? "购买后会立即出现在这里" : "控制器开始记录后会自动显示";
    empty.append(title, detail);
    grid.append(empty);
    return;
  }
  for (const card of cards) grid.append(createCard(card));
}

startOverlay(render);
