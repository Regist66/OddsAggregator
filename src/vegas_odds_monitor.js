import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireWriterLock, writeTextAtomically } from "./atomic_file.js";
import { envNumber } from "./numeric_config.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
const CONFIG_DIR = path.join(PROJECT_DIR, "config");

export function resolveVegasTimezoneOffsetMinutes(value, date = new Date()) {
  if (value === undefined || value === null || value === "") {
    return date.getTimezoneOffset();
  }
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
    throw new Error(`Érvénytelen VEGAS_TIMEZONE_OFFSET_MINUTES: ${value}`);
  }
  return offset;
}

const CONFIG = {
  cdpEndpoint: process.env.VEGAS_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
  targetUrlPrefix: process.env.VEGAS_TARGET_URL_PREFIX ?? "https://vegas.hu/sports",
  outputFile:
    process.env.VEGAS_OUTPUT_FILE ?? path.join(DATA_DIR, "vegas_odds_snapshot.json"),
  watchlistFile:
    process.env.SHARPX_WATCHLIST_FILE ?? path.join(DATA_DIR, "sharpx_watchlist.json"),
  teamAliasesFile:
    process.env.TEAM_ALIASES_FILE ?? path.join(CONFIG_DIR, "team_aliases.json"),
  outputIntervalMs: envNumber("VEGAS_OUTPUT_INTERVAL_MS", 1_000, {
    integer: true,
    min: 100,
  }),
  matchedRefreshMs: envNumber("VEGAS_MATCHED_REFRESH_MS", 5_000, {
    integer: true,
    min: 250,
  }),
  catalogueRefreshMs: envNumber("VEGAS_CATALOGUE_REFRESH_MS", 300_000, {
    integer: true,
    min: 1_000,
  }),
  liveRefreshMs: envNumber("VEGAS_LIVE_REFRESH_MS", 1_000, {
    integer: true,
    min: 250,
  }),
  // Keep the live request comfortably below the comparator's 5s freshness
  // gate, leaving room for response parsing and atomic snapshot publication.
  // The generic request timeout remains longer for catalogue/detail calls.
  liveRequestTimeoutMs: envNumber("VEGAS_LIVE_REQUEST_TIMEOUT_MS", 3_000, {
    integer: true,
    min: 100,
    max: 120_000,
  }),
  liveRequestRetries: envNumber("VEGAS_LIVE_REQUEST_RETRIES", 1, {
    integer: true,
    min: 0,
    max: 3,
  }),
  liveRetryDelayMs: envNumber("VEGAS_LIVE_RETRY_DELAY_MS", 150, {
    integer: true,
    min: 0,
    max: 5_000,
  }),
  // The retry budget is bounded as a whole. Without this cap, a 3s timeout
  // plus one retry could keep lastLiveRefreshAt stale for more than 6s.
  liveRequestBudgetMs: envNumber("VEGAS_LIVE_REQUEST_BUDGET_MS", 4_500, {
    integer: true,
    min: 100,
    max: 120_000,
  }),
  liveFailureBackoffMs: envNumber("VEGAS_LIVE_FAILURE_BACKOFF_MS", 500, {
    integer: true,
    min: 0,
    max: 60_000,
  }),
  liveFailureBackoffMaxMs: envNumber("VEGAS_LIVE_FAILURE_BACKOFF_MAX_MS", 5_000, {
    integer: true,
    min: 0,
    max: 120_000,
  }),
  enhancedDetailConcurrency: envNumber("VEGAS_ENHANCED_DETAIL_CONCURRENCY", 12, {
    integer: true,
    min: 1,
    max: 64,
  }),
  matchedRequestTimeoutMs: envNumber("VEGAS_MATCHED_REQUEST_TIMEOUT_MS", 8_000, {
    integer: true,
    min: 100,
    max: 120_000,
  }),
  matchedRequestRetries: envNumber("VEGAS_MATCHED_REQUEST_RETRIES", 1, {
    integer: true,
    min: 0,
    max: 3,
  }),
  matchedRetryDelayMs: envNumber("VEGAS_MATCHED_RETRY_DELAY_MS", 250, {
    integer: true,
    min: 0,
    max: 5_000,
  }),
  requestTimeoutMs: envNumber("VEGAS_REQUEST_TIMEOUT_MS", 15_000, {
    integer: true,
    min: 100,
    max: 120_000,
  }),
  cdpCommandTimeoutMs: envNumber("CDP_COMMAND_TIMEOUT_MS", 15_000, {
    integer: true,
    min: 1_000,
    max: 120_000,
  }),
  timezoneOffsetMinutes:
    process.env.VEGAS_TIMEZONE_OFFSET_MINUTES === undefined
      ? null
      : resolveVegasTimezoneOffsetMinutes(process.env.VEGAS_TIMEZONE_OFFSET_MINUTES),
  once: process.env.VEGAS_ONCE === "1",
};

const EVENT_TIME_BUCKET_MS = 30 * 60_000;

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

function createMonitorDiagnostics() {
  return {
    version: 1,
    startedAt: Date.now(),
    cdp: {
      connectAttempts: 0,
      connectSuccesses: 0,
      connectFailures: 0,
      connectTimeouts: 0,
      commandTimeouts: 0,
      commandErrors: 0,
      unexpectedDisconnects: 0,
      contextTimeouts: 0,
    },
    initialization: {
      attempts: 0,
      successes: 0,
      failures: 0,
    },
    matchedRefresh: {
      runs: 0,
      errors: 0,
    },
    output: {
      cycles: 0,
      errors: 0,
    },
    lastErrorAt: null,
    lastError: null,
    lastEvent: null,
  };
}

function incrementDiagnostic(diagnostics, section, field, details = {}) {
  diagnostics[section][field] = Number(diagnostics[section][field] ?? 0) + 1;
  diagnostics.lastEvent = {
    at: Date.now(),
    section,
    field,
    ...details,
  };
}

