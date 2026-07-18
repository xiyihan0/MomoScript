import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/typstProviderDescriptors.ts';",
      "export * from './src/typstProviderPayload.ts';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "provider-payload-negative-entry.ts",
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
  TYPST_PROVIDER_DESCRIPTORS,
  bindTypstProviderResolveMetadata,
  validateTypstProviderItemPayload
} = runtime;

const sourceUri = "file:///workspace/main.typ";
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const secondRange = { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } };
const identity = {
  backendGeneration: 9,
  logicalSource: "logical-source",
  sourceContent: "content-key",
  sourceStaleToken: {
    hostUri: sourceUri,
    documentIncarnation: "document-1",
    documentVersion: 7
  },
  projectSnapshot: "project-snapshot",
  projectionKey: "projection-key"
};

function capability(method) {
  return {
    kind: "QualifiedProvider",
    descriptor: TYPST_PROVIDER_DESCRIPTORS[method],
    runtime: { method, initializeOptions: true, dynamicRegistrations: [] },
    host: "native",
    qualification: "host-optional",
    resolveProvider: true,
    codeActionKinds: [],
    identity: {
      backendGeneration: true,
      logicalSource: true,
      sourceContent: true,
      sourceStaleToken: true,
      projectSnapshot: true,
      projectionKey: true,
      requestSequence: true
    }
  };
}

function validate(method, item, overrides = {}) {
  return validateTypstProviderItemPayload({
    method,
    capability: capability(method),
    request: identity,
    current: identity,
    targetClass: "AuthoredMmt",
    allowedCommands: ["mmt.safe", "mmt.shell", "mmt.open"],
    item,
    ...overrides
  });
}

function expectKind(kind, result, message) {
  assert.equal(result.kind, kind, `${message}: ${result.kind === "UnsafeEdit" ? result.reason : "unexpected result"}`);
  return result;
}

const validColor = validate("textDocument/colorPresentation", {
  label: "black",
  textEdit: { range, newText: "#000" },
  additionalTextEdits: [{ range: secondRange, newText: "black" }]
});
expectKind("Validated", validColor, "valid color presentation");
assert.equal(validColor.edits.length, 2);
expectKind("StaleProjection", validate("textDocument/colorPresentation", {
  label: "stale",
  additionalTextEdits: [{ range, newText: "x" }]
}, { current: { ...identity, projectSnapshot: "new-snapshot" } }), "stale color edit");
expectKind("ReadOnlyTarget", validate("textDocument/colorPresentation", {
  label: "read-only",
  textEdit: { range, newText: "x" }
}, { targetClass: "PackageFile" }), "read-only color edit");
expectKind("UnsafeEdit", validate("textDocument/colorPresentation", {
  label: "mixed",
  textEdit: { range: { start: range.start, end: secondRange.end }, newText: "safe-looking" },
  additionalTextEdits: [{ range: secondRange, newText: "overlap" }]
}), "mixed safe and unsafe color edits remain atomic");

