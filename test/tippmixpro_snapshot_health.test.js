import assert from "node:assert/strict";
import test from "node:test";

import { sideHealth } from "../src/provider_direct_shadow_comparator.js";
import { browserCollectorSource } from "../src/tippmixpro_odds_monitor.js";
import { assessTippmixSnapshot } from "../src/sharpx_odds_monitor.js";

const NOW = 1_800_000_000_000;

function policy() {
  return {
    provider: "tippmixpro",
    maxContentAgeMs: 5_000,
    catalogueMaxAgeMs: 660_000,
    tippmixFrameMaxAgeMs: 15_000,
  };
}

function snapshotSide(document) {
  return { ok: true, fileAgeMs: 100, document };
}

function healthyEvent(overrides = {}) {
  return {
    eventId: "event-1",
    startTime: NOW + 60_000,
    inPlay: false,
    statusId: "1",
    statusName: "Prematch",
    odds: [2.1, 3.2, 3.4],
    ...overrides,
  };
}

function healthySnapshot(overrides = {}) {
  return {
    generatedAt: NOW - 100,
    lastCatalogueRefreshAt: NOW - 1_000,
    lastFrameAt: NOW - 50,
    connected: true,
    pendingWork: 0,
    pendingWorkDetails: {
      catalogueRequests: 0,
      topicRegistrations: 0,
      initialDumps: 0,
      queuedOffers: 0,
    },
    snapshotConsistency: {
      consistent: true,
      invalidEvents: 0,
      issues: [],
    },
    events: [healthyEvent()],
    ...overrides,
  };
}

function createCollector(t) {
  new Function(`return ${browserCollectorSource()};`)();
  const collector = globalThis.__tippmixProMatchOddsCollector;
  t.after(() => {
    collector.shutdown();
    delete globalThis.__tippmixProMatchOddsCollector;
  });
  return collector;
}

function populateCompleteEvent(collector, matchOverrides = {}) {
  collector.matches.set("event-1", {
    id: "event-1",
    name: "Home - Away",
    homeParticipantName: "Home",
    awayParticipantName: "Away",
    parentName: "League",
    startTime: NOW + 60_000,
    statusId: "1",
    statusName: "Prematch",
    ...matchOverrides,
  });
  collector.markets.set("market-1", {
    id: "market-1",
    eventId: "event-1",
    displayKey: "b69_ep3",
    isClosed: false,
    isAvailable: true,
  });
  for (const [name, odds] of [["home", 2.1], ["draw", 3.2], ["away", 3.4]]) {
    const outcomeId = `outcome-${name}`;
    collector.outcomes.set(outcomeId, { id: outcomeId, headerNameKey: name });
    collector.relations.set(`relation-${name}`, { marketId: "market-1", outcomeId });
    collector.offers.set(`offer-${name}`, {
      id: `offer-${name}`,
      outcomeId,
      bettingTypeId: "69",
      statusId: "1",
      isAvailable: true,
      isLive: false,
      odds,
      lastChangedTime: NOW - 100,
    });
  }
}

test("TippmixPro collector separates background protocol work from snapshot consistency", t => {
  const collector = createCollector(t);
  populateCompleteEvent(collector);
  collector.pendingRegistrations.set(1, "topic-registering");
  collector.pendingCalls.set(2, "initial-dump-running");
  collector.queuedOfferIds.add("queued-offer");

  const snapshot = collector.getSnapshot();

  assert.equal(snapshot.pendingWork, 3);
  assert.deepEqual(snapshot.pendingWorkDetails, {
    catalogueRequests: 0,
    topicRegistrations: 1,
    initialDumps: 1,
    queuedOffers: 1,
  });
  assert.deepEqual(snapshot.snapshotConsistency, {
    consistent: true,
    invalidEvents: 0,
    issues: [],
  });
});

