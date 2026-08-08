import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareSnapshots,
  createStats,
  eventId,
  main,
  recordSample,
  sideHealth,
  summarizedStats,
} from "../src/provider_direct_shadow_comparator.js";

const NOW = 1_800_000_000_000;

function policy(provider, overrides = {}) {
  return {
    provider,
    maxContentAgeMs: 5_000,
    catalogueMaxAgeMs: 660_000,
    tippmixFrameMaxAgeMs: 15_000,
    vegasLiveMaxAgeMs: 5_000,
    vegasEnhancedMaxAgeMs: 15_000,
    ...overrides,
  };
}

function tippmixEvent(overrides = {}) {
  return {
    eventId: "tm-1",
    startTime: NOW + 3_600_000,
    inPlay: false,
    statusId: "1",
    statusName: "Prematch",
    odds: [2.1, 3.2, 3.4],
    regularOdds: [2.1, 3.2, 3.4],
    superOdds: null,
    ...overrides,
  };
}

function tippmixSnapshot(overrides = {}) {
  return {
    generatedAt: NOW - 100,
    lastCatalogueRefreshAt: NOW - 1_000,
    lastFrameAt: NOW - 50,
    connected: true,
    pendingWork: 0,
    lastError: null,
    events: [tippmixEvent()],
    ...overrides,
  };
}

function vegasEvent(overrides = {}) {
  return {
    id: 101,
    startTime: NOW + 3_600_000,
    live: false,
    status: 1,
    statusName: "Prematch",
    odds: [2.2, 3.1, 3.3],
    enhancedOdds: null,
    updatedAt: NOW - 100,
    ...overrides,
  };
}

function vegasSnapshot(overrides = {}) {
  return {
    generatedAt: NOW - 100,
    lastCatalogueRefreshAt: NOW - 1_000,
    lastLiveRefreshAt: NOW - 50,
    lastEnhancedRefreshAt: NOW - 500,
    lastError: null,
    events: [vegasEvent()],
    ...overrides,
  };
}

function side(document, overrides = {}) {
  return { ok: true, fileAgeMs: 100, document, ...overrides };
}

test("TippmixPro health gate accepts a fresh, complete snapshot", () => {
  const health = sideHealth(side(tippmixSnapshot()), policy("tippmixpro"), NOW);

  assert.equal(health.healthy, true);
  assert.deepEqual(health.unhealthyReasons, []);
  assert.equal(health.connected, true);
  assert.equal(health.pendingWork, 0);
  assert.equal(health.events, 1);
  assert.equal(health.validEvents, 1);
});

test("TippmixPro health gate rejects stale content, disconnect and pending work", () => {
  const health = sideHealth(side(tippmixSnapshot({
    generatedAt: NOW - 20_000,
    connected: false,
    pendingWork: 2,
    lastFrameAt: NOW - 30_000,
  })), policy("tippmixpro"), NOW);

  assert.equal(health.healthy, false);
  assert.ok(health.unhealthyReasons.includes("generated-at-stale"));
  assert.ok(health.unhealthyReasons.includes("disconnected"));
  assert.ok(health.unhealthyReasons.includes("pending-work"));
  assert.ok(health.unhealthyReasons.includes("last-frame-at-stale"));
});

test("Vegas health gate validates provider freshness and is null-safe", () => {
  const valid = sideHealth(side(vegasSnapshot()), policy("vegas"), NOW);
  assert.equal(valid.healthy, true);

  const invalid = sideHealth(side(vegasSnapshot({
    lastLiveRefreshAt: NOW - 20_000,
    lastEnhancedRefreshAt: null,
    events: [null, vegasEvent({ id: null })],
  })), policy("vegas"), NOW);

  assert.equal(invalid.healthy, false);
  assert.ok(invalid.unhealthyReasons.includes("last-live-refresh-at-stale"));
  assert.ok(invalid.unhealthyReasons.includes("last-enhanced-refresh-at-missing"));
  assert.ok(invalid.unhealthyReasons.includes("event-invalid"));
  assert.ok(invalid.unhealthyReasons.includes("event-id-missing"));
  assert.equal(eventId(null), "");
  assert.equal(eventId({}), "");
  assert.equal(eventId({ id: 0 }), "0");
});

