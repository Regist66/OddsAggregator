import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireWriterLocks, writeTextAtomically } from "./atomic_file.js";
import { envNumber } from "./numeric_config.js";
import {
  assessTippmixSnapshot,
  assessVegasSnapshot,
  composeRenderedOutput,
  createStatusSnapshot,
  createWatchlist,
  refreshTeamAliases,
  renderSummary,
  renderSurebets,
} from "./sharpx_odds_monitor.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");

function configuredPath(name, fallback) {
  return path.resolve(process.env[name] ?? fallback);
}

const CONFIG = {
  sharpXSnapshotFile: configuredPath(
    "DIRECT_SHARPX_SNAPSHOT_FILE",
    path.join(DATA_DIR, "direct-primary", "sharpx_raw_snapshot.json"),
  ),
  tippmixSnapshotFile: configuredPath(
    "DIRECT_TIPPMIXPRO_SNAPSHOT_FILE",
    path.join(DATA_DIR, "direct-primary", "tippmixpro_raw_snapshot.json"),
  ),
  vegasSnapshotFile: configuredPath(
    "DIRECT_VEGAS_SNAPSHOT_FILE",
    path.join(DATA_DIR, "direct-primary", "vegas_raw_snapshot.json"),
  ),
  outputFile: configuredPath(
    "DIRECT_PRIMARY_OUTPUT_FILE",
    path.join(DATA_DIR, "direct-primary", "combined_odds.txt"),
  ),
  surebetsOutputFile: configuredPath(
    "DIRECT_PRIMARY_SUREBETS_OUTPUT_FILE",
    path.join(DATA_DIR, "direct-primary", "football", "surebets_live_odds.txt"),
  ),
  watchlistFile: configuredPath(
    "DIRECT_PRIMARY_WATCHLIST_FILE",
    path.join(DATA_DIR, "direct-primary", "sharpx_watchlist.json"),
  ),
  statusSnapshotFile: configuredPath(
    "DIRECT_PRIMARY_STATUS_FILE",
    path.join(DATA_DIR, "direct-primary", "sharpx_status_snapshot.json"),
  ),
  healthFile: configuredPath(
    "DIRECT_PRIMARY_HEALTH_FILE",
    path.join(DATA_DIR, "direct-primary", "direct_primary_health.json"),
  ),
  teamAliasesFile: configuredPath(
    "TEAM_ALIASES_FILE",
    path.join(PROJECT_DIR, "config", "team_aliases.json"),
  ),
  outputIntervalMs: envNumber("DIRECT_PRIMARY_OUTPUT_INTERVAL_MS", 1_000, {
    integer: true,
    min: 100,
  }),
  prematchRenderMs: envNumber("DIRECT_PRIMARY_PREMATCH_RENDER_MS", 5_000, {
    integer: true,
    min: 100,
  }),
  sharpXSnapshotMaxAgeMs: envNumber("DIRECT_SHARPX_SNAPSHOT_MAX_AGE_MS", 10_000, {
    integer: true,
    min: 1_000,
  }),
  bookmakerSnapshotMaxAgeMs: envNumber("DIRECT_BOOKMAKER_SNAPSHOT_MAX_AGE_MS", 10_000, {
    integer: true,
    min: 1_000,
  }),
  tippmixSourceMaxAgeMs: envNumber("DIRECT_TIPPMIXPRO_SOURCE_MAX_AGE_MS", 30_000, {
    integer: true,
    min: 1_000,
  }),
  vegasSourceMaxAgeMs: envNumber("DIRECT_VEGAS_SOURCE_MAX_AGE_MS", 10_000, {
    integer: true,
    min: 1_000,
  }),
  vegasEventMaxAgeMs: envNumber("DIRECT_VEGAS_EVENT_MAX_AGE_MS", 15_000, {
    integer: true,
    min: 1_000,
  }),
  futureToleranceMs: envNumber("DIRECT_SNAPSHOT_FUTURE_TOLERANCE_MS", 5_000, {
    integer: true,
    min: 0,
  }),
  minimumCoverageRatio: envNumber("DIRECT_PRIMARY_MIN_COVERAGE_RATIO", 0.90, {
    min: 0,
    max: 1,
  }),
  durationMs: envNumber("DIRECT_PRIMARY_DURATION_HOURS", 0, {
    min: 0,
    max: 720,
  }) * 3_600_000,
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function readJsonSnapshot(filename) {
  try {
    const stats = await fs.stat(filename);
    return {
      ok: true,
      fileAgeMs: Math.max(0, Date.now() - stats.mtimeMs),
      snapshot: JSON.parse(await fs.readFile(filename, "utf8")),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      fileAgeMs: null,
      snapshot: null,
      error: error.code ?? error.message,
    };
  }
}

function timestampFreshness(value, now, maxAgeMs) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "timestamp-missing";
  const ageMs = now - timestamp;
  if (ageMs > maxAgeMs) return "stale";
  if (ageMs < -CONFIG.futureToleranceMs) return "future-timestamp";
  return "fresh";
}

