import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vscodeStub = `
export const __host = { documents: [], applyCalls: 0, didChange: 0, failAt: -1 };
export class Position { constructor(line, character) { this.line = line; this.character = character; } }
export class Range { constructor(start, end) { this.start = start; this.end = end; } }
export class TextEdit { constructor(range, newText) { this.range = range; this.newText = newText; } }
export class Uri {
  constructor(value) { this.value = value; this.scheme = value.slice(0, value.indexOf(":")); this.query = ""; this.fragment = ""; }
  toString() { return this.value; }
  static parse(value) { if (typeof value !== "string" || !value.includes(":")) throw new Error("invalid URI"); return new Uri(value); }
}
export class WorkspaceEdit {
  constructor() { this.values = new Map(); }
  set(uri, edits) { this.values.set(uri.toString(), edits); }
}
export const workspace = {
  get textDocuments() { return __host.documents; },
  async applyEdit(edit) {
    __host.applyCalls += 1;
    const targets = [];
    for (const [uri, edits] of edit.values) {
      const document = __host.documents.find((candidate) => candidate.uri.toString() === uri);
      if (!document) return false;
      targets.push({ document, edits, text: document.text, version: document.version });
    }
    for (let index = 0; index < targets.length; index += 1) {
      if (__host.failAt === index) {
        for (const target of targets) { target.document.text = target.text; target.document.version = target.version; }
        return false;
      }
      const { document, edits } = targets[index];
      for (const item of [...edits].sort((left, right) => document.offsetAt(right.range.start) - document.offsetAt(left.range.start))) {
        const start = document.offsetAt(item.range.start);
        const end = document.offsetAt(item.range.end);
        document.text = document.text.slice(0, start) + item.newText + document.text.slice(end);
      }
      document.version += 1;
    }
    __host.didChange += targets.length;
    return true;
  }
};
export const languages = {};
`;
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/projectedEdits.ts';",
      "export { __host, Position, Uri, workspace } from 'vscode';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "multi-document-projected-edit-entry.ts",
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
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const {
  __host,
  AtomicWorkspaceEditMultiDocumentEditApplier,
  CapabilityUnavailableMultiDocumentEditApplier,
  ProjectedEditAdapter,
  TinymistProjectedEditDocumentResolver,
  Uri,
  workspace
} = runtime;

const sourceA = "file:///workspace/a.mmt";
const sourceB = "file:///workspace/b.mmt";
const virtualA = "untitled:/mmt-projection/a/session/main-7.typ";
const virtualB = "untitled:/mmt-projection/b/session/main-11.typ";
const originalA = "@typ: #let alpha = 1\n";
const originalB = "@typ: #let beta = 2\n";
function document(uri, version, text) {
  return {
    uri: Uri.parse(uri),
    version,
    text,
    getText() { return this.text; },
    positionAt(offset) { return new runtime.Position(0, offset); },
    offsetAt(position) { return position.character; }
  };
}
const documentA = document(sourceA, 3, originalA);
const documentB = document(sourceB, 5, originalB);
__host.documents.push(documentA, documentB);
const token = { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } };
const route = {
  entryUri: virtualA,
  revision: 7,
  encoding: "utf-16",
  identity: {
    sourceContent: "source-a",
    projectionKey: "projection-a",
    sourceStaleToken: { hostUri: sourceA, documentVersion: 3 }
  }
};
const resolver = new TinymistProjectedEditDocumentResolver({
  projectForEntry(uri) {
    assert.equal(uri, virtualB);
    return {
      sourceUri: sourceB,
      sourceVersion: 5,
      revision: 11,
      entryUri: virtualB,
      sourceContent: "source-b",
      projectionKey: "projection-b"
    };
  }
}, workspace);
const ranges = {
  [sourceA]: [originalA.indexOf("alpha"), originalA.indexOf("alpha") + 5],
  [sourceB]: [originalB.indexOf("beta"), originalB.indexOf("beta") + 4]
};
let validatorMode = "valid";
let validatorCalls = 0;
const validator = {
  async validate(transaction) {
    validatorCalls += 1;
    assert.deepEqual(transaction.documents.map((item) => [item.virtualUri, item.sourceContent, item.projectionKey]), [
      [virtualA, "source-a", "projection-a"],
      [virtualB, "source-b", "projection-b"]
    ]);
    assert.deepEqual(transaction.expectedVersions.map((item) => [item.uri, item.version]), [[sourceA, 3], [sourceB, 5]]);
    if (validatorMode === "unsafe") return { kind: "UnsafeEdit", reason: "mixed invalid edit" };
    if (validatorMode === "readonly") return { kind: "ReadOnlyTarget", uri: "mmt-package:/readonly.typ" };
    const documents = [sourceA, sourceB].map((uri, index) => ({
      normalizedUri: uri,
      expectedVersion: index === 0 ? 3 : 5,
      edits: [{ startByte: ranges[uri][0], endByte: ranges[uri][1], newText: index === 0 ? "first" : "second" }]
    }));
    if (validatorMode === "partial") return { kind: "Validated", documents: documents.slice(0, 1) };
    if (validatorMode === "overlap") documents[0].edits.push({ ...documents[0].edits[0], newText: "overlap" });
    return { kind: "Validated", documents };
  }
};
const adapter = new ProjectedEditAdapter(
  validator,
  workspace,
  new AtomicWorkspaceEditMultiDocumentEditApplier(workspace),
  resolver
);
const backendEdit = {
  documentChanges: [
    { textDocument: { uri: virtualA, version: 7 }, edits: [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } }, newText: "first" }] },
    { textDocument: { uri: virtualB, version: 11 }, edits: [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 9 } }, newText: "second" }] }
  ]
};