const strippedHintCommand = expectKind("Validated", validate("textDocument/inlayHint", {
  position: range.start,
  label: [{ value: "hint", command: { title: "bad", command: "mmt.unknown" } }]
}), "optional inlay command stripping");
assert.equal(strippedHintCommand.value.label[0].command, undefined);
assert.match(strippedHintCommand.strippedFields[0].reason, /optional inlay-hint command stripped/u);
const strippedHintEdits = expectKind("Validated", validate("textDocument/inlayHint", {
  position: range.start,
  label: "hint",
  textEdits: [{ range, newText: 5 }]
}), "optional inlay edits stripping");
assert.equal(strippedHintEdits.value.textEdits, undefined);
expectKind("Validated", validate("textDocument/inlayHint", {
  position: range.start,
  label: [{ value: "hint", location: { uri: "file:///etc/passwd", range } }]
}), "host-path inlay location is stripped from meaningful hint");
const packageDigest = "a".repeat(64);
const packagePath = "mmt-package:/preview/example/1.0.0/lib.typ";
const canonicalPackageUri = `${packagePath}?digest=${packageDigest}`;
const packageHint = expectKind("Validated", validate("textDocument/inlayHint", {
  position: range.start,
  label: [{ value: "package", location: { uri: canonicalPackageUri, range } }]
}), "canonical package generation URI");
assert.equal(packageHint.strippedFields.length, 0);
assert.equal(packageHint.uris[0].uri, canonicalPackageUri);
for (const unsafePackageUri of [
  `${canonicalPackageUri}&extra=1`,
  `${canonicalPackageUri}&digest=${packageDigest}`,
  `${packagePath}?digest=${"A".repeat(64)}`,
  `${canonicalPackageUri}#fragment`
]) {
  const unsafePackageHint = expectKind("Validated", validate("textDocument/inlayHint", {
    position: range.start,
    label: [{ value: "package", location: { uri: unsafePackageUri, range } }]
  }), "non-canonical package URI stripping");
  assert.equal(unsafePackageHint.value.label[0].location, undefined);
  assert.match(unsafePackageHint.strippedFields[0].reason, /unsafe scheme, authority, query, or fragment/u);
}

const strippedLens = expectKind("Validated", validate("textDocument/codeLens", {
  range,
  command: { title: "bad", command: "mmt.unknown" },
  data: { backend: 1 }
}), "unresolved code-lens command stripping");
assert.equal(strippedLens.value.command, undefined);
expectKind("UnsafeEdit", validate("textDocument/codeLens", {
  range,
  command: { title: "bad", command: "mmt.unknown" }
}), "command-only code lens");
expectKind("UnsafeEdit", validate("textDocument/codeLens", {
  range,
  command: { title: "shell", command: "mmt.shell", arguments: ["echo unsafe"] }
}), "allowlisted shell command");

const strippedNetworkLink = expectKind("Validated", validate("textDocument/documentLink", {
  range,
  target: "https://example.com/",
  tooltip: "external target withheld"
}), "optional network link stripping");
assert.equal(strippedNetworkLink.value.target, undefined);
assert.match(strippedNetworkLink.strippedFields[0].reason, /network or external-host/u);
expectKind("UnsafeEdit", validate("textDocument/documentLink", {
  range,
  target: "javascript:alert(1)"
}), "unsafe link target without meaningful remainder");
expectKind("UnsafeEdit", validate("textDocument/documentLink", {
  range,
  target: "file:///etc/passwd"
}), "host-path link target without meaningful remainder");
expectKind("StaleProjection", validate("textDocument/documentLink", {
  range,
  target: sourceUri
}, { current: { ...identity, projectionKey: "new-projection" } }), "stale link target");

