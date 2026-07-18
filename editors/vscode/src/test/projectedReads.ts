import assert from "node:assert/strict";
import type { Range, SymbolInformation } from "vscode-languageserver-protocol";

import {
  mapDocumentHighlights,
  mapNavigationLocations,
  mapSelectionRanges,
  mergeWorkspaceSymbols,
  mmtNativeFirst,
  parseProjectedReadLocations,
  type ProjectedReadLocation
} from "../projectedReads";
import {
  RetainedVirtualDocumentStore,
  projectionReadUri,
  registerVirtualTypstContentProviders,
  type TextDocumentContentProviderRegistry
} from "../retainedVirtualDocuments";

const range = (start: number, end: number): Range => ({
  start: { line: 0, character: start },
  end: { line: 0, character: end }
});
const sourceUri = "file:///workspace/story.mmt";
const authored = (start: number, end: number): ProjectedReadLocation => ({
  kind: "authoredIdentity",
  uri: sourceUri,
  range: range(start, end)
});

const definition = mapNavigationLocations("definition", [
  authored(1, 4),
  { kind: "workspaceTypst", uri: "file:///workspace/helper.typ", range: range(2, 5) },
  {
    kind: "packageFile",
    uri: "mmt-package:/preview/example/1.0.0/lib.typ?digest=generation-a",
    range: range(3, 6)
  },
  {
    kind: "generatedProjection",
    uri: "mmt-projection:/mmt-projection/source/session/main-1.typ",
    range: range(4, 7)
  }
], { packageVisible: () => true });
assert.equal(definition.kind, "Mapped");
assert.equal(definition.kind === "Mapped" ? definition.items.length : 0, 4);

const references = mapNavigationLocations("references", [
  authored(1, 2),
  { kind: "staleUnknown" }
]);
assert.deepEqual(references, {
  kind: "Mapped",
  items: [{ uri: sourceUri, range: range(1, 2) }],
  omitted: 1
});
assert.deepEqual(mapNavigationLocations("references", [{ kind: "staleUnknown" }]), {
  kind: "StaleUnknown",
  omitted: 1
});
assert.deepEqual(mapNavigationLocations("typeDefinition", [authored(0, 1)], { qualified: false }), {
  kind: "CapabilityUnavailable",
  method: "typeDefinition"
});
assert.equal(mapNavigationLocations("implementation", [authored(0, 1)]).kind, "Mapped");
assert.deepEqual(mapNavigationLocations("definition", [{
  kind: "packageFile",
  uri: "mmt-package:/preview/example/1.0.0/lib.typ?digest=inactive",
  range: range(0, 1)
}]), { kind: "StaleUnknown", omitted: 1 });
assert.deepEqual(parseProjectedReadLocations([
  { kind: "authoredIdentity", uri: sourceUri, range: range(0, 1) },
  { kind: "staleUnknown" }
]), [authored(0, 1), { kind: "staleUnknown" }]);
assert.throws(
  () => parseProjectedReadLocations([{ kind: "generatedProjection", uri: "file:///editable.typ", range: null }]),
  /exact URI\/range/
);

const highlights = mapDocumentHighlights(
  sourceUri,
  [{ range: range(0, 1), kind: 1 }, { range: range(1, 2), kind: 2 }],
  [authored(3, 4), { kind: "generatedProjection", uri: "mmt-projection:/generated", range: range(1, 2) }]
);
assert.deepEqual(highlights, {
  kind: "Mapped",
  items: [{ range: range(3, 4), kind: 1 }],
  omitted: 1
});

const selections = mapSelectionRanges([
  {
    chain: [
      authored(3, 4),
      authored(2, 5),
      { kind: "generatedProjection", uri: "mmt-projection:/generated", range: range(0, 8) },
      authored(0, 9)
    ]
  }
], sourceUri);
assert.deepEqual(selections, {
  kind: "Mapped",
  items: [{ range: range(3, 4), parent: { range: range(2, 5) } }],
  omitted: 1
});

