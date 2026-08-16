import { promises as fs } from "node:fs";
import dns from "node:dns";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  browserCollectorSource,
  createEventTimeIndex,
  findVegasEvent,
  refreshTeamAliases,
  timeCandidates,
} from "./vegas_odds_monitor.js";
import { numericOption, validateNamedArguments } from "./numeric_config.js";
import { acquireWriterLock, writeTextAtomically } from "./atomic_file.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Hiányzó érték: ${name}`);
  if (process.argv.indexOf(name, index + 1) >= 0) throw new Error(`Dupla CLI kapcsoló: ${name}`);
  return value;
}
const numberArgument = (name, fallback, constraints) =>
  numericOption(argument(name, fallback), name, constraints);
validateNamedArguments([
  "output-file",
  "watchlist-file",
  "output-ms",
  "matched-refresh-ms",
  "duration-hours",
]);
const CONFIG = {
  outputFile: path.resolve(argument("--output-file", path.join(PROJECT_DIR, "data", "vegas-direct-shadow", "vegas_odds_snapshot.json"))),
  watchlistFile: path.resolve(argument("--watchlist-file", path.join(PROJECT_DIR, "data", "sharpx_watchlist.json"))),
  outputMs: numberArgument("--output-ms", "1000", { integer: true, min: 100 }),
  matchedRefreshMs: numberArgument("--matched-refresh-ms", "5000", { integer: true, min: 250 }),
  durationMs: numberArgument("--duration-hours", "0", { min: 0, max: 720 }) * 3_600_000,
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const nodeHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

export function createNodeRequestTransport() {
  return (url, timeoutMs) => new Promise(resolve => {
    const startedAt = performance.now();
    const phases = {
      dnsMs: null,
      tcpMs: null,
      tlsMs: null,
      ttfbMs: null,
      bodyMs: null,
      totalMs: null,
    };
    let timedOut = false;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      phases.totalMs = Math.round(performance.now() - startedAt);
      resolve({ ...result, phases });
    };

    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      finish({ ok: false, status: 0, body: "", error: String(error?.message ?? error) });
      return;
    }

    const request = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      agent: nodeHttpsAgent,
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "OddsAggregator-direct/1.0",
      },
      lookup(hostname, options, callback) {
        const lookupStartedAt = performance.now();
        const lookupOptions = {
          family: options.family ?? 0,
          all: options.all === true,
        };
        dns.lookup(hostname, lookupOptions, (error, address, family) => {
          phases.dnsMs = Math.round(performance.now() - lookupStartedAt);
          if (options.all === true) callback(error, address);
          else callback(error, address, family);
        });
      },
    }, response => {
      phases.ttfbMs = Math.round(performance.now() - startedAt);
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", error => finish({
        ok: false,
        status: response.statusCode ?? 0,
        body: "",
        error: String(error?.message ?? error),
      }));
      response.on("end", () => {
        phases.bodyMs = Math.round(performance.now() - startedAt - (phases.ttfbMs ?? 0));
        const compressedBody = Buffer.concat(chunks);
        const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
        let body = compressedBody;
        try {
          if (encoding.includes("br")) body = brotliDecompressSync(compressedBody);
          else if (encoding.includes("gzip")) body = gunzipSync(compressedBody);
          else if (encoding.includes("deflate")) body = inflateSync(compressedBody);
        } catch (error) {
          finish({
            ok: false,
            status: response.statusCode ?? 0,
            body: "",
            error: String(error?.message ?? error),
          });
          return;
        }
        finish({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          body: body.toString("utf8"),
        });
      });
    });

    request.on("socket", socket => {
      if (request.reusedSocket === true) {
        // A keep-alive socket has no new DNS/TCP/TLS phases. Do not attach
        // listeners to it again: repeated requests would otherwise accumulate
        // listeners and produce MaxListenersExceededWarning noise.
        phases.tcpMs = 0;
        phases.tlsMs = 0;
        return;
      }
      if (!socket.connecting) return;
      socket.once("connect", () => {
        phases.tcpMs ??= Math.round(performance.now() - startedAt);
      });
      socket.once("secureConnect", () => {
        phases.tlsMs = Math.round(performance.now() - startedAt);
      });
    });
    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy(new Error("Vegas direct request timeout"));
    });
    request.on("error", error => finish({
      ok: false,
      status: 0,
      body: "",
      timedOut,
      error: String(error?.message ?? error),
    }));
    request.end();
  });
}

async function writeAtomically(file, document) {
  await writeTextAtomically(file, `${JSON.stringify(document, null, 2)}\n`);
}

