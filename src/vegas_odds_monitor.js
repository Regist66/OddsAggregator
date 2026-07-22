import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
const CONFIG_DIR = path.join(PROJECT_DIR, "config");

const CONFIG = {
  cdpEndpoint: process.env.VEGAS_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
  targetUrlPrefix: process.env.VEGAS_TARGET_URL_PREFIX ?? "https://vegas.hu/sports",
  outputFile:
    process.env.VEGAS_OUTPUT_FILE ?? path.join(DATA_DIR, "vegas_odds_snapshot.json"),
  watchlistFile:
    process.env.SHARPX_WATCHLIST_FILE ?? path.join(DATA_DIR, "sharpx_watchlist.json"),
  teamAliasesFile:
    process.env.TEAM_ALIASES_FILE ?? path.join(CONFIG_DIR, "team_aliases.json"),
  outputIntervalMs: Number(process.env.VEGAS_OUTPUT_INTERVAL_MS ?? 1_000),
  matchedRefreshMs: Number(process.env.VEGAS_MATCHED_REFRESH_MS ?? 5_000),
  catalogueRefreshMs: Number(process.env.VEGAS_CATALOGUE_REFRESH_MS ?? 300_000),
  liveRefreshMs: Number(process.env.VEGAS_LIVE_REFRESH_MS ?? 1_000),
  once: process.env.VEGAS_ONCE === "1",
};

const EVENT_TIME_BUCKET_MS = 30 * 60_000;

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
        () => reject(new Error("Nem sikerült kapcsolódni a Vegas CDP targethez.")),
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
      this.pending.set(id, { resolve, reject });
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
      reject(new Error("A Vegas CDP kapcsolat váratlanul megszakadt."));
    }
    this.pending.clear();
  }
}

