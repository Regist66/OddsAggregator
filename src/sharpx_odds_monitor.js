import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
const CONFIG_DIR = path.join(PROJECT_DIR, "config");

const CONFIG = {
  cdpEndpoint: process.env.SHARPX_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
  targetUrlPrefix:
    process.env.SHARPX_TARGET_URL_PREFIX ?? "https://sharpxch.com/player/sport/1",
  outputFile:
    process.env.SHARPX_OUTPUT_FILE ?? path.join(DATA_DIR, "combined_odds.txt"),
  surebetsOutputFile:
    process.env.SUREBETS_OUTPUT_FILE ??
    path.join(DATA_DIR, "football", "surebets_live_odds.txt"),
  tippmixProSnapshotFile:
    process.env.TIPPMIXPRO_SNAPSHOT_FILE ??
    path.join(DATA_DIR, "tippmixpro_odds_snapshot.json"),
  vegasSnapshotFile:
    process.env.VEGAS_SNAPSHOT_FILE ??
    path.join(DATA_DIR, "vegas_odds_snapshot.json"),
  watchlistFile:
    process.env.SHARPX_WATCHLIST_FILE ??
    path.join(DATA_DIR, "sharpx_watchlist.json"),
  teamAliasesFile:
    process.env.TEAM_ALIASES_FILE ?? path.join(CONFIG_DIR, "team_aliases.json"),
  prematchMinimumMatched: Number(
    process.env.SHARPX_PREMATCH_MIN_MATCHED ?? 300,
  ),
  catalogueRefreshMs: Number(
    process.env.SHARPX_CATALOGUE_REFRESH_MS ?? 60_000,
  ),
  outputIntervalMs: Number(process.env.SHARPX_OUTPUT_INTERVAL_MS ?? 1_000),
  prematchRenderMs: Number(process.env.SHARPX_PREMATCH_RENDER_MS ?? 5_000),
  marketsPerSocket: Number(process.env.SHARPX_MARKETS_PER_SOCKET ?? 30),
  once: process.env.SHARPX_ONCE === "1",
};

