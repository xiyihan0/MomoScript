import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const canonicalPin = JSON.parse(
  await readFile(path.resolve(root, "../../third_party/tinymist/pin.json"), "utf8")
);
const expectedTinymistVersion = canonicalPin.upstream.version;

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
  serverInfo: { name: "fixture", version: expectedTinymistVersion }
};

function fixtureResponse(message) {
  if (message.method === "initialize") return INITIALIZE_RESULT;
  if (message.method !== "mmt/previewRenderer.v1") return null;
  const { protocolVersion, action, sessionId, snapshotToken, sourceDigest } = message.params;
  if (action === "register") return { status: "registered", protocolVersion, sessionId, sourceDigest };
  if (action === "render") {
    return {
      status: "compileFailed", protocolVersion, sessionId, snapshotToken, sourceDigest,
      compilerRevision: 1, diagnostics: []
    };
  }
  return null;
}

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
        params: { protocolVersion: 1, backendVersion: expectedTinymistVersion }
      }));
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "fixture/stale") {
      this.delayed.set(message.id, message);
      return;
    }
    const result = fixtureResponse(message);
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
    const result = fixtureResponse(message);
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

function digestedFile(uri, text) {
  const hash = createHash("sha256");
  for (const bytes of [Buffer.from("mmt-project-file-v1"), Buffer.from(text)]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return { uri, text, digest: hash.digest("hex") };
}

async function exercisePreviewCompilerOwnership(kind, startClient, transports) {
  const client = await startClient();
  try {
    const language = {
      ...fullUpdate(),
      sourceContent: "1".repeat(64),
      projectDigest: "2".repeat(64),
      projectionKey: "3".repeat(64),
      mappingDigest: "4".repeat(64),
      files: [
        digestedFile(HELPER_A, "#let value = 1"),
        digestedFile(ENTRY_A1, "#import \"helper.typ\": value\n#value")
      ]
    };
    const mount = { logicalSourceId: "5".repeat(64) };
    const options = { sessionId: "preview-ownership", snapshotToken: "6".repeat(64), forceFull: true };
    const chatEntry = `${SESSION_A}/main-chat-390-v1.typ`;
    const chat = {
      ...language,
      renderPreset: { kind: "chat", widthPt: 390 },
      entryUri: chatEntry,
      projectDigest: "7".repeat(64),
      projectionKey: "8".repeat(64),
      files: [language.files[0], digestedFile(chatEntry, "#import \"helper.typ\": value\n#value\n// chat")]
    };
    client.syncProject(language);
    const beforePreview = transports.at(-1).sent.length;
    const rendered = await client.previewRenderer(chat, mount, options);
    const renderTraffic = transports.at(-1).sent.slice(beforePreview);
    const registration = renderTraffic.find((message) => message.params?.action === "register");
    assert.equal(registration?.params.entryUri, language.entryUri, `${kind} did not use the language compiler base`);
    assert.equal(registration.params.renderEntryUri, rendered.synchronized.project.entryUri);
    assert.equal(rendered.synchronized.compilerEntryUri, chatEntry, `${kind} changed the public render identity`);
    assert.equal(client.projectForEntry(language.entryUri)?.projectDigest, language.projectDigest);
    assert.equal(client.projectForEntry(chatEntry), undefined, `${kind} admitted chat into the language revision domain`);
    assert.deepEqual(
      renderTraffic.filter((message) => ["textDocument/didOpen", "textDocument/didChange"].includes(message.method)),
      [],
      `${kind} overwrote language virtual files with chat bytes`
    );
    const widerEntry = `${SESSION_A}/main-chat-720-v1.typ`;
    await client.previewRenderer({
      ...chat,
      renderPreset: { kind: "chat", widthPt: 720 },
      entryUri: widerEntry,
      projectDigest: "9".repeat(64),
      files: [language.files[0], digestedFile(widerEntry, "#value\n// wider chat")]
    }, mount, options);
    assert.equal(client.projectForEntry(language.entryUri)?.revision, 1);
    for (const mismatch of [
      { sourceVersion: 2 },
      { revision: 2 },
      { sourceContent: "a".repeat(64) },
      { entryUri: `${SESSION_B}/main-chat-390-v1.typ`, files: [
        digestedFile(`${SESSION_B}/main-chat-390-v1.typ`, "#text(\"other session\")")
      ] }
    ]) {
      await assert.rejects(
        client.syncPreviewProject({ ...chat, ...mismatch }, mount),
        (error) => error?.code === "PreviewSnapshotMismatch",
        `${kind} accepted a render from a different authored snapshot`
      );
    }
    const nextLanguage = {
      ...language, sourceVersion: 2, revision: 2, sourceContent: "b".repeat(64),
      entryUri: ENTRY_A2, projectDigest: "c".repeat(64),
      files: [language.files[0], digestedFile(ENTRY_A2, "#value + 1")]
    };
    client.syncProject(nextLanguage);
    await client.previewRenderer({
      ...chat, sourceVersion: 2, revision: 2, sourceContent: nextLanguage.sourceContent,
      projectDigest: "a".repeat(64),
      files: [language.files[0], digestedFile(chatEntry, "#value + 1\n// next chat")]
    }, mount, options);
    assert.equal(client.projectForEntry(ENTRY_A2)?.projectDigest, nextLanguage.projectDigest);
    await client.restart();
    assert.deepEqual(
      transports.at(-1).sent.filter((message) => message.method === "textDocument/didOpen")
        .map((message) => message.params.textDocument.uri),
      [HELPER_A, ENTRY_A2],
      `${kind} replayed a render preset as a language project`
    );

    const renderOnlyEntry = "untitled:/fixture/render-only/main.typ";
    const renderOnly = {
      ...language, sourceUri: "logical-source:render-only", entryUri: renderOnlyEntry,
      files: [digestedFile(renderOnlyEntry, "#text(\"render only\")")],
      projectDigest: "d".repeat(64)
    };
    const renderOnlyMount = { logicalSourceId: "e".repeat(64) };
    const direct = await client.previewRenderer(renderOnly, renderOnlyMount, options);
    const directRegistration = transports.at(-1).sent.findLast((message) => message.params?.action === "register");
    const directBaseEntry = direct.synchronized.project.entryUri.replace(/^mmt-preview:/u, "untitled:");
    assert.equal(directRegistration.params.entryUri, directBaseEntry);
    assert.equal(client.projectForEntry(renderOnlyEntry), undefined);
    assert.equal(
      client.projectForEntry(directBaseEntry)?.sourceUri,
      direct.synchronized.project.sourceUri
    );
    const renderOnlyChatEntry = renderOnlyEntry.replace("main.typ", "main-chat-720.typ");
    const directChat = await client.previewRenderer({
      ...renderOnly,
      entryUri: renderOnlyChatEntry,
      renderPreset: { kind: "chat", widthPt: 720 },
      files: [digestedFile(renderOnlyChatEntry, "#text(\"render-only chat\")")]
    }, renderOnlyMount, options);
    const directChatRegistration = transports.at(-1).sent.findLast((message) => message.params?.action === "register");
    assert.equal(directChatRegistration.params.entryUri, directBaseEntry);
    assert.equal(directChatRegistration.params.renderEntryUri, directChat.synchronized.project.entryUri);
    client.syncProject(renderOnly);
    assert.equal(client.projectForEntry(renderOnlyEntry)?.revision, 1);
    assert.equal(
      client.projectForEntry(directBaseEntry),
      undefined,
      `${kind} retained the renderer-only compiler after language ownership arrived`
    );
    const ownedOnly = await client.previewRenderer({
      ...renderOnly, sourceUri: "logical-source:render-only-close", projectDigest: "f".repeat(64)
    }, { logicalSourceId: "0".repeat(64) }, options);
    assert.equal(client.closeProject("logical-source:render-only-close", renderOnlyEntry), true);
    assert.equal(
      client.projectForEntry(ownedOnly.synchronized.project.entryUri.replace(/^mmt-preview:/u, "untitled:")),
      undefined
    );
    return kind;
  } finally {
    await client.stop();
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
const previewWorkers = [];
const previewChildren = [];
const previewOwnership = [
  await exercisePreviewCompilerOwnership(
    "worker",
    () => TinymistWorkerClient.start("fixture:preview-worker", "fixture:module", "fixture:wasm", () => {
      const transport = new FakeWorker();
      previewWorkers.push(transport);
      return transport;
    }, 5),
    previewWorkers
  ),
  await exercisePreviewCompilerOwnership(
    "process",
    () => TinymistProcessClient.start("fixture-preview-process", 5, () => {
      const transport = new FakeChild();
      previewChildren.push(transport);
      return transport;
    }),
    previewChildren
  )
];
console.log(JSON.stringify({
  checked: true,
  transports: actual.lifecycle.map((item) => item.kind),
  previewCompilerOwnership: previewOwnership
}));