async function findVegasTarget() {
  const response = await fetch(`${CONFIG.cdpEndpoint}/json`);
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

function browserCollectorSource() {
  const options = JSON.stringify({
    liveRefreshMs: CONFIG.liveRefreshMs,
    catalogueRefreshMs: CONFIG.catalogueRefreshMs,
    enhancedRefreshMs: CONFIG.matchedRefreshMs,
  });

  return `(() => {
    globalThis.__vegasSoccerCollector?.shutdown?.();
    const options = ${options};
    const BASE = "https://hu-sb2frontend-altenar2.biahosted.com/api/widget/";
    const QUERY =
      "?culture=hu-HU&timezoneOffset=-120&integration=vegas.hu" +
      "&deviceType=1&numFormat=hu-HU&countryCode=LU";

    const collector = {
      events: new Map(),
      liveEventIds: new Set(),
      enhancedEventIds: new Set(),
      lastCatalogueRefreshAt: null,
      lastLiveRefreshAt: null,
      lastEnhancedRefreshAt: null,
      lastError: null,
      catalogueBusy: false,
      liveBusy: false,
      enhancedBusy: false,
      matchedEventsBusy: false,
      timers: [],

      async request(endpoint, parameters = "") {
        const response = await fetch(BASE + endpoint + QUERY + parameters, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(endpoint + " HTTP " + response.status);
        return response.json();
      },

      isOneXTwoMarket(market, selections, enhanced = false) {
        const name = String(market?.name ?? "")
          .replace(/\s+/g, " ")
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
          if (nextEvents.size > 0) this.events = nextEvents;
          this.lastCatalogueRefreshAt = Date.now();
          this.lastError = failedChamps
            ? failedChamps + " bajnokság lekérése sikertelen"
            : null;
          return {
            events: this.events.size,
            championships: champIds.length,
            failedChamps,
          };
        } finally {
          this.catalogueBusy = false;
        }
      },

      async refreshEvents(eventIds) {
        if (this.matchedEventsBusy) return { busy: true };
        this.matchedEventsBusy = true;
        const uniqueIds = [...new Set(eventIds.map(Number).filter(Number.isFinite))];
        try {
          const batches = [];
          for (let start = 0; start < uniqueIds.length; start += 50) {
            batches.push(uniqueIds.slice(start, start + 50));
          }
          const payloads = await Promise.all(
            batches.map(batch =>
              this.request("GetEventsById", "&eventIds=" + batch.join(",")),
            ),
          );
          for (const payload of payloads) this.mapPayload(payload, "prematch");
          return { refreshedEvents: uniqueIds.length };
        } finally {
          this.matchedEventsBusy = false;
        }
      },

      async refreshLive() {
        if (this.liveBusy) return;
        this.liveBusy = true;
        try {
          const payload = await this.request("GetLiveOverview", "&sportId=66");
          const currentIds = new Set(this.mapPayload(payload, "live"));
          for (const id of this.liveEventIds) {
            if (!currentIds.has(id)) this.events.delete(id);
          }
          this.liveEventIds = currentIds;
          this.lastLiveRefreshAt = Date.now();
        } catch (error) {
          this.lastError = error.message;
        } finally {
          this.liveBusy = false;
        }
      },

      async refreshEnhancedOdds() {
        if (this.enhancedBusy) return { busy: true };
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
            updatedAt: previous?.updatedAt ?? Date.now(),
          });
          currentIds.add(event.id);
        }

        const detailResults = await Promise.allSettled(
          [...currentIds].map(id =>
            this.request("GetEventDetails", "&eventId=" + id),
          ),
        );
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
          if (!previous) continue;
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
        this.lastEnhancedRefreshAt = Date.now();
        return { enhancedEvents: currentIds.size };
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
          lastEnhancedRefreshAt: this.lastEnhancedRefreshAt,
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
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
      },
    };

    globalThis.__vegasSoccerCollector = collector;
    collector.timers.push(
      setInterval(() => void collector.refreshLive(), options.liveRefreshMs),
      setInterval(
        () => void collector.refreshEnhancedOdds(),
        options.enhancedRefreshMs,
      ),
      setInterval(() => void collector.refreshCatalogue(), options.catalogueRefreshMs),
    );
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

async function refreshTeamAliases() {
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

function createEventTimeIndex(events) {
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

function timeCandidates(index, startTime) {
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

function findVegasEvent(watchEvent, vegasEvents) {
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

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

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
  const target = await findVegasTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  let contextId;
  let outputTimer;
  let matchedRefreshTimer;
  let stopping = false;
  let writing = false;
  let refreshingMatchedEvents = false;
  let selectedIds = [];
  let lastStatus = "";

  const stop = async exitCode => {
    if (stopping) return;
    stopping = true;
    clearInterval(outputTimer);
    clearInterval(matchedRefreshTimer);
    try {
      if (contextId) await cdp.evaluate(browserShutdownSource, contextId, false);
    } catch {
      // A böngésző ekkor már bezáródhatott.
    }
    cdp.close();
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  await cdp.connect();

  const initialize = async () => {
    contextId = await cdp.waitForMainContext();
    await cdp.evaluate(browserCollectorSource(), contextId);
    const catalogue = await cdp.evaluate(browserRefreshCatalogueSource, contextId);
    await cdp.evaluate(browserRefreshLiveSource, contextId);
    await cdp.evaluate(browserRefreshEnhancedSource, contextId);
    console.log(
      `[catalogue] ${catalogue.events} soccer events, ` +
      `${catalogue.championships} championships, ${catalogue.failedChamps} failed`,
    );
  };

  const refreshMatchedEvents = async () => {
    if (refreshingMatchedEvents || stopping) return;
    refreshingMatchedEvents = true;
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
      console.error(`[matched-refresh] ${error.message}`);
      try {
        await initialize();
      } catch (recoveryError) {
        console.error(`[recovery] ${recoveryError.message}`);
      }
    } finally {
      refreshingMatchedEvents = false;
    }
  };

  const writeOutput = async () => {
    if (writing || stopping) return;
    writing = true;
    try {
      const snapshot = await cdp.evaluate(
        `globalThis.__vegasSoccerCollector.snapshot(${JSON.stringify(selectedIds)})`,
        contextId,
      );
      await writeAtomically(CONFIG.outputFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      const status =
        `${snapshot.events.length} selected/live, ` +
        `${snapshot.catalogueEvents} catalogue, ${snapshot.liveEvents} live`;
      if (status !== lastStatus) {
        lastStatus = status;
        console.log(`[output] ${status} -> ${CONFIG.outputFile}`);
      }
    } catch (error) {
      console.error(`[output] ${error.message}`);
      try {
        await initialize();
      } catch (recoveryError) {
        console.error(`[recovery] ${recoveryError.message}`);
      }
    } finally {
      writing = false;
    }
  };

  await initialize();
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

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