function recordDiagnosticError(diagnostics, error, details = {}) {
  diagnostics.lastErrorAt = Date.now();
  diagnostics.lastError = String(error?.message ?? error);
  diagnostics.lastEvent = {
    at: diagnostics.lastErrorAt,
    type: "error",
    ...details,
    message: diagnostics.lastError,
  };
}

class CdpClient {
  constructor(webSocketUrl, diagnostics) {
    this.webSocketUrl = webSocketUrl;
    this.diagnostics = diagnostics;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.contexts = new Map();
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          incrementDiagnostic(this.diagnostics, "cdp", "connectTimeouts");
          reject(new Error("Vegas CDP kapcsolódási időtúllépés."));
          this.socket?.close();
        },
        CONFIG.cdpCommandTimeoutMs,
      );
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Nem sikerült kapcsolódni a Vegas CDP targethez."));
        },
        { once: true },
      );
    });
    this.socket.addEventListener("message", event => this.#onMessage(event));
    this.socket.addEventListener("close", () => this.#onClose());
    await this.send("Runtime.enable");
  }

  async send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("A Vegas CDP kapcsolat nem él.");
    }
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        incrementDiagnostic(this.diagnostics, "cdp", "commandTimeouts", { method });
        reject(new Error(`Vegas CDP parancs időtúllépés: ${method}`));
        try {
          this.socket?.close();
        } catch {
          // A socket már bezáródhatott a timeouttal párhuzamosan.
        }
      }, CONFIG.cdpCommandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async waitForMainContext(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const context = [...this.contexts.values()].find(
        item =>
          item.origin === "https://vegas.hu" &&
          item.auxData?.isDefault === true &&
          item.auxData?.type === "default",
      );
      if (context) return context.id;
      await sleep(100);
    }
    incrementDiagnostic(this.diagnostics, "cdp", "contextTimeouts");
    throw new Error("Nem található a vegas.hu fő execution contextje.");
  }

  async evaluate(expression, contextId, awaitPromise = true) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      contextId,
      awaitPromise,
      returnByValue: true,
    });
    if (response.exceptionDetails || response.result?.subtype === "error") {
      const description =
        response.exceptionDetails?.exception?.description ??
        response.result?.description ??
        "Ismeretlen Vegas böngészőoldali hiba.";
      throw new Error(description);
    }
    return response.result?.value;
  }

  close() {
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("A Vegas CDP kapcsolat lezárult."));
    }
    this.pending.clear();
    this.socket?.close();
  }

  #onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        incrementDiagnostic(this.diagnostics, "cdp", "commandErrors", {
          method: pending.method,
        });
        pending.reject(new Error(JSON.stringify(message.error)));
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.executionContextCreated") {
      const context = message.params.context;
      this.contexts.set(context.id, context);
    } else if (message.method === "Runtime.executionContextDestroyed") {
      this.contexts.delete(message.params.executionContextId);
    } else if (message.method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
    }
  }

  #onClose() {
    if (this.closed) return;
    incrementDiagnostic(this.diagnostics, "cdp", "unexpectedDisconnects");
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("A Vegas CDP kapcsolat váratlanul megszakadt."));
    }
    this.pending.clear();
  }
}

async function findVegasTarget() {
  const response = await fetch(`${CONFIG.cdpEndpoint}/json`, {
    signal: AbortSignal.timeout(CONFIG.cdpCommandTimeoutMs),
  });
  if (!response.ok) throw new Error(`A CDP targetlista HTTP ${response.status} hibát adott.`);
  const targets = (await response.json()).filter(
    item =>
      item.type === "page" &&
      typeof item.url === "string" &&
      item.url.startsWith(CONFIG.targetUrlPrefix),
  );
  const target = targets.find(item => item.url.includes("/live")) ?? targets[0];
  if (!target) {
    throw new Error(`Nincs megnyitva Vegas sportoldal: ${CONFIG.targetUrlPrefix}`);
  }
  return target;
}

