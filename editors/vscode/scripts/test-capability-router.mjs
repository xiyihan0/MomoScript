import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/tinymistCapabilities.ts';",
      "export * from './src/tinymistHostSession.ts';",
      "export * from './src/tinymistRequestDispatcher.ts';",
      "export * from './src/typstFeatureRouter.ts';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "capability-router-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent"
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const {
  TinymistCapabilityRegistry,
  TinymistDispatchError,
  TinymistHostSession,
  TinymistRequestDispatcher,
  TinymistServerRequestDispatcher,
  TypstFeatureRouter
} = runtime;

const fixtures = path.join(root, "src", "test", "fixtures");
const nativeEvidence = JSON.parse(await readFile(path.join(fixtures, "tinymist-native-evidence.json"), "utf8"));
const webEvidence = JSON.parse(await readFile(path.join(fixtures, "tinymist-web-evidence.json"), "utf8"));

function applyTranscript(dispatcher, generation, transcript) {
  const response = dispatcher.dispatch({
    jsonrpc: "2.0",
    id: `${generation}:register`,
    method: "client/registerCapability",
    params: { registrations: transcript.dynamicRegistrations.register }
  }, generation);
  assert.equal(response.result, null);
}

const nativeRegistry = new TinymistCapabilityRegistry();
nativeRegistry.install(1, nativeEvidence.initialize);
const nativeServerRequests = new TinymistServerRequestDispatcher(nativeRegistry);
applyTranscript(nativeServerRequests, 1, nativeEvidence);
assert.equal(nativeRegistry.has("textDocument/completion"), true);
assert.equal(nativeRegistry.has("textDocument/semanticTokens/full"), true);
assert.equal(
  nativeRegistry.get("textDocument/semanticTokens").dynamicRegistrations.length,
  0,
  "native transcript unexpectedly used dynamic semantic-token registration"
);

const webRegistry = new TinymistCapabilityRegistry();
webRegistry.install(7, webEvidence.initialize);
const webServerRequests = new TinymistServerRequestDispatcher(webRegistry);
applyTranscript(webServerRequests, 7, webEvidence);
assert.equal(webRegistry.has("textDocument/completion"), true);
assert.equal(webRegistry.has("textDocument/semanticTokens"), true);
assert.equal(
  webRegistry.get("textDocument/semanticTokens").dynamicRegistrations.length,
  1,
  "Web semantic-token dynamic registration was not retained"
);
assert.equal(webRegistry.has("textDocument/semanticTokens/full"), true);
assert.equal(
  webRegistry.get("textDocument/semanticTokens/full").dynamicRegistrations.length,
  1,
  "Web dynamic registration did not expose its full-token request method"
);
assert.equal(
  nativeRegistry.get("workspace/executeCommand").initializeOptions.commands.includes("tinymist.scrollPreview"),
  true
);
assert.equal(
  webRegistry.get("workspace/executeCommand").initializeOptions.commands.includes("tinymist.scrollPreview"),
  false,
  "native/Web command capability difference was erased"
);

const registerTypeDefinition = {
  jsonrpc: "2.0",
  id: 10,
  method: "client/registerCapability",
  params: {
    registrations: [{
      id: "type-definition",
      method: "textDocument/typeDefinition",
      registerOptions: { documentSelector: [{ language: "typst" }] }
    }]
  }
};
assert.equal(webServerRequests.dispatch(registerTypeDefinition, 7).result, null);
assert.equal(webRegistry.has("textDocument/typeDefinition"), true);
assert.equal(
  webServerRequests.dispatch({
    jsonrpc: "2.0",
    id: 11,
    method: "client/unregisterCapability",
    params: { unregisterations: [{ id: "type-definition", method: "textDocument/definition" }] }
  }, 7).result,
  null
);
assert.equal(webRegistry.has("textDocument/typeDefinition"), true, "mismatched unregister removed a capability");
assert.equal(
  webServerRequests.dispatch({
    jsonrpc: "2.0",
    id: 12,
    method: "client/unregisterCapability",
    params: { unregistrations: [{ id: "type-definition", method: "textDocument/typeDefinition" }] }
  }, 7).result,
  null
);
assert.equal(webRegistry.has("textDocument/typeDefinition"), false);
webServerRequests.dispatch(registerTypeDefinition, 6);
assert.equal(webRegistry.has("textDocument/typeDefinition"), false, "stale generation mutated capability state");
assert.equal(
  webServerRequests.dispatch({ jsonrpc: "2.0", id: 13, method: "client/registerCapability", params: {} }, 7).error.code,
  -32602
);
assert.equal(
  webServerRequests.dispatch({ jsonrpc: "2.0", id: 14, method: "workspace/unknown" }, 7).error.code,
  -32601
);
assert.equal(webRegistry.clear(6), false);
assert.equal(webRegistry.clear(7), true);
assert.equal(webRegistry.list().length, 0, "generation end retained capabilities");

