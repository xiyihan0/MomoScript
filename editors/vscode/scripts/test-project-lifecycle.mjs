import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function importBundled(entryPoint) {
  const result = await build({
    entryPoints: [path.join(root, entryPoint)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    logLevel: "silent"
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const workerModule = await importBundled("src/tinymistClient.ts");
const processModule = await importBundled("src/tinymistProcessClient.ts");
const { TinymistWorkerClient } = workerModule;
const { TinymistProcessClient } = processModule;

const INITIALIZE_RESULT = {
  capabilities: {
    completionProvider: {},
    hoverProvider: true,
    signatureHelpProvider: {},
    semanticTokensProvider: {
      legend: { tokenTypes: ["variable"], tokenModifiers: [] },
      full: true
    }
  },
  serverInfo: { name: "fixture", version: "0.15.2" }
};

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.delayed = new Map();
    this.terminated = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data, preventDefault() {} });
  }

  postMessage(message) {
    this.sent.push(structuredClone(message));
    if (message.method === "tinymist/boot") {
      queueMicrotask(() => this.emit("message", {
        jsonrpc: "2.0",
        method: "tinymist/workerReady",
        params: { protocolVersion: 1, backendVersion: "0.15.2" }
      }));
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "fixture/stale") {
      this.delayed.set(message.id, message);
      return;
    }
    const result = message.method === "initialize" ? INITIALIZE_RESULT : null;
    queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: message.id, result }));
  }

  releaseDelayed() {
    for (const id of this.delayed.keys()) this.emit("message", { jsonrpc: "2.0", id, result: "stale" });
    this.delayed.clear();
  }

  terminate() {
    this.terminated = true;
  }
}

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.exitCode = null;
    this.sent = [];
    this.delayed = new Map();
    this.input = Buffer.alloc(0);
    this.stdin = { write: (chunk) => this.write(chunk) };
  }

  write(chunk) {
    this.input = Buffer.concat([this.input, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return true;
      const header = this.input.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("fixture request omitted Content-Length");
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (this.input.length < bodyEnd) return true;
      const message = JSON.parse(this.input.subarray(bodyStart, bodyEnd).toString("utf8"));
      this.input = this.input.subarray(bodyEnd);
      this.sent.push(structuredClone(message));
      this.handle(message);
    }
  }

  handle(message) {
    if (message.id === undefined) return;
    if (message.method === "fixture/stale") {
      this.delayed.set(message.id, message);
      return;
    }
    const result = message.method === "initialize" ? INITIALIZE_RESULT : null;
    queueMicrotask(() => this.respond(message.id, result));
  }

  respond(id, result) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8");
    this.stdout.emit("data", Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
      body
    ]));
  }

  releaseDelayed() {
    for (const id of this.delayed.keys()) this.respond(id, "stale");
    this.delayed.clear();
  }

  kill() {
    this.exitCode = 0;
    return true;
  }
}

function waitForEvent(register, label) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
  register((value) => {
    clearTimeout(timeout);
    resolve(value);
  });
  return promise;
}

const SOURCE = "logical-source:project-lifecycle";
const SESSION_A = "untitled:/fixture/session-a";
const SESSION_B = "untitled:/fixture/session-b";
const HELPER_A = `${SESSION_A}/helper.typ`;
const ENTRY_A1 = `${SESSION_A}/main-1.typ`;
const ENTRY_A2 = `${SESSION_A}/main-2.typ`;
const ENTRY_A3 = `${SESSION_A}/main-3.typ`;
const ENTRY_B1 = `${SESSION_B}/main-1.typ`;

function fullUpdate() {
  return {
    sourceUri: SOURCE,
    sourceVersion: 1,
    revision: 1,
    entryUri: ENTRY_A1,
    full: true,
    files: [
      { uri: HELPER_A, text: "#let value = 1" },
      { uri: ENTRY_A1, text: "#import \"helper.typ\": value\n#value" }
    ]
  };
}

function normalizeMessages(messages) {
  return messages
    .filter((message) => typeof message.method === "string" && message.method.startsWith("textDocument/"))
    .map((message) => ({
      method: message.method,
      uri: message.params?.textDocument?.uri ?? null,
      version: message.params?.textDocument?.version ?? null
    }));
}

