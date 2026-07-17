import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const diagnosticWrites = [];
const vscodeFixture = {
  Uri: { parse: (value) => ({ toString: () => value }) },
  languages: {
    createDiagnosticCollection() {
      return {
        set(uri, diagnostics) {
          diagnosticWrites.push({ uri: uri.toString(), diagnostics: structuredClone(diagnostics) });
        },
        delete() {},
        dispose() {}
      };
    }
  }
};
globalThis.__mmtRuntimeCharacterizationVscode = vscodeFixture;

const bundle = await build({
  stdin: {
    contents: "export { installTypstMiddleware, connectTypstBackend } from './src/typstFeatures.ts';",
    resolveDir: root,
    sourcefile: "runtime-characterization-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent",
  plugins: [{
    name: "vscode-characterization-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode-characterization", namespace: "fixture" }));
      buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const Uri = globalThis.__mmtRuntimeCharacterizationVscode.Uri; export const languages = globalThis.__mmtRuntimeCharacterizationVscode.languages;",
        loader: "js"
      }));
    }
  }]
});
const source = bundle.outputFiles[0].text;
const { installTypstMiddleware, connectTypstBackend } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const backendCalls = [];
const clientCalls = [];
const backendHandlers = new Map();
const projects = new Map([
  ["logical:/standalone.typ", {
    sourceUri: "logical:/standalone.typ",
    entryUri: "logical:/standalone.typ",
    sourceVersion: 3,
    revision: 3,
    full: true,
    files: [{ uri: "logical:/standalone.typ", text: "line\nabcd" }]
  }],
  ["untitled:/fixture/embedded/main-7.typ", {
    sourceUri: "logical-source:embedded",
    entryUri: "untitled:/fixture/embedded/main-7.typ",
    sourceVersion: 4,
    revision: 7,
    full: true,
    files: [{ uri: "untitled:/fixture/embedded/main-7.typ", text: "a\nb\nabcdefg" }]
  }]
]);

const backend = {
  on(method, handler) {
    const handlers = backendHandlers.get(method) ?? [];
    handlers.push(handler);
    backendHandlers.set(method, handlers);
  },
  async request(method, params) {
    backendCalls.push({ method, params: structuredClone(params) });
    if (method === "textDocument/completion") {
      return [{ label: params.textDocument.uri.includes("embedded") ? "projected" : "standalone" }];
    }
    if (method === "textDocument/hover") {
      return { contents: { kind: "markdown", value: `hover:${params.textDocument.uri}` } };
    }
    if (method === "textDocument/signatureHelp") {
      return { signatures: [{ label: `signature:${params.textDocument.uri}` }], activeSignature: 0, activeParameter: 0 };
    }
    if (method === "textDocument/semanticTokens/full") return { data: [0, 0, 3, 1, 0], resultId: "stable" };
    return null;
  },
  syncProject(update) {
    projects.set(update.entryUri, update);
  },
  closeProject(sourceUri, entryUri) {
    const project = projects.get(entryUri);
    if (project?.sourceUri !== sourceUri) return false;
    projects.delete(entryUri);
    return true;
  },
  projectForEntry(entryUri) {
    return projects.get(entryUri);
  },
  async stop() {},
  terminate() {}
};

const notificationHandlers = new Map();
const converter = {
  asPosition: (position) => ({ line: position.line, character: position.character }),
  asCompletionResult: (value) => value,
  asHover: (value) => value,
  asSignatureHelp: (value) => value,
  asDiagnostics: async (value) => value
};
const client = {
  code2ProtocolConverter: converter,
  protocol2CodeConverter: converter,
  onNotification(method, handler) {
    notificationHandlers.set(method, handler);
    return { dispose() {} };
  },
  async sendRequest(method, params) {
    clientCalls.push({ method, params: structuredClone(params) });
    if (method === "mmt/typstPosition") {
      return {
        entryUri: "untitled:/fixture/embedded/main-7.typ",
        revision: 7,
        position: { line: params.position.line, character: params.position.character },
        positionEncoding: "utf-16"
      };
    }
    if (method === "mmt/mapTypstCompletion") {
      return params.items.map((item) => ({ ...item, label: `mapped:${item.label}` }));
    }
    if (method === "mmt/mapTypstHover") {
      return { ...params.hover, range: { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } } };
    }
    if (method === "mmt/mapTypstDiagnostics") {
      return params.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `mapped:${diagnostic.message}` }));
    }
    return null;
  }
};

const cancellationToken = {
  onCancellationRequested() {
    return { dispose() {} };
  }
};
const options = {};
installTypstMiddleware(options, backend, () => client);
const middleware = options.middleware;
assert.ok(middleware, "Typst middleware was not installed");
assert.equal(
  "provideDocumentSemanticTokens" in middleware,
  false,
  "embedded Typst middleware unexpectedly replaced MMT-native semantic tokens"
);
connectTypstBackend(client, backend);

const standalone = {
  languageId: "typst",
  uri: { toString: () => "logical:/standalone.typ" },
  getText: () => "line\nabcd"
};
const embedded = {
  languageId: "mmt",
  uri: { toString: () => "logical-source:embedded" },
  getText: () => "a\nb\nabcdefg"
};
const completionContext = { triggerKind: 1 };
const signatureContext = { triggerKind: 1, triggerCharacter: "(", isRetrigger: false };

