import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ArtifactUnavailableError,
  ExactExportService,
  ExportChoiceRequiredError,
  PreviewNotExportableError,
} from "../src/exactExport.ts";
import { PreviewArtifactStore, createPreviewArtifact } from "../src/previewArtifact.ts";
import { LatestExactArtifactWaiter } from "../src/exactExportUi.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sourceUri = "mmtfs://workspace/story.mmt";
const causes = ["source", "dependency", "materialization", "render", "backend", "runtime"];

function page(marker) {
  return {
    pageIndex: 0,
    geometry: { viewBox: [0, 0, 120, 240], cssWidth: 120, cssHeight: 240 },
    sanitizedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 240"><text>${marker}</text></svg>`,
  };
}

function artifact(key, marker) {
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
    pages: [page(marker)],
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

const expectedA = {
  svg: encoder.encode(a.pages[0].sanitizedSvg),
  png: encoder.encode(`png:${a.pages[0].sanitizedSvg}`),
  jpg: encoder.encode(`jpg:${a.pages[0].sanitizedSvg}`),
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

service.dispose();
store.dispose();

console.log(JSON.stringify({
  displayedFourFormats: true,
  waitLatestExactB: true,
  waitLatestCancelRetry: true,
  waitLatestSetupAbortRace: true,
  sixAdvanceRaces: causes,
  artifactAndInputEviction: true,
  partialAndFailedRejected: true,
  pinReleaseAndDisposeAbort: true,
  metadataContentHashBound: true,
}));