const prepared = await adapter.prepareWorkspaceEdit(route, backendEdit, token);
assert.equal(prepared.kind, "Validated");
assert.equal(prepared.documents.length, 2);
assert.equal(prepared.workspaceEdit.values.size, 2, "rename/code-action preparation must return one complete WorkspaceEdit");
assert.equal(prepared.protocolEdit.documentChanges.length, 2, "versioned provider payload lost a target");
assert.deepEqual(prepared.protocolEdit.documentChanges.map((item) => item.textDocument.version), [3, 5]);

const applied = await adapter.apply(route, backendEdit, token);
assert.equal(applied.kind, "Applied");
assert.equal(__host.applyCalls, 1, "multi-document result used more than one WorkspaceEdit transaction");
assert.equal(__host.didChange, 2, "didChange publication did not wait for the complete transaction");
assert.equal(documentA.text.includes("first"), true);
assert.equal(documentB.text.includes("second"), true);

function reset() {
  documentA.text = originalA; documentA.version = 3;
  documentB.text = originalB; documentB.version = 5;
  __host.failAt = -1;
}
reset();
__host.failAt = 1;
const beforeFailureCalls = __host.applyCalls;
assert.equal((await adapter.apply(route, backendEdit, token)).kind, "ApplyFailed");
assert.equal(__host.applyCalls, beforeFailureCalls + 1);
assert.deepEqual([documentA.text, documentA.version, documentB.text, documentB.version], [originalA, 3, originalB, 5],
  "injected second-target failure did not restore every preimage");

for (const mode of ["unsafe", "readonly", "partial", "overlap"]) {
  reset();
  validatorMode = mode;
  const before = __host.applyCalls;
  const result = await adapter.apply(route, backendEdit, token);
  assert.equal(result.kind, mode === "readonly" ? "ReadOnlyTarget" : "UnsafeEdit");
  assert.equal(__host.applyCalls, before, `${mode} validation reached workspace mutation`);
  assert.deepEqual([documentA.text, documentB.text], [originalA, originalB]);
}
validatorMode = "valid";

const staleProjectedVersion = structuredClone(backendEdit);
staleProjectedVersion.documentChanges[1].textDocument.version = 10;
const callsBeforeStale = validatorCalls;
assert.equal((await adapter.apply(route, staleProjectedVersion, token)).kind, "StaleProjection");
assert.equal(validatorCalls, callsBeforeStale, "stale secondary projection reached Rust validation");

const resourceOperation = { documentChanges: [{ kind: "delete", uri: sourceB }] };
assert.equal((await adapter.apply(route, resourceOperation, token)).kind, "UnsafeEdit");
assert.equal(validatorCalls, callsBeforeStale, "unsafe resource operation reached Rust validation");

const cancelled = { ...token, isCancellationRequested: true };
const beforeCancelled = __host.applyCalls;
assert.equal((await adapter.apply(route, backendEdit, cancelled)).kind, "StaleProjection");
assert.equal(__host.applyCalls, beforeCancelled);

const unsupported = new ProjectedEditAdapter(
  validator,
  workspace,
  new AtomicWorkspaceEditMultiDocumentEditApplier(workspace, false),
  resolver
);
assert.equal((await unsupported.apply(route, backendEdit, token)).kind, "CapabilityUnavailable");
assert.equal((await new CapabilityUnavailableMultiDocumentEditApplier().apply(
  { protocolVersion: 1, documents: [], edits: [], expectedVersions: [] },
  { kind: "Validated", documents: [] },
  token
)).kind, "CapabilityUnavailable");

console.log("multi-document projected edit atomic fixture: ok");