const symbol = (name: string, uri: string, symbolRange: Range): SymbolInformation => ({
  name,
  kind: 12,
  location: { uri, range: symbolRange }
});
const nativeSymbol = symbol("accent", sourceUri, range(1, 4));
const symbols = mergeWorkspaceSymbols(
  [nativeSymbol],
  [
    { symbol: symbol("accent", "untitled:/projection", range(0, 3)), location: authored(1, 4) },
    {
      symbol: symbol("wrapper", "untitled:/projection", range(0, 3)),
      location: { kind: "generatedProjection", uri: "mmt-projection:/generated", range: range(0, 3) }
    },
    {
      symbol: symbol("helper", "file:///workspace/helper.typ", range(0, 2)),
      location: { kind: "workspaceTypst", uri: "file:///workspace/helper.typ", range: range(0, 2) }
    }
  ]
);
assert.deepEqual(symbols.map((item) => item.name), ["accent", "helper"]);

let fallbackCalls = 0;
const nativeResult = await mmtNativeFirst([nativeSymbol], async () => {
  fallbackCalls += 1;
  return [symbol("fallback", sourceUri, range(0, 1))];
});
assert.deepEqual(nativeResult, [nativeSymbol]);
assert.equal(fallbackCalls, 0);
await mmtNativeFirst<SymbolInformation[]>([], async () => {
  fallbackCalls += 1;
  return [nativeSymbol];
});
assert.equal(fallbackCalls, 1);

const store = new RetainedVirtualDocumentStore();
const projectionUri = (revision: number) => `untitled:/mmt-projection/source/session/main-${revision}.typ`;
for (let revision = 1; revision <= 4; revision += 1) {
  store.retainProjection({
    sourceUri,
    revision,
    projectionKey: `projection-${revision}`,
    files: [{ uri: projectionUri(revision), text: `revision ${revision}` }]
  });
}
assert.equal(store.projectionContent(projectionReadUri(projectionUri(1))), undefined);
assert.equal(store.projectionContent(projectionReadUri(projectionUri(2))), "revision 2");
assert.equal(store.projectionContent(projectionReadUri(projectionUri(4))), "revision 4");
assert.throws(() => store.retainProjection({
  sourceUri,
  revision: 5,
  projectionKey: "projection-5",
  files: [{ uri: projectionUri(4), text: "mutated revision 4" }]
}), /Immutable projection URI changed content/);
store.closeProjectionSource(sourceUri);
assert.equal(store.projectionContent(projectionReadUri(projectionUri(4))), undefined);

const packageUri = "mmt-package:/preview/example/1.0.0/lib.typ?digest=generation-a";
store.retainPackage({
  generationDigest: "generation-a",
  files: [{ uri: packageUri, text: "#let answer = 42" }]
});
assert.equal(store.packageContent(packageUri), undefined);
store.setActivePackageDependencies("project-a", ["generation-a"]);
assert.equal(store.packageContent(packageUri), "#let answer = 42");
store.closeProject("project-a");
assert.equal(store.packageContent(packageUri), undefined);
store.retirePackageGeneration("generation-a");
assert.equal(store.packageContent(packageUri), undefined);

const registrations: string[] = [];
const registry: TextDocumentContentProviderRegistry = {
  registerTextDocumentContentProvider(scheme) {
    registrations.push(scheme);
    return { dispose() {} };
  }
};
assert.equal(registerVirtualTypstContentProviders(registry, store).length, 2);
assert.deepEqual(registrations, ["mmt-projection", "mmt-package"]);

console.log(JSON.stringify({
  projectionKinds: [
    "authoredIdentity",
    "workspaceTypst",
    "packageFile",
    "generatedProjection",
    "staleUnknown"
  ],
  navigation: ["definition", "references", "typeDefinition", "implementation"],
  conservativeHighlights: true,
  selectionPrefix: true,
  symbolDedupe: true,
  mmtNativePrecedence: true,
  retainedProjectionGenerations: 3,
  inactivePackageHidden: true,
  readOnlySchemes: registrations
}));
