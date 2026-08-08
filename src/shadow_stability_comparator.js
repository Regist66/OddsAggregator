import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { numericOption, validateNamedArguments } from "./numeric_config.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Hiányzó érték: --${name}`);
  if (process.argv.indexOf(`--${name}`, index + 1) >= 0) {
    throw new Error(`Dupla CLI kapcsoló: --${name}`);
  }
  return value;
}

validateNamedArguments([
  "normal-data", "headless-data", "output-dir", "normal-logs", "headless-logs",
  "shadow-live-surebets-output", "duration-hours", "interval-ms",
  "health-interval-ms", "grace-ms", "minimum-edge", "stale-snapshot-ms",
  "stale-text-ms", "once",
], process.argv.slice(2), ["once"]);
const numberArgument = (name, fallback, constraints) =>
  numericOption(argument(name, fallback), `--${name}`, constraints);

const shadowLiveSurebetsOutput = argument("shadow-live-surebets-output");

const CONFIG = {
  normalDataDir: path.resolve(argument("normal-data", path.join(PROJECT_DIR, "data"))),
  headlessDataDir: path.resolve(argument("headless-data", path.join(PROJECT_DIR, "data", "shadow-headless"))),
  outputDir: path.resolve(argument("output-dir", path.join(PROJECT_DIR, "logs", "shadow-stability"))),
  normalLogsDir: path.resolve(argument("normal-logs", path.join(PROJECT_DIR, "logs"))),
  headlessLogsDir: path.resolve(argument("headless-logs", path.join(PROJECT_DIR, "logs", "shadow-headless"))),
  shadowLiveSurebetsFile: shadowLiveSurebetsOutput
    ? path.resolve(shadowLiveSurebetsOutput)
    : null,
  durationMs: numberArgument("duration-hours", "24", { min: 0, max: 168 }) * 60 * 60 * 1_000,
  intervalMs: numberArgument("interval-ms", "1000", { integer: true, min: 100 }),
  healthIntervalMs: numberArgument("health-interval-ms", "5000", { integer: true, min: 100 }),
  graceMs: numberArgument("grace-ms", "30000", { integer: true, min: 0 }),
  minimumEdge: numberArgument("minimum-edge", "0.005", { min: 0, max: 1 }),
  staleSnapshotMs: numberArgument("stale-snapshot-ms", "5000", { integer: true, min: 100 }),
  staleTextMs: numberArgument("stale-text-ms", "6000", { integer: true, min: 100 }),
  once: process.argv.includes("--once"),
};

const OUTPUTS = {
  combined: { relativePath: "combined_odds.txt", kind: "text" },
  surebets: { relativePath: path.join("football", "surebets_live_odds.txt"), kind: "surebets" },
  sharpxStatus: { relativePath: "sharpx_status_snapshot.json", kind: "status", requiredFresh: false },
  tippmix: { relativePath: "tippmixpro_odds_snapshot.json", kind: "snapshot" },
  vegas: { relativePath: "vegas_odds_snapshot.json", kind: "snapshot" },
};
const COMMISSION = 0.0295;
const OUTCOMES = ["1", "X", "2"];

const state = {
  startedAt: Date.now(),
  readyAt: null,
  stopped: false,
  timer: null,
  lastHealthAt: 0,
  candidates: new Map(),
  stale: new Map(),
  snapshotMismatch: new Map(),
  errorLogSizes: new Map(),
  stats: {
    samples: 0,
    readySamples: 0,
    normalOnlySurebetEpisodes: 0,
    headlessOnlySurebetEpisodes: 0,
    recoveredSurebets: 0,
    snapshotMismatchEpisodes: 0,
    staleEpisodes: 0,
    errorLogGrowthEvents: 0,
    detectionDelaysMs: [],
    significantDisagreements: [],
  },
  evidenceSequence: 0,
};