const standaloneCompletion = await middleware.provideCompletionItem(
  standalone,
  { line: 1, character: 2 },
  completionContext,
  cancellationToken,
  () => { throw new Error("standalone completion reached MMT middleware"); }
);
const standaloneHover = await middleware.provideHover(
  standalone,
  { line: 1, character: 2 },
  cancellationToken,
  () => { throw new Error("standalone hover reached MMT middleware"); }
);
const standaloneSignature = await middleware.provideSignatureHelp(
  standalone,
  { line: 1, character: 3 },
  signatureContext,
  cancellationToken,
  () => { throw new Error("standalone signature help reached MMT middleware"); }
);

const embeddedCompletion = await middleware.provideCompletionItem(
  embedded,
  { line: 2, character: 4 },
  completionContext,
  cancellationToken,
  () => []
);
const embeddedHover = await middleware.provideHover(
  embedded,
  { line: 2, character: 4 },
  cancellationToken,
  () => undefined
);
const embeddedSignature = await middleware.provideSignatureHelp(
  embedded,
  { line: 2, character: 6 },
  signatureContext,
  cancellationToken,
  () => undefined
);

const beforePrecedence = backendCalls.length;
const mmtCompletion = [{ label: "mmt-native" }];
const precedenceCompletion = await middleware.provideCompletionItem(
  embedded,
  { line: 0, character: 1 },
  completionContext,
  cancellationToken,
  () => mmtCompletion
);
assert.equal(precedenceCompletion, mmtCompletion, "MMT-native completion lost precedence");
assert.equal(backendCalls.length, beforePrecedence, "MMT-native completion still queried Tinymist");

for (const handler of backendHandlers.get("textDocument/publishDiagnostics") ?? []) {
  handler({
    uri: "logical:/standalone.typ",
    version: 3,
    diagnostics: [{ severity: 1, message: "standalone-diagnostic", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
  });
  handler({
    uri: "untitled:/fixture/embedded/main-7.typ",
    version: 7,
    diagnostics: [{ severity: 2, message: "embedded-diagnostic", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
  });
}
const diagnosticsSettled = Promise.withResolvers();
setImmediate(diagnosticsSettled.resolve);
await diagnosticsSettled.promise;

const semanticTokens = await backend.request("textDocument/semanticTokens/full", {
  textDocument: { uri: "logical:/standalone.typ" }
});
const typstFeaturesSource = await readFile(path.join(root, "src/typstFeatures.ts"), "utf8");
const webAdapterSource = await readFile(path.join(root, "../vscode-web/src/tinymistLanguageClient.ts"), "utf8");
assert.equal(
  typstFeaturesSource.includes("provideDocumentSemanticTokens"),
  false,
  "embedded middleware unexpectedly began routing Tinymist semantic tokens"
);
assert.match(webAdapterSource, /\{ language: "typst", scheme: "mmtfs" \}/);
assert.match(webAdapterSource, /"textDocument\/semanticTokens\/full"/);


const standaloneBackendMethods = backendCalls.slice(0, 3).map((call) => call.method);
const embeddedBackendMethods = backendCalls.slice(3, 6).map((call) => call.method);
const actual = {
  schemaVersion: 1,
  standalone: {
    diagnostics: diagnosticWrites.find((write) => write.uri === "logical:/standalone.typ"),
    completion: { methods: [standaloneBackendMethods[0]], labels: standaloneCompletion.map((item) => item.label) },
    hover: { methods: [standaloneBackendMethods[1]], value: standaloneHover.contents.value },
    signatureHelp: { methods: [standaloneBackendMethods[2]], labels: standaloneSignature.signatures.map((item) => item.label) },
    semanticTokens: {
      route: "tinymist-direct",
      selector: { language: "typst", scheme: "mmtfs" },
      method: "textDocument/semanticTokens/full",
      data: semanticTokens.data
    }
  },
  embedded: {
    diagnostics: diagnosticWrites.find((write) => write.uri === "logical-source:embedded"),
    completion: {
      methods: [clientCalls[0].method, embeddedBackendMethods[0], clientCalls[1].method],
      labels: embeddedCompletion.map((item) => item.label),
      mmtNativePrecedence: true
    },
    hover: {
      methods: [clientCalls[2].method, embeddedBackendMethods[1], clientCalls[3].method],
      value: embeddedHover.contents.value,
      mappedRange: embeddedHover.range
    },
    signatureHelp: {
      methods: [clientCalls[4].method, embeddedBackendMethods[2], clientCalls[5].method],
      labels: embeddedSignature.signatures.map((item) => item.label),
      backendCharacter: backendCalls[5].params.position.character,
      revisionRechecked: true
    },
    semanticTokens: { route: "mmt-native", projectedTinymistRequest: false }
  }
};

const checkedPath = path.join(root, "src/test/fixtures/typst-language-baseline.json");
const checkedText = await readFile(checkedPath, "utf8");
assert.doesNotMatch(checkedText, /(?:file|https?):\/\//, "language evidence contains a host/network URI");
assert.doesNotMatch(checkedText, /(?:\/home\/|[A-Z]:\\\\)/, "language evidence contains an absolute host path");
assert.doesNotMatch(checkedText, /"(?:capturedAt|durationMs|timestamp)"/, "language evidence contains volatile timing");
const checked = JSON.parse(checkedText);
assert.deepEqual(actual, checked, "Typst language baseline changed; inspect and deliberately update checked evidence");
console.log(JSON.stringify({ checked: true, families: ["diagnostics", "completion", "hover", "signatureHelp", "semanticTokens"] }));
