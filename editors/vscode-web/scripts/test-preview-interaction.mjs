import assert from "node:assert/strict";
import {
  PreviewArtifactStore,
  createPreviewArtifact,
} from "../src/previewArtifact.ts";
import {
  PreviewInteractionController,
  fallbackPreviewSourceTarget,
  PreviewUpdateCoordinator,
  nearestVisiblePage,
  normalizeViewport,
  previewSourceTargetIsNavigable,
  safePreviewOutline,
} from "../src/previewInteraction.ts";
import {
  findProjectedTextCall,
  projectedTextCharacterByteOffset,
} from "../src/previewTextLocation.ts";

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
  visualSnapshot: { kind: "svg", pages: [page(0), page(1)], imageAssets: [] },
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
const pageFitController = new PreviewInteractionController({ defaultFitMode: () => "page" });
pageFitController.bindArtifact(artifactA, identityA);
assert.equal(pageFitController.viewport.fitMode, "page");

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
  visualSnapshot: { kind: "svg", pages: [page(0), page(1)], imageAssets: [] },
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
await projectedController.navigatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3, text: "1234abcd", textOffset: 4 });
assert.equal(providerPointRequest.renderKey, providerArtifact.renderKey);
assert.equal(providerPointRequest.text, "1234abcd");
assert.equal(providerPointRequest.textOffset, 4);
providerPointRequest = undefined;
projectedController.bindArtifact(providerArtifact, identityA);
await projectedController.navigatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3 });
assert.equal(providerPointRequest.renderKey, providerArtifact.renderKey, "same artifact rebind discarded its exact location resolver");
projectedController.providerRestarted(providerKey(12));
assert.equal(await projectedController.navigatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3 }), undefined, "old provider-bound artifact queried a restarted provider");
assert.equal(projectedController.cursor, undefined);
assert.equal(projectedController.indicator, undefined, "bounded indicator survived provider restart");

const locatedStatuses = [];
const locatedMappedTargets = [];
const locatedOpenedTargets = [];
const locatedController = new PreviewInteractionController({
  currentIdentity: () => identityA,
  mapPreviewSource: async (_sourceIdentity, location) => {
    locatedMappedTargets.push(location);
    return {
      kind: "authoredIdentity",
      uri: sourceA,
      range: location.range,
      readOnly: false,
      retained: true,
    };
  },
  openSource: async (target) => { locatedOpenedTargets.push(target); },
  events: { statusChanged: (status) => locatedStatuses.push(status) },
});
locatedController.bindArtifact(providerArtifact, identityA, resolver);
const statusCountBeforeLocate = locatedStatuses.length;
const locatedPoint = await locatedController.locatePreviewPoint({ pageIndex: 0, x: 0.4, y: 0.6 });
assert.deepEqual(locatedPoint, {
  identity: identityA,
  location: { uri: identityA.entryUri, range: range(9, 1, 2) },
}, "provider-backed Composer location did not retain the exact artifact identity");
assert.equal(locatedMappedTargets.length, 0, "Composer location invoked navigation-only authored/fallback mapping");
assert.equal(locatedOpenedTargets.length, 0, "Composer location opened a source editor");
assert.equal(locatedStatuses.length, statusCountBeforeLocate, "Composer location emitted navigation status");
const navigatedTarget = await locatedController.navigatePreviewPoint({ pageIndex: 0, x: 0.4, y: 0.6 });
assert.equal(navigatedTarget.uri, sourceA, "provider navigation stopped mapping the backend location to authored source");
assert.equal(locatedMappedTargets.length, 1, "provider navigation did not reuse its provider point location");
assert.equal(locatedOpenedTargets.length, 1, "provider navigation stopped opening its mapped target");

