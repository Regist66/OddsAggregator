import { promises as fs } from "node:fs";
import process from "node:process";

const [kind, filename] = process.argv.slice(2);
const maxAgeMs = Number(process.env.DIRECT_OUTPUT_STALE_MS ?? 120_000);
const futureToleranceMs = Number(process.env.DIRECT_OUTPUT_FUTURE_TOLERANCE_MS ?? 5_000);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!kind || !filename || !Number.isFinite(maxAgeMs) || maxAgeMs < 1 ||
    !Number.isFinite(futureToleranceMs) || futureToleranceMs < 0) {
  fail("Használat: direct-healthcheck.mjs <sharpx|tippmixpro|vegas|primary> <json-file>");
}

let stats;
let document;
try {
  stats = await fs.stat(filename);
  document = JSON.parse(await fs.readFile(filename, "utf8"));
} catch (error) {
  fail(`${filename} nem olvasható: ${error.message}`);
}

const now = Date.now();
const fileAgeMs = now - stats.mtimeMs;
if (fileAgeMs < 0 || fileAgeMs > maxAgeMs) {
  fail(`${filename} stale: file=${Math.round(fileAgeMs / 1000)}s`);
}

function requireFreshTimestamp(value, label) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    fail(`${filename} ${label} timestamp missing`);
  }
  const ageMs = now - timestamp;
  if (ageMs < -futureToleranceMs || ageMs > maxAgeMs) {
    fail(`${filename} ${label} stale: ${Math.round(ageMs / 1000)}s`);
  }
}

if (!document || typeof document !== "object" || Array.isArray(document)) {
  fail(`${filename} JSON objectet vár`);
}

if (kind === "sharpx") {
  requireFreshTimestamp(document.generatedAt, "generatedAt");
  if (!Array.isArray(document.markets)) fail(`${filename} markets tömb hiányzik`);
  const subscribed = Number(document.subscribedMarkets);
  const initialized = Number(document.initializedMarkets);
  if (!Number.isInteger(subscribed) || subscribed <= 0 ||
      !Number.isInteger(initialized) || initialized < 0 || initialized > subscribed) {
    fail(`${filename} invalid market coverage`);
  }
} else if (kind === "tippmixpro" || kind === "vegas") {
  requireFreshTimestamp(document.generatedAt, "generatedAt");
  if (!Array.isArray(document.events)) fail(`${filename} events tömb hiányzik`);
} else if (kind === "primary") {
  requireFreshTimestamp(document.generatedAt, "generatedAt");
  if (!document.sources || typeof document.sources !== "object" || Array.isArray(document.sources)) {
    fail(`${filename} sources blokk hiányzik`);
  }
  for (const source of ["sharpx", "tippmixpro", "vegas"]) {
    const item = document.sources[source];
    if (!item || item.ok !== true || item.state !== "fresh") {
      fail(`${filename} ${source} nem fresh: ${item?.state ?? "missing"}`);
    }
  }
} else {
  fail(`Ismeretlen healthcheck típus: ${kind}`);
}

console.log(`${kind} healthy: ${filename}`);
