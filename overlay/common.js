const formatter = new Intl.NumberFormat("zh-CN");
const GAME_THEMES = new Set(["neutral", "normal", "boss", "showdown", "shop", "pack", "result", "select", "won"]);
const THEME_PROPERTIES = Object.freeze({
  accent: "--theme-accent",
  accentBorder: "--theme-accent-border",
  accentFaint: "--theme-accent-faint",
  panel: "--theme-panel",
  panelSoft: "--theme-panel-soft",
  panelDeep: "--theme-panel-deep",
  cardStart: "--theme-card-start",
  cardEnd: "--theme-card-end",
  glow: "--theme-glow",
  specialGlow: "--theme-special-glow",
  line: "--theme-line",
});
const SAFE_COLOUR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu;

export function applyGameTheme(snapshot) {
  const requested = String(snapshot?.theme?.id ?? "neutral").toLowerCase();
  const theme = GAME_THEMES.has(requested) ? requested : "neutral";
  const root = document.documentElement;
  root.dataset.gameTheme = theme;
  root.dataset.gameState = String(snapshot?.theme?.gameState ?? "UNKNOWN");
  for (const property of Object.values(THEME_PROPERTIES)) root.style.removeProperty(property);
  for (const [key, property] of Object.entries(THEME_PROPERTIES)) {
    const value = String(snapshot?.theme?.colors?.[key] ?? "").trim();
    if (SAFE_COLOUR.test(value)) root.style.setProperty(property, value);
  }
}

export function formatNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? formatter.format(amount) : "—";
}

export function byId(id) {
  return document.getElementById(id);
}

export function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
}

export function setConnection(element, snapshot) {
  if (!element) return;
  element.classList.toggle("online", Boolean(snapshot.connected));
  element.classList.toggle("offline", !snapshot.connected);
  element.lastChild.textContent = snapshot.connected ? "实时同步" : snapshot.runId ? "日志已暂停" : "等待控制器";
}

export async function startOverlay(render, { intervalMs = 750 } = {}) {
  let stopped = false;
  const tick = async () => {
    try {
      const response = await fetch("/api/overlay", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      const pageVersion = document.documentElement.dataset.overlayVersion;
      if (pageVersion && snapshot.uiVersion && pageVersion !== snapshot.uiVersion) {
        window.location.reload();
        return;
      }
      applyGameTheme(snapshot);
      render(snapshot);
    } catch (error) {
      const offline = { connected: false, error: error.message, state: null, strategy: null, thinking: null };
      applyGameTheme(offline);
      render(offline);
    }
    if (!stopped) window.setTimeout(tick, intervalMs);
  };
  tick();
  return () => { stopped = true; };
}

const imageCache = new Map();

function atlasImage(url) {
  if (!imageCache.has(url)) {
    const image = new Image();
    image.src = url;
    imageCache.set(url, image);
  }
  return imageCache.get(url);
}

export function drawCardArt(canvas, card) {
  const art = card?.art;
  if (!canvas || !art) return false;
  const image = atlasImage(art.url);
  const draw = () => {
    const width = image.naturalWidth / art.columns;
    const height = image.naturalHeight / art.rows;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, art.x * width, art.y * height, width, height, 0, 0, canvas.width, canvas.height);
  };
  if (image.complete && image.naturalWidth) draw();
  else image.addEventListener("load", draw, { once: true });
  return true;
}
