import test from "node:test";
import assert from "node:assert/strict";

import {
  assessSharpXSnapshot,
  directSharpXCoverage,
} from "../src/direct_primary_aggregator.js";

function side(snapshot, now = Date.now()) {
  return {
    ok: true,
    fileAgeMs: 0,
    snapshot: {
      generatedAt: now,
      ...snapshot,
    },
  };
}

function diagnostics({ notRenderable = 0, notReady = 0, stale = 0, closed = 0 } = {}) {
  return {
    missingOutputMarkets: notRenderable + notReady + stale + closed,
    subscribedAccountingMatches: true,
    counts: {
      "not-renderable": notRenderable,
      "not-ready": notReady,
      stale,
      closed,
    },
  };
}

test("direct coverage does not treat non-renderable markets as catalogue gaps", () => {
  const coverage = directSharpXCoverage({
    subscribedMarkets: 559,
    initializedMarkets: 517,
    marketDiagnostics: diagnostics({ notRenderable: 42 }),
  });

  assert.equal(coverage.renderableCoverageRatio, 517 / 559);
  assert.equal(coverage.catalogueCoverageRatio, 1);
  assert.equal(coverage.notRenderableMarkets, 42);
  assert.equal(coverage.blockingMissingMarkets, 0);

  const assessment = assessSharpXSnapshot(side({
    subscribedMarkets: 559,
    initializedMarkets: 517,
    markets: [],
    marketDiagnostics: diagnostics({ notRenderable: 42 }),
  }), Date.now());
  assert.equal(assessment.state, "fresh");
  assert.equal(assessment.snapshot !== null, true);
});

test("direct coverage reports a small not-ready transition without stopping output", () => {
  const assessment = assessSharpXSnapshot(side({
    subscribedMarkets: 559,
    initializedMarkets: 517,
    markets: [],
    marketDiagnostics: diagnostics({ notRenderable: 41, notReady: 1 }),
  }), Date.now());

  assert.notEqual(assessment.snapshot, null);
  assert.equal(assessment.state, "fresh-degraded");
  assert.deepEqual(assessment.degradedReasons, ["coverage-incomplete"]);
});

test("snapshots without diagnostics retain the conservative coverage gate", () => {
  const assessment = assessSharpXSnapshot(side({
    subscribedMarkets: 100,
    initializedMarkets: 89,
    markets: [],
  }), Date.now());

  assert.equal(assessment.snapshot, null);
  assert.match(assessment.state, /coverage-low/);
});
