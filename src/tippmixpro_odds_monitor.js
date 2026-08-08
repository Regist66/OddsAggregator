import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireWriterLock, writeTextAtomically } from "./atomic_file.js";
import { envNumber } from "./numeric_config.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");

const CONFIG = {
  cdpEndpoint: process.env.TIPPMIXPRO_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
  targetUrlFragment: process.env.TIPPMIXPRO_TARGET_URL_FRAGMENT ?? "tippmixpro.hu",
  outputFile:
    process.env.TIPPMIXPRO_OUTPUT_FILE ??
    path.join(DATA_DIR, "tippmixpro_odds_snapshot.json"),
  catalogueRefreshMs: envNumber("TIPPMIXPRO_CATALOGUE_REFRESH_MS", 300_000, {
    integer: true,
    min: 1_000,
  }),
  outputIntervalMs: envNumber("TIPPMIXPRO_OUTPUT_INTERVAL_MS", 1_000, {
    integer: true,
    min: 100,
  }),
  cdpCommandTimeoutMs: envNumber("CDP_COMMAND_TIMEOUT_MS", 15_000, {
    integer: true,
    min: 1_000,
    max: 120_000,
  }),
  once: process.env.TIPPMIXPRO_ONCE === "1",
};

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
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
          reject(new Error("TippmixPro CDP kapcsolódási időtúllépés."));
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
          reject(new Error("Nem sikerült kapcsolódni a CDP WebSockethez."));
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
      throw new Error("A CDP kapcsolat nem él.");
    }
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`TippmixPro CDP parancs időtúllépés: ${method}`));
      }, CONFIG.cdpCommandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async waitForSportsContext(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const context = [...this.contexts.values()].find(
        item =>
          item.origin === "https://sports2.tippmixpro.hu" &&
          item.auxData?.isDefault === true,
      );
      if (context) return context.id;
      await sleep(100);
    }
    throw new Error("Nem található a sports2.tippmixpro.hu iframe kontextusa.");
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
        "Ismeretlen böngészőoldali hiba.";
      throw new Error(description);
    }
    return response.result?.value;
  }

  close() {
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("A CDP kapcsolat lezárult."));
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
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
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
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("A CDP kapcsolat váratlanul megszakadt."));
    }
    this.pending.clear();
  }
}

async function findTarget() {
  const response = await fetch(`${CONFIG.cdpEndpoint}/json`, {
    signal: AbortSignal.timeout(CONFIG.cdpCommandTimeoutMs),
  });
  if (!response.ok) throw new Error(`A CDP targetlista HTTP ${response.status} hibát adott.`);
  const targets = await response.json();
  const target = targets.find(
    item =>
      item.type === "page" &&
      typeof item.url === "string" &&
      item.url.includes(CONFIG.targetUrlFragment),
  );
  if (!target) throw new Error("Nincs megnyitva TippmixPro oldal a Chrome-ban.");
  return target;
}