class FakeTransport {
  generation = 0;
  started = false;
  serverRequest = undefined;
  notification = undefined;
  failure = undefined;

  async start() {
    this.generation += 1;
    this.started = true;
    return { generation: this.generation, initializeResult: webEvidence.initialize };
  }

  async request() {
    return null;
  }

  notify() {}

  onNotification(handler) {
    this.notification = handler;
  }

  onServerRequest(handler) {
    this.serverRequest = handler;
  }

  onFailure(handler) {
    this.failure = handler;
  }

  async stop() {
    this.started = false;
  }

  terminateNow() {
    this.started = false;
  }
}

const hostTransport = new FakeTransport();
const hostSession = new TinymistHostSession({
  label: "capability fixture",
  transport: hostTransport,
  boot: () => hostTransport.start()
});
await hostSession.start();
assert.equal(hostSession.capabilities().generation, 1);
assert.equal(hostSession.capabilities().has("textDocument/completion"), true);
assert.equal(hostTransport.serverRequest(registerTypeDefinition, 1).result, null);
assert.equal(hostSession.capabilities().has("textDocument/typeDefinition"), true);
await hostSession.restart();
assert.equal(hostSession.capabilities().generation, 2);
assert.equal(
  hostSession.capabilities().has("textDocument/typeDefinition"),
  false,
  "host recovery leaked a previous generation dynamic registration"
);
await hostSession.stop();

const baseIdentity = Object.freeze({
  backendGeneration: 4,
  logicalSource: "logical-source-a",
  sourceContent: "source-content-a",
  sourceStaleToken: Object.freeze({
    hostUri: "file:///workspace/main.typ",
    documentIncarnation: "document-9",
    documentVersion: 3
  }),
  projectSnapshot: "project-snapshot-a",
  projectionKey: "projection-a"
});
let currentIdentity = baseIdentity;
const pending = [];
const captured = [];
const requestDispatcher = new TinymistRequestDispatcher(
  (envelope, signal) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    captured.push(envelope);
    pending.push({ envelope, resolve, reject });
  }),
  () => currentIdentity
);

const first = requestDispatcher.request("textDocument/hover", { position: 1 }, baseIdentity);
assert.equal(pending.length, 1);
assert.deepEqual(pending[0].envelope.metadata, { ...baseIdentity, requestSequence: 1 });
pending.shift().resolve("first-result");
assert.equal(await first, "first-result");

const older = requestDispatcher.request("textDocument/hover", { position: 2 }, baseIdentity);
const newer = requestDispatcher.request("textDocument/hover", { position: 3 }, baseIdentity);
assert.deepEqual(pending.map((item) => item.envelope.metadata.requestSequence), [2, 3]);
pending[1].resolve("newer-result");
assert.equal(await newer, "newer-result");
pending[0].resolve("older-result");
await assert.rejects(
  older,
  (error) => error instanceof TinymistDispatchError && error.code === "SupersededSequence"
);
pending.splice(0, 2);

const graphRequest = requestDispatcher.request("textDocument/definition", {}, baseIdentity);
assert.equal(pending.length, 1);
currentIdentity = { ...baseIdentity, projectSnapshot: "project-snapshot-b" };
pending.shift().resolve("stale-graph-result");
await assert.rejects(
  graphRequest,
  (error) => error instanceof TinymistDispatchError && error.code === "StaleProjectSnapshot",
  "unchanged document version accepted a response for an old complete project graph"
);

currentIdentity = baseIdentity;
const generationRequest = requestDispatcher.request("textDocument/references", {}, baseIdentity);
currentIdentity = { ...baseIdentity, backendGeneration: 5 };
pending.shift().resolve([]);
await assert.rejects(
  generationRequest,
  (error) => error instanceof TinymistDispatchError && error.code === "StaleBackendGeneration"
);