export function browserCollectorSource() {
  const options = JSON.stringify({
    liveRefreshMs: CONFIG.liveRefreshMs,
    catalogueRefreshMs: CONFIG.catalogueRefreshMs,
    enhancedRefreshMs: CONFIG.matchedRefreshMs,
    requestTimeoutMs: CONFIG.requestTimeoutMs,
    liveRequestTimeoutMs: CONFIG.liveRequestTimeoutMs,
    liveRequestRetries: CONFIG.liveRequestRetries,
    liveRetryDelayMs: CONFIG.liveRetryDelayMs,
    liveRequestBudgetMs: CONFIG.liveRequestBudgetMs,
    liveFailureBackoffMs: CONFIG.liveFailureBackoffMs,
    liveFailureBackoffMaxMs: CONFIG.liveFailureBackoffMaxMs,
    enhancedDetailConcurrency: CONFIG.enhancedDetailConcurrency,
    matchedRequestTimeoutMs: CONFIG.matchedRequestTimeoutMs,
    matchedRequestRetries: CONFIG.matchedRequestRetries,
    matchedRetryDelayMs: CONFIG.matchedRetryDelayMs,
    timezoneOffsetMinutes: CONFIG.timezoneOffsetMinutes,
  });

  return `(() => {
    globalThis.__vegasSoccerCollector?.shutdown?.();
    const options = ${options};
    const BASE = "https://hu-sb2frontend-altenar2.biahosted.com/api/widget/";

    const collector = {
      events: new Map(),
      // IDs confirmed by the latest public prematch catalogue or live overview.
      // Targeted/event-detail endpoints alone must not keep a removed offer alive.
      availableEventIds: new Set(),
      liveEventIds: new Set(),
      enhancedEventIds: new Set(),
      priorityEventIds: new Set(),
      priorityEventIdsConfigured: false,
      lastCatalogueRefreshAt: null,
      lastLiveRefreshAt: null,
      lastEnhancedRefreshAt: null,
      lastError: null,
      catalogueBusy: false,
      liveBusy: false,
      livePriorityPending: false,
      enhancedBusy: false,
      matchedEventsBusy: false,
      stopped: false,
      liveTimer: null,
      liveRefresh: {
        attempts: 0,
        successes: 0,
        failures: 0,
        timeouts: 0,
        retries: 0,
        skippedBusy: 0,
        consecutiveFailures: 0,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDurationMs: null,
        lastError: null,
        backoffMs: 0,
        nextAttemptAt: null,
      },
      enhancedRefresh: {
        runs: 0,
        successes: 0,
        failures: 0,
        detailRequests: 0,
        detailSuccesses: 0,
        detailFailures: 0,
        pausedForLive: 0,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastDurationMs: null,
        lastError: null,
      },
      timers: [],

      query() {
        // getTimezoneOffset follows DST for long-running processes. An explicit
        // override remains available for reproducible tests or provider quirks.
        const timezoneOffset = Number.isInteger(options.timezoneOffsetMinutes)
          ? options.timezoneOffsetMinutes
          : new Date().getTimezoneOffset();
        return (
          "?culture=hu-HU&timezoneOffset=" + timezoneOffset +
          "&integration=vegas.hu&deviceType=1&numFormat=hu-HU&countryCode=LU"
        );
      },

      setPriorityEventIds(eventIds) {
        this.priorityEventIdsConfigured = true;
        this.priorityEventIds = new Set(
          (eventIds ?? []).map(Number).filter(Number.isFinite),
        );
      },

      async request(endpoint, parameters = "", timeoutMs = options.requestTimeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(BASE + endpoint + this.query() + parameters, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(endpoint + " HTTP " + response.status);
          return await response.json();
        } catch (error) {
          if (error?.name === "AbortError") {
            throw new Error(endpoint + " kérés időtúllépés");
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      },

      async requestWithRetry(
        endpoint,
        parameters = "",
        timeoutMs = options.requestTimeoutMs,
        retries = 0,
        retryDelayMs = 0,
        requestOptions = {},
      ) {
        const totalTimeoutMs = Number.isFinite(requestOptions.totalTimeoutMs)
          ? requestOptions.totalTimeoutMs
          : null;
        const deadline = totalTimeoutMs === null ? null : Date.now() + totalTimeoutMs;
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          const remainingMs = deadline === null ? timeoutMs : deadline - Date.now();
          if (remainingMs <= 0) break;
          try {
            return await this.request(
              endpoint,
              parameters,
              Math.max(1, Math.min(timeoutMs, remainingMs)),
            );
          } catch (error) {
            lastError = error;
            if (attempt >= retries) break;
            requestOptions.onRetry?.({ attempt: attempt + 1, error });
            const availableForDelay = deadline === null
              ? retryDelayMs
              : Math.max(0, deadline - Date.now() - 1);
            const delayMs = Math.min(retryDelayMs, availableForDelay);
            if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
        throw lastError ?? new Error(endpoint + " kérés sikertelen");
      },

      isOneXTwoMarket(market, selections, enhanced = false) {
        const name = String(market?.name ?? "")
          .replace(/\\s+/g, " ")
          .trim()
          .toLowerCase();
        const expectedName = enhanced ? "1x2 - odds+" : "1x2";
        if (name !== expectedName) return false;
        const types = new Set(selections.map(item => item?.typeId));
        return types.has(1) && types.has(2) && types.has(3);
      },

      mapPayload(payload, source, destination = this.events) {
        const markets = new Map((payload.markets ?? []).map(item => [item.id, item]));
        const odds = new Map((payload.odds ?? []).map(item => [item.id, item]));
        const competitors = new Map(
          (payload.competitors ?? []).map(item => [item.id, item]),
        );
        const champs = new Map((payload.champs ?? []).map(item => [item.id, item]));
        const mappedIds = [];

        for (const event of payload.events ?? []) {
          if (event.sportId !== 66) continue;
          const market = (event.marketIds ?? [])
            .map(id => markets.get(id))
            .find(item => {
              const selections = (item?.oddIds ?? [])
                .map(id => odds.get(id))
                .filter(Boolean);
              return this.isOneXTwoMarket(item, selections);
            });
          if (!market) continue;
          const selections = (market.oddIds ?? []).map(id => odds.get(id)).filter(Boolean);
          const byType = new Map(selections.map(item => [item.typeId, item]));
          const homeCompetitor = competitors.get(event.competitorIds?.[0]);
          const awayCompetitor = competitors.get(event.competitorIds?.[1]);
          const previous = destination.get(event.id) ?? this.events.get(event.id);
          const mapped = {
            id: event.id,
            startTime: Date.parse(event.startDate),
            homeName: homeCompetitor?.name ?? byType.get(1)?.name ?? "",
            awayName: awayCompetitor?.name ?? byType.get(3)?.name ?? "",
            competitionName: champs.get(event.champId)?.name ?? previous?.competitionName ?? "",
            odds: [1, 2, 3].map(typeId => {
              const selection = byType.get(typeId);
              return selection && selection.oddStatus === 0
                ? Number(selection.price)
                : null;
            }),
            enhancedOdds: previous?.enhancedOdds ?? null,
            enhancedUpdatedAt: previous?.enhancedUpdatedAt ?? null,
            live: source === "live",
            status: event.status,
            statusName: event.statusName ?? event.statusText ?? null,
            score: event.score ?? event.scoreString ?? event.currentScore ?? null,
            homeScore: event.homeScore ?? null,
            awayScore: event.awayScore ?? null,
            period: event.period ?? event.periodName ?? null,
            minute: event.minute ?? event.elapsed ?? null,
            redCards: event.redCards ?? null,
            updatedAt: Date.now(),
          };
          destination.set(event.id, mapped);
          mappedIds.push(event.id);
        }
        return mappedIds;
      },

      async refreshCatalogue() {
        if (this.catalogueBusy) return { busy: true };
        this.catalogueBusy = true;
        try {
          const menu = await this.request("GetSportMenu", "&sportId=66");
          const champIds = (menu.champs ?? []).map(item => item.id);
          const nextEvents = new Map();
          let failedChamps = 0;
          for (let start = 0; start < champIds.length; start += 8) {
            const batch = champIds.slice(start, start + 8);
            const results = await Promise.allSettled(
              batch.map(id => this.request("GetEventsByChamp", "&champIds=" + id)),
            );
            for (const result of results) {
              if (result.status === "fulfilled") {
                this.mapPayload(result.value, "prematch", nextEvents);
              } else {
                failedChamps += 1;
              }
            }
          }
          for (const id of this.liveEventIds) {
            const liveEvent = this.events.get(id);
            if (liveEvent) nextEvents.set(id, liveEvent);
          }
          for (const [id, event] of nextEvents) {
            const previous = this.events.get(id);
            if (previous?.enhancedOdds) {
              nextEvents.set(id, {
                ...event,
                enhancedOdds: previous.enhancedOdds,
                enhancedUpdatedAt: previous.enhancedUpdatedAt,
              });
            }
          }
          if (failedChamps > 0) {
            this.lastError = failedChamps + " bajnokság lekérése sikertelen";
            throw new Error(this.lastError);
          }
          if (nextEvents.size > 0) {
            this.events = nextEvents;
            this.availableEventIds = new Set(nextEvents.keys());
          }
          this.lastCatalogueRefreshAt = Date.now();
          this.lastError = null;
          return {
            events: this.events.size,
            championships: champIds.length,
            failedChamps,
            committed: true,
          };
        } finally {
          this.catalogueBusy = false;
        }
      },

      async refreshEvents(eventIds) {
        if (this.matchedEventsBusy) return { busy: true };
        this.matchedEventsBusy = true;
        const requestedIds = [...new Set(eventIds.map(Number).filter(Number.isFinite))];
        const uniqueIds = requestedIds.filter(id => this.availableEventIds.has(id));
        try {
          const batches = [];
          for (let start = 0; start < uniqueIds.length; start += 50) {
            batches.push(uniqueIds.slice(start, start + 50));
          }
          const payloads = await Promise.allSettled(
            batches.map(batch =>
              this.requestWithRetry(
                "GetEventsById",
                "&eventIds=" + batch.join(","),
                options.matchedRequestTimeoutMs,
                options.matchedRequestRetries,
                options.matchedRetryDelayMs,
              ),
            ),
          );
          const refreshedEvents = new Map();
          let failedBatches = 0;
          for (const payload of payloads) {
            if (payload.status === "fulfilled") {
              this.mapPayload(payload.value, "prematch", refreshedEvents);
            } else {
              failedBatches += 1;
            }
          }
          for (const [id, event] of refreshedEvents) {
            // A catalogue refresh may have completed while the targeted request
            // was in flight. Recheck before merging its response.
            if (this.availableEventIds.has(id)) this.events.set(id, event);
          }
          if (failedBatches > 0) {
            this.lastError =
              "GetEventsById: " + failedBatches + " batch lekérése sikertelen";
          }
          return {
            refreshedEvents: [...refreshedEvents.keys()]
              .filter(id => this.availableEventIds.has(id)).length,
            skippedUnavailableEvents: requestedIds.length - uniqueIds.length,
            failedBatches,
          };
        } finally {
          this.matchedEventsBusy = false;
        }
      },

      async refreshLive() {
        if (this.liveBusy) {
          this.liveRefresh.skippedBusy += 1;
          return { ok: false, busy: true, backoffMs: options.liveRefreshMs };
        }
        const startedAt = Date.now();
        this.liveRefresh.attempts += 1;
        this.liveRefresh.lastStartedAt = startedAt;
        this.liveRefresh.nextAttemptAt = null;
        this.liveBusy = true;
        try {
          const payload = await this.requestWithRetry(
            "GetLiveOverview",
            "&sportId=66",
            options.liveRequestTimeoutMs,
            options.liveRequestRetries,
            options.liveRetryDelayMs,
            {
              totalTimeoutMs: options.liveRequestBudgetMs,
              onRetry: () => { this.liveRefresh.retries += 1; },
            },
          );
          const currentIds = new Set(this.mapPayload(payload, "live"));
          for (const id of this.liveEventIds) {
            if (!currentIds.has(id)) this.events.delete(id);
          }
          this.liveEventIds = currentIds;
          for (const id of currentIds) this.availableEventIds.add(id);
          const completedAt = Date.now();
          this.lastLiveRefreshAt = completedAt;
          this.liveRefresh.successes += 1;
          this.liveRefresh.consecutiveFailures = 0;
          this.liveRefresh.lastCompletedAt = completedAt;
          this.liveRefresh.lastSuccessAt = completedAt;
          this.liveRefresh.lastDurationMs = completedAt - startedAt;
          this.liveRefresh.lastError = null;
          this.liveRefresh.backoffMs = 0;
          this.liveRefresh.nextAttemptAt = completedAt + options.liveRefreshMs;
          return {
            ok: true,
            events: currentIds.size,
            durationMs: completedAt - startedAt,
            backoffMs: options.liveRefreshMs,
          };
        } catch (error) {
          const completedAt = Date.now();
          const message = String(error?.message ?? error);
          this.liveRefresh.failures += 1;
          if (/idő?túllépés|timeout|abort/i.test(message)) this.liveRefresh.timeouts += 1;
          this.liveRefresh.consecutiveFailures += 1;
          this.liveRefresh.lastCompletedAt = completedAt;
          this.liveRefresh.lastFailureAt = completedAt;
          this.liveRefresh.lastDurationMs = completedAt - startedAt;
          this.liveRefresh.lastError = message;
          this.liveRefresh.backoffMs = Math.min(
            options.liveFailureBackoffMaxMs,
            options.liveFailureBackoffMs * 2 ** Math.min(this.liveRefresh.consecutiveFailures - 1, 8),
          );
          this.liveRefresh.nextAttemptAt = completedAt + this.liveRefresh.backoffMs;
          this.lastError = error.message;
          return {
            ok: false,
            error: message,
            durationMs: completedAt - startedAt,
            backoffMs: this.liveRefresh.backoffMs,
          };
        } finally {
          this.liveBusy = false;
        }
      },

      async runWithConcurrency(items, concurrency, operation, shouldPause = () => false) {
        const results = [];
        let nextIndex = 0;
        let paused = false;
        const worker = async () => {
          while (nextIndex < items.length) {
            if (shouldPause()) {
              paused = true;
              return;
            }
            const index = nextIndex++;
            try {
              results[index] = {
                status: "fulfilled",
                value: await operation(items[index], index),
              };
            } catch (error) {
              results[index] = { status: "rejected", reason: error };
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(Math.max(1, concurrency), items.length) },
            () => worker(),
          ),
        );
        return { results: results.filter(Boolean), paused };
      },

      async refreshEnhancedOdds() {
        if (this.enhancedBusy) return { busy: true, reason: "enhanced-busy" };
        if (this.liveBusy || this.livePriorityPending) {
          this.enhancedRefresh.pausedForLive += 1;
          return { busy: true, reason: "live-priority" };
        }
        const startedAt = Date.now();
        this.enhancedRefresh.runs += 1;
        this.enhancedRefresh.lastStartedAt = startedAt;
        this.enhancedBusy = true;
        try {
        const payload = await this.request("GetEnhancedOdds");
        const markets = new Map((payload.markets ?? []).map(item => [item.id, item]));
        const odds = new Map((payload.odds ?? []).map(item => [item.id, item]));
        const competitors = new Map(
          (payload.competitors ?? []).map(item => [item.id, item]),
        );
        const champs = new Map((payload.champs ?? []).map(item => [item.id, item]));
        const currentIds = new Set();

        for (const id of this.enhancedEventIds) {
          const previous = this.events.get(id);
          if (previous) {
            this.events.set(id, {
              ...previous,
              enhancedOdds: null,
              enhancedUpdatedAt: Date.now(),
            });
          }
        }

        for (const event of payload.events ?? []) {
          if (event.sportId !== 66) continue;
          if (!this.availableEventIds.has(event.id)) continue;
          const market = (event.marketIds ?? [])
            .map(id => markets.get(id))
            .find(item => {
              const selections = (item?.oddIds ?? [])
                .map(id => odds.get(id))
                .filter(Boolean);
              return this.isOneXTwoMarket(item, selections, true);
            });
          if (!market) continue;
          const selections = (market.oddIds ?? []).map(id => odds.get(id)).filter(Boolean);
          const byType = new Map(selections.map(item => [item.typeId, item]));
          const enhancedOdds = [1, 2, 3].map(typeId => {
            const selection = byType.get(typeId);
            return selection && selection.oddStatus === 0
              ? Number(selection.price)
              : null;
          });
          const previous = this.events.get(event.id);
          const homeCompetitor = competitors.get(event.competitorIds?.[0]);
          const awayCompetitor = competitors.get(event.competitorIds?.[1]);
          this.events.set(event.id, {
            id: event.id,
            startTime: Date.parse(event.startDate),
            homeName: previous?.homeName ?? homeCompetitor?.name ?? byType.get(1)?.name ?? "",
            awayName: previous?.awayName ?? awayCompetitor?.name ?? byType.get(3)?.name ?? "",
            competitionName:
              previous?.competitionName ?? champs.get(event.champId)?.name ?? "",
            odds: previous?.odds ?? [null, null, null],
            enhancedOdds,
            enhancedUpdatedAt: Date.now(),
            live: previous?.live ?? false,
            status: event.status,
            statusName: event.statusName ?? event.statusText ?? previous?.statusName ?? null,
            score: event.score ?? event.scoreString ?? event.currentScore ?? previous?.score ?? null,
            homeScore: event.homeScore ?? previous?.homeScore ?? null,
            awayScore: event.awayScore ?? previous?.awayScore ?? null,
            period: event.period ?? event.periodName ?? previous?.period ?? null,
            minute: event.minute ?? event.elapsed ?? previous?.minute ?? null,
            redCards: event.redCards ?? previous?.redCards ?? null,
            updatedAt: previous?.updatedAt ?? Date.now(),
          });
          currentIds.add(event.id);
        }

        const detailIds = this.priorityEventIdsConfigured
          ? [...currentIds].filter(id => this.priorityEventIds.has(id))
          : [...currentIds];
        const detailRun = await this.runWithConcurrency(
          detailIds,
          options.enhancedDetailConcurrency,
          id => this.request("GetEventDetails", "&eventId=" + id),
          () => this.liveBusy || this.livePriorityPending,
        );
        const detailResults = detailRun.results;
        this.enhancedRefresh.detailRequests += detailResults.length;
        this.enhancedRefresh.detailSuccesses += detailResults.filter(
          result => result.status === "fulfilled",
        ).length;
        this.enhancedRefresh.detailFailures += detailResults.filter(
          result => result.status === "rejected",
        ).length;
        for (const result of detailResults) {
          if (result.status !== "fulfilled") continue;
          const details = result.value;
          const oddsById = new Map(
            (details.odds ?? []).map(item => [item.id, item]),
          );
          const market = (details.markets ?? []).find(item => {
            if (item?.isBB === true) return false;
            const oddIds = (item.desktopOddIds ?? item.mobileOddIds ?? []).flat(3);
            const selections = oddIds.map(id => oddsById.get(id)).filter(Boolean);
            return this.isOneXTwoMarket(item, selections);
          });
          if (!market) continue;
          const oddIds = (market.desktopOddIds ?? market.mobileOddIds ?? []).flat(3);
          const selections = oddIds.map(id => oddsById.get(id)).filter(Boolean);
          const byType = new Map(selections.map(item => [item.typeId, item]));
          const previous = this.events.get(details.id);
          if (!previous || !this.availableEventIds.has(details.id)) continue;
          this.events.set(details.id, {
            ...previous,
            odds: [1, 2, 3].map(typeId => {
              const selection = byType.get(typeId);
              return selection && selection.oddStatus === 0
                ? Number(selection.price)
                : null;
            }),
            updatedAt: Date.now(),
          });
        }
        this.enhancedEventIds = currentIds;
        const completedAt = Date.now();
        // The enhanced source payload is fresh even when detail fan-out pauses
        // for a due live refresh. Event-level timestamps still fail closed
        // independently if their detail odds were not refreshed.
        this.lastEnhancedRefreshAt = completedAt;
        this.enhancedRefresh.successes += 1;
        this.enhancedRefresh.lastCompletedAt = completedAt;
        this.enhancedRefresh.lastDurationMs = completedAt - startedAt;
        this.enhancedRefresh.lastError = null;
        return {
          enhancedEvents: currentIds.size,
          detailRequests: detailResults.length,
          detailPausedForLive: detailRun.paused,
        };
        } catch (error) {
          this.enhancedRefresh.failures += 1;
          this.enhancedRefresh.lastCompletedAt = Date.now();
          this.enhancedRefresh.lastDurationMs = Date.now() - startedAt;
          this.enhancedRefresh.lastError = String(error?.message ?? error);
          throw error;
        } finally {
          this.enhancedBusy = false;
        }
      },

      snapshot(eventIds) {
        const selected = eventIds ? new Set(eventIds.map(Number)) : null;
        return {
          generatedAt: Date.now(),
          lastCatalogueRefreshAt: this.lastCatalogueRefreshAt,
          lastLiveRefreshAt: this.lastLiveRefreshAt,
          liveRefresh: { ...this.liveRefresh },
          lastEnhancedRefreshAt: this.lastEnhancedRefreshAt,
          enhancedRefresh: { ...this.enhancedRefresh },
          lastError: this.lastError,
          catalogueEvents: this.events.size,
          liveEvents: this.liveEventIds.size,
          enhancedEvents: this.enhancedEventIds.size,
          events: [...this.events.values()]
            .filter(event => !selected || selected.has(event.id) || event.live)
            .sort((left, right) => left.startTime - right.startTime),
        };
      },

      shutdown() {
        this.stopped = true;
        if (this.liveTimer) clearTimeout(this.liveTimer);
        this.liveTimer = null;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
      },

      scheduleLiveRefresh(delayMs = options.liveRefreshMs) {
        if (this.stopped || this.liveTimer) return;
        const delay = Math.max(0, Number(delayMs) || 0);
        this.liveRefresh.nextAttemptAt = Date.now() + delay;
        this.liveTimer = setTimeout(async () => {
          this.liveTimer = null;
          if (this.stopped) return;
          this.livePriorityPending = true;
          let result;
          try {
            result = await this.refreshLive();
          } finally {
            this.livePriorityPending = false;
          }
          this.scheduleLiveRefresh(result.backoffMs ?? options.liveRefreshMs);
        }, delay);
      },
    };

    globalThis.__vegasSoccerCollector = collector;
    const runSafely = (label, operation) => {
      void operation().catch(error => {
        collector.lastError = label + ": " + String(error?.message ?? error);
      });
    };
    collector.timers.push(
      setInterval(
        () => runSafely("enhanced", () => collector.refreshEnhancedOdds()),
        options.enhancedRefreshMs,
      ),
      setInterval(
        () => runSafely("catalogue", () => collector.refreshCatalogue()),
        options.catalogueRefreshMs,
      ),
    );
    collector.scheduleLiveRefresh(options.liveRefreshMs);
    return true;
  })()`;
}