export function browserCollectorSource() {
  return `(() => {
    const VERSION = 1;
    const BASE = "/sports/2901/hu/";
    const AGGREGATOR_SUFFIX = "/default-event-info/BOTH/1380,1381,1382";
    const TARGET_DISPLAY_KEY = "b69_ep3";

    globalThis.__tippmixProMatchOddsCollector?.shutdown?.();

    const collector = {
      version: VERSION,
      socket: null,
      requestId: 100,
      generation: 0,
      connected: false,
      connectPromise: null,
      cancelConnect: null,
      reconnectTimer: null,
      closing: false,
      pendingRegistrations: new Map(),
      pendingCalls: new Map(),
      pendingRpcs: new Map(),
      pendingRequestTimers: new Map(),
      registrationTopics: new Map(),
      subscribedTopics: new Set(),
      queuedOfferIds: new Set(),
      subscribedOfferIds: new Set(),
      offerFlushTimer: null,
      matches: new Map(),
      markets: new Map(),
      outcomes: new Map(),
      relations: new Map(),
      offers: new Map(),
      tournaments: new Map(),
      lastCatalogueRefreshAt: null,
      lastFrameAt: null,
      lastError: null,

      nextRequestId() {
        this.requestId += 1;
        return this.requestId;
      },

      startRequestTimeout(requestId, label, onTimeout) {
        this.clearRequestTimeout(requestId);
        const timer = setTimeout(() => {
          this.pendingRequestTimers.delete(requestId);
          onTimeout();
          this.lastError = "TippmixPro WAMP időtúllépés: " + label;
        }, 15_000);
        this.pendingRequestTimers.set(requestId, timer);
      },

      clearRequestTimeout(requestId) {
        clearTimeout(this.pendingRequestTimers.get(requestId));
        this.pendingRequestTimers.delete(requestId);
      },

      async connect() {
        if (this.closing) throw new Error("A TippmixPro collector leáll.");
        if (this.socket?.readyState === WebSocket.OPEN && this.connected) return;
        if (this.connectPromise) return this.connectPromise;
        const generation = ++this.generation;
        const pendingConnection = new Promise((resolve, reject) => {
          const socket = new WebSocket(
            "wss://sportsapi.tippmixpro.hu/v2",
            ["wamp.2.json"],
          );
          this.socket = socket;
          let settled = false;
          const settle = (handler, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (this.cancelConnect === cancel) this.cancelConnect = null;
            handler(value);
          };
          const cancel = error => settle(reject, error);
          this.cancelConnect = cancel;
          const timeout = setTimeout(() => {
            const error = new Error("TippmixPro WAMP kapcsolódási időtúllépés.");
            this.lastError = error.message;
            cancel(error);
            try { socket.close(); } catch { /* A socket már lezáródhatott. */ }
          }, 10_000);

          socket.onopen = () => {
            try {
              socket.send(JSON.stringify([
                1,
                "www.tippmixpro.hu",
                { roles: { caller: {}, callee: {} }, agent: "SharpX monitor" },
              ]));
            } catch (error) {
              this.lastError = String(error?.stack ?? error);
              cancel(error);
              try { socket.close(); } catch { /* A socket már lezáródhatott. */ }
            }
          };
          socket.onmessage = event => {
            if (generation !== this.generation) return;
            this.lastFrameAt = Date.now();
            try {
              const message = JSON.parse(String(event.data));
              if (message[0] === 2) {
                this.connected = true;
                this.lastError = null;
                settle(resolve);
              } else {
                this.handleWampMessage(message);
              }
            } catch (error) {
              this.lastError = String(error?.stack ?? error);
            }
          };
          socket.onerror = () => {
            this.lastError = "TippmixPro WAMP WebSocket hiba";
          };
          socket.onclose = () => {
            const currentGeneration = generation === this.generation;
            cancel(new Error("A TippmixPro WAMP kapcsolat a WELCOME előtt megszakadt."));
            if (!currentGeneration) return;
            this.connected = false;
            this.subscribedTopics.clear();
            this.registrationTopics.clear();
            this.pendingRegistrations.clear();
            this.pendingCalls.clear();
            for (const timer of this.pendingRequestTimers.values()) clearTimeout(timer);
            this.pendingRequestTimers.clear();
            for (const pending of this.pendingRpcs.values()) {
              clearTimeout(pending.timer);
              pending.reject(new Error("A TippmixPro WAMP kapcsolat megszakadt."));
            }
            this.pendingRpcs.clear();
            this.scheduleReconnect(1000);
          };
        });
        const trackedConnection = pendingConnection.finally(() => {
          if (this.connectPromise === trackedConnection) this.connectPromise = null;
        });
        this.connectPromise = trackedConnection;
        return trackedConnection;
      },

      scheduleReconnect(delayMs) {
        if (this.closing || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.reconnect();
        }, delayMs);
      },

      async reconnect() {
        if (this.closing) return;
        try {
          await this.connect();
          const tournamentIds = [...this.tournaments.keys()];
          this.subscribedOfferIds.clear();
          this.queuedOfferIds.clear();
          await this.subscribeTournaments(tournamentIds);
        } catch (error) {
          this.lastError = String(error?.stack ?? error);
          this.scheduleReconnect(5000);
        }
      },

      send(message) {
        if (this.socket?.readyState !== WebSocket.OPEN) {
          throw new Error("A TippmixPro WAMP kapcsolat nem él.");
        }
        this.socket.send(JSON.stringify(message));
      },

      subscribeAndDump(topic) {
        if (this.subscribedTopics.has(topic)) return;
        this.subscribedTopics.add(topic);
        const requestId = this.nextRequestId();
        this.pendingRegistrations.set(requestId, topic);
        this.startRequestTimeout(requestId, "REGISTER " + topic, () => {
          this.pendingRegistrations.delete(requestId);
          this.subscribedTopics.delete(topic);
        });
        try {
          this.send([64, requestId, {}, topic]);
        } catch (error) {
          this.clearRequestTimeout(requestId);
          this.pendingRegistrations.delete(requestId);
          this.subscribedTopics.delete(topic);
          throw error;
        }
      },

      rpc(procedure, kwargs) {
        const requestId = this.nextRequestId();
        const result = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!this.pendingRpcs.delete(requestId)) return;
            reject(new Error("TippmixPro WAMP RPC időtúllépés: " + procedure));
          }, 15_000);
          this.pendingRpcs.set(requestId, { resolve, reject, timer });
        });
        try {
          this.send([48, requestId, {}, procedure, [], kwargs]);
        } catch (error) {
          const pending = this.pendingRpcs.get(requestId);
          this.pendingRpcs.delete(requestId);
          clearTimeout(pending?.timer);
          pending?.reject(error);
        }
        return result;
      },

      handleWampMessage(message) {
        const type = message[0];
        if (type === 65) {
          const requestId = message[1];
          const registrationId = message[2];
          const topic = this.pendingRegistrations.get(requestId);
          this.clearRequestTimeout(requestId);
          this.pendingRegistrations.delete(requestId);
          if (!topic) return;
          this.registrationTopics.set(registrationId, topic);
          const callId = this.nextRequestId();
          this.pendingCalls.set(callId, topic);
          this.startRequestTimeout(callId, "initialDump " + topic, () => {
            this.pendingCalls.delete(callId);
            this.subscribedTopics.delete(topic);
          });
          try {
            this.send([48, callId, {}, "/sports#initialDump", [], { topic }]);
          } catch (error) {
            this.clearRequestTimeout(callId);
            this.pendingCalls.delete(callId);
            this.registrationTopics.delete(registrationId);
            this.subscribedTopics.delete(topic);
            throw error;
          }
          return;
        }
        if (type === 50) {
          const requestId = message[1];
          this.clearRequestTimeout(requestId);
          const rpc = this.pendingRpcs.get(requestId);
          if (rpc) {
            this.pendingRpcs.delete(requestId);
            clearTimeout(rpc.timer);
            rpc.resolve(message[4]);
            return;
          }
          const topic = this.pendingCalls.get(requestId) ?? "";
          this.pendingCalls.delete(requestId);
          this.processPayload(message[4], topic);
          return;
        }
        if (type === 68) {
          const topic = this.registrationTopics.get(message[2]) ?? "";
          this.processPayload(message[5], topic);
          this.send([70, message[1], {}]);
          return;
        }
        if (type === 8) {
          // WAMP ERROR: [ERROR, requestType, requestId, ...]. The old code used
          // message[1], leaving the actual request permanently pending.
          const requestId = message[2];
          this.clearRequestTimeout(requestId);
          const rpc = this.pendingRpcs.get(requestId);
          if (rpc) {
            this.pendingRpcs.delete(requestId);
            clearTimeout(rpc.timer);
            rpc.reject(new Error("WAMP RPC hiba: " + JSON.stringify(message)));
          }
          const pendingTopic = this.pendingCalls.get(requestId);
          if (pendingTopic) {
            this.pendingCalls.delete(requestId);
            this.subscribedTopics.delete(pendingTopic);
          }
          const registrationTopic = this.pendingRegistrations.get(requestId);
          if (registrationTopic) {
            this.pendingRegistrations.delete(requestId);
            this.subscribedTopics.delete(registrationTopic);
          }
          this.lastError = "TippmixPro WAMP hiba: " + JSON.stringify(message);
        }
      },

      processPayload(payload, topic) {
        const records = payload?.records;
        if (!Array.isArray(records)) return;
        const fullRecords = records.filter(record => record && !record.changeType);
        for (const record of records) this.applyRecord(record);

        if (topic.includes("tournament-aggregator-groups-overview")) {
          const outcomeEvents = new Map(
            fullRecords
              .filter(record => record._type === "OUTCOME")
              .map(record => [record.id, record.eventId]),
          );
          const firstOfferByEventAndType = new Map();
          for (const record of fullRecords) {
            if (record._type !== "BETTING_OFFER") continue;
            const eventId = outcomeEvents.get(record.outcomeId);
            const key = eventId + "|" + record.bettingTypeId;
            if (eventId && !firstOfferByEventAndType.has(key)) {
              firstOfferByEventAndType.set(key, record.id);
            }
          }
          for (const offerId of firstOfferByEventAndType.values()) this.queueOffer(offerId);
        }
      },

      applyRecord(record) {
        if (!record) return;
        if (record.changeType) {
          const maps = {
            MATCH: this.matches,
            MARKET: this.markets,
            OUTCOME: this.outcomes,
            MARKET_OUTCOME_RELATION: this.relations,
            BETTING_OFFER: this.offers,
            TOURNAMENT: this.tournaments,
          };
          const map = maps[record.entityType];
          if (!map) return;
          if (record.changeType === "DELETE") {
            map.delete(record.id);
            return;
          }
          const previous = map.get(record.id) ?? { id: record.id };
          const next = { ...previous, ...record.changedProperties };
          map.set(record.id, next);
          if (
            record.entityType === "BETTING_OFFER" &&
            ["69", "693"].includes(String(next.bettingTypeId))
          ) {
            this.queueOffer(record.id);
          }
          return;
        }

        const maps = {
          MATCH: this.matches,
          MARKET: this.markets,
          OUTCOME: this.outcomes,
          MARKET_OUTCOME_RELATION: this.relations,
          BETTING_OFFER: this.offers,
          TOURNAMENT: this.tournaments,
        };
        maps[record._type]?.set(record.id, record);
      },

      queueOffer(offerId) {
        if (this.closing || this.subscribedOfferIds.has(offerId)) return;
        this.queuedOfferIds.add(offerId);
        clearTimeout(this.offerFlushTimer);
        this.offerFlushTimer = setTimeout(() => {
          this.offerFlushTimer = null;
          try {
            this.flushOffers();
          } catch (error) {
            this.lastError = String(error?.stack ?? error);
            this.scheduleOfferFlush(1000);
          }
        }, 250);
      },

      scheduleOfferFlush(delayMs) {
        if (this.closing || this.offerFlushTimer || this.queuedOfferIds.size === 0) return;
        this.offerFlushTimer = setTimeout(() => {
          this.offerFlushTimer = null;
          try {
            this.flushOffers();
          } catch (error) {
            this.lastError = String(error?.stack ?? error);
            this.scheduleOfferFlush(1000);
          }
        }, delayMs);
      },

      flushOffers() {
        const ids = [...this.queuedOfferIds];
        this.queuedOfferIds.clear();
        for (let index = 0; index < ids.length; index += 30) {
          const chunk = ids.slice(index, index + 30);
          try {
            this.subscribeAndDump(BASE + "bettingOffers/" + chunk.join(","));
            for (const id of chunk) this.subscribedOfferIds.add(id);
          } catch (error) {
            for (const id of ids.slice(index)) this.queuedOfferIds.add(id);
            throw error;
          }
        }
      },

      async discoverTournamentIds() {
        await this.connect();
        const locationsPayload = await this.rpc("/sports#locations", {
          lang: "hu",
          sportId: "1",
          locationTypes: ["COUNTRY", "CONTINENT", "WORLD", "MISC"],
        });
        const locations = (locationsPayload?.records ?? []).filter(
          location => Number(location.numberOfEvents ?? 0) > 0,
        );
        const tournamentPayloads = await Promise.all(
          locations.map(location =>
            this.rpc("/sports#tournaments", {
              lang: "hu",
              sportId: "1",
              eventCategoryId: String(location.id) + "001",
              locationId: String(location.id),
            }).catch(error => {
              this.lastError = String(error?.stack ?? error);
              return { records: [] };
            }),
          ),
        );
        const ids = new Set();
        for (const payload of tournamentPayloads) {
          for (const tournament of payload?.records ?? []) {
            if (
              tournament._type === "TOURNAMENT" &&
              (Number(tournament.numberOfEvents ?? 0) > 0 ||
                Number(tournament.numberOfLiveEvents ?? 0) > 0)
            ) {
              ids.add(String(tournament.id));
              this.tournaments.set(tournament.id, tournament);
            }
          }
        }
        return [...ids];
      },

      async subscribeTournaments(tournamentIds) {
        await this.connect();
        for (const tournamentId of tournamentIds) {
          const topic =
            BASE +
            "tournament-aggregator-groups-overview/" +
            tournamentId +
            AGGREGATOR_SUFFIX;
          this.subscribeAndDump(topic);
        }
      },

      async refreshCatalogue() {
        const ids = await this.discoverTournamentIds();
        await this.subscribeTournaments(ids);
        this.lastCatalogueRefreshAt = Date.now();
        return {
          tournamentIds: ids.length,
          subscribedTopics: this.subscribedTopics.size,
        };
      },

      getSnapshot() {
        const marketsByEvent = new Map();
        for (const market of this.markets.values()) {
          if (
            ![TARGET_DISPLAY_KEY, "b693_ep3"].includes(market.displayKey) ||
            market.isClosed === true ||
            market.isAvailable === false
          ) continue;
          if (!marketsByEvent.has(market.eventId)) marketsByEvent.set(market.eventId, {});
          const key = market.displayKey === TARGET_DISPLAY_KEY ? "regular" : "super";
          marketsByEvent.get(market.eventId)[key] = market;
        }
        const outcomeIdsByMarket = new Map();
        for (const relation of this.relations.values()) {
          if (!outcomeIdsByMarket.has(relation.marketId)) {
            outcomeIdsByMarket.set(relation.marketId, new Set());
          }
          outcomeIdsByMarket.get(relation.marketId).add(relation.outcomeId);
        }
        const selectionsByMarket = new Map();
        for (const marketTypes of marketsByEvent.values()) {
          for (const market of Object.values(marketTypes)) {
            const outcomeIds = outcomeIdsByMarket.get(market.id) ?? new Set();
            const selections = {};
            for (const outcomeId of outcomeIds) {
              const outcome = this.outcomes.get(outcomeId);
              const key = outcome?.headerNameKey;
              if (["home", "draw", "away"].includes(key)) selections[key] = outcome;
            }
            selectionsByMarket.set(market.id, selections);
          }
        }
        const offersByOutcome = new Map();
        for (const offer of this.offers.values()) {
          if (
            ["69", "693"].includes(offer.bettingTypeId) &&
            offer.statusId === "1" &&
            offer.isAvailable !== false &&
            Number(offer.odds) > 0
          ) {
            const previous = offersByOutcome.get(offer.outcomeId);
            if (!previous || Number(offer.lastChangedTime ?? 0) >= Number(previous.lastChangedTime ?? 0)) {
              offersByOutcome.set(offer.outcomeId, offer);
            }
          }
        }

        const oddsForMarket = market => {
          if (!market) return null;
          const selections = selectionsByMarket.get(market.id) ?? {};
          if (!selections.home || !selections.draw || !selections.away) return null;
          const home = offersByOutcome.get(selections.home.id);
          const draw = offersByOutcome.get(selections.draw.id);
          const away = offersByOutcome.get(selections.away.id);
          if (!home || !draw || !away) return null;
          return {
            odds: [Number(home.odds), Number(draw.odds), Number(away.odds)],
            inPlay: home.isLive === true,
            lastChangedTime: Math.max(
              Number(home.lastChangedTime ?? 0),
              Number(draw.lastChangedTime ?? 0),
              Number(away.lastChangedTime ?? 0),
            ),
          };
        };

        const events = [];
        for (const [eventId, marketTypes] of marketsByEvent) {
          const match = this.matches.get(eventId);
          if (!match) continue;
          const regular = oddsForMarket(marketTypes.regular);
          const superOdds = oddsForMarket(marketTypes.super);
          if (!regular && !superOdds) continue;
          const primary = regular ?? superOdds;
          events.push({
            eventId,
            eventName: match.name ?? "",
            homeName: match.homeParticipantName ?? "",
            awayName: match.awayParticipantName ?? "",
            competitionName: match.parentName ?? "",
            startTime: Number(match.startTime),
            inPlay:
              regular?.inPlay === true ||
              superOdds?.inPlay === true ||
              match.statusName === "Live",
            statusId: match.statusId,
            statusName: match.statusName ?? null,
            score: match.score ?? match.scoreText ?? match.currentScore ?? null,
            homeScore: match.homeScore ?? null,
            awayScore: match.awayScore ?? null,
            period: match.period ?? match.periodName ?? null,
            minute: match.minute ?? match.elapsed ?? null,
            redCards: match.redCards ?? null,
            odds: primary.odds,
            regularOdds: regular?.odds ?? null,
            superOdds: superOdds?.odds ?? null,
            lastChangedTime: Math.max(
              regular?.lastChangedTime ?? 0,
              superOdds?.lastChangedTime ?? 0,
            ),
          });
        }
        events.sort((left, right) => left.startTime - right.startTime);
        return {
          generatedAt: Date.now(),
          connected: this.connected,
          pendingWork:
            this.pendingRegistrations.size +
            this.pendingCalls.size +
            this.pendingRpcs.size +
            this.queuedOfferIds.size,
          tournamentCount: this.tournaments.size,
          subscribedTopics: this.subscribedTopics.size,
          lastCatalogueRefreshAt: this.lastCatalogueRefreshAt,
          lastFrameAt: this.lastFrameAt,
          lastError: this.lastError,
          events,
        };
      },

      shutdown() {
        this.closing = true;
        this.generation += 1;
        clearTimeout(this.offerFlushTimer);
        clearTimeout(this.reconnectTimer);
        this.offerFlushTimer = null;
        this.reconnectTimer = null;
        this.connected = false;
        this.cancelConnect?.(new Error("A TippmixPro collector leállt."));
        this.cancelConnect = null;
        for (const pending of this.pendingRpcs.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("A TippmixPro collector leállt."));
        }
        this.pendingRpcs.clear();
        for (const timer of this.pendingRequestTimers.values()) clearTimeout(timer);
        this.pendingRequestTimers.clear();
        this.pendingCalls.clear();
        this.pendingRegistrations.clear();
        this.socket?.close();
      },
    };

    globalThis.__tippmixProMatchOddsCollector = collector;
    return { initialized: true };
  })()`;
}

