import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vscodeStub = `
export const __host = { registrations: [], documents: [], applyCalls: 0, didChange: 0, formatOnSave: false };
function register(kind, selector, provider, metadata = {}) {
  const value = { kind, selector, provider, metadata, disposed: false };
  value.dispose = () => { value.disposed = true; };
  __host.registrations.push(value);
  return value;
}
export class Position { constructor(line, character) { this.line = line; this.character = character; } }
export class Range {
  constructor(start, end) { this.start = start; this.end = end; }
  isEqual(other) { return this.start.line === other.start.line && this.start.character === other.start.character
    && this.end.line === other.end.line && this.end.character === other.end.character; }
}
export class TextEdit { constructor(range, newText) { this.range = range; this.newText = newText; } }
export class Uri {
  constructor(value) { this.value = value; this.scheme = value.slice(0, value.indexOf(":")); }
  toString() { return this.value; }
  static parse(value) { return new Uri(value); }
}
export class WorkspaceEdit {
  constructor() { this.values = new Map(); }
  set(uri, edits) { this.values.set(uri.toString(), edits); }
}
export const workspace = {
  get textDocuments() { return __host.documents; },
  getConfiguration() { return { get: () => __host.formatOnSave }; },
  async applyEdit(edit) {
    __host.applyCalls += 1;
    for (const [uri, edits] of edit.values) {
      const document = __host.documents.find((item) => item.uri.toString() === uri);
      if (!document) return false;
      for (const item of [...edits].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
        const start = document.offsetAt(item.range.start);
        const end = document.offsetAt(item.range.end);
        document.text = document.text.slice(0, start) + item.newText + document.text.slice(end);
      }
      document.version += 1;
      __host.didChange += 1;
    }
    return true;
  }
};
export const languages = {
  registerRenameProvider: (selector, provider) => register("rename", selector, provider),
  registerDocumentRangeFormattingEditProvider: (selector, provider) => register("rangeFormatting", selector, provider),
  registerCodeActionsProvider: (selector, provider, metadata) => register("codeAction", selector, provider, metadata)
};
`;
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/tinymistCapabilities.ts';",
      "export * from './src/typstFeatureRouter.ts';",
      "export * from './src/projectedEdits.ts';",
      "export * from './src/typstProviderPayload.ts';",
      "export { __host, Position, Range, Uri } from 'vscode';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "single-document-projected-edit-entry.ts",
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
  CapabilityUnavailableMultiDocumentEditApplier,
  Position,
  ProjectedEditAdapter,
  ProjectedTypstEditProviders,
  Range,
  TinymistCapabilityRegistry,
  TypstFeatureRouter,
  Uri,
  validateTypstCommandPayload
} = runtime;

