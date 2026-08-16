import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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

function normalizedProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  return provider === "tippmix" ? "tippmixpro" : provider;
}

validateNamedArguments([
  "provider", "normal-file", "direct-file", "output-dir", "duration-hours",
  "interval-ms", "warmup-ms", "normal-max-content-age-ms",
  "direct-max-content-age-ms", "max-snapshot-skew-ms", "catalogue-max-age-ms",
  "tippmix-frame-max-age-ms", "vegas-live-max-age-ms",
  "vegas-enhanced-max-age-ms", "stale-grace-ms", "paired-snapshot-attempts",
  "paired-snapshot-retry-ms", "event-update-max-skew-ms",
]);

const configuredIntervalMs = numberArgument("interval-ms", 1000, {
  integer: true,
  min: 100,
});
const CONFIG = {
  provider: normalizedProvider(argument("provider", "provider")),
  normalFile: path.resolve(argument("normal-file", "data/normal.json")),
  directFile: path.resolve(argument("direct-file", "data/direct.json")),
  outputDir: path.resolve(argument("output-dir", "logs/direct-shadow")),
  durationMs: numberArgument("duration-hours", 2, { min: 0, max: 720 }) * 3_600_000,
  intervalMs: configuredIntervalMs,
  warmupMs: numberArgument("warmup-ms", 30_000, { integer: true, min: 0 }),
  normalMaxContentAgeMs: numberArgument("normal-max-content-age-ms", 10_000, { integer: true, min: 0 }),
  directMaxContentAgeMs: numberArgument("direct-max-content-age-ms", 5_000, { integer: true, min: 0 }),
  maxSnapshotSkewMs: numberArgument("max-snapshot-skew-ms", 5_000, { integer: true, min: 0 }),
  catalogueMaxAgeMs: numberArgument("catalogue-max-age-ms", 660_000, { integer: true, min: 0 }),
  tippmixFrameMaxAgeMs: numberArgument("tippmix-frame-max-age-ms", 15_000, { integer: true, min: 0 }),
  vegasLiveMaxAgeMs: numberArgument("vegas-live-max-age-ms", 5_000, { integer: true, min: 0 }),
  vegasEnhancedMaxAgeMs: numberArgument("vegas-enhanced-max-age-ms", 15_000, { integer: true, min: 0 }),
  staleGraceMs: numberArgument("stale-grace-ms", 3_000, { integer: true, min: 0, max: 60_000 }),
  pairedSnapshotAttempts: numberArgument("paired-snapshot-attempts", 3, { integer: true, min: 1, max: 10 }),
  pairedSnapshotRetryMs: numberArgument("paired-snapshot-retry-ms", 100, { integer: true, min: 0, max: 2_000 }),
  eventUpdateMaxSkewMs: numberArgument("event-update-max-skew-ms", 3_000, { integer: true, min: 0, max: 60_000 }),
};

const SUPPORTED_PROVIDERS = new Set(["tippmixpro", "vegas"]);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function timestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function eventId(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "";
  const value = event.id ?? event.eventId;
  return value === null || value === undefined ? "" : String(value).trim();
}

function eventInPlay(provider, event) {
  const value = provider === "vegas" ? event?.live : event?.inPlay;
  return typeof value === "boolean" ? value : null;
}

function eventStatus(provider, event) {
  const candidates = provider === "vegas"
    ? [event?.status, event?.statusName]
    : [event?.statusId, event?.statusName];
  const value = candidates.find(candidate => candidate !== null && candidate !== undefined && candidate !== "");
  return value === undefined ? null : String(value);
}