const browserRefreshCatalogueSource =
  "globalThis.__vegasSoccerCollector.refreshCatalogue()";
const browserRefreshLiveSource =
  "globalThis.__vegasSoccerCollector.refreshLive()";
const browserRefreshEnhancedSource =
  "globalThis.__vegasSoccerCollector.refreshEnhancedOdds()";
const browserShutdownSource =
  "globalThis.__vegasSoccerCollector?.shutdown()";

let teamAliasLookup = new Map();
let teamAliasesModifiedAt = -1;

function teamAliasKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function refreshTeamAliases() {
  const stats = await fs.stat(CONFIG.teamAliasesFile);
  if (stats.mtimeMs === teamAliasesModifiedAt) return;
  const document = JSON.parse(await fs.readFile(CONFIG.teamAliasesFile, "utf8"));
  const nextLookup = new Map();
  for (const [canonicalName, aliases] of Object.entries(document.teams ?? {})) {
    const canonicalValue = canonicalName.replaceAll("_", " ");
    for (const alias of [canonicalValue, ...(Array.isArray(aliases) ? aliases : [])]) {
      const key = teamAliasKey(alias);
      if (key) nextLookup.set(key, canonicalValue);
    }
  }
  teamAliasLookup = nextLookup;
  teamAliasesModifiedAt = stats.mtimeMs;
}

