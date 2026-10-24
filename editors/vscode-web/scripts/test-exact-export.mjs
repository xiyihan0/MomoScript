import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ArtifactUnavailableError,
  ExactExportService,
  ExportChoiceRequiredError,
  PreviewNotExportableError,
  exactExportFileName,
} from "../src/exactExport.ts";
import { PreviewArtifactStore, createPreviewArtifact, previewImageAssetHref } from "../src/previewArtifact.ts";
import { ExactExportUiController, LatestExactArtifactWaiter } from "../src/exactExportUi.ts";
import { createCurrentPreviewExportClient } from "../src/currentPreviewExport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sourceUri = "mmtfs://workspace/story.mmt";
const causes = ["source", "dependency", "materialization", "render", "backend", "runtime"];
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageAsset = Object.freeze({
  digest: imageDigest,
  mimeType: "image/png",
  blob: new Blob([new Uint8Array([65])], { type: "image/png" }),
});

function page(marker) {
  return {
    pageIndex: 0,
    geometry: { viewBox: [0, 0, 120, 240], cssWidth: 120, cssHeight: 240 },
    sanitizedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 240"><text>${marker}</text></svg>`,
  };
}

function artifact(key, marker) {
  const renderedPage = page(marker);
  const withImage = marker === "A"
    ? {
        ...renderedPage,
        sanitizedSvg: renderedPage.sanitizedSvg.replace(
          "</svg>",
          `<image href="${previewImageAssetHref(imageDigest)}"/></svg>`,
        ),
      }
    : renderedPage;
  return createPreviewArtifact({
    renderKey: key,
    sourceUri,
    locationProviderKey: {
      kind: "provider",
      backendOrTraceArtifactDigest: `sha256:location-${marker}`,
      backendGeneration: 1,
      method: "tinymist/preview/location.v1",
      coordinateVersion: "typst-page-points-v1",
    },
    visualSnapshot: {
      kind: "svg",
      pages: [withImage],
      imageAssets: marker === "A" ? [imageAsset] : [],
    },
  });
}

function retainedInputs(key, marker) {
  const entryBytes = encoder.encode(`source-${marker}`);
  const resourceBytes = encoder.encode(`resource-${marker}`);
  const compilerBytes = encoder.encode(`compiler-${marker}`);
  const fontBytes = encoder.encode(`font-${marker}`);
  return {
    mutable: { entryBytes, resourceBytes, compilerBytes, fontBytes },
    render: {
      renderKey: key,
      materializationKey: `materialization-${marker}`,
      runtimeArtifactKey: `runtime-${marker}`,
      renderOptionsDigest: `sha256:options-${marker}`,
      entryPath: "/main.typ",
      files: [
        { path: "/main.typ", kind: "source", contentDigest: `sha256:source-${marker}`, bytes: entryBytes },
        { path: "/assets/picture.png", kind: "resource", contentDigest: `sha256:resource-${marker}`, bytes: resourceBytes },
      ],
      packageRoots: [{ namespace: "preview", name: "fixture", version: "1.0.0", root: "/packages/fixture" }],
      sysInputs: { revision: marker },
    },
    runtime: {
      runtimeArtifactKey: `runtime-${marker}`,
      compilerVersion: `compiler-${marker}`,
      compilerWasmDigest: `sha256:compiler-${marker}`,
      compilerWasmBytes: compilerBytes,
      rendererVersion: `renderer-${marker}`,
      rendererWasmDigest: `sha256:renderer-${marker}`,
      templateBundleDigest: `sha256:templates-${marker}`,
      fontSetDigest: `sha256:fonts-${marker}`,
      fonts: [{ family: "Fixture Sans", contentDigest: `sha256:font-${marker}`, bytes: fontBytes }],
    },
  };
}

