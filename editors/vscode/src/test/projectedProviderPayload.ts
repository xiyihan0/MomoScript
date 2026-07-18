import assert from "node:assert/strict";
import type { Range } from "vscode-languageserver-protocol";

import {
  mapProjectedProviderPayloadItems,
  ProjectedProviderPayloadCancelledError,
  type MapProjectedProviderPayloadInput,
  type ProjectedProviderPayloadMethod,
  type ProjectedProviderPayloadResult
} from "../projectedProviderPayload";
import type { ProjectedReadLocation } from "../projectedReads";
import {
  projectionReadUri,
  RetainedVirtualDocumentStore
} from "../retainedVirtualDocuments";
import type { TinymistRequestIdentity } from "../tinymistRequestDispatcher";
import {
  bindTypstProviderResolveMetadata,
  TYPST_PROVIDER_DESCRIPTORS,
  type TypstProviderCapabilityContract
} from "../typstProviderDescriptors";

const sourceUri = "file:///workspace/story.mmt";
const projectedUri = "untitled:/mmt-projection/story/session/main.typ";
const range = (start: number, end: number): Range => ({
  start: { line: 0, character: start },
  end: { line: 0, character: end }
});
const identity = {
  backendGeneration: 11,
  logicalSource: "logical-source",
  sourceContent: "source-content",
  sourceStaleToken: {
    hostUri: sourceUri,
    documentIncarnation: "document-1",
    documentVersion: 7
  },
  projectSnapshot: "project-snapshot",
  projectionKey: "projection-key"
} as TinymistRequestIdentity;
let currentIdentity: TinymistRequestIdentity | undefined = identity;

const retainedDocuments = new RetainedVirtualDocumentStore();
const activePackageDigest = "a".repeat(64);
const inactivePackageDigest = "b".repeat(64);
const activePackageUri = `mmt-package:/preview/example/1.0.0/lib.typ?digest=${activePackageDigest}`;
const inactivePackageUri = `mmt-package:/preview/example/2.0.0/lib.typ?digest=${inactivePackageDigest}`;
retainedDocuments.retainPackage({
  generationDigest: activePackageDigest,
  files: [{ uri: activePackageUri, text: "#let active = true" }]
});
retainedDocuments.retainPackage({
  generationDigest: inactivePackageDigest,
  files: [{ uri: inactivePackageUri, text: "#let inactive = true" }]
});
retainedDocuments.setActivePackageDependencies(identity.projectSnapshot, [activePackageDigest]);
const generatedBackendUri = "untitled:/mmt-projection/story/session/generated.typ";
const retainedProjectionUri = projectionReadUri(generatedBackendUri);
retainedDocuments.retainProjection({
  sourceUri,
  revision: 7,
  projectionKey: identity.projectionKey!,
  files: [{ uri: generatedBackendUri, text: "#let generated = true" }]
});
const retiredProjectionUri = projectionReadUri("untitled:/mmt-projection/story/session/retired.typ");

