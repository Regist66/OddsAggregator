import assert from "node:assert/strict";
import test from "node:test";

import {
  assessTippmixSnapshot,
  assessVegasSnapshot,
} from "../src/sharpx_odds_monitor.js";

const NOW = 1_800_000_000_000;
const FRESHNESS = {
  now: NOW,
  maxAgeMs: 1_000,
  sourceMaxAgeMs: 1_000,
  eventMaxAgeMs: 1_000,
  futureToleranceMs: 100,
};

function freshTippmixSnapshot(overrides = {}) {
  return {
    generatedAt: NOW - 10,
    connected: true,
    pendingWork: 0,
    lastFrameAt: NOW - 10,
    events: [
      {
        eventId: "tippmix-1",
        inPlay: false,
        regularOdds: [2.1, 3.2, 3.4],
      },
    ],
    ...overrides,
  };
}

function freshVegasEvent(overrides = {}) {
  return {
    id: 42,
    live: false,
    updatedAt: NOW - 10,
    enhancedUpdatedAt: NOW - 10,
    odds: [2.1, 3.2, 3.4],
    enhancedOdds: [2.2, 3.3, 3.5],
    ...overrides,
  };
}

function freshVegasSnapshot(events, overrides = {}) {
  return {
    generatedAt: NOW - 10,
    lastLiveRefreshAt: NOW - 10,
    events,
    ...overrides,
  };
}

test("Tippmix: a fresh generatedAt nem teszi elfogadhatova a disconnectelt forrast", () => {
  const input = freshTippmixSnapshot({ connected: false });

  const assessment = assessTippmixSnapshot(input, FRESHNESS);

  assert.equal(assessment.snapshot, null);
  assert.equal(assessment.state, "disconnected");
  assert.equal(assessment.cacheKey, "disconnected");
});

test("Tippmix: stale es jovobeli snapshot timestamp fail-closed eredmenyt ad", async t => {
  const cases = [
    {
      name: "stale snapshot",
      generatedAt: NOW - FRESHNESS.maxAgeMs - 1,
      expectedState: "snapshot-stale",
    },
    {
      name: "future snapshot",
      generatedAt: NOW + FRESHNESS.futureToleranceMs + 1,
      expectedState: "snapshot-future-timestamp",
    },
  ];

  for (const current of cases) {
    await t.test(current.name, () => {
      const assessment = assessTippmixSnapshot(
        freshTippmixSnapshot({ generatedAt: current.generatedAt }),
        FRESHNESS,
      );

      assert.equal(assessment.snapshot, null);
      assert.equal(assessment.state, current.expectedState);
    });
  }
});

test("Tippmix: stale es jovobeli source timestamp is elutasitott", async t => {
  const cases = [
    {
      name: "stale source",
      lastFrameAt: NOW - FRESHNESS.sourceMaxAgeMs - 1,
      expectedState: "source-stale",
    },
    {
      name: "future source",
      lastFrameAt: NOW + FRESHNESS.futureToleranceMs + 1,
      expectedState: "source-future-timestamp",
    },
  ];

  for (const current of cases) {
    await t.test(current.name, () => {
      const assessment = assessTippmixSnapshot(
        freshTippmixSnapshot({ lastFrameAt: current.lastFrameAt }),
        FRESHNESS,
      );

      assert.equal(assessment.snapshot, null);
      assert.equal(assessment.state, current.expectedState);
    });
  }
});

test("Tippmix: minden health timestamp friss eseten a snapshot megmarad", () => {
  const input = freshTippmixSnapshot();

  const assessment = assessTippmixSnapshot(input, FRESHNESS);

  assert.equal(assessment.state, "fresh");
  assert.strictEqual(assessment.snapshot, input);
  assert.equal(assessment.cacheKey, "fresh");
});