const rendererProvider = {
  kind: "renderer-provider",
  sessionId: "renderer-session-context",
  snapshotToken: "render-renderer-provider",
  artifactDigest: "b".repeat(64),
  backendGeneration: 3,
  rendererGeneration: 5,
  method: "mmt/previewRenderer.v1",
  coordinateVersion: "typst-page-points-v1",
};
const rendererProviderArtifact = createPreviewArtifact({
  renderKey: rendererProvider.snapshotToken,
  sourceUri: sourceA,
  locationProviderKey: rendererProvider,
  visualSnapshot: {
    kind: "renderer",
    artifactDigest: rendererProvider.artifactDigest,
    sourceDigest: "c".repeat(64),
    backendGeneration: rendererProvider.backendGeneration,
    rendererGeneration: rendererProvider.rendererGeneration,
    frameKind: "new",
    sessionId: rendererProvider.sessionId,
    snapshotToken: rendererProvider.snapshotToken,
    byteLength: 256,
    pages: [{ pageIndex: 0, geometry: { viewBox: [0, 0, 100, 200], cssWidth: 100, cssHeight: 200 } }],
  },
});
const rendererProviderController = new PreviewInteractionController({ currentIdentity: () => identityA });
rendererProviderController.bindArtifact(rendererProviderArtifact, identityA, {
  key: rendererProvider,
  async locateSelection() { return []; },
  async locatePoint() { return { uri: identityA.entryUri, range: range(12, 4, 6) }; },
});
assert.deepEqual(
  await rendererProviderController.locatePreviewPoint({ pageIndex: 0, x: 0.5, y: 0.5 }),
  { identity: identityA, location: { uri: identityA.entryUri, range: range(12, 4, 6) } },
  "current renderer-provider artifact did not authorize its exact Composer location",
);
assert.equal(locatedStatuses.at(-1), "ready", "provider navigation stopped publishing ready after a successful open");

let fallbackMappingCalls = 0;
const immutableComposerController = new PreviewInteractionController({
  currentIdentity: () => identityA,
  mapPreviewSource: async () => {
    fallbackMappingCalls += 1;
    return fallbackPreviewSourceTarget({ uri: sourceA, range: range(2, 3, 5) });
  },
});
immutableComposerController.bindArtifact(artifactA, identityA);
assert.equal(
  await immutableComposerController.locatePreviewPoint({ pageIndex: 1, x: 0.98, y: 0.99 }),
  undefined,
  "immutable navigation map authorized a Composer location",
);
assert.equal(fallbackMappingCalls, 0, "navigation-only authored fallback authorized a Composer location");

let resolveDriftLocation;
const driftResolver = {
  key: providerKey(11),
  async locateSelection() { return []; },
  locatePoint() {
    return new Promise((resolve) => { resolveDriftLocation = resolve; });
  },
};
const driftController = new PreviewInteractionController();
driftController.bindArtifact(providerArtifact, identityA, driftResolver);
const staleLocation = driftController.locatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3 });
driftController.sourceIdentityAdvanced(advancedA);
resolveDriftLocation({ uri: identityA.entryUri, range: range(9, 1, 2) });
assert.equal(await staleLocation, undefined, "async source identity drift published a Composer location");

driftController.bindArtifact(providerArtifact, identityA, driftResolver);
const replacedProviderLocation = driftController.locatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3 });
driftController.bindArtifact(providerArtifact, identityA, {
  key: providerKey(11),
  async locateSelection() { return []; },
  async locatePoint() { return { uri: identityA.entryUri, range: range(10, 0, 1) }; },
});
resolveDriftLocation({ uri: identityA.entryUri, range: range(9, 1, 2) });
assert.equal(await replacedProviderLocation, undefined, "async provider identity drift published a Composer location");

controller.bindArtifact(artifactA, identityA);
controller.providerRestarted(providerKey(99));
assert.equal((await controller.navigatePreviewPoint({ pageIndex: 1, x: 0.98, y: 0.99 })).uri, sourceA, "retained immutable map was disabled by unrelated provider restart");