function normalizeTeamName(value) {
  const aliasedValue = teamAliasLookup.get(teamAliasKey(value)) ?? value;
  return String(aliasedValue ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bii\b/g, "2")
    .replace(/nottingham/g, "nottm")
    .replace(/universitatea|university|universitario/g, "univ")
    .replace(/sz/g, "s")
    .replace(/cs/g, "c")
    .replace(/zs/g, "z")
    .replace(/gy/g, "g")
    .replace(/ny/g, "n")
    .replace(/ty/g, "t")
    .replace(/ly/g, "l")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(token => token && !["fc", "fk", "afc", "cf", "sc", "pfc"].includes(token))
    .join(" ")
    .trim();
}

function diceCoefficient(leftValue, rightValue) {
  const left = normalizeTeamName(leftValue);
  const right = normalizeTeamName(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (
    (left.includes(right) && right.length >= 5) ||
    (right.includes(left) && left.length >= 5)
  ) return 0.94;
  if (left.length < 2 || right.length < 2) return 0;
  const pairs = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let matches = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = pairs.get(pair) ?? 0;
    if (count > 0) {
      matches += 1;
      pairs.set(pair, count - 1);
    }
  }
  return (2 * matches) / (left.length + right.length - 2);
}

export function createEventTimeIndex(events) {
  const index = new Map();
  for (const event of events) {
    const startTime = Number(event.startTime);
    if (!Number.isFinite(startTime)) continue;
    const bucket = Math.floor(startTime / EVENT_TIME_BUCKET_MS);
    const bucketEvents = index.get(bucket) ?? [];
    bucketEvents.push(event);
    index.set(bucket, bucketEvents);
  }
  return index;
}

