import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vscodeStub = `
export const __host = {
  registrations: [],
  contentProviders: [],
  diagnosticCollections: [],
  documents: [],
  opened: [],
  changed: [],
  closed: []
};
function disposable(dispose) { return { dispose }; }
function registration(kind, selector, provider, metadata) {
  const value = { kind, selector, provider, metadata, disposed: false };
  value.dispose = () => { value.disposed = true; };
  __host.registrations.push(value);
  return value;
}
export const languages = {
  createDiagnosticCollection(name) {
    const value = {
      name,
      sets: [],
      deletes: [],
      set(uri, diagnostics) { this.sets.push({ uri: uri.toString(), diagnostics }); },
      delete(uri) { this.deletes.push(uri.toString()); },
      dispose() { this.disposed = true; }
    };
    __host.diagnosticCollections.push(value);
    return value;
  },
  registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
    return registration("completion", selector, provider, { triggerCharacters });
  },
  registerHoverProvider(selector, provider) {
    return registration("hover", selector, provider, {});
  },
  registerSignatureHelpProvider(selector, provider, metadata) {
    return registration("signatureHelp", selector, provider, metadata);
  },
  registerDocumentSemanticTokensProvider(selector, provider, legend) {
    return registration("semanticTokens", selector, provider, { legend });
  },
  registerDefinitionProvider(selector, provider) { return registration("definition", selector, provider, {}); },
  registerTypeDefinitionProvider(selector, provider) { return registration("typeDefinition", selector, provider, {}); },
  registerImplementationProvider(selector, provider) { return registration("implementation", selector, provider, {}); },
  registerReferenceProvider(selector, provider) { return registration("references", selector, provider, {}); },
  registerDocumentSymbolProvider(selector, provider) { return registration("documentSymbols", selector, provider, {}); },
  registerWorkspaceSymbolProvider(provider) { return registration("workspaceSymbols", [], provider, {}); },
  registerDocumentHighlightProvider(selector, provider) { return registration("highlights", selector, provider, {}); }
};
export const workspace = {
  get textDocuments() { return __host.documents; },
  registerTextDocumentContentProvider(scheme, provider) {
    const value = { scheme, provider, disposed: false };
    __host.contentProviders.push(value);
    return disposable(() => { value.disposed = true; });
  },
  onDidOpenTextDocument(handler) { __host.opened.push(handler); return disposable(() => {}); },
  onDidChangeTextDocument(handler) { __host.changed.push(handler); return disposable(() => {}); },
  onDidCloseTextDocument(handler) { __host.closed.push(handler); return disposable(() => {}); }
};
export const Uri = { parse(value) { return { toString: () => value }; } };
export const window = { activeTextEditor: undefined, setStatusBarMessage() {} };
export class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}
export class Disposable {
  constructor(call) { this.call = call; }
  dispose() { this.call(); }
}
`;
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/tinymistCapabilities.ts';",
      "export * from './src/tinymistHostSession.ts';",
      "export * from './src/tinymistRequestDispatcher.ts';",
      "export * from './src/typstFeatureRouter.ts';",
      "export * from './src/typstFeatures.ts';",
      "export { __host } from 'vscode';"
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
  logLevel: "silent",
  plugins: [{
    name: "vscode-fixture",
    setup(context) {
      context.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
      context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: vscodeStub, loader: "js" }));
    }
  }],
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const {
  __host,
  connectTypstBackend,
  installTypstMiddleware,
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
  (envelope, signal) => {
    const gate = Promise.withResolvers();
    const abort = () => gate.reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    captured.push(envelope);
    pending.push({ envelope, resolve: gate.resolve, reject: gate.reject });
    return gate.promise;
  },
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

assert.equal(requestDispatcher.activeRequestScopeCount(), 0, "completed requests retained sequence scopes");
const growthDispatcher = new TinymistRequestDispatcher(
  async () => null,
  (capturedIdentity) => capturedIdentity
);
for (let index = 0; index < 256; index += 1) {
  const identity = {
    ...baseIdentity,
    sourceContent: `source-content-${index}`,
    sourceStaleToken: {
      ...baseIdentity.sourceStaleToken,
      hostUri: `file:///workspace/growth-${index}.typ`
    }
  };
  await growthDispatcher.request("textDocument/hover", {}, identity);
}
assert.equal(growthDispatcher.activeRequestScopeCount(), 0, "settled content snapshots grew sequence state");

let retirementGate = Promise.withResolvers();
const retirementDispatcher = new TinymistRequestDispatcher(
  () => retirementGate.promise,
  (capturedIdentity) => capturedIdentity
);
const retiredByClose = retirementDispatcher.request("textDocument/hover", {}, baseIdentity);
assert.equal(retirementDispatcher.activeRequestScopeCount(), 1);
retirementDispatcher.retireHost(baseIdentity.sourceStaleToken.hostUri);
assert.equal(retirementDispatcher.activeRequestScopeCount(), 0);
retirementGate.resolve(null);
await assert.rejects(
  retiredByClose,
  (error) => error instanceof TinymistDispatchError && error.code === "SupersededSequence"
);

const nextGenerationIdentity = {
  ...baseIdentity,
  backendGeneration: 5,
  sourceStaleToken: { ...baseIdentity.sourceStaleToken, hostUri: "file:///workspace/generation.typ" }
};
retirementGate = Promise.withResolvers();
const retiredByGeneration = retirementDispatcher.request("textDocument/hover", {}, nextGenerationIdentity);
retirementDispatcher.retireGenerationsExcept(6);
assert.equal(retirementDispatcher.activeRequestScopeCount(), 0);
retirementGate.resolve(null);
await assert.rejects(
  retiredByGeneration,
  (error) => error instanceof TinymistDispatchError && error.code === "SupersededSequence"
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
const fixedQualifiedProviderMethods = [
  "textDocument/definition",
  "textDocument/references",
  "textDocument/prepareRename",
  "textDocument/rename",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/documentSymbol",
  "workspace/symbol",
  "textDocument/documentHighlight",
  "textDocument/selectionRange",
  "textDocument/documentLink",
  "textDocument/documentColor",
  "textDocument/colorPresentation",
  "textDocument/codeAction",
  "textDocument/inlayHint"
];
assert.deepEqual(nativeProviderRouter.providerRegistrations("native").map((item) => item.descriptor.method),
  fixedQualifiedProviderMethods, "native provider registrations diverged from checked qualification");
assert.deepEqual(webProviderRouter.providerRegistrations("web").map((item) => item.descriptor.method),
  fixedQualifiedProviderMethods, "Web provider registrations diverged from checked qualification");
assert.equal(
  nativeProviderRouter.providerCapability("native", "textDocument/definition").kind,
  "QualifiedProvider",
  "checked navigation qualification was not installed"
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

const hostRegistry = new TinymistCapabilityRegistry();
hostRegistry.install(20, {
  capabilities: {
    completionProvider: { triggerCharacters: ["#", "."] },
    signatureHelpProvider: { triggerCharacters: ["("], retriggerCharacters: [","] }
  }
});
hostRegistry.register(20, [{ id: "host-hover", method: "textDocument/hover" }]);
const hostEvents = new Map();
const hostDocument = {
  languageId: "typst",
  uri: { toString: () => "file:///workspace/host.typ" },
  version: 1,
  getText: () => "abc"
};
const hostProjects = new Map([["file:///workspace/host.typ", {
  sourceUri: "file:///workspace/host.typ",
  sourceVersion: 1,
  revision: 1,
  entryUri: "file:///workspace/host.typ",
  files: [{ uri: "file:///workspace/host.typ", text: "abc" }],
  full: true,
  sourceContent: "source-host",
  projectDigest: "project-host-a",
  projectionKey: "projection-host",
  mappingDigest: "mapping-host"
}]]);
const hostBackend = {
  capabilities: () => hostRegistry,
  backendGeneration: () => 20,
  semanticTokensLegend() {
    const options = hostRegistry.get("textDocument/semanticTokens/full")
      ?.dynamicRegistrations.at(-1)?.registerOptions;
    return options?.legend;
  },
  on(method, handler) {
    const handlers = hostEvents.get(method) ?? [];
    handlers.push(handler);
    hostEvents.set(method, handlers);
    return {
      dispose() {
        const current = hostEvents.get(method) ?? [];
        const remaining = current.filter((candidate) => candidate !== handler);
        if (remaining.length === 0) hostEvents.delete(method);
        else hostEvents.set(method, remaining);
      }
    };
  },
  projectForEntry: (entryUri) => hostProjects.get(entryUri),
  request: async (method) => method === "textDocument/semanticTokens/full"
    ? { data: [0, 0, 1, 2, 0] }
    : null,
  syncProject(update) {
    const contentProvider = __host.contentProviders.find((item) => item.scheme === "mmt-projection" && !item.disposed);
    const retainedUri = update.entryUri.replace(/^[^:]+:/, "mmt-projection:");
    assert.equal(
      contentProvider.provider.provideTextDocumentContent({ toString: () => retainedUri }),
      update.files.find((file) => file.uri === update.entryUri).text,
      "projection bytes were not retained before backend sync"
    );
    hostProjects.set(update.entryUri, update);
  },
  closeProject() { return true; }
};
const diagnosticsGate = Promise.withResolvers();
const diagnosticsStarted = Promise.withResolvers();
const notificationHandlers = new Map();
const hostClient = {
  onNotification(method, handler) {
    notificationHandlers.set(method, handler);
    return { dispose() {} };
  },
  sendRequest: async () => null,
  code2ProtocolConverter: { asPosition: (position) => position },
  protocol2CodeConverter: {
    asCompletionResult: async (value) => value,
    asHover: (value) => value,
    asSignatureHelp: async (value) => value,
    asSemanticTokens: async (value) => value,
    asDiagnostics(value) {
      diagnosticsStarted.resolve();
      return diagnosticsGate.promise.then(() => value);
    }
  }
};
__host.documents.splice(0, __host.documents.length, hostDocument);
const hostOptions = { documentSelector: [{ language: "mmt" }, { language: "typst" }] };
installTypstMiddleware(hostOptions, hostBackend, () => hostClient);
assert.deepEqual(hostOptions.documentSelector, [{ language: "mmt" }], "MMT client retained standalone Typst providers");
const hostDisposables = connectTypstBackend(hostClient, hostBackend, "native");
assert.deepEqual(
  __host.contentProviders.map((item) => item.scheme).sort(),
  ["mmt-package", "mmt-projection"],
  "virtual Typst content providers were not registered"
);
const retainedUpdate = {
  sourceUri: "file:///workspace/host.typ",
  sourceVersion: 2,
  revision: 2,
  entryUri: "untitled:/mmt-projection/host/main-2.typ",
  files: [{ uri: "untitled:/mmt-projection/host/main-2.typ", text: "retained projection" }],
  full: true,
  sourceContent: "source-host-2",
  projectDigest: "project-host-2",
  projectionKey: "projection-host-2",
  mappingDigest: "mapping-host-2"
};
notificationHandlers.get("mmt/typstProjectUpdated")(retainedUpdate);
const projectionContentProvider = __host.contentProviders.find((item) => item.scheme === "mmt-projection").provider;
const retainedReadUri = { toString: () => "mmt-projection:/mmt-projection/host/main-2.typ" };
assert.equal(
  projectionContentProvider.provideTextDocumentContent(retainedReadUri),
  "retained projection",
  "accepted project update was not readable from the retained content provider"
);
notificationHandlers.get("mmt/typstProjectClosed")({
  sourceUri: retainedUpdate.sourceUri,
  entryUri: retainedUpdate.entryUri
});
assert.throws(
  () => projectionContentProvider.provideTextDocumentContent(retainedReadUri),
  /not retained/,
  "closed projection source remained readable"
);
const activeHostRegistrations = () => __host.registrations.filter((registration) => !registration.disposed);
assert.deepEqual(
  activeHostRegistrations().map((registration) => registration.kind).sort(),
  ["completion", "hover", "signatureHelp"],
  "semantic tokens registered before the dynamic legend was available"
);
assert.deepEqual(
  activeHostRegistrations().find((registration) => registration.kind === "completion").metadata.triggerCharacters,
  ["#", "."]
);
assert.deepEqual(
  activeHostRegistrations().find((registration) => registration.kind === "signatureHelp").metadata,
  { triggerCharacters: ["("], retriggerCharacters: [","] }
);
hostRegistry.register(20, [{
  id: "host-semantic-tokens",
  method: "textDocument/semanticTokens",
  registerOptions: {
    full: true,
    legend: {
      tokenTypes: ["comment", "string", "keyword", "operator"],
      tokenModifiers: ["declaration", "readonly"]
    }
  }
}]);
for (const handler of hostEvents.get("tinymist/capabilitiesChanged")) {
  handler({ generation: 20, capabilities: hostRegistry.list() });
}
assert.deepEqual(
  activeHostRegistrations().map((registration) => registration.kind).sort(),
  ["completion", "hover", "semanticTokens", "signatureHelp"],
  "dynamic semantic-token legend did not activate the VS Code provider"
);
const semanticRegistration = activeHostRegistrations().find((registration) => registration.kind === "semanticTokens");
assert.deepEqual(
  semanticRegistration.metadata.legend.tokenTypes,
  ["comment", "string", "keyword", "operator"],
  "standalone provider used the MMT semantic-token legend"
);
const hostToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
assert.deepEqual(
  await semanticRegistration.provider.provideDocumentSemanticTokens(hostDocument, hostToken),
  { data: [0, 0, 1, 2, 0] },
  "standalone semantic tokens were not decoded against the registered Tinymist legend"
);

hostRegistry.unregister(20, [{ id: "host-hover", method: "textDocument/hover" }]);
for (const handler of hostEvents.get("tinymist/capabilitiesChanged")) {
  handler({ generation: 20, capabilities: hostRegistry.list() });
}
assert.equal(
  activeHostRegistrations().some((registration) => registration.kind === "hover"),
  false,
  "dynamic capability unregistration left a VS Code hover provider registered"
);
hostRegistry.register(20, [{
  id: "host-completion-triggers",
  method: "textDocument/completion",
  registerOptions: { triggerCharacters: ["@"] }
}]);
for (const handler of hostEvents.get("tinymist/capabilitiesChanged")) {
  handler({ generation: 20, capabilities: hostRegistry.list() });
}
assert.deepEqual(
  activeHostRegistrations().find((registration) => registration.kind === "completion").metadata.triggerCharacters,
  ["#", ".", "@"],
  "dynamic completion trigger metadata was not applied to the host registration"
);

for (const handler of hostEvents.get("textDocument/publishDiagnostics")) {
  handler({
    uri: "file:///workspace/host.typ",
    version: 1,
    diagnostics: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      message: "stale"
    }]
  });
}
await diagnosticsStarted.promise;
hostProjects.set("file:///workspace/host.typ", {
  ...hostProjects.get("file:///workspace/host.typ"),
  projectDigest: "project-host-b"
});
diagnosticsGate.resolve();
const eventLoopTurn = Promise.withResolvers();
setImmediate(eventLoopTurn.resolve);
await eventLoopTurn.promise;
assert.equal(
  __host.diagnosticCollections[0].sets.length,
  0,
  "diagnostics converted after a project graph change were published"
);
for (const disposable of hostDisposables) disposable.dispose();
assert(__host.contentProviders.every((item) => item.disposed), "virtual content providers survived backend disposal");

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
let routedDefaultEditRange = {
  insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
};
const routedBackend = {
  capabilities: () => qualifiedRegistry,
  backendGeneration: () => 12,
  projectForEntry: (entryUri) => routedProjects.get(entryUri),
  request: async (method, params) => {
    routedBackendCalls.push({ method, params: structuredClone(params) });
    return {
      isIncomplete: true,
      itemDefaults: { commitCharacters: ["."], editRange: routedDefaultEditRange },
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
    if (method === "mmt/mapTypstCompletion") {
      return params.items.map((item) => item.textEdit?.newText === ""
        ? {
            ...item,
            textEdit: {
              newText: "",
              insert: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
              replace: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }
            }
          }
        : item);
    }
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
assert.deepEqual(standaloneResult.itemDefaults, {
  commitCharacters: ["."],
  editRange: {
    insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  }
});
assert.deepEqual(projectedResult.itemDefaults, {
  commitCharacters: ["."],
  editRange: {
    insert: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
    replace: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }
  }
});
assert.deepEqual(projectedResult.items[0].data, { resolve: "kept" });
routedDefaultEditRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 99 }
};
await assert.rejects(
  routedRouter.completion(
    embeddedDocument,
    { line: 0, character: 3 },
    { triggerKind: 1 },
    routedToken
  ),
  "invalid default editRange was published"
);

console.log(JSON.stringify({
  checked: true,
  nativeCapabilities: nativeRegistry.list().length,
  webDynamicSemanticTokens: true,
  dynamicUnregister: true,
  nativeWebProviderRegistration: true,
  unavailableStateVisible: true,
  standaloneAndProjectedPositionConversion: true,
  completionDefaultsAndResolveDataPreserved: true,
  hostRegistrationsReconciled: true,
  dynamicSemanticLegendPublished: true,
  diagnosticConversionRaceRejected: true,
  completionDefaultEditRangeMapped: true,
  requestScopesRetired: true,
  staleGraphRejected: true,
  cancellationRejected: true,
  sequenceRejected: true
}));
