import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { numericOption, validateNamedArguments } from "./numeric_config.js";

function argument(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  if (process.argv.indexOf(flag, index + 1) >= 0) {
    throw new Error(`Dupla CLI kapcsoló: ${flag}`);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Hiányzó érték: ${flag}`);
  return value;
}

function numberArgument(name, fallback, constraints = {}) {
  return numericOption(argument(name, String(fallback)), `--${name}`, {
    ...constraints,
  });
}

validateNamedArguments([
  "normal-file", "direct-file", "output-dir", "duration-hours", "interval-ms",
  "min-coverage-ratio", "max-observation-gap-ms", "evidence-grace-ms",
  "odds-time-tolerance-ms", "live-odds-time-tolerance-ms", "warmup-ms",
  "normal-max-content-age-ms", "direct-max-content-age-ms", "max-snapshot-skew-ms",
  "normal-min-coverage-ratio", "direct-min-coverage-ratio",
]);

const defaultMinimumCoverageRatio = numberArgument("min-coverage-ratio", 0.95, { min: 0, max: 1 });
const configuredIntervalMs = numberArgument("interval-ms", 1000, { integer: true, min: 100 });
const CONFIG = {
  normalFile: path.resolve(argument("normal-file", "data/sharpx_status_snapshot.json")),
  directFile: path.resolve(argument("direct-file", "data/sharpx-direct-shadow/sharpx_status_snapshot.json")),
  outputDir: path.resolve(argument("output-dir", "logs/sharpx-direct-shadow")),
  durationMs: numberArgument("duration-hours", 8, { min: 0, max: 720 }) * 3_600_000,
  intervalMs: configuredIntervalMs,
  maxObservationGapMs: numberArgument("max-observation-gap-ms", Math.max(3 * configuredIntervalMs, 5000), { integer: true, min: 1 }),
  evidenceGraceMs: numberArgument("evidence-grace-ms", 30000, { integer: true, min: 0 }),
  oddsTimeToleranceMs: numberArgument("odds-time-tolerance-ms", 3000, { integer: true, min: 0 }),
  liveOddsTimeToleranceMs: numberArgument("live-odds-time-tolerance-ms", 10000, { integer: true, min: 0 }),
  warmupMs: numberArgument("warmup-ms", 30000, { integer: true, min: 0 }),
  normalMaxContentAgeMs: numberArgument("normal-max-content-age-ms", 10000, { integer: true, min: 0 }),
  directMaxContentAgeMs: numberArgument("direct-max-content-age-ms", 5000, { integer: true, min: 0 }),
  maxSnapshotSkewMs: numberArgument("max-snapshot-skew-ms", 5000, { integer: true, min: 0 }),
  normalMinimumCoverageRatio: numberArgument("normal-min-coverage-ratio", defaultMinimumCoverageRatio, { min: 0, max: 1 }),
  directMinimumCoverageRatio: numberArgument("direct-min-coverage-ratio", defaultMinimumCoverageRatio, { min: 0, max: 1 }),
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function timestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function read(file) {
  let stats = null;
  try {
    stats = await fs.stat(file);
    const text = await fs.readFile(file, "utf8");
    return {
      ok: true,
      fileAgeMs: Math.max(0, Date.now() - stats.mtimeMs),
      document: JSON.parse(text),
    };
  } catch (error) {
    return {
      ok: false,
      fileAgeMs: stats ? Math.max(0, Date.now() - stats.mtimeMs) : null,
      error: error.code ?? error.message,
    };
  }
}

function numericOdds(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function odds(market) {
  if (Array.isArray(market.oneXTwoLayOdds)) return market.oneXTwoLayOdds.map(numericOdds);
  const runnerPrices = Array.isArray(market.runnerPrices) ? market.runnerPrices : [];
  const runners = Array.isArray(market.runners) ? market.runners : [];
  const prices = new Map(runnerPrices.filter(Boolean).map(item => [Number(item.selectionId), numericOdds(item.bestLay?.odds)]));
  const draw = runners.filter(Boolean).find(item => Number(item.selectionId) === 58805 || /(^|\s)draw($|\s)/i.test(item.runnerName));
  const teams = runners.filter(item => item && item !== draw);
  return [prices.get(Number(teams[0]?.selectionId)) ?? null, prices.get(Number(draw?.selectionId)) ?? null, prices.get(Number(teams[1]?.selectionId)) ?? null];
}

function marketTimestamp(market) {
  for (const value of [market.apiPt, market.oddsUpdatedAt, market.receivedAt]) {
    const parsed = timestamp(value);
    if (parsed) return parsed;
  }
  return null;
}

function marketEvidence(market) {
  if (!market) return null;
  return {
    marketId: market.marketId ?? null,
    eventId: market.eventId ?? null,
    eventName: market.eventName ?? null,
    competitionName: market.competitionName ?? null,
    startTime: Number(market.startTime ?? market.marketStartTime ?? 0) || null,
    inPlay: market.inPlay === true,
    status: market.status ?? null,
    betDelay: Number(market.betDelay ?? 0),
    odds: odds(market),
    apiPt: timestamp(market.apiPt),
    oddsUpdatedAt: marketTimestamp(market),
  };
}

function sideHealth(side, policy, now) {
  const document = side.document ?? {};
  const generatedAt = timestamp(document.generatedAt);
  const catalogueAt = timestamp(document.lastCatalogueRefreshAt);
  const subscribedMarkets = Number(document.subscribedMarkets);
  const initializedMarkets = Number(document.initializedMarkets);
  const hasMarketsArray = Array.isArray(document.markets);
  const marketCount = hasMarketsArray ? document.markets.length : 0;
  const marketEntriesValid = hasMarketsArray
    ? document.markets.every(market => market && typeof market === "object" && market.marketId !== null && market.marketId !== undefined)
    : null;
  const initializedMarketsMatchSnapshot = hasMarketsArray && Number.isFinite(initializedMarkets)
    ? initializedMarkets === marketCount
    : null;
  const hasCoverageCounters = Number.isFinite(subscribedMarkets)
    && Number.isFinite(initializedMarkets)
    && subscribedMarkets > 0
    && initializedMarkets >= 0
    && initializedMarkets <= subscribedMarkets;
  const coverageRatio = hasCoverageCounters ? initializedMarkets / subscribedMarkets : null;
  const contentAgeMs = generatedAt ? now - generatedAt : null;
  const unhealthyReasons = [];

  if (!side.ok) unhealthyReasons.push("read-failed");
  if (side.ok && !hasMarketsArray) unhealthyReasons.push("markets-unavailable");
  if (side.ok && marketEntriesValid === false) unhealthyReasons.push("market-entry-invalid");
  if (side.ok && !generatedAt) unhealthyReasons.push("generated-at-missing");
  if (side.ok && generatedAt && contentAgeMs < -1_000) unhealthyReasons.push("generated-at-future");
  if (side.ok && generatedAt && contentAgeMs > policy.maxContentAgeMs) unhealthyReasons.push("content-stale");
  if (side.ok && !hasCoverageCounters) unhealthyReasons.push("coverage-unavailable");
  if (side.ok && hasCoverageCounters && coverageRatio < policy.minimumCoverageRatio) unhealthyReasons.push("coverage-low");
  if (side.ok && initializedMarketsMatchSnapshot === false) unhealthyReasons.push("initialized-markets-mismatch");

  return {
    ok: side.ok,
    healthy: unhealthyReasons.length === 0,
    unhealthyReasons,
    error: side.error ?? null,
    // ageMs now means snapshot-content age for compatibility with older readers.
    ageMs: contentAgeMs,
    contentAgeMs,
    maxContentAgeMs: policy.maxContentAgeMs,
    fileAgeMs: side.fileAgeMs ?? null,
    markets: marketCount,
    hasMarketsArray,
    marketEntriesValid,
    initializedMarketsMatchSnapshot,
    generatedAt,
    catalogueRefreshAt: catalogueAt,
    catalogueAgeMs: catalogueAt ? Math.max(0, now - catalogueAt) : null,
    subscribedMarkets: Number.isFinite(subscribedMarkets) ? subscribedMarkets : null,
    initializedMarkets: Number.isFinite(initializedMarkets) ? initializedMarkets : null,
    coverageRatio,
    minimumCoverageRatio: policy.minimumCoverageRatio,
    lastError: document.lastError ?? null,
  };
}

function sameOdds(normalOdds, directOdds) {
  return normalOdds.length === directOdds.length
    && normalOdds.every((value, index) => value === directOdds[index]);
}

function classifyOdds(normalMarket, directMarket) {
  const normalOdds = odds(normalMarket);
  const directOdds = odds(directMarket);
  if (sameOdds(normalOdds, directOdds)) {
    return { kind: "same", confirmed: false, tolerated: false, normalOdds, directOdds };
  }

  const liveMarket = normalMarket?.inPlay === true || directMarket?.inPlay === true;
  const toleranceMs = liveMarket ? CONFIG.liveOddsTimeToleranceMs : CONFIG.oddsTimeToleranceMs;
  const normalApiPt = timestamp(normalMarket.apiPt);
  const directApiPt = timestamp(directMarket.apiPt);

  if (normalApiPt && directApiPt) {
    const apiPtDeltaMs = directApiPt - normalApiPt;
    if (apiPtDeltaMs === 0) {
      return {
        kind: "same-apiPt-different-odds", confirmed: true, tolerated: false,
        normalOdds, directOdds, normalTimestamp: normalApiPt, directTimestamp: directApiPt,
        timestampDeltaMs: 0, apiPtDeltaMs: 0, toleranceMs,
      };
    }
    const olderSide = apiPtDeltaMs > 0 ? "normal" : "direct";
    const tolerated = Math.abs(apiPtDeltaMs) <= toleranceMs;
    return {
      kind: tolerated ? `${olderSide}-older-apiPt-timing-tolerated` : `${olderSide}-older-apiPt`,
      confirmed: !tolerated, tolerated,
      normalOdds, directOdds, normalTimestamp: normalApiPt, directTimestamp: directApiPt,
      timestampDeltaMs: apiPtDeltaMs, apiPtDeltaMs, toleranceMs,
    };
  }

  const normalTime = marketTimestamp(normalMarket);
  const directTime = marketTimestamp(directMarket);
  if (!normalTime || !directTime) {
    return { kind: "unclassified", confirmed: false, tolerated: false, normalOdds, directOdds, toleranceMs };
  }
  const timestampDeltaMs = directTime - normalTime;
  if (timestampDeltaMs === 0) {
    return {
      kind: "same-timestamp-different-odds", confirmed: true, tolerated: false,
      normalOdds, directOdds, normalTimestamp: normalTime, directTimestamp: directTime,
      timestampDeltaMs: 0, apiPtDeltaMs: null, toleranceMs,
    };
  }
  const olderSide = timestampDeltaMs > 0 ? "normal" : "direct";
  const tolerated = Math.abs(timestampDeltaMs) <= toleranceMs;
  return {
    kind: tolerated ? `${olderSide}-older-timestamp-timing-tolerated` : `${olderSide}-older-timestamp`,
    confirmed: !tolerated, tolerated,
    normalOdds, directOdds, normalTimestamp: normalTime, directTimestamp: directTime,
    timestampDeltaMs, apiPtDeltaMs: null, toleranceMs,
  };
}

function trackEpisode(episodes, key, present, state, createEvidence, now, onObservationGapReset) {
  if (!present) {
    episodes.delete(key);
    return null;
  }

  let item = episodes.get(key);
  if (!item || item.state !== state) {
    item = { startedAt: now, lastObservedAt: now, validForMs: 0, reported: false, state };
    episodes.set(key, item);
  } else {
    const observationGapMs = item.lastObservedAt === null ? null : Math.max(0, now - item.lastObservedAt);
    if (observationGapMs !== null && observationGapMs > CONFIG.maxObservationGapMs) {
      onObservationGapReset?.(observationGapMs);
      item = { startedAt: now, lastObservedAt: now, validForMs: 0, reported: false, state };
      episodes.set(key, item);
    } else {
      if (observationGapMs !== null) item.validForMs += observationGapMs;
      item.lastObservedAt = now;
    }
  }

  if (item.reported || item.validForMs < CONFIG.evidenceGraceMs) return null;
  item.reported = true;
  return {
    visibleForMs: item.validForMs,
    wallClockVisibleForMs: now - item.startedAt,
    ...createEvidence(),
  };
}

function incrementReasonCounts(target, reasons) {
  for (const reason of reasons) target[reason] = (target[reason] ?? 0) + 1;
}

function marketsById(side) {
  const markets = side.document?.markets;
  if (!Array.isArray(markets)) return new Map();
  return new Map(markets
    .filter(market => market && typeof market === "object" && market.marketId !== null && market.marketId !== undefined)
    .map(market => [String(market.marketId), market]));
}

function emptyOddsCounts() {
  return {
    raw: 0,
    tolerated: 0,
    confirmed: 0,
    unclassified: 0,
    sameApiPtDifferent: 0,
    sameTimestampDifferent: 0,
    normalOlderApiPt: 0,
    directOlderApiPt: 0,
    normalOlderTimestamp: 0,
    directOlderTimestamp: 0,
    normalOlderTolerated: 0,
    directOlderTolerated: 0,
  };
}

function countOddsClassification(counts, classification) {
  counts.raw += 1;
  if (classification.tolerated) counts.tolerated += 1;
  else if (classification.confirmed) counts.confirmed += 1;
  else counts.unclassified += 1;

  if (classification.kind === "same-apiPt-different-odds") counts.sameApiPtDifferent += 1;
  if (classification.kind === "same-timestamp-different-odds") counts.sameTimestampDifferent += 1;
  if (classification.kind === "normal-older-apiPt") counts.normalOlderApiPt += 1;
  if (classification.kind === "direct-older-apiPt") counts.directOlderApiPt += 1;
  if (classification.kind === "normal-older-timestamp") counts.normalOlderTimestamp += 1;
  if (classification.kind === "direct-older-timestamp") counts.directOlderTimestamp += 1;
  if (classification.tolerated && classification.kind.startsWith("normal-older")) counts.normalOlderTolerated += 1;
  if (classification.tolerated && classification.kind.startsWith("direct-older")) counts.directOlderTolerated += 1;
}

async function main() {
  await fs.mkdir(CONFIG.outputDir, { recursive: true });
  const files = {
    health: path.join(CONFIG.outputDir, "health.jsonl"),
    evidence: path.join(CONFIG.outputDir, "market-evidence.jsonl"),
    summary: path.join(CONFIG.outputDir, "summary.json"),
  };
  const startedAt = Date.now();
  const presenceEpisodes = new Map();
  const oddsEpisodes = new Map();
  const stats = {
    samples: 0,
    validSamples: 0,
    invalidSamples: 0,
    readySamples: 0,
    staleSamples: 0,
    invalidSamplesByReason: {},
    normalOnlyMax: 0,
    directOnlyMax: 0,
    rawOddsMismatches: 0,
    timingToleratedOdds: 0,
    confirmedOddsMismatches: 0,
    unclassifiedOddsMismatches: 0,
    sameApiPtDifferentOdds: 0,
    sameTimestampDifferentOdds: 0,
    normalOlderApiPtOdds: 0,
    directOlderApiPtOdds: 0,
    normalOlderTimestampOdds: 0,
    directOlderTimestampOdds: 0,
    timingToleratedNormalOlderOdds: 0,
    timingToleratedDirectOlderOdds: 0,
    persistentPresenceEvidence: 0,
    persistentOddsEvidence: 0,
    presenceEpisodeObservationGapResets: 0,
    oddsEpisodeObservationGapResets: 0,
    maxResetObservationGapMs: 0,
  };

  while (Date.now() - startedAt < CONFIG.durationMs) {
    const now = Date.now();
    const [normal, direct] = await Promise.all([read(CONFIG.normalFile), read(CONFIG.directFile)]);
    const normalHealth = sideHealth(normal, {
      maxContentAgeMs: CONFIG.normalMaxContentAgeMs,
      minimumCoverageRatio: CONFIG.normalMinimumCoverageRatio,
    }, now);
    const directHealth = sideHealth(direct, {
      maxContentAgeMs: CONFIG.directMaxContentAgeMs,
      minimumCoverageRatio: CONFIG.directMinimumCoverageRatio,
    }, now);
    const invalidReasons = [];
    if (now - startedAt < CONFIG.warmupMs) invalidReasons.push("warmup");
    invalidReasons.push(...normalHealth.unhealthyReasons.map(reason => `normal-${reason}`));
    invalidReasons.push(...directHealth.unhealthyReasons.map(reason => `direct-${reason}`));
    const snapshotSkewMs = normalHealth.generatedAt && directHealth.generatedAt
      ? Math.abs(normalHealth.generatedAt - directHealth.generatedAt)
      : null;
    if (snapshotSkewMs !== null && snapshotSkewMs > CONFIG.maxSnapshotSkewMs) {
      invalidReasons.push("snapshot-skew-high");
    }
    const sampleValid = invalidReasons.length === 0;

    const normalById = marketsById(normal);
    const directById = marketsById(direct);
    const ids = new Set([...normalById.keys(), ...directById.keys()]);
    let normalOnly = 0;
    let directOnly = 0;
    let presenceEpisodeObservationGapResets = 0;
    let oddsEpisodeObservationGapResets = 0;
    const counts = emptyOddsCounts();

    for (const id of ids) {
      if (normalById.has(id) && !directById.has(id)) normalOnly += 1;
      if (directById.has(id) && !normalById.has(id)) directOnly += 1;
    }

    // A market that disappears from either successfully read snapshot cannot
    // keep an odds-difference episode alive, even across later reappearance.
    if (normal.ok && direct.ok) {
      for (const key of oddsEpisodes.keys()) {
        const id = key.slice("odds|".length);
        if (!normalById.has(id) || !directById.has(id)) oddsEpisodes.delete(key);
      }
    }

    if (!sampleValid) {
      // Evidence requires one uninterrupted sequence of comparable samples.
      // An unhealthy or excessively skewed snapshot pair restarts every grace
      // period instead of letting an old episode continue after the gap.
      presenceEpisodes.clear();
      oddsEpisodes.clear();
    } else {
      const activePresenceKeys = new Set();

      for (const id of ids) {
        const normalMarket = normalById.get(id);
        const directMarket = directById.get(id);
        const side = normalMarket && !directMarket ? "normal-only" : directMarket && !normalMarket ? "direct-only" : null;

        if (side) activePresenceKeys.add(`presence|${side}|${id}`);
        for (const candidate of ["normal-only", "direct-only"]) {
          const key = `presence|${candidate}|${id}`;
          const evidence = trackEpisode(
            presenceEpisodes,
            key,
            side === candidate,
            candidate,
            () => ({
              at: new Date(now).toISOString(),
              type: "persistent-market-presence",
              side: candidate,
              marketId: id,
              normal: marketEvidence(normalMarket),
              direct: marketEvidence(directMarket),
              normalSnapshot: normalHealth,
              directSnapshot: directHealth,
            }),
            now,
            observationGapMs => {
              presenceEpisodeObservationGapResets += 1;
              stats.presenceEpisodeObservationGapResets += 1;
              stats.maxResetObservationGapMs = Math.max(stats.maxResetObservationGapMs, observationGapMs);
            },
          );
          if (evidence) {
            stats.persistentPresenceEvidence += 1;
            await fs.appendFile(files.evidence, `${JSON.stringify(evidence)}\n`, "utf8");
          }
        }

        if (!normalMarket || !directMarket) {
          oddsEpisodes.delete(`odds|${id}`);
          continue;
        }

        const classification = classifyOdds(normalMarket, directMarket);
        if (classification.kind === "same") {
          oddsEpisodes.delete(`odds|${id}`);
          continue;
        }

        countOddsClassification(counts, classification);
        const episodeState = [
          classification.kind,
          normalMarket.inPlay === true ? "normal-live" : "normal-prematch",
          normalMarket.status ?? "normal-status-unknown",
          Number(normalMarket.betDelay ?? 0),
          directMarket.inPlay === true ? "direct-live" : "direct-prematch",
          directMarket.status ?? "direct-status-unknown",
          Number(directMarket.betDelay ?? 0),
        ].join("|");
        const evidence = trackEpisode(
          oddsEpisodes,
          `odds|${id}`,
          classification.confirmed,
          episodeState,
          () => ({
            at: new Date(now).toISOString(),
            type: "persistent-confirmed-odds-difference",
            marketId: id,
            classification: classification.kind,
            timestampDeltaMs: classification.timestampDeltaMs ?? null,
            apiPtDeltaMs: classification.apiPtDeltaMs ?? null,
            toleranceMs: classification.toleranceMs ?? null,
            normal: marketEvidence(normalMarket),
            direct: marketEvidence(directMarket),
            normalSnapshot: normalHealth,
            directSnapshot: directHealth,
          }),
          now,
          observationGapMs => {
            oddsEpisodeObservationGapResets += 1;
            stats.oddsEpisodeObservationGapResets += 1;
            stats.maxResetObservationGapMs = Math.max(stats.maxResetObservationGapMs, observationGapMs);
          },
        );
        if (evidence) {
          stats.persistentOddsEvidence += 1;
          await fs.appendFile(files.evidence, `${JSON.stringify(evidence)}\n`, "utf8");
        }
      }

      for (const key of presenceEpisodes.keys()) {
        if (!activePresenceKeys.has(key)) presenceEpisodes.delete(key);
      }
    }

    const cumulativeInvalidSamplesByReason = { ...stats.invalidSamplesByReason };
    if (!sampleValid) incrementReasonCounts(cumulativeInvalidSamplesByReason, invalidReasons);
    const item = {
      at: new Date(now).toISOString(),
      sampleValid,
      comparisonSkipped: !sampleValid,
      invalidReasons,
      samples: stats.samples + 1,
      validSamples: stats.validSamples + (sampleValid ? 1 : 0),
      invalidSamples: stats.invalidSamples + (sampleValid ? 0 : 1),
      invalidSamplesByReason: cumulativeInvalidSamplesByReason,
      warmupRemainingMs: Math.max(0, CONFIG.warmupMs - (now - startedAt)),
      snapshotSkewMs,
      maxSnapshotSkewMs: CONFIG.maxSnapshotSkewMs,
      intervalMs: CONFIG.intervalMs,
      maxObservationGapMs: CONFIG.maxObservationGapMs,
      episodeObservationGapResets: {
        presence: presenceEpisodeObservationGapResets,
        odds: oddsEpisodeObservationGapResets,
      },
      cumulativeEpisodeObservationGapResets: {
        presence: stats.presenceEpisodeObservationGapResets,
        odds: stats.oddsEpisodeObservationGapResets,
        maxGapMs: stats.maxResetObservationGapMs,
      },
      normal: normalHealth,
      direct: directHealth,
      commonMarkets: [...normalById.keys()].filter(id => directById.has(id)).length,
      normalOnly,
      directOnly,
      differingOdds: sampleValid ? counts.raw : null,
      rawOddsDifferences: sampleValid ? counts.raw : null,
      timingToleratedOdds: sampleValid ? counts.tolerated : null,
      confirmedOddsDifferences: sampleValid ? counts.confirmed : null,
      unclassifiedOddsDifferences: sampleValid ? counts.unclassified : null,
      sameApiPtDifferentOdds: sampleValid ? counts.sameApiPtDifferent : null,
      sameTimestampDifferentOdds: sampleValid ? counts.sameTimestampDifferent : null,
      normalOlderApiPtOdds: sampleValid ? counts.normalOlderApiPt : null,
      directOlderApiPtOdds: sampleValid ? counts.directOlderApiPt : null,
      normalOlderTimestampOdds: sampleValid ? counts.normalOlderTimestamp : null,
      directOlderTimestampOdds: sampleValid ? counts.directOlderTimestamp : null,
    };
    await fs.appendFile(files.health, `${JSON.stringify(item)}\n`, "utf8");

    stats.samples += 1;
    if (sampleValid) {
      stats.validSamples += 1;
      stats.readySamples += 1;
      stats.normalOnlyMax = Math.max(stats.normalOnlyMax, normalOnly);
      stats.directOnlyMax = Math.max(stats.directOnlyMax, directOnly);
      stats.rawOddsMismatches += counts.raw;
      stats.timingToleratedOdds += counts.tolerated;
      stats.confirmedOddsMismatches += counts.confirmed;
      stats.unclassifiedOddsMismatches += counts.unclassified;
      stats.sameApiPtDifferentOdds += counts.sameApiPtDifferent;
      stats.sameTimestampDifferentOdds += counts.sameTimestampDifferent;
      stats.normalOlderApiPtOdds += counts.normalOlderApiPt;
      stats.directOlderApiPtOdds += counts.directOlderApiPt;
      stats.normalOlderTimestampOdds += counts.normalOlderTimestamp;
      stats.directOlderTimestampOdds += counts.directOlderTimestamp;
      stats.timingToleratedNormalOlderOdds += counts.normalOlderTolerated;
      stats.timingToleratedDirectOlderOdds += counts.directOlderTolerated;
    } else {
      stats.invalidSamples += 1;
      stats.staleSamples += 1;
      incrementReasonCounts(stats.invalidSamplesByReason, invalidReasons);
    }
    await sleep(CONFIG.intervalMs);
  }

  await fs.writeFile(files.summary, `${JSON.stringify({
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    oddsTimeToleranceMs: CONFIG.oddsTimeToleranceMs,
    liveOddsTimeToleranceMs: CONFIG.liveOddsTimeToleranceMs,
    evidenceGraceMs: CONFIG.evidenceGraceMs,
    intervalMs: CONFIG.intervalMs,
    maxObservationGapMs: CONFIG.maxObservationGapMs,
    warmupMs: CONFIG.warmupMs,
    normalMaxContentAgeMs: CONFIG.normalMaxContentAgeMs,
    directMaxContentAgeMs: CONFIG.directMaxContentAgeMs,
    maxSnapshotSkewMs: CONFIG.maxSnapshotSkewMs,
    normalMinimumCoverageRatio: CONFIG.normalMinimumCoverageRatio,
    directMinimumCoverageRatio: CONFIG.directMinimumCoverageRatio,
    ...stats,
  }, null, 2)}\n`, "utf8");
}

main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