export function timeCandidates(index, startTime) {
  const timestamp = Number(startTime);
  if (!Number.isFinite(timestamp)) return [];
  const bucket = Math.floor(timestamp / EVENT_TIME_BUCKET_MS);
  const candidates = [];
  for (let offset = -3; offset <= 3; offset += 1) {
    candidates.push(...(index.get(bucket + offset) ?? []));
  }
  return candidates;
}

function competitionFamily(value) {
  const name = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const families = [
    ["champions_q", ["uefa champions league qualifiers", "bl-selejtezo"]],
    ["europa_q", ["uefa europa league qualifiers", "el-selejtezo"]],
    ["conference_q", ["uefa europa conference qualifiers", "kl-selejtezo"]],
    ["danish_superliga", ["danish superliga", "dan bajnoksag"]],
    ["english_premier", ["english premier league", "premier liga"]],
    ["finnish_kakkonen", ["finnish kakkonen", "finn 4"]],
    ["sudamericana", ["conmebol copa sudamericana", "copa sudamericana"]],
    [
      "friendly",
      ["friendly matches", "felkeszulesi merkozes", "baratsagos merkozes"],
    ],
  ];
  return families.find(([, aliases]) =>
    aliases.some(alias => name.includes(alias)),
  )?.[0];
}

function competitionsCompatible(left, right) {
  const leftFamily = competitionFamily(left);
  const rightFamily = competitionFamily(right);
  if (leftFamily || rightFamily) return leftFamily === rightFamily;
  return diceCoefficient(left, right) >= 0.55;
}

