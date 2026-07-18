import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const registrations = [];
const disposed = [];
const document = {
  languageId: "typst",
  uri: { toString: () => "logical:/unicode.typ" },
  version: 1,
  getText: () => "中😀abc\n= Parent\n== Child"
};
globalThis.__navigationVscode = {
  languages: Object.fromEntries([
    ["registerDefinitionProvider", "definition"],
    ["registerTypeDefinitionProvider", "typeDefinition"],
    ["registerImplementationProvider", "implementation"],
    ["registerReferenceProvider", "references"],
    ["registerDocumentSymbolProvider", "documentSymbols"],
    ["registerWorkspaceSymbolProvider", "workspaceSymbols"],
    ["registerDocumentHighlightProvider", "highlights"]
  ].map(([name, kind]) => [name, (...args) => {
    const provider = kind === "workspaceSymbols" ? args[0] : args[1];
    const entry = { kind, provider, disposed: false };
    registrations.push(entry);
    return { dispose() { entry.disposed = true; disposed.push(kind); } };
  }])),
  workspace: { textDocuments: [document] },
  window: { activeTextEditor: { document } }
};

const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/tinymistCapabilities.ts';",
      "export * from './src/typstFeatureRouter.ts';",
      "export * from './src/typstNavigationProviders.ts';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "navigation-provider-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent",
  plugins: [{
    name: "navigation-vscode-mock",
    setup(plugin) {
      plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "navigation-mock" }));
      plugin.onLoad({ filter: /.*/, namespace: "navigation-mock" }, () => ({
        contents: "export const languages = globalThis.__navigationVscode.languages; export const workspace = globalThis.__navigationVscode.workspace; export const window = globalThis.__navigationVscode.window;",
        loader: "js"
      }));
    }
  }]
});
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { TinymistCapabilityRegistry, TypstFeatureRouter, TypstNavigationProviders } = runtime;

const registry = new TinymistCapabilityRegistry();
let project = projectFixture(1, "content-1", "project-1");
let backendRequest = async () => null;
const backend = {
  backendGeneration: () => registry.generation,
  capabilities: () => registry,
  on() {},
  request: (method, params, signal) => backendRequest(method, params, signal),
  syncProject(update) { project = update; },
  closeProject() { return false; },
  projectForEntry(uri) { return uri === project.entryUri ? project : undefined; },
  async stop() {},
  terminate() {}
};
const converter = {
  code2ProtocolConverter: {
    asPosition: (position) => ({ line: position.line, character: position.character }),
    asWorkspaceSymbol: (symbol) => ({ ...symbol, location: symbol.location })
  },
  protocol2CodeConverter: {
    asDefinitionResult: async (value) => value,
    asReferences: async (value) => value,
    asDocumentHighlights: async (value) => value,
    asDocumentSymbols: async (value) => value,
    asSymbolInformations: async (value) => value,
    asSymbolInformation: (value) => value
  }
};
const router = new TypstFeatureRouter(backend, () => converter, { backendEncoding: "utf-8" });
router.open(routerDocument(document));
const family = new TypstNavigationProviders(router, converter, "native");

registry.install(1, { capabilities: {} });
registry.register(1, [{ id: "dynamic-definition", method: "textDocument/definition" }]);
family.reconcile();
assert.deepEqual(registrations.filter((item) => !item.disposed).map((item) => item.kind), ["definition"]);
registry.unregister(1, [{ id: "dynamic-definition", method: "textDocument/definition" }]);
family.reconcile();
assert.equal(registrations.at(-1).disposed, true, "dynamic unregister left a provider installed");

registry.install(2, { capabilities: {
  definitionProvider: true,
  referencesProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: { resolveProvider: true },
  documentHighlightProvider: true
} });
project = projectFixture(1, "content-1", "project-1");
family.reconcile();
assert.deepEqual(
  registrations.filter((item) => !item.disposed).map((item) => item.kind).sort(),
  ["definition", "documentSymbols", "highlights", "references", "workspaceSymbols"]
);
assert.equal(registrations.some((item) => item.kind === "typeDefinition"), false, "absent typeDefinition registered");
assert.equal(registrations.some((item) => item.kind === "implementation"), false, "absent implementation registered");

let projectedBackendCalled = false;
backendRequest = async () => { projectedBackendCalled = true; return null; };
const projectedAttempt = await router.standaloneProvider(
  "native",
  "textDocument/definition",
  { ...routerDocument(document), languageId: "mmt" },
  { textDocument: { uri: document.uri.toString() }, position: { line: 0, character: 3 } },
  cancellationToken()
);
assert.equal(projectedAttempt, undefined, "standalone navigation enabled a projected provider");
assert.equal(projectedBackendCalled, false, "projected navigation reached Tinymist before mapping qualification");

const definitionProvider = active("definition");
let capturedPosition;
backendRequest = async (method, params) => {
  assert.equal(method, "textDocument/definition");
  capturedPosition = params.position;
  return [
    { uri: project.entryUri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } } },
    { uri: project.entryUri, range: { start: { line: 0, character: 10 }, end: { line: 0, character: 10 } } }
  ];
};
const convertedDefinitions = await definitionProvider.provideDefinition(document, { line: 0, character: 3 }, cancellationToken());
assert.deepEqual(capturedPosition, { line: 0, character: 7 }, "UTF-16 input bypassed backend UTF-8 conversion");
assert.deepEqual(convertedDefinitions.map((item) => item.range), [
  { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } },
  { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } }
]);

