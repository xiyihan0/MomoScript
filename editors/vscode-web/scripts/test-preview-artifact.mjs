import assert from "node:assert/strict";
import {
  PreviewArtifactStore,
  createPreviewArtifact,
  locationProviderMatches,
  markPreviewArtifactStale,
} from "../src/previewArtifact.ts";

const renderKey = (value) => value;
const provider = (generation = 1) => ({
  kind: "provider",
  backendOrTraceArtifactDigest: "tinymist:sha256:abc",
  backendGeneration: generation,
  method: "tinymist/preview/location.v1",
  coordinateVersion: "typst-page-points-v1",
});
const page = (index, marker = "page") => ({
  pageIndex: index,
  geometry: { viewBox: [0, 0, 100, 200], cssWidth: 100, cssHeight: 200 },
  sanitizedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><g id="${marker}"/></svg>`,
});
const artifact = (key, source, marker = "page", locationProviderKey = provider()) => createPreviewArtifact({
  renderKey: renderKey(key), sourceUri: source, locationProviderKey, pages: [page(0, marker)], warnings: ["fixture"],
});

const a = artifact("render-a", "mmtfs://workspace/a.mmt", "a");
assert.ok(Object.isFrozen(a) && Object.isFrozen(a.pages) && Object.isFrozen(a.pages[0].geometry));
assert.ok(a.byteSize > new TextEncoder().encode(a.pages[0].sanitizedSvg).byteLength);
assert.equal(markPreviewArtifactStale(a).renderKey, a.renderKey);
assert.equal(markPreviewArtifactStale(a).stale, true);
assert.equal(a.stale, false, "stale transitions must not mutate immutable artifacts");
assert.equal(locationProviderMatches(a, renderKey("render-a"), provider()), true);
assert.equal(locationProviderMatches(a, renderKey("render-a"), provider(2)), false, "provider restart invalidates responses");
assert.equal(locationProviderMatches(a, renderKey("render-b"), provider()), false, "location response must bind exact RenderKey");

const fallbackKey = { kind: "immutable-map", digest: "sha256:map", coordinateVersion: "typst-page-points-v1" };
const fallback = createPreviewArtifact({
  renderKey: renderKey("render-map"),
  sourceUri: "mmtfs://workspace/a.mmt",
  locationProviderKey: fallbackKey,
  locationMap: { digest: fallbackKey.digest, sourceToPreview: [], previewToSource: [] },
  pages: [page(0, "map")],
});
assert.equal(locationProviderMatches(fallback, renderKey("render-map"), fallback.locationProviderKey), true);

assert.throws(() => artifact("bad-gap", "source", "bad", provider()).pages.length && createPreviewArtifact({
  renderKey: renderKey("bad-gap"), sourceUri: "source", locationProviderKey: provider(), pages: [page(1)],
}), /contiguous/);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("bad-geometry"), sourceUri: "source", locationProviderKey: provider(),
  pages: [{ ...page(0), geometry: { viewBox: [0, 0, Number.NaN, 2], cssWidth: 1, cssHeight: 2 } }],
}), /finite/);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("bad-svg"), sourceUri: "source", locationProviderKey: provider(),
  pages: [{ ...page(0), sanitizedSvg: "<svg><script>alert(1)</script></svg>" }],
}), /namespace root|unsafe/);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("bad-link"), sourceUri: "source", locationProviderKey: provider(),
  pages: [{ ...page(0), sanitizedSvg: '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.invalid"/></svg>' }],
}), /unsafe link/);

const cache = new PreviewArtifactStore(a.byteSize * 2 + 20);
cache.put(a);
const releaseA = cache.pin(a.renderKey);
const b = artifact("render-b", "mmtfs://workspace/b.mmt", "b");
cache.put(b);
cache.get(a.renderKey);
const c = artifact("render-c", "mmtfs://workspace/c.mmt", "c");
cache.put(c);
assert.equal(cache.get(a.renderKey), a, "pinned artifact survives eviction");
assert.equal(cache.get(b.renderKey), undefined, "least-recent unpinned artifact is evicted");
releaseA();

cache.request(a.sourceUri, a.renderKey);
cache.display(a.sourceUri, a.renderKey);
cache.request(a.sourceUri, c.renderKey);
assert.equal(cache.document(a.sourceUri).displayedArtifact.stale, true);
assert.equal(cache.document(a.sourceUri).displayedArtifact.renderKey, a.renderKey);
assert.equal(cache.document("mmtfs://workspace/unrelated.mmt").status, "idle", "documents have independent state");
assert.equal(cache.fail(a.sourceUri, a.renderKey).status, "stale", "an old render failure cannot replace current preview state");
assert.equal(cache.fail(a.sourceUri, c.renderKey).status, "failed");
assert.throws(() => cache.put(artifact("render-a", a.sourceUri, "different")), /different immutable artifact/);
cache.closeSource(a.sourceUri);
assert.equal(cache.document(a.sourceUri).status, "idle");
cache.dispose();
assert.throws(() => cache.get(a.renderKey), /disposed/);

console.log(JSON.stringify({ immutableArtifacts: true, normalizedPages: true, exactIdentityBinding: true, boundedPinnedLru: true, multiDocumentState: true, currentFailureGuard: true }));
