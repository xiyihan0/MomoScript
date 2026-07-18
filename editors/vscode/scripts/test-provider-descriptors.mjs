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
      "export * from './src/typstPosition.ts';",
      "export * from './src/typstProviderDescriptors.ts';",
      "export * from './src/typstProviderPayload.ts';"
    ].join("\n"),
    resolveDir: root,
    sourcefile: "provider-descriptor-entry.ts",
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
  FIXED_TINYMIST_PROVIDER_ARTIFACTS,
  FIXED_TINYMIST_PROVIDER_QUALIFICATION,
  LineIndex,
  TYPST_PROVIDER_DESCRIPTORS,
  TYPST_PROVIDER_METHODS,
  TinymistCapabilityRegistry,
  TypstProviderQualificationRegistry,
  bindTypstProviderResolveMetadata,
  readTypstProviderResolveMetadata,
  typstProviderResolveIdentityIsCurrent,
  unwrapTypstProviderResolveItem,
  validateTypstProviderPayload,
  validateTypstProviderPositions
} = runtime;

const fixtures = path.join(root, "src", "test", "fixtures");
const manifest = JSON.parse(await readFile(path.join(fixtures, "tinymist-capability-manifest.json"), "utf8"));
const nativeEvidence = JSON.parse(await readFile(path.join(fixtures, "tinymist-native-evidence.json"), "utf8"));
const webEvidence = JSON.parse(await readFile(path.join(fixtures, "tinymist-web-evidence.json"), "utf8"));

assert.equal(TYPST_PROVIDER_METHODS.length, 23);
assert.deepEqual(Object.keys(TYPST_PROVIDER_DESCRIPTORS).sort(), [...TYPST_PROVIDER_METHODS].sort());
assert(TYPST_PROVIDER_METHODS.every((method) => TYPST_PROVIDER_DESCRIPTORS[method].cancellation === "required"));
assert.equal(TYPST_PROVIDER_DESCRIPTORS["textDocument/references"].partialResults, "safe-item-list");
assert.equal(TYPST_PROVIDER_DESCRIPTORS["textDocument/selectionRange"].partialResults, "nested-prefix");
assert.equal(TYPST_PROVIDER_DESCRIPTORS["textDocument/rename"].partialResults, "none");
assert.equal(TYPST_PROVIDER_DESCRIPTORS["textDocument/documentLink"].resolveMethod, "documentLink/resolve");
assert.equal(TYPST_PROVIDER_DESCRIPTORS["workspaceSymbol/resolve"].requestMethod, "workspace/symbol");
const resolvePairs = {
  "workspace/symbol": "workspaceSymbol/resolve",
  "textDocument/documentLink": "documentLink/resolve",
  "textDocument/codeAction": "codeAction/resolve",
  "textDocument/inlayHint": "inlayHint/resolve",
  "textDocument/codeLens": "codeLens/resolve"
};
for (const [requestMethod, resolveMethod] of Object.entries(resolvePairs)) {
  assert.equal(TYPST_PROVIDER_DESCRIPTORS[requestMethod].resolveMethod, resolveMethod);
  assert.equal(TYPST_PROVIDER_DESCRIPTORS[resolveMethod].requestMethod, requestMethod);
}
assert.equal(FIXED_TINYMIST_PROVIDER_ARTIFACTS.native.digest, manifest.artifacts.native.digest);
assert.equal(FIXED_TINYMIST_PROVIDER_ARTIFACTS.web.digest, manifest.artifacts.web.digest);
for (const provider of manifest.providers) {
  const qualification = FIXED_TINYMIST_PROVIDER_QUALIFICATION[provider.key];
  if (!qualification) continue;
  assert.deepEqual(
    {
      classification: qualification.classification,
      native: qualification.native,
      sameOptions: qualification.sameOptions,
      web: qualification.web
    },
    {
      classification: provider.classification,
      native: provider.native,
      sameOptions: provider.sameOptions,
      web: provider.web
    },
    `${provider.key} fixed qualification diverged from checked artifact evidence`
  );
}

