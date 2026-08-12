function signatureBytes(value) {
  if (typeof value !== "string" || !value) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length ? bytes : null;
}

function cellDistances(left, right, cellBytes = 2) {
  const a = signatureBytes(left);
  const b = signatureBytes(right);
  if (!a || !b || a.length !== b.length || a.length % cellBytes !== 0) return null;

  const result = new Float64Array(a.length / cellBytes);
  for (let cell = 0; cell < result.length; cell++) {
    let total = 0;
    const offset = cell * cellBytes;
    for (let channel = 0; channel < cellBytes; channel++) {
      total += Math.abs(a[offset + channel] - b[offset + channel]);
    }
    result[cell] = total / (cellBytes * 255);
  }
  return result;
}

export function frameDifference(left, right) {
  const a = signatureBytes(left);
  const b = signatureBytes(right);
  if (!a || !b || a.length !== b.length) return 1;

  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
  return total / (a.length * 255);
}

export function signatureRegionDifference(left, right, x, y, radiusColumns = 2, radiusRows = 3, cellBytes = 2) {
  const a = signatureBytes(left);
  const b = signatureBytes(right);
  if (!a || !b || a.length !== b.length || a.length % cellBytes !== 0) return 1;
  const columns = 32;
  const rows = a.length / cellBytes / columns;
  if (!Number.isFinite(x) || !Number.isFinite(y) || rows < 1) return 1;
  const centerColumn = Math.max(0, Math.min(columns - 1, Math.floor(x * columns)));
  const centerRow = Math.max(0, Math.min(rows - 1, Math.floor(y * rows)));
  const leftColumn = Math.max(0, centerColumn - radiusColumns);
  const rightColumn = Math.min(columns - 1, centerColumn + radiusColumns);
  const topRow = Math.max(0, centerRow - radiusRows);
  const bottomRow = Math.min(rows - 1, centerRow + radiusRows);
  let total = 0;
  let count = 0;
  for (let row = topRow; row <= bottomRow; row++) {
    for (let column = leftColumn; column <= rightColumn; column++) {
      const offset = (row * columns + column) * cellBytes;
      for (let channel = 0; channel < cellBytes; channel++) {
        total += Math.abs(a[offset + channel] - b[offset + channel]);
        count += 1;
      }
    }
  }
  return count ? total / (count * 255) : 1;
}

export function stableCellRatio(left, right, threshold, cellBytes = 2) {
  const distances = cellDistances(left, right, cellBytes);
  if (!distances) return 0;
  let stable = 0;
  for (const distance of distances) if (distance <= threshold) stable += 1;
  return stable / distances.length;
}

function buildReference(left, right, stableThreshold, cellBytes) {
  const a = signatureBytes(left);
  const b = signatureBytes(right);
  const distances = cellDistances(left, right, cellBytes);
  if (!a || !b || !distances) return null;

  const values = Buffer.alloc(a.length);
  const stable = new Uint8Array(distances.length);
  for (let index = 0; index < values.length; index++) values[index] = Math.round((a[index] + b[index]) / 2);
  for (let cell = 0; cell < distances.length; cell++) stable[cell] = distances[cell] <= stableThreshold ? 1 : 0;
  return { values, stable, cellBytes };
}

function referenceChange(previous, current, changedCellThreshold) {
  if (!previous || !current || previous.values.length !== current.values.length || previous.cellBytes !== current.cellBytes) {
    return { ratio: 1, coverage: 0 };
  }

  let compared = 0;
  let changed = 0;
  for (let cell = 0; cell < previous.stable.length; cell++) {
    if (!previous.stable[cell] || !current.stable[cell]) continue;
    compared += 1;
    let total = 0;
    const offset = cell * current.cellBytes;
    for (let channel = 0; channel < current.cellBytes; channel++) {
      total += Math.abs(previous.values[offset + channel] - current.values[offset + channel]);
    }
    if (total / (current.cellBytes * 255) >= changedCellThreshold) changed += 1;
  }
  if (!compared) return { ratio: 1, coverage: 0 };
  return { ratio: changed / compared, coverage: compared / previous.stable.length };
}