const splitProjection = '#text("前置终端目前能正常启动。先读取它保存的维护状态。后置")';
const splitFragment = "终端目前能正常启动。";
const splitCall = findProjectedTextCall(splitProjection, 0, 5, splitFragment);
assert.ok(splitCall, "renderer text fragment was not found inside its generated #text call");
const splitFragmentOffset = 4;
assert.equal(
  projectedTextCharacterByteOffset(splitCall, splitFragmentOffset),
  new TextEncoder().encode(
    splitProjection.slice(0, splitProjection.indexOf(splitFragment) + splitFragmentOffset),
  ).byteLength,
  "renderer fragment offset did not include the fragment's position inside the full generated text",
);
assert.equal(
  findProjectedTextCall('#text("重复重复")', 0, 5, "重复"),
  undefined,
  "ambiguous renderer fragments must not claim a character-accurate source location",
);
assert.equal(
  findProjectedTextCall(String.raw`#text("escaped\ntext")`, 0, 5, "escaped\ntext"),
  undefined,
  "a renderer fragment crossing an escaped projection segment became reverse-mappable",
);
const newlineSuffixedCall = String.raw`#text("终端目前能正常启动。先读取它保存的维护状态。\n")`;
assert.deepEqual(
  findProjectedTextCall(newlineSuffixedCall, 0, 5, "终端目前能正常启动。先读取它保存的维护状态。"),
  { text: "终端目前能正常启动。先读取它保存的维护状态。", contentStart: 7, fragmentStart: 0 },
  "a canonical escaped newline suffix hid the preceding exact authored text",
);
const adjacentCalls = String.raw`#text("escaped\n") #text("target")`;
const targetCallStart = adjacentCalls.indexOf('#text("target")');
assert.deepEqual(
  findProjectedTextCall(adjacentCalls, targetCallStart, targetCallStart + 5, "target"),
  { text: "target", contentStart: targetCallStart + 7, fragmentStart: 0 },
  "an unrelated escaped call hid the overlapping plain-text call later on the same generated line",
);

const staleMmtfsTarget = fallbackPreviewSourceTarget({
  uri: "mmtfs://workspace/stale.typ",
  range: range(0, 0),
});
assert.deepEqual(staleMmtfsTarget, {
  kind: "workspaceTypst",
  uri: "mmtfs://workspace/stale.typ",
  range: range(0, 0),
  readOnly: false,
  retained: true,
}, "stale mmtfs renderer location did not retain an editable workspace fallback");
assert.equal(fallbackPreviewSourceTarget({
  uri: "untitled:/mmt-projection/stale.typ",
  range: range(0, 0),
}), undefined, "raw generated untitled location became an editable fallback");
assert.equal(fallbackPreviewSourceTarget({
  uri: "https://renderer.invalid/stale.typ",
  range: range(0, 0),
}), undefined, "HTTP renderer location became an editable fallback");
assert.equal(fallbackPreviewSourceTarget({
  uri: "mmt-renderer:/internal/stale.typ",
  range: range(0, 0),
}), undefined, "renderer-internal location became an editable fallback");

assert.equal(previewSourceTargetIsNavigable(staleMmtfsTarget), true);
assert.equal(previewSourceTargetIsNavigable({ kind: "workspaceTypst", uri: "untitled:/authored/main.typ", range: range(0, 0), readOnly: false }), true);
assert.equal(previewSourceTargetIsNavigable({ kind: "workspaceTypst", uri: "untitled:/mmt-projection/main.typ", range: range(0, 0), readOnly: false }), false);
assert.equal(previewSourceTargetIsNavigable({ kind: "workspaceTypst", uri: "https://renderer.invalid/main.typ", range: range(0, 0), readOnly: false }), false);
assert.equal(previewSourceTargetIsNavigable({ kind: "packageFile", uri: "mmt-package:/preview/name/1.0.0/lib.typ", range: range(0, 0), readOnly: true, retained: true }), true);
const retainedProjectionTarget = {
  kind: "generatedProjection",
  uri: "mmt-projection:/retained/main.typ",
  range: range(0, 0),
  readOnly: true,
  retained: true,
};
assert.equal(previewSourceTargetIsNavigable(retainedProjectionTarget), true);
assert.equal(previewSourceTargetIsNavigable({ kind: "generatedProjection", uri: sourceA, range: range(0, 0), readOnly: false, retained: true }), false, "generated output became writable authored MMT");
assert.equal(previewSourceTargetIsNavigable({ kind: "staleUnknown" }), false);