const SHARPX_COMMISSION_RATE = 0.0295;
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
      const onError = () => reject(new Error("Nem sikerült kapcsolódni a CDP WebSockethez."));
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
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

  async waitForPortalContext(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const context = [...this.contexts.values()].find(
        item =>
          item.origin === "https://portal.sharpxch.com" &&
          item.auxData?.isDefault === true,
      );

      if (context) return context.id;
      await sleep(100);
    }

    throw new Error("Nem található a portal.sharpxch.com iframe execution contextje.");
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
      return;
    }

    if (message.method === "Runtime.executionContextDestroyed") {
      this.contexts.delete(message.params.executionContextId);
      return;
    }

    if (message.method === "Runtime.executionContextsCleared") {
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

async function findSharpXTarget() {
  const response = await fetch(`${CONFIG.cdpEndpoint}/json`);
  if (!response.ok) {
    throw new Error(`A CDP targetlista nem kérhető le: HTTP ${response.status}`);
  }

  const targets = await response.json();
  const target = targets.find(
    item =>
      item.type === "page" &&
      typeof item.url === "string" &&
      item.url.startsWith(CONFIG.targetUrlPrefix),
  );

  if (!target) {
    throw new Error(
      `Nincs megnyitva SharpX soccer oldal a Chrome-ban: ${CONFIG.targetUrlPrefix}`,
    );
  }

  return target;
}

function browserCollectorSource() {
  const options = JSON.stringify({
    prematchMinimumMatched: CONFIG.prematchMinimumMatched,
    marketsPerSocket: CONFIG.marketsPerSocket,
  });

  return `(() => {
    const VERSION = 1;
    const options = ${options};

    globalThis.__sharpXMatchOddsCollector?.shutdown?.();

    const collector = {
      version: VERSION,
      options,
      catalogue: new Map(),
      prices: new Map(),
      connections: [],
      generation: 0,
      subscriptionSignature: "",
      lastCatalogueRefreshAt: null,
      lastError: null,

      async refreshCatalogue() {
        const requestBody = {
          id: "1",
          timeFilter: "ALL",
          viewBy: "POPULARITY",
          contextFilter: "EVENT_TYPE",
        };

        const firstResponse = await fetch("/customer/api/sport/details?page=0", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        });
        if (!firstResponse.ok) throw new Error("Catalogue HTTP " + firstResponse.status);

        const firstPage = await firstResponse.json();
        const pageCount = firstPage.marketCatalogueList.totalPages;
        const pages = [firstPage];

        for (let start = 1; start < pageCount; start += 5) {
          const pageNumbers = Array.from(
            { length: Math.min(5, pageCount - start) },
            (_, index) => start + index,
          );
          const batch = await Promise.all(
            pageNumbers.map(async page => {
              const response = await fetch("/customer/api/sport/details?page=" + page, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(requestBody),
              });
              if (!response.ok) throw new Error("Catalogue HTTP " + response.status);
              return response.json();
            }),
          );
          pages.push(...batch);
        }

        const now = Date.now();
        const allMarkets = pages
          .flatMap(page => page.marketCatalogueList.content)
          .filter(market => market.description?.marketType === "MATCH_ODDS")
          .map(market => ({
            marketId: market.marketId,
            eventId: market.event?.id,
            eventName: market.event?.name ?? "",
            competitionName: market.competition?.name ?? "",
            marketStartTime: Number(market.marketStartTime),
            inPlay: market.inPlay === true,
            totalMatched: Number(market.totalMatched ?? 0),
            runners: (market.runners ?? []).map(runner => ({
              selectionId: Number(runner.selectionId),
              runnerName: runner.runnerName ?? "",
            })),
          }))
          .filter(market => market.marketId && market.eventId);

        this.catalogue = new Map(allMarkets.map(market => [market.marketId, market]));

        const selected = allMarkets
          .filter(
            market =>
              market.inPlay ||
              market.marketStartTime > now,
          )
          .sort((left, right) => right.totalMatched - left.totalMatched);

        this.lastCatalogueRefreshAt = Date.now();
        this.applySubscriptions(selected);
        return {
          catalogueMarkets: allMarkets.length,
          selectedMarkets: selected.length,
          liveMarkets: selected.filter(market => market.inPlay).length,
        };
      },

      applySubscriptions(markets) {
        const signature = markets.map(market => market.marketId).sort().join(",");
        if (signature === this.subscriptionSignature) return;

        this.subscriptionSignature = signature;
        this.generation += 1;
        const generation = this.generation;
        this.closeConnections();

        const size = Math.max(1, this.options.marketsPerSocket);
        for (let index = 0; index < markets.length; index += size) {
          this.openConnection(markets.slice(index, index + size), generation, 0);
        }
      },

      openConnection(markets, generation, attempt) {
        if (generation !== this.generation || markets.length === 0) return;

        const serverId = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
        const sessionId = crypto.randomUUID();
        const url =
          "wss://portal.sharpxch.com/customer/ws/multiple-market-prices/" +
          serverId +
          "/" +
          sessionId +
          "/websocket";
        const connection = {
          socket: new WebSocket(url),
          markets,
          generation,
          attempt,
          readyMarkets: new Set(),
          intentionallyClosed: false,
          opened: false,
          lastFrameAt: null,
        };
        this.connections.push(connection);

        connection.socket.onmessage = event => {
          if (generation !== this.generation) return;
          const raw = String(event.data);
          connection.lastFrameAt = Date.now();

          if (raw === "o") {
            connection.opened = true;
            connection.socket.send(
              JSON.stringify([
                JSON.stringify(
                  markets.map(market => ({
                    marketId: market.marketId,
                    eventId: market.eventId,
                    applicationType: "WEB",
                  })),
                ),
              ]),
            );
            return;
          }

          if (raw === "h" || !raw.startsWith("a")) return;

          try {
            for (const encoded of JSON.parse(raw.slice(1))) {
              const decoded = JSON.parse(encoded);
              const updates = Array.isArray(decoded) ? decoded : [decoded];

              for (const update of updates) {
                if (!update.id || !this.catalogue.has(update.id)) continue;
                const previous = this.prices.get(update.id);
                if (
                  previous &&
                  Number.isFinite(previous.apiPt) &&
                  Number.isFinite(update.apiPt) &&
                  update.apiPt < previous.apiPt
                ) {
                  continue;
                }

                this.prices.set(update.id, {
                  ...previous,
                  ...update,
                  marketDefinition:
                    update.marketDefinition ?? previous?.marketDefinition,
                  rc: update.rc ?? previous?.rc ?? [],
                  receivedAt: Date.now(),
                  generation,
                });
                connection.readyMarkets.add(update.id);
              }
            }
          } catch (error) {
            this.lastError = String(error?.stack ?? error);
          }
        };

        connection.socket.onerror = () => {
          this.lastError = "SharpX WebSocket hiba";
        };

        connection.socket.onclose = () => {
          connection.opened = false;
          connection.readyMarkets.clear();
          this.connections = this.connections.filter(item => item !== connection);
          if (connection.intentionallyClosed || generation !== this.generation) return;
          const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
          setTimeout(() => this.openConnection(markets, generation, attempt + 1), delay);
        };
      },

      getSnapshot() {
        const selectedIds = new Set(
          this.subscriptionSignature ? this.subscriptionSignature.split(",") : [],
        );

        const markets = [...selectedIds]
          .map(marketId => {
            const catalogue = this.catalogue.get(marketId);
            const price = this.prices.get(marketId);
            if (!catalogue || !price || price.generation !== this.generation) return null;
            const healthy = this.connections.some(
              connection =>
                connection.generation === this.generation &&
                connection.socket.readyState === WebSocket.OPEN &&
                connection.readyMarkets.has(marketId),
            );
            if (!healthy) return null;

            const marketDefinition = price.marketDefinition ?? {};
            return {
              ...catalogue,
              inPlay: marketDefinition.inPlay ?? catalogue.inPlay,
              status: marketDefinition.status ?? "OPEN",
              betDelay: marketDefinition.betDelay ?? 0,
              totalMatched: Number(price.tv ?? catalogue.totalMatched ?? 0),
              apiPt: price.apiPt ?? null,
              receivedAt: price.receivedAt,
              runnerPrices: (price.rc ?? []).map(runner => ({
                selectionId: Number(runner.id),
                bestLay: runner.bdatl?.[0] ?? null,
              })),
            };
          })
          .filter(Boolean)
          .filter(market => market.status !== "CLOSED")
          .sort((left, right) => right.totalMatched - left.totalMatched);

        return {
          generatedAt: Date.now(),
          generation: this.generation,
          subscribedMarkets: selectedIds.size,
          initializedMarkets: markets.length,
          connections: this.connections
            .filter(connection => connection.generation === this.generation)
            .map(connection => ({
              opened: connection.opened,
              marketCount: connection.markets.length,
              readyCount: connection.readyMarkets.size,
              lastFrameAt: connection.lastFrameAt,
            })),
          lastCatalogueRefreshAt: this.lastCatalogueRefreshAt,
          lastError: this.lastError,
          markets,
        };
      },

      closeConnections() {
        for (const connection of this.connections) {
          connection.intentionallyClosed = true;
          connection.socket.close();
        }
        this.connections = [];
      },

      shutdown() {
        this.generation += 1;
        this.closeConnections();
      },
    };

    globalThis.__sharpXMatchOddsCollector = collector;
    return { initialized: true };
  })()`;
}

const browserRefreshCatalogueSource =
  "globalThis.__sharpXMatchOddsCollector.refreshCatalogue()";
const browserGetSnapshotSource =
  "globalThis.__sharpXMatchOddsCollector.getSnapshot()";
const browserShutdownSource =
  "globalThis.__sharpXMatchOddsCollector?.shutdown?.()";

function formatTimestamp(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const value = type => parts.find(part => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function formatInteger(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatOdds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(2) : "-.--";
}

function displayEventName(value) {
  return String(value).replace(/\s+v\s+/i, " - ");
}

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
  let stats;
  try {
    stats = await fs.stat(CONFIG.teamAliasesFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      teamAliasLookup = new Map();
      teamAliasesModifiedAt = -1;
      return;
    }
    throw error;
  }
  if (stats.mtimeMs === teamAliasesModifiedAt) return;

  const document = JSON.parse(await fs.readFile(CONFIG.teamAliasesFile, "utf8"));
  const nextLookup = new Map();
  for (const [canonicalName, aliases] of Object.entries(document.teams ?? {})) {
    if (!Array.isArray(aliases)) continue;
    const canonicalValue = canonicalName.replaceAll("_", " ");
    for (const alias of [canonicalValue, ...aliases]) {
      const key = teamAliasKey(alias);
      const previous = nextLookup.get(key);
      if (previous && previous !== canonicalValue) {
        throw new Error(
          `A(z) "${alias}" csapatalias két canonical névhez tartozik: ` +
            `${previous}, ${canonicalValue}`,
        );
      }
      if (key) nextLookup.set(key, canonicalValue);
    }
  }
  teamAliasLookup = nextLookup;
  teamAliasesModifiedAt = stats.mtimeMs;
}

function orderedOneXTwo(market) {
  const prices = new Map(
    market.runnerPrices.map(runner => [runner.selectionId, runner.bestLay?.odds]),
  );
  const draw = market.runners.find(
    runner =>
      runner.selectionId === 58805 || /(^|\s)draw($|\s)/i.test(runner.runnerName),
  );
  const teams = market.runners.filter(runner => runner !== draw);

  return [
    prices.get(teams[0]?.selectionId),
    prices.get(draw?.selectionId),
    prices.get(teams[1]?.selectionId),
  ];
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
  return families.find(([, aliases]) => aliases.some(alias => name.includes(alias)))?.[0];
}

function competitionsCompatible(left, right) {
  const leftFamily = competitionFamily(left);
  const rightFamily = competitionFamily(right);
  if (leftFamily || rightFamily) return leftFamily === rightFamily;
  return diceCoefficient(left, right) >= 0.55;
}

function diceCoefficient(leftValue, rightValue) {
  const left = normalizeTeamName(leftValue);
  const right = normalizeTeamName(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (
    (left.includes(right) && right.length >= 5) ||
    (right.includes(left) && left.length >= 5)
  ) {
    return 0.94;
  }
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
  // Covers the normal 30-minute window and the guarded one-hour source offset.
  for (let offset = -3; offset <= 3; offset += 1) {
    candidates.push(...(index.get(bucket + offset) ?? []));
  }
  return candidates;
}

function findTippmixProEvent(market, tippmixEvents) {
  const teams = market.runners.filter(
    runner =>
      runner.selectionId !== 58805 &&
      !/(^|\s)draw($|\s)/i.test(runner.runnerName),
  );
  if (teams.length < 2) return null;
  const startTime = Number(market.marketStartTime);
  let best = null;
  const fallbackCandidates = [];
  for (const event of tippmixEvents) {
    const timeDifference = Math.abs(Number(event.startTime) - startTime);
    if (!Number.isFinite(timeDifference)) continue;
    const homeScore = diceCoefficient(teams[0].runnerName, event.homeName);
    const awayScore = diceCoefficient(teams[1].runnerName, event.awayName);
    const score = (homeScore + awayScore) / 2;
    const withinNormalWindow = timeDifference <= 30 * 60_000;
    const probableOneHourSourceOffset =
      Math.abs(timeDifference - 60 * 60_000) <= 2 * 60_000 &&
      homeScore >= 0.84 &&
      awayScore >= 0.84 &&
      competitionsCompatible(market.competitionName, event.competitionName);
    if (!withinNormalWindow && !probableOneHourSourceOffset) continue;
    if (homeScore >= 0.45 && awayScore >= 0.45 && score >= 0.6) {
      if (!best || score > best.score) best = { event, score };
      continue;
    }
    if (
      timeDifference <= 2 * 60_000 &&
      competitionsCompatible(market.competitionName, event.competitionName)
    ) {
      fallbackCandidates.push({ event, homeScore, awayScore, score });
    }
  }
  if (best) return best.event;

  fallbackCandidates.sort((left, right) => right.score - left.score);
  const fallback = fallbackCandidates[0];
  if (!fallback) return null;
  const minimum = Math.min(fallback.homeScore, fallback.awayScore);
  const maximum = Math.max(fallback.homeScore, fallback.awayScore);
  const total = fallback.homeScore + fallback.awayScore;
  const strongEnough =
    (maximum >= 0.84 && total >= 0.88) ||
    (minimum >= 0.3 && total >= 0.85);
  const nextTotal = fallbackCandidates[1]
    ? fallbackCandidates[1].homeScore + fallbackCandidates[1].awayScore
    : 0;
  return strongEnough && total - nextTotal >= 0.12 ? fallback.event : null;
}

function renderSummary(snapshot, tippmixSnapshot, vegasSnapshot) {
  const lines = [`*** ${formatTimestamp(snapshot.generatedAt)} ***`, ""];
  const tippmixEvents = Array.isArray(tippmixSnapshot?.events)
    ? tippmixSnapshot.events
    : [];
  const vegasEvents = Array.isArray(vegasSnapshot?.events)
    ? vegasSnapshot.events
    : [];
  const tippmixTimeIndex = createEventTimeIndex(tippmixEvents);
  const vegasTimeIndex = createEventTimeIndex(vegasEvents);
  let tippmixMatches = 0;
  let vegasMatches = 0;
  let vegasEnhancedMatches = 0;

  const visibleMarkets = snapshot.markets.filter(
    market =>
      market.inPlay ||
      (Number(market.marketStartTime) > snapshot.generatedAt &&
        Number(market.totalMatched) >= CONFIG.prematchMinimumMatched),
  );

  for (const market of visibleMarkets) {
    const [home, draw, away] = orderedOneXTwo(market).map(formatOdds);
    lines.push(
      `${displayEventName(market.eventName)} / ${market.competitionName}    (${formatInteger(market.totalMatched)} €)`,
    );
    lines.push(
      `${"SharpX".padEnd(22)}${home.padEnd(10)}${draw.padEnd(10)}${away}`,
    );
    const tippmixEvent = findTippmixProEvent(
      market,
      timeCandidates(tippmixTimeIndex, market.marketStartTime),
    );
    if (tippmixEvent) {
      const hasSeparatedOdds =
        Object.hasOwn(tippmixEvent, "regularOdds") ||
        Object.hasOwn(tippmixEvent, "superOdds");
      const regularOdds = hasSeparatedOdds
        ? tippmixEvent.regularOdds
        : tippmixEvent.marketType !== "b693_ep3"
          ? tippmixEvent.odds
          : null;
      const superOdds = hasSeparatedOdds
        ? tippmixEvent.superOdds
        : tippmixEvent.marketType === "b693_ep3"
          ? tippmixEvent.odds
          : null;
      if (Array.isArray(regularOdds)) {
        const [regularHome, regularDraw, regularAway] = regularOdds.map(formatOdds);
        lines.push(
          `${"TippmixPro".padEnd(22)}${regularHome.padEnd(10)}${regularDraw.padEnd(10)}${regularAway}`,
        );
      }
      if (Array.isArray(superOdds)) {
        const [superHome, superDraw, superAway] = superOdds.map(formatOdds);
        lines.push(
          `${"TippmixPro**".padEnd(22)}${superHome.padEnd(10)}${superDraw.padEnd(10)}${superAway}`,
        );
      }
      if (Array.isArray(regularOdds) || Array.isArray(superOdds)) tippmixMatches += 1;
    }
    const vegasEvent = findTippmixProEvent(
      market,
      timeCandidates(vegasTimeIndex, market.marketStartTime),
    );
    if (Array.isArray(vegasEvent?.odds)) {
      const [vegasHome, vegasDraw, vegasAway] = vegasEvent.odds.map(formatOdds);
      lines.push(
        `${"Vegas".padEnd(22)}${vegasHome.padEnd(10)}${vegasDraw.padEnd(10)}${vegasAway}`,
      );
      vegasMatches += 1;
    }
    if (Array.isArray(vegasEvent?.enhancedOdds)) {
      const [enhancedHome, enhancedDraw, enhancedAway] =
        vegasEvent.enhancedOdds.map(formatOdds);
      lines.push(
        `${"Vegas**".padEnd(22)}${enhancedHome.padEnd(10)}${enhancedDraw.padEnd(10)}${enhancedAway}`,
      );
      vegasEnhancedMatches += 1;
    }
    lines.push("");
  }

  const content = `${lines.join("\r\n")}\r\n`.replaceAll(
    "\u00e2\u201a\u00ac",
    "\u20ac",
  );
  return { content, tippmixMatches, vegasMatches, vegasEnhancedMatches };
}

function formatBookmakerOdds(value) {
  return formatOdds(value).replace(".", ",");
}

function isLayBackSurebet(layOdds, backOdds) {
  const lay = Number(layOdds);
  const back = Number(backOdds);
  if (!Number.isFinite(lay) || !Number.isFinite(back) || lay <= 1 || back <= 1) {
    return false;
  }
  return (
    back * (1 - SHARPX_COMMISSION_RATE) >
    lay - SHARPX_COMMISSION_RATE
  );
}

function hasSurebet(layOdds, bookmakerOdds) {
  return bookmakerOdds.some((backOdds, index) =>
    isLayBackSurebet(layOdds[index], backOdds),
  );
}

function renderSurebets(snapshot, tippmixSnapshot, vegasSnapshot) {
  const lines = [
    `*** SURE BETS - ${formatTimestamp(snapshot.generatedAt)} ***`,
    "",
  ];
  const tippmixEvents = Array.isArray(tippmixSnapshot?.events)
    ? tippmixSnapshot.events
    : [];
  const vegasEvents = Array.isArray(vegasSnapshot?.events)
    ? vegasSnapshot.events
    : [];
  const tippmixTimeIndex = createEventTimeIndex(tippmixEvents);
  const vegasTimeIndex = createEventTimeIndex(vegasEvents);
  let surebetEvents = 0;

  for (const market of snapshot.markets) {
    const layOdds = orderedOneXTwo(market);
    const bookmakerRows = [];
    const tippmixEvent = findTippmixProEvent(
      market,
      timeCandidates(tippmixTimeIndex, market.marketStartTime),
    );
    if (tippmixEvent) {
      const hasSeparatedOdds =
        Object.hasOwn(tippmixEvent, "regularOdds") ||
        Object.hasOwn(tippmixEvent, "superOdds");
      const regularOdds = hasSeparatedOdds
        ? tippmixEvent.regularOdds
        : tippmixEvent.marketType !== "b693_ep3"
          ? tippmixEvent.odds
          : null;
      const superOdds = hasSeparatedOdds
        ? tippmixEvent.superOdds
        : tippmixEvent.marketType === "b693_ep3"
          ? tippmixEvent.odds
          : null;
      if (Array.isArray(regularOdds)) {
        bookmakerRows.push({ label: "Tippmix", odds: regularOdds });
      }
      if (Array.isArray(superOdds)) {
        bookmakerRows.push({ label: "Tippmix**", odds: superOdds });
      }
    }

    const vegasEvent = findTippmixProEvent(
      market,
      timeCandidates(vegasTimeIndex, market.marketStartTime),
    );
    if (Array.isArray(vegasEvent?.odds)) {
      bookmakerRows.push({ label: "Vegas", odds: vegasEvent.odds });
    }
    if (Array.isArray(vegasEvent?.enhancedOdds)) {
      bookmakerRows.push({ label: "Vegas**", odds: vegasEvent.enhancedOdds });
    }

    if (!bookmakerRows.some(row => hasSurebet(layOdds, row.odds))) continue;
    surebetEvents += 1;
    const livePrefix = market.inPlay ? "** " : "";
    lines.push(
      `${livePrefix}${displayEventName(market.eventName)} / ` +
        `${market.competitionName}    (${formatInteger(market.totalMatched)} €)`,
    );
    const [layHome, layDraw, layAway] = layOdds.map(formatOdds);
    lines.push(
      `${"SharpX".padEnd(20)}${layHome.padEnd(10)}${layDraw.padEnd(10)}${layAway}`,
    );
    for (const row of bookmakerRows) {
      const [home, draw, away] = row.odds.map(formatBookmakerOdds);
      lines.push(
        `${row.label.padEnd(20)}${home.padEnd(10)}${draw.padEnd(10)}${away}`,
      );
    }
    lines.push("");
  }

  return {
    content: `${lines.join("\r\n")}\r\n`,
    surebetEvents,
  };
}

function renderedBodyLines(content) {
  const lines = String(content ?? "").split("\r\n");
  // The renderers always create: header, blank line, body..., final newline.
  return lines.length >= 3 ? lines.slice(2, -1) : [];
}

function composeRenderedOutput(header, ...contents) {
  const lines = [header, ""];
  for (const content of contents) lines.push(...renderedBodyLines(content));
  return `${lines.join("\r\n")}\r\n`.replaceAll("\u00e2\u201a\u00ac", "\u20ac");
}

async function readJsonSnapshot(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function createWatchlist(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    events: snapshot.markets.map(market => {
      const teams = market.runners.filter(
        runner =>
          runner.selectionId !== 58805 &&
          !/(^|\s)draw($|\s)/i.test(runner.runnerName),
      );
      return {
        eventName: market.eventName,
        competitionName: market.competitionName,
        startTime: Number(market.marketStartTime),
        inPlay: market.inPlay === true,
        homeName: teams[0]?.runnerName ?? "",
        awayName: teams[1]?.runnerName ?? "",
      };
    }),
  };
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
  await fs.mkdir(path.dirname(CONFIG.surebetsOutputFile), { recursive: true });
  const target = await findSharpXTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  let contextId;
  let catalogueTimer;
  let outputTimer;
  let stopping = false;
  let writing = false;
  let lastOutputStatus = "";
  let recoveryPromise = null;
  let prematchCache = null;

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
          contextId = await cdp.waitForPortalContext();
          await cdp.evaluate(browserCollectorSource(), contextId);
          const result = await cdp.evaluate(browserRefreshCatalogueSource, contextId);
          console.log(
            `[catalogue] total=${result.catalogueMarkets} selected=${result.selectedMarkets} live=${result.liveMarkets}`,
          );
          return;
        } catch (error) {
          lastError = error;
          await sleep(500);
        }
      }
      throw lastError ?? new Error("A SharpX collector nem állítható helyre.");
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  const refreshCatalogue = async () => {
    try {
      if (recoveryPromise) return;
      const result = await cdp.evaluate(browserRefreshCatalogueSource, contextId);
      console.log(
        `[catalogue] total=${result.catalogueMarkets} selected=${result.selectedMarkets} live=${result.liveMarkets}`,
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
      const snapshot = await cdp.evaluate(browserGetSnapshotSource, contextId);
      await refreshTeamAliases();
      const now = Date.now();
      const liveMarkets = snapshot.markets.filter(market => market.inPlay === true);
      const needsPrematchRefresh =
        !prematchCache || now - prematchCache.updatedAt >= CONFIG.prematchRenderMs;

      // Without live events the cached prematch output is intentionally refreshed only
      // at the configured prematch cadence. Live events always get a fresh cycle.
      if (liveMarkets.length === 0 && !needsPrematchRefresh) return;

      const [tippmixSnapshot, vegasSnapshot] = await Promise.all([
        readJsonSnapshot(CONFIG.tippmixProSnapshotFile),
        readJsonSnapshot(CONFIG.vegasSnapshotFile),
      ]);

      if (needsPrematchRefresh) {
        const visiblePrematchMarkets = snapshot.markets.filter(
          market =>
            market.inPlay !== true &&
            Number(market.marketStartTime) > snapshot.generatedAt &&
            Number(market.totalMatched) >= CONFIG.prematchMinimumMatched,
        );
        const prematchMarkets = snapshot.markets.filter(
          market => market.inPlay !== true,
        );
        const summary = renderSummary(
          { ...snapshot, markets: visiblePrematchMarkets },
          tippmixSnapshot,
          vegasSnapshot,
        );
        const surebets = renderSurebets(
          { ...snapshot, markets: prematchMarkets },
          tippmixSnapshot,
          vegasSnapshot,
        );
        prematchCache = { updatedAt: now, summary, surebets };
      }

      const liveSummary = renderSummary(
        { ...snapshot, markets: liveMarkets },
        tippmixSnapshot,
        vegasSnapshot,
      );
      const liveSurebets = renderSurebets(
        { ...snapshot, markets: liveMarkets },
        tippmixSnapshot,
        vegasSnapshot,
      );
      const rendered = {
        content: composeRenderedOutput(
          `*** ${formatTimestamp(snapshot.generatedAt)} ***`,
          liveSummary.content,
          prematchCache.summary.content,
        ),
        tippmixMatches:
          liveSummary.tippmixMatches + prematchCache.summary.tippmixMatches,
        vegasMatches: liveSummary.vegasMatches + prematchCache.summary.vegasMatches,
        vegasEnhancedMatches:
          liveSummary.vegasEnhancedMatches +
          prematchCache.summary.vegasEnhancedMatches,
      };
      const surebets = {
        content: composeRenderedOutput(
          `*** SURE BETS - ${formatTimestamp(snapshot.generatedAt)} ***`,
          liveSurebets.content,
          prematchCache.surebets.content,
        ),
        surebetEvents:
          liveSurebets.surebetEvents + prematchCache.surebets.surebetEvents,
      };
      await writeAtomically(
        CONFIG.watchlistFile,
        `${JSON.stringify(createWatchlist(snapshot), null, 2)}\n`,
      );
      await writeAtomically(CONFIG.outputFile, rendered.content);
      await writeAtomically(CONFIG.surebetsOutputFile, surebets.content);
      const status =
        `${snapshot.initializedMarkets}/${snapshot.subscribedMarkets}` +
        ` SharpX, ${rendered.tippmixMatches} TippmixPro, ` +
        `${rendered.vegasMatches} Vegas, ${rendered.vegasEnhancedMatches} Vegas**, ` +
        `${surebets.surebetEvents} surebets`;
      if (status !== lastOutputStatus) {
        lastOutputStatus = status;
        console.log(`[output] ${status} markets -> ${CONFIG.outputFile}`);
      }
    } catch (error) {
      console.error(`[output] ${error.message}`);
      await recoverCollector();
    } finally {
      writing = false;
    }
  };

  await recoverCollector();

  const initializationDeadline = Date.now() + 15_000;
  while (Date.now() < initializationDeadline) {
    try {
      const snapshot = await cdp.evaluate(browserGetSnapshotSource, contextId);
      if (
        snapshot.subscribedMarkets > 0 &&
        snapshot.initializedMarkets === snapshot.subscribedMarkets
      ) {
        break;
      }
    } catch {
      await recoverCollector();
    }
    await sleep(250);
  }

  await writeOutput();

  if (CONFIG.once) {
    await stop(0);
    return;
  }

  catalogueTimer = setInterval(() => void refreshCatalogue(), CONFIG.catalogueRefreshMs);
  outputTimer = setInterval(() => void writeOutput(), CONFIG.outputIntervalMs);
}

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
