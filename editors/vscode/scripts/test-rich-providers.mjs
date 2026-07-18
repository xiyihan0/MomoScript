import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vscodeStub = `
export const __host = { registrations: [] };
function register(kind, selector, provider, metadata = {}) {
  const value = { kind, selector, provider, metadata, disposed: false };
  value.dispose = () => { value.disposed = true; };
  __host.registrations.push(value);
  return value;
}
export const languages = {
  registerRenameProvider: (s, p) => register("rename", s, p),
  registerDocumentFormattingEditProvider: (s, p) => register("formatting", s, p),
  registerDocumentRangeFormattingEditProvider: (s, p) => register("rangeFormatting", s, p),
  registerDocumentLinkProvider: (s, p) => register("documentLink", s, p),
  registerColorProvider: (s, p) => register("color", s, p),
  registerCodeActionsProvider: (s, p, m) => register("codeAction", s, p, m),
  registerInlayHintsProvider: (s, p) => register("inlayHint", s, p),
  registerCodeLensProvider: (s, p) => register("codeLens", s, p)
};
export class Position { constructor(line, character) { this.line = line; this.character = character; } }
export class Range {
  constructor(a, b, c, d) {
    if (typeof b === "object") { this.start = a; this.end = b; }
    else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
export class TextEdit { constructor(range, newText) { this.range = range; this.newText = newText; } }
export class Uri {
  constructor(value) { this.value = value; this.scheme = value.slice(0, value.indexOf(":")); }
  toString() { return this.value; }
  static parse(value) { return new Uri(value); }
}
`;
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/tinymistCapabilities.ts';",
      "export * from './src/typstFeatureRouter.ts';",
      "export * from './src/typstRichProviders.ts';",
      "export { __host, Uri } from 'vscode';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "rich-provider-entry.ts",
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
  }]
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const {
  __host,
  RichTypstProviderRegistrations,
  TinymistCapabilityRegistry,
  TypstFeatureRouter,
  Uri
} = runtime;

