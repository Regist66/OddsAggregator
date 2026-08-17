import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { acquireWriterLocks, writeTextAtomically } from "./atomic_file.js";
import { envNumber } from "./numeric_config.js";
import { assessTippmixSnapshot } from "./sharpx_odds_monitor.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");

function configuredPath(name, fallback) {
  return path.resolve(process.env[name] ?? fallback);
}

const CONFIG = {
  directSnapshotFile: configuredPath(
    "TIPPMIXPRO_DIRECT_SNAPSHOT_FILE",
    path.join(DATA_DIR, "tippmixpro_direct_odds_snapshot.json"),
  ),
  headlessSnapshotFile: configuredPath(
    "TIPPMIXPRO_HEADLESS_SNAPSHOT_FILE",
    path.join(DATA_DIR, "tippmixpro_headless_odds_snapshot.json"),
  ),
  canonicalSnapshotFile: configuredPath(
    "TIPPMIXPRO_CANONICAL_SNAPSHOT_FILE",
    path.join(DATA_DIR, "tippmixpro_odds_snapshot.json"),
  ),
  healthFile: configuredPath(
    "TIPPMIXPRO_SELECTOR_HEALTH_FILE",
    path.join(DATA_DIR, "tippmixpro_production_health.json"),
  ),
  pollMs: envNumber("TIPPMIXPRO_SELECTOR_POLL_MS", 1_000, {
    integer: true,
    min: 100,
  }),
  snapshotMaxAgeMs: envNumber("TIPPMIXPRO_SELECTOR_SNAPSHOT_MAX_AGE_MS", 10_000, {
    integer: true,
    min: 1_000,
  }),
  sourceMaxAgeMs: envNumber("TIPPMIXPRO_SELECTOR_SOURCE_MAX_AGE_MS", 15_000, {
    integer: true,
    min: 1_000,
  }),
  futureToleranceMs: envNumber("TIPPMIXPRO_SELECTOR_FUTURE_TOLERANCE_MS", 5_000, {
    integer: true,
    min: 0,
  }),
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function readSnapshot(filename) {
  try {
    return { snapshot: JSON.parse(await fs.readFile(filename, "utf8")), error: null };
  } catch (error) {
    return { snapshot: null, error: error.code ?? error.message };
  }
}

function assessSource(read, now) {
  if (read.error) {
    return { snapshot: null, state: `read-${read.error}`, cacheKey: `read-${read.error}` };
  }
  return assessTippmixSnapshot(read.snapshot, {
    now,
    maxAgeMs: CONFIG.snapshotMaxAgeMs,
    sourceMaxAgeMs: CONFIG.sourceMaxAgeMs,
    futureToleranceMs: CONFIG.futureToleranceMs,
  });
}

function sourceHealth(read, assessment) {
  return {
    healthy: assessment.snapshot !== null,
    state: assessment.state,
    error: read.error,
    generatedAt: read.snapshot?.generatedAt ?? null,
    lastFrameAt: read.snapshot?.lastFrameAt ?? null,
    events: Array.isArray(read.snapshot?.events) ? read.snapshot.events.length : null,
  };
}

export function selectTippmixSnapshot({ direct, headless, now = Date.now() }) {
  const directAssessment = assessSource(direct, now);
  const headlessAssessment = assessSource(headless, now);
  let source = "unavailable";
  let assessment = directAssessment;

  if (directAssessment.snapshot) {
    source = "direct";
    assessment = directAssessment;
  } else if (headlessAssessment.snapshot) {
    source = "headless-fallback";
    assessment = headlessAssessment;
  } else {
    assessment = headlessAssessment;
  }

  const snapshot = assessment.snapshot
    ? {
        ...assessment.snapshot,
        productionSource: source,
        productionSourceState: assessment.state,
        productionSelectedAt: now,
      }
    : null;

  return {
    snapshot,
    source,
    direct: sourceHealth(direct, directAssessment),
    headless: sourceHealth(headless, headlessAssessment),
    selectedState: assessment.state,
  };
}

export function selectorHealth(result, now = Date.now()) {
  return {
    generatedAt: now,
    selectedSource: result.source,
    selectedState: result.selectedState,
    selectedGeneratedAt: result.snapshot?.generatedAt ?? null,
    direct: result.direct,
    headless: result.headless,
  };
}

async function main() {
  await fs.mkdir(path.dirname(CONFIG.canonicalSnapshotFile), { recursive: true });
  const writerLock = await acquireWriterLocks(
    [CONFIG.canonicalSnapshotFile, CONFIG.healthFile],
    "TippmixPro production selector",
  );
  let stopping = false;
  let lastSource = "";

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await writerLock.release();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  try {
    while (!stopping) {
      const now = Date.now();
      const [direct, headless] = await Promise.all([
        readSnapshot(CONFIG.directSnapshotFile),
        readSnapshot(CONFIG.headlessSnapshotFile),
      ]);
      const result = selectTippmixSnapshot({ direct, headless, now });
      await writeTextAtomically(
        CONFIG.healthFile,
        `${JSON.stringify(selectorHealth(result, now), null, 2)}\n`,
      );
      if (result.snapshot) {
        await writeTextAtomically(
          CONFIG.canonicalSnapshotFile,
          `${JSON.stringify(result.snapshot, null, 2)}\n`,
        );
      }
      if (result.source !== lastSource) {
        lastSource = result.source;
        console.log(
          `[selector] source=${result.source} state=${result.selectedState} ` +
          `direct=${result.direct.state} headless=${result.headless.state}`,
        );
      }
      await sleep(CONFIG.pollMs);
    }
  } finally {
    await stop();
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