function installedRegistry(generation, evidence) {
  const registry = new TinymistCapabilityRegistry();
  registry.install(generation, evidence.initialize);
  return registry;
}
const nativeRegistry = installedRegistry(1, nativeEvidence);
const webRegistry = installedRegistry(2, webEvidence);
const nativeQualification = new TypstProviderQualificationRegistry(nativeRegistry, "native");
const webQualification = new TypstProviderQualificationRegistry(webRegistry, "web");
const fixedQualifiedMethods = [
  "textDocument/definition",
  "textDocument/references",
  "textDocument/prepareRename",
  "textDocument/rename",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/documentSymbol",
  "workspace/symbol",
  "textDocument/documentHighlight",
  "textDocument/documentLink",
  "textDocument/documentColor",
  "textDocument/colorPresentation",
  "textDocument/codeAction",
  "textDocument/inlayHint"
];
assert.deepEqual(nativeQualification.registrations().map((item) => item.descriptor.method), fixedQualifiedMethods,
  "native provider qualification diverged from checked evidence");
assert.deepEqual(webQualification.registrations().map((item) => item.descriptor.method), fixedQualifiedMethods,
  "Web provider qualification diverged from checked evidence");
assert.equal(nativeQualification.capability("textDocument/definition").kind, "QualifiedProvider");
assert.equal(nativeQualification.capability("textDocument/definition").qualification, "core-required");
assert.equal(webQualification.capability("textDocument/inlayHint").qualification, "host-optional");
assert.equal(webQualification.capability("textDocument/typeDefinition").classification, "unavailable");

const resolveRegistry = new TinymistCapabilityRegistry();
resolveRegistry.install(3, { capabilities: {} });
const dynamicDerivedMethods = [
  ["textDocument/completion", "completionItem/resolve", { resolveProvider: true }],
  ["textDocument/rename", "textDocument/prepareRename", { prepareProvider: true }],
  ["textDocument/documentLink", "documentLink/resolve", { resolveProvider: true }],
  ["textDocument/codeAction", "codeAction/resolve", { resolveProvider: true, codeActionKinds: ["quickfix"] }],
  ["textDocument/inlayHint", "inlayHint/resolve", { resolveProvider: true }],
  ["textDocument/codeLens", "codeLens/resolve", { resolveProvider: true }],
  ["workspace/symbol", "workspaceSymbol/resolve", { resolveProvider: true }]
];
for (const [method, derivedMethod, registerOptions] of dynamicDerivedMethods) {
  const id = `dynamic-${derivedMethod}`;
  resolveRegistry.register(3, [{ id, method, registerOptions }]);
  assert.equal(resolveRegistry.has(derivedMethod), true, `${method} did not expose ${derivedMethod}`);
  assert.deepEqual(resolveRegistry.get(derivedMethod).dynamicRegistrations.map((item) => item.id), [id]);
  resolveRegistry.unregister(3, [{ id, method }]);
  assert.equal(resolveRegistry.has(derivedMethod), false, `${derivedMethod} survived dynamic unregistration`);
}
resolveRegistry.register(3, [{
  id: "code-lens-no-resolve",
  method: "textDocument/codeLens",
  registerOptions: { resolveProvider: false }
}]);
assert.equal(resolveRegistry.has("codeLens/resolve"), false, "resolve=false created a failing resolve route");

const syntheticQualification = Object.fromEntries(
  Object.entries(FIXED_TINYMIST_PROVIDER_QUALIFICATION).map(([key, value]) => [key, { ...value }])
);
syntheticQualification.documentLinkProvider = {
  classification: "core-required",
  native: true,
  web: true,
  sameOptions: true,
  reason: "fixture-qualified"
};
const qualifiedRuntime = new TinymistCapabilityRegistry();
qualifiedRuntime.install(4, {
  capabilities: { documentLinkProvider: { resolveProvider: true } }
});
const qualified = new TypstProviderQualificationRegistry(qualifiedRuntime, "native", syntheticQualification);
const linkCapability = qualified.capability("textDocument/documentLink");
assert.equal(linkCapability.kind, "QualifiedProvider");
assert.equal(linkCapability.resolveProvider, true);
assert.deepEqual(linkCapability.identity, {
  backendGeneration: true,
  logicalSource: true,
  sourceContent: true,
  sourceStaleToken: true,
  projectSnapshot: true,
  projectionKey: true,
  requestSequence: true
});
assert.deepEqual(qualified.registrations().map((item) => item.descriptor.method), ["textDocument/documentLink"]);