test("TippmixPro health accepts consistent snapshots during background work", () => {
  const snapshot = healthySnapshot({
    pendingWork: 37,
    pendingWorkDetails: {
      catalogueRequests: 20,
      topicRegistrations: 5,
      initialDumps: 10,
      queuedOffers: 2,
    },
  });
  const health = sideHealth(snapshotSide(snapshot), policy(), NOW);
  const productionAssessment = assessTippmixSnapshot(snapshot, {
    now: NOW,
    maxAgeMs: 5_000,
    sourceMaxAgeMs: 15_000,
    futureToleranceMs: 1_000,
  });

  assert.equal(health.healthy, true);
  assert.deepEqual(health.unhealthyReasons, []);
  assert.equal(health.pendingWork, 37);
  assert.equal(health.snapshotConsistent, true);
  assert.equal(productionAssessment.state, "fresh");
  assert.strictEqual(productionAssessment.snapshot, snapshot);
});

test("TippmixPro health still rejects a genuinely inconsistent snapshot", t => {
  const collector = createCollector(t);
  populateCompleteEvent(collector, { startTime: null });
  const snapshot = collector.getSnapshot();
  snapshot.generatedAt = NOW - 100;
  snapshot.lastCatalogueRefreshAt = NOW - 1_000;
  snapshot.lastFrameAt = NOW - 50;
  snapshot.connected = true;

  assert.deepEqual(snapshot.snapshotConsistency, {
    consistent: false,
    invalidEvents: 1,
    issues: ["event-start-time-invalid"],
  });

  const health = sideHealth(snapshotSide(snapshot), policy(), NOW);
  const productionAssessment = assessTippmixSnapshot(snapshot, {
    now: NOW,
    maxAgeMs: 5_000,
    sourceMaxAgeMs: 15_000,
    futureToleranceMs: 1_000,
  });
  assert.equal(health.healthy, false);
  assert.ok(health.unhealthyReasons.includes("snapshot-inconsistent"));
  assert.ok(health.unhealthyReasons.includes("event-start-time-invalid"));
  assert.equal(productionAssessment.snapshot, null);
  assert.equal(productionAssessment.state, "snapshot-inconsistent");
});

test("TippmixPro recovers transient MATCH metadata gaps from the last complete event", t => {
  const collector = createCollector(t);
  populateCompleteEvent(collector);
  const first = collector.getSnapshot();
  const previous = first.events[0];

  collector.matches.set("event-1", {
    ...collector.matches.get("event-1"),
    startTime: null,
    statusId: null,
    statusName: null,
  });
  const recovered = collector.getSnapshot();

  assert.deepEqual(recovered.snapshotConsistency, {
    consistent: true,
    invalidEvents: 0,
    issues: [],
    recoveredEvents: 1,
  });
  assert.equal(recovered.events[0].startTime, previous.startTime);
  assert.equal(recovered.events[0].statusId, previous.statusId);
  assert.equal(recovered.events[0].statusName, previous.statusName);
});

test("TippmixPro legacy snapshots keep the conservative pending-work gate", () => {
  const legacy = healthySnapshot({ pendingWork: 2 });
  delete legacy.snapshotConsistency;
  delete legacy.pendingWorkDetails;

  const health = sideHealth(snapshotSide(legacy), policy(), NOW);

  assert.equal(health.healthy, false);
  assert.ok(health.unhealthyReasons.includes("pending-work"));
  assert.equal(health.snapshotConsistent, null);
  assert.equal(assessTippmixSnapshot(legacy, {
    now: NOW,
    maxAgeMs: 5_000,
    sourceMaxAgeMs: 15_000,
    futureToleranceMs: 1_000,
  }).state, "pending-work");
});

test("TippmixPro consumers reject a contradictory consistency declaration", () => {
  const snapshot = healthySnapshot({
    snapshotConsistency: {
      consistent: true,
      invalidEvents: 1,
      issues: ["event-start-time-invalid"],
    },
  });

  const health = sideHealth(snapshotSide(snapshot), policy(), NOW);
  const productionAssessment = assessTippmixSnapshot(snapshot, {
    now: NOW,
    maxAgeMs: 5_000,
    sourceMaxAgeMs: 15_000,
    futureToleranceMs: 1_000,
  });

  assert.equal(health.healthy, false);
  assert.ok(health.unhealthyReasons.includes("snapshot-consistency-invalid"));
  assert.equal(productionAssessment.snapshot, null);
  assert.equal(productionAssessment.state, "health-invalid");
});
