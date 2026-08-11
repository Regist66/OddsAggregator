import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireWriterLock,
  acquireWriterLocks,
  writeTextAtomically,
} from "../src/atomic_file.js";
import { browserCollectorSource } from "../src/tippmixpro_odds_monitor.js";

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("A tesztfeltétel nem teljesült időben.");
    await delay(5);
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  send(content) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("A fake WebSocket nem nyitott.");
    }
    this.sent.push(String(content));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "test close" });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function installFakeCollector(t) {
  const previousWebSocket = globalThis.WebSocket;
  const previousCollector = globalThis.__tippmixProMatchOddsCollector;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  delete globalThis.__tippmixProMatchOddsCollector;
  (0, eval)(browserCollectorSource());
  const collector = globalThis.__tippmixProMatchOddsCollector;

  t.after(() => {
    collector?.shutdown();
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
    if (previousCollector === undefined) {
      delete globalThis.__tippmixProMatchOddsCollector;
    } else {
      globalThis.__tippmixProMatchOddsCollector = previousCollector;
    }
  });

  return collector;
}

async function rejectWithin(promise, milliseconds) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`A promise nem rejectalt ${milliseconds} ms alatt.`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "oddsaggregator-runtime-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Tippmix collector: close before WELCOME rejects promptly and shutdown cancels reconnect", async t => {
  const collector = installFakeCollector(t);
  const connecting = collector.connect();
  const socket = FakeWebSocket.instances[0];

  assert.ok(socket);
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]).slice(0, 2), [1, "www.tippmixpro.hu"]);

  socket.close();
  await assert.rejects(
    rejectWithin(connecting, 250),
    /WELCOME .*megszakadt/,
  );

  assert.ok(collector.reconnectTimer, "a close-nak reconnectet kell utemeznie");
  collector.shutdown();
  const socketCountAfterShutdown = FakeWebSocket.instances.length;
  await delay(1_100);

  assert.equal(FakeWebSocket.instances.length, socketCountAfterShutdown);
  assert.equal(collector.reconnectTimer, null);
  assert.equal(collector.closing, true);
});

test("Tippmix collector: WAMP ERROR rejects and removes the matching RPC", async t => {
  const collector = installFakeCollector(t);
  const connecting = collector.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive([2, 12345, {}]);
  await connecting;

  const rpcPromise = collector.rpc("/sports#test", { value: 1 });
  const call = JSON.parse(socket.sent.at(-1));
  assert.equal(call[0], 48);
  const requestId = call[1];
  assert.equal(collector.pendingRpcs.has(requestId), true);

  const rejection = assert.rejects(rpcPromise, /WAMP RPC hiba/);
  socket.receive([8, 48, requestId, {}, "wamp.error.test"]);
  await rejection;

  assert.equal(collector.pendingRpcs.has(requestId), false);
  assert.match(collector.lastError, /wamp\.error\.test/);
});

test("Tippmix collector: timed-out RPCs retry and late RESULT frames are ignored", async t => {
  const collector = installFakeCollector(t);
  const connecting = collector.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive([2, 12345, {}]);
  await connecting;

  collector.wampRpcTimeoutMs = 20;
  collector.catalogueRpcRetryCount = 1;
  collector.catalogueRpcRetryBaseMs = 1;
  const resultPromise = collector.rpcWithRetry("/sports#locations", { sportId: "1" });
  const firstCall = JSON.parse(socket.sent.at(-1));
  const firstRequestId = firstCall[1];

  await waitFor(() =>
    collector.rpcTimeouts === 1
    && collector.catalogueRpcRetries === 1
    && socket.sent.length >= 3,
  );
  const secondCall = JSON.parse(socket.sent.at(-1));
  const secondRequestId = secondCall[1];
  assert.notEqual(secondRequestId, firstRequestId);
  assert.equal(collector.rpcTimeouts, 1);
  assert.equal(collector.catalogueRpcRetries, 1);

  // A late response for the expired RPC must not be processed as an
  // initialDump payload.
  socket.receive([50, firstRequestId, {}, {}, { records: [{ _type: "MATCH", id: "late" }] }]);
  assert.equal(collector.matches.has("late"), false);

  socket.receive([50, secondRequestId, {}, {}, { records: [] }]);
  await resultPromise;
  assert.equal(collector.expiredRpcIds.size, 0);
  assert.equal(collector.lastError, null);
});

test("Tippmix collector: timed-out initialDump is cleaned up and late RESULT is ignored", async t => {
  const collector = installFakeCollector(t);
  const connecting = collector.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive([2, 12345, {}]);
  await connecting;

  collector.wampRequestTimeoutMs = 20;
  const topic = "/sports/2901/hu/test-topic";
  collector.subscribeAndDump(topic);
  const register = JSON.parse(socket.sent.at(-1));
  socket.receive([65, register[1], 7001, {}]);
  const initialDump = JSON.parse(socket.sent.at(-1));
  assert.equal(initialDump[0], 48);

  await waitFor(() => !collector.pendingCalls.has(initialDump[1]));
  socket.receive([50, initialDump[1], {}, {}, { records: [{ _type: "MATCH", id: "late-dump" }] }]);
  assert.equal(collector.matches.has("late-dump"), false);
  assert.equal(collector.expiredRequestIds.size, 0);
});