const sourceUri = "file:///workspace/main.typ";
const text = '#let greet(name) = [Hello #name]\n#let shade = rgb("ff0000")\n#greet("MMT")\n';
const range = { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } };
const secondRange = { start: { line: 2, character: 1 }, end: { line: 2, character: 6 } };
const initialize = {
  capabilities: {
    renameProvider: { prepareProvider: true },
    documentFormattingProvider: true,
    documentRangeFormattingProvider: true,
    documentLinkProvider: { resolveProvider: true },
    colorProvider: true,
    codeActionProvider: { resolveProvider: true, codeActionKinds: ["quickfix"] },
    inlayHintProvider: { resolveProvider: true },
    codeLensProvider: { resolveProvider: true },
    executeCommandProvider: { commands: ["mmt.safe", "tinymist.exportPdf"] }
  }
};
const capabilities = new TinymistCapabilityRegistry();
capabilities.install(1, initialize);
const listeners = new Map();
const responses = new Map([
  ["textDocument/prepareRename", { range, placeholder: "greet" }],
  ["textDocument/rename", { changes: { [sourceUri]: [{ range, newText: "welcome" }, { range: secondRange, newText: "welcome" }] } }],
  ["textDocument/formatting", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// formatted\n" }]],
  ["textDocument/rangeFormatting", [{ range, newText: "greet" }]],
  ["textDocument/documentLink", [
    { range, target: sourceUri, data: { id: "safe" } },
    { range: secondRange, target: "https://example.com/", tooltip: "external withheld", data: { id: "external" } }
  ]],
  ["documentLink/resolve", { range, target: sourceUri, tooltip: "resolved", data: { id: "safe" } }],
  ["textDocument/documentColor", [{ range: secondRange, color: { red: 1, green: 0, blue: 0, alpha: 1 } }]],
  ["textDocument/colorPresentation", [{ label: "red", textEdit: { range: secondRange, newText: 'rgb("ff0000")' } }]],
  ["textDocument/codeAction", [{
    title: "safe fix",
    edit: { documentChanges: [{ textDocument: { uri: sourceUri, version: 1 }, edits: [{ range, newText: "fixed" }] }] },
    data: { id: "action" }
  }]],
  ["codeAction/resolve", {
    title: "safe fix",
    edit: { documentChanges: [{ textDocument: { uri: sourceUri, version: 1 }, edits: [{ range, newText: "fixed" }] }] },
    data: { id: "action" }
  }],
  ["textDocument/inlayHint", [{
    position: { line: 0, character: 10 },
    label: [{ value: "name", command: { title: "unsafe", command: "tinymist.exportPdf" } }],
    data: { id: "hint" }
  }]],
  ["inlayHint/resolve", { position: { line: 0, character: 10 }, label: "name", data: { id: "hint" } }],
  ["textDocument/codeLens", [{
    range,
    command: { title: "Export PDF", command: "tinymist.exportPdf", arguments: [sourceUri] }
  }]],
  ["codeLens/resolve", { range, command: { title: "Export PDF", command: "tinymist.exportPdf" } }]
]);
let pendingRequest;
const backend = {
  backendGeneration: () => capabilities.generation,
  capabilities: () => capabilities,
  on(method, handler) {
    listeners.set(method, handler);
    return { dispose() { if (listeners.get(method) === handler) listeners.delete(method); } };
  },
  request(method, params, signal) {
    if (method === "textDocument/rangeFormatting" && pendingRequest) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        pendingRequest.resolve = resolve;
      });
    }
    return Promise.resolve(structuredClone(responses.get(method) ?? null));
  },
  projectForEntry(uri) { return uri === sourceUri ? project : undefined; },
  syncProject() {}, closeProject() { return true; }, stop: async () => {}, terminate() {}
};
const project = {
  sourceUri,
  sourceVersion: 1,
  revision: 1,
  entryUri: sourceUri,
  files: [{ uri: sourceUri, text }],
  full: true,
  sourceContent: "source-content",
  projectDigest: "project-snapshot",
  projectionKey: "projection-key",
  mappingDigest: "mapping-digest"
};
const converter = {
  asPosition: (value) => ({ ...value }),
  asRange: (value) => ({ start: { ...value.start }, end: { ...value.end } }),
  asWorkspaceEdit: async (value) => value,
  asTextEdits: async (value) => value,
  asDocumentLinks: async (value) => value,
  asDocumentLink: (value) => value,
  asColorInformations: async (value) => value,
  asColorPresentations: async (value) => value,
  asCodeActionResult: async (value) => value,
  asCodeAction: async (value) => value,
  asInlayHints: async (value) => value,
  asInlayHint: async (value) => value,
  asCodeLenses: async (value) => value,
  asCodeLens: (value) => value,
  asCodeActionKinds: (value) => value
};
const codeConverter = {
  asPosition: (value) => ({ ...value }),
  asRange: (value) => ({ start: { ...value.start }, end: { ...value.end } }),
  asDocumentLink: (value) => value,
  asCodeActionSync: (value) => value,
  asCodeActionContextSync: (value) => value,
  asInlayHint: (value) => value,
  asCodeLens: (value) => value
};
const client = { protocol2CodeConverter: converter, code2ProtocolConverter: codeConverter };
const router = new TypstFeatureRouter(backend, () => client);
const document = {
  languageId: "typst",
  version: 1,
  uri: Uri.parse(sourceUri),
  getText: () => text
};
router.open({ languageId: "typst", uri: sourceUri, version: 1, text });
const registrations = new RichTypstProviderRegistrations(router, backend, client, "native");
registrations.reconcile();
const registered = Object.fromEntries(__host.registrations.map((item) => [item.kind, item]));
assert.deepEqual(Object.keys(registered).sort(), [
  "codeAction", "color", "documentLink", "formatting", "inlayHint", "rangeFormatting", "rename"
]);
assert.equal(registered.codeLens, undefined, "unqualified effectful code lens registered");
assert.deepEqual(registered.codeAction.metadata.providedCodeActionKinds, ["quickfix"]);
assert.equal(typeof registered.documentLink.provider.resolveDocumentLink, "function");
assert.equal(typeof registered.codeAction.provider.resolveCodeAction, "function");
assert.equal(typeof registered.inlayHint.provider.resolveInlayHint, "function");

