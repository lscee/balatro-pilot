import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

export class WindowsBridge {
  constructor(projectRoot, { timeoutMs = 15_000 } = {}) {
    this.scriptPath = path.join(projectRoot, "native", "windows-bridge.ps1");
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.pending = [];
    this.stderr = "";
  }

  async start() {
    if (process.platform !== "win32") {
      throw new Error("Balatro Pilot currently supports Windows only");
    }
    if (this.child) return;

    this.child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-12_000);
    });
    this.child.on("exit", (code) => {
      const reason = new Error(`Windows bridge exited with code ${code}. ${this.stderr}`.trim());
      for (const item of this.pending.splice(0)) item.reject(reason);
      this.child = null;
    });
    this.child.on("error", (error) => {
      for (const item of this.pending.splice(0)) item.reject(error);
    });

    await this.request({ command: "ping" }, 30_000);
  }

  #handleLine(line) {
    const item = this.pending.shift();
    if (!item) return;
    clearTimeout(item.timer);
    try {
      const response = JSON.parse(line);
      if (!response.ok) throw new Error(response.error || "Windows bridge command failed");
      item.resolve(response);
    } catch (error) {
      item.reject(new Error(`Invalid Windows bridge response: ${error.message}; line=${line}`));
    }
  }

  request(payload, timeoutMs = this.timeoutMs) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Windows bridge is not running"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.resolve === resolve);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error(`Windows bridge timed out while running ${payload.command}`));
      }, timeoutMs);
      this.pending.push({ resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }

  locate(title) {
    return this.request({ command: "locate", title });
  }

  async listWindows() {
    const response = await this.request({ command: "list_windows" });
    return {
      ...response,
      windows: (response.windows ?? []).map((item) => ({
        handle: item.handle ?? item.Handle,
        title: item.title ?? item.Title,
      })),
    };
  }

  focus() {
    return this.request({ command: "focus" });
  }

  capture({ includeImage = true } = {}) {
    return this.request({ command: "screenshot", includeImage }, 30_000);
  }

  detectUnlockOverlay() {
    return this.request({ command: "detect_unlock_overlay" }, 30_000);
  }

  move(x, y) {
    return this.request({ command: "move", x, y });
  }

  click(x, y, button = "left", count = 1) {
    return this.request({ command: "click", x, y, button, count });
  }

  key(key) {
    return this.request({ command: "key", key });
  }

  stopPressed() {
    return this.request({ command: "stop_pressed" });
  }

  async close() {
    if (!this.child) return;
    try {
      await this.request({ command: "exit" }, 2_000);
    } catch {
      // The process may exit before acknowledging; termination below is a fallback.
    }
    this.child?.kill();
    this.child = null;
  }
}