const mappedOpens = [];
const mappedStatuses = [];
const mappedSourceOpened = [];
const mappedTargetController = new PreviewInteractionController({
  openSource: async (target) => { mappedOpens.push(target); },
  events: {
    statusChanged: (status) => mappedStatuses.push(status),
    sourceOpened: (target) => mappedSourceOpened.push(target),
  },
});
assert.equal(await mappedTargetController.openMappedTarget(staleMmtfsTarget), true);
assert.equal(await mappedTargetController.openMappedTarget(retainedProjectionTarget), true);
assert.deepEqual(mappedOpens, [staleMmtfsTarget, retainedProjectionTarget], "navigable stale workspace and retained projection targets were not really opened");
assert.deepEqual(mappedSourceOpened, mappedOpens, "sourceOpened did not follow successful opens");
assert.deepEqual(mappedStatuses, ["ready", "ready"], "successful mapped opens did not become ready");

const providerFailureStatuses = [];
const providerFailureSourceOpened = [];
const providerFailureController = new PreviewInteractionController({
  currentIdentity: () => identityA,
  openSource: async () => { throw new Error("must not open after provider failure"); },
  events: {
    statusChanged: (status) => providerFailureStatuses.push(status),
    sourceOpened: (target) => providerFailureSourceOpened.push(target),
  },
});
providerFailureController.bindArtifact(providerArtifact, identityA, {
  key: providerKey(11),
  async locateSelection() { return []; },
  async locatePoint() { throw new Error("provider failed"); },
});
providerFailureStatuses.length = 0;
assert.equal(await providerFailureController.navigatePreviewPoint({ pageIndex: 0, x: 0.2, y: 0.3 }), undefined);
assert.deepEqual(providerFailureStatuses, ["unmapped"], "provider failure did not become unmapped");
assert.equal(providerFailureSourceOpened.length, 0, "provider failure emitted sourceOpened");
assert.equal(providerFailureStatuses.includes("ready"), false, "provider failure emitted ready");

const openFailureStatuses = [];
const openFailureSourceOpened = [];
const openFailureController = new PreviewInteractionController({
  currentIdentity: () => identityA,
  openSource: async () => { throw new Error("open failed"); },
  events: {
    statusChanged: (status) => openFailureStatuses.push(status),
    sourceOpened: (target) => openFailureSourceOpened.push(target),
  },
});
openFailureController.bindArtifact(artifactA, identityA);
openFailureStatuses.length = 0;
assert.equal(await openFailureController.navigatePreviewPoint({ pageIndex: 1, x: 0.98, y: 0.99 }), undefined);
assert.deepEqual(openFailureStatuses, ["unmapped"], "open failure did not become unmapped");
assert.equal(openFailureSourceOpened.length, 0, "open failure emitted sourceOpened");
assert.equal(openFailureStatuses.includes("ready"), false, "open failure emitted ready");

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
locatedController.dispose();
immutableComposerController.dispose();
rendererProviderController.dispose();
driftController.dispose();
console.log(JSON.stringify({
  debouncedNavigationCore: true,
  projectedRangeAdapter: "mmt/typstRange",
  reverseMappingAdapter: "mmt/mapTypstReadLocations",
  boundedIndicator: true,
  artifactBoundCursor: true,
  normalizedViewport: true,
  perDocumentPersistence: true,
  immutableOldArtifactMap: true,
  providerBackedComposerLocation: true,
  splitTextSpanRefinement: true,
  composerIdentityDriftRejection: true,
  incrementalGapRefresh: true,
  partialRenderKeyIsolation: true,
  safeOutline: true,
  rendererRecovery: true,
}));