currentIdentity = baseIdentity;
const tokenRequest = requestDispatcher.request("textDocument/documentSymbol", {}, baseIdentity);
currentIdentity = {
  ...baseIdentity,
  sourceStaleToken: { ...baseIdentity.sourceStaleToken, documentVersion: 4 }
};
pending.shift().resolve([]);
await assert.rejects(
  tokenRequest,
  (error) => error instanceof TinymistDispatchError && error.code === "StaleDocument"
);

currentIdentity = baseIdentity;
const projectionRequest = requestDispatcher.request("textDocument/documentLink", {}, baseIdentity);
currentIdentity = { ...baseIdentity, projectionKey: "projection-b" };
pending.shift().resolve([]);
await assert.rejects(
  projectionRequest,
  (error) => error instanceof TinymistDispatchError && error.code === "StaleProjection"
);

currentIdentity = baseIdentity;
const controller = new AbortController();
const cancelled = requestDispatcher.request("textDocument/completion", {}, baseIdentity, controller.signal);
assert.equal(pending.length, 1);
controller.abort(new Error("fixture cancellation"));
await assert.rejects(
  cancelled,
  (error) => error instanceof TinymistDispatchError && error.code === "Cancelled"
);
pending.shift();

const distinctHover = requestDispatcher.request("textDocument/hover", { position: 4 }, baseIdentity);
const distinctCompletion = requestDispatcher.request("textDocument/completion", {}, baseIdentity);
const [hoverPending, completionPending] = pending.splice(0, 2);
hoverPending.resolve("hover-result");
completionPending.resolve("completion-result");
assert.deepEqual(await Promise.all([distinctHover, distinctCompletion]), ["hover-result", "completion-result"]);

assert.deepEqual(
  captured.map((envelope) => envelope.metadata.requestSequence),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "request sequence was not strictly monotonic"
);

const nativeProviderRegistry = new TinymistCapabilityRegistry();
nativeProviderRegistry.install(10, nativeEvidence.initialize);
const webProviderRegistry = new TinymistCapabilityRegistry();
webProviderRegistry.install(11, webEvidence.initialize);
applyTranscript(new TinymistServerRequestDispatcher(webProviderRegistry), 11, webEvidence);
const nativeProviderRouter = new TypstFeatureRouter({ capabilities: () => nativeProviderRegistry }, () => ({}));
const webProviderRouter = new TypstFeatureRouter({ capabilities: () => webProviderRegistry }, () => ({}));
const nativeProviderMethods = nativeProviderRouter.registrations().map((registration) => registration.method);
const webProviderMethods = webProviderRouter.registrations().map((registration) => registration.method);
assert.deepEqual(nativeProviderMethods, webProviderMethods, "native/Web qualified baseline provider registrations diverged");
assert.equal(webProviderMethods.includes("textDocument/semanticTokens/full"), true);
assert.deepEqual(
  nativeProviderRouter.capability("textDocument/completion").triggerCharacters,
  webProviderRouter.capability("textDocument/completion").triggerCharacters,
  "native/Web negotiated completion triggers diverged"
);

const qualifiedRegistry = new TinymistCapabilityRegistry();
qualifiedRegistry.install(12, {
  capabilities: {
    completionProvider: { resolveProvider: true, triggerCharacters: ["#", "."] },
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ["("], retriggerCharacters: [","] },
    semanticTokensProvider: { full: true }
  }
});
const providerBackend = {
  capabilities: () => qualifiedRegistry,
  backendGeneration: () => 12,
  projectForEntry: () => undefined,
  request: async () => null
};
const providerRouter = new TypstFeatureRouter(providerBackend, () => ({}));
const registrations = providerRouter.registrations();
assert.deepEqual(
  registrations.map((registration) => registration.method),
  [
    "textDocument/completion",
    "textDocument/hover",
    "textDocument/signatureHelp",
    "textDocument/semanticTokens/full"
  ],
  "qualified provider registration order changed"
);
assert.deepEqual(providerRouter.capability("textDocument/completion"), {
  method: "textDocument/completion",
  triggerCharacters: ["#", "."],
  retriggerCharacters: [],
  resolveProvider: true
});
assert.deepEqual(providerRouter.capability("textDocument/signatureHelp"), {
  method: "textDocument/signatureHelp",
  triggerCharacters: ["("],
  retriggerCharacters: [","],
  resolveProvider: false
});

