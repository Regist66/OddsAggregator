// Shared executable-market predicate for the browser and direct SharpX
// collectors. Keeping it side-effect-free makes the comparator contract
// directly testable without starting a collector.
export function isRenderableMarket(market) {
  if (!market || market.status !== "OPEN") return false;
  return Array.isArray(market.runnerPrices)
    && market.runnerPrices.some(runner =>
      Number.isFinite(Number(runner?.bestLay?.odds))
      && Number(runner.bestLay.odds) > 1,
    );
}

export function mergeSharpXPrice(previous, update, generation, receivedAt) {
  const status = update?.marketDefinition?.status;
  return {
    ...previous,
    ...update,
    marketDefinition: update?.marketDefinition ?? previous?.marketDefinition,
    // A suspension invalidates the previous executable prices. Do not revive
    // them if the next OPEN definition omits rc.
    rc: update?.rc ?? (status && status !== "OPEN" ? [] : previous?.rc ?? []),
    receivedAt,
    generation,
  };
}
