import { promises as fs } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { numericOption, validateNamedArguments } from "./numeric_config.js";
import { acquireWriterLock, writeTextAtomically } from "./atomic_file.js";
import { isRenderableMarket, mergeSharpXPrice } from "./sharpx_market_renderability.js";

// The PIA/Gluetun network exposes AAAA records but has no usable IPv6 route.
// Node's default fetch resolver can therefore select IPv6 and fail with
// ETIMEDOUT before reaching the IPv4 SharpX endpoint.
setDefaultResultOrder("ipv4first");

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function argument(name, fallback) {
  const indexes = process.argv
    .map((value, index) => (value === name ? index : -1))
    .filter(index => index >= 0);
  if (indexes.length === 0) return fallback;
  if (indexes.length > 1) throw new Error(`Dupla CLI kapcsoló: ${name}`);
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Hiányzó érték a CLI kapcsoló után: ${name}`);
  }
  return value;
}
const numberArgument = (name, fallback, constraints) =>
  numericOption(argument(name, fallback), name, constraints);
validateNamedArguments([
  "output-file", "catalogue-ms", "output-ms", "fetch-timeout-ms",
  "catalogue-retry-count", "catalogue-retry-base-ms", "catalogue-retry-max-ms",
  "catalogue-startup-timeout-ms", "catalogue-startup-retry-count",
  "catalogue-startup-retry-base-ms", "catalogue-startup-retry-max-ms",
  "catalogue-page-concurrency",
  "catalogue-failure-backoff-base-ms", "catalogue-failure-backoff-max-ms",
  "catalogue-absence-confirmations", "catalogue-missing-retention-ms",
  "closed-diagnostic-retention-ms", "markets-per-socket", "socket-stale-ms",
  "socket-ready-timeout-ms", "socket-compaction-ms",
  "socket-compaction-confirmations", "socket-compaction-factor",
  "market-resubscribe-ms", "market-ready-timeout-ms", "market-recovery-attempts",
  "market-resubscribe-batch-size", "market-restart-max-per-tick",
  "market-restart-cooldown-base-ms", "market-restart-cooldown-max-ms",
  "live-market-stale-ms", "prematch-market-stale-ms", "diagnostic-detail-limit",
  "duration-hours",
]);
const CONFIG = {
  outputFile: path.resolve(argument("--output-file", path.join(PROJECT_DIR, "data", "sharpx-direct-shadow", "sharpx_status_snapshot.json"))),
  catalogueMs: numberArgument("--catalogue-ms", "60000", { integer: true, min: 1_000 }),
  outputMs: numberArgument("--output-ms", "1000", { integer: true, min: 100 }),
  fetchTimeoutMs: numberArgument("--fetch-timeout-ms", "20000", { integer: true, min: 100, max: 120_000 }),
  catalogueRetryCount: numberArgument("--catalogue-retry-count", "4", { integer: true, min: 0, max: 20 }),
  catalogueRetryBaseMs: numberArgument("--catalogue-retry-base-ms", "1000", { integer: true, min: 1 }),
  catalogueRetryMaxMs: numberArgument("--catalogue-retry-max-ms", "15000", { integer: true, min: 1 }),
  catalogueStartupFetchTimeoutMs: numberArgument("--catalogue-startup-timeout-ms", "8000", { integer: true, min: 100, max: 120_000 }),
  catalogueStartupRetryCount: numberArgument("--catalogue-startup-retry-count", "1", { integer: true, min: 0, max: 5 }),
  catalogueStartupRetryBaseMs: numberArgument("--catalogue-startup-retry-base-ms", "500", { integer: true, min: 1 }),
  catalogueStartupRetryMaxMs: numberArgument("--catalogue-startup-retry-max-ms", "2000", { integer: true, min: 1 }),
  cataloguePageConcurrency: numberArgument("--catalogue-page-concurrency", "3", { integer: true, min: 1, max: 10 }),
  catalogueFailureBackoffBaseMs: numberArgument("--catalogue-failure-backoff-base-ms", "5000", { integer: true, min: 1 }),
  catalogueFailureBackoffMaxMs: numberArgument("--catalogue-failure-backoff-max-ms", "60000", { integer: true, min: 1 }),
  catalogueAbsenceConfirmations: numberArgument("--catalogue-absence-confirmations", "3", { integer: true, min: 1 }),
  catalogueMissingRetentionMs: numberArgument("--catalogue-missing-retention-ms", "900000", { integer: true, min: 0 }),
  closedDiagnosticRetentionMs: numberArgument("--closed-diagnostic-retention-ms", "300000", { integer: true, min: 0 }),
  marketsPerSocket: numberArgument("--markets-per-socket", "30", { integer: true, min: 1, max: 200 }),
  socketStaleMs: numberArgument("--socket-stale-ms", "90000", { integer: true, min: 1_000 }),
  socketReadyTimeoutMs: numberArgument("--socket-ready-timeout-ms", "45000", { integer: true, min: 1_000 }),
  socketCompactionMs: numberArgument("--socket-compaction-ms", "300000", { integer: true, min: 1_000 }),
  socketCompactionConfirmations: numberArgument("--socket-compaction-confirmations", "3", { integer: true, min: 1 }),
  socketCompactionFactor: numberArgument("--socket-compaction-factor", "1.5", { min: 1 }),
  marketResubscribeMs: numberArgument("--market-resubscribe-ms", "30000", { integer: true, min: 1_000 }),
  marketReadyTimeoutMs: numberArgument("--market-ready-timeout-ms", "45000", { integer: true, min: 1_000 }),
  marketRecoveryAttempts: numberArgument("--market-recovery-attempts", "2", { integer: true, min: 1 }),
  marketResubscribeBatchSize: numberArgument("--market-resubscribe-batch-size", "30", { integer: true, min: 1 }),
  marketRestartMaxPerTick: numberArgument("--market-restart-max-per-tick", "2", { integer: true, min: 1 }),
  marketRestartCooldownBaseMs: numberArgument("--market-restart-cooldown-base-ms", "120000", { integer: true, min: 1_000 }),
  marketRestartCooldownMaxMs: numberArgument("--market-restart-cooldown-max-ms", "900000", { integer: true, min: 1_000 }),
  liveMarketStaleMs: numberArgument("--live-market-stale-ms", "60000", { integer: true, min: 0 }),
  prematchMarketStaleMs: numberArgument("--prematch-market-stale-ms", "0", { integer: true, min: 0 }),
  diagnosticDetailLimit: numberArgument("--diagnostic-detail-limit", "50", { integer: true, min: 0 }),
  durationMs: numberArgument("--duration-hours", "0", { min: 0, max: 720 }) * 3_600_000,
};
const CATALOGUE_URL = "https://portal.sharpxch.com/customer/api/sport/details";
const WS_BASE = "wss://portal.sharpxch.com/customer/ws/multiple-market-prices";
const requestBody = { id: "1", timeFilter: "ALL", viewBy: "POPULARITY", contextFilter: "EVENT_TYPE" };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function writeAtomically(file, document) {
  const payload = `${JSON.stringify(document)}\n`;
  try {
    await writeTextAtomically(file, payload);
    return true;
  } catch (error) {
    console.warn(`[output-write] ${errorText(error)}`);
    return false;
  }
}

function shouldRetryCatalogueError(error) {
  const status = Number(error?.status);
  return !Number.isInteger(status) || status === 429 || status >= 500;
}

function catalogueRetryOptions(startup = false) {
  if (!startup) {
    return {
      fetchTimeoutMs: CONFIG.fetchTimeoutMs,
      retryCount: CONFIG.catalogueRetryCount,
      retryBaseMs: CONFIG.catalogueRetryBaseMs,
      retryMaxMs: CONFIG.catalogueRetryMaxMs,
    };
  }
  return {
    fetchTimeoutMs: CONFIG.catalogueStartupFetchTimeoutMs,
    retryCount: CONFIG.catalogueStartupRetryCount,
    retryBaseMs: CONFIG.catalogueStartupRetryBaseMs,
    retryMaxMs: CONFIG.catalogueStartupRetryMaxMs,
  };
}

export { catalogueRetryOptions };

async function cataloguePage(page, stats, options = catalogueRetryOptions()) {
  let lastError;
  for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
    stats.attempts += 1;
    try {
      const response = await fetch(`${CATALOGUE_URL}?page=${page}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(options.fetchTimeoutMs),
      });
      if (!response.ok) {
        const error = new Error(`SharpX katalogus HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= options.retryCount || !shouldRetryCatalogueError(error)) break;
      stats.retries += 1;
      const delay = Math.min(options.retryMaxMs, options.retryBaseMs * 2 ** attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}

function errorText(error) {
  const message = String(error?.message ?? error);
  const code = error?.cause?.code;
  return code ? `${message} (${code})` : message;
}

class DirectCollector {
  constructor() {
    this.catalogue = new Map();
    this.catalogueAbsenceCycles = new Map();
    this.catalogueMissingMarkets = new Map();
    this.hysteresisRetainedMarketIds = new Set();
    this.closedMarketIds = new Set();
    this.recentClosedMarkets = new Map();
    this.catalogueRawMarkets = 0;
    this.catalogueUniqueMarkets = 0;
    this.catalogueDuplicateMarkets = 0;
    this.catalogueRetainedByHysteresis = 0;
    this.prices = new Map();
    this.connections = [];
    this.marketConnections = new Map();
    this.marketLastSubscriptionAt = new Map();
    this.marketRecovery = new Map();
    this.selectedMarketIds = new Set();
    this.generation = 0;
    this.lastCatalogueRefreshAt = null;
    this.nextCatalogueRefreshAt = 0;
    this.catalogueRefreshInProgress = false;
    this.catalogueRefreshStartedAt = null;
    this.catalogueRefreshCompletedAt = null;
    this.catalogueRefreshLastDurationMs = null;
    this.catalogueFetchAttempts = 0;
    this.catalogueFetchRetries = 0;
    this.catalogueConsecutiveFailures = 0;
    this.lastCatalogueError = null;
    this.lastError = null;
    this.lastSocketError = null;
    this.socketRestarts = 0;
    this.staleSocketRestarts = 0;
    this.socketReadinessRestarts = 0;
    this.emptySocketRestarts = 0;
    this.marketTriggeredSocketRestarts = 0;
    this.marketRestartDeferredByLimit = 0;
    this.marketRestartDeferredByCooldown = 0;
    this.marketRestartLastAt = null;
    this.marketRestartLastCooldownMs = null;
    this.marketRestartMaxBackoffLevel = 0;
    this.socketCloseEvents = 0;
    this.socketUnexpectedCloses = 0;
    this.socketReconnectAttempts = 0;
    this.socketReconnects = 0;
    this.lastSocketRestartAt = null;
    this.lastSocketCompactionAt = null;
    this.socketCompactions = 0;
    this.compactionQueue = [];
    this.compactionActive = null;
    this.compactionTimer = null;
    this.compactionPressureCycles = 0;
    this.compactionCandidateSockets = 0;
    this.compactionCandidateMarkets = 0;
    this.marketResends = 0;
    this.resubscribeCursor = 0;
    this.nextSubscriptionSerial = 1;
    this.nextConnectionId = 1;
    this.closed = false;
  }

  async refreshCatalogue({ startup = false } = {}) {
    const stats = { attempts: 0, retries: 0 };
    const retryOptions = catalogueRetryOptions(startup);
    const commitStats = () => {
      this.catalogueFetchAttempts += stats.attempts;
      this.catalogueFetchRetries += stats.retries;
    };
    try {
      const first = await cataloguePage(0, stats, retryOptions);
      const pageCount = Number(first.marketCatalogueList?.totalPages ?? 0);
      const pages = [first];
      const pageConcurrency = CONFIG.cataloguePageConcurrency;
      for (let start = 1; start < pageCount; start += pageConcurrency) {
        const batch = Array.from({ length: Math.min(pageConcurrency, pageCount - start) }, (_, offset) => cataloguePage(start + offset, stats, retryOptions));
        pages.push(...await Promise.all(batch));
      }
      if (this.closed) return null;
      const now = Date.now();
      const marketRows = pages.flatMap(page => page.marketCatalogueList?.content ?? [])
        .filter(market => market.description?.marketType === "MATCH_ODDS")
        .map(market => ({
          marketId: market.marketId,
          eventId: market.event?.id,
          eventName: market.event?.name ?? "",
          competitionName: market.competition?.name ?? "",
          marketStartTime: Number(market.marketStartTime),
          inPlay: market.inPlay === true,
          totalMatched: Number(market.totalMatched ?? 0),
          runners: (market.runners ?? []).map(runner => ({ selectionId: Number(runner.selectionId), runnerName: runner.runnerName ?? "" })),
        }))
        .filter(market => market.marketId && market.eventId);
      const currentCatalogue = new Map(marketRows.map(market => [market.marketId, market]));
      for (const marketId of this.closedMarketIds) {
        if (!currentCatalogue.has(marketId)) this.closedMarketIds.delete(marketId);
      }
      for (const market of currentCatalogue.values()) {
        const cachedPrice = this.prices.get(market.marketId);
        if (cachedPrice?.generation !== this.generation) continue;
        if (cachedPrice.marketDefinition?.status === "CLOSED") {
          this.closedMarketIds.add(market.marketId);
          if (!this.recentClosedMarkets.has(market.marketId)) {
            this.recentClosedMarkets.set(market.marketId, {
              market,
              closedAt: cachedPrice.receivedAt ?? now,
              apiPt: cachedPrice.apiPt ?? null,
            });
          }
        } else {
          this.closedMarketIds.delete(market.marketId);
          this.recentClosedMarkets.delete(market.marketId);
        }
      }
      const closedDiagnosticRetentionMs = Math.max(0, CONFIG.closedDiagnosticRetentionMs);
      for (const [marketId, closed] of this.recentClosedMarkets) {
        if (closedDiagnosticRetentionMs === 0 || now - closed.closedAt > closedDiagnosticRetentionMs) {
          this.recentClosedMarkets.delete(marketId);
        }
      }
      const currentSelected = new Map(
        [...currentCatalogue.values()]
          .filter(market => (market.inPlay || market.marketStartTime > now) && !this.closedMarketIds.has(market.marketId))
          .map(market => [market.marketId, market]),
      );
      const effectiveCatalogue = new Map(currentCatalogue);
      const effectiveSelected = new Map(currentSelected);
      const absenceConfirmations = Math.max(1, CONFIG.catalogueAbsenceConfirmations);
      const hysteresisRetained = new Set();

      // POPULARITY pagination is not stable while a multi-page refresh is in
      // flight. A market can therefore disappear for one page sweep and return
      // in the next one. The start-time/in-play flags can also briefly leave a
      // kickoff market outside the selected set. Only N consecutive successful
      // sweeps may therefore unsubscribe a previously selected, non-closed market.
      for (const marketId of currentSelected.keys()) {
        this.catalogueAbsenceCycles.delete(marketId);
        this.catalogueMissingMarkets.delete(marketId);
      }
      for (const marketId of this.selectedMarketIds) {
        if (currentSelected.has(marketId)) continue;
        const previousMarket = currentCatalogue.get(marketId) ?? this.catalogue.get(marketId);
        if (!previousMarket) continue;
        const previousPrice = this.prices.get(marketId);
        const currentGenerationClosed = previousPrice?.generation === this.generation
          && previousPrice.marketDefinition?.status === "CLOSED";
        if (currentGenerationClosed || this.closedMarketIds.has(marketId)) {
          this.catalogueAbsenceCycles.delete(marketId);
          this.catalogueMissingMarkets.delete(marketId);
          continue;
        }
        const previousAbsence = this.catalogueAbsenceCycles.get(marketId);
        const absentCycles = (previousAbsence?.absentCycles ?? 0) + 1;
        const absence = {
          market: previousMarket,
          reason: currentCatalogue.has(marketId) ? "selection-filtered" : "catalogue-missing",
          absentCycles,
          absentSinceAt: previousAbsence?.absentSinceAt ?? now,
          lastSeenAt: currentCatalogue.has(marketId)
            ? now
            : previousAbsence?.lastSeenAt ?? this.lastCatalogueRefreshAt,
        };
        this.catalogueAbsenceCycles.set(marketId, absence);
        if (absentCycles < absenceConfirmations) {
          effectiveCatalogue.set(marketId, previousMarket);
          effectiveSelected.set(marketId, previousMarket);
          hysteresisRetained.add(marketId);
          continue;
        }
        const existingMissing = this.catalogueMissingMarkets.get(marketId);
        this.catalogueMissingMarkets.set(marketId, {
          ...absence,
          confirmedAt: existingMissing?.confirmedAt ?? now,
        });
      }
      const missingRetentionMs = Math.max(0, CONFIG.catalogueMissingRetentionMs);
      for (const [marketId, missing] of this.catalogueMissingMarkets) {
        if (missingRetentionMs === 0 || now - missing.confirmedAt > missingRetentionMs) {
          this.catalogueMissingMarkets.delete(marketId);
          this.catalogueAbsenceCycles.delete(marketId);
        }
      }

      this.catalogue = effectiveCatalogue;
      this.hysteresisRetainedMarketIds = hysteresisRetained;
      this.catalogueRawMarkets = marketRows.length;
      this.catalogueUniqueMarkets = currentCatalogue.size;
      this.catalogueDuplicateMarkets = Math.max(0, marketRows.length - currentCatalogue.size);
      this.catalogueRetainedByHysteresis = hysteresisRetained.size;
      const selected = [...effectiveSelected.values()];
      const subscription = this.syncSubscriptions(selected);
      this.lastCatalogueRefreshAt = Date.now();
      this.nextCatalogueRefreshAt = this.lastCatalogueRefreshAt + CONFIG.catalogueMs;
      this.catalogueConsecutiveFailures = 0;
      this.lastCatalogueError = null;
      this.lastError = null;
      commitStats();
      return {
        catalogueMarkets: effectiveCatalogue.size,
        catalogueRawMarkets: marketRows.length,
        catalogueUniqueMarkets: currentCatalogue.size,
        catalogueDuplicateMarkets: Math.max(0, marketRows.length - currentCatalogue.size),
        catalogueRetainedByHysteresis: hysteresisRetained.size,
        selectedMarkets: selected.length,
        liveMarkets: selected.filter(market => market.inPlay).length,
        addedMarkets: subscription.addedMarkets,
        reusedMarkets: subscription.reusedMarkets,
        retainedMarkets: subscription.retainedMarkets,
        fetchAttempts: stats.attempts,
        fetchRetries: stats.retries,
      };
    } catch (error) {
      commitStats();
      this.catalogueConsecutiveFailures += 1;
      this.lastCatalogueError = errorText(error);
      const delay = Math.min(
        CONFIG.catalogueFailureBackoffMaxMs,
        CONFIG.catalogueFailureBackoffBaseMs * 2 ** Math.min(this.catalogueConsecutiveFailures - 1, 6),
      );
      this.nextCatalogueRefreshAt = Date.now() + delay;
      throw error;
    }
  }

  syncSubscriptions(markets) {
    const nextSelectedMarketIds = new Set(markets.map(market => market.marketId));
    const affectedConnections = new Map();
    for (const [marketId, connection] of this.marketConnections) {
      if (nextSelectedMarketIds.has(marketId)) continue;
      this.marketConnections.delete(marketId);
      if (connection) {
        if (!affectedConnections.has(connection)) affectedConnections.set(connection, connection.lastSubscriptionSerial ?? 0);
        connection.markets = connection.markets.filter(market => market.marketId !== marketId);
        connection.ready.delete(marketId);
      }
    }
    for (const marketId of this.marketLastSubscriptionAt.keys()) {
      if (!nextSelectedMarketIds.has(marketId)) this.marketLastSubscriptionAt.delete(marketId);
    }
    for (const marketId of this.marketRecovery.keys()) {
      if (!nextSelectedMarketIds.has(marketId)) this.marketRecovery.delete(marketId);
    }
    const additions = markets.filter(market => !this.marketConnections.has(market.marketId));
    const retainedMarkets = [...nextSelectedMarketIds].filter(marketId => this.selectedMarketIds.has(marketId)).length;

    this.selectedMarketIds = nextSelectedMarketIds;
    if (this.compactionActive) {
      for (const marketId of this.compactionActive.marketIds) {
        if (!nextSelectedMarketIds.has(marketId)) this.compactionActive.marketIds.delete(marketId);
      }
      for (const marketId of this.compactionActive.receivedIds ?? []) {
        if (!nextSelectedMarketIds.has(marketId)) this.compactionActive.receivedIds.delete(marketId);
      }
      for (const marketId of this.compactionActive.freshIds ?? []) {
        if (!nextSelectedMarketIds.has(marketId)) this.compactionActive.freshIds.delete(marketId);
      }
      if ([...this.compactionActive.marketIds]
        .map(marketId => this.catalogue.get(marketId))
        .filter(Boolean)
        .some(market => this.isLiveMarket(market))) {
        this.compactionActive.requireFresh = true;
      }
      if (this.compactionActive.marketIds.size === 0 && this.compactionActive.connection) {
        this.abortCompactionHandoff(this.compactionActive.connection);
      }
    }
    for (const marketId of this.prices.keys()) {
      if (!nextSelectedMarketIds.has(marketId)) this.prices.delete(marketId);
    }

    if (this.generation === 0) this.generation = 1;
    const unassignedAdditions = this.assignAdditionsToExistingSockets(additions);
    for (let index = 0; index < unassignedAdditions.length; index += CONFIG.marketsPerSocket) {
      this.openSocket(unassignedAdditions.slice(index, index + CONFIG.marketsPerSocket), this.generation, 0);
    }
    for (const [connection, previousSubscriptionSerial] of affectedConnections) {
      if (!this.connections.includes(connection) || connection.intentional) continue;
      const activeMarkets = connection.markets.filter(market => this.selectedMarketIds.has(market.marketId));
      if (activeMarkets.length === 0) {
        this.restartConnection(connection, "empty");
        continue;
      }
      if (connection.socket?.readyState !== WebSocket.OPEN
        || connection.lastSubscriptionSerial !== previousSubscriptionSerial) continue;
      const neverSubscribed = activeMarkets.filter(market => !this.marketLastSubscriptionAt.has(market.marketId));
      this.sendSubscription(connection, activeMarkets, neverSubscribed);
    }
    this.maybeCompactSockets();
    return { addedMarkets: additions.length, reusedMarkets: additions.length - unassignedAdditions.length, retainedMarkets };
  }

  assignAdditionsToExistingSockets(additions) {
    if (additions.length === 0) return additions;
    const candidates = this.connections
      .filter(connection => !connection.intentional && !connection.handoff
        && (connection.socket?.readyState === WebSocket.OPEN || connection.socket?.readyState === WebSocket.CONNECTING))
      .map(connection => {
        const activeMarkets = connection.markets.filter(market => this.selectedMarketIds.has(market.marketId));
        return { connection, activeMarkets, capacity: Math.max(0, CONFIG.marketsPerSocket - activeMarkets.length) };
      })
      .filter(entry => entry.capacity > 0)
      .sort((left, right) => right.activeMarkets.length - left.activeMarkets.length);
    const assignments = new Map();
    let offset = 0;
    for (const entry of candidates) {
      if (offset >= additions.length) break;
      const assigned = additions.slice(offset, offset + entry.capacity);
      if (assigned.length === 0) continue;
      entry.connection.markets = [...entry.activeMarkets, ...assigned];
      for (const market of assigned) this.marketConnections.set(market.marketId, entry.connection);
      assignments.set(entry.connection, assigned);
      offset += assigned.length;
    }
    for (const [connection, assigned] of assignments) {
      // SharpX subscriptions replace the complete socket subscription. Keep
      // existing ready markets intact and reset only newly assigned markets.
      this.sendSubscription(connection, connection.markets, assigned);
    }
    if (offset > 0) console.log(`[socket-reuse] markets=${offset} sockets=${assignments.size}`);
    return additions.slice(offset);
  }

  isLiveMarket(market) {
    const price = this.prices.get(market.marketId);
    return market.inPlay === true || price?.marketDefinition?.inPlay === true;
  }

  marketState(market, now = Date.now()) {
    const marketId = market.marketId;
    const connection = this.marketConnections.get(marketId) ?? null;
    const price = this.prices.get(marketId) ?? null;
    const connectionOpen = connection?.socket?.readyState === WebSocket.OPEN;
    let readinessReason = null;
    if (!connection) readinessReason = "owner-missing";
    else if (connection.generation !== this.generation) readinessReason = "owner-generation";
    else if (!connectionOpen) readinessReason = connection.socket?.readyState === WebSocket.CONNECTING ? "socket-connecting" : "socket-not-open";
    else if (!connection.ready.has(marketId)) readinessReason = "subscription-not-ready";
    else if (!price) readinessReason = "price-missing";
    else if (price.generation !== this.generation) readinessReason = "price-generation";
    const ready = readinessReason === null;
    const definition = price?.marketDefinition ?? {};
    const inPlay = definition.inPlay ?? market.inPlay;
    const status = definition.status ?? "OPEN";
    const receivedAt = Number(price?.receivedAt);
    const ageMs = Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : null;
    const staleThresholdMs = Math.max(0, inPlay ? CONFIG.liveMarketStaleMs : CONFIG.prematchMarketStaleMs);
    const currentGenerationPrice = price?.generation === this.generation;
    const stale = ready && status === "OPEN"
      && staleThresholdMs > 0 && ageMs !== null && ageMs > staleThresholdMs;
    const recovery = this.marketRecovery.get(marketId) ?? null;
    return {
      connection,
      price,
      ready,
      readinessReason,
      inPlay,
      status,
      receivedAt: Number.isFinite(receivedAt) ? receivedAt : null,
      ageMs,
      staleThresholdMs,
      stale:
        stale ||
        (recovery?.triggerReason === "stale" &&
          status === "OPEN" &&
          staleThresholdMs > 0),
      closed: currentGenerationPrice && status === "CLOSED",
      recovery,
    };
  }

  marketDiagnostic(market, reason, state, extra = {}) {
    const socketStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    const socketState = state?.connection?.socket?.readyState;
    return {
      reason,
      marketId: market.marketId,
      eventId: market.eventId,
      eventName: market.eventName,
      competitionName: market.competitionName,
      marketStartTime: market.marketStartTime,
      inPlay: state?.inPlay ?? market.inPlay,
      status: state?.status ?? null,
      receivedAt: state?.receivedAt ?? null,
      ageMs: state?.ageMs ?? null,
      staleThresholdMs: state?.staleThresholdMs ?? null,
      readinessReason: state?.readinessReason ?? null,
      connectionId: state?.connection?.id ?? null,
      connectionState: Number.isInteger(socketState) ? socketStates[socketState] ?? String(socketState) : null,
      connectionGeneration: state?.connection?.generation ?? null,
      priceGeneration: state?.price?.generation ?? null,
      lastSubscriptionAt: this.marketLastSubscriptionAt.get(market.marketId) ?? null,
      recoveryAttempts: state?.recovery?.attempts ?? 0,
      recoveryStartedAt: state?.recovery?.startedAt ?? null,
      recoveryLastAttemptAt: state?.recovery?.lastAttemptAt ?? null,
      ...extra,
    };
  }

  resetMarketRestartBackoffIfReady(connection) {
    if (!connection.marketRestartBackoffLevel) return;
    const ownedMarkets = connection.markets
      .map(market => this.catalogue.get(market.marketId))
      .filter(market => market && this.selectedMarketIds.has(market.marketId)
        && this.marketConnections.get(market.marketId) === connection);
    if (ownedMarkets.length === 0 || !ownedMarkets.every(market => {
      const state = this.marketState(market);
      return state.ready && !state.stale;
    })) return;
    connection.marketRestartBackoffLevel = 0;
    connection.marketRestartCooldownUntil = 0;
  }

  resetCompactionPressure() {
    this.compactionPressureCycles = 0;
    this.compactionCandidateSockets = 0;
    this.compactionCandidateMarkets = 0;
  }

  scheduleCompactionProcessing(delayMs) {
    if (this.compactionTimer || this.compactionQueue.length === 0) return;
    this.compactionTimer = setTimeout(() => {
      this.compactionTimer = null;
      this.processCompactionQueue();
    }, Math.max(0, delayMs));
  }

  maybeCompactSockets() {
    const activeMarkets = [...this.selectedMarketIds]
      .map(marketId => this.catalogue.get(marketId))
      .filter(Boolean);
    if (activeMarkets.length === 0) return;
    const targetSockets = Math.ceil(activeMarkets.length / Math.max(1, CONFIG.marketsPerSocket));
    const currentSockets = this.connections.filter(connection =>
      connection.socket?.readyState === WebSocket.OPEN || connection.socket?.readyState === WebSocket.CONNECTING,
    ).length;
    const threshold = Math.max(targetSockets + 5, Math.ceil(targetSockets * CONFIG.socketCompactionFactor));
    const now = Date.now();
    if (currentSockets <= threshold) {
      this.resetCompactionPressure();
      return;
    }
    if (this.compactionActive || this.compactionQueue.length > 0) return;

    const candidates = this.connections
      .map(connection => ({
        connection,
        markets: connection.markets.filter(market => this.selectedMarketIds.has(market.marketId)),
      }))
      .filter(entry => entry.markets.length > 0 && entry.markets.every(market => !this.isLiveMarket(market)))
      .sort((left, right) => left.markets.length - right.markets.length);
    if (candidates.length === 0) {
      this.resetCompactionPressure();
      return;
    }
    // The catalogue naturally changes every minute, so the exact market/socket
    // membership is not a useful stability key. Count consecutive aggregate
    // pressure cycles instead; the handoff itself still revalidates every
    // market before closing any source socket.
    this.compactionPressureCycles += 1;
    this.compactionCandidateSockets = candidates.length;
    this.compactionCandidateMarkets = candidates.reduce((total, entry) => total + entry.markets.length, 0);
    const requiredCycles = Math.max(1, CONFIG.socketCompactionConfirmations);
    if (this.compactionPressureCycles < requiredCycles) {
      console.log(`[socket-compaction-pending] cycles=${this.compactionPressureCycles}/${requiredCycles} sockets=${currentSockets} target=${targetSockets} candidates=${candidates.length}`);
      return;
    }
    if (this.lastSocketCompactionAt && now - this.lastSocketCompactionAt < CONFIG.socketCompactionMs) return;

    const queue = [];
    let group = [];
    let groupSize = 0;
    for (const entry of candidates) {
      if (group.length > 0 && groupSize + entry.markets.length > CONFIG.marketsPerSocket) {
        if (group.length >= 2) queue.push({ sources: group.map(item => item.connection), markets: group.flatMap(item => item.markets) });
        group = [];
        groupSize = 0;
      }
      group.push(entry);
      groupSize += entry.markets.length;
    }
    if (group.length >= 2) queue.push({ sources: group.map(item => item.connection), markets: group.flatMap(item => item.markets) });
    if (queue.length === 0) {
      this.resetCompactionPressure();
      return;
    }
    this.compactionQueue = queue;
    this.resetCompactionPressure();
    console.log(`[socket-compaction-queued] sockets=${currentSockets} target=${targetSockets} groups=${queue.length}`);
    this.processCompactionQueue();
  }

  processCompactionQueue() {
    if (this.compactionActive || this.compactionQueue.length === 0) return;
    const now = Date.now();
    if (this.lastSocketCompactionAt) {
      const remaining = CONFIG.socketCompactionMs - (now - this.lastSocketCompactionAt);
      if (remaining > 0) {
        this.scheduleCompactionProcessing(remaining);
        return;
      }
    }
    const queued = this.compactionQueue.shift();
    const sources = queued.sources.filter(source => this.connections.includes(source) && !source.intentional);
    const markets = sources
      .flatMap(source => source.markets)
      .filter((market, index, list) => this.selectedMarketIds.has(market.marketId) && list.findIndex(item => item.marketId === market.marketId) === index);
    if (sources.length < 2 || markets.length === 0 || markets.length > CONFIG.marketsPerSocket || markets.some(market => this.isLiveMarket(market))) {
      this.processCompactionQueue();
      return;
    }
    const handoff = {
      sources,
      marketIds: new Set(markets.map(market => market.marketId)),
      receivedIds: new Set(),
      freshIds: new Set(),
      requireFresh: markets.some(market => this.isLiveMarket(market)),
      completed: false,
    };
    this.compactionActive = handoff;
    const connection = this.openSocket(markets, this.generation, 0, { allowExisting: true, handoff });
    if (!connection) {
      this.compactionActive = null;
      this.processCompactionQueue();
    } else {
      handoff.connection = connection;
    }
  }

  abortCompactionHandoff(connection) {
    if (!connection.handoff || connection.handoff.completed) return;
    const shouldContinue = !connection.intentional;
    connection.handoff.failed = true;
    connection.handoff = null;
    connection.intentional = true;
    this.compactionActive = null;
    this.detachConnection(connection);
    try { connection.socket.close(); } catch { /* The socket may already be closed. */ }
    if (shouldContinue) this.processCompactionQueue();
  }

  completeCompactionHandoff(connection) {
    const handoff = connection.handoff;
    if (!handoff || handoff.completed || !this.compactionActive) return;
    handoff.completed = true;
    for (const source of handoff.sources) {
      source.intentional = true;
      this.detachConnection(source);
      try { source.socket.close(); } catch { /* The socket may already be closed. */ }
    }
    for (const marketId of handoff.marketIds) this.marketConnections.set(marketId, connection);
    connection.markets = [...handoff.marketIds].map(marketId => this.catalogue.get(marketId)).filter(Boolean);
    connection.handoff = null;
    this.compactionActive = null;
    this.socketCompactions += 1;
    this.lastSocketCompactionAt = Date.now();
    console.log(`[socket-compaction] sources=${handoff.sources.length} markets=${handoff.marketIds.size}`);
    this.processCompactionQueue();
  }

  openSocket(markets, generation, attempt, options = {}) {
    if (this.closed || generation !== this.generation || markets.length === 0) return;
    const ownedMarkets = markets.filter(market => this.selectedMarketIds.has(market.marketId) && (options.allowExisting || !this.marketConnections.has(market.marketId)));
    if (ownedMarkets.length === 0) return;
    if (options.reconnect) this.socketReconnectAttempts += 1;
    const url = `${WS_BASE}/${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}/${crypto.randomUUID()}/websocket`;
    const connection = {
      id: this.nextConnectionId++,
      socket: null, markets: ownedMarkets, generation, ready: new Set(), opened: false,
      intentional: false, createdAt: Date.now(), lastFrameAt: null, handoff: options.handoff ?? null,
      reconnect: options.reconnect === true,
      lastSubscriptionSerial: 0,
      marketRestartBackoffLevel: options.marketRestartBackoffLevel ?? 0,
      marketRestartCooldownUntil: options.marketRestartCooldownUntil ?? 0,
    };
    if (!options.allowExisting) for (const market of ownedMarkets) this.marketConnections.set(market.marketId, connection);
    this.connections.push(connection);
    try {
      connection.socket = new WebSocket(url);
    } catch (error) {
      const retryMarkets = this.detachConnection(connection);
      this.lastSocketError = errorText(error);
      if (!options.handoff && !this.closed && generation === this.generation && retryMarkets.length > 0) {
        setTimeout(
          () => this.openSocket(retryMarkets, generation, attempt + 1, {
            reconnect: true,
            marketRestartBackoffLevel: connection.marketRestartBackoffLevel,
            marketRestartCooldownUntil: connection.marketRestartCooldownUntil,
          }),
          Math.min(10000, 500 * 2 ** Math.min(attempt, 5)),
        );
      }
      return null;
    }
    connection.socket.addEventListener("message", event => {
      if (generation !== this.generation) return;
      const raw = String(event.data);
      connection.lastFrameAt = Date.now();
      if (raw === "o") {
        if (!connection.opened && connection.reconnect) this.socketReconnects += 1;
        connection.opened = true;
        const activeMarkets = connection.markets.filter(market => this.selectedMarketIds.has(market.marketId));
        this.sendSubscription(connection, activeMarkets);
        return;
      }
      if (raw === "h" || !raw.startsWith("a")) return;
      try {
        for (const encoded of JSON.parse(raw.slice(1))) {
          for (const update of (Array.isArray(JSON.parse(encoded)) ? JSON.parse(encoded) : [JSON.parse(encoded)])) {
            if (!update.id || !this.catalogue.has(update.id) || !this.selectedMarketIds.has(update.id)) continue;
            if (connection.handoff?.marketIds.has(update.id)) connection.handoff.receivedIds.add(update.id);
            const previous = this.prices.get(update.id);
            const olderThanCurrent = Number.isFinite(previous?.apiPt) && Number.isFinite(update.apiPt) && update.apiPt < previous.apiPt;
            if (olderThanCurrent) {
              // This socket answered for the market, so its subscription is
              // ready even if a different/earlier connection already supplied
              // a newer price. Keep the newer cache and do not call this a
              // fresh compaction handoff update.
              connection.ready.add(update.id);
              this.marketRecovery.delete(update.id);
              continue;
            }
            const nextPrice = mergeSharpXPrice(previous, update, generation, Date.now());
            this.prices.set(update.id, nextPrice);
            connection.ready.add(update.id);
            this.marketRecovery.delete(update.id);
            const market = this.catalogue.get(update.id);
            if (nextPrice.marketDefinition?.status === "CLOSED") {
              this.closedMarketIds.add(update.id);
              if (market) {
                this.recentClosedMarkets.set(update.id, {
                  market,
                  closedAt: nextPrice.receivedAt,
                  apiPt: nextPrice.apiPt ?? null,
                });
              }
            } else if (nextPrice.marketDefinition?.status) {
              this.closedMarketIds.delete(update.id);
              this.recentClosedMarkets.delete(update.id);
            }
            if (connection.handoff?.marketIds.has(update.id)) connection.handoff.freshIds.add(update.id);
          }
        }
        this.resetMarketRestartBackoffIfReady(connection);
        if (connection.handoff && connection.handoff.marketIds.size === 0) {
          this.abortCompactionHandoff(connection);
        } else if (connection.handoff) {
          const readyIds = connection.handoff.requireFresh ? connection.handoff.freshIds : connection.handoff.receivedIds;
          if ([...connection.handoff.marketIds].every(marketId => readyIds.has(marketId))) this.completeCompactionHandoff(connection);
        }
      } catch (error) { this.lastError = errorText(error); }
    });
    connection.socket.addEventListener("error", () => { this.lastSocketError = "SharpX direct WebSocket hiba"; });
    connection.socket.addEventListener("close", () => {
      this.socketCloseEvents += 1;
      if (!connection.intentional) this.socketUnexpectedCloses += 1;
      if (connection.handoff && !connection.handoff.completed) {
        this.abortCompactionHandoff(connection);
        return;
      }
      const retryMarkets = this.detachConnection(connection);
      if (!connection.intentional && generation === this.generation) {
        setTimeout(
          () => this.openSocket(retryMarkets, generation, attempt + 1, {
            reconnect: true,
            marketRestartBackoffLevel: connection.marketRestartBackoffLevel,
            marketRestartCooldownUntil: connection.marketRestartCooldownUntil,
          }),
          Math.min(10000, 500 * 2 ** Math.min(attempt, 5)),
        );
      }
    });
    return connection;
  }

  sendSubscription(connection, markets, resetMarkets = markets) {
    if (!connection.socket || connection.socket.readyState !== WebSocket.OPEN || markets.length === 0) return false;
    try {
      connection.socket.send(JSON.stringify([JSON.stringify(markets.map(market => ({ marketId: market.marketId, eventId: market.eventId, applicationType: "WEB" })))]));
      connection.lastSubscriptionSerial = this.nextSubscriptionSerial++;
      const now = Date.now();
      for (const market of resetMarkets) {
        this.marketLastSubscriptionAt.set(market.marketId, now);
        connection.ready.delete(market.marketId);
      }
      return true;
    } catch (error) {
      this.lastSocketError = errorText(error);
      return false;
    }
  }

  resubscribeUnhealthyMarkets(now) {
    const selectedMarketIds = [...this.selectedMarketIds];
    if (selectedMarketIds.length === 0) return;
    const candidateLimit = Math.max(1, CONFIG.marketResubscribeBatchSize);
    const byConnection = new Map();
    const restartConnections = new Map();
    const cooldownDeferredConnections = new Set();
    let inspected = 0;
    let candidates = 0;
    while (inspected < selectedMarketIds.length && candidates < candidateLimit) {
      const index = (this.resubscribeCursor + inspected) % selectedMarketIds.length;
      const marketId = selectedMarketIds[index];
      inspected += 1;
      const market = this.catalogue.get(marketId);
      if (!market) continue;
      const state = this.marketState(market, now);
      if (state.closed) {
        this.marketRecovery.delete(marketId);
        continue;
      }
      const triggerReason = state.stale ? "stale" : (!state.ready ? "not-ready" : null);
      if (!triggerReason) {
        this.marketRecovery.delete(marketId);
        continue;
      }
      const connection = state.connection;
      if (!connection || connection.generation !== this.generation
        || connection.socket?.readyState !== WebSocket.OPEN || connection.handoff) continue;
      let recovery = this.marketRecovery.get(marketId);
      if (
        recovery?.triggerReason === "stale" &&
        !(state.status === "OPEN" && state.staleThresholdMs > 0)
      ) {
        this.marketRecovery.delete(marketId);
        recovery = null;
      }
      if (recovery) {
        if (now - recovery.lastAttemptAt < Math.max(1, CONFIG.marketReadyTimeoutMs)) continue;
        if (recovery.attempts >= Math.max(1, CONFIG.marketRecoveryAttempts)) {
          if (now < (connection.marketRestartCooldownUntil ?? 0)) {
            if (!cooldownDeferredConnections.has(connection)) {
              cooldownDeferredConnections.add(connection);
              this.marketRestartDeferredByCooldown += 1;
            }
            continue;
          }
          const problems = restartConnections.get(connection) ?? [];
          problems.push({ marketId, reason: recovery.triggerReason });
          if (!restartConnections.has(connection)) candidates += 1;
          restartConnections.set(connection, problems);
          continue;
        }
      }
      const lastSubscriptionAt = this.marketLastSubscriptionAt.get(marketId) ?? 0;
      if (!recovery && triggerReason === "not-ready" && now - lastSubscriptionAt < Math.max(1, CONFIG.marketResubscribeMs)) continue;
      const problems = byConnection.get(connection) ?? [];
      problems.push({ market, triggerReason, recovery });
      candidates += 1;
      byConnection.set(connection, problems);
    }
    this.resubscribeCursor = (this.resubscribeCursor + Math.max(1, inspected)) % selectedMarketIds.length;

    let marketRestartsThisTick = 0;
    const maxMarketRestartsPerTick = Math.max(1, CONFIG.marketRestartMaxPerTick);
    for (const [connection, problems] of restartConnections) {
      if (marketRestartsThisTick >= maxMarketRestartsPerTick) {
        this.marketRestartDeferredByLimit += 1;
        continue;
      }
      const sample = problems.slice(0, 3).map(problem => problem.marketId).join(",");
      const triggerReasons = new Set(problems.map(problem => problem.reason));
      const restarted = this.restartConnection(connection, `market-ready-timeout:${sample}`, {
        marketTriggered: true,
        staleTriggered: triggerReasons.has("stale"),
        notReadyTriggered: triggerReasons.has("not-ready"),
      });
      if (restarted) marketRestartsThisTick += 1;
    }
    for (const [connection, problems] of byConnection) {
      if (restartConnections.has(connection) || !this.connections.includes(connection)) continue;
      const activeMarkets = connection.markets.filter(market => this.selectedMarketIds.has(market.marketId));
      // The SharpX message is a complete subscription for the socket. Always
      // resend the full owned set; sending only unhealthy markets would silently
      // unsubscribe the remaining markets on that connection.
      const recoveryMarkets = problems.map(problem => problem.market);
      if (this.sendSubscription(connection, activeMarkets, recoveryMarkets)) {
        for (const problem of problems) {
          const previous = problem.recovery;
          this.marketRecovery.set(problem.market.marketId, {
            attempts: (previous?.attempts ?? 0) + 1,
            startedAt: previous?.startedAt ?? now,
            lastAttemptAt: now,
            triggerReason: previous?.triggerReason ?? problem.triggerReason,
          });
        }
        this.marketResends += recoveryMarkets.length;
      }
    }
  }

  detachConnection(connection) {
    this.connections = this.connections.filter(item => item !== connection);
    const activeMarkets = connection.markets
      .map(market => this.catalogue.get(market.marketId))
      .filter(market => market && this.selectedMarketIds.has(market.marketId));
    for (const market of connection.markets) {
      if (this.marketConnections.get(market.marketId) === connection) {
        this.marketConnections.delete(market.marketId);
        this.marketRecovery.delete(market.marketId);
      }
    }
    return activeMarkets;
  }

  restartConnection(connection, reason, options = {}) {
    if (connection.intentional || connection.generation !== this.generation) return false;
    const now = Date.now();
    let marketRestartBackoffLevel = Math.max(0, connection.marketRestartBackoffLevel ?? 0);
    let marketRestartCooldownUntil = Math.max(0, connection.marketRestartCooldownUntil ?? 0);
    let marketRestartCooldownMs = 0;
    if (options.marketTriggered) {
      marketRestartBackoffLevel += 1;
      marketRestartCooldownMs = Math.min(
        Math.max(1, CONFIG.marketRestartCooldownMaxMs),
        Math.max(1, CONFIG.marketRestartCooldownBaseMs) * 2 ** Math.min(marketRestartBackoffLevel - 1, 10),
      );
      marketRestartCooldownUntil = now + marketRestartCooldownMs;
    }
    connection.intentional = true;
    const markets = this.detachConnection(connection);
    try { connection.socket.close(); } catch { /* The close handler removes the old socket as well. */ }
    this.socketRestarts += 1;
    if (reason === "no-frame" || options.staleTriggered) this.staleSocketRestarts += 1;
    if (reason === "connect-timeout" || reason === "no-initial-prices" || options.notReadyTriggered) this.socketReadinessRestarts += 1;
    if (reason === "empty") this.emptySocketRestarts += 1;
    if (options.marketTriggered) {
      this.marketTriggeredSocketRestarts += 1;
      this.marketRestartLastAt = now;
      this.marketRestartLastCooldownMs = marketRestartCooldownMs;
      this.marketRestartMaxBackoffLevel = Math.max(this.marketRestartMaxBackoffLevel, marketRestartBackoffLevel);
    }
    this.lastSocketRestartAt = now;
    console.warn(`[socket-restart] reason=${reason} markets=${markets.length} cooldownMs=${marketRestartCooldownMs}`);
    this.openSocket(markets, this.generation, 0, {
      reconnect: true,
      marketRestartBackoffLevel,
      marketRestartCooldownUntil,
    });
    return true;
  }

  maintainConnections() {
    const now = Date.now();
    for (const connection of [...this.connections]) {
      if (connection.intentional || connection.generation !== this.generation) continue;
      if (connection.handoff) {
        if (now - connection.createdAt > CONFIG.socketReadyTimeoutMs * 2) this.abortCompactionHandoff(connection);
        continue;
      }
      const activeMarkets = connection.markets.filter(market => this.selectedMarketIds.has(market.marketId));
      if (activeMarkets.length === 0) {
        this.restartConnection(connection, "empty");
        continue;
      }
      const ageMs = now - connection.createdAt;
      const noRecentFrame = connection.socket?.readyState === WebSocket.OPEN
        && connection.lastFrameAt
        && now - connection.lastFrameAt > CONFIG.socketStaleMs;
      const connectingTooLong = connection.socket?.readyState === WebSocket.CONNECTING
        && ageMs > CONFIG.socketReadyTimeoutMs;
      const activeReadyMarkets = activeMarkets.filter(market => connection.ready.has(market.marketId)).length;
      const noInitialPrices = ageMs > CONFIG.socketReadyTimeoutMs && activeReadyMarkets === 0;
      if (noRecentFrame) this.restartConnection(connection, "no-frame");
      else if (connectingTooLong) this.restartConnection(connection, "connect-timeout");
      else if (noInitialPrices) this.restartConnection(connection, "no-initial-prices");
    }
    this.resubscribeUnhealthyMarkets(now);
  }

  snapshot() {
    const now = Date.now();
    const details = {
      "catalogue-missing": [],
      "hysteresis-retained": [],
      "not-ready": [],
      "not-renderable": [],
      stale: [],
      closed: [],
    };
    for (const missing of this.catalogueMissingMarkets.values()) {
      details["catalogue-missing"].push(this.marketDiagnostic(missing.market, "catalogue-missing", null, {
        catalogueAbsenceReason: missing.reason ?? "catalogue-missing",
        absentCycles: missing.absentCycles,
        absentSinceAt: missing.absentSinceAt,
        lastSeenAt: missing.lastSeenAt,
        confirmedAt: missing.confirmedAt,
      }));
    }
    const closedDetailIds = new Set();
    const closedDiagnosticRetentionMs = Math.max(0, CONFIG.closedDiagnosticRetentionMs);
    for (const [marketId, closed] of this.recentClosedMarkets) {
      if (closedDiagnosticRetentionMs === 0 || now - closed.closedAt > closedDiagnosticRetentionMs) {
        this.recentClosedMarkets.delete(marketId);
        continue;
      }
      const selectedMarket = this.selectedMarketIds.has(marketId) ? this.catalogue.get(marketId) : null;
      const state = selectedMarket ? this.marketState(selectedMarket, now) : null;
      details.closed.push(this.marketDiagnostic(closed.market, "closed", state, {
        status: "CLOSED",
        receivedAt: closed.closedAt,
        closedAt: closed.closedAt,
        apiPt: closed.apiPt,
      }));
      closedDetailIds.add(marketId);
    }

    const markets = [];
    let selectedClosedMarkets = 0;
    for (const marketId of this.selectedMarketIds) {
      const market = this.catalogue.get(marketId);
      if (!market) continue;
      const state = this.marketState(market, now);
      if (this.hysteresisRetainedMarketIds.has(marketId)) {
        const absence = this.catalogueAbsenceCycles.get(marketId);
        details["hysteresis-retained"].push(this.marketDiagnostic(market, "hysteresis-retained", state, {
          catalogueAbsenceReason: absence?.reason ?? "catalogue-missing",
          absentCycles: absence?.absentCycles ?? 0,
          absentSinceAt: absence?.absentSinceAt ?? null,
          lastSeenAt: absence?.lastSeenAt ?? null,
        }));
      }
      if (state.closed) {
        selectedClosedMarkets += 1;
        if (!closedDetailIds.has(marketId)) details.closed.push(this.marketDiagnostic(market, "closed", state));
        continue;
      }
      if (state.stale) {
        details.stale.push(this.marketDiagnostic(market, "stale", state));
        continue;
      }
      if (!state.ready) {
        details["not-ready"].push(this.marketDiagnostic(market, "not-ready", state));
        continue;
      }
      const price = state.price;
      const definition = price.marketDefinition ?? {};
      const candidate = {
        ...market,
        inPlay: definition.inPlay ?? market.inPlay,
        status: definition.status ?? "OPEN",
        betDelay: definition.betDelay ?? 0,
        totalMatched: Number(price.tv ?? market.totalMatched),
        apiPt: price.apiPt ?? null,
        receivedAt: price.receivedAt,
        runnerPrices: (price.rc ?? []).map(runner => ({ selectionId: Number(runner.id), bestLay: runner.bdatl?.[0] ?? null })),
      };
      if (!isRenderableMarket(candidate)) {
        details["not-renderable"].push(this.marketDiagnostic(
          candidate,
          "not-renderable",
          state,
          { renderabilityReason: candidate.status !== "OPEN" ? "status-not-open" : "no-executable-lay" },
        ));
        continue;
      }
      markets.push(candidate);
    }
    const diagnosticCounts = Object.fromEntries(Object.entries(details).map(([reason, entries]) => [reason, entries.length]));
    const missingOutputMarkets = diagnosticCounts["not-ready"]
      + diagnosticCounts.stale
      + diagnosticCounts["not-renderable"]
      + selectedClosedMarkets;
    const subscribedAccountingMatches = markets.length + missingOutputMarkets === this.selectedMarketIds.size;
    const detailLimit = Math.max(0, CONFIG.diagnosticDetailLimit);
    const limitedDetails = Object.fromEntries(Object.entries(details).map(([reason, entries]) => [reason, entries.slice(0, detailLimit)]));
    const openConnections = this.connections.filter(connection => connection.socket?.readyState === WebSocket.OPEN).length;
    const coolingConnections = this.connections.filter(connection => now < (connection.marketRestartCooldownUntil ?? 0));
    const marketRestartCooldownRemainingMs = coolingConnections.length > 0
      ? Math.max(...coolingConnections.map(connection => connection.marketRestartCooldownUntil - now))
      : 0;
    return {
      generatedAt: now, generation: this.generation,
      subscribedMarkets: this.selectedMarketIds.size, initializedMarkets: markets.length,
      marketDiagnostics: {
        healthy: markets.length,
        missingOutputMarkets,
        selectedClosedMarkets,
        subscribedAccountingMatches,
        counts: diagnosticCounts,
        detailLimit,
        details: limitedDetails,
      },
      socketConnections: this.connections.length, openSocketConnections: openConnections,
      marketSocketOwners: this.marketConnections.size,
      socketRestarts: this.socketRestarts, staleSocketRestarts: this.staleSocketRestarts,
      staleSocketRestartScope: "no-frame-or-live-open-market-stale",
      socketReadinessRestarts: this.socketReadinessRestarts,
      emptySocketRestarts: this.emptySocketRestarts,
      marketTriggeredSocketRestarts: this.marketTriggeredSocketRestarts,
      marketRestartDeferredByLimit: this.marketRestartDeferredByLimit,
      marketRestartDeferredByCooldown: this.marketRestartDeferredByCooldown,
      marketRestartLastAt: this.marketRestartLastAt,
      marketRestartLastCooldownMs: this.marketRestartLastCooldownMs,
      marketRestartMaxBackoffLevel: this.marketRestartMaxBackoffLevel,
      marketRestartCoolingSockets: coolingConnections.length,
      marketRestartCooldownRemainingMs,
      marketRestartMaxPerTick: Math.max(1, CONFIG.marketRestartMaxPerTick),
      marketRestartCooldownBaseMs: Math.max(1, CONFIG.marketRestartCooldownBaseMs),
      marketRestartCooldownMaxMs: Math.max(1, CONFIG.marketRestartCooldownMaxMs),
      socketCloseEvents: this.socketCloseEvents,
      socketUnexpectedCloses: this.socketUnexpectedCloses,
      socketReconnectAttempts: this.socketReconnectAttempts,
      socketReconnects: this.socketReconnects,
      socketCompactions: this.socketCompactions, lastSocketCompactionAt: this.lastSocketCompactionAt,
      socketCompactionPressureCycles: this.compactionPressureCycles,
      socketCompactionConfirmations: Math.max(1, CONFIG.socketCompactionConfirmations),
      socketCompactionCandidateSockets: this.compactionCandidateSockets,
      socketCompactionCandidateMarkets: this.compactionCandidateMarkets,
      socketCompactionCooldownRemainingMs: this.lastSocketCompactionAt
        ? Math.max(0, CONFIG.socketCompactionMs - (Date.now() - this.lastSocketCompactionAt))
        : 0,
      socketCompactionQueue: this.compactionQueue.length, socketCompactionActive: Boolean(this.compactionActive),
      socketCompactionReceived: this.compactionActive?.receivedIds?.size ?? 0,
      socketCompactionFresh: this.compactionActive?.freshIds?.size ?? 0,
      socketCompactionRequireFresh: this.compactionActive?.requireFresh ?? false,
      marketResends: this.marketResends,
      marketRecoveriesActive: this.marketRecovery.size,
      marketReadyTimeoutMs: Math.max(1, CONFIG.marketReadyTimeoutMs),
      marketRecoveryAttempts: Math.max(1, CONFIG.marketRecoveryAttempts),
      liveMarketStaleMs: Math.max(0, CONFIG.liveMarketStaleMs),
      prematchMarketStaleMs: Math.max(0, CONFIG.prematchMarketStaleMs),
      closedDiagnosticRetentionMs: Math.max(0, CONFIG.closedDiagnosticRetentionMs),
      lastSocketRestartAt: this.lastSocketRestartAt, lastSocketError: this.lastSocketError,
      lastCatalogueRefreshAt: this.lastCatalogueRefreshAt, nextCatalogueRefreshAt: this.nextCatalogueRefreshAt,
      catalogueRefreshInProgress: this.catalogueRefreshInProgress,
      catalogueRefreshStartedAt: this.catalogueRefreshStartedAt,
      catalogueRefreshCompletedAt: this.catalogueRefreshCompletedAt,
      catalogueRefreshLastDurationMs: this.catalogueRefreshLastDurationMs,
      catalogueRawMarkets: this.catalogueRawMarkets,
      catalogueUniqueMarkets: this.catalogueUniqueMarkets,
      catalogueDuplicateMarkets: this.catalogueDuplicateMarkets,
      catalogueRetainedByHysteresis: this.catalogueRetainedByHysteresis,
      catalogueAbsenceConfirmations: Math.max(1, CONFIG.catalogueAbsenceConfirmations),
      catalogueFetchAttempts: this.catalogueFetchAttempts, catalogueFetchRetries: this.catalogueFetchRetries,
      catalogueConsecutiveFailures: this.catalogueConsecutiveFailures, lastCatalogueError: this.lastCatalogueError,
      lastError: this.lastError, markets,
    };
  }

  close() {
    this.closed = true;
    if (this.compactionTimer) {
      clearTimeout(this.compactionTimer);
      this.compactionTimer = null;
    }
    for (const connection of this.connections) {
      connection.intentional = true;
      try { connection.socket?.close(); } catch { /* The socket may already be closed. */ }
    }
  }
}

async function main() {
  const writerLock = await acquireWriterLock(CONFIG.outputFile, "SharpX direct collector");
  let collector = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    collector?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    collector = new DirectCollector();
    const startedAt = Date.now();
    const refresh = async (startup = false) => {
      const refreshStartedAt = Date.now();
      collector.catalogueRefreshInProgress = true;
      collector.catalogueRefreshStartedAt = refreshStartedAt;
      try {
        const result = await collector.refreshCatalogue({ startup });
        if (result) {
          console.log(`[catalogue] total=${result.catalogueMarkets} raw=${result.catalogueRawMarkets} unique=${result.catalogueUniqueMarkets} duplicates=${result.catalogueDuplicateMarkets} selected=${result.selectedMarkets} live=${result.liveMarkets} added=${result.addedMarkets} reused=${result.reusedMarkets} retained=${result.retainedMarkets} hysteresis=${result.catalogueRetainedByHysteresis} attempts=${result.fetchAttempts} retries=${result.fetchRetries}`);
        }
      } catch (error) {
        collector.lastError = errorText(error);
        console.error(`[catalogue] ${collector.lastError}`);
      } finally {
        collector.catalogueRefreshInProgress = false;
        collector.catalogueRefreshCompletedAt = Date.now();
        collector.catalogueRefreshLastDurationMs = collector.catalogueRefreshCompletedAt - refreshStartedAt;
      }
    };
    // Startup uses a short, bounded retry profile so readiness is not held
    // hostage by the full long-running catalogue retry budget. Subsequent
    // refreshes use the more tolerant profile and retain the last good state.
    await refresh(true);
    let refreshPromise = null;
    const requestRefresh = () => {
      if (refreshPromise || stopped || collector.closed) return;
      refreshPromise = refresh().finally(() => { refreshPromise = null; });
    };
    let lastStatus = "";
    while (!stopped && (!CONFIG.durationMs || Date.now() - startedAt < CONFIG.durationMs)) {
      collector.maintainConnections();
      const snapshot = collector.snapshot();
      await writeAtomically(CONFIG.outputFile, snapshot);
      const status = `${snapshot.initializedMarkets}/${snapshot.subscribedMarkets}`;
      if (status !== lastStatus) { lastStatus = status; console.log(`[output] ${status} markets -> ${CONFIG.outputFile}`); }
      if (Date.now() >= collector.nextCatalogueRefreshAt) requestRefresh();
      await sleep(CONFIG.outputMs);
    }
  } finally {
    stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await writerLock.release();
  }
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
}