test("Tippmix: hianyzo vagy hibas pendingWork fail-closed", () => {
  const missing = freshTippmixSnapshot();
  delete missing.pendingWork;
  assert.equal(assessTippmixSnapshot(missing, FRESHNESS).state, "health-invalid");
  assert.equal(
    assessTippmixSnapshot(freshTippmixSnapshot({ pendingWork: "invalid" }), FRESHNESS).state,
    "health-invalid",
  );
});

test("Vegas: stale live source mellett a teljes snapshot elutasitott", () => {
  const input = freshVegasSnapshot([freshVegasEvent()], {
    lastLiveRefreshAt: NOW - FRESHNESS.sourceMaxAgeMs - 1,
  });

  const assessment = assessVegasSnapshot(input, FRESHNESS);

  assert.equal(assessment.snapshot, null);
  assert.equal(assessment.state, "source-stale");
  assert.equal(assessment.cacheKey, "stale");
});

test("Vegas: stale normal es enhanced event timestamp eseten az event kiesik", () => {
  const staleTimestamp = NOW - FRESHNESS.eventMaxAgeMs - 1;
  const input = freshVegasSnapshot([
    freshVegasEvent({
      updatedAt: staleTimestamp,
      enhancedUpdatedAt: staleTimestamp,
    }),
  ]);

  const assessment = assessVegasSnapshot(input, FRESHNESS);

  assert.equal(assessment.state, "fresh");
  assert.deepEqual(assessment.snapshot.events, []);
  assert.equal(assessment.cacheKey, "fresh:");
});

test("Vegas: stale enhanced odds kiszurodik, a friss normal odds megmarad", () => {
  const normalOdds = [2.1, 3.2, 3.4];
  const input = freshVegasSnapshot([
    freshVegasEvent({
      odds: normalOdds,
      enhancedUpdatedAt: NOW - FRESHNESS.eventMaxAgeMs - 1,
    }),
  ]);

  const assessment = assessVegasSnapshot(input, FRESHNESS);

  assert.equal(assessment.state, "fresh");
  assert.equal(assessment.snapshot.events.length, 1);
  assert.deepEqual(assessment.snapshot.events[0].odds, normalOdds);
  assert.equal(assessment.snapshot.events[0].enhancedOdds, null);
  assert.equal(assessment.cacheKey, "fresh:42:n");
});

test("Vegas: stale normal odds mellett a friss enhanced odds megtartja az eventet", () => {
  const enhancedOdds = [2.2, 3.3, 3.5];
  const input = freshVegasSnapshot([
    freshVegasEvent({
      updatedAt: NOW - FRESHNESS.eventMaxAgeMs - 1,
      enhancedOdds,
    }),
  ]);

  const assessment = assessVegasSnapshot(input, FRESHNESS);

  assert.equal(assessment.state, "fresh");
  assert.equal(assessment.snapshot.events.length, 1);
  assert.equal(assessment.snapshot.events[0].odds, null);
  assert.deepEqual(assessment.snapshot.events[0].enhancedOdds, enhancedOdds);
  assert.equal(assessment.cacheKey, "fresh:42:e");
});

test("Vegas: a jovobeli event timestamp nem keruli meg a freshness kaput", () => {
  const futureTimestamp = NOW + FRESHNESS.futureToleranceMs + 1;
  const input = freshVegasSnapshot([
    freshVegasEvent({
      updatedAt: futureTimestamp,
      enhancedUpdatedAt: futureTimestamp,
    }),
  ]);

  const assessment = assessVegasSnapshot(input, FRESHNESS);

  assert.equal(assessment.state, "fresh");
  assert.deepEqual(assessment.snapshot.events, []);
});

test("Vegas: friss source, event es enhanced timestamp eseten minden odds megmarad", () => {
  const inputEvent = freshVegasEvent();
  const input = freshVegasSnapshot([inputEvent]);

  const assessment = assessVegasSnapshot(input, FRESHNESS);

  assert.equal(assessment.state, "fresh");
  assert.equal(assessment.snapshot.events.length, 1);
  assert.deepEqual(assessment.snapshot.events[0], inputEvent);
  assert.equal(assessment.cacheKey, "fresh:42:ne");
});