const sourceUri = "file:///workspace/story.mmt";
const entryUri = "untitled:/mmt-projection/story/session/main-1.typ";
const sourceText = "@typ: #let alpha = 1\n";
const projectedText = "#let alpha = 1\n";
const alphaStart = Buffer.byteLength(sourceText.slice(0, sourceText.indexOf("alpha")));
const alphaEnd = alphaStart + Buffer.byteLength("alpha");
function createDocument(text = sourceText) {
  return {
    languageId: "mmt",
    uri: Uri.parse(sourceUri),
    version: 1,
    text,
    getText(range) {
      if (!range) return this.text;
      return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
    },
    positionAt(offset) {
      const prefix = this.text.slice(0, offset);
      const lines = prefix.split("\n");
      return new Position(lines.length - 1, lines.at(-1).length);
    },
    offsetAt(position) {
      const lines = this.text.split("\n");
      let offset = 0;
      for (let line = 0; line < position.line; line += 1) offset += lines[line].length + 1;
      return offset + position.character;
    }
  };
}
const document = createDocument();
__host.documents.push(document);
const token = {
  isCancellationRequested: false,
  onCancellationRequested() { return { dispose() {} }; }
};
const route = {
  entryUri,
  revision: 1,
  encoding: "utf-16",
  identity: {
    backendGeneration: 1,
    logicalSource: "logical-source",
    sourceContent: "source-content",
    sourceStaleToken: {
      hostUri: sourceUri,
      documentIncarnation: "incarnation-1",
      documentVersion: 1
    },
    projectSnapshot: "project-snapshot",
    projectionKey: "projection-key"
  }
};
const validatorCalls = [];
const validator = {
  async validate(transaction) {
    validatorCalls.push(structuredClone(transaction));
    const marker = transaction.edits[0]?.newText;
    if (marker === "cross") return { kind: "UnsafeEdit", reason: "CrossSegment" };
    if (marker === "overlap") return { kind: "UnsafeEdit", reason: "OverlappingEdits" };
    if (marker === "readonly") return { kind: "ReadOnlyTarget", uri: "mmt-package:/dependency.typ" };
    if (marker === "stale") return { kind: "StaleProjection", reason: "DocumentVersionChanged" };
    const mapped = {
      normalizedUri: sourceUri,
      expectedVersion: 1,
      edits: transaction.edits.map((edit) => ({ startByte: alphaStart, endByte: alphaEnd, newText: edit.newText }))
    };
    if (marker === "multi") return { kind: "Validated", documents: [mapped, { ...mapped, normalizedUri: "file:///workspace/other.mmt" }] };
    return { kind: "Validated", documents: [mapped] };
  }
};
// The production default is vscode.workspace; use it for the didChange proof.
const productionAdapter = new ProjectedEditAdapter(validator);
const applied = await productionAdapter.apply(route, {
  changes: { [entryUri]: [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } }, newText: "beta" }] }
}, token);
assert.equal(applied.kind, "Applied");
assert.equal(document.text.includes("beta"), true);
assert.equal(__host.applyCalls, 1, "single-document apply bypassed vscode.workspace.applyEdit");
assert.equal(__host.didChange, 1, "standard WorkspaceEdit did not produce exactly one didChange");
assert.equal(validatorCalls.some((call) => call.method === "mmt/updateDocument"), false);
assert.equal(validatorCalls[0].documents[0].sourceContent, "source-content");
assert.equal(validatorCalls[0].documents[0].projectionKey, "projection-key");

// Reset the authored snapshot for refusal cases.
document.text = sourceText;
document.version = 1;
for (const [newText, expectedKind] of [
  ["cross", "UnsafeEdit"],
  ["overlap", "UnsafeEdit"],
  ["readonly", "ReadOnlyTarget"],
  ["stale", "StaleProjection"]
]) {
  const beforeApply = __host.applyCalls;
  const refused = await productionAdapter.apply(route, {
    changes: { [entryUri]: [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } }, newText }] }
  }, token);
  assert.equal(refused.kind, expectedKind);
  assert.equal(__host.applyCalls, beforeApply, `${expectedKind} reached WorkspaceEdit.applyEdit`);
}
const multi = await productionAdapter.apply(route, {
  changes: { [entryUri]: [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } }, newText: "multi" }] }
}, token);
assert.equal(multi.kind, "CapabilityUnavailable");
assert.equal((await new CapabilityUnavailableMultiDocumentEditApplier().apply({ kind: "Validated", documents: [] }, token)).kind,
  "CapabilityUnavailable");
assert.equal(validateTypstCommandPayload({ title: "safe", command: "mmt.safe", arguments: ["local"] }, ["mmt.safe"]).kind,
  "Validated");
for (const command of [
  { title: "shell", command: "mmt.shell", arguments: [] },
  { title: "path", command: "mmt.safe", arguments: ["file:///etc/passwd"] },
  { title: "clipboard", command: "mmt.safe", arguments: [{ clipboard: "write" }] }
]) assert.equal(validateTypstCommandPayload(command, ["mmt.safe", "mmt.shell"]).kind, "UnsafeEdit");