function contentKey(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function assertResult(result, expectedKey, expectedBytes, staleDisplayedRevision) {
  const actual = new Uint8Array(await result.blob.arrayBuffer());
  assert.deepEqual(actual, expectedBytes);
  assert.equal(result.metadata.renderKey, expectedKey);
  assert.equal(result.metadata.sourceUri, sourceUri);
  assert.equal(result.metadata.staleDisplayedRevision, staleDisplayedRevision);
  assert.equal(result.metadata.contentKey, contentKey(expectedBytes));
  assert.equal(result.extension, result.metadata.format);
}

const a = artifact("render-a", "A");
const b = artifact("render-b", "B");
const store = new PreviewArtifactStore(a.byteSize + b.byteSize + 64);
store.put(a);
store.put(b);
store.display(sourceUri, a.renderKey);

let latestResolve;
let latestWaits = 0;
const rasterCalls = [];
const pdfCalls = [];
let pinCount = 0;
let releaseCount = 0;
const artifacts = {
  document: (uri) => store.document(uri),
  get: (key) => store.get(key),
  pin: (key) => {
    pinCount += 1;
    const release = store.pin(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCount += 1;
      release();
    };
  },
};
const service = new ExactExportService({
  artifacts,
  raster: {
    async encode(renderedPage, format, signal) {
      signal.throwIfAborted();
      rasterCalls.push({ format, svg: renderedPage.sanitizedSvg, geometry: renderedPage.geometry });
      return encoder.encode(`${format}:${renderedPage.sanitizedSvg}`);
    },
  },
  pdf: {
    async compile(render, runtime, signal) {
      signal.throwIfAborted();
      const entry = render.files.find((file) => file.path === render.entryPath);
      assert.ok(entry, "immutable PDF session must receive its retained entry file");
      const call = {
        renderKey: render.renderKey,
        materializationKey: render.materializationKey,
        runtimeArtifactKey: runtime.runtimeArtifactKey,
        entry: decoder.decode(entry.bytes),
        resource: decoder.decode(render.files.find((file) => file.kind === "resource").bytes),
        compiler: decoder.decode(runtime.compilerWasmBytes),
        font: decoder.decode(runtime.fonts[0].bytes),
      };
      pdfCalls.push(call);
      return encoder.encode(`pdf:${call.renderKey}:${call.entry}:${call.resource}:${call.compiler}:${call.font}`);
    },
  },
  latest: {
    waitForLatest(uri, afterRenderKey, signal) {
      latestWaits += 1;
      assert.equal(uri, sourceUri);
      assert.equal(afterRenderKey, a.renderKey);
      return new Promise((resolve, reject) => {
        latestResolve = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  },
});

const retainedA = retainedInputs(a.renderKey, "A");
const retainedB = retainedInputs(b.renderKey, "B");
service.retainInputs(retainedA.render, retainedA.runtime);
service.retainInputs(retainedB.render, retainedB.runtime);
for (const bytes of Object.values(retainedA.mutable)) bytes.fill(0x58);
for (const bytes of Object.values(retainedB.mutable)) bytes.fill(0x59);
assert.throws(
  () => service.retainInputs({ ...retainedA.render, renderOptionsDigest: "sha256:changed" }, retainedA.runtime),
  /already bound to different immutable renderer inputs/,
);

const raceTokens = causes.map((cause) => {
  const token = service.advance(sourceUri, cause);
  assert.equal(service.availability(sourceUri).kind, "stale-choice", `${cause} advance must mark the displayed artifact stale`);
  return token;
});
assert.equal(service.publishLatest(raceTokens.at(-1), a.renderKey), false, "an advance cannot be cleared by republishing its old displayed key");
store.request(sourceUri, b.renderKey);
assert.equal(service.publishLatest(raceTokens[0], b.renderKey), false, "an older race token cannot publish over a newer dependency/runtime advance");
await assert.rejects(
  service.export({ sourceUri, format: "svg" }),
  (error) => error instanceof ExportChoiceRequiredError && error.displayedRenderKey === a.renderKey,
);
await assert.rejects(
  service.export({ sourceUri, format: "svg", staleChoice: "implicit-current" }),
  /Unsupported stale export choice/,
);

const expandedASvg = a.pages[0].sanitizedSvg.replace(
  previewImageAssetHref(imageDigest),
  "data:image/png;base64,QQ==",
);
const expectedA = {
  svg: encoder.encode(expandedASvg),
  png: encoder.encode(`png:${expandedASvg}`),
  jpg: encoder.encode(`jpg:${expandedASvg}`),
  pdf: encoder.encode("pdf:render-a:source-A:resource-A:compiler-A:font-A"),
};
for (const format of ["svg", "png", "jpg", "pdf"]) {
  const result = await service.export({ sourceUri, format, staleChoice: "export-displayed" });
  await assertResult(result, a.renderKey, expectedA[format], true);
  if (format === "pdf") {
    assert.equal(result.metadata.materializationKey, "materialization-A");
    assert.equal(result.metadata.runtimeArtifactKey, "runtime-A");
    assert.equal(result.metadata.renderOptionsDigest, "sha256:options-A");
  } else {
    assert.equal(result.metadata.pageIndex, 0);
    assert.deepEqual(result.metadata.pageGeometry, a.pages[0].geometry);
  }
}
assert.equal(rasterCalls.length, 2);
assert.ok(rasterCalls.every((call) => call.svg.includes(">A<")), "raster ports must never receive current B shadows");
assert.deepEqual(pdfCalls[0], {
  renderKey: "render-a",
  materializationKey: "materialization-A",
  runtimeArtifactKey: "runtime-A",
  entry: "source-A",
  resource: "resource-A",
  compiler: "compiler-A",
  font: "font-A",
});

const waitForB = service.export({ sourceUri, format: "pdf", staleChoice: "wait-for-latest" });
await Promise.resolve();
assert.equal(latestWaits, 1);
store.display(sourceUri, b.renderKey);
assert.equal(service.publishLatest(raceTokens.at(-1), b.renderKey), true);
latestResolve(b.renderKey);
const resultB = await waitForB;
await assertResult(resultB, b.renderKey, encoder.encode("pdf:render-b:source-B:resource-B:compiler-B:font-B"), false);
assert.equal(resultB.metadata.materializationKey, "materialization-B");
assert.equal(resultB.metadata.runtimeArtifactKey, "runtime-B");
assert.equal(pinCount, releaseCount, "every successful or rejected export must release its artifact pin");

service.evictInputs(b.renderKey);
await assert.rejects(
  service.export({ sourceUri, format: "pdf" }),
  (error) => error instanceof ArtifactUnavailableError && error.code === "ArtifactUnavailable",
);
await assertResult(
  await service.export({ sourceUri, format: "svg" }),
  b.renderKey,
  encoder.encode(b.pages[0].sanitizedSvg),
  false,
);

const evictionStore = new PreviewArtifactStore(a.byteSize + 8);
evictionStore.put(a);
evictionStore.display(sourceUri, a.renderKey);
evictionStore.put(artifact("render-c", "C"));
const evictedService = new ExactExportService({
  artifacts: evictionStore,
  raster: { async encode() { throw new Error("evicted artifact must not rasterize"); } },
  pdf: { async compile() { throw new Error("evicted artifact must not compile"); } },
  latest: { async waitForLatest() { throw new Error("evicted artifact has no latest wait"); } },
});
assert.deepEqual(evictedService.availability(sourceUri), { kind: "unavailable", reason: "ArtifactUnavailable" });
await assert.rejects(evictedService.export({ sourceUri, format: "svg" }), ArtifactUnavailableError);
evictedService.dispose();
evictionStore.dispose();

function unavailableService(status) {
  return new ExactExportService({
    artifacts: {
      document: (uri) => ({
        sourceUri: uri,
        status,
        viewport: { page: 0, x: 0, y: 0, zoom: 1, fitMode: "width" },
      }),
      get: () => undefined,
      pin: () => { throw new Error("unavailable state must not pin"); },
    },
    raster: { async encode() { throw new Error("unavailable state must not rasterize"); } },
    pdf: { async compile() { throw new Error("unavailable state must not compile"); } },
    latest: { async waitForLatest() { throw new Error("unavailable state must not wait"); } },
  });
}
for (const [status, code] of [["rendering", "PartialPreview"], ["failed", "FailedPreview"]]) {
  const unavailable = unavailableService(status);
  await assert.rejects(
    unavailable.export({ sourceUri, format: "svg" }),
    (error) => error instanceof PreviewNotExportableError && error.code === code,
  );
  unavailable.dispose();
}

const abortStore = new PreviewArtifactStore(a.byteSize + 8);
abortStore.put(a);
abortStore.display(sourceUri, a.renderKey);
let abortReleaseCount = 0;
let rasterStartedResolve;
const rasterStarted = new Promise((resolve) => { rasterStartedResolve = resolve; });
const abortingService = new ExactExportService({
  artifacts: {
    document: (uri) => abortStore.document(uri),
    get: (key) => abortStore.get(key),
    pin: (key) => {
      const release = abortStore.pin(key);
      return () => { abortReleaseCount += 1; release(); };
    },
  },
  raster: {
    encode(_page, _format, signal) {
      rasterStartedResolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  },
  pdf: { async compile() { throw new Error("not exercised"); } },
  latest: { async waitForLatest() { throw new Error("not exercised"); } },
});
const interrupted = abortingService.export({ sourceUri, format: "png" });
await rasterStarted;
abortingService.dispose();
await assert.rejects(interrupted, (error) => error?.name === "AbortError");
assert.equal(abortReleaseCount, 1, "dispose must abort work and release the pinned displayed artifact");
assert.throws(() => abortingService.advance(sourceUri, "source"), /disposed/);
abortStore.put(artifact("render-after-dispose", "D"));
assert.equal(abortStore.get(a.renderKey), undefined, "released pins must not survive service disposal");
abortStore.dispose();
const latestWaiter = new LatestExactArtifactWaiter();
latestWaiter.publish(sourceUri, a.renderKey);
const firstWaitAbort = new AbortController();
const firstWait = latestWaiter.waitForLatest(sourceUri, a.renderKey, firstWaitAbort.signal);
firstWaitAbort.abort(new DOMException("cancel first wait", "AbortError"));
await assert.rejects(firstWait, (error) => error?.name === "AbortError");
const retriedWait = latestWaiter.waitForLatest(sourceUri, a.renderKey, new AbortController().signal);
let retriedSettled = false;
void retriedWait.then(() => { retriedSettled = true; });
latestWaiter.publish(sourceUri, a.renderKey);
await Promise.resolve();
assert.equal(retriedSettled, false, "retry resolved without a new renderKey");
latestWaiter.publish(sourceUri, b.renderKey);
assert.equal(await retriedWait, b.renderKey, "retry did not resolve to the new renderKey");

const setupAbort = new DOMException("abort during waiter setup", "AbortError");
const racingSignal = {
  aborted: false,
  reason: setupAbort,
  throwIfAborted() {},
  addEventListener() { this.aborted = true; },
  removeEventListener() {},
};
await assert.rejects(
  latestWaiter.waitForLatest(sourceUri, b.renderKey, racingSignal),
  (error) => error === setupAbort,
);
latestWaiter.dispose();

const outputPages = [
  page("first-page-only"),
  {
    pageIndex: 1,
    geometry: { viewBox: [0, 0, 81, 123], cssWidth: 81, cssHeight: 123 },
    sanitizedSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 81 123"><rect width="81" height="123" fill="#185ea8"/><text>second-page-only</text></svg>',
  },
];
const pagedArtifact = (key, marker, renderPreset = { kind: "output" }) => createPreviewArtifact({
  renderKey: key,
  sourceUri,
  renderPreset,
  locationProviderKey: a.locationProviderKey,
  visualSnapshot: {
    kind: "svg",
    pages: outputPages.map((value) => ({ ...value, sanitizedSvg: value.sanitizedSvg.replace("-only", `-${marker}`) })),
    imageAssets: [],
  },
});
const paged = pagedArtifact("paged-output-a", "A");
const nextPaged = pagedArtifact("paged-output-b", "B");
const chatArtifact = pagedArtifact("paged-chat", "chat", { kind: "chat", widthPt: 390 });
const pageStore = new PreviewArtifactStore((paged.byteSize + nextPaged.byteSize + chatArtifact.byteSize) * 2);
for (const value of [paged, nextPaged, chatArtifact]) pageStore.put(value);
pageStore.display(sourceUri, paged.renderKey);
const pageLatest = new LatestExactArtifactWaiter();
pageLatest.publish(sourceUri, paged.renderKey);
const pageService = new ExactExportService({
  artifacts: pageStore,
  raster: { async encode() { throw new Error("SVG page selection must not rasterize"); } },
  pdf: { async compile() { throw new Error("SVG page selection must not compile PDF"); } },
  latest: pageLatest,
});
const secondPage = await pageService.export({ sourceUri, format: "svg", pageIndex: 1 });
assert.match(await secondPage.blob.text(), /second-page-A/);
assert.doesNotMatch(await secondPage.blob.text(), /first-page-A/);
assert.equal(secondPage.metadata.fileName, "story-page-2.svg");
assert.equal(secondPage.metadata.pageCount, 2);
assert.equal(secondPage.metadata.pageIndex, 1);
assert.deepEqual(secondPage.metadata.pageGeometry, outputPages[1].geometry);
assert.equal(
  exactExportFileName(`mmtfs://workspace/${encodeURIComponent("作品%name.mmt")}`, "png", 1, true),
  "作品%name-snapshot-page-2.png",
  "download names must decode URI encoding exactly once",
);
for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2, "1"]) {
  await assert.rejects(pageService.export({ sourceUri, format: "svg", pageIndex: invalid }), RangeError);
}
await assert.rejects(pageService.export({ sourceUri, format: "pdf", pageIndex: 0 }), RangeError);

const immutablePages = new Map([[paged.renderKey, paged], [nextPaged.renderKey, nextPaged]]);
const currentClient = createCurrentPreviewExportClient({
  artifacts: pageStore,
  latest: pageLatest,
  preview: () => ({
    displayedRenderKey: pageStore.document(sourceUri).displayedArtifact?.renderKey,
    async createExport() { throw new Error("Retained output must not use the mutable live compiler"); },
  }),
  immutable: {
    has: (key) => immutablePages.has(key),
    async export(key, format, pageIndex, signal) {
      signal?.throwIfAborted();
      const retained = immutablePages.get(key);
      return { blob: new Blob([retained.pages[pageIndex].sanitizedSvg], { type: "image/svg+xml" }), extension: format };
    },
  },
});
pageStore.request(sourceUri, nextPaged.renderKey);
assert.equal(pageStore.document(sourceUri).displayedArtifact.renderPreset.kind, "output", "stale clones must retain the accepted presentation");
assert.equal(currentClient.availability(sourceUri).kind, "stale-choice");
await assert.rejects(currentClient.export({ sourceUri, format: "svg", pageIndex: 1 }), ExportChoiceRequiredError);
const stalePage = await currentClient.export({ sourceUri, format: "svg", pageIndex: 1, staleChoice: "export-displayed" });
assert.match(await stalePage.blob.text(), /second-page-A/);
assert.equal(stalePage.metadata.fileName, "story-snapshot-page-2.svg");
assert.equal(stalePage.metadata.staleDisplayedRevision, true);
const newestPage = currentClient.export({ sourceUri, format: "svg", pageIndex: 1, staleChoice: "wait-for-latest" });
pageStore.display(sourceUri, nextPaged.renderKey);
pageLatest.publish(sourceUri, nextPaged.renderKey);
const latestPage = await newestPage;
assert.match(await latestPage.blob.text(), /second-page-B/);
assert.equal(latestPage.metadata.fileName, "story-page-2.svg");
assert.equal(latestPage.metadata.staleDisplayedRevision, false);
for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2, "1"]) {
  await assert.rejects(currentClient.export({ sourceUri, format: "svg", pageIndex: invalid }), RangeError);
}
await assert.rejects(currentClient.export({ sourceUri, format: "pdf", pageIndex: 1 }), RangeError);
pageStore.display(sourceUri, chatArtifact.renderKey);
pageStore.request(sourceUri, nextPaged.renderKey);
assert.equal(pageStore.document(sourceUri).displayedArtifact.renderPreset.kind, "chat");
for (const client of [currentClient, pageService]) {
  await assert.rejects(client.export({ sourceUri, format: "svg", staleChoice: "export-displayed" }), PreviewNotExportableError);
}
pageStore.display(sourceUri, nextPaged.renderKey);

let releaseDelivery;
let startDelivery;
const deliveryStarted = new Promise((resolve) => { startDelivery = resolve; });
const deliveryPending = new Promise((resolve) => { releaseDelivery = resolve; });
const deliveryPhases = [];
const deliveryUi = new ExactExportUiController(pageService, {
  stateChanged: (state) => deliveryPhases.push(state.phase),
  async deliver(result) {
    assert.match(await result.blob.text(), /second-page-B/);
    startDelivery();
    await deliveryPending;
  },
});
deliveryUi.bind(sourceUri);
const delivering = deliveryUi.export("svg", { pageIndex: 1 });
await deliveryStarted;
assert.equal(deliveryUi.state.phase, "exporting", "generation alone must not report download completion");
assert.equal(deliveryUi.state.canCancel, false, "a download already being dispatched cannot be recalled");
assert.equal(deliveryUi.cancel(), false);
assert.equal(deliveryPhases.includes("complete"), false);
releaseDelivery();
assert.ok(await delivering);
assert.equal(deliveryUi.state.phase, "complete");
assert.equal(deliveryUi.state.completedFileName, "story-page-2.svg");
assert.equal(deliveryUi.state.completedPageIndex, 1);
assert.equal(deliveryUi.state.completedPageCount, 2);
deliveryUi.dispose();

let failDelivery = true;
let deliveredCount = 0;
const failureUi = new ExactExportUiController(currentClient, {
  deliver() {
    if (failDelivery) throw new Error("Browser refused download dispatch");
    deliveredCount += 1;
  },
}, "current-preview");
failureUi.bind(sourceUri);
assert.equal(await failureUi.export("svg", { pageIndex: 1 }), undefined);
assert.equal(failureUi.state.phase, "error");
assert.match(failureUi.state.message, /Browser refused download dispatch/);
assert.equal(failureUi.state.completedFileName, undefined);
failDelivery = false;
assert.ok(await failureUi.export("svg", { pageIndex: 1 }));
assert.equal(deliveredCount, 1);
assert.equal(failureUi.state.phase, "complete");

pageStore.request(sourceUri, "pending-output");
const cancelledExport = failureUi.export("svg", { pageIndex: 1, staleChoice: "wait-for-latest" });
assert.equal(failureUi.state.phase, "waiting");
assert.equal(failureUi.cancel(), true);
assert.equal(await cancelledExport, undefined);
assert.equal(failureUi.state.phase, "cancelled");
assert.equal(failureUi.state.completedFileName, undefined);
assert.equal(deliveredCount, 1, "cancelling a latest wait must never dispatch an old snapshot");
const failedRender = failureUi.export("svg", { pageIndex: 1, staleChoice: "wait-for-latest" });
pageLatest.failSource(sourceUri, new Error("Latest output failed to compile"));
assert.equal(await failedRender, undefined);
assert.equal(failureUi.state.phase, "error");
assert.match(failureUi.state.message, /Latest output failed to compile/);
assert.equal(currentClient.availability(sourceUri).kind, "stale-choice", "a failed latest wait must preserve the accepted output snapshot");
failureUi.dispose();
pageStore.fail(sourceUri, "pending-output");
assert.deepEqual(currentClient.availability(sourceUri), { kind: "unavailable", reason: "FailedPreview" });
for (const staleChoice of [undefined, "export-displayed", "wait-for-latest"]) {
  await assert.rejects(
    currentClient.export({ sourceUri, format: "svg", staleChoice }),
    (error) => error instanceof PreviewNotExportableError && error.code === "FailedPreview",
  );
}
assert.ok(pageStore.get(nextPaged.renderKey), "failure must block export without discarding the accepted snapshot");
pageService.dispose();
pageLatest.dispose();
pageStore.dispose();

service.dispose();
store.dispose();

console.log(JSON.stringify({
  displayedFourFormats: true,
  waitLatestExactB: true,
  externalizedImagesReinlined: true,
  waitLatestCancelRetry: true,
  waitLatestSetupAbortRace: true,
  sixAdvanceRaces: causes,
  artifactAndInputEviction: true,
  partialAndFailedRejected: true,
  pinReleaseAndDisposeAbort: true,
  metadataContentHashBound: true,
  explicitCurrentOutputSnapshot: true,
  selectedPageBytesAndGeometry: true,
  invalidPagesRejected: true,
  immutablePresetSurvivesStaleClone: true,
  completionWaitsForDelivery: true,
  deliveryFailureRetry: true,
  cancelLatestWithoutDownload: true,
  failedLatestWaitSettles: true,
}));