function capability(method: ProjectedProviderPayloadMethod): TypstProviderCapabilityContract {
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

function authored(mappedRange: Range): ProjectedReadLocation {
  return { kind: "authoredIdentity", uri: sourceUri, range: mappedRange };
}

function generated(uri: string, mappedRange: Range): ProjectedReadLocation {
  return { kind: "generatedProjection", uri, range: mappedRange };
}

function packageFile(uri: string, mappedRange: Range): ProjectedReadLocation {
  return { kind: "packageFile", uri, range: mappedRange };
}

function workspaceFile(uri: string, mappedRange: Range): ProjectedReadLocation {
  return { kind: "workspaceTypst", uri, range: mappedRange };
}

async function map(
  method: ProjectedProviderPayloadMethod,
  items: readonly unknown[],
  mappings: readonly ProjectedReadLocation[],
  overrides: Partial<MapProjectedProviderPayloadInput> = {}
): Promise<ProjectedProviderPayloadResult> {
  const input: MapProjectedProviderPayloadInput = {
    method,
    capability: capability(method),
    request: identity,
    current: () => currentIdentity,
    projectedDocumentUri: projectedUri,
    items,
    classifyLocations(locations) {
      assert.equal(locations.length, mappings.length, `${method} mapping count`);
      return mappings;
    },
    retainedDocuments,
    allowedCommands: ["mmt.safe", "mmt.open"],
    ...overrides
  };
  return await mapProjectedProviderPayloadItems(input);
}

function mappedItems(result: ProjectedProviderPayloadResult): readonly unknown[] {
  assert.equal(result.kind, "Mapped");
  return result.items;
}

function mappedRecord(result: ProjectedProviderPayloadResult, index = 0): Record<string, unknown> {
  const items = mappedItems(result);
  const item = items[index];
  assert.ok(item && typeof item === "object" && !Array.isArray(item));
  return item as Record<string, unknown>;
}

const link = await map("textDocument/documentLink", [{
  range: range(0, 4),
  target: activePackageUri,
  tooltip: "active dependency"
}], [authored(range(10, 14))]);
assert.deepEqual(mappedRecord(link).range, range(10, 14));
assert.equal(mappedRecord(link).target, activePackageUri);

const strippedInactiveLink = await map("textDocument/documentLink", [{
  range: range(0, 4),
  target: inactivePackageUri,
  tooltip: "dependency unavailable"
}], [authored(range(10, 14))]);
const strippedInactiveLinkRecord = mappedRecord(strippedInactiveLink);
assert.equal(strippedInactiveLinkRecord.target, undefined);
assert.equal(strippedInactiveLink.kind, "Mapped");
if (strippedInactiveLink.kind === "Mapped") {
  assert.match(strippedInactiveLink.strippedFields[0].reason, /inactive or retired/u);
}
assert.equal((await map("textDocument/documentLink", [{
  range: range(0, 4),
  target: inactivePackageUri
}], [authored(range(10, 14))])).kind, "StaleProjection");

const documentColor = await map("textDocument/documentColor", [{
  range: range(0, 3),
  color: { red: 0.2, green: 0.3, blue: 0.4, alpha: 1 }
}], [authored(range(20, 23))]);
assert.deepEqual(mappedRecord(documentColor).range, range(20, 23));
for (const generatedMode of ["Synthetic", "Escaped", "MacroExpansion"]) {
  const rejected = await map("textDocument/documentColor", [{
    range: range(0, 3),
    color: { red: 0, green: 0, blue: 0, alpha: 1 },
    data: { generatedMode }
  }], [generated(retainedProjectionUri, range(0, 3))]);
  assert.equal(rejected.kind, "StaleProjection", `${generatedMode} top-level result rejected`);
}

const partialColors = await map("textDocument/documentColor", [
  { range: range(0, 1), color: { red: 0, green: 0, blue: 0, alpha: 1 } },
  { range: range(2, 3), color: { red: 1, green: 1, blue: 1, alpha: 1 } }
], [authored(range(20, 21)), generated(retainedProjectionUri, range(2, 3))]);
assert.equal(partialColors.kind, "Mapped");
if (partialColors.kind === "Mapped") {
  assert.equal(partialColors.items.length, 1);
  assert.deepEqual(partialColors.omitted, [{ index: 1, reason: "read-only GeneratedProjection" }]);
}

const presentation = await map("textDocument/colorPresentation", [{
  label: "accent",
  textEdit: { range: range(0, 2), newText: "#f00" },
  additionalTextEdits: [{ range: range(4, 6), newText: "red" }]
}], [authored(range(30, 32)), authored(range(34, 36))]);
const presentationRecord = mappedRecord(presentation);
const presentationEdit = presentationRecord.textEdit;
assert.ok(presentationEdit && typeof presentationEdit === "object" && "range" in presentationEdit);
assert.deepEqual(presentationEdit.range, range(30, 32));
assert.equal((await map("textDocument/colorPresentation", [{
  label: "mixed",
  textEdit: { range: range(0, 2), newText: "safe" },
  additionalTextEdits: [{ range: range(3, 5), newText: "unsafe" }]
}], [authored(range(30, 32)), { kind: "staleUnknown" }])).kind, "StaleProjection");
assert.equal((await map("textDocument/colorPresentation", [{
  label: "package",
  textEdit: { range: range(0, 2), newText: "unsafe" }
}], [packageFile(activePackageUri, range(0, 2))])).kind, "ReadOnlyTarget");

const hint = await map("textDocument/inlayHint", [{
  position: { line: 0, character: 2 },
  label: [{
    value: "type",
    location: { uri: projectedUri, range: range(5, 7) },
    command: { title: "safe", command: "mmt.safe", arguments: [{ mode: "local" }] }
  }],
  textEdits: [{ range: range(8, 9), newText: ": value" }]
}], [
  authored(range(40, 40)),
  packageFile(activePackageUri, range(1, 3)),
  authored(range(48, 49))
]);
const hintRecord = mappedRecord(hint);
assert.deepEqual(hintRecord.position, { line: 0, character: 40 });
const hintLabel = hintRecord.label;
assert.ok(Array.isArray(hintLabel));
const hintPart = hintLabel[0];
assert.ok(hintPart && typeof hintPart === "object" && "location" in hintPart);
assert.deepEqual(hintPart.location, { uri: activePackageUri, range: range(1, 3) });

const workspaceUri = "mmtfs:/workspace/helper.typ";
const workspaceHint = await map("textDocument/inlayHint", [{
  position: { line: 0, character: 2 },
  label: [{ value: "workspace", location: { uri: projectedUri, range: range(2, 3) } }]
}], [authored(range(40, 40)), workspaceFile(workspaceUri, range(4, 5))], {
  workspaceTypstVisible: (uri) => uri === workspaceUri
});
const workspaceHintLabel = mappedRecord(workspaceHint).label;
assert.ok(Array.isArray(workspaceHintLabel));
const workspaceHintPart = workspaceHintLabel[0];
assert.ok(workspaceHintPart && typeof workspaceHintPart === "object" && "location" in workspaceHintPart);
assert.deepEqual(workspaceHintPart.location, { uri: workspaceUri, range: range(4, 5) });

const retainedGeneratedHint = await map("textDocument/inlayHint", [{
  position: { line: 0, character: 1 },
  label: [{ value: "generated", location: { uri: projectedUri, range: range(1, 2) } }]
}], [authored(range(41, 41)), generated(retainedProjectionUri, range(2, 3))]);
const retainedGeneratedLabel = mappedRecord(retainedGeneratedHint).label;
assert.ok(Array.isArray(retainedGeneratedLabel));
const retainedGeneratedPart = retainedGeneratedLabel[0];
assert.ok(retainedGeneratedPart && typeof retainedGeneratedPart === "object" && "location" in retainedGeneratedPart);
assert.deepEqual(retainedGeneratedPart.location, { uri: retainedProjectionUri, range: range(2, 3) });

const retiredGeneratedHint = await map("textDocument/inlayHint", [{
  position: { line: 0, character: 1 },
  label: [{ value: "retired", location: { uri: projectedUri, range: range(1, 2) } }]
}], [authored(range(42, 42)), generated(retiredProjectionUri, range(2, 3))]);
const retiredHintLabel = mappedRecord(retiredGeneratedHint).label;
assert.ok(Array.isArray(retiredHintLabel));
const retiredHintPart = retiredHintLabel[0];
assert.ok(retiredHintPart && typeof retiredHintPart === "object");
assert.equal("location" in retiredHintPart, false);
assert.equal(retiredGeneratedHint.kind, "Mapped");
if (retiredGeneratedHint.kind === "Mapped") {
  assert.match(retiredGeneratedHint.strippedFields[0].reason, /stale, or unavailable/u);
}

const strippedHint = await map("textDocument/inlayHint", [{
  position: { line: 0, character: 1 },
  label: [{
    value: "hint",
    location: { uri: projectedUri, range: range(1, 2) },
    command: { title: "unsafe", command: "mmt.unknown" }
  }],
  textEdits: [
    { range: range(3, 4), newText: "safe" },
    { range: range(5, 6), newText: "unsafe" }
  ]
}], [
  authored(range(41, 41)),
  packageFile(inactivePackageUri, range(1, 2)),
  authored(range(43, 44)),
  { kind: "staleUnknown" }
]);
const strippedHintRecord = mappedRecord(strippedHint);
assert.equal(strippedHintRecord.textEdits, undefined);
const strippedHintLabel = strippedHintRecord.label;
assert.ok(Array.isArray(strippedHintLabel));
const strippedHintPart = strippedHintLabel[0];
assert.ok(strippedHintPart && typeof strippedHintPart === "object");
assert.equal("location" in strippedHintPart, false);
assert.equal("command" in strippedHintPart, false);
assert.equal(strippedHint.kind, "Mapped");
if (strippedHint.kind === "Mapped") {
  assert.deepEqual(strippedHint.strippedFields.map((field) => field.path), [
    "label[0].location",
    "textEdits",
    "label[0].command"
  ]);
  for (const field of strippedHint.strippedFields) assert.ok(field.reason.length > 20);
}

const lens = await map("textDocument/codeLens", [{
  range: range(1, 3),
  command: { title: "safe", command: "mmt.safe" },
  data: { backend: "lens" }
}], [authored(range(51, 53))]);
assert.deepEqual(mappedRecord(lens).range, range(51, 53));
const strippedLens = await map("textDocument/codeLens", [{
  range: range(1, 3),
  command: { title: "unsafe", command: "mmt.open", arguments: ["https://example.com/"] },
  data: { backend: "lens" }
}], [authored(range(51, 53))]);
assert.equal(mappedRecord(strippedLens).command, undefined);
assert.equal(strippedLens.kind, "Mapped");
if (strippedLens.kind === "Mapped") {
  assert.match(strippedLens.strippedFields[0].reason, /optional unresolved code-lens command stripped/u);
}
assert.equal((await map("textDocument/codeLens", [{
  range: range(1, 3),
  command: { title: "unsafe", command: "mmt.unknown" }
}], [authored(range(51, 53))])).kind, "StaleProjection");
assert.equal((await map("textDocument/codeLens", [{
  range: range(1, 3),
  command: { title: "safe", command: "mmt.safe" }
}], [generated(retainedProjectionUri, range(1, 3))])).kind, "StaleProjection");

for (const [requestMethod, resolveMethod, item] of [
  ["textDocument/documentLink", "documentLink/resolve", {
    range: range(0, 1), target: sourceUri, data: { backend: "link" }
  }],
  ["textDocument/inlayHint", "inlayHint/resolve", {
    position: { line: 0, character: 1 }, label: "hint", data: { backend: "hint" }
  }],
  ["textDocument/codeLens", "codeLens/resolve", {
    range: range(0, 1), command: { title: "safe", command: "mmt.safe" }, data: { backend: "lens" }
  }]
] as const) {
  const bound = bindTypstProviderResolveMetadata(requestMethod, item, identity);
  currentIdentity = { ...identity, backendGeneration: 12 };
  const staleResolve = await map(resolveMethod, [bound], [authored(range(60, 61))]);
  assert.equal(staleResolve.kind, "StaleProjection", `${resolveMethod} restart race`);
  currentIdentity = identity;
}

currentIdentity = identity;
const restartRace = await map("textDocument/documentLink", [{
  range: range(0, 1), target: sourceUri
}], [authored(range(70, 71))], {
  classifyLocations(locations) {
    assert.equal(locations.length, 1);
    currentIdentity = { ...identity, backendGeneration: 12 };
    return [authored(range(70, 71))];
  }
});
assert.equal(restartRace.kind, "StaleProjection");
currentIdentity = identity;

const controller = new AbortController();
await assert.rejects(
  map("textDocument/inlayHint", [{
    position: { line: 0, character: 1 }, label: "hint"
  }], [authored(range(80, 80))], {
    signal: controller.signal,
    classifyLocations(locations) {
      assert.equal(locations.length, 1);
      controller.abort();
      return [authored(range(80, 80))];
    }
  }),
  ProjectedProviderPayloadCancelledError
);

assert.equal((await map("textDocument/documentLink", [{
  range: range(0, 1), target: sourceUri
}], [])).kind, "StaleProjection");

console.log(JSON.stringify({
  checked: true,
  families: ["documentLink", "documentColor", "colorPresentation", "inlayHint", "codeLens"],
  projectedIdentityOnly: true,
  retainedReadOnlyTargets: true,
  optionalStrippingReasons: true,
  mixedEditTransactionRejected: true,
  generatedModesRejected: ["Synthetic", "Escaped", "MacroExpansion"],
  inactivePackageRejected: true,
  staleResolveRejected: true,
  restartRaceRejected: true,
  cancellationNeverPublishes: true
}));
