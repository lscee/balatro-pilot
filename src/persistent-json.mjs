import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function localAppDataFile(...segments) {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(root, "BalatroPilot", ...segments);
}

export function readJsonFile(filePath, fallback, isValid = () => true) {
  try {
    const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    const value = JSON.parse(source);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}