async function exerciseClient(kind, startClient, transports) {
  const client = await startClient();
  const primes = [];
  const closes = [];
  const lifecycleEvents = [];
  client.on("tinymist/clientRestarting", () => lifecycleEvents.push("restarting"));
  client.on("tinymist/clientRestarted", () => lifecycleEvents.push("restarted"));
  client.on("tinymist/projectPrimed", (value) => primes.push(value));
  client.on("tinymist/virtualFileClosed", (value) => closes.push(value));

  try {
    const firstPrime = waitForEvent(
      (resolve) => client.on("tinymist/projectPrimed", (value) => {
        if (value.entryUri === ENTRY_A1) resolve(value);
      }),
      `${kind} full prime`
    );
    client.syncProject(fullUpdate());
    await firstPrime;

    const deltaPrime = waitForEvent(
      (resolve) => client.on("tinymist/projectPrimed", (value) => {
        if (value.entryUri === ENTRY_A2) resolve(value);
      }),
      `${kind} delta prime`
    );
    client.syncProject({
      ...fullUpdate(),
      revision: 2,
      entryUri: ENTRY_A2,
      full: false,
      files: [{ uri: ENTRY_A2, text: "#let value = 2\n#value" }]
    });
    await deltaPrime;
    assert.equal(client.projectForEntry(ENTRY_A1), undefined, `${kind} retained an old delta entry`);
    assert.equal(client.projectForEntry(ENTRY_A2)?.files.length, 2, `${kind} did not materialize full+delta state`);

    const beforeDuplicate = transports.at(-1).sent.length;
    client.syncProject({
      ...fullUpdate(),
      revision: 2,
      entryUri: ENTRY_A2,
      full: false,
      files: [{ uri: ENTRY_A2, text: "#let stale = true" }]
    });
    assert.equal(transports.at(-1).sent.length, beforeDuplicate, `${kind} applied a duplicate revision`);

    client.syncProject({
      ...fullUpdate(),
      revision: 1,
      entryUri: ENTRY_B1,
      full: false,
      files: [{ uri: ENTRY_B1, text: "#let incomplete = true" }]
    });
    assert.equal(client.projectForEntry(ENTRY_B1), undefined, `${kind} accepted an unknown-session delta`);

    const nextPrime = waitForEvent(
      (resolve) => client.on("tinymist/projectPrimed", (value) => {
        if (value.entryUri === ENTRY_B1) resolve(value);
      }),
      `${kind} replacement prime`
    );
    client.syncProject({
      ...fullUpdate(),
      revision: 1,
      entryUri: ENTRY_B1,
      full: true,
      files: [{ uri: ENTRY_B1, text: "#let current = true" }]
    });
    await nextPrime;
    client.syncProject({
      ...fullUpdate(),
      revision: 3,
      entryUri: ENTRY_A3,
      full: true,
      files: [{ uri: ENTRY_A3, text: "#let stale = true" }]
    });
    assert.equal(client.projectForEntry(ENTRY_A3), undefined, `${kind} revived a retired session`);
    assert.equal(client.projectForEntry(ENTRY_B1)?.revision, 1, `${kind} lost the replacement session`);

    const oldTransport = transports.at(-1);
    const initialGeneration = client.backendGeneration();
    const initialTransitions = normalizeMessages(oldTransport.sent);
    const staleRequest = client.request("fixture/stale", { textDocument: { uri: ENTRY_B1 } });
    while (oldTransport.delayed.size === 0) await Promise.resolve();
    const restart = client.restart();
    await assert.rejects(staleRequest, /restart requested/, `${kind} published an old-generation response`);
    oldTransport.releaseDelayed();
    await restart;
    assert.equal(client.backendGeneration(), initialGeneration + 1, `${kind} recovery did not advance exactly one generation`);
    assert.deepEqual(lifecycleEvents, ["restarting", "restarted"], `${kind} recovery lifecycle was not serialized`);
    const replayTransport = transports.at(-1);
    const replay = normalizeMessages(replayTransport.sent);
    assert.deepEqual(
      replay.filter((item) => item.method === "textDocument/didOpen").map((item) => item.uri),
      [ENTRY_B1],
      `${kind} restart did not replay only the latest complete project`
    );

    const closeEvent = waitForEvent(
      (resolve) => client.on("tinymist/virtualFileClosed", (value) => {
        if (value.uri === ENTRY_B1) resolve(value);
      }),
      `${kind} close`
    );
    assert.equal(client.closeProject(SOURCE, ENTRY_B1), true, `${kind} rejected current close`);
    await closeEvent;
    assert.equal(client.projectForEntry(ENTRY_B1), undefined, `${kind} close retained the current entry`);

    return {
      kind,
      accepted: ["full:session-a@1", "delta:session-a@2", "full:session-b@1"],
      rejected: ["duplicate:session-a@2", "unknown-delta:session-b@1", "retired:session-a@3"],
      materializedDeltaFileCount: 2,
      initialTransitions,
      primeEntries: primes.map((value) => value.entryUri),
      restartReplay: replay,
      staleGenerationRejected: true,
      closeEntries: closes.map((value) => value.uri)
    };
  } finally {
    await client.stop();
    await client.stop();
    await assert.rejects(client.request("fixture/after-stop", {}), /client stopped/, `${kind} accepted work after disposal`);
    const finalTransport = transports.at(-1);
    assert.ok(finalTransport.terminated === true || finalTransport.exitCode === 0, `${kind} transport was not disposed`);
  }
}

const workers = [];
const worker = await exerciseClient(
  "worker",
  () => TinymistWorkerClient.start(
    "fixture:worker",
    "fixture:module",
    "fixture:wasm",
    () => {
      const transport = new FakeWorker();
      workers.push(transport);
      return transport;
    },
    5
  ),
  workers
);

const children = [];
const processClient = await exerciseClient(
  "process",
  () => TinymistProcessClient.start("fixture-process", 5, () => {
    const transport = new FakeChild();
    children.push(transport);
    return transport;
  }),
  children
);
assert.deepEqual(
  { ...worker, kind: "transport" },
  { ...processClient, kind: "transport" },
  "Worker and process clients diverged on the characterized project sequence"
);

const actual = {
  schemaVersion: 1,
  lifecycle: [worker, processClient]
};
const checkedPath = path.join(root, "src/test/fixtures/project-lifecycle-baseline.json");
const checkedText = await readFile(checkedPath, "utf8");
assert.doesNotMatch(checkedText, /(?:file|https?):\/\//, "lifecycle evidence contains a host/network URI");
assert.doesNotMatch(checkedText, /(?:\/home\/|[A-Z]:\\\\)/, "lifecycle evidence contains an absolute host path");
assert.doesNotMatch(checkedText, /"(?:capturedAt|durationMs|timestamp)"/, "lifecycle evidence contains volatile timing");
const checked = JSON.parse(checkedText);
assert.deepEqual(actual, checked, "project lifecycle behavior changed; inspect and deliberately update checked evidence");
console.log(JSON.stringify({ checked: true, transports: actual.lifecycle.map((item) => item.kind) }));
