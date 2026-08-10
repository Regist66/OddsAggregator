import { promises as fs, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const TRANSIENT_REPLACE_ERRORS = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EPERM",
]);

export class AtomicWriteError extends Error {
  constructor(filename, cause) {
    super(`Az output nem cserélhető atomikusan: ${filename}: ${cause.message}`, {
      cause,
    });
    this.name = "AtomicWriteError";
    this.code = cause.code;
    this.isOutputError = true;
  }
}

export async function writeTextAtomically(
  filename,
  content,
  { attempts = 8, retryBaseMs = 25 } = {},
) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporaryFile =
    `${filename}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await fs.writeFile(temporaryFile, content, "utf8");
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fs.rename(temporaryFile, filename);
        published = true;
        return;
      } catch (error) {
        lastError = error;
        if (!TRANSIENT_REPLACE_ERRORS.has(error?.code)) throw error;

        // Windows may reject rename-over-existing. Keep the previous good file
        // until it can actually be removed, then publish the already complete
        // same-directory temporary file.
        try {
          await fs.rm(filename, { force: true });
          try {
            await fs.rename(temporaryFile, filename);
            published = true;
            return;
          } catch (publishError) {
            lastError = publishError;
            if (!TRANSIENT_REPLACE_ERRORS.has(publishError?.code)) {
              throw publishError;
            }
          }
        } catch (removeError) {
          lastError = removeError;
          if (!TRANSIENT_REPLACE_ERRORS.has(removeError?.code)) throw removeError;
        }
        await sleep(Math.min(250, retryBaseMs * (attempt + 1)));
      }
    }
    throw lastError ?? new Error("Ismeretlen outputcsere-hiba.");
  } catch (error) {
    throw error instanceof AtomicWriteError
      ? error
      : new AtomicWriteError(filename, error);
  } finally {
    if (!published) await fs.rm(temporaryFile, { force: true }).catch(() => {});
  }
}

function getProcessImageName(pid) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "tasklist.exe",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const match = output.match(/^"([^"]+)"\s*,\s*"(\d+)"/m);
      return match?.[1]?.toLowerCase() ?? null;
    }
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

function processIsAlive(pid, expectedImageName = path.basename(process.execPath).toLowerCase()) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    const actualImageName = getProcessImageName(pid);
    // A PID can be reused by an unrelated process. The image-name check keeps
    // an old Node lock from blocking a new monitor after such a reuse.
    return !actualImageName || actualImageName === expectedImageName;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireWriterLock(outputFile, label) {
  const lockFile = `${outputFile}.lock`;
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = await fs.open(lockFile, "wx");
      const record = {
        token,
        pid: process.pid,
        processName: path.basename(process.execPath).toLowerCase(),
        label,
        outputFile,
        acquiredAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.close();
      handle = null;

      let released = false;
      const removeIfOwnedSync = () => {
        if (released) return;
        try {
          const current = JSON.parse(readFileSync(lockFile, "utf8"));
          if (current.token === token) rmSync(lockFile, { force: true });
        } catch {
          // A lock már eltűnt vagy másik folyamaté; nem törlünk vakon.
        }
      };
      const exitHandler = () => removeIfOwnedSync();
      process.once("exit", exitHandler);

      return {
        filename: lockFile,
        async release() {
          if (released) return;
          removeIfOwnedSync();
          released = true;
          process.removeListener("exit", exitHandler);
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;

      let owner = null;
      try {
        owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
      } catch {
        // Félbemaradt lock-rekord: az alábbi stale eltávolítás kezeli.
      }
      if (processIsAlive(Number(owner?.pid), owner?.processName ?? path.basename(process.execPath).toLowerCase())) {
        throw new Error(
          `${label} már írja ezt az outputot (PID ${owner.pid}): ${outputFile}`,
        );
      }
      await fs.rm(lockFile, { force: true });
    }
  }
  throw new Error(`Az írózár nem szerezhető meg: ${lockFile}`);
}

export async function acquireWriterLocks(outputFiles, label) {
  const locks = [];
  try {
    for (const outputFile of [...new Set(outputFiles.map(file => path.resolve(file)))]) {
      locks.push(await acquireWriterLock(outputFile, label));
    }
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release();
    throw error;
  }
  return {
    async release() {
      for (const lock of locks.reverse()) await lock.release();
    },
  };
}