const browserRefreshSource =
  "globalThis.__tippmixProMatchOddsCollector.refreshCatalogue()";
const browserSnapshotSource =
  "globalThis.__tippmixProMatchOddsCollector.getSnapshot()";
const browserShutdownSource =
  "globalThis.__tippmixProMatchOddsCollector?.shutdown?.()";

async function writeAtomically(filename, content) {
  await writeTextAtomically(filename, content);
}

async function main() {
  const writerLock = await acquireWriterLock(
    CONFIG.outputFile,
    "TippmixPro production monitor",
  );
  let cdp = null;
  let contextId;
  let catalogueTimer;
  let outputTimer;
  let stopping = false;
  let writing = false;
  let lastStatus = "";
  let recoveryPromise = null;

  const connectCdp = async (force = false) => {
    if (!force && cdp?.socket?.readyState === WebSocket.OPEN) return;
    cdp?.close();
    const target = await findTarget();
    const nextClient = new CdpClient(target.webSocketDebuggerUrl);
    await nextClient.connect();
    cdp = nextClient;
    contextId = undefined;
  };

  const stop = async exitCode => {
    if (stopping) return;
    stopping = true;
    clearInterval(catalogueTimer);
    clearInterval(outputTimer);
    try {
      if (contextId && cdp) await cdp.evaluate(browserShutdownSource, contextId, false);
    } catch {
      // A böngésző vagy az iframe ekkor már bezáródhatott.
    }
    cdp?.close();
    await writerLock.release();
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));

  await connectCdp();

  const recoverCollector = () => {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      let lastError;
      for (let attempt = 0; attempt < 20 && !stopping; attempt += 1) {
        try {
          if (attempt > 0 || cdp?.socket?.readyState !== WebSocket.OPEN) {
            await connectCdp(attempt > 0);
          }
          contextId = await cdp.waitForSportsContext();
          await cdp.evaluate(browserCollectorSource(), contextId);
          const result = await cdp.evaluate(browserRefreshSource, contextId);
          console.log(
            `[catalogue] tournaments=${result.tournamentIds} topics=${result.subscribedTopics}`,
          );
          return;
        } catch (error) {
          lastError = error;
          await sleep(500);
        }
      }
      throw lastError ?? new Error("A TippmixPro collector nem állítható helyre.");
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  const refresh = async () => {
    try {
      if (recoveryPromise) return;
      const result = await cdp.evaluate(browserRefreshSource, contextId);
      console.log(
        `[catalogue] tournaments=${result.tournamentIds} topics=${result.subscribedTopics}`,
      );
    } catch (error) {
      console.error(`[catalogue] ${error.message}`);
      try {
        await recoverCollector();
      } catch (recoveryError) {
        console.error(`[recovery] ${recoveryError.message}`);
        await stop(1);
      }
    }
  };

  const writeOutput = async () => {
    if (writing || stopping || recoveryPromise) return;
    writing = true;
    try {
      const snapshot = await cdp.evaluate(browserSnapshotSource, contextId);
      await writeAtomically(CONFIG.outputFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      const status =
        `${snapshot.events.length} events, ${snapshot.subscribedTopics} topics, ` +
        `${snapshot.connected ? "connected" : "disconnected"}, ` +
        `${snapshot.pendingWork} pending`;
      if (status !== lastStatus) {
        lastStatus = status;
        console.log(`[output] ${status} -> ${CONFIG.outputFile}`);
      }
    } catch (error) {
      console.error(`[output] ${error.message}`);
      if (!error?.isOutputError) {
        try {
          await recoverCollector();
        } catch (recoveryError) {
          console.error(`[recovery] ${recoveryError.message}`);
          await stop(1);
        }
      }
    } finally {
      writing = false;
    }
  };

  await recoverCollector();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const snapshot = await cdp.evaluate(browserSnapshotSource, contextId);
      if (snapshot.events.length > 0 && snapshot.pendingWork === 0) break;
    } catch {
      await recoverCollector();
    }
  }
  await writeOutput();

  if (CONFIG.once) {
    await stop(0);
    return;
  }
  catalogueTimer = setInterval(() => void refresh(), CONFIG.catalogueRefreshMs);
  outputTimer = setInterval(() => void writeOutput(), CONFIG.outputIntervalMs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