const sourceUri = "file:///workspace/main.typ";
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const edit = { range, newText: "x" };
const positionContext = {
  sourceUri,
  sourceIndex: new LineIndex("abc\nxy"),
  encoding: "utf-16"
};
const validPositionFixtures = {
  location: { method: "textDocument/definition", value: { uri: sourceUri, range } },
  locations: { method: "textDocument/references", value: [{ uri: sourceUri, range }] },
  "workspace-edit": { method: "textDocument/rename", value: { changes: { [sourceUri]: [edit] } } },
  formatting: { method: "textDocument/formatting", value: [edit] },
  symbols: {
    method: "textDocument/documentSymbol",
    value: [{ name: "x", kind: 13, range, selectionRange: range, children: [] }]
  },
  "workspace-symbols": {
    method: "workspace/symbol",
    value: [{ name: "x", kind: 13, location: { uri: sourceUri, range } }]
  },
  highlights: { method: "textDocument/documentHighlight", value: [{ range, kind: 1 }] },
  "selection-ranges": { method: "textDocument/selectionRange", value: [{ range, parent: { range } }] },
  links: { method: "textDocument/documentLink", value: [{ range, target: "https://example.com/" }] },
  colors: { method: "textDocument/documentColor", value: [{ range, color: { red: 0, green: 0, blue: 0, alpha: 1 } }] },
  "color-presentations": {
    method: "textDocument/colorPresentation",
    value: [{ label: "black", textEdit: edit, additionalTextEdits: [edit] }]
  },
  "code-actions": {
    method: "textDocument/codeAction",
    value: [{ title: "fix", edit: { changes: { [sourceUri]: [edit] } }, diagnostics: [{ range, message: "x" }] }]
  },
  "inlay-hints": {
    method: "textDocument/inlayHint",
    value: [{ position: { line: 0, character: 1 }, label: "x", textEdits: [edit] }]
  },
  "code-lenses": { method: "textDocument/codeLens", value: [{ range, data: { id: 1 } }] }
};
for (const [family, fixture] of Object.entries(validPositionFixtures)) {
  assert.strictEqual(validateTypstProviderPositions(fixture.method, fixture.value, positionContext), fixture.value);
  const malformed = structuredClone(fixture.value);
  const badRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 99 } };
  if (family === "location") malformed.range = badRange;
  else if (family === "locations" || family === "highlights" || family === "colors" || family === "code-lenses") malformed[0].range = badRange;
  else if (family === "workspace-edit") malformed.changes[sourceUri][0].range = badRange;
  else if (family === "formatting") malformed[0].range = badRange;
  else if (family === "symbols") malformed[0].selectionRange = badRange;
  else if (family === "workspace-symbols") malformed[0].location.range = badRange;
  else if (family === "selection-ranges") malformed[0].parent.range = badRange;
  else if (family === "links") malformed[0].range = badRange;
  else if (family === "color-presentations") malformed[0].textEdit.range = badRange;
  else if (family === "code-actions") malformed[0].edit.changes[sourceUri][0].range = badRange;
  else if (family === "inlay-hints") malformed[0].position = { line: 0, character: 99 };
  assert.throws(
    () => validateTypstProviderPositions(fixture.method, malformed, positionContext),
    `${family} published a malformed position-bearing payload`
  );
}

const identity = {
  backendGeneration: 4,
  logicalSource: "logical-source",
  sourceContent: "source-content",
  sourceStaleToken: {
    hostUri: sourceUri,
    documentIncarnation: "document-1",
    documentVersion: 7
  },
  projectSnapshot: "project-snapshot",
  projectionKey: "projection-key"
};
const backendLink = { range, target: "https://example.com/", data: { backend: "opaque" } };
const boundLink = bindTypstProviderResolveMetadata("textDocument/documentLink", backendLink, identity);
const resolveMetadata = readTypstProviderResolveMetadata("documentLink/resolve", boundLink);
assert(resolveMetadata);
assert.deepEqual(unwrapTypstProviderResolveItem(boundLink, resolveMetadata), backendLink);
assert.equal(typstProviderResolveIdentityIsCurrent(resolveMetadata, identity), true);
assert.equal(typstProviderResolveIdentityIsCurrent(resolveMetadata, {
  ...identity,
  projectSnapshot: "new-project"
}), false);
assert.equal(readTypstProviderResolveMetadata("codeAction/resolve", boundLink), undefined);
assert.throws(() => bindTypstProviderResolveMetadata("textDocument/references", {}, identity));

