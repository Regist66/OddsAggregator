import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { browserCollectorSource } from "./tippmixpro_odds_monitor.js";
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
validateNamedArguments(["output-file", "output-ms", "catalogue-ms", "duration-hours"]);
const CONFIG = {
  outputFile: path.resolve(argument("--output-file", path.join(PROJECT_DIR, "data", "tippmixpro-direct-shadow", "tippmixpro_odds_snapshot.json"))),
  outputMs: numberArgument("--output-ms", "1000", { integer: true, min: 100 }),
  catalogueMs: numberArgument("--catalogue-ms", "300000", { integer: true, min: 1_000 }),
  durationMs: numberArgument("--duration-hours", "0", { min: 0, max: 720 }) * 3_600_000,
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function writeAtomically(file, document) {
  await writeTextAtomically(file, `${JSON.stringify(document, null, 2)}\n`);
}

function startSharedCollector() {
  // This is the existing public WAMP protocol collector, evaluated directly
  // in Node instead of the TippmixPro iframe.
  new Function(`return ${browserCollectorSource()};`)();
  return globalThis.__tippmixProMatchOddsCollector;
}

async function main() {
  const writerLock = await acquireWriterLock(CONFIG.outputFile, "TippmixPro direct collector");
  let collector = null;
  let nextCatalogueRefreshAt = 0;
  let stopping = false;
  const stop = () => {
    stopping = true;
    collector?.shutdown();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    collector = startSharedCollector();
    const startedAt = Date.now();
    while (!stopping && (!CONFIG.durationMs || Date.now() - startedAt < CONFIG.durationMs)) {
      if (Date.now() >= nextCatalogueRefreshAt) {
        try {
          const result = await collector.refreshCatalogue();
          console.log(`[catalogue] tournaments=${result.tournamentIds} topics=${result.subscribedTopics}`);
          nextCatalogueRefreshAt = Date.now() + CONFIG.catalogueMs;
        } catch (error) {
          collector.lastError = error.message;
          console.error(`[catalogue] ${error.message}`);
          nextCatalogueRefreshAt = Date.now() + 5_000;
        }
      }
      const snapshot = collector.getSnapshot();
      if (snapshot.events.length || snapshot.pendingWork === 0) await writeAtomically(CONFIG.outputFile, snapshot);
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
