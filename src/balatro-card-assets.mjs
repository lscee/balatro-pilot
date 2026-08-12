import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ARCHIVE_ENTRIES = Object.freeze({
  game: "game.lua",
  jokers: "resources/textures/2x/Jokers.png",
  tarots: "resources/textures/2x/Tarots.png",
});

export function findBalatroExecutable(explicitPath) {
  const configured = explicitPath || process.env.BALATRO_EXE;
  if (configured) {
    const candidate = configured.toLowerCase().endsWith(".exe") ? configured : path.join(configured, "Balatro.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "Steam", "steamapps", "common", "Balatro", "Balatro.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function archiveEntry(executable, entry, encoding = null) {
  if (!executable) throw new Error("Balatro.exe was not found");
  const result = spawnSync("tar.exe", ["-xOf", executable, entry], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(`Could not read ${entry} from the local Balatro installation`);
  }
  return result.stdout;
}

function pngDimensions(buffer) {
  const signature = "89504e470d0a1a0a";
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Balatro texture is not a valid PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export class BalatroCardAssets {
  constructor({ executablePath, readEntry = archiveEntry } = {}) {
    this.executablePath = findBalatroExecutable(executablePath);
    this.readEntry = readEntry;
    this.index = null;
    this.assets = new Map();
  }

  #loadIndex() {
    if (this.index) return this.index;
    const result = new Map();
    if (!this.executablePath) {
      this.index = result;
      return result;
    }
    const source = this.readEntry(this.executablePath, ARCHIVE_ENTRIES.game, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const key = line.match(/^\s*([a-z][a-z0-9_]*)\s*=/i)?.[1]?.toLowerCase();
      const position = line.match(/pos\s*=\s*\{\s*x\s*=\s*(\d+)\s*,\s*y\s*=\s*(\d+)\s*\}/i);
      if (!key || !position) continue;
      const atlas = key.startsWith("j_") ? "jokers" : key.startsWith("c_") ? "tarots" : null;
      if (!atlas) continue;
      result.set(key, { atlas, x: Number(position[1]), y: Number(position[2]) });
    }
    this.index = result;
    return result;
  }

  getAsset(atlas) {
    if (!Object.hasOwn(ARCHIVE_ENTRIES, atlas) || atlas === "game") return null;
    if (this.assets.has(atlas)) return this.assets.get(atlas);
    if (!this.executablePath) return null;
    const buffer = this.readEntry(this.executablePath, ARCHIVE_ENTRIES[atlas]);
    const dimensions = pngDimensions(buffer);
    const value = {
      buffer,
      width: dimensions.width,
      height: dimensions.height,
      columns: Math.round(dimensions.width / 142),
      rows: Math.round(dimensions.height / 190),
    };
    this.assets.set(atlas, value);
    return value;
  }

  decorateCard(card) {
    const position = this.#loadIndex().get(String(card?.key ?? "").toLowerCase());
    if (!position) return { ...card, art: null };
    const asset = this.getAsset(position.atlas);
    if (!asset) return { ...card, art: null };
    return {
      ...card,
      art: {
        url: `/assets/game/${position.atlas}.png`,
        x: position.x,
        y: position.y,
        columns: asset.columns,
        rows: asset.rows,
      },
    };
  }
}
