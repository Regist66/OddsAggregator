import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");

const CONFIG = {
  cdpEndpoint: process.env.TIPPMIXPRO_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
  targetUrlFragment: process.env.TIPPMIXPRO_TARGET_URL_FRAGMENT ?? "tippmixpro.hu",
  outputFile:
    process.env.TIPPMIXPRO_OUTPUT_FILE ??
    path.join(DATA_DIR, "tippmixpro_odds_snapshot.json"),
  catalogueRefreshMs: Number(
    process.env.TIPPMIXPRO_CATALOGUE_REFRESH_MS ?? 300_000,
  ),
  outputIntervalMs: Number(process.env.TIPPMIXPRO_OUTPUT_INTERVAL_MS ?? 1_000),
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
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("Nem sikerült kapcsolódni a CDP WebSockethez.")),
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
      this.pending.set(id, { resolve, reject });
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
    this.socket?.close();
  }

  #onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
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
    for (const { reject } of this.pending.values()) {
      reject(new Error("A CDP kapcsolat váratlanul megszakadt."));
    }
    this.pending.clear();
  }
}

async function findTarget() {
  const response = await fetch(`${CONFIG.cdpEndpoint}/json`);
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

function browserCollectorSource() {
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
      pendingRegistrations: new Map(),
      pendingCalls: new Map(),
      pendingRpcs: new Map(),
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

      async connect() {
        if (this.socket?.readyState === WebSocket.OPEN && this.connected) return;
        if (this.connectPromise) return this.connectPromise;
        const generation = ++this.generation;
        this.connectPromise = new Promise((resolve, reject) => {
          const socket = new WebSocket(
            "wss://sportsapi.tippmixpro.hu/v2",
            ["wamp.2.json"],
          );
          this.socket = socket;
          const timeout = setTimeout(
            () => reject(new Error("TippmixPro WAMP kapcsolódási időtúllépés.")),
            10_000,
          );

          socket.onopen = () => {
            socket.send(JSON.stringify([
              1,
              "www.tippmixpro.hu",
              { roles: { caller: {}, callee: {} }, agent: "SharpX monitor" },
            ]));
          };
          socket.onmessage = event => {
            if (generation !== this.generation) return;
            this.lastFrameAt = Date.now();
            try {
              const message = JSON.parse(String(event.data));
              if (message[0] === 2) {
                clearTimeout(timeout);
                this.connected = true;
                resolve();
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
            clearTimeout(timeout);
            if (generation !== this.generation) return;
            this.connected = false;
            this.connectPromise = null;
            this.subscribedTopics.clear();
            this.registrationTopics.clear();
            this.pendingRegistrations.clear();
            this.pendingCalls.clear();
            for (const pending of this.pendingRpcs.values()) {
              pending.reject(new Error("A TippmixPro WAMP kapcsolat megszakadt."));
            }
            this.pendingRpcs.clear();
            setTimeout(() => void this.reconnect(), 1000);
          };
        }).finally(() => {
          if (generation === this.generation) this.connectPromise = null;
        });
        return this.connectPromise;
      },

      async reconnect() {
        try {
          await this.connect();
          const tournamentIds = [...this.tournaments.keys()];
          this.subscribedOfferIds.clear();
          this.queuedOfferIds.clear();
          await this.subscribeTournaments(tournamentIds);
        } catch (error) {
          this.lastError = String(error?.stack ?? error);
          setTimeout(() => void this.reconnect(), 5000);
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
        this.send([64, requestId, {}, topic]);
      },

      rpc(procedure, kwargs) {
        const requestId = this.nextRequestId();
        const result = new Promise((resolve, reject) => {
          this.pendingRpcs.set(requestId, { resolve, reject });
        });
        this.send([48, requestId, {}, procedure, [], kwargs]);
        return result;
      },

      handleWampMessage(message) {
        const type = message[0];
        if (type === 65) {
          const requestId = message[1];
          const registrationId = message[2];
          const topic = this.pendingRegistrations.get(requestId);
          this.pendingRegistrations.delete(requestId);
          if (!topic) return;
          this.registrationTopics.set(registrationId, topic);
          const callId = this.nextRequestId();
          this.pendingCalls.set(callId, topic);
          this.send([48, callId, {}, "/sports#initialDump", [], { topic }]);
          return;
        }
        if (type === 50) {
          const requestId = message[1];
          const rpc = this.pendingRpcs.get(requestId);
          if (rpc) {
            this.pendingRpcs.delete(requestId);
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
        if (type === 8 || type === 66) {
          const requestId = message[1];
          const rpc = this.pendingRpcs.get(requestId);
          if (rpc) {
            this.pendingRpcs.delete(requestId);
            rpc.reject(new Error("WAMP RPC hiba: " + JSON.stringify(message)));
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
          map.set(record.id, { ...previous, ...record.changedProperties });
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
        if (this.subscribedOfferIds.has(offerId)) return;
        this.queuedOfferIds.add(offerId);
        clearTimeout(this.offerFlushTimer);
        this.offerFlushTimer = setTimeout(() => this.flushOffers(), 250);
      },

      flushOffers() {
        const ids = [...this.queuedOfferIds];
        this.queuedOfferIds.clear();
        for (let index = 0; index < ids.length; index += 30) {
          const chunk = ids.slice(index, index + 30);
          for (const id of chunk) this.subscribedOfferIds.add(id);
          this.subscribeAndDump(BASE + "bettingOffers/" + chunk.join(","));
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
        this.generation += 1;
        clearTimeout(this.offerFlushTimer);
        this.connected = false;
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
  const temporaryFile = `${filename}.tmp`;
  await fs.writeFile(temporaryFile, content, "utf8");
  try {
    await fs.rename(temporaryFile, filename);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    await fs.rm(filename, { force: true });
    await fs.rename(temporaryFile, filename);
  }
}

async function main() {
  const target = await findTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  let contextId;
  let catalogueTimer;
  let outputTimer;
  let stopping = false;
  let writing = false;
  let lastStatus = "";
  let recoveryPromise = null;

  const stop = async exitCode => {
    if (stopping) return;
    stopping = true;
    clearInterval(catalogueTimer);
    clearInterval(outputTimer);
    try {
      if (contextId) await cdp.evaluate(browserShutdownSource, contextId, false);
    } catch {
      // A böngésző vagy az iframe ekkor már bezáródhatott.
    }
    cdp.close();
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));

  await cdp.connect();

  const recoverCollector = () => {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      let lastError;
      for (let attempt = 0; attempt < 20 && !stopping; attempt += 1) {
        try {
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
      await recoverCollector();
    }
  };

  const writeOutput = async () => {
    if (writing || stopping || recoveryPromise) return;
    writing = true;
    try {
      const snapshot = await cdp.evaluate(browserSnapshotSource, contextId);
      if ((snapshot.events.length === 0 || snapshot.pendingWork > 0) && lastStatus) return;
      await writeAtomically(CONFIG.outputFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      const status = `${snapshot.events.length} events, ${snapshot.subscribedTopics} topics`;
      if (status !== lastStatus) {
        lastStatus = status;
        console.log(`[output] ${status} -> ${CONFIG.outputFile}`);
      }
    } catch (error) {
      console.error(`[output] ${error.message}`);
      await recoverCollector();
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

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
