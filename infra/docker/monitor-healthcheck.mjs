import { promises as fs } from "node:fs";
import process from "node:process";

const filename = process.argv[2];
const maxAgeMs = Number(process.env.MONITOR_STALE_MS ?? 120_000);

if (!filename || !Number.isFinite(maxAgeMs) || maxAgeMs < 1) {
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
} catch (error) {
  console.error(`${filename} nem olvasható: ${error.message}`);
  process.exit(1);
}