export function normalizeWatchlistSnapshot(document) {
  if (Array.isArray(document?.events)) return document;

  const seen = new Set();
  const events = [];
  for (const market of document?.markets ?? []) {
    const teams = (market.runners ?? []).filter(
      runner => !/(^|\s)draw($|\s)/i.test(String(runner.runnerName ?? "")),
    );
    const startTime = Number(market.marketStartTime ?? market.startTime);
    const eventKey = String(market.eventId ?? `${market.eventName}|${startTime}`);
    if (
      seen.has(eventKey) ||
      !Number.isFinite(startTime) ||
      startTime <= 0 ||
      !teams[0]?.runnerName ||
      !teams[1]?.runnerName
    ) continue;
    seen.add(eventKey);
    events.push({
      eventName: market.eventName ?? "",
      competitionName: market.competitionName ?? "",
      startTime,
      inPlay: market.inPlay === true,
      homeName: teams[0].runnerName,
      awayName: teams[1].runnerName,
    });
  }
  return { generatedAt: document?.generatedAt ?? null, events };
}

async function readWatchlist() {
  try {
    return normalizeWatchlistSnapshot(JSON.parse(await fs.readFile(CONFIG.watchlistFile, "utf8")));
  }
  catch (error) { if (error.code === "ENOENT") return { events: [] }; throw error; }
}

function startSharedCollector() {
  // The same public REST collector implementation is used in Node; no browser
  // context, CDP endpoint, cookies, or page navigation is involved.
  new Function(`return ${browserCollectorSource()};`)();
  return globalThis.__vegasSoccerCollector;
}

async function main() {
  const writerLock = await acquireWriterLock(CONFIG.outputFile, "Vegas direct collector");
  let collector = null;
  let selectedIds = [];
  let nextMatchedRefreshAt = 0;
  let matchedRetryMs = 1_000;
  let matchedRefreshPromise = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    collector?.shutdown();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const previousNodeTransport = globalThis.__vegasNodeRequestTransport;
  globalThis.__vegasNodeRequestTransport = createNodeRequestTransport();
  try {
    collector = startSharedCollector();
    // Keep the initial enhanced refresh bounded. The matched watchlist below
    // supplies the actual priority IDs once the catalogue is available.
    collector.setPriorityEventIds([]);
    const startedAt = Date.now();
    let initializationAttempt = 0;
    while (!stopping && !collector.lastCatalogueRefreshAt) {
      try {
        await collector.refreshCatalogue();
        await collector.refreshLive();
        await collector.refreshEnhancedOdds();
      } catch (error) {
        initializationAttempt += 1;
        collector.lastError = error.message;
        const retryMs = Math.min(30_000, 1_000 * 2 ** Math.min(initializationAttempt - 1, 5));
        console.error(`[initialize] ${error.message}; retry in ${retryMs} ms`);
        await sleep(retryMs);
      }
    }
    while (!stopping && (!CONFIG.durationMs || Date.now() - startedAt < CONFIG.durationMs)) {
      if (Date.now() >= nextMatchedRefreshAt) {
        if (!matchedRefreshPromise) {
          matchedRefreshPromise = (async () => {
            try {
              await refreshTeamAliases();
              const watchlist = await readWatchlist();
              const fullSnapshot = collector.snapshot();
              const index = createEventTimeIndex(fullSnapshot.events);
              selectedIds = [...new Set((watchlist.events ?? []).map(event =>
                findVegasEvent(event, timeCandidates(index, event.startTime))?.id,
              ).filter(Number.isFinite))];
              collector.setPriorityEventIds(selectedIds);
              const result = selectedIds.length
                ? await collector.refreshEvents(selectedIds)
                : { failedBatches: 0 };
              if (result.failedBatches > 0) {
                throw new Error(
                  `GetEventsById: ${result.failedBatches} batch lekérése sikertelen`,
                );
              }
              nextMatchedRefreshAt = Date.now() + CONFIG.matchedRefreshMs;
              matchedRetryMs = 1_000;
            } catch (error) {
              collector.lastError = error.message;
              console.error(`[matched-refresh] ${error.message}`);
              nextMatchedRefreshAt = Date.now() + matchedRetryMs;
              matchedRetryMs = Math.min(CONFIG.matchedRefreshMs, matchedRetryMs * 2);
            } finally {
              matchedRefreshPromise = null;
            }
          })();
        }
      }
      const snapshot = collector.snapshot(selectedIds);
      await writeAtomically(CONFIG.outputFile, snapshot);
      await sleep(CONFIG.outputMs);
    }
  } finally {
    stop();
    if (previousNodeTransport === undefined) {
      delete globalThis.__vegasNodeRequestTransport;
    } else {
      globalThis.__vegasNodeRequestTransport = previousNodeTransport;
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await writerLock.release();
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
}
