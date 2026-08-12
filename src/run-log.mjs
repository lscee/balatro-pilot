import fs from "node:fs";
import path from "node:path";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class RunLog {
  constructor(projectRoot, mode) {
    this.dir = path.join(projectRoot, "runs", `${timestamp()}-${mode}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.eventsPath = path.join(this.dir, "events.ndjson");
  }

  screenshot(step, base64) {
    const file = path.join(this.dir, `step-${String(step).padStart(4, "0")}.png`);
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
    return file;
  }

  event(type, data = {}) {
    fs.appendFileSync(
      this.eventsPath,
      `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`,
      "utf8",
    );
  }
}