test("content comparison counts odds, status, in-play and start-time agreement", () => {
  const normal = vegasSnapshot({
    events: [
      vegasEvent({ id: 1 }),
      vegasEvent({ id: 2, odds: [1.5, 4, 6], status: 1, live: false, startTime: NOW + 10_000 }),
      vegasEvent({ id: 3 }),
    ],
  });
  const direct = vegasSnapshot({
    events: [
      vegasEvent({ id: 1 }),
      vegasEvent({ id: 2, odds: [1.6, 4, 6], status: 2, live: true, startTime: NOW + 20_000 }),
      vegasEvent({ id: 4 }),
    ],
  });

  const comparison = compareSnapshots(normal, direct, "vegas");

  assert.equal(comparison.commonEvents, 2);
  assert.equal(comparison.normalOnly, 1);
  assert.equal(comparison.directOnly, 1);
  for (const field of ["odds", "status", "inPlay", "startTime", "allFields"]) {
    assert.deepEqual(comparison.fields[field], {
      compared: 2,
      agreements: 1,
      mismatches: 1,
      agreementRatio: 0.5,
    });
  }
});

test("warmup and invalid samples cannot change coverage maxima or content totals", () => {
  const stats = createStats();
  const largeDiff = compareSnapshots(
    vegasSnapshot({ events: Array.from({ length: 20 }, (_, id) => vegasEvent({ id: id + 1 })) }),
    vegasSnapshot({ events: [] }),
    "vegas",
  );
  const validDiff = compareSnapshots(
    vegasSnapshot({ events: [vegasEvent({ id: 1 }), vegasEvent({ id: 2 }), vegasEvent({ id: 3 })] }),
    vegasSnapshot({ events: [vegasEvent({ id: 3 }), vegasEvent({ id: 4 })] }),
    "vegas",
  );

  recordSample(stats, { warmup: true, sampleValid: false, invalidReasons: ["warmup"], comparison: largeDiff });
  recordSample(stats, { warmup: false, sampleValid: false, invalidReasons: ["direct-content-stale"], comparison: largeDiff });
  recordSample(stats, { warmup: false, sampleValid: true, comparison: validDiff });

  const summary = summarizedStats(stats);
  assert.equal(summary.samples, 3);
  assert.equal(summary.warmupSamples, 1);
  assert.equal(summary.eligibleSamples, 2);
  assert.equal(summary.invalidSamples, 1);
  assert.equal(summary.staleSamples, 1);
  assert.equal(summary.validSamples, 1);
  assert.equal(summary.normalOnlyMax, 2);
  assert.equal(summary.directOnlyMax, 1);
  assert.equal(summary.commonEventObservations, 1);
  assert.equal(summary.odds.compared, 1);
  assert.equal(summary.readinessRatio, 0.5);
  assert.deepEqual(summary.invalidSamplesByReason, { "direct-content-stale": 1 });
});

test("main writes a provider-aware summary from local fixtures", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "provider-comparator-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const normalFile = path.join(directory, "normal.json");
  const directFile = path.join(directory, "direct.json");
  const outputDir = path.join(directory, "output");
  const now = Date.now();
  const normal = {
    ...tippmixSnapshot(),
    generatedAt: now,
    lastCatalogueRefreshAt: now,
    lastFrameAt: now,
    events: [tippmixEvent({ eventId: "1", startTime: now + 60_000 })],
  };
  const direct = {
    ...normal,
    events: [tippmixEvent({ eventId: "1", startTime: now + 60_000, odds: [2.2, 3.2, 3.4] })],
  };
  await Promise.all([
    fs.writeFile(normalFile, JSON.stringify(normal)),
    fs.writeFile(directFile, JSON.stringify(direct)),
  ]);

  const summary = await main({
    provider: "tippmixpro",
    normalFile,
    directFile,
    outputDir,
    durationMs: 220,
    intervalMs: 100,
    warmupMs: 0,
    normalMaxContentAgeMs: 5_000,
    directMaxContentAgeMs: 5_000,
    maxSnapshotSkewMs: 5_000,
    catalogueMaxAgeMs: 660_000,
    tippmixFrameMaxAgeMs: 15_000,
    vegasLiveMaxAgeMs: 5_000,
    vegasEnhancedMaxAgeMs: 15_000,
  });

  assert.ok(summary.validSamples >= 2);
  assert.equal(summary.invalidSamples, 0);
  assert.equal(summary.odds.compared, summary.validSamples);
  assert.equal(summary.odds.agreements, 0);
  assert.equal(summary.odds.mismatches, summary.validSamples);
  assert.equal(summary.status.agreementRatio, 1);
  assert.equal(summary.inPlay.agreementRatio, 1);
  assert.equal(summary.startTime.agreementRatio, 1);

  const written = JSON.parse(await fs.readFile(path.join(outputDir, "summary.json"), "utf8"));
  assert.deepEqual(written, summary);
  const healthLines = (await fs.readFile(path.join(outputDir, "health.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(healthLines.length, summary.samples);
  assert.ok(healthLines.every(line => line.sampleValid && line.comparison.fields.odds.mismatches === 1));
});