const files = {
  health: path.join(CONFIG.outputDir, "health.jsonl"),
  events: path.join(CONFIG.outputDir, "events.jsonl"),
  summary: path.join(CONFIG.outputDir, "summary.json"),
  report: path.join(CONFIG.outputDir, "report.md"),
  evidence: path.join(CONFIG.outputDir, "evidence"),
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numberValues(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .map(value => Number(value.replace(",", ".")))
    .filter(Number.isFinite);
}

function parseSurebets(text) {
  const candidates = new Map();
  const lines = String(text ?? "").split(/\r?\n/);
  let current = null;
  const blocks = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.startsWith("***")) continue;
    const marketRow = line.match(/^(SharpX|TippmixPro\*\*|TippmixPro|Tippmix\*\*|Tippmix|Vegas\*\*|Vegas)\s+(.+)$/);
    if (marketRow && current) {
      current.rows.set(marketRow[1], numberValues(marketRow[2]));
      continue;
    }
    const eventName = line.replace(/^\*\*\s*/, "").replace(/\s+\([^()]*\)\s*$/, "").trim();
    if (eventName) {
      current = { eventName, rows: new Map() };
      blocks.push(current);
    }
  }
  for (const block of blocks) {
    const lay = block.rows.get("SharpX");
    if (!lay || lay.length < 3) continue;
    for (const [bookmaker, back] of block.rows) {
      if (bookmaker === "SharpX" || back.length < 3) continue;
      for (let index = 0; index < 3; index += 1) {
        if (back[index] * (1 - COMMISSION) <= lay[index] - COMMISSION) continue;
        const key = `${normalize(block.eventName)}|${normalize(bookmaker)}|${OUTCOMES[index]}`;
        candidates.set(key, {
          eventName: block.eventName,
          bookmaker,
          outcome: OUTCOMES[index],
          backOdds: back[index],
          layOdds: lay[index],
          edge: back[index] * (1 - COMMISSION) / (lay[index] - COMMISSION) - 1,
        });
      }
    }
  }
  return candidates;
}

async function readOutput(root, descriptor) {
  const filename = path.join(root, descriptor.relativePath);
  try {
    const [stats, text] = await Promise.all([fs.stat(filename), fs.readFile(filename, "utf8")]);
    const ageMs = Math.max(0, Date.now() - stats.mtimeMs);
    if (descriptor.kind === "snapshot" || descriptor.kind === "status") {
      const document = JSON.parse(text);
      return {
        filename,
        ageMs,
        ok: true,
        eventCount: Array.isArray(document.events) ? document.events.length : 0,
        events: Array.isArray(document.events) ? document.events : [],
        markets: Array.isArray(document.markets) ? document.markets : [],
        generatedAt: Number(document.generatedAt) || null,
      };
    }
    return {
      filename,
      ageMs,
      ok: true,
      candidates: descriptor.kind === "surebets" ? parseSurebets(text) : undefined,
      text: descriptor.kind === "surebets" ? text : undefined,
    };
  } catch (error) {
    return { filename, ageMs: Number.POSITIVE_INFINITY, ok: false, error: error.message };
  }
}

async function appendJsonLine(filename, value) {
  await fs.appendFile(filename, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeAtomically(filename, content) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporaryFile = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, content, "utf8");
  try {
    await fs.rename(temporaryFile, filename);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    await fs.rm(filename, { force: true });
    await fs.rename(temporaryFile, filename);
  }
}

async function mirrorHeadlessSurebets(output) {
  if (!CONFIG.shadowLiveSurebetsFile || !output.ok || typeof output.text !== "string") return;
  try {
    await writeAtomically(CONFIG.shadowLiveSurebetsFile, output.text);
  } catch (error) {
    await logEvent("shadow_surebets_mirror_error", {
      file: CONFIG.shadowLiveSurebetsFile,
      message: error.message,
    });
  }
}

async function logEvent(type, details = {}) {
  await appendJsonLine(files.events, { at: new Date().toISOString(), type, ...details });
}

function outputStale(name, output) {
  if (OUTPUTS[name].kind === "status") return !output.ok;
  const threshold = OUTPUTS[name].kind === "snapshot" ? CONFIG.staleSnapshotMs : CONFIG.staleTextMs;
  return !output.ok || output.ageMs > threshold;
}