const referencesProvider = active("references");
backendRequest = async () => [
  { uri: project.entryUri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } } },
  { uri: project.entryUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } } }
];
const references = await referencesProvider.provideReferences(
  document,
  { line: 0, character: 3 },
  { includeDeclaration: true },
  cancellationToken()
);
assert.equal(references.length, 2, "multi-location references were truncated");

const symbolProvider = active("documentSymbols");
backendRequest = async () => [{
  name: "Parent",
  kind: 13,
  range: { start: { line: 1, character: 0 }, end: { line: 2, character: 8 } },
  selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
  children: [{
    name: "Child",
    kind: 13,
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } },
    selectionRange: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } }
  }]
}];
const symbols = await symbolProvider.provideDocumentSymbols(document, cancellationToken());
assert.equal(symbols[0].children[0].name, "Child", "document symbol hierarchy was flattened");

const workspaceProvider = active("workspaceSymbols");
backendRequest = async (method, params) => {
  if (method === "workspace/symbol") {
    return [{
      name: "abc",
      kind: 13,
      location: { uri: project.entryUri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } } },
      data: { backend: "opaque" }
    }];
  }
  assert.equal(method, "workspaceSymbol/resolve");
  assert.deepEqual(params.data, { backend: "opaque" }, "host resolve metadata leaked to the backend");
  return { ...params, detail: "resolved" };
};
const workspaceSymbols = await workspaceProvider.provideWorkspaceSymbols("abc", cancellationToken());
assert.equal(workspaceSymbols.length, 1, "workspace symbol response was lost");
const resolvedWorkspaceSymbol = await workspaceProvider.resolveWorkspaceSymbol(workspaceSymbols[0], cancellationToken());
assert.equal(resolvedWorkspaceSymbol.detail, "resolved", "qualified workspace symbol resolve did not run");

let resolveStale;
backendRequest = () => new Promise((resolve) => { resolveStale = resolve; });
const stalePromise = definitionProvider.provideDefinition(document, { line: 0, character: 3 }, cancellationToken());
document.version = 2;
project = projectFixture(2, "content-2", "project-2");
router.change(routerDocument(document));
resolveStale([{ uri: project.entryUri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } } }]);
assert.equal(await stalePromise, undefined, "stale dependency/project response was published");

document.version = 3;
project = projectFixture(3, "content-3", "project-3");
router.change(routerDocument(document));
let resolveUnregistered;
backendRequest = () => new Promise((resolve) => { resolveUnregistered = resolve; });
const unregisteredPromise = active("definition").provideDefinition(document, { line: 0, character: 3 }, cancellationToken());
registry.install(3, { capabilities: { referencesProvider: true } });
family.reconcile();
resolveUnregistered([{ uri: project.entryUri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } } }]);
assert.equal(await unregisteredPromise, undefined, "capability-unregister race published a response");

registry.install(4, { capabilities: { referencesProvider: true } });
family.reconcile();
document.version = 4;
project = projectFixture(4, "content-4", "project-4");
router.change(routerDocument(document));
const cancellable = cancellationToken();
backendRequest = (_method, _params, signal) => new Promise((resolve, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const cancelledPromise = active("references").provideReferences(
  document,
  { line: 0, character: 3 },
  { includeDeclaration: true },
  cancellable
);
cancellable.cancel();
assert.equal(await cancelledPromise, undefined, "cancelled reference request was published");

registry.clear(4);
family.reconcile();
assert.equal(registrations.filter((item) => !item.disposed).length, 0, "restart clear left registrations active");
family.dispose();
console.log(JSON.stringify({
  dynamicAbsentAndUnregister: true,
  restartClear: true,
  staleAndCapabilityRace: true,
  cancellation: true,
  multiLocation: references.length,
  symbolHierarchy: "Parent/Child",
  backendPosition: capturedPosition,
  clientRange: convertedDefinitions[0].range,
  disposed: disposed.length
}, null, 2));

function projectFixture(version, sourceContent, projectDigest) {
  return {
    sourceUri: "logical:/unicode.typ",
    sourceVersion: version,
    revision: version,
    entryUri: "logical:/unicode.typ",
    full: true,
    files: [{ uri: "logical:/unicode.typ", text: document.getText() }],
    sourceContent,
    projectDigest,
    projectionKey: `projection-${version}`,
    mappingDigest: `mapping-${version}`
  };
}

function routerDocument(value) {
  return {
    languageId: value.languageId,
    uri: value.uri.toString(),
    version: value.version,
    text: value.getText()
  };
}

function active(kind) {
  const entry = registrations.findLast((item) => item.kind === kind && !item.disposed);
  assert(entry, `${kind} provider is not active`);
  return entry.provider;
}

function cancellationToken() {
  let cancelled = false;
  const listeners = new Set();
  return {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
    }
  };
}