async function gateSleep(ms, bridge, signal) {
  let remaining = ms;
  while (remaining > 0) {
    if (signal?.aborted) throw new Error("Stopped by Ctrl+C");
    const stop = await bridge.stopPressed();
    if (stop.pressed) throw new Error("Emergency stop: F8 is pressed");
    const chunk = Math.min(remaining, 200);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

export class FrameGate {
  constructor(config) {
    this.enabled = config.frameGateEnabled;
    this.probeMs = config.frameProbeMs;
    this.stableSamples = config.frameStableSamples;
    this.stableThreshold = config.frameStableThreshold;
    this.requiredStableRatio = config.frameStableRatio;
    this.changedCellThreshold = config.frameChangeCellThreshold;
    this.requiredChangeRatio = config.frameChangeThreshold;
    this.timeoutMs = config.frameGateTimeoutMs;
  }

  async next({
    bridge,
    previousReference = null,
    requireChange = false,
    signal,
    onProbe = () => {},
  }) {
    if (!this.enabled) {
      const capture = await bridge.capture();
      return {
        capture,
        reference: null,
        changed: true,
        stable: true,
        forced: false,
        probes: 0,
        waitedMs: 0,
        stabilityRatio: 1,
        changeRatio: 1,
      };
    }

    const startedAt = Date.now();
    let previousProbe = null;
    let latestProbe = null;
    let latestReference = null;
    let stableCount = 0;
    let probes = 0;
    let stabilityRatio = 0;
    let change = { ratio: requireChange ? 0 : 1, coverage: 0 };

    while (true) {
      if (signal?.aborted) throw new Error("Stopped by Ctrl+C");
      const stop = await bridge.stopPressed();
      if (stop.pressed) throw new Error("Emergency stop: F8 is pressed");

      latestProbe = await bridge.capture({ includeImage: false });
      probes += 1;
      if (!latestProbe.signature) throw new Error("Windows bridge did not return a frame signature");

      if (previousProbe) {
        const cellBytes = latestProbe.signatureCellBytes ?? previousProbe.signatureCellBytes ?? 2;
        stabilityRatio = stableCellRatio(
          previousProbe.signature,
          latestProbe.signature,
          this.stableThreshold,
          cellBytes,
        );
        latestReference = buildReference(
          previousProbe.signature,
          latestProbe.signature,
          this.stableThreshold,
          cellBytes,
        );
        stableCount = stabilityRatio >= this.requiredStableRatio ? stableCount + 1 : 0;
        change = previousReference
          ? referenceChange(previousReference, latestReference, this.changedCellThreshold)
          : { ratio: 1, coverage: latestReference ? 1 : 0 };
      }

      const changed = !previousReference || change.ratio >= this.requiredChangeRatio;
      const changeSatisfied = !requireChange || changed;
      onProbe({ probes, changed, stableCount, stabilityRatio, changeRatio: change.ratio, coverage: change.coverage });

      if (previousProbe && changeSatisfied && stableCount >= this.stableSamples) {
        const capture = await bridge.capture();
        const cellBytes = capture.signatureCellBytes ?? latestProbe.signatureCellBytes ?? 2;
        const finalStability = stableCellRatio(
          latestProbe.signature,
          capture.signature,
          this.stableThreshold,
          cellBytes,
        );
        if (finalStability >= this.requiredStableRatio) {
          return {
            capture,
            reference: buildReference(latestProbe.signature, capture.signature, this.stableThreshold, cellBytes),
            changed,
            stable: true,
            forced: false,
            probes: probes + 1,
            waitedMs: Date.now() - startedAt,
            stabilityRatio: finalStability,
            changeRatio: change.ratio,
            referenceCoverage: change.coverage,
          };
        }
        previousProbe = capture;
        stableCount = 0;
      } else {
        previousProbe = latestProbe;
      }

      if (Date.now() - startedAt >= this.timeoutMs) {
        const capture = await bridge.capture();
        const anchor = latestProbe ?? capture;
        const cellBytes = capture.signatureCellBytes ?? anchor.signatureCellBytes ?? 2;
        return {
          capture,
          reference: buildReference(anchor.signature, capture.signature, this.stableThreshold, cellBytes),
          changed,
          stable: false,
          forced: true,
          probes: probes + 1,
          waitedMs: Date.now() - startedAt,
          stabilityRatio: stableCellRatio(anchor.signature, capture.signature, this.stableThreshold, cellBytes),
          changeRatio: change.ratio,
          referenceCoverage: change.coverage,
        };
      }

      await gateSleep(this.probeMs, bridge, signal);
    }
  }
}
