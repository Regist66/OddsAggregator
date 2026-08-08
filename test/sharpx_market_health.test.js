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
        { id: 1, bdatl: [{ odds: 2.1, amount: 10 }] },
        { id: 58805, bdatl: [{ odds: 3.2, amount: 20 }] },
        { id: 2, bdatl: [{ odds: 3.5, amount: 30 }] },
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

test("SharpX accepts the real bdatl lay object shape on cold start", () => {
  const collector = seededCollector();
  try {
    const snapshot = collector.getSnapshot();
    assert.equal(snapshot.initializedMarkets, 1);
    assert.equal(snapshot.markets[0].runnerPrices[0].bestLay.odds, 2.1);
    collector.prices.get("1.123").rc = [];
    assert.equal(collector.getSnapshot().markets.length, 0);
  } finally {
    collector.shutdown();
    delete globalThis.__sharpXMatchOddsCollector;
  }
});

test("SharpX keeps the last complete prices during a subscription transition", () => {
  const previousWebSocket = globalThis.WebSocket;
  class SilentWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;

    constructor() {
      this.readyState = SilentWebSocket.OPEN;
      this.close = () => {};
    }
  }

  globalThis.WebSocket = SilentWebSocket;
  const collector = seededCollector();
  try {
    const previousMarket = collector.catalogue.get("1.123");
    const nextMarket = {
      ...previousMarket,
      marketId: "1.124",
      eventId: "event-2",
    };
    collector.catalogue.set(nextMarket.marketId, nextMarket);

    collector.applySubscriptions([previousMarket, nextMarket]);

    assert.equal(collector.prices.get("1.123").fallback, true);
    assert.equal(collector.getSnapshot().initializedMarkets, 1);

    collector.prices.get("1.123").receivedAt =
      Date.now() - collector.options.subscriptionFallbackMaxAgeMs - 1;
    assert.equal(collector.getSnapshot().initializedMarkets, 0);
  } finally {
    collector.shutdown();
    delete globalThis.__sharpXMatchOddsCollector;
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
});

test("bookmaker odds can only match the same live or prematch phase", () => {
  assert.equal(sameEventPhase({ inPlay: true }, { inPlay: true }, "inPlay"), true);
  assert.equal(sameEventPhase({ inPlay: false }, { live: false }, "live"), true);
  assert.equal(sameEventPhase({ inPlay: true }, { live: false }, "live"), false);
  assert.equal(sameEventPhase({ inPlay: false }, { inPlay: true }, "inPlay"), false);
  assert.equal(sameEventPhase({ inPlay: false }, {}, "live"), false);
});