// Exercise the actual projected provider adapter over position/range routing.
const capabilities = new TinymistCapabilityRegistry();
capabilities.install(1, {
  capabilities: {
    renameProvider: { prepareProvider: true },
    documentRangeFormattingProvider: true,
    codeActionProvider: { resolveProvider: false, codeActionKinds: ["quickfix"] },
    executeCommandProvider: { commands: ["mmt.safe", "mmt.shell"] }
  }
});
let unsafeCodeAction = false;
const backend = {
  backendGeneration: () => 1,
  capabilities: () => capabilities,
  on() {},
  request(method) {
    const range = { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } };
    if (method === "textDocument/prepareRename") return Promise.resolve({ range, placeholder: "alpha" });
    if (method === "textDocument/rename") return Promise.resolve({ changes: { [entryUri]: [{ range, newText: "renamed" }] } });
    if (method === "textDocument/rangeFormatting") return Promise.resolve([{ range, newText: "formatted" }]);
    if (method === "textDocument/codeAction") return Promise.resolve([unsafeCodeAction
      ? { title: "unsafe", command: { title: "Shell", command: "mmt.shell" } }
      : { title: "safe fix", edit: { changes: { [entryUri]: [{ range, newText: "fixed" }] } }, command: { title: "Safe", command: "mmt.safe" } }]);
    return Promise.resolve(null);
  },
  projectForEntry(uri) { return uri === entryUri ? project : undefined; },
  syncProject() {}, closeProject() { return true; }, stop: async () => {}, terminate() {}
};
const project = {
  sourceUri,
  sourceVersion: 1,
  revision: 1,
  entryUri,
  files: [{ uri: entryUri, text: projectedText }],
  full: true,
  sourceContent: "source-content",
  projectDigest: "project-snapshot",
  projectionKey: "projection-key",
  mappingDigest: "mapping-digest"
};
const requestMethods = [];
const converter = {
  asCodeActionResult: async (value) => value,
  asCodeAction: async (value) => value,
  asCodeActionKinds: (value) => value
};
const codeConverter = {
  asPosition: (value) => ({ ...value }),
  asRange: (value) => ({ start: { ...value.start }, end: { ...value.end } }),
  asCodeActionContextSync: (value) => value,
  asCodeActionSync: (value) => value
};
const client = {
  protocol2CodeConverter: converter,
  code2ProtocolConverter: codeConverter,
  sendRequest(method) {
    requestMethods.push(method);
    if (method === "mmt/typstPosition") return Promise.resolve({
      entryUri, revision: 1, position: { line: 0, character: 6 }, positionEncoding: "utf-16",
      sourceContent: "source-content", projectDigest: "project-snapshot", projectionKey: "projection-key"
    });
    if (method === "mmt/typstRange") return Promise.resolve({
      entryUri, revision: 1, range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
      positionEncoding: "utf-16", sourceContent: "source-content", projectDigest: "project-snapshot", projectionKey: "projection-key"
    });
    if (method === "mmt/validateProjectedEdit") return validator.validate(arguments[1]);
    throw new Error(`unexpected MMT request ${method}`);
  }
};
const router = new TypstFeatureRouter(backend, () => client);
router.open({ languageId: "mmt", uri: sourceUri, version: 1, text: sourceText });
__host.registrations.length = 0;
const providers = new ProjectedTypstEditProviders(router, backend, client, "native", new ProjectedEditAdapter(validator));
providers.reconcile();
const registered = Object.fromEntries(__host.registrations.map((item) => [item.kind, item]));
assert.deepEqual(Object.keys(registered).sort(), ["codeAction", "rangeFormatting", "rename"]);
const sourceRange = new Range(new Position(0, sourceText.indexOf("alpha")), new Position(0, sourceText.indexOf("alpha") + 5));
const preparedRename = await registered.rename.provider.prepareRename(document, sourceRange.start, token);
assert.equal(preparedRename.placeholder, "alpha");
assert.equal(document.getText(preparedRename.range), "alpha");
assert(await registered.rename.provider.provideRenameEdits(document, sourceRange.start, "renamed", token));
assert.equal((await registered.rangeFormatting.provider.provideDocumentRangeFormattingEdits(
  document, sourceRange, { tabSize: 2, insertSpaces: true }, token
))[0].newText, "formatted");
assert.equal((await registered.codeAction.provider.provideCodeActions(
  document, sourceRange, { diagnostics: [] }, token
)).length, 1);
unsafeCodeAction = true;
assert.equal(await registered.codeAction.provider.provideCodeActions(
  document, sourceRange, { diagnostics: [] }, token
), undefined);
__host.formatOnSave = true;
assert.equal(await registered.rangeFormatting.provider.provideDocumentRangeFormattingEdits(
  document, sourceRange, { tabSize: 2, insertSpaces: true }, token
), undefined, "embedded format-on-save was not disabled");
assert.equal(requestMethods.includes("mmt/updateDocument"), false);

console.log("single-document projected edit adapter fixture: ok");
