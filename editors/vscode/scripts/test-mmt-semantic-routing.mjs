import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vscodeFixture = {
  workspace: {
    textDocuments: [],
    async applyEdit() { return false; },
  },
  Disposable: class {
    constructor(call) { this.call = call; }
    dispose() { this.call(); }
  },
};
globalThis.__mmtSemanticRoutingVscode = vscodeFixture;

const bundle = await build({
  stdin: {
    contents: [
      "export { installMmtSemanticMiddleware, connectMmtProjectedSemanticDispatcher } from './src/mmtSemanticMiddleware.ts';",
      "export { TypstFeatureRouter } from './src/typstFeatureRouter.ts';",
    ].join("\n"),
    resolveDir: root,
    sourcefile: "mmt-semantic-routing-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent",
  plugins: [{
    name: "vscode-semantic-routing-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^vscode$/ }, () => ({
        path: "vscode-semantic-routing",
        namespace: "fixture",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: [
          "export const workspace = globalThis.__mmtSemanticRoutingVscode.workspace;",
          "export const Disposable = globalThis.__mmtSemanticRoutingVscode.Disposable;",
        ].join("\n"),
        loader: "js",
      }));
    },
  }],
});
const {
  connectMmtProjectedSemanticDispatcher,
  installMmtSemanticMiddleware,
  TypstFeatureRouter,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const sourceUri = "file:///workspace/story.mmt";
const entryUri = "untitled:/mmt-projection/story/main-7.typ";
const tinymistEntryAlias = entryUri.replace("untitled:/", "untitled:");
const source = "@alice: #accent\n";
const project = Object.freeze({
  sourceUri,
  entryUri,
  sourceVersion: 4,
  revision: 7,
  full: true,
  files: Object.freeze([{ uri: entryUri, text: "#let accent = blue\n#accent" }]),
  sourceContent: "source-v4",
  projectDigest: "project-v4",
  projectionKey: "projection-v4",
});
const document = Object.freeze({
  languageId: "mmt",
  uri: { toString: () => sourceUri },
  version: 4,
  getText: (range) => range ? source.slice(range.start.character, range.end.character) : source,
});
const typstDocument = Object.freeze({
  languageId: "typst",
  uri: { toString: () => "file:///workspace/main.typ" },
  version: 1,
  getText: () => "#accent",
});
const position = Object.freeze({ line: 0, character: 9 });
const token = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested() { return { dispose() {} }; },
});

let route = "none";
const clientCalls = [];
const converter = {
  asPosition: (value) => ({ line: value.line, character: value.character }),
  asDefinitionResult: async (value) => value,
  asReferences: async (value) => value,
};
const client = {
  code2ProtocolConverter: converter,
  protocol2CodeConverter: converter,
  async sendRequest(method, params) {
    clientCalls.push({ method, params: structuredClone(params) });
    if (method === "mmt/semanticRoute") return route;
    if (method === "mmt/typstPosition") {
      return {
        entryUri,
        revision: 7,
        position: { line: 1, character: 2 },
        positionEncoding: "utf-16",
        sourceContent: "source-v4",
        projectDigest: "project-v4",
        projectionKey: "projection-v4",
      };
    }
    if (method === "mmt/mapTypstReadLocations") {
      return params.locations.map(() => ({
        kind: "authoredIdentity",
        uri: sourceUri,
        range: {
          start: { line: 0, character: 8 },
          end: { line: 0, character: 14 },
        },
      }));
    }
    throw new Error(`unexpected client request: ${method}`);
  },
};

const advertised = new Map([
  ["textDocument/definition", true],
  ["textDocument/references", true],
].map(([method, initializeOptions]) => [
  method,
  Object.freeze({ method, initializeOptions, dynamicRegistrations: Object.freeze([]) }),
]));
const backendCalls = [];
const backend = {
  capabilities() {
    return {
      generation: 3,
      has: (method) => advertised.has(method),
      get: (method) => advertised.get(method),
      list: () => [...advertised.values()],
    };
  },
  backendGeneration() { return 3; },
  projectForEntry(uri) { return uri === entryUri ? project : undefined; },
  async request(method, params) {
    backendCalls.push({ method, params: structuredClone(params) });
    if (method === "textDocument/definition") {
      return {
        targetUri: tinymistEntryAlias,
        targetRange: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 11 },
        },
        targetSelectionRange: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 11 },
        },
        originSelectionRange: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 7 },
        },
      };
    }
    if (method === "textDocument/references") {
      return [{
        uri: tinymistEntryAlias,
        range: {
          start: { line: 0, character: 1 },
          end: { line: 0, character: 7 },
        },
      }];
    }
    throw new Error(`unexpected backend request: ${method}`);
  },
};

