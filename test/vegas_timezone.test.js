import test from "node:test";
import assert from "node:assert/strict";

import {
  browserCollectorSource,
  resolveVegasTimezoneOffsetMinutes,
} from "../src/vegas_odds_monitor.js";

test("Vegas timezone offset defaults to the current runtime timezone", () => {
  const fakeDate = { getTimezoneOffset: () => -60 };
  assert.equal(resolveVegasTimezoneOffsetMinutes(undefined, fakeDate), -60);
});

test("Vegas timezone offset accepts a valid explicit override", () => {
  assert.equal(resolveVegasTimezoneOffsetMinutes("-120"), -120);
});

test("Vegas timezone offset rejects invalid and out-of-range values", () => {
  assert.throws(() => resolveVegasTimezoneOffsetMinutes("oops"), /Érvénytelen/);
  assert.throws(() => resolveVegasTimezoneOffsetMinutes("900"), /Érvénytelen/);
});

test("the shared Vegas collector builds each query with the current offset", () => {
  new Function(`return ${browserCollectorSource()};`)();
  try {
    const query = globalThis.__vegasSoccerCollector.query();
    assert.match(
      query,
      new RegExp(`timezoneOffset=${new Date().getTimezoneOffset()}(?:&|$)`),
    );
  } finally {
    globalThis.__vegasSoccerCollector?.shutdown();
    delete globalThis.__vegasSoccerCollector;
  }
});

test("a partial Vegas catalogue refresh keeps the previous complete catalogue", async () => {
  new Function(`return ${browserCollectorSource()};`)();
  const collector = globalThis.__vegasSoccerCollector;
  try {
    const previousEvent = { id: 7, startTime: 1, odds: [2, 3, 4] };
    collector.events = new Map([[7, previousEvent]]);
    collector.availableEventIds = new Set([7]);
    collector.lastCatalogueRefreshAt = 123;
    collector.request = async (endpoint, suffix) => {
      if (endpoint === "GetSportMenu") return { champs: [{ id: 1 }, { id: 2 }] };
      if (suffix === "&champIds=1") return { events: [] };
      throw new Error("transient championship failure");
    };

    await assert.rejects(
      collector.refreshCatalogue(),
      /1 bajnokság lekérése sikertelen/,
    );
    assert.equal(collector.lastCatalogueRefreshAt, 123);
    assert.strictEqual(collector.events.get(7), previousEvent);
    assert.deepEqual([...collector.availableEventIds], [7]);
  } finally {
    collector.shutdown();
    delete globalThis.__vegasSoccerCollector;
  }
});

test("Vegas live refresh uses the freshness-safe timeout", async () => {
  new Function(`return ${browserCollectorSource()};`)();
  const collector = globalThis.__vegasSoccerCollector;
  try {
    let timeoutMs;
    collector.request = async (endpoint, suffix, timeout) => {
      assert.equal(endpoint, "GetLiveOverview");
      assert.equal(suffix, "&sportId=66");
      timeoutMs = timeout;
      return { events: [], markets: [], odds: [], competitors: [], champs: [] };
    };

    await collector.refreshLive();

    assert.equal(timeoutMs, 3_000);
    assert.ok(Number.isFinite(collector.lastLiveRefreshAt));
  } finally {
    collector.shutdown();
    delete globalThis.__vegasSoccerCollector;
  }
});

test("Vegas live refresh retries a transient request failure", async () => {
  new Function(`return ${browserCollectorSource()};`)();
  const collector = globalThis.__vegasSoccerCollector;
  try {
    let attempts = 0;
    collector.request = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient live failure");
      return { events: [], markets: [], odds: [], competitors: [], champs: [] };
    };

    await collector.refreshLive();

    assert.equal(attempts, 2);
    assert.equal(collector.liveRefresh.retries, 1);
    assert.equal(collector.liveRefresh.successes, 1);
    assert.equal(collector.liveRefresh.failures, 0);
    assert.ok(Number.isFinite(collector.lastLiveRefreshAt));
  } finally {
    collector.shutdown();
    delete globalThis.__vegasSoccerCollector;
  }
});

test("Vegas live refresh records bounded timeout failures and backoff", async () => {
  new Function(`return ${browserCollectorSource()};`)();
  const collector = globalThis.__vegasSoccerCollector;
  try {
    collector.request = async () => {
      throw new Error("GetLiveOverview kérés időtúllépés");
    };

    const result = await collector.refreshLive();

    assert.equal(result.ok, false);
    assert.equal(collector.liveRefresh.failures, 1);
    assert.equal(collector.liveRefresh.timeouts, 1);
    assert.equal(collector.liveRefresh.retries, 1);
    assert.equal(collector.liveRefresh.consecutiveFailures, 1);
    assert.equal(collector.liveRefresh.backoffMs, 500);
    assert.ok(Number.isFinite(collector.liveRefresh.nextAttemptAt));
  } finally {
    collector.shutdown();
    delete globalThis.__vegasSoccerCollector;
  }
});

test("Vegas targeted refresh keeps successful batches when another batch fails", async () => {
  new Function(`return ${browserCollectorSource()};`)();
  const collector = globalThis.__vegasSoccerCollector;
  try {
    const eventIds = Array.from({ length: 51 }, (_, index) => index + 1);
    collector.availableEventIds = new Set(eventIds);
    collector.request = async (endpoint, suffix) => {
      assert.equal(endpoint, "GetEventsById");
      if (suffix.includes("eventIds=51")) throw new Error("transient detail failure");
      return { events: [], markets: [], odds: [], competitors: [], champs: [] };
    };

    const result = await collector.refreshEvents(eventIds);

    assert.equal(result.failedBatches, 1);
    assert.equal(result.refreshedEvents, 0);
  } finally {
    collector.shutdown();
    delete globalThis.__vegasSoccerCollector;
  }
});