test("Tippmix collector: topic registration queue respects the concurrency cap", async t => {
  const collector = installFakeCollector(t);
  const connecting = collector.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive([2, 12345, {}]);
  await connecting;

  collector.topicRegistrationConcurrency = 1;
  collector.subscribeAndDump("/sports/2901/hu/topic-a");
  collector.subscribeAndDump("/sports/2901/hu/topic-b");
  assert.equal(collector.pendingRegistrations.size, 1);
  assert.equal(collector.topicQueue.length, 1);

  const firstRegister = JSON.parse(socket.sent.at(-1));
  socket.receive([65, firstRegister[1], 7001, {}]);
  const firstDump = JSON.parse(socket.sent.at(-1));
  assert.equal(collector.topicQueue.length, 1);
  socket.receive([50, firstDump[1], {}, {}, { records: [] }]);

  const secondRegister = JSON.parse(socket.sent.at(-1));
  assert.equal(secondRegister[0], 64);
  assert.equal(collector.topicQueue.length, 0);
});

test("atomic file: repeated replace publishes the complete latest content", async t => {
  const directory = await makeTemporaryDirectory(t);
  const output = path.join(directory, "snapshot.txt");

  await writeTextAtomically(output, "first complete content\n");
  assert.equal(await fs.readFile(output, "utf8"), "first complete content\n");

  await writeTextAtomically(output, "second complete content\n");
  assert.equal(await fs.readFile(output, "utf8"), "second complete content\n");
  assert.deepEqual(await fs.readdir(directory), ["snapshot.txt"]);
});

test("atomic file: parallel writers leave one complete payload and no temp files", async t => {
  const directory = await makeTemporaryDirectory(t);
  const output = path.join(directory, "parallel.txt");
  const payloads = Array.from({ length: 24 }, (_, index) => {
    const marker = String(index).padStart(2, "0");
    return `writer-${marker}\n${marker.repeat(16_384)}\nend-${marker}\n`;
  });

  await Promise.all(
    payloads.map(content => writeTextAtomically(output, content)),
  );

  const published = await fs.readFile(output, "utf8");
  assert.ok(payloads.includes(published), "a vegso fajl egy teljes payload legyen");
  assert.deepEqual(await fs.readdir(directory), ["parallel.txt"]);
});

test("writer lock: a second live owner is rejected, then succeeds after release", async t => {
  const directory = await makeTemporaryDirectory(t);
  const output = path.join(directory, "locked-output.txt");
  let firstLock = await acquireWriterLock(output, "first writer");
  let secondLock;
  t.after(async () => {
    await secondLock?.release();
    await firstLock?.release();
  });

  await assert.rejects(
    acquireWriterLock(output, "second writer"),
    error => {
      assert.match(error.message, /second writer mar irja|second writer már írja/);
      assert.match(error.message, new RegExp(`PID ${process.pid}`));
      return true;
    },
  );

  await firstLock.release();
  firstLock = null;
  secondLock = await acquireWriterLock(output, "second writer");
  assert.equal(typeof secondLock.release, "function");

  await secondLock.release();
  secondLock = null;
  await assert.rejects(fs.access(`${output}.lock`), { code: "ENOENT" });
});

test("writer lock: a legacy PID 1 lock from a previous container is reclaimed", async t => {
  const directory = await makeTemporaryDirectory(t);
  const output = path.join(directory, "container-output.txt");
  const lockFile = `${output}.lock`;
  const staleAcquiredAt = new Date(
    Date.now() - Math.ceil(process.uptime() * 1_000) - 1_000,
  ).toISOString();

  await fs.writeFile(
    lockFile,
    `${JSON.stringify({
      pid: process.pid,
      processName: path.basename(process.execPath).toLowerCase(),
      label: "previous container",
      outputFile: output,
      acquiredAt: staleAcquiredAt,
    })}\n`,
    "utf8",
  );

  const lock = await acquireWriterLock(output, "new container");
  t.after(() => lock.release());
  assert.equal(typeof lock.release, "function");
});

test("writer lock set: a partial acquisition rolls every acquired lock back", async t => {
  const directory = await makeTemporaryDirectory(t);
  const firstOutput = path.join(directory, "first.txt");
  const blockedOutput = path.join(directory, "blocked.txt");
  const blocker = await acquireWriterLock(blockedOutput, "blocker");
  t.after(() => blocker.release());

  await assert.rejects(
    acquireWriterLocks([firstOutput, blockedOutput], "multi writer"),
    /mar irja|már írja/,
  );

  const firstLock = await acquireWriterLock(firstOutput, "replacement writer");
  await firstLock.release();
});