const router = new TypstFeatureRouter(backend, () => client);
router.open({ languageId: "mmt", uri: sourceUri, version: 4, text: source });
const dispatcher = connectMmtProjectedSemanticDispatcher(
  backend,
  router,
  client,
  "web",
  { packageContent: () => undefined },
);
const options = {};
installMmtSemanticMiddleware(options, () => client, backend);
const middleware = options.middleware;
assert.ok(middleware, "semantic middleware was not installed");

route = "native";
let nativeCalls = 0;
const nativeNull = await middleware.provideDefinition(document, position, token, async () => {
  nativeCalls += 1;
  return null;
});
assert.equal(nativeNull, null, "a native null result must not fall through to projected Typst");
assert.equal(nativeCalls, 1);
assert.equal(backendCalls.length, 0);
assert.equal(
  await middleware.prepareRename(document, position, token, async () => null),
  null,
  "a native prepare-rename rejection must not fall through to projected Typst",
);
assert.equal(
  await middleware.provideRenameEdits(document, position, "renamed", token, async () => null),
  null,
  "a native rename rejection must not fall through to projected Typst",
);
assert.equal(backendCalls.length, 0);

const nativeFailure = new Error("native failure");
await assert.rejects(
  middleware.provideReferences(document, position, { includeDeclaration: true }, token, async () => {
    throw nativeFailure;
  }),
  (error) => error === nativeFailure,
  "a native error must not fall through to projected Typst",
);
assert.equal(backendCalls.length, 0);

route = "projected";
const definition = await middleware.provideDefinition(document, position, token, async () => {
  throw new Error("projected definition called the native provider");
});
assert.deepEqual(definition, [{
  uri: sourceUri,
  range: {
    start: { line: 0, character: 8 },
    end: { line: 0, character: 14 },
  },
}]);
assert.equal(backendCalls.at(-1)?.method, "textDocument/definition");
assert.equal(backendCalls.at(-1)?.params.textDocument.uri, entryUri);

const references = await middleware.provideReferences(
  document,
  position,
  { includeDeclaration: false },
  token,
  async () => { throw new Error("projected references called the native provider"); },
);
assert.equal(references?.length, 1);
assert.equal(backendCalls.at(-1)?.method, "textDocument/references");
assert.equal(backendCalls.at(-1)?.params.context.includeDeclaration, false);

route = "none";
let noneNativeCalls = 0;
assert.equal(await middleware.provideDefinition(document, position, token, async () => {
  noneNativeCalls += 1;
  return [];
}), undefined);
assert.equal(noneNativeCalls, 0, "the none route must invoke neither provider");

const routeCallsBeforeTypst = clientCalls.filter((call) => call.method === "mmt/semanticRoute").length;
let typstNativeCalls = 0;
assert.equal(await middleware.provideDefinition(typstDocument, position, token, async () => {
  typstNativeCalls += 1;
  return [];
}), undefined);
assert.equal(typstNativeCalls, 0, ".typ documents must never enter MMT native middleware");
assert.equal(
  clientCalls.filter((call) => call.method === "mmt/semanticRoute").length,
  routeCallsBeforeTypst,
  ".typ documents must not request an MMT semantic route",
);

const nativeOnlyOptions = {};
installMmtSemanticMiddleware(nativeOnlyOptions, () => client);
route = "native";
const nativeOnly = Object.freeze([{ uri: sourceUri, range: { start: position, end: position } }]);
assert.equal(
  await nativeOnlyOptions.middleware.provideDefinition(document, position, token, async () => nativeOnly),
  nativeOnly,
  "native semantics must work without a Tinymist backend",
);
route = "projected";
assert.equal(
  await nativeOnlyOptions.middleware.provideDefinition(document, position, token, async () => nativeOnly),
  undefined,
  "a projected route without a connected backend must fail closed",
);

dispatcher.dispose();
console.log("MMT semantic routing: native/projected/none ownership verified");
