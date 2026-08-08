import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeTextAtomically } from "./atomic_file.js";
import { numericOption, validateNamedArguments } from "./numeric_config.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Hiányzó érték: ${name}`);
  if (process.argv.indexOf(name, index + 1) >= 0) throw new Error(`Dupla CLI kapcsoló: ${name}`);
  return value;
}

validateNamedArguments([
  "catalogue-url", "websocket-base", "report-file", "timeout-ms", "sample-markets",
]);
const numberArgument = (name, fallback, constraints) =>
  numericOption(argument(name, fallback), name, constraints);

const CONFIG = {
  catalogueUrl: argument(
    "--catalogue-url",
    "https://portal.sharpxch.com/customer/api/sport/details?page=0",
  ),
  websocketBase: argument(
    "--websocket-base",
    "wss://portal.sharpxch.com/customer/ws/multiple-market-prices",
  ),
  reportFile: path.resolve(
    argument("--report-file", path.join(PROJECT_DIR, "logs", "sharpx-direct-probe", "latest.json")),
  ),
  timeoutMs: numberArgument("--timeout-ms", "15000", { integer: true, min: 100, max: 120_000 }),
  sampleMarkets: numberArgument("--sample-markets", "3", { integer: true, min: 1, max: 3 }),
};

const requestBody = {
  id: "1",
  timeFilter: "ALL",
  viewBy: "POPULARITY",
  contextFilter: "EVENT_TYPE",
};

function timestamp() {
  return new Date().toISOString();
}

function withTimeout(task, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${description}: időtúllépés`)),
      CONFIG.timeoutMs,
    );
    task.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchCatalogue() {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const response = await fetch(CONFIG.catalogueUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const result = {
      ok: response.ok,
      status: response.status,
      contentType,
      finalUrl: response.url,
      elapsedMs: Date.now() - startedAt,
      bodyBytes: Buffer.byteLength(body),
    };
    if (!response.ok) {
      result.bodyPreview = body.slice(0, 500);
      throw Object.assign(new Error(`Katalógus HTTP ${response.status}`), { result });
    }
    try {
      result.payload = JSON.parse(body);
    } catch {
      result.bodyPreview = body.slice(0, 500);
      throw Object.assign(new Error("A katalógus válasza nem JSON."), { result });
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function selectMarkets(payload) {
  const content = payload?.marketCatalogueList?.content;
  if (!Array.isArray(content)) {
    throw new Error("A katalógus válaszából hiányzik a marketCatalogueList.content tömb.");
  }
  return content
    .filter(market => market?.description?.marketType === "MATCH_ODDS")
    .filter(market => market?.marketId && market?.event?.id)
    .filter(market => market.inPlay === true || Number(market.marketStartTime) > Date.now())
    .slice(0, CONFIG.sampleMarkets)
    .map(market => ({
      marketId: market.marketId,
      eventId: market.event.id,
      eventName: market.event.name ?? "",
      inPlay: market.inPlay === true,
    }));
}

async function receivePrices(markets) {
  const serverId = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  const sessionId = crypto.randomUUID();
  const url = `${CONFIG.websocketBase}/${serverId}/${sessionId}/websocket`;

  return withTimeout(new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let opened = false;
    let frames = 0;
    let updateCount = 0;
    let firstUpdate = null;

    const finish = value => {
      settled = true;
      try { socket.close(); } catch {}
      resolve({ url, opened, frames, updateCount, firstUpdate, ...value });
    };

    socket.addEventListener("error", () => reject(new Error("SharpX WebSocket kapcsolat hiba.")), { once: true });
    socket.addEventListener("message", event => {
      const raw = String(event.data);
      frames += 1;
      if (raw === "o") {
        opened = true;
        socket.send(JSON.stringify([
          JSON.stringify(markets.map(market => ({
            marketId: market.marketId,
            eventId: market.eventId,
            applicationType: "WEB",
          }))),
        ]));
        return;
      }
      if (raw === "h" || !raw.startsWith("a")) return;

      try {
        for (const encoded of JSON.parse(raw.slice(1))) {
          const decoded = JSON.parse(encoded);
          const updates = Array.isArray(decoded) ? decoded : [decoded];
          updateCount += updates.length;
          if (!firstUpdate) {
            const update = updates[0] ?? {};
            firstUpdate = {
              marketId: update.id ?? null,
              apiPt: update.apiPt ?? null,
              hasMarketDefinition: Boolean(update.marketDefinition),
              runnerCount: Array.isArray(update.rc) ? update.rc.length : 0,
            };
          }
        }
        if (updateCount > 0) finish({ receivedPriceUpdate: true });
      } catch (error) {
        reject(new Error(`SharpX WebSocket üzenet feldolgozási hiba: ${error.message}`));
      }
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        reject(new Error(
          opened
            ? "SharpX WebSocket az első árfrissítés előtt bezárult."
            : "SharpX WebSocket a SockJS nyitókeret előtt bezárult.",
        ));
      }
    }, { once: true });
  }), "SharpX WebSocket próba");
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(CONFIG.reportFile), { recursive: true });
  await writeTextAtomically(CONFIG.reportFile, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const report = {
    startedAt: timestamp(),
    mode: "public-direct-node-probe",
    configuration: {
      catalogueUrl: CONFIG.catalogueUrl,
      websocketBase: CONFIG.websocketBase,
      timeoutMs: CONFIG.timeoutMs,
      sampleMarkets: CONFIG.sampleMarkets,
    },
    catalogue: null,
    websocket: null,
    result: "failed",
    error: null,
  };

  try {
    const catalogueResult = await fetchCatalogue();
    const markets = selectMarkets(catalogueResult.payload);
    report.catalogue = {
      ok: catalogueResult.ok,
      status: catalogueResult.status,
      contentType: catalogueResult.contentType,
      finalUrl: catalogueResult.finalUrl,
      elapsedMs: catalogueResult.elapsedMs,
      bodyBytes: catalogueResult.bodyBytes,
      totalPages: catalogueResult.payload.marketCatalogueList?.totalPages ?? null,
      firstPageMarkets: catalogueResult.payload.marketCatalogueList?.content?.length ?? null,
      selectedMarkets: markets,
    };
    if (markets.length === 0) throw new Error("A közvetlen katalógusban nincs választható MATCH_ODDS piac.");

    report.websocket = await receivePrices(markets);
    report.result = report.websocket.receivedPriceUpdate ? "success" : "no-price-update";
  } catch (error) {
    if (error.result) report.catalogue = { ...report.catalogue, ...error.result };
    report.error = error.message;
  } finally {
    report.finishedAt = timestamp();
    await writeReport(report);
  }

  console.log(JSON.stringify({
    result: report.result,
    reportFile: CONFIG.reportFile,
    catalogue: report.catalogue ? {
      status: report.catalogue.status,
      totalPages: report.catalogue.totalPages,
      selectedMarkets: report.catalogue.selectedMarkets?.length,
    } : null,
    websocket: report.websocket ? {
      opened: report.websocket.opened,
      receivedPriceUpdate: report.websocket.receivedPriceUpdate,
      updateCount: report.websocket.updateCount,
    } : null,
    error: report.error,
  }));
  process.exitCode = report.result === "success" ? 0 : 1;
}

main().catch(async error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