const cancellationToken = () => {
  const handlers = new Set();
  return {
    isCancellationRequested: false,
    onCancellationRequested(handler) { handlers.add(handler); return { dispose: () => handlers.delete(handler) }; },
    cancel() { this.isCancellationRequested = true; for (const handler of handlers) handler(); }
  };
};
const token = cancellationToken();
const position = { line: 0, character: 7 };
const prepared = await registered.rename.provider.prepareRename(document, position, token);
assert.equal(prepared.placeholder, "greet");
const renamed = await registered.rename.provider.provideRenameEdits(document, position, "welcome", token);
assert.equal(renamed.documentChanges[0].textDocument.version, 1, "rename lost document version identity");
assert.equal(renamed.documentChanges[0].edits.length, 2);
assert.equal((await registered.formatting.provider.provideDocumentFormattingEdits(document, { tabSize: 2, insertSpaces: true }, token)).length, 1);
const links = await registered.documentLink.provider.provideDocumentLinks(document, token);
assert.equal(links.length, 2);
assert.equal(links[1].target, undefined, "external link target crossed publication boundary");
const resolvedLink = await registered.documentLink.provider.resolveDocumentLink(links[0], token);
assert.equal(resolvedLink.tooltip, "resolved");
assert.equal((await registered.color.provider.provideDocumentColors(document, token)).length, 1);
assert.equal((await registered.color.provider.provideColorPresentations(
  { red: 1, green: 0, blue: 0, alpha: 1 },
  { document, range: secondRange },
  token
)).length, 1);
assert.equal((await registered.codeAction.provider.provideCodeActions(document, range, { diagnostics: [] }, token)).length, 1);
const hints = await registered.inlayHint.provider.provideInlayHints(document, range, token);
assert.equal(hints.length, 1);
assert.equal(hints[0].label[0].command, undefined, "effectful inlay command crossed publication boundary");
const resolvedHint = await registered.inlayHint.provider.resolveInlayHint(hints[0], token);
assert.equal(resolvedHint.label, "name");

responses.set("textDocument/colorPresentation", [{
  label: "overlap",
  textEdit: { range: { start: range.start, end: secondRange.end }, newText: "x" },
  additionalTextEdits: [{ range: secondRange, newText: "y" }]
}]);
assert.equal(await registered.color.provider.provideColorPresentations(
  { red: 1, green: 0, blue: 0, alpha: 1 },
  { document, range: secondRange },
  token
), undefined, "overlapping color edits were partially published");
responses.set("textDocument/codeAction", [{
  title: "unsafe command",
  command: { title: "Export", command: "tinymist.exportPdf", arguments: [sourceUri] }
}]);
assert.equal(await registered.codeAction.provider.provideCodeActions(document, range, { diagnostics: [] }, token), undefined);

pendingRequest = {};
const cancelledToken = cancellationToken();
const cancelled = registered.rangeFormatting.provider.provideDocumentRangeFormattingEdits(
  document,
  range,
  { tabSize: 2, insertSpaces: true },
  cancelledToken
);
cancelledToken.cancel();
assert.equal(await cancelled, undefined, "cancelled range formatting published");
pendingRequest = undefined;

responses.set("textDocument/documentLink", [{ range, target: sourceUri, data: { id: "restart" } }]);
const restartLinks = await registered.documentLink.provider.provideDocumentLinks(document, token);
capabilities.install(2, initialize);
assert.equal(await registered.documentLink.provider.resolveDocumentLink(restartLinks[0], token), undefined,
  "resolve metadata survived backend generation restart");
registrations.reconcile();
assert(__host.registrations.slice(0, 7).every((item) => item.disposed), "restart did not dispose old providers");
capabilities.clear(2);
registrations.reconcile();
assert(__host.registrations.every((item) => item.disposed), "capability removal left providers registered");
registrations.dispose();

console.log(JSON.stringify({
  checked: true,
  registered: Object.keys(registered).sort(),
  unavailable: ["codeLens"],
  atomicUnsafePayloadsRejected: true,
  cancellationRejected: true,
  resolveRestartRejected: true,
  versionedRename: true,
  dynamicUnregisterDisposed: true
}));
