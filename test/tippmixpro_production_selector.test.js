import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTippmixSnapshot,
  selectorHealth,
} from "../src/tippmixpro_production_selector.js";

const NOW = 1_800_000_000_000;

function healthySnapshot(overrides = {}) {
  return {
    generatedAt: NOW - 100,
    lastFrameAt: NOW - 50,
    connected: true,
    pendingWork: 0,
    snapshotConsistency: {
      consistent: true,
      invalidEvents: 0,
      issues: [],
    },
    events: [{ eventId: "event-1", startTime: NOW + 60_000, inPlay: false }],
    ...overrides,
  };
}

function read(snapshot, error = null) {
  return { snapshot, error };
}

test("TippmixPro selector prefers a healthy direct snapshot", () => {
  const direct = healthySnapshot({ events: [{ eventId: "direct" }] });
  const headless = healthySnapshot({ events: [{ eventId: "headless" }] });

  const result = selectTippmixSnapshot({
    direct: read(direct),
    headless: read(headless),
    now: NOW,
  });

  assert.equal(result.source, "direct");
  assert.equal(result.selectedState, "fresh");
  assert.equal(result.snapshot.productionSource, "direct");
  assert.deepEqual(result.snapshot.events, [{ eventId: "direct" }]);
  assert.equal(result.direct.healthy, true);
  assert.equal(result.headless.healthy, true);
});

test("TippmixPro selector falls back to headless when direct is unhealthy", () => {
  const direct = healthySnapshot({ connected: false });
  const headless = healthySnapshot({ events: [{ eventId: "headless" }] });

  const result = selectTippmixSnapshot({
    direct: read(direct),
    headless: read(headless),
    now: NOW,
  });

  assert.equal(result.source, "headless-fallback");
  assert.equal(result.selectedState, "fresh");
  assert.equal(result.snapshot.productionSource, "headless-fallback");
  assert.deepEqual(result.snapshot.events, [{ eventId: "headless" }]);
  assert.equal(result.direct.state, "disconnected");
  assert.equal(result.headless.healthy, true);

  const health = selectorHealth(result, NOW);
  assert.equal(health.selectedSource, "headless-fallback");
  assert.equal(health.direct.healthy, false);
});

test("TippmixPro selector stays unavailable when both sources are unhealthy", () => {
  const result = selectTippmixSnapshot({
    direct: read(null, "ENOENT"),
    headless: read(healthySnapshot({ generatedAt: NOW - 20_000 })),
    now: NOW,
  });

  assert.equal(result.source, "unavailable");
  assert.equal(result.snapshot, null);
  assert.equal(result.direct.state, "read-ENOENT");
  assert.equal(result.headless.state, "snapshot-stale");
});