const unavailableStates = [];
const unavailableRegistry = new TinymistCapabilityRegistry();
unavailableRegistry.install(13, { capabilities: { completionProvider: {} } });
const unavailableRouter = new TypstFeatureRouter(
  {
    capabilities: () => unavailableRegistry,
    backendGeneration: () => 13,
    projectForEntry: () => undefined,
    request: async () => null
  },
  () => ({}),
  { unavailable: (state) => unavailableStates.push(state) }
);
assert.equal(unavailableRouter.registrations().some((item) => item.method === "textDocument/hover"), false);
assert.equal(unavailableRouter.capability("textDocument/hover").kind, "CapabilityUnavailable");
assert.equal(unavailableStates.length, 1, "unavailable state was not visible exactly once");

const routedProjects = new Map([
  ["logical:/unicode.typ", {
    sourceUri: "logical:/unicode.typ",
    sourceVersion: 1,
    revision: 1,
    entryUri: "logical:/unicode.typ",
    files: [{ uri: "logical:/unicode.typ", text: "中😀a" }],
    full: true,
    sourceContent: "source-standalone",
    projectDigest: "project-standalone",
    projectionKey: "projection-standalone",
    mappingDigest: "mapping-standalone"
  }],
  ["logical:/embedded-2.typ", {
    sourceUri: "logical:/embedded.mmt",
    sourceVersion: 2,
    revision: 2,
    entryUri: "logical:/embedded-2.typ",
    files: [{ uri: "logical:/embedded-2.typ", text: "a😀b" }],
    full: true,
    sourceContent: "source-embedded",
    projectDigest: "project-embedded",
    projectionKey: "projection-embedded",
    mappingDigest: "mapping-embedded"
  }]
]);
const routedBackendCalls = [];
const routedBackend = {
  capabilities: () => qualifiedRegistry,
  backendGeneration: () => 12,
  projectForEntry: (entryUri) => routedProjects.get(entryUri),
  request: async (method, params) => {
    routedBackendCalls.push({ method, params: structuredClone(params) });
    return {
      isIncomplete: true,
      itemDefaults: { commitCharacters: ["."] },
      items: [{ label: params.textDocument.uri, data: { resolve: "kept" } }]
    };
  }
};
const routedClient = {
  sendRequest: async (method, params) => {
    if (method === "mmt/typstPosition") {
      return {
        entryUri: "logical:/embedded-2.typ",
        revision: 2,
        position: { line: 0, character: 5 },
        positionEncoding: "utf-8",
        sourceContent: "source-embedded",
        projectDigest: "project-embedded",
        projectionKey: "projection-embedded"
      };
    }
    if (method === "mmt/mapTypstCompletion") return params.items;
    throw new Error(`unexpected routed client request: ${method}`);
  }
};
const routedRouter = new TypstFeatureRouter(routedBackend, () => routedClient, { backendEncoding: "utf-8" });
const routedToken = { onCancellationRequested: () => ({ dispose() {} }) };
const standaloneDocument = { languageId: "typst", uri: "logical:/unicode.typ", version: 1, text: "中😀a" };
const embeddedDocument = { languageId: "mmt", uri: "logical:/embedded.mmt", version: 2, text: "x😀y" };
routedRouter.open(standaloneDocument);
routedRouter.open(embeddedDocument);
const standaloneResult = await routedRouter.completion(
  standaloneDocument,
  { line: 0, character: 3 },
  { triggerKind: 1 },
  routedToken
);
const projectedResult = await routedRouter.completion(
  embeddedDocument,
  { line: 0, character: 3 },
  { triggerKind: 1 },
  routedToken
);
assert.equal(routedBackendCalls[0].params.position.character, 7, "standalone UTF-16 position was not converted to UTF-8");
assert.equal(routedBackendCalls[1].params.position.character, 5, "projected lookup position was not retained in backend encoding");
assert.deepEqual(standaloneResult.itemDefaults, { commitCharacters: ["."] });
assert.deepEqual(projectedResult.itemDefaults, { commitCharacters: ["."] });
assert.deepEqual(projectedResult.items[0].data, { resolve: "kept" });

console.log(JSON.stringify({
  checked: true,
  nativeCapabilities: nativeRegistry.list().length,
  webDynamicSemanticTokens: true,
  dynamicUnregister: true,
  nativeWebProviderRegistration: true,
  unavailableStateVisible: true,
  standaloneAndProjectedPositionConversion: true,
  completionDefaultsAndResolveDataPreserved: true,
  staleGraphRejected: true,
  cancellationRejected: true,
  sequenceRejected: true
}));
