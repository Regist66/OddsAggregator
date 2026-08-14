import { promises as fs } from "node:fs";
import process from "node:process";

const filename = process.argv[2];
const maxAgeMs = Number(process.env.MONITOR_STALE_MS ?? 120_000);
const validateContent = process.env.MONITOR_VALIDATE_CONTENT === "1";
const minimumCoverageRatio = Number(process.env.MONITOR_MIN_COVERAGE_RATIO ?? 0);

if (
  !filename ||
  !Number.isFinite(maxAgeMs) ||
  maxAgeMs < 1 ||
  !Number.isFinite(minimumCoverageRatio) ||
  minimumCoverageRatio < 0 ||
  minimumCoverageRatio > 1
) {
  console.error("Használat: monitor-healthcheck.mjs <heartbeat-file>");
  process.exit(2);
}

try {
  const stats = await fs.stat(filename);
  const ageMs = Date.now() - stats.mtimeMs;
  if (ageMs < 0 || ageMs > maxAgeMs) {
    console.error(`${filename} stale: ${Math.round(ageMs / 1000)}s`);
    process.exit(1);
  }
  if (validateContent) {
    const document = JSON.parse(await fs.readFile(filename, "utf8"));
    const outputHealth = document.outputHealth;
    if (!outputHealth || outputHealth.state !== "healthy") {
      console.error(`SharpX output health: ${outputHealth?.state ?? "missing"}`);
      process.exit(1);
    }
    if (document.connectionHealth?.allConnectionsUnhealthy === true) {
      console.error("SharpX minden WebSocket kapcsolata unhealthy");
      process.exit(1);
    }
    const subscribedMarkets = Number(document.subscribedMarkets);
    const initializedMarkets = Number(document.initializedMarkets);
    if (minimumCoverageRatio > 0 && subscribedMarkets > 0) {
      const coverageRatio = initializedMarkets / subscribedMarkets;
      if (!Number.isFinite(coverageRatio) || coverageRatio < minimumCoverageRatio) {
        console.error(
          `SharpX coverage alacsony: ${initializedMarkets}/${subscribedMarkets} ` +
          `(${coverageRatio.toFixed(4)} < ${minimumCoverageRatio})`,
        );
        process.exit(1);
      }
    }
  }
} catch (error) {
  console.error(`${filename} nem olvasható: ${error.message}`);
  process.exit(1);
}
