import assert from "node:assert/strict";
import {
  PreviewArtifactStore,
  createPreviewArtifact,
} from "../src/previewArtifact.ts";
import {
  PreviewInteractionController,
  PreviewUpdateCoordinator,
  nearestVisiblePage,
  normalizeViewport,
  previewSourceTargetIsNavigable,
  safePreviewOutline,
} from "../src/previewInteraction.ts";

const range = (line, start, end = start) => ({
  start: { line, character: start },
  end: { line, character: end },
});
const page = (pageIndex, marker = `page-${pageIndex}`) => ({
  pageIndex,
  geometry: { viewBox: [0, 0, 100, 200], cssWidth: 100, cssHeight: 200 },
  sanitizedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><g id="${marker}"/></svg>`,
});
const providerKey = (generation = 1) => ({
  kind: "provider",
  backendOrTraceArtifactDigest: "tinymist:sha256:fixture",
  backendGeneration: generation,
  method: "mmt/previewLocation.v1",
  coordinateVersion: "typst-page-points-v1",
});
const identity = (sourceUri, version, overrides = {}) => ({
  workspaceId: "workspace-a",
  sourceUri,
  sourceContent: `source-${sourceUri}-${version}`,
  sourceStaleToken: {
    hostUri: sourceUri,
    documentIncarnation: `document-${sourceUri}`,
    documentVersion: version,
  },
  projectDigest: `project-${sourceUri}-${version}`,
  projectionKey: `projection-${sourceUri}-${version}`,
  revision: version,
  entryUri: `mmt-projection:${encodeURIComponent(sourceUri)}/main.typ`,
  languageId: "mmt",
  backendEncoding: "utf-8",
  ...overrides,
});
const immutableArtifact = (renderKey, sourceIdentity, targetUri = sourceIdentity.sourceUri) => createPreviewArtifact({
  renderKey,
  sourceUri: sourceIdentity.sourceUri,
  locationProviderKey: { kind: "immutable-map", digest: `map-${renderKey}`, coordinateVersion: "typst-page-points-v1" },
  locationMap: {
    digest: `map-${renderKey}`,
    sourceToPreview: [{
      sourceUri: sourceIdentity.sourceUri,
      sourceContent: sourceIdentity.sourceContent,
      projectionKey: sourceIdentity.projectionKey,
      range: range(2, 3, 5),
      candidates: [
        { pageIndex: 0, x: 0.1, y: 0.1 },
        { pageIndex: 1, x: 0.98, y: 0.99 },
      ],
    }],
    previewToSource: [{
      pageIndex: 1,
      x: 0.98,
      y: 0.99,
      radius: 0.08,
      target: {
        kind: "authoredIdentity",
        uri: targetUri,
        range: range(2, 3, 5),
        readOnly: false,
        retained: true,
      },
    }],
  },
  pages: [page(0), page(1)],
});

class MemoryViewportPersistence {
  records = new Map();

  load(workspaceId, sourceUri) {
    return this.records.get(`${workspaceId}\u0000${sourceUri}`);
  }

  save(workspaceId, sourceUri, viewport) {
    this.records.set(`${workspaceId}\u0000${sourceUri}`, structuredClone(viewport));
  }
}

const sourceA = "mmtfs://workspace/a.mmt";
const sourceB = "mmtfs://workspace/b.mmt";
const identityA = identity(sourceA, 4);
const identityB = identity(sourceB, 7);
const artifactA = immutableArtifact("render-a", identityA);
const artifactB = immutableArtifact("render-b", identityB);
const currentIdentityBySource = new Map([[sourceA, identityA], [sourceB, identityB]]);
const persistence = new MemoryViewportPersistence();
const statuses = [];
const indicators = [];
const cursors = [];
const opened = [];
const controller = new PreviewInteractionController({
  persistence,
  currentIdentity: (sourceUri) => currentIdentityBySource.get(sourceUri),
  openSource: async (target) => { opened.push(target); },
  events: {
    statusChanged: (status, message) => statuses.push({ status, message }),
    indicatorChanged: (indicator) => indicators.push(indicator),
    cursorChanged: (cursor) => cursors.push(cursor),
  },
});

controller.bindArtifact(artifactA, identityA);
const scheduled = new Map();
let nextTimer = 1;
let debouncedIndicators = 0;
const debounceController = new PreviewInteractionController({
  currentIdentity: () => identityA,
  setTimer(callback) {
    const handle = nextTimer++;
    scheduled.set(handle, callback);
    return handle;
  },
  clearTimer(handle) { scheduled.delete(handle); },
  events: { indicatorChanged(indicator) { if (indicator) debouncedIndicators += 1; } },
});
debounceController.bindArtifact(artifactA, identityA);
debounceController.scheduleEditorSelection({ identity: identityA, range: range(1, 0) });
debounceController.scheduleEditorSelection({ identity: identityA, range: range(2, 3, 5) });
assert.equal(scheduled.size, 1, "editor selection debounce retained more than the latest source event");
for (const callback of scheduled.values()) callback();
await Promise.resolve();
await Promise.resolve();
assert.equal(debouncedIndicators, 1, "debounced editor positioning did not publish exactly once");
debounceController.dispose();
controller.updateViewport({ page: 1, x: 2, y: -1, zoom: 9, fitMode: "page" });
assert.deepEqual(controller.viewport, { page: 1, x: 1, y: 0, zoom: 5, fitMode: "page" }, "viewport must be page-relative and bounded");
assert.equal(JSON.stringify([...persistence.records.values()]).includes("id="), false, "generated DOM ids entered persisted viewport state");

const indicatorA = await controller.navigateEditorSelection({ identity: identityA, range: range(2, 3, 5) });
assert.equal(indicatorA.point.pageIndex, 1, "editor-to-preview did not choose the candidate nearest the visible page");
assert.deepEqual(indicatorA.bounds, { left: 0.955, top: 0.965, right: 1, bottom: 1 }, "indicator was not bounded inside the page");
assert.equal(controller.cursor.renderKey, artifactA.renderKey, "cursor was not bound to the immutable artifact");
const openedA = await controller.navigatePreviewPoint({ pageIndex: 1, x: 0.99, y: 1 });
assert.equal(openedA.uri, sourceA);
assert.equal(opened.length, 1);

controller.bindArtifact(artifactB, identityB);
controller.updateViewport({ page: 0, x: 0.25, y: 0.4, zoom: 1.75, fitMode: "manual" });
controller.bindArtifact(artifactA, identityA);
assert.deepEqual(controller.viewport, { page: 1, x: 1, y: 0, zoom: 5, fitMode: "page" }, "document A viewport was overwritten by document B");
controller.bindArtifact(artifactB, identityB);
assert.deepEqual(controller.viewport, { page: 0, x: 0.25, y: 0.4, zoom: 1.75, fitMode: "manual" }, "document B viewport did not restore");

controller.bindArtifact(artifactA, identityA);
await controller.navigateEditorSelection({ identity: identityA, range: range(2, 3, 5) });
const advancedA = identity(sourceA, 5);
currentIdentityBySource.set(sourceA, advancedA);
controller.sourceIdentityAdvanced(advancedA);
assert.equal(controller.cursor, undefined, "cursor overlay survived source/render identity drift");
assert.equal(controller.indicator, undefined, "bounded indicator survived source/render identity drift");
assert.equal(statuses.at(-1).status, "stale");
currentIdentityBySource.set(sourceA, identityA);

let projectedSelections = 0;
let providerSelectionRequest;
let providerPointRequest;
const providerArtifact = createPreviewArtifact({
  renderKey: "render-provider",
  sourceUri: sourceA,
  locationProviderKey: providerKey(11),
  pages: [page(0), page(1)],
});
const resolver = {
  key: providerKey(11),
  async locateSelection(request) {
    providerSelectionRequest = request;
    return [{ pageIndex: 0, x: 0.4, y: 0.5 }];
  },
  async locatePoint(request) {
    providerPointRequest = request;
    return { uri: identityA.entryUri, range: range(9, 1, 2) };
  },
};
const projectedController = new PreviewInteractionController({
  currentIdentity: () => identityA,
  mapProjectedSelection: async (selection) => {
    projectedSelections += 1;
    return {
      revision: selection.identity.revision,
      entryUri: selection.identity.entryUri,
      range: range(18, 2, 4),
      positionEncoding: "utf-8",
      sourceContent: selection.identity.sourceContent,
      projectDigest: selection.identity.projectDigest,
      projectionKey: selection.identity.projectionKey,
    };
  },
  mapPreviewSource: async (_sourceIdentity, location) => ({
    kind: "authoredIdentity",
    uri: sourceA,
    range: location.range,
    readOnly: false,
    retained: true,
  }),
});
projectedController.bindArtifact(providerArtifact, identityA, resolver);
await projectedController.navigateEditorSelection({ identity: identityA, range: range(2, 3, 5) });
assert.equal(projectedSelections, 1, "projected MMT selection bypassed the exact forward mapping adapter");
assert.equal(providerSelectionRequest.sourceUri, identityA.entryUri);
assert.deepEqual(providerSelectionRequest.range, range(18, 2, 4));
await projectedController.navigatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3 });
assert.equal(providerPointRequest.renderKey, providerArtifact.renderKey);
projectedController.providerRestarted(providerKey(12));
assert.equal(await projectedController.navigatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3 }), undefined, "old provider-bound artifact queried a restarted provider");
assert.equal(projectedController.cursor, undefined);
assert.equal(projectedController.indicator, undefined, "bounded indicator survived provider restart");

controller.bindArtifact(artifactA, identityA);
controller.providerRestarted(providerKey(99));
assert.equal((await controller.navigatePreviewPoint({ pageIndex: 1, x: 0.98, y: 0.99 })).uri, sourceA, "retained immutable map was disabled by unrelated provider restart");

assert.equal(previewSourceTargetIsNavigable({ kind: "workspaceTypst", uri: "mmtfs://workspace/main.typ", range: range(0, 0), readOnly: false }), true);
assert.equal(previewSourceTargetIsNavigable({ kind: "packageFile", uri: "mmt-package:/preview/name/1.0.0/lib.typ", range: range(0, 0), readOnly: true, retained: true }), true);
assert.equal(previewSourceTargetIsNavigable({ kind: "generatedProjection", uri: "mmt-projection:/retained/main.typ", range: range(0, 0), readOnly: true, retained: true }), true);
assert.equal(previewSourceTargetIsNavigable({ kind: "generatedProjection", uri: sourceA, range: range(0, 0), readOnly: false, retained: true }), false, "generated output became writable authored MMT");
assert.equal(previewSourceTargetIsNavigable({ kind: "staleUnknown" }), false);

const outline = safePreviewOutline([
  { label: "Authored", target: { kind: "authoredIdentity", uri: sourceA, range: range(0, 0) } },
  { label: "Unsafe synthetic", target: { kind: "generatedProjection", uri: sourceA, range: range(0, 0) } },
  { label: "Retained dependency", target: { kind: "packageFile", uri: "mmt-package:/preview/pkg/1.0.0/lib.typ", range: range(1, 0), readOnly: true, retained: true } },
]);
assert.deepEqual(outline.map((item) => item.label), ["Authored", "Retained dependency"]);

const refreshReasons = [];
const updateCoordinator = new PreviewUpdateCoordinator({
  protocolVersion: "mmt-preview-v1",
  incrementalVersion: "mmt-preview-v1",
  partialVersion: "mmt-preview-v1",
}, { fullRefreshRequested: (reason) => refreshReasons.push(reason) });
assert.equal(updateCoordinator.accept({
  mode: "incremental", protocolVersion: "mmt-preview-v1", renderKey: "render-inc", sequence: 0,
  totalPages: 2, pages: [page(0, "inc-0")], complete: false,
}).status, "accepted");
assert.equal(updateCoordinator.accept({
  mode: "incremental", protocolVersion: "mmt-preview-v1", renderKey: "render-inc", sequence: 2,
  totalPages: 2, pages: [page(1, "inc-1")], complete: true,
}).status, "full-refresh");
assert.equal(refreshReasons.at(-1), "gap");
assert.equal(updateCoordinator.accept({
  mode: "partial", protocolVersion: "mmt-preview-v1", renderKey: "render-partial-a", sequence: 0,
  totalPages: 2, pages: [page(0, "partial-0")], complete: false,
}).status, "accepted");
assert.equal(updateCoordinator.accept({
  mode: "partial", protocolVersion: "mmt-preview-v1", renderKey: "render-partial-b", sequence: 1,
  totalPages: 2, pages: [page(1, "partial-1")], complete: true,
}).status, "full-refresh");
assert.equal(refreshReasons.at(-1), "mixed-render-key");
const recoveredFirst = updateCoordinator.accept({
  mode: "partial", protocolVersion: "mmt-preview-v1", renderKey: "render-recovered", sequence: 0,
  totalPages: 2, pages: [page(0, "recovered-0")], complete: false,
});
const recovered = updateCoordinator.accept({
  mode: "partial", protocolVersion: "mmt-preview-v1", renderKey: "render-recovered", sequence: 1,
  totalPages: 2, pages: [page(1, "recovered-1")], complete: true,
});
assert.equal(recoveredFirst.status, "accepted");
assert.equal(recovered.status, "complete", "renderer could not recover with a clean same-key full page set");
assert.deepEqual(recovered.pages.map((candidate) => candidate.pageIndex), [0, 1]);
const disabledCoordinator = new PreviewUpdateCoordinator({ protocolVersion: "mmt-preview-v1" });
assert.equal(disabledCoordinator.accept({
  mode: "incremental", protocolVersion: "mmt-preview-v1", renderKey: "render-disabled", sequence: 0,
  totalPages: 1, pages: [page(0)], complete: true,
}).status, "capability-unavailable", "incremental rendering ran without advertised capability");

assert.equal(nearestVisiblePage([
  { pageIndex: 0, x: 0.1, y: 0.1 },
  { pageIndex: 2, x: 0.2, y: 0.2 },
], 2, 3).pageIndex, 2);
assert.deepEqual(normalizeViewport({ page: -10, x: Number.NaN, y: 2, zoom: 0, fitMode: "manual" }, 2), {
  page: 0, x: 0, y: 1, zoom: 0.1, fitMode: "manual",
});

const artifactStore = new PreviewArtifactStore(artifactA.byteSize * 2);
artifactStore.put(artifactA);
artifactStore.display(sourceA, artifactA.renderKey);
const explicitlyStale = artifactStore.markStale(sourceA);
assert.equal(explicitlyStale.status, "stale");
assert.equal(explicitlyStale.displayedArtifact.renderKey, artifactA.renderKey);
assert.equal(explicitlyStale.displayedArtifact.stale, true);
artifactStore.dispose();

assert.ok(indicators.some(Boolean));
assert.ok(cursors.some(Boolean));
controller.dispose();
projectedController.dispose();
console.log(JSON.stringify({
  debouncedNavigationCore: true,
  projectedRangeAdapter: "mmt/typstRange",
  reverseMappingAdapter: "mmt/mapTypstReadLocations",
  boundedIndicator: true,
  artifactBoundCursor: true,
  normalizedViewport: true,
  perDocumentPersistence: true,
  immutableOldArtifactMap: true,
  incrementalGapRefresh: true,
  partialRenderKeyIsolation: true,
  safeOutline: true,
  rendererRecovery: true,
}));
