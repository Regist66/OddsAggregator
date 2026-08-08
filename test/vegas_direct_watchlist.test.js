import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWatchlistSnapshot } from "../src/vegas_direct_shadow.js";

test("Vegas direct accepts the direct SharpX snapshot as its watchlist", () => {
  const generatedAt = 1_800_000_000_000;
  const watchlist = normalizeWatchlistSnapshot({
    generatedAt,
    markets: [
      {
        eventId: "event-1",
        eventName: "Home FC v Away FC",
        competitionName: "Test League",
        marketStartTime: generatedAt + 60_000,
        inPlay: false,
        runners: [
          { selectionId: 1, runnerName: "Home FC" },
          { selectionId: 2, runnerName: "Away FC" },
          { selectionId: 3, runnerName: "The Draw" },
        ],
      },
    ],
  });

  assert.deepEqual(watchlist, {
    generatedAt,
    events: [
      {
        eventName: "Home FC v Away FC",
        competitionName: "Test League",
        startTime: generatedAt + 60_000,
        inPlay: false,
        homeName: "Home FC",
        awayName: "Away FC",
      },
    ],
  });
});

test("Vegas direct keeps the canonical watchlist schema unchanged", () => {
  const watchlist = { generatedAt: 1, events: [{ eventName: "A v B" }] };
  assert.strictEqual(normalizeWatchlistSnapshot(watchlist), watchlist);
});