async function trackStaleness(side, outputs) {
  for (const [name, output] of Object.entries(outputs)) {
    const key = `${side}:${name}`;
    const stale = outputStale(name, output);
    const previous = state.stale.get(key) === true;
    if (stale && !previous) {
      state.stale.set(key, true);
      state.stats.staleEpisodes += 1;
      await logEvent("output_stale", { side, output: name, ageMs: output.ageMs, error: output.error ?? null });
    } else if (!stale && previous) {
      state.stale.set(key, false);
      await logEvent("output_recovered", { side, output: name, ageMs: output.ageMs });
    }
  }
}

async function trackSnapshotCounts(normal, headless) {
  for (const name of ["tippmix", "vegas"]) {
    const key = `snapshot:${name}`;
    const comparable = normal[name].ok && headless[name].ok;
    const mismatch = comparable && normal[name].eventCount !== headless[name].eventCount;
    const previous = state.snapshotMismatch.get(key);
    if (mismatch && !previous?.active) {
      state.snapshotMismatch.set(key, { active: true, startedAt: Date.now(), reported: false });
    }
    const current = state.snapshotMismatch.get(key);
    if (mismatch && current && !current.reported && Date.now() - current.startedAt >= 30_000) {
      current.reported = true;
      state.stats.snapshotMismatchEpisodes += 1;
      await logEvent("snapshot_count_mismatch", {
        source: name,
        normalEvents: normal[name].eventCount,
        headlessEvents: headless[name].eventCount,
      });
    }
    if (!mismatch && current?.active) {
      state.snapshotMismatch.delete(key);
      if (current.reported) await logEvent("snapshot_count_recovered", { source: name });
    }
  }
}

function eventIdentity(value) {
  return normalize(String(value ?? "").split("/")[0]);
}

function eventTokens(value) {
  return new Set(eventIdentity(value).split(" ").filter(Boolean));
}

function eventSimilarity(left, right) {
  const leftTokens = eventTokens(left);
  const rightTokens = eventTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common += 1;
  return common / Math.max(leftTokens.size, rightTokens.size);
}

function findEventStatus(output, eventName) {
  const entries = output.markets?.length ? output.markets : output.events ?? [];
  let best = null;
  for (const event of entries) {
    const candidateName = event.eventName ?? `${event.homeName ?? ""} - ${event.awayName ?? ""}`;
    const similarity = eventSimilarity(eventName, candidateName);
    if (!best || similarity > best.similarity) best = { event, similarity };
  }
  if (!best || best.similarity < 0.5) return null;
  const { event } = best;
  return {
    matchedName: event.eventName ?? `${event.homeName ?? ""} - ${event.awayName ?? ""}`,
    matchScore: Number(best.similarity.toFixed(3)),
    inPlay: event.inPlay ?? event.live ?? null,
    status: event.status ?? event.statusId ?? null,
    statusName: event.statusName ?? null,
    score: event.score ?? null,
    homeScore: event.homeScore ?? null,
    awayScore: event.awayScore ?? null,
    period: event.period ?? null,
    minute: event.minute ?? null,
    redCards: event.redCards ?? null,
    startTime: event.startTime ?? null,
    updatedAt: event.updatedAt ?? event.lastChangedTime ?? event.receivedAt ?? null,
    odds: Array.isArray(event.odds) ? event.odds : null,
    oneXTwoLayOdds: Array.isArray(event.oneXTwoLayOdds) ? event.oneXTwoLayOdds : null,
    oddsUpdatedAt: event.oddsUpdatedAt ?? event.receivedAt ?? event.updatedAt ?? event.lastChangedTime ?? null,
  };
}

function statusSignature(status) {
  if (!status) return "missing";
  return JSON.stringify({
    inPlay: status.inPlay,
    status: status.status,
    statusName: status.statusName,
    score: status.score,
    homeScore: status.homeScore,
    awayScore: status.awayScore,
    period: status.period,
    minute: status.minute,
    redCards: status.redCards,
  });
}

function bookmakerOutput(outputs, bookmaker) {
  return normalize(bookmaker).startsWith("vegas") ? outputs.vegas : outputs.tippmix;
}