export function findVegasEvent(watchEvent, vegasEvents) {
  let best = null;
  for (const event of vegasEvents) {
    const timeDifference = Math.abs(Number(event.startTime) - Number(watchEvent.startTime));
    if (!Number.isFinite(timeDifference)) continue;
    const homeScore = diceCoefficient(watchEvent.homeName, event.homeName);
    const awayScore = diceCoefficient(watchEvent.awayName, event.awayName);
    const score = (homeScore + awayScore) / 2;
    const withinNormalWindow = timeDifference <= 30 * 60_000;
    const probableOneHourSourceOffset =
      Math.abs(timeDifference - 60 * 60_000) <= 2 * 60_000 &&
      homeScore >= 0.84 &&
      awayScore >= 0.84 &&
      competitionsCompatible(watchEvent.competitionName, event.competitionName);
    if (!withinNormalWindow && !probableOneHourSourceOffset) continue;
    if (homeScore >= 0.45 && awayScore >= 0.45 && score >= 0.6) {
      const adjustedScore = score - timeDifference / (30 * 60_000) / 100;
      if (!best || adjustedScore > best.score) best = { event, score: adjustedScore };
    }
  }
  return best?.event ?? null;
}

export async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomically(filename, content) {
  await writeTextAtomically(filename, content);
}