const safeWorkspaceEdit = {
  documentChanges: [{
    textDocument: { uri: sourceUri, version: 7 },
    edits: [{ range, newText: "fixed" }]
  }]
};
const validAction = expectKind("Validated", validate("textDocument/codeAction", {
  title: "safe fix",
  diagnostics: [{ range, message: "problem", data: { code: 1 } }],
  edit: safeWorkspaceEdit,
  command: { title: "finish", command: "mmt.safe", arguments: [{ mode: "local" }] },
  data: { backend: "opaque" }
}), "safe code action");
assert.equal(validAction.edits.length, 1);
assert.equal(validAction.commands.length, 1);
const strippedActionCommand = expectKind("Validated", validate("textDocument/codeAction", {
  title: "edit survives",
  edit: safeWorkspaceEdit,
  command: { title: "unsafe", command: "mmt.open", arguments: ["https://example.com/"] }
}), "unsafe optional code-action command stripping");
assert.equal(strippedActionCommand.value.command, undefined);
expectKind("UnsafeEdit", validate("textDocument/codeAction", {
  title: "command only",
  command: { title: "unsafe", command: "mmt.unknown" }
}), "command-only code action");
expectKind("UnsafeEdit", validate("textDocument/codeAction", {
  title: "clipboard command",
  command: { title: "copy", command: "mmt.safe", arguments: ["clipboard://write"] }
}), "command-only clipboard effect");
expectKind("UnsafeEdit", validate("textDocument/codeAction", {
  title: "unversioned",
  edit: { changes: { [sourceUri]: [{ range, newText: "x" }] } }
}), "unversioned WorkspaceEdit changes");
for (const operation of [
  { kind: "create", uri: "file:///workspace/new.typ" },
  { kind: "rename", oldUri: sourceUri, newUri: "file:///workspace/new.typ" },
  { kind: "delete", uri: sourceUri }
]) {
  expectKind("UnsafeEdit", validate("textDocument/codeAction", {
    title: `resource ${operation.kind}`,
    edit: { documentChanges: [operation] }
  }), `${operation.kind} resource operation`);
}
expectKind("UnsafeEdit", validate("textDocument/codeAction", {
  title: "outside identity",
  edit: { documentChanges: [{
    textDocument: { uri: "file:///workspace/other.typ", version: 7 },
    edits: [{ range, newText: "x" }]
  }] }
}), "workspace edit outside captured identity");
expectKind("UnsafeEdit", validate("textDocument/codeAction", {
  title: "mixed transaction",
  edit: { documentChanges: [{
    textDocument: { uri: sourceUri, version: 7 },
    edits: [
      { range: { start: range.start, end: secondRange.end }, newText: "first" },
      { range: secondRange, newText: "overlap" }
    ]
  }] }
}), "mixed safe and unsafe workspace edit");
expectKind("ReadOnlyTarget", validate("textDocument/codeAction", {
  title: "package edit",
  edit: safeWorkspaceEdit
}, { targetClass: "PackageFile" }), "read-only code action target");
expectKind("UnsafeEdit", validate("textDocument/codeAction", {
  title: "bad diagnostic",
  disabled: { reason: "not applicable" },
  diagnostics: [{ range: { start: range.end, end: range.start }, message: "bad" }]
}), "malformed code-action diagnostic");

const boundLink = bindTypstProviderResolveMetadata(
  "textDocument/documentLink",
  { range, target: sourceUri, data: { backend: "opaque" } },
  identity
);
expectKind("Validated", validate("documentLink/resolve", boundLink), "current resolve item");
expectKind("StaleProjection", validate("documentLink/resolve", boundLink, {
  current: { ...identity, backendGeneration: 10 }
}), "resolve after backend restart");
const resolveFixtures = [
  ["textDocument/inlayHint", "inlayHint/resolve", {
    position: range.start,
    label: "hint",
    data: { backend: "hint" }
  }],
  ["textDocument/codeLens", "codeLens/resolve", {
    range,
    command: { title: "safe", command: "mmt.safe" },
    data: { backend: "lens" }
  }],
  ["textDocument/codeAction", "codeAction/resolve", {
    title: "safe resolve",
    edit: safeWorkspaceEdit,
    data: { backend: "action" }
  }]
];
for (const [requestMethod, resolveMethod, item] of resolveFixtures) {
  const bound = bindTypstProviderResolveMetadata(requestMethod, item, identity);
  expectKind("Validated", validate(resolveMethod, bound), `${resolveMethod} current item`);
  expectKind("StaleProjection", validate(resolveMethod, bound, {
    current: { ...identity, backendGeneration: 10 }
  }), `${resolveMethod} after backend restart`);
}
expectKind("UnsafeEdit", validate("documentLink/resolve", {
  range,
  target: sourceUri,
  data: { backend: "unbound" }
}), "resolve without authenticated metadata");

console.log(JSON.stringify({
  checked: true,
  providers: ["colorPresentation", "inlayHint", "codeLens", "documentLink", "codeAction"],
  resolveAfterRestartRejected: true,
  resourceOperationsRejected: ["create", "rename", "delete"],
  optionalStrippingReasonsChecked: true,
  atomicMixedPayloadsRejected: true,
  hostNetworkClipboardShellEffectsRejected: true
}));
