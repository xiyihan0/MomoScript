import assert from "node:assert/strict";
import {
  PreviewArtifactStore,
  createPreviewArtifact,
  inlinePreviewImageAssets,
  locationProviderMatches,
  markPreviewArtifactStale,
  previewImageAssetHref,
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
  renderKey: renderKey(key),
  sourceUri: source,
  locationProviderKey,
  visualSnapshot: { kind: "svg", pages: [page(0, marker)], imageAssets: [] },
  warnings: ["fixture"],
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
  visualSnapshot: { kind: "svg", pages: [page(0, "map")], imageAssets: [] },
});
assert.equal(locationProviderMatches(fallback, renderKey("render-map"), fallback.locationProviderKey), true);

assert.throws(() => artifact("bad-gap", "source", "bad", provider()).pages.length && createPreviewArtifact({
  renderKey: renderKey("bad-gap"), sourceUri: "source", locationProviderKey: provider(),
  visualSnapshot: { kind: "svg", pages: [page(1)], imageAssets: [] },
}), /contiguous/);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("bad-geometry"), sourceUri: "source", locationProviderKey: provider(),
  visualSnapshot: {
    kind: "svg",
    pages: [{ ...page(0), geometry: { viewBox: [0, 0, Number.NaN, 2], cssWidth: 1, cssHeight: 2 } }],
    imageAssets: [],
  },
}), /finite/);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("bad-svg"), sourceUri: "source", locationProviderKey: provider(),
  visualSnapshot: {
    kind: "svg",
    pages: [{ ...page(0), sanitizedSvg: "<svg><script>alert(1)</script></svg>" }],
    imageAssets: [],
  },
}), /namespace root|unsafe/);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("bad-link"), sourceUri: "source", locationProviderKey: provider(),
  visualSnapshot: {
    kind: "svg",
    pages: [{ ...page(0), sanitizedSvg: '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.invalid"/></svg>' }],
    imageAssets: [],
  },
}), /unsafe link/);
const imageDigest = `sha256:${"a".repeat(64)}`;
const imageBytes = new Uint8Array(1024).fill(42);
const imageAsset = Object.freeze({
  digest: imageDigest,
  mimeType: "image/png",
  blob: new Blob([imageBytes], { type: "image/png" }),
});
const imageHref = previewImageAssetHref(imageDigest);
const imagePage = {
  ...page(0, "external-image"),
  sanitizedSvg: `<svg xmlns="http://www.w3.org/2000/svg"><image href="${imageHref}"/><image href="${imageHref}"/></svg>`,
};
const imageArtifact = createPreviewArtifact({
  renderKey: renderKey("render-image"),
  sourceUri: "mmtfs://workspace/image.mmt",
  locationProviderKey: provider(),
  visualSnapshot: { kind: "svg", pages: [imagePage], imageAssets: [imageAsset] },
});
assert.equal(imageArtifact.visualSnapshot.kind, "svg");
const normalizedImageAssets = imageArtifact.visualSnapshot.imageAssets;
const inlinedImageSvg = await inlinePreviewImageAssets(imageArtifact.pages[0].sanitizedSvg, normalizedImageAssets);
assert.equal((inlinedImageSvg.match(/data:image\/png;base64,/g) ?? []).length, 2);
assert.equal(inlinedImageSvg.includes(imageHref), false);
assert.ok(imageArtifact.byteSize < new TextEncoder().encode(inlinedImageSvg).byteLength);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("missing-image"),
  sourceUri: "mmtfs://workspace/missing-image.mmt",
  locationProviderKey: provider(),
  visualSnapshot: { kind: "svg", pages: [imagePage], imageAssets: [] },
}), /unavailable image asset/);

const rendererProvider = {
  kind: "renderer-provider",
  sessionId: "renderer-session-1",
  snapshotToken: renderKey("render-incremental"),
  artifactDigest: "b".repeat(64),
  backendGeneration: 7,
  rendererGeneration: 11,
  method: "mmt/previewRenderer.v1",
  coordinateVersion: "typst-page-points-v1",
};
const rendererArtifact = createPreviewArtifact({
  renderKey: renderKey("render-incremental"),
  sourceUri: "mmtfs://workspace/incremental.mmt",
  locationProviderKey: rendererProvider,
  visualSnapshot: {
    kind: "renderer",
    artifactDigest: "b".repeat(64),
    sourceDigest: "c".repeat(64),
    backendGeneration: 7,
    rendererGeneration: 11,
    frameKind: "diff-v1",
    sessionId: rendererProvider.sessionId,
    snapshotToken: rendererProvider.snapshotToken,
    byteLength: 4096,
    pages: [{ pageIndex: 0, geometry: { viewBox: [0, 0, 120, 80], cssWidth: 120, cssHeight: 80 } }],
  },
});
assert.equal(rendererArtifact.visualSnapshot.kind, "renderer");
assert.equal(rendererArtifact.visualSnapshot.rendererGeneration, 11);
assert.equal(rendererArtifact.pages[0].geometry.cssWidth, 120);
assert.ok(Object.isFrozen(rendererArtifact.visualSnapshot) && Object.isFrozen(rendererArtifact.pages));
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("bad-renderer"),
  sourceUri: "mmtfs://workspace/bad-renderer.mmt",
  locationProviderKey: { ...rendererProvider, snapshotToken: renderKey("bad-renderer"), artifactDigest: "d".repeat(64) },
  visualSnapshot: {
    kind: "renderer",
    artifactDigest: "not-a-digest",
    sourceDigest: "c".repeat(64),
    backendGeneration: 7,
    rendererGeneration: 11,
    frameKind: "new",
    sessionId: rendererProvider.sessionId,
    snapshotToken: renderKey("bad-renderer"),
    byteLength: 1,
    pages: [{ pageIndex: 0, geometry: { viewBox: [0, 0, 1, 1], cssWidth: 1, cssHeight: 1 } }],
  },
}), /digest/);
assert.throws(() => createPreviewArtifact({
  renderKey: renderKey("wrong-generation"),
  sourceUri: "mmtfs://workspace/wrong-generation.mmt",
  locationProviderKey: { ...rendererProvider, snapshotToken: renderKey("wrong-generation") },
  visualSnapshot: {
    ...rendererArtifact.visualSnapshot,
    snapshotToken: renderKey("wrong-generation"),
    rendererGeneration: 12,
  },
}), /identity/);

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

const result = {
  immutableArtifacts: true,
  normalizedPages: true,
  discriminatedVisualSnapshots: true,
  exactIdentityBinding: true,
  deduplicatedImageAssets: true,
  boundedPinnedLru: true,
  multiDocumentState: true,
  currentFailureGuard: true,
};
console.log(JSON.stringify(result));