function eventStartTime(event) {
  const value = Number(event?.startTime);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function eventUpdatedAt(event) {
  for (const candidate of [event?.updatedAt, event?.liveUpdatedAt, event?.updatedAtMs]) {
    const value = timestamp(candidate);
    if (value !== null) return value;
  }
  return null;
}

function eventOdds(event) {
  if (!Array.isArray(event?.odds) || event.odds.length !== 3) return null;
  const normalized = [];
  for (const value of event.odds) {
    if (value === null) {
      normalized.push(null);
      continue;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    normalized.push(numeric);
  }
  return normalized;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function freshness(reasons, document, field, maximumAgeMs, now) {
  const value = timestamp(document?.[field]);
  const label = field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  if (!value) {
    reasons.add(`${label}-missing`);
    return { value: null, ageMs: null };
  }
  const ageMs = now - value;
  if (ageMs < -1_000) reasons.add(`${label}-future`);
  else if (ageMs > maximumAgeMs) reasons.add(`${label}-stale`);
  return { value, ageMs };
}

function validateEvents(provider, events) {
  const reasons = new Set();
  const ids = new Set();
  let validEvents = 0;
  if (!Array.isArray(events)) {
    reasons.add("events-unavailable");
    return { reasons, ids, eventCount: 0, validEvents };
  }

  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      reasons.add("event-invalid");
      continue;
    }
    const id = eventId(event);
    if (!id) reasons.add("event-id-missing");
    else if (ids.has(id)) reasons.add("event-id-duplicate");
    else ids.add(id);
    if (!eventStartTime(event)) reasons.add("event-start-time-invalid");
    if (!eventOdds(event)) reasons.add("event-odds-invalid");
    if (eventInPlay(provider, event) === null) reasons.add("event-in-play-invalid");
    if (eventStatus(provider, event) === null) reasons.add("event-status-missing");
    if (
      id
      && eventStartTime(event)
      && eventOdds(event)
      && eventInPlay(provider, event) !== null
      && eventStatus(provider, event) !== null
    ) validEvents += 1;
  }
  return { reasons, ids, eventCount: events.length, validEvents };
}

export async function readSnapshot(file) {
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

export async function readPairedSnapshots(
  normalFile,
  directFile,
  maxSnapshotSkewMs,
  attempts = 1,
  retryMs = 0,
  read = readSnapshot,
) {
  const maximumAttempts = Math.max(1, Number(attempts) || 1);
  let normal;
  let direct;
  let snapshotSkewMs = null;
  let initialSnapshotSkewMs = null;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    [normal, direct] = await Promise.all([read(normalFile), read(directFile)]);
    const normalGeneratedAt = timestamp(normal.document?.generatedAt);
    const directGeneratedAt = timestamp(direct.document?.generatedAt);
    snapshotSkewMs = normalGeneratedAt && directGeneratedAt
      ? Math.abs(normalGeneratedAt - directGeneratedAt)
      : null;
    if (attempt === 1) initialSnapshotSkewMs = snapshotSkewMs;
    if (
      snapshotSkewMs === null
      || snapshotSkewMs <= maxSnapshotSkewMs
      || attempt === maximumAttempts
    ) {
      return {
        normal,
        direct,
        snapshotSkewMs,
        initialSnapshotSkewMs,
        attempts: attempt,
        retries: attempt - 1,
        skewResolved: attempt > 1
          && initialSnapshotSkewMs !== null
          && initialSnapshotSkewMs > maxSnapshotSkewMs
          && snapshotSkewMs !== null
          && snapshotSkewMs <= maxSnapshotSkewMs,
      };
    }
    if (retryMs > 0) await sleep(retryMs);
  }

  return { normal, direct, snapshotSkewMs, initialSnapshotSkewMs, attempts: maximumAttempts, retries: maximumAttempts - 1, skewResolved: false };
}

const TRANSIENT_HEALTH_REASONS = new Set([
  "generated-at-stale",
  "file-stale",
  "last-live-refresh-at-stale",
  "last-enhanced-refresh-at-stale",
  "last-frame-at-stale",
  "snapshot-skew-high",
]);

export function createHealthHysteresis() {
  return {
    transientStartedAt: null,
    rawInvalidSamples: 0,
    suppressedInvalidSamples: 0,
  };
}

export function stabilizeHealthReasons(reasons, state, now, graceMs) {
  const currentReasons = [...new Set(reasons)];
  const transientReasons = currentReasons.filter(reason => {
    const normalized = reason.replace(/^(normal|direct)-/, "");
    return TRANSIENT_HEALTH_REASONS.has(normalized);
  });
  const persistentReasons = currentReasons.filter(reason => !transientReasons.includes(reason));
  if (currentReasons.length > 0) state.rawInvalidSamples += 1;

  if (transientReasons.length > 0) {
    if (state.transientStartedAt === null) state.transientStartedAt = now;
    const transientAgeMs = Math.max(0, now - state.transientStartedAt);
    if (transientAgeMs < Math.max(0, graceMs)) {
      if (persistentReasons.length === 0) state.suppressedInvalidSamples += 1;
      return { reasons: persistentReasons, suppressedReasons: transientReasons, transientAgeMs };
    }
    return { reasons: [...persistentReasons, ...transientReasons], suppressedReasons: [], transientAgeMs };
  }

  state.transientStartedAt = null;
  return { reasons: persistentReasons, suppressedReasons: [], transientAgeMs: 0 };
}

export function sideHealth(side, policy, now = Date.now()) {
  const provider = normalizedProvider(policy.provider);
  const document = side.document;
  const reasons = new Set();
  if (!side.ok) reasons.add("read-failed");
  if (side.ok && (!document || typeof document !== "object" || Array.isArray(document))) {
    reasons.add("document-invalid");
  }
  if (!SUPPORTED_PROVIDERS.has(provider)) reasons.add("provider-unsupported");

  const safeDocument = document && typeof document === "object" && !Array.isArray(document)
    ? document
    : {};
  const generated = freshness(reasons, safeDocument, "generatedAt", policy.maxContentAgeMs, now);
  const catalogue = freshness(reasons, safeDocument, "lastCatalogueRefreshAt", policy.catalogueMaxAgeMs, now);
  if (side.ok && Number.isFinite(side.fileAgeMs) && side.fileAgeMs > policy.maxContentAgeMs) {
    reasons.add("file-stale");
  }

  const eventValidation = validateEvents(provider, safeDocument.events);
  for (const reason of eventValidation.reasons) reasons.add(reason);

  const sourceHealth = {};
  if (provider === "tippmixpro") {
    sourceHealth.connected = safeDocument.connected === true;
    sourceHealth.pendingWork = Number(safeDocument.pendingWork);
    sourceHealth.pendingWorkDetails = safeDocument.pendingWorkDetails ?? null;
    if (safeDocument.connected !== true) reasons.add("disconnected");
    if (!Number.isInteger(sourceHealth.pendingWork) || sourceHealth.pendingWork < 0) {
      reasons.add("pending-work-invalid");
    }

    const hasSnapshotConsistency = Object.hasOwn(safeDocument, "snapshotConsistency");
    const snapshotConsistency = safeDocument.snapshotConsistency;
    if (hasSnapshotConsistency) {
      const validObject =
        snapshotConsistency &&
        typeof snapshotConsistency === "object" &&
        !Array.isArray(snapshotConsistency);
      const issues = validObject && Array.isArray(snapshotConsistency.issues)
        ? snapshotConsistency.issues
        : null;
      const invalidEvents = validObject ? Number(snapshotConsistency.invalidEvents) : Number.NaN;
      sourceHealth.snapshotConsistent = validObject
        ? snapshotConsistency.consistent === true
        : null;
      sourceHealth.snapshotInvalidEvents = Number.isFinite(invalidEvents) ? invalidEvents : null;
      sourceHealth.snapshotConsistencyIssues = issues;
      if (
        !validObject ||
        typeof snapshotConsistency.consistent !== "boolean" ||
        !Number.isInteger(invalidEvents) ||
        invalidEvents < 0 ||
        !issues ||
        issues.some(issue => typeof issue !== "string" || !issue) ||
        snapshotConsistency.consistent !== (invalidEvents === 0 && issues.length === 0)
      ) {
        reasons.add("snapshot-consistency-invalid");
      } else if (!snapshotConsistency.consistent) {
        reasons.add("snapshot-inconsistent");
      }
    } else {
      sourceHealth.snapshotConsistent = null;
      sourceHealth.snapshotInvalidEvents = null;
      sourceHealth.snapshotConsistencyIssues = null;
      // Legacy collectors did not distinguish background protocol work from
      // snapshot-blocking work, so retain the conservative legacy gate.
      if (sourceHealth.pendingWork > 0) reasons.add("pending-work");
    }
    const frame = freshness(reasons, safeDocument, "lastFrameAt", policy.tippmixFrameMaxAgeMs, now);
    sourceHealth.lastFrameAt = frame.value;
    sourceHealth.lastFrameAgeMs = frame.ageMs;
  } else if (provider === "vegas") {
    const live = freshness(reasons, safeDocument, "lastLiveRefreshAt", policy.vegasLiveMaxAgeMs, now);
    const enhancedReasons = new Set();
    const enhanced = freshness(
      enhancedReasons,
      safeDocument,
      "lastEnhancedRefreshAt",
      policy.vegasEnhancedMaxAgeMs,
      now,
    );
    const enhancedRefresh = safeDocument.enhancedRefresh;
    const enhancedNotApplicable =
      Number(safeDocument.enhancedEvents) === 0 &&
      enhancedRefresh &&
      typeof enhancedRefresh === "object" &&
      !Array.isArray(enhancedRefresh) &&
      Number(enhancedRefresh.failures) === 0;
    if (!enhancedNotApplicable) {
      for (const reason of enhancedReasons) reasons.add(reason);
    }
    sourceHealth.lastLiveRefreshAt = live.value;
    sourceHealth.lastLiveAgeMs = live.ageMs;
    sourceHealth.lastEnhancedRefreshAt = enhanced.value;
    sourceHealth.lastEnhancedAgeMs = enhanced.ageMs;
    sourceHealth.enhancedApplicable = !enhancedNotApplicable;
    const liveRefresh = safeDocument.liveRefresh;
    sourceHealth.liveRefresh = liveRefresh && typeof liveRefresh === "object"
      && !Array.isArray(liveRefresh)
      ? {
        attempts: Number(liveRefresh.attempts) || 0,
        successes: Number(liveRefresh.successes) || 0,
        failures: Number(liveRefresh.failures) || 0,
        timeouts: Number(liveRefresh.timeouts) || 0,
        retries: Number(liveRefresh.retries) || 0,
        skippedBusy: Number(liveRefresh.skippedBusy) || 0,
        consecutiveFailures: Number(liveRefresh.consecutiveFailures) || 0,
        latencySamples: Number(liveRefresh.latencySamples) || 0,
        latencyWindowSize: Number(liveRefresh.latencyWindowSize) || 0,
        latencyP50Ms: Number.isFinite(Number(liveRefresh.latencyP50Ms))
          ? Number(liveRefresh.latencyP50Ms)
          : null,
        latencyP95Ms: Number.isFinite(Number(liveRefresh.latencyP95Ms))
          ? Number(liveRefresh.latencyP95Ms)
          : null,
        latencyP99Ms: Number.isFinite(Number(liveRefresh.latencyP99Ms))
          ? Number(liveRefresh.latencyP99Ms)
          : null,
        latencyMaxMs: Number.isFinite(Number(liveRefresh.latencyMaxMs))
          ? Number(liveRefresh.latencyMaxMs)
          : null,
        requestPhaseSamples: Number(liveRefresh.requestPhaseSamples) || 0,
        requestPhaseWindowSize: Number(liveRefresh.requestPhaseWindowSize) || 0,
        lastRequestPhases: liveRefresh.lastRequestPhases ?? null,
        requestPhaseP95Ms: liveRefresh.requestPhaseP95Ms ?? null,
        lastDurationMs: Number.isFinite(Number(liveRefresh.lastDurationMs))
          ? Number(liveRefresh.lastDurationMs)
          : null,
        lastError: liveRefresh.lastError ?? null,
        backoffMs: Number(liveRefresh.backoffMs) || 0,
      }
      : null;
    sourceHealth.enhancedRefresh = enhancedRefresh && typeof enhancedRefresh === "object"
      && !Array.isArray(enhancedRefresh)
      ? {
        runs: Number(enhancedRefresh.runs) || 0,
        successes: Number(enhancedRefresh.successes) || 0,
        failures: Number(enhancedRefresh.failures) || 0,
        detailRequests: Number(enhancedRefresh.detailRequests) || 0,
        detailSuccesses: Number(enhancedRefresh.detailSuccesses) || 0,
        detailFailures: Number(enhancedRefresh.detailFailures) || 0,
        pausedForLive: Number(enhancedRefresh.pausedForLive) || 0,
        lastDurationMs: Number.isFinite(Number(enhancedRefresh.lastDurationMs))
          ? Number(enhancedRefresh.lastDurationMs)
          : null,
        lastError: enhancedRefresh.lastError ?? null,
      }
      : null;
  }

  return {
    ok: side.ok === true,
    healthy: reasons.size === 0,
    unhealthyReasons: [...reasons],
    error: side.error ?? null,
    provider,
    fileAgeMs: side.fileAgeMs ?? null,
    generatedAt: generated.value,
    contentAgeMs: generated.ageMs,
    maxContentAgeMs: policy.maxContentAgeMs,
    catalogueRefreshAt: catalogue.value,
    catalogueAgeMs: catalogue.ageMs,
    catalogueMaxAgeMs: policy.catalogueMaxAgeMs,
    events: eventValidation.eventCount,
    validEvents: eventValidation.validEvents,
    uniqueEventIds: eventValidation.ids.size,
    lastError: safeDocument.lastError ?? null,
    ...sourceHealth,
  };
}

export function eventsById(document) {
  const result = new Map();
  for (const event of Array.isArray(document?.events) ? document.events : []) {
    const id = eventId(event);
    if (id) result.set(id, event);
  }
  return result;
}

function fieldCounts() {
  return { compared: 0, agreements: 0, mismatches: 0 };
}

function countField(target, agrees) {
  target.compared += 1;
  if (agrees) target.agreements += 1;
  else target.mismatches += 1;
}

function withAgreementRatio(counts) {
  return {
    ...counts,
    agreementRatio: counts.compared > 0 ? counts.agreements / counts.compared : null,
  };
}

export function compareSnapshots(
  normalDocument,
  directDocument,
  providerValue,
  options = {},
) {
  const provider = normalizedProvider(providerValue);
  const eventUpdateMaxSkewMs = Number.isFinite(Number(options.eventUpdateMaxSkewMs))
    ? Number(options.eventUpdateMaxSkewMs)
    : null;
  const normalById = eventsById(normalDocument);
  const directById = eventsById(directDocument);
  const normalIds = new Set(normalById.keys());
  const directIds = new Set(directById.keys());
  const commonIds = [...normalIds].filter(id => directIds.has(id));
  const fields = {
    odds: fieldCounts(),
    status: fieldCounts(),
    inPlay: fieldCounts(),
    startTime: fieldCounts(),
    allFields: fieldCounts(),
  };
  const eventCoherence = {
    comparedEvents: 0,
    skippedEvents: 0,
    phaseMismatches: 0,
    liveUpdateTimestampMissing: 0,
    liveUpdateSkew: 0,
  };

  for (const id of commonIds) {
    const normal = normalById.get(id);
    const direct = directById.get(id);
    const normalPhase = eventInPlay(provider, normal);
    const directPhase = eventInPlay(provider, direct);
    if (normalPhase !== directPhase) {
      eventCoherence.skippedEvents += 1;
      eventCoherence.phaseMismatches += 1;
      continue;
    }
    if (normalPhase === true && eventUpdateMaxSkewMs !== null) {
      const normalUpdatedAt = eventUpdatedAt(normal);
      const directUpdatedAt = eventUpdatedAt(direct);
      if (normalUpdatedAt === null || directUpdatedAt === null) {
        eventCoherence.skippedEvents += 1;
        eventCoherence.liveUpdateTimestampMissing += 1;
        continue;
      }
      if (Math.abs(normalUpdatedAt - directUpdatedAt) > eventUpdateMaxSkewMs) {
        eventCoherence.skippedEvents += 1;
        eventCoherence.liveUpdateSkew += 1;
        continue;
      }
    }
    eventCoherence.comparedEvents += 1;
    const agreements = {
      odds: sameArray(eventOdds(normal), eventOdds(direct)),
      status: eventStatus(provider, normal) === eventStatus(provider, direct),
      inPlay: eventInPlay(provider, normal) === eventInPlay(provider, direct),
      startTime: eventStartTime(normal) === eventStartTime(direct),
    };
    for (const [field, agrees] of Object.entries(agreements)) countField(fields[field], agrees);
    countField(fields.allFields, Object.values(agreements).every(Boolean));
  }

  return {
    normalEvents: normalIds.size,
    directEvents: directIds.size,
    commonEvents: commonIds.length,
    normalOnly: normalIds.size - commonIds.length,
    directOnly: directIds.size - commonIds.length,
    coherentEvents: eventCoherence.comparedEvents,
    eventCoherence,
    fields: Object.fromEntries(
      Object.entries(fields).map(([field, counts]) => [field, withAgreementRatio(counts)]),
    ),
  };
}

export function createStats() {
  return {
    samples: 0,
    warmupSamples: 0,
    eligibleSamples: 0,
    readySamples: 0,
    validSamples: 0,
    graceSamples: 0,
    invalidSamples: 0,
    // Kept for compatibility. Warmup is intentionally not counted as stale.
    staleSamples: 0,
    rawInvalidSamples: 0,
    suppressedInvalidSamples: 0,
    invalidEpisodeCount: 0,
    invalidEpisodeTotalMs: 0,
    invalidEpisodeMaxMs: 0,
    invalidSamplesByReason: {},
    normalOnlyMax: 0,
    directOnlyMax: 0,
    normalOnlyObservations: 0,
    directOnlyObservations: 0,
    commonEventObservations: 0,
    coherentEventObservations: 0,
    coherenceSkippedEvents: 0,
    phaseMismatchEvents: 0,
    liveUpdateTimestampMissingEvents: 0,
    liveUpdateSkewEvents: 0,
    odds: fieldCounts(),
    status: fieldCounts(),
    inPlay: fieldCounts(),
    startTime: fieldCounts(),
    allFields: fieldCounts(),
    pairedSamples: 0,
    pairedRetries: 0,
    pairedSkewResolved: 0,
    pairedSkewUnresolved: 0,
    _invalidEpisodeStartedAt: null,
  };
}

function incrementReasons(target, reasons) {
  for (const reason of reasons) target[reason] = (target[reason] ?? 0) + 1;
}

function closeInvalidEpisode(stats, at = Date.now()) {
  if (stats._invalidEpisodeStartedAt === null) return;
  const durationMs = Math.max(0, at - stats._invalidEpisodeStartedAt);
  stats.invalidEpisodeTotalMs += durationMs;
  stats.invalidEpisodeMaxMs = Math.max(stats.invalidEpisodeMaxMs, durationMs);
  stats._invalidEpisodeStartedAt = null;
}

export function recordSample(
  stats,
  {
    warmup,
    sampleValid,
    comparisonSkipped = false,
    invalidReasons = [],
    comparison = null,
    at = Date.now(),
  },
) {
  stats.samples += 1;
  if (warmup) {
    stats.warmupSamples += 1;
    return;
  }
  stats.eligibleSamples += 1;
  if (!sampleValid) {
    if (stats._invalidEpisodeStartedAt === null) {
      stats._invalidEpisodeStartedAt = at;
      stats.invalidEpisodeCount += 1;
    }
    stats.invalidSamples += 1;
    stats.staleSamples += 1;
    incrementReasons(stats.invalidSamplesByReason, invalidReasons);
    return;
  }

  closeInvalidEpisode(stats, at);
  stats.readySamples += 1;
  if (comparisonSkipped || !comparison) {
    stats.graceSamples += 1;
    return;
  }
  stats.validSamples += 1;
  stats.normalOnlyMax = Math.max(stats.normalOnlyMax, comparison.normalOnly);
  stats.directOnlyMax = Math.max(stats.directOnlyMax, comparison.directOnly);
  stats.normalOnlyObservations += comparison.normalOnly;
  stats.directOnlyObservations += comparison.directOnly;
  stats.commonEventObservations += comparison.commonEvents;
  stats.coherentEventObservations += comparison.coherentEvents ?? comparison.commonEvents;
  stats.coherenceSkippedEvents += comparison.eventCoherence?.skippedEvents ?? 0;
  stats.phaseMismatchEvents += comparison.eventCoherence?.phaseMismatches ?? 0;
  stats.liveUpdateTimestampMissingEvents += comparison.eventCoherence?.liveUpdateTimestampMissing ?? 0;
  stats.liveUpdateSkewEvents += comparison.eventCoherence?.liveUpdateSkew ?? 0;
  for (const field of ["odds", "status", "inPlay", "startTime", "allFields"]) {
    stats[field].compared += comparison.fields[field].compared;
    stats[field].agreements += comparison.fields[field].agreements;
    stats[field].mismatches += comparison.fields[field].mismatches;
  }
}

export function summarizedStats(stats) {
  const { _invalidEpisodeStartedAt, ...publicStats } = stats;
  return {
    ...publicStats,
    activeInvalidMs: _invalidEpisodeStartedAt === null
      ? 0
      : Math.max(0, Date.now() - _invalidEpisodeStartedAt),
    readinessRatio: stats.eligibleSamples > 0 ? stats.readySamples / stats.eligibleSamples : null,
    odds: withAgreementRatio(stats.odds),
    status: withAgreementRatio(stats.status),
    inPlay: withAgreementRatio(stats.inPlay),
    startTime: withAgreementRatio(stats.startTime),
    allFields: withAgreementRatio(stats.allFields),
  };
}

export async function main(config = CONFIG) {
  if (!SUPPORTED_PROVIDERS.has(config.provider)) {
    throw new Error(`Nem tamogatott provider: ${config.provider}. Hasznald: vegas vagy tippmixpro.`);
  }
  await fs.mkdir(config.outputDir, { recursive: true });
  const healthFile = path.join(config.outputDir, "health.jsonl");
  const summaryFile = path.join(config.outputDir, "summary.json");
  const startedAt = Date.now();
  const stats = createStats();
  const healthHysteresis = createHealthHysteresis();
  const staleGraceMs = Number.isFinite(Number(config.staleGraceMs))
    ? Number(config.staleGraceMs)
    : 0;
  const pairedSnapshotAttempts = Number.isFinite(Number(config.pairedSnapshotAttempts))
    ? Number(config.pairedSnapshotAttempts)
    : 1;
  const pairedSnapshotRetryMs = Number.isFinite(Number(config.pairedSnapshotRetryMs))
    ? Number(config.pairedSnapshotRetryMs)
    : 0;

  while (Date.now() - startedAt < config.durationMs) {
    const paired = await readPairedSnapshots(
      config.normalFile,
      config.directFile,
      config.maxSnapshotSkewMs,
      pairedSnapshotAttempts,
      pairedSnapshotRetryMs,
    );
    const { normal, direct } = paired;
    const now = Date.now();
    const normalHealth = sideHealth(normal, {
      ...config,
      maxContentAgeMs: config.normalMaxContentAgeMs,
    }, now);
    const directHealth = sideHealth(direct, {
      ...config,
      maxContentAgeMs: config.directMaxContentAgeMs,
    }, now);
    const warmup = now - startedAt < config.warmupMs;
    const rawInvalidReasons = [];
    if (warmup) rawInvalidReasons.push("warmup");
    rawInvalidReasons.push(...normalHealth.unhealthyReasons.map(reason => `normal-${reason}`));
    rawInvalidReasons.push(...directHealth.unhealthyReasons.map(reason => `direct-${reason}`));
    const snapshotSkewMs = paired.snapshotSkewMs;
    if (snapshotSkewMs !== null && snapshotSkewMs > config.maxSnapshotSkewMs) {
      rawInvalidReasons.push("snapshot-skew-high");
    }
    const stabilized = warmup
      ? { reasons: ["warmup"], suppressedReasons: [], transientAgeMs: 0 }
      : stabilizeHealthReasons(rawInvalidReasons, healthHysteresis, now, staleGraceMs);
    stats.rawInvalidSamples = healthHysteresis.rawInvalidSamples;
    stats.suppressedInvalidSamples = healthHysteresis.suppressedInvalidSamples;
    stats.pairedSamples += 1;
    stats.pairedRetries += paired.retries;
    if (paired.skewResolved) stats.pairedSkewResolved += 1;
    if (
      paired.snapshotSkewMs !== null
      && paired.snapshotSkewMs > config.maxSnapshotSkewMs
    ) stats.pairedSkewUnresolved += 1;
    const invalidReasons = stabilized.reasons;
    const sampleValid = !warmup && invalidReasons.length === 0;
    const comparisonSkipped = !warmup && rawInvalidReasons.length > 0;
    const comparison = !warmup && rawInvalidReasons.length === 0 && sampleValid
      ? compareSnapshots(
        normal.document,
        direct.document,
        config.provider,
        { eventUpdateMaxSkewMs: config.eventUpdateMaxSkewMs },
      )
      : null;

    recordSample(
      stats,
      { warmup, sampleValid, comparisonSkipped, invalidReasons, comparison, at: now },
    );
    const item = {
      at: new Date(now).toISOString(),
      provider: config.provider,
      sampleValid,
      comparisonSkipped: warmup || comparisonSkipped || comparison === null,
      warmup,
      rawInvalidReasons,
      invalidReasons,
      suppressedInvalidReasons: stabilized.suppressedReasons,
      hysteresis: {
        staleGraceMs,
        transientAgeMs: stabilized.transientAgeMs,
      },
      snapshotSkewMs,
      maxSnapshotSkewMs: config.maxSnapshotSkewMs,
      pairing: {
        attempts: paired.attempts,
        retries: paired.retries,
        initialSnapshotSkewMs: paired.initialSnapshotSkewMs,
        skewResolved: paired.skewResolved,
      },
      normal: normalHealth,
      direct: directHealth,
      comparison,
      cumulative: summarizedStats(stats),
    };
    await fs.appendFile(healthFile, `${JSON.stringify(item)}\n`, "utf8");
    await sleep(config.intervalMs);
  }

  closeInvalidEpisode(stats, Date.now());
  const summary = {
    provider: config.provider,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    warmupMs: config.warmupMs,
    intervalMs: config.intervalMs,
    normalMaxContentAgeMs: config.normalMaxContentAgeMs,
    directMaxContentAgeMs: config.directMaxContentAgeMs,
    maxSnapshotSkewMs: config.maxSnapshotSkewMs,
    catalogueMaxAgeMs: config.catalogueMaxAgeMs,
    tippmixFrameMaxAgeMs: config.tippmixFrameMaxAgeMs,
    vegasLiveMaxAgeMs: config.vegasLiveMaxAgeMs,
    vegasEnhancedMaxAgeMs: config.vegasEnhancedMaxAgeMs,
    staleGraceMs,
    pairedSnapshotAttempts,
    pairedSnapshotRetryMs,
    eventUpdateMaxSkewMs: config.eventUpdateMaxSkewMs ?? null,
    ...summarizedStats(stats),
  };
  await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