function captureSide(outputs, lookupCandidate, visibleCandidate) {
  const bookmaker = lookupCandidate ? bookmakerOutput(outputs, lookupCandidate.bookmaker) : null;
  const sharpXStatus = lookupCandidate
    ? findEventStatus(outputs.sharpxStatus, lookupCandidate.eventName)
    : null;
  return {
    surebetPresent: Boolean(visibleCandidate),
    statusLookupEvent: lookupCandidate?.eventName ?? null,
    outputAgesMs: Object.fromEntries(
      Object.entries(outputs).map(([name, output]) => [name, output.ageMs]),
    ),
    sharpXStatus,
    sharpXQuote: sharpXStatus
      ? {
          matchedName: sharpXStatus.matchedName,
          matchScore: sharpXStatus.matchScore,
          oneXTwoLayOdds: sharpXStatus.oneXTwoLayOdds,
          oddsUpdatedAt: sharpXStatus.oddsUpdatedAt,
          statusSnapshotGeneratedAt: outputs.sharpxStatus.generatedAt ?? null,
        }
      : null,
    bookmakerStatus: lookupCandidate && bookmaker ? findEventStatus(bookmaker, lookupCandidate.eventName) : null,
    candidate: visibleCandidate ?? null,
  };
}

function classifyDisagreement(normal, headless) {
  const stale = [...Object.values(normal.outputAgesMs), ...Object.values(headless.outputAgesMs)]
    .some(ageMs => !Number.isFinite(ageMs) || ageMs > CONFIG.staleTextMs);
  if (stale) return "stale_input";
  if (statusSignature(normal.bookmakerStatus) !== statusSignature(headless.bookmakerStatus) ||
      statusSignature(normal.sharpXStatus) !== statusSignature(headless.sharpXStatus)) {
    return "status_transition_or_source_state_divergence";
  }
  return "fresh_quote_or_pairing_divergence";
}

