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