async function main() {
  const writerLock = await acquireWriterLock(
    CONFIG.outputFile,
    "Vegas production monitor",
  );
  let cdp = null;
  let contextId;
  let outputTimer;
  let matchedRefreshTimer;
  let stopping = false;
  let writing = false;
  let refreshingMatchedEvents = false;
  let selectedIds = [];
  let lastStatus = "";
  let initializationPromise = null;
  const diagnostics = createMonitorDiagnostics();

  const connectCdp = async (force = false) => {
    if (!force && cdp?.socket?.readyState === WebSocket.OPEN) return;
    incrementDiagnostic(diagnostics, "cdp", "connectAttempts");
    cdp?.close();
    try {
      const target = await findVegasTarget();
      const nextClient = new CdpClient(target.webSocketDebuggerUrl, diagnostics);
      await nextClient.connect();
      cdp = nextClient;
      contextId = undefined;
      incrementDiagnostic(diagnostics, "cdp", "connectSuccesses");
    } catch (error) {
      incrementDiagnostic(diagnostics, "cdp", "connectFailures");
      recordDiagnosticError(diagnostics, error, { section: "cdp", field: "connectFailures" });
      throw error;
    }
  };

  const stop = async exitCode => {
    if (stopping) return;
    stopping = true;
    clearInterval(outputTimer);
    clearInterval(matchedRefreshTimer);
    // Release the bind-mounted lock before the CDP cleanup can hit its
    // timeout. Docker may otherwise SIGKILL the process with the lock held.
    await writerLock.release();
    try {
      if (contextId && cdp) await cdp.evaluate(browserShutdownSource, contextId, false);
    } catch {
      // A böngésző ekkor már bezáródhatott.
    }
    cdp?.close();
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  await connectCdp();

  const initialize = async () => {
    contextId = await cdp.waitForMainContext();
    await cdp.evaluate(browserCollectorSource(), contextId);
    // The first enhanced refresh must not fan out to the entire catalogue.
    // refreshMatchedEvents() installs the current watchlist IDs afterwards.
    await cdp.evaluate(
      "globalThis.__vegasSoccerCollector.setPriorityEventIds([])",
      contextId,
      false,
    );
    const catalogue = await cdp.evaluate(browserRefreshCatalogueSource, contextId);
    await cdp.evaluate(browserRefreshLiveSource, contextId);
    await cdp.evaluate(browserRefreshEnhancedSource, contextId);
    console.log(
      `[catalogue] ${catalogue.events} soccer events, ` +
      `${catalogue.championships} championships, ${catalogue.failedChamps} failed`,
    );
  };

  const initializeWithRetry = () => {
    if (initializationPromise) return initializationPromise;
    initializationPromise = (async () => {
      let attempt = 0;
      while (!stopping) {
        incrementDiagnostic(diagnostics, "initialization", "attempts");
        try {
          if (cdp?.socket?.readyState !== WebSocket.OPEN || attempt > 0) {
            await connectCdp(attempt > 0);
          }
          await initialize();
          incrementDiagnostic(diagnostics, "initialization", "successes");
          return true;
        } catch (error) {
          attempt += 1;
          recordDiagnosticError(diagnostics, error, { section: "initialization", field: "attempts" });
          // A Vegas oldal első betöltésekor a CDP execution context navigáció
          // közben megszűnhet. Új target-kapcsolattal próbálkozunk tovább.
          console.error(`[initialize] ${error.message}; újrapróbálás 1 mp múlva.`);
          await sleep(1_000);
        }
      }
      incrementDiagnostic(diagnostics, "initialization", "failures");
      return false;
    })().finally(() => {
      initializationPromise = null;
    });
    return initializationPromise;
  };

  const refreshMatchedEvents = async () => {
    if (refreshingMatchedEvents || stopping || writing || initializationPromise) return;
    refreshingMatchedEvents = true;
    incrementDiagnostic(diagnostics, "matchedRefresh", "runs");
    try {
      await refreshTeamAliases();
      const watchlist = await readJson(CONFIG.watchlistFile);
      const fullSnapshot = await cdp.evaluate(
        "globalThis.__vegasSoccerCollector.snapshot()",
        contextId,
      );
      const eventTimeIndex = createEventTimeIndex(fullSnapshot.events);
      const nextSelectedIds = [];
      for (const watchEvent of watchlist?.events ?? []) {
        const match = findVegasEvent(
          watchEvent,
          timeCandidates(eventTimeIndex, watchEvent.startTime),
        );
        if (match) nextSelectedIds.push(match.id);
      }
      const uniqueIds = [...new Set(nextSelectedIds)];
      selectedIds = uniqueIds;
      await cdp.evaluate(
        "globalThis.__vegasSoccerCollector.setPriorityEventIds(" +
          `${JSON.stringify(uniqueIds)}` +
          ")",
        contextId,
        false,
      );
      if (uniqueIds.length > 0) {
        await cdp.evaluate(
          "void globalThis.__vegasSoccerCollector.refreshEvents(" +
            `${JSON.stringify(uniqueIds)}` +
            ").catch(error => { globalThis.__vegasSoccerCollector.lastError = error.message; })",
          contextId,
          false,
        );
      }
    } catch (error) {
      incrementDiagnostic(diagnostics, "matchedRefresh", "errors");
      recordDiagnosticError(diagnostics, error, { section: "matchedRefresh", field: "errors" });
      console.error(`[matched-refresh] ${error.message}`);
      await initializeWithRetry();
    } finally {
      refreshingMatchedEvents = false;
    }
  };

  const writeOutput = async () => {
    if (writing || stopping || refreshingMatchedEvents || initializationPromise) return;
    writing = true;
    incrementDiagnostic(diagnostics, "output", "cycles");
    try {
      const snapshot = await cdp.evaluate(
        `globalThis.__vegasSoccerCollector.snapshot(${JSON.stringify(selectedIds)})`,
        contextId,
      );
      const output = {
        ...snapshot,
        monitorHealth: {
          ...diagnostics,
          updatedAt: Date.now(),
        },
      };
      await writeAtomically(CONFIG.outputFile, `${JSON.stringify(output, null, 2)}\n`);
      const status =
        `${snapshot.events.length} selected/live, ` +
        `${snapshot.catalogueEvents} catalogue, ${snapshot.liveEvents} live`;
      if (status !== lastStatus) {
        lastStatus = status;
        console.log(`[output] ${status} -> ${CONFIG.outputFile}`);
      }
    } catch (error) {
      incrementDiagnostic(diagnostics, "output", "errors");
      recordDiagnosticError(diagnostics, error, { section: "output", field: "errors" });
      console.error(`[output] ${error.message}`);
      if (!error?.isOutputError) await initializeWithRetry();
    } finally {
      writing = false;
    }
  };

  if (!await initializeWithRetry()) {
    await stop(0);
    return;
  }
  await refreshMatchedEvents();
  await writeOutput();
  if (CONFIG.once) {
    await stop(0);
    return;
  }
  matchedRefreshTimer = setInterval(
    () => void refreshMatchedEvents(),
    CONFIG.matchedRefreshMs,
  );
  outputTimer = setInterval(() => void writeOutput(), CONFIG.outputIntervalMs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
