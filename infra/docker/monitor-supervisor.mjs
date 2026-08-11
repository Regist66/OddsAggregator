import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import process from "node:process";

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} pozitív egész kell legyen: ${value}`);
  }
  return value;
}

export async function fileAgeMs(filename, now = Date.now()) {
  const stats = await fs.stat(filename);
  return Math.max(0, now - stats.mtimeMs);
}

const [childScript, ...childArguments] = process.argv.slice(2);
if (!childScript) {
  console.error(
    "Használat: monitor-supervisor.mjs <monitor-script> [monitor-argumentumok...]",
  );
  process.exit(2);
}

const heartbeatFile = process.env.MONITOR_HEARTBEAT_FILE;
if (!heartbeatFile) {
  console.error("Hiányzik a MONITOR_HEARTBEAT_FILE.");
  process.exit(2);
}

const staleMs = positiveInteger("MONITOR_STALE_MS", 120_000);
const startupGraceMs = positiveInteger("MONITOR_STARTUP_GRACE_MS", 180_000);
const pollMs = positiveInteger("MONITOR_POLL_MS", 10_000);

const child = spawn(process.execPath, [childScript, ...childArguments], {
  env: process.env,
  stdio: "inherit",
});

let stopping = false;
let requestedExitCode = null;
let killTimer = null;

function stopChild(signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    return;
  }
  if (signal === "SIGTERM") {
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // A child that exited between the check and kill is harmless.
        }
      }
    }, 10_000);
    killTimer.unref();
  }
}

function requestShutdown(exitCode, reason) {
  if (stopping) return;
  stopping = true;
  requestedExitCode = exitCode;
  clearInterval(watchdogTimer);
  console.error(`[watchdog] ${reason}; monitor újraindítása szükséges.`);
  stopChild();
}

async function checkHeartbeat() {
  if (stopping || Date.now() - startedAt < startupGraceMs) return;
  try {
    const ageMs = await fileAgeMs(heartbeatFile);
    if (ageMs > staleMs) {
      requestShutdown(
        75,
        `${heartbeatFile} ${Math.round(ageMs / 1000)} másodperce nem frissült`,
      );
    }
  } catch (error) {
    requestShutdown(
      75,
      error?.code === "ENOENT"
        ? `${heartbeatFile} nem jött létre`
        : `heartbeat ellenőrzési hiba: ${error.message}`,
    );
  }
}

const startedAt = Date.now();
const watchdogTimer = setInterval(() => {
  void checkHeartbeat();
}, pollMs);

child.once("error", error => {
  if (!stopping) requestShutdown(1, `monitor indítási hiba: ${error.message}`);
});

child.once("exit", (code, signal) => {
  clearInterval(watchdogTimer);
  if (killTimer) clearTimeout(killTimer);
  if (requestedExitCode !== null) {
    process.exitCode = requestedExitCode;
  } else {
    process.exitCode = signal ? 1 : code ?? 1;
  }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (!stopping) {
      stopping = true;
      requestedExitCode = 0;
      clearInterval(watchdogTimer);
      stopChild(signal === "SIGHUP" ? "SIGTERM" : signal);
    }
  });
}
