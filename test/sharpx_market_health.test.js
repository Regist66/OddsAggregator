import test from "node:test";
import assert from "node:assert/strict";

import { browserCollectorSource, sameEventPhase } from "../src/sharpx_odds_monitor.js";

function seededCollector({ status = "OPEN", inPlay = true, oddsAgeMs = 0, rc } = {}) {
  new Function(`return ${browserCollectorSource()};`)();
  const collector = globalThis.__sharpXMatchOddsCollector;
  const market = {
    marketId: "1.123",
    eventId: "event-1",
    eventName: "Home v Away",
    competitionName: "League",
    marketStartTime: Date.now() + 60_000,
    inPlay,
    totalMatched: 100,
    runners: [
      { selectionId: 1, runnerName: "Home" },
      { selectionId: 58805, runnerName: "The Draw" },
      { selectionId: 2, runnerName: "Away" },
    ],
  };
  collector.generation = 1;
  collector.catalogue.set(market.marketId, market);
  collector.subscriptionSignature = market.marketId;
  collector.prices.set(market.marketId, {
    generation: 1,
    marketDefinition: { status, inPlay },
    receivedAt: Date.now(),
    oddsReceivedAt: Date.now() - oddsAgeMs,
    rc:
      rc ?? [
        { id: 1, bdatl: [2.1] },
        { id: 58805, bdatl: [3.2] },
        { id: 2, bdatl: [3.5] },
      ],
  });
  collector.connections = [
    {
      generation: 1,
      socket: { readyState: WebSocket.OPEN, close() {} },
      readyMarkets: new Set([market.marketId]),
      markets: [market],
      opened: true,
      lastFrameAt: Date.now(),
    },
  ];
  return collector;
}

test("SharpX excludes SUSPENDED prices even when an old rc is cached", () => {
  const collector = seededCollector({ status: "SUSPENDED" });
  try {
    assert.equal(collector.getSnapshot().markets.length, 0);
  } finally {
    collector.shutdown();
    delete globalThis.__sharpXMatchOddsCollector;
  }
});

test("SharpX excludes stale live prices", () => {
  const collector = seededCollector({ oddsAgeMs: 10_001 });
  try {
    assert.equal(collector.getSnapshot().markets.length, 0);
  } finally {
    collector.shutdown();
    delete globalThis.__sharpXMatchOddsCollector;
  }
});

test("SharpX keeps a fresh OPEN market only while it has an executable lay price", () => {
  const collector = seededCollector();
  try {
    assert.equal(collector.getSnapshot().markets.length, 1);
    collector.prices.get("1.123").rc = [];
    assert.equal(collector.getSnapshot().markets.length, 0);
  } finally {
    collector.shutdown();
    delete globalThis.__sharpXMatchOddsCollector;
  }
});

test("bookmaker odds can only match the same live or prematch phase", () => {
  assert.equal(sameEventPhase({ inPlay: true }, { inPlay: true }, "inPlay"), true);
  assert.equal(sameEventPhase({ inPlay: false }, { live: false }, "live"), true);
  assert.equal(sameEventPhase({ inPlay: true }, { live: false }, "live"), false);
  assert.equal(sameEventPhase({ inPlay: false }, { inPlay: true }, "inPlay"), false);
  assert.equal(sameEventPhase({ inPlay: false }, {}, "live"), false);
});