async function recordDisagreement(side, key, visibleForMs, normalOutputs, headlessOutputs, normalCandidate, headlessCandidate) {
  const candidate = side === "normal" ? normalCandidate : headlessCandidate;
  if (!candidate || candidate.edge < CONFIG.minimumEdge) return null;
  // The shared lookup candidate lets us compare event state on both stacks,
  // while `candidate: null` truthfully records that the surebet was absent.
  const lookupCandidate = normalCandidate ?? headlessCandidate;
  const normal = captureSide(normalOutputs, lookupCandidate, normalCandidate);
  const headless = captureSide(headlessOutputs, lookupCandidate, headlessCandidate);
  const classification = classifyDisagreement(normal, headless);
  const evidence = {
    id: ++state.evidenceSequence,
    at: new Date().toISOString(),
    side,
    missingFrom: side === "normal" ? "headless" : "normal",
    key,
    visibleForMs,
    minimumEdge: CONFIG.minimumEdge,
    classification,
    normal,
    headless,
  };
  const filename = path.join(files.evidence, `${String(evidence.id).padStart(5, "0")}-${side}.json`);
  await fs.writeFile(filename, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  state.stats.significantDisagreements.push({
    id: evidence.id,
    side,
    key,
    edge: candidate.edge,
    classification,
    visibleForMs,
    file: path.basename(filename),
  });
  return { ...evidence, file: path.basename(filename) };
}

async function trackSurebets(normalCandidates, headlessCandidates, normalOutputs, headlessOutputs) {
  const keys = new Set([...normalCandidates.keys(), ...headlessCandidates.keys(), ...state.candidates.keys()]);
  const now = Date.now();
  for (const key of keys) {
    const normal = normalCandidates.get(key);
    const headless = headlessCandidates.get(key);
    let item = state.candidates.get(key);
    if (!item) {
      item = { normalSince: null, headlessSince: null, normalOnlyReported: false, headlessOnlyReported: false, matchedReported: false };
      state.candidates.set(key, item);
    }
    if (normal) {
      if (item.normalSince === null) item.normalSince = now;
      item.normalEvidence = normal;
    } else {
      item.normalSince = null;
      item.normalOnlyReported = false;
      item.matchedReported = false;
    }
    if (headless) {
      if (item.headlessSince === null) item.headlessSince = now;
      item.headlessEvidence = headless;
    } else {
      item.headlessSince = null;
      item.headlessOnlyReported = false;
      item.matchedReported = false;
    }
    if (normal && headless && !item.matchedReported) {
      item.matchedReported = true;
      const delayMs = Math.abs(item.normalSince - item.headlessSince);
      state.stats.detectionDelaysMs.push(delayMs);
      if (item.normalOnlyReported || item.headlessOnlyReported) {
        state.stats.recoveredSurebets += 1;
        await logEvent("surebet_recovered", { key, delayMs, normal, headless, evidenceFile: item.evidenceFile ?? null });
      } else {
        await logEvent("surebet_matched", { key, delayMs, normal, headless });
      }
      item.normalOnlyReported = false;
      item.headlessOnlyReported = false;
      item.evidenceFile = null;
    }
    if (normal && !headless && now - item.normalSince >= CONFIG.graceMs && !item.normalOnlyReported) {
      item.normalOnlyReported = true;
      state.stats.normalOnlySurebetEpisodes += 1;
      const evidence = await recordDisagreement(
        "normal",
        key,
        now - item.normalSince,
        normalOutputs,
        headlessOutputs,
        normal,
        null,
      );
      item.evidenceFile = evidence?.file ?? null;
      await logEvent("surebet_normal_only", {
        key,
        visibleForMs: now - item.normalSince,
        normal,
        evidenceFile: item.evidenceFile,
      });
    }
    if (headless && !normal && now - item.headlessSince >= CONFIG.graceMs && !item.headlessOnlyReported) {
      item.headlessOnlyReported = true;
      state.stats.headlessOnlySurebetEpisodes += 1;
      const evidence = await recordDisagreement(
        "headless",
        key,
        now - item.headlessSince,
        normalOutputs,
        headlessOutputs,
        null,
        headless,
      );
      item.evidenceFile = evidence?.file ?? null;
      await logEvent("surebet_headless_only", {
        key,
        visibleForMs: now - item.headlessSince,
        headless,
        evidenceFile: item.evidenceFile,
      });
    }
    if (!normal && !headless) state.candidates.delete(key);
  }
}

async function trackErrorLogs() {
  for (const [side, directory] of [["normal", CONFIG.normalLogsDir], ["headless", CONFIG.headlessLogsDir]]) {
    let entries = [];
    try { entries = await fs.readdir(directory); } catch { continue; }
    for (const name of entries.filter(value => value.endsWith(".error.log"))) {
      const filename = path.join(directory, name);
      const key = `${side}:${name}`;
      try {
        const size = (await fs.stat(filename)).size;
        const previous = state.errorLogSizes.get(key);
        if (previous !== undefined && size > previous) {
          state.stats.errorLogGrowthEvents += 1;
          await logEvent("error_log_grew", { side, file: name, addedBytes: size - previous });
        }
        state.errorLogSizes.set(key, size);
      } catch {
        // A log forgatása vagy átmeneti hiánya nem önálló hiba.
      }
    }
  }
}

async function sample() {
  const [normalEntries, headlessEntries] = await Promise.all([
    Promise.all(Object.entries(OUTPUTS).map(async ([name, descriptor]) => [name, await readOutput(CONFIG.normalDataDir, descriptor)])),
    Promise.all(Object.entries(OUTPUTS).map(async ([name, descriptor]) => [name, await readOutput(CONFIG.headlessDataDir, descriptor)])),
  ]);
  const normal = Object.fromEntries(normalEntries);
  const headless = Object.fromEntries(headlessEntries);
  state.stats.samples += 1;
  await mirrorHeadlessSurebets(headless.surebets);
  const requiredOutputs = Object.entries(OUTPUTS)
    .filter(([, descriptor]) => descriptor.requiredFresh !== false)
    .map(([name]) => name);
  const ready = [...requiredOutputs]
    .every(name => normal[name].ok && headless[name].ok && normal[name].ageMs < 10_000 && headless[name].ageMs < 10_000);
  if (ready && state.readyAt === null) {
    state.readyAt = Date.now();
    await logEvent("comparison_ready");
  }
  if (state.readyAt !== null) {
    state.stats.readySamples += 1;
    await trackStaleness("normal", normal);
    await trackStaleness("headless", headless);
    await trackSnapshotCounts(normal, headless);
    await trackSurebets(
      normal.surebets.candidates ?? new Map(),
      headless.surebets.candidates ?? new Map(),
      normal,
      headless,
    );
    await trackErrorLogs();
  }
  const now = Date.now();
  if (now - state.lastHealthAt >= CONFIG.healthIntervalMs) {
    state.lastHealthAt = now;
    await appendJsonLine(files.health, {
      at: new Date().toISOString(),
      ready,
      normal: Object.fromEntries(Object.entries(normal).map(([name, output]) => [name, { ageMs: output.ageMs, ok: output.ok, eventCount: output.eventCount ?? null, surebetCount: output.candidates?.size ?? null }])),
      headless: Object.fromEntries(Object.entries(headless).map(([name, output]) => [name, { ageMs: output.ageMs, ok: output.ok, eventCount: output.eventCount ?? null, surebetCount: output.candidates?.size ?? null }])),
    });
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

async function writeSummary() {
  const endedAt = Date.now();
  const { detectionDelaysMs, significantDisagreements, ...counts } = state.stats;
  const summary = {
    startedAt: new Date(state.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds: Math.round((endedAt - state.startedAt) / 1000),
    comparisonReadyAt: state.readyAt ? new Date(state.readyAt).toISOString() : null,
    ...counts,
    detectionDelayCount: detectionDelaysMs.length,
    medianDetectionDelayMs: median(detectionDelaysMs),
    p95DetectionDelayMs: percentile(detectionDelaysMs, 0.95),
    significantDisagreementCount: significantDisagreements.length,
    topDisagreements: [...significantDisagreements]
      .sort((left, right) => right.edge - left.edge)
      .slice(0, 30),
    config: {
      graceMs: CONFIG.graceMs,
      minimumEdge: CONFIG.minimumEdge,
      staleSnapshotMs: CONFIG.staleSnapshotMs,
      staleTextMs: CONFIG.staleTextMs,
    },
  };
  await fs.writeFile(files.summary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const report = [
    "# Headless shadow stabilitási riport",
    "",
    `- Futás: ${summary.startedAt} – ${summary.endedAt} (${summary.durationSeconds} mp)`,
    `- Értékelhető minták: ${summary.readySamples}/${summary.samples}`,
    `- Kimeneti elakadások: ${summary.staleEpisodes}`,
    `- Hibatároló-növekedések: ${summary.errorLogGrowthEvents}`,
    `- Tartós normál-only surebetek: ${summary.normalOnlySurebetEpisodes}`,
    `- Tartós headless-only surebetek: ${summary.headlessOnlySurebetEpisodes}`,
    `- Helyreállt surebet-eltérések: ${summary.recoveredSurebets}`,
    `- Snapshot darabszám-eltérések: ${summary.snapshotMismatchEpisodes}`,
    `- Medián felismerési eltérés: ${summary.medianDetectionDelayMs === null ? "nincs közös surebet" : `${summary.medianDetectionDelayMs} ms`}`,
    "",
    `A tartós eltérés legalább ${CONFIG.graceMs / 1000} másodpercig csak az egyik stackben jelen lévő, azonos esemény/bookmaker/kimenet surebet. Az evidence fájlban a \`surebetPresent\` és a \`missingFrom\` jelöli egyértelműen, melyik oldalon hiányzott.`,
  ].join("\n");
  await fs.writeFile(files.report, `${report}\n`, "utf8");
}

async function stop(exitCode = 0) {
  if (state.stopped) return;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  try { await writeSummary(); } catch (error) { console.error(`[summary] ${error.message}`); exitCode = 1; }
  // A duration lejártakor a folyamatnak ténylegesen ki kell lépnie, különben
  // a PowerShell runner `finally` blokkja nem fut le, és a shadow stack életben marad.
  process.exit(exitCode);
}

async function main() {
  await Promise.all([
    fs.mkdir(CONFIG.outputDir, { recursive: true }),
    fs.mkdir(files.evidence, { recursive: true }),
  ]);
  await logEvent("comparator_started", { config: CONFIG });
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  const deadline = Date.now() + CONFIG.durationMs;
  while (!state.stopped && Date.now() < deadline) {
    try { await sample(); } catch (error) { await logEvent("comparator_sample_error", { message: error.message }); }
    if (CONFIG.once) break;
    await sleep(CONFIG.intervalMs);
  }
  await stop(0);
}

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