function directSharpXCoverage(snapshot) {
  const subscribedMarkets = Number(snapshot?.subscribedMarkets);
  const initializedMarkets = Number(snapshot?.initializedMarkets);
  const diagnostics = snapshot?.marketDiagnostics;
  const counts = diagnostics?.counts;
  const hasDiagnostics = diagnostics && typeof diagnostics === "object" && counts && typeof counts === "object";
  const renderableCoverageRatio = Number.isInteger(subscribedMarkets) && subscribedMarkets > 0
    && Number.isInteger(initializedMarkets)
    ? initializedMarkets / subscribedMarkets
    : null;

  if (!hasDiagnostics) {
    return {
      subscribedMarkets: Number.isInteger(subscribedMarkets) ? subscribedMarkets : null,
      initializedMarkets: Number.isInteger(initializedMarkets) ? initializedMarkets : null,
      renderableCoverageRatio,
      catalogueCoverageRatio: renderableCoverageRatio,
      notRenderableMarkets: null,
      blockingMissingMarkets: null,
      accountingMatches: null,
      diagnosticsAvailable: false,
    };
  }

  const notRenderableMarkets = Number(counts["not-renderable"]);
  const notReadyMarkets = Number(counts["not-ready"]);
  const staleMarkets = Number(counts.stale);
  const closedMarkets = Number(counts.closed);
  const missingOutputMarkets = Number(diagnostics.missingOutputMarkets);
  const accountingMatches = diagnostics.subscribedAccountingMatches === true;
  const validDiagnosticCounts = [
    notRenderableMarkets,
    notReadyMarkets,
    staleMarkets,
    closedMarkets,
    missingOutputMarkets,
  ].every(value => Number.isInteger(value) && value >= 0);
  const blockingMissingMarkets = validDiagnosticCounts
    ? notReadyMarkets + staleMarkets + closedMarkets
    : null;
  const accountedMarkets = validDiagnosticCounts
    ? initializedMarkets + notRenderableMarkets + blockingMissingMarkets
    : null;
  const catalogueCoverageRatio = Number.isInteger(subscribedMarkets)
    && subscribedMarkets > 0
    && Number.isInteger(accountedMarkets)
    ? accountedMarkets / subscribedMarkets
    : null;

  return {
    subscribedMarkets: Number.isInteger(subscribedMarkets) ? subscribedMarkets : null,
    initializedMarkets: Number.isInteger(initializedMarkets) ? initializedMarkets : null,
    renderableCoverageRatio,
    catalogueCoverageRatio,
    notRenderableMarkets: Number.isInteger(notRenderableMarkets) ? notRenderableMarkets : null,
    blockingMissingMarkets,
    accountingMatches,
    diagnosticsAvailable: true,
    accountedMarkets,
    missingOutputMarkets: Number.isInteger(missingOutputMarkets) ? missingOutputMarkets : null,
  };
}

function assessSharpXSnapshot(side, now) {
  const snapshot = side.snapshot;
  const reasons = [];
  if (!side.ok) reasons.push(`read-${side.error}`);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    reasons.push("document-invalid");
    return { snapshot: null, state: reasons.join(","), reasons };
  }
  if (!Array.isArray(snapshot.markets)) reasons.push("markets-unavailable");
  if (timestampFreshness(snapshot.generatedAt, now, CONFIG.sharpXSnapshotMaxAgeMs) !== "fresh") {
    reasons.push("snapshot-stale");
  }
  const coverage = directSharpXCoverage(snapshot);
  const subscribed = coverage.subscribedMarkets;
  const initialized = coverage.initializedMarkets;
  const degradedReasons = [];
  if (!Number.isInteger(subscribed) || subscribed <= 0) reasons.push("coverage-unavailable");
  else if (!Number.isInteger(initialized) || initialized < 0 || initialized > subscribed) {
    reasons.push("coverage-invalid");
  } else if (coverage.diagnosticsAvailable) {
    if (!coverage.accountingMatches || coverage.accountedMarkets !== subscribed) {
      degradedReasons.push("coverage-accounting-invalid");
    }
    if (coverage.blockingMissingMarkets > 0) {
      degradedReasons.push("coverage-incomplete");
    }
    if (coverage.renderableCoverageRatio < CONFIG.minimumCoverageRatio) {
      reasons.push("coverage-low");
    }
  } else if (coverage.renderableCoverageRatio < CONFIG.minimumCoverageRatio) {
    reasons.push("coverage-low");
  }
  if (reasons.length > 0) return { snapshot: null, state: reasons.join(","), reasons, degradedReasons, coverage };
  return {
    snapshot,
    state: degradedReasons.length > 0 ? "fresh-degraded" : "fresh",
    reasons,
    degradedReasons,
    coverage,
  };
}