function payload(overrides = {}) {
  return {
    method: "textDocument/documentLink",
    capability: linkCapability,
    request: identity,
    current: identity,
    targetClass: "AuthoredMmt",
    nestedEdits: [],
    nestedCommands: [],
    nestedUris: [],
    allowedCommands: ["mmt.safe"],
    ...overrides
  };
}
const validPayload = validateTypstProviderPayload(payload({
  nestedEdits: [{ uri: sourceUri, version: 7, range, newText: "x" }],
  nestedCommands: [{ command: "mmt.safe", arguments: [{ value: 1 }] }],
  nestedUris: [{ kind: "link-target", uri: "https://example.com/" }]
}));
assert.equal(validPayload.kind, "Validated");
assert.equal(validPayload.edits[0].uri, sourceUri);
assert.equal(validateTypstProviderPayload(payload({
  capability: nativeQualification.capability("textDocument/codeLens")
})).kind, "CapabilityUnavailable");
assert.equal(validateTypstProviderPayload(payload({
  current: { ...identity, projectSnapshot: "new-project" }
})).kind, "StaleProjection");
assert.equal(validateTypstProviderPayload(payload({
  targetClass: "PackageFile",
  nestedEdits: [{ uri: sourceUri, version: 7, range, newText: "x" }]
})).kind, "ReadOnlyTarget");
assert.equal(validateTypstProviderPayload(payload({
  nestedEdits: [{
    uri: sourceUri,
    version: 7,
    range: { start: range.end, end: range.start },
    newText: "x"
  }]
})).kind, "UnsafeEdit");
assert.equal(validateTypstProviderPayload(payload({
  nestedEdits: [{ uri: sourceUri, version: 6, range, newText: "x" }]
})).kind, "UnsafeEdit");
assert.equal(validateTypstProviderPayload(payload({
  nestedCommands: [{ command: "mmt.hostIo", arguments: [] }]
})).kind, "UnsafeEdit");
assert.equal(validateTypstProviderPayload(payload({
  nestedUris: [{ kind: "link-target", uri: "javascript:alert(1)" }]
})).kind, "UnsafeEdit");
assert.equal(validateTypstProviderPayload(payload({
  nestedUris: [{ kind: "link-target", uri: "https://example.com" }]
})).kind, "UnsafeEdit", "unnormalized URI crossed the descriptor boundary");
assert.equal(validateTypstProviderPayload(payload({
  nestedUris: [{ kind: "document", uri: "file:///workspace/main%00.typ" }]
})).kind, "UnsafeEdit", "encoded control character crossed the URI boundary");
assert.equal(validateTypstProviderPayload(payload({
  nestedEdits: [
    { uri: sourceUri, version: 7, range: { start: range.start, end: { line: 0, character: 2 } }, newText: "x" },
    { uri: sourceUri, version: 7, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "y" }
  ]
})).kind, "UnsafeEdit");
assert.equal(validateTypstProviderPayload(payload({
  nestedEdits: [
    { uri: sourceUri, version: 7, range: { start: range.start, end: range.start }, newText: "x" },
    { uri: sourceUri, version: 7, range: { start: range.start, end: range.start }, newText: "y" }
  ]
})).kind, "UnsafeEdit", "same-position insertions crossed the atomic overlap boundary");
const cyclic = [];
cyclic.push(cyclic);
assert.equal(validateTypstProviderPayload(payload({
  nestedCommands: [{ command: "mmt.safe", arguments: cyclic }]
})).kind, "UnsafeEdit");

console.log(JSON.stringify({
  checked: true,
  descriptorMethods: TYPST_PROVIDER_METHODS.length,
  providerFamilies: Object.keys(validPositionFixtures).length,
  fixedNativeRegistrations: nativeQualification.registrations().length,
  fixedWebRegistrations: webQualification.registrations().length,
  dynamicResolveLifecycle: true,
  resolveIdentityPreserved: true,
  unsafeNestedPayloadsRejected: true
}));