function emptySharpXSnapshot(now) {
  return {
    generatedAt: now,
    generation: null,
    subscribedMarkets: 0,
    initializedMarkets: 0,
    lastCatalogueRefreshAt: null,
    lastError: null,
    markets: [],
  };
}

function sourceSummary(side, assessment) {
  return {
    ok: side.ok,
    fileAgeMs: side.fileAgeMs,
    state: assessment.state,
    error: side.error,
    generatedAt: assessment.snapshot?.generatedAt ?? side.snapshot?.generatedAt ?? null,
    events: Array.isArray(assessment.snapshot?.events) ? assessment.snapshot.events.length : null,
    markets: Array.isArray(assessment.snapshot?.markets) ? assessment.snapshot.markets.length : null,
    coverage: assessment.coverage ?? null,
  };
}

export { assessSharpXSnapshot, directSharpXCoverage };

async function writeOutput(filename, content) {
  await writeTextAtomically(filename, content);
}

async function main() {
  await fs.mkdir(path.dirname(CONFIG.surebetsOutputFile), { recursive: true });
  const writerLock = await acquireWriterLocks(
    [
      CONFIG.outputFile,
      CONFIG.surebetsOutputFile,
      CONFIG.watchlistFile,
      CONFIG.statusSnapshotFile,
      CONFIG.healthFile,
    ],
    "Direct primary aggregator",
  );
  let stopping = false;
  let writing = false;
  let prematchCache = null;
  let lastHealthSignature = "";

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await writerLock.release();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  const writeCycle = async () => {
    if (writing || stopping) return;
    writing = true;
    const now = Date.now();
    try {
      const [sharpXRead, tippmixRead, vegasRead] = await Promise.all([
        readJsonSnapshot(CONFIG.sharpXSnapshotFile),
        readJsonSnapshot(CONFIG.tippmixSnapshotFile),
        readJsonSnapshot(CONFIG.vegasSnapshotFile),
      ]);
      await refreshTeamAliases();

      const sharpXAssessment = assessSharpXSnapshot(sharpXRead, now);
      const tippmixAssessment = tippmixRead.error
        ? { snapshot: null, state: `read-${tippmixRead.error}`, cacheKey: `read-${tippmixRead.error}` }
        : assessTippmixSnapshot(tippmixRead.snapshot, {
            now,
            maxAgeMs: CONFIG.bookmakerSnapshotMaxAgeMs,
            sourceMaxAgeMs: CONFIG.tippmixSourceMaxAgeMs,
            futureToleranceMs: CONFIG.futureToleranceMs,
          });
      const vegasAssessment = vegasRead.error
        ? { snapshot: null, state: `read-${vegasRead.error}`, cacheKey: `read-${vegasRead.error}` }
        : assessVegasSnapshot(vegasRead.snapshot, {
            now,
            maxAgeMs: CONFIG.bookmakerSnapshotMaxAgeMs,
            sourceMaxAgeMs: CONFIG.vegasSourceMaxAgeMs,
            eventMaxAgeMs: CONFIG.vegasEventMaxAgeMs,
            futureToleranceMs: CONFIG.futureToleranceMs,
          });

      const health = {
        generatedAt: now,
        sources: {
          sharpx: sourceSummary(sharpXRead, sharpXAssessment),
          tippmixpro: sourceSummary(tippmixRead, tippmixAssessment),
          vegas: sourceSummary(vegasRead, vegasAssessment),
        },
        output: {
          file: CONFIG.outputFile,
          surebetsFile: CONFIG.surebetsOutputFile,
        },
      };
      await writeOutput(CONFIG.healthFile, `${JSON.stringify(health, null, 2)}\n`);
      const healthSignature = JSON.stringify(health.sources);
      if (healthSignature !== lastHealthSignature) {
        lastHealthSignature = healthSignature;
        console.log(`[health] ${Object.entries(health.sources).map(([name, item]) => `${name}=${item.state}`).join(" ")}`);
      }

      if (!sharpXAssessment.snapshot) return;
      const snapshot = sharpXAssessment.snapshot;
      await Promise.all([
        writeOutput(CONFIG.watchlistFile, `${JSON.stringify(createWatchlist(snapshot), null, 2)}\n`),
        writeOutput(CONFIG.statusSnapshotFile, `${JSON.stringify(createStatusSnapshot(snapshot), null, 2)}\n`),
      ]);

      const tippmixSnapshot = tippmixAssessment.snapshot;
      const vegasSnapshot = vegasAssessment.snapshot;
      const bookmakerCacheKey = `${tippmixAssessment.cacheKey ?? tippmixAssessment.state}|${vegasAssessment.cacheKey ?? vegasAssessment.state}`;
      const liveMarkets = snapshot.markets.filter(market => market.inPlay === true);
      const liveSignature = liveMarkets.map(market => market.marketId).sort().join(",");
      const needsPrematchRefresh =
        !prematchCache ||
        now - prematchCache.updatedAt >= CONFIG.prematchRenderMs ||
        prematchCache.liveSignature !== liveSignature ||
        prematchCache.bookmakerCacheKey !== bookmakerCacheKey;

      if (liveMarkets.length === 0 && !needsPrematchRefresh) return;
      if (needsPrematchRefresh) {
        const visiblePrematchMarkets = snapshot.markets.filter(
          market => market.inPlay !== true && Number(market.marketStartTime) > snapshot.generatedAt,
        );
        const prematchMarkets = snapshot.markets.filter(market => market.inPlay !== true);
        prematchCache = {
          updatedAt: now,
          liveSignature,
          bookmakerCacheKey,
          summary: renderSummary({ ...snapshot, markets: visiblePrematchMarkets }, tippmixSnapshot, vegasSnapshot),
          surebets: renderSurebets({ ...snapshot, markets: prematchMarkets }, tippmixSnapshot, vegasSnapshot),
        };
      }

      const liveSummary = renderSummary({ ...snapshot, markets: liveMarkets }, tippmixSnapshot, vegasSnapshot);
      const liveSurebets = renderSurebets({ ...snapshot, markets: liveMarkets }, tippmixSnapshot, vegasSnapshot);
      const rendered = {
        content: composeRenderedOutput(
          `*** ${new Date(snapshot.generatedAt).toISOString()} ***`,
          liveSummary.content,
          prematchCache.summary.content,
        ),
        tippmixMatches: liveSummary.tippmixMatches + prematchCache.summary.tippmixMatches,
        vegasMatches: liveSummary.vegasMatches + prematchCache.summary.vegasMatches,
        vegasEnhancedMatches: liveSummary.vegasEnhancedMatches + prematchCache.summary.vegasEnhancedMatches,
      };
      const surebets = {
        content: composeRenderedOutput(
          `*** SURE BETS - ${new Date(snapshot.generatedAt).toISOString()} ***`,
          liveSurebets.content,
          prematchCache.surebets.content,
        ),
        surebetEvents: liveSurebets.surebetEvents + prematchCache.surebets.surebetEvents,
      };
      await Promise.all([
        writeOutput(CONFIG.outputFile, rendered.content),
        writeOutput(CONFIG.surebetsOutputFile, surebets.content),
      ]);
      console.log(
        `[output] ${snapshot.initializedMarkets}/${snapshot.subscribedMarkets} markets ` +
        `TippmixPro=${rendered.tippmixMatches} Vegas=${rendered.vegasMatches} ` +
        `Vegas**=${rendered.vegasEnhancedMatches} surebets=${surebets.surebetEvents}`,
      );
    } catch (error) {
      console.error(`[output] ${error.stack ?? error.message ?? error}`);
    } finally {
      writing = false;
    }
  };

  try {
    await writeCycle();
    const startedAt = Date.now();
    while (!stopping && (!CONFIG.durationMs || Date.now() - startedAt < CONFIG.durationMs)) {
      await sleep(CONFIG.outputIntervalMs);
      await writeCycle();
    }
  } finally {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    await stop();
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
