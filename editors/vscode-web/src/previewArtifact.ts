import type { RenderKey } from "../../vscode/src/runtimeIdentity";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";
import type { PreviewPagePoint, PreviewViewport } from "./previewWebviewProtocol.ts";
import {
  isReservedPreviewSemanticLabel,
  parsePreviewSemanticLabel,
} from "./previewSemanticTarget.ts";

export type PreviewStatus = "idle" | "queued" | "materializing" | "rendering" | "ready" | "stale" | "failed";

export interface QualifiedLocationProviderKey {
  readonly kind: "provider";
  readonly backendOrTraceArtifactDigest: string;
  readonly backendGeneration: number;
  readonly method: string;
  readonly coordinateVersion: string;
}

export interface RendererLocationProviderKey {
  readonly kind: "renderer-provider";
  readonly sessionId: string;
  readonly snapshotToken: RenderKey;
  readonly artifactDigest: string;
  readonly backendGeneration: number;
  readonly rendererGeneration: number;
  readonly method: string;
  readonly coordinateVersion: string;
}

export interface ImmutableLocationMapKey {
  readonly kind: "immutable-map";
  readonly digest: string;
  readonly coordinateVersion: string;
}

export type LocationProviderKey = QualifiedLocationProviderKey | RendererLocationProviderKey | ImmutableLocationMapKey;

export interface PreviewPageGeometry {
  readonly viewBox: readonly [number, number, number, number];
  readonly cssWidth: number;
  readonly cssHeight: number;
}

export interface PreviewPage {
  readonly pageIndex: number;
  readonly geometry: PreviewPageGeometry;
}

export interface PreviewSvgPage extends PreviewPage {
  readonly sanitizedSvg: string;
}

export interface PreviewImageAsset {
  readonly digest: `sha256:${string}`;
  readonly mimeType: string;
  readonly blob: Blob;
}

export interface PreviewSvgVisualSnapshot {
  readonly kind: "svg";
  readonly pages: readonly PreviewSvgPage[];
  readonly imageAssets: readonly PreviewImageAsset[];
}

export interface PreviewRendererVisualSnapshot {
  readonly kind: "renderer";
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly backendGeneration: number;
  readonly rendererGeneration: number;
  readonly frameKind: "new" | "diff-v1";
  readonly sessionId: string;
  readonly snapshotToken: RenderKey;
  readonly byteLength: number;
  readonly pages: readonly PreviewPage[];
}

export type PreviewVisualSnapshot = PreviewSvgVisualSnapshot | PreviewRendererVisualSnapshot;

export interface PreviewWirePosition {
  readonly line: number;
  readonly character: number;
}

export interface PreviewWireRange {
  readonly start: PreviewWirePosition;
  readonly end: PreviewWirePosition;
}

export const PREVIEW_SOURCE_KINDS = Object.freeze({
  authoredIdentity: true,
  workspaceTypst: true,
  packageFile: true,
  generatedProjection: true,
  staleUnknown: true,
} as const);

export type PreviewSourceKind = keyof typeof PREVIEW_SOURCE_KINDS;

export interface PreviewSourceTarget {
  readonly kind: PreviewSourceKind;
  readonly uri?: string;
  readonly range?: PreviewWireRange;
  readonly readOnly?: boolean;
  readonly retained?: boolean;
}

export function parsePreviewSourceTargets(value: unknown): readonly PreviewSourceTarget[] {
  if (!Array.isArray(value)) throw new TypeError("Preview source mapping must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || !("kind" in item)
      || typeof item.kind !== "string" || !(item.kind in PREVIEW_SOURCE_KINDS)) {
      throw new TypeError("Preview source mapping has an unknown kind");
    }
    const kind = item.kind as PreviewSourceKind;
    if (kind === "staleUnknown") {
      if (Object.keys(item).length !== 1) {
        throw new TypeError("Stale preview source mapping must not contain a URI/range");
      }
      return Object.freeze({ kind });
    }
    if (!("uri" in item) || typeof item.uri !== "string"
      || !("range" in item) || !isWireRange(item.range)) {
      throw new TypeError("Preview source mapping is missing an exact URI/range");
    }
    return Object.freeze({ kind, uri: item.uri, range: normalizeWireRange(item.range) });
  });
}

export interface PreviewSourceMapEntry {
  readonly sourceUri: string;
  readonly sourceContent: string;
  readonly projectionKey?: string;
  readonly range: PreviewWireRange;
  readonly candidates: readonly PreviewPagePoint[];
}

export interface PreviewPageMapEntry extends PreviewPagePoint {
  readonly radius: number;
  readonly target: PreviewSourceTarget;
}

/** Complete location data retained with one immutable render artifact. */
export interface PreviewImmutableLocationMap {
  readonly digest: string;
  readonly sourceToPreview: readonly PreviewSourceMapEntry[];
  readonly previewToSource: readonly PreviewPageMapEntry[];
}

export interface PreviewArtifact {
  readonly renderKey: RenderKey;
  readonly sourceUri: string;
  readonly locationProviderKey: LocationProviderKey;
  readonly locationMap?: PreviewImmutableLocationMap;
  readonly visualSnapshot: PreviewVisualSnapshot;
  readonly pages: readonly PreviewPage[];
  readonly warnings: readonly string[];
  readonly byteSize: number;
  readonly stale: boolean;
}

export interface PreviewDocumentState {
  readonly sourceUri: string;
  readonly requestedRenderKey?: RenderKey;
  readonly displayedArtifact?: PreviewArtifact;
  readonly status: PreviewStatus;
  readonly viewport: PreviewViewport;
}

export interface PreviewArtifactInput {
  readonly renderKey: RenderKey;
  readonly sourceUri: string;
  readonly locationProviderKey: LocationProviderKey;
  readonly locationMap?: PreviewImmutableLocationMap;
  readonly visualSnapshot: PreviewVisualSnapshot;
  readonly warnings?: readonly string[];
}

const encoder = new TextEncoder();
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PREVIEW_IMAGE_ASSET_PREFIX = "mmt-preview-image:";

export function createPreviewArtifact(input: PreviewArtifactInput): PreviewArtifact {
  requireNonEmpty(input.renderKey, "RenderKey");
  requireNonEmpty(input.sourceUri, "source URI");
  validateLocationProviderKey(input.locationProviderKey);
  if (input.locationProviderKey.kind === "immutable-map" && !input.locationMap) {
    throw new Error("Immutable LocationProviderKey requires a complete retained location map");
  }
  const visualSnapshot = normalizeVisualSnapshot(input.visualSnapshot);
  const pages = visualSnapshot.pages;
  if (visualSnapshot.kind === "renderer") {
    if (input.locationProviderKey.kind !== "renderer-provider") {
      throw new Error("Renderer visual snapshots require a generation-bound renderer location provider");
    }
    if (input.locationProviderKey.sessionId !== visualSnapshot.sessionId
      || input.locationProviderKey.snapshotToken !== visualSnapshot.snapshotToken
      || input.locationProviderKey.artifactDigest !== visualSnapshot.artifactDigest
      || input.locationProviderKey.backendGeneration !== visualSnapshot.backendGeneration
      || input.locationProviderKey.rendererGeneration !== visualSnapshot.rendererGeneration
      || visualSnapshot.snapshotToken !== input.renderKey) {
      throw new Error("Renderer visual snapshot identity must match its location provider and RenderKey");
    }
  }
  const locationMap = input.locationMap ? normalizeLocationMap(input.locationMap, input.locationProviderKey, pages.length) : undefined;
  const warnings = Object.freeze([...(input.warnings ?? [])].map((warning) => String(warning)));
  const visualByteSize = visualSnapshot.kind === "svg"
    ? visualSnapshot.pages.reduce((total, page) => total + encoder.encode(page.sanitizedSvg).byteLength + 8 * 6, 0)
      + visualSnapshot.imageAssets.reduce((total, asset) => total
        + asset.blob.size
        + encoder.encode(asset.digest).byteLength
        + encoder.encode(asset.mimeType).byteLength, 0)
    : visualSnapshot.byteLength
      + encoder.encode(visualSnapshot.artifactDigest).byteLength
      + encoder.encode(visualSnapshot.sourceDigest).byteLength
      + visualSnapshot.pages.length * 8 * 6;
  const byteSize = visualByteSize
    + encoder.encode(input.sourceUri).byteLength
    + encoder.encode(JSON.stringify(input.locationProviderKey)).byteLength
    + (locationMap ? encoder.encode(JSON.stringify(locationMap)).byteLength : 0)
    + warnings.reduce((total, warning) => total + encoder.encode(warning).byteLength, 0);
  return Object.freeze({
    renderKey: input.renderKey,
    sourceUri: input.sourceUri,
    locationProviderKey: Object.freeze({ ...input.locationProviderKey }),
    locationMap,
    visualSnapshot,
    pages,
    warnings,
    byteSize,
    stale: false,
  });
}

export function markPreviewArtifactStale(artifact: PreviewArtifact): PreviewArtifact {
  if (artifact.stale) return artifact;
  return Object.freeze({ ...artifact, stale: true });
}

export function locationProviderMatches(
  artifact: PreviewArtifact,
  renderKey: RenderKey,
  provider: LocationProviderKey,
): boolean {
  return artifact.renderKey === renderKey && locationProviderKeyId(artifact.locationProviderKey) === locationProviderKeyId(provider);
}

export function locationProviderKeyId(key: LocationProviderKey): string {
  if (key.kind === "renderer-provider") {
    return `renderer-provider:${key.sessionId}:${key.snapshotToken}:${key.artifactDigest}:${key.backendGeneration}:${key.rendererGeneration}:${key.method}:${key.coordinateVersion}`;
  }
  return key.kind === "provider"
    ? `provider:${key.backendOrTraceArtifactDigest}:${key.backendGeneration}:${key.method}:${key.coordinateVersion}`
    : `immutable-map:${key.digest}:${key.coordinateVersion}`;
}

function normalizeVisualSnapshot(snapshot: PreviewVisualSnapshot): PreviewVisualSnapshot {
  if (snapshot.pages.length === 0) throw new Error("Preview artifact must contain at least one page");
  if (snapshot.kind === "svg") {
    const imageAssets = normalizePreviewImageAssets(snapshot.imageAssets);
    const pages = snapshot.pages.map((page, index) => normalizePreviewPage(page, index, imageAssets));
    return Object.freeze({
      kind: "svg",
      pages: Object.freeze(pages),
      imageAssets,
    });
  }
  for (const [label, digest] of [
    ["artifact", snapshot.artifactDigest],
    ["source", snapshot.sourceDigest],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Preview renderer ${label} digest must be lowercase SHA-256`);
  }
  if (!Number.isSafeInteger(snapshot.backendGeneration) || snapshot.backendGeneration <= 0
    || !Number.isSafeInteger(snapshot.rendererGeneration) || snapshot.rendererGeneration <= 0
    || !Number.isSafeInteger(snapshot.byteLength) || snapshot.byteLength <= 0) {
    throw new Error("Preview renderer snapshot generation metadata is invalid");
  }
  requireNonEmpty(snapshot.sessionId, "Preview renderer session id");
  requireNonEmpty(snapshot.snapshotToken, "Preview renderer snapshot token");
  const pages = snapshot.pages.map((page, index) => normalizePreviewPageGeometry(page, index));
  return Object.freeze({
    ...snapshot,
    pages: Object.freeze(pages),
  });
}

export function normalizePreviewPage(
  page: PreviewSvgPage,
  expectedIndex = page.pageIndex,
  imageAssets: readonly PreviewImageAsset[] = [],
): PreviewSvgPage {
  const normalized = normalizePreviewPageGeometry(page, expectedIndex);
  validateSanitizedSvg(page.sanitizedSvg, new Set(imageAssets.map((asset) => asset.digest)));
  return Object.freeze({ ...normalized, sanitizedSvg: page.sanitizedSvg });
}

function normalizePreviewPageGeometry(page: PreviewPage, expectedIndex: number): PreviewPage {
  if (page.pageIndex !== expectedIndex) throw new Error(`Preview pages must be contiguous from zero (expected ${expectedIndex})`);
  const [x, y, width, height] = page.geometry.viewBox;
  for (const value of [x, y, width, height, page.geometry.cssWidth, page.geometry.cssHeight]) {
    if (!Number.isFinite(value)) throw new Error("Preview page geometry must be finite");
  }
  if (width <= 0 || height <= 0 || page.geometry.cssWidth <= 0 || page.geometry.cssHeight <= 0) {
    throw new Error("Preview page geometry must have positive dimensions");
  }
  const viewBox: readonly [number, number, number, number] = Object.freeze([x, y, width, height]);
  return Object.freeze({
    pageIndex: page.pageIndex,
    geometry: Object.freeze({ viewBox, cssWidth: page.geometry.cssWidth, cssHeight: page.geometry.cssHeight }),
  });
}

export function previewImageAssetHref(digest: PreviewImageAsset["digest"]): string {
  return `${PREVIEW_IMAGE_ASSET_PREFIX}${digest}`;
}

export async function inlinePreviewImageAssets(
  svg: string,
  imageAssets: readonly PreviewImageAsset[],
): Promise<string> {
  let expanded = svg;
  for (const asset of imageAssets) {
    const bytes = new Uint8Array(await asset.blob.arrayBuffer());
    expanded = expanded.replaceAll(
      previewImageAssetHref(asset.digest),
      `data:${asset.mimeType};base64,${encodeBase64(bytes)}`,
    );
  }
  return expanded;
}

function normalizePreviewImageAssets(imageAssets: readonly PreviewImageAsset[]): readonly PreviewImageAsset[] {
  const digests = new Set<string>();
  return Object.freeze(imageAssets.map((asset) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest)) throw new Error("Preview image asset has an invalid digest");
    if (!/^image\/[a-z0-9.+-]+$/.test(asset.mimeType)) throw new Error("Preview image asset has an invalid MIME type");
    if (asset.blob.size === 0 || asset.blob.type !== asset.mimeType) {
      throw new Error("Preview image asset Blob does not match its MIME type");
    }
    if (digests.has(asset.digest)) throw new Error("Preview image asset digests must be unique");
    digests.add(asset.digest);
    return Object.freeze({ digest: asset.digest, mimeType: asset.mimeType, blob: asset.blob });
  }));
}

function validateSanitizedSvg(svg: string, imageAssetDigests: ReadonlySet<string>): void {
  const root = /^\s*<svg\b([^>]*)>/i.exec(svg);
  if (!root || !new RegExp(`\\bxmlns=["']${SVG_NAMESPACE.replaceAll("/", "\\/")}["']`, "i").test(root[1] ?? "")) {
    throw new Error("Preview page must have an SVG namespace root");
  }
  if (/<\/?(?:script|style|iframe|object|embed)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg)) {
    throw new Error("Preview page contains unsafe SVG content");
  }
  for (const match of svg.matchAll(/\s(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi)) {
    const value = match[1] ?? "";
    if (value.startsWith(PREVIEW_IMAGE_ASSET_PREFIX)) {
      const digest = value.slice(PREVIEW_IMAGE_ASSET_PREFIX.length);
      if (!imageAssetDigests.has(digest)) throw new Error("Preview page references an unavailable image asset");
      continue;
    }
    if (!value.startsWith("#") && !value.startsWith("data:image/")) throw new Error("Preview page contains an unsafe link");
  }
  for (const match of svg.matchAll(/\sdata-typst-label\s*=\s*["']([^"']*)["']/gi)) {
    const value = match[1] ?? "";
    if (
      isReservedPreviewSemanticLabel(value)
      && parsePreviewSemanticLabel(value) === undefined
    ) {
      throw new Error("Preview page contains an invalid reserved semantic label");
    }
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeLocationMap(
  map: PreviewImmutableLocationMap,
  key: LocationProviderKey,
  pageCount: number,
): PreviewImmutableLocationMap {
  if (key.kind !== "immutable-map" || key.digest !== map.digest) {
    throw new Error("Immutable location map must match the artifact LocationProviderKey");
  }
  const sourceToPreview = map.sourceToPreview.map((entry) => Object.freeze({
    sourceUri: requireNonEmpty(entry.sourceUri, "location-map source URI"),
    sourceContent: requireNonEmpty(entry.sourceContent, "location-map SourceContentKey"),
    projectionKey: entry.projectionKey,
    range: normalizeWireRange(entry.range),
    candidates: Object.freeze(entry.candidates.map((candidate) => normalizePagePoint(candidate, pageCount))),
  }));
  const previewToSource = map.previewToSource.map((entry) => {
    if (!Number.isFinite(entry.radius) || entry.radius <= 0 || entry.radius > 1) {
      throw new Error("Preview location radius must be within 0..1");
    }
    const point = normalizePagePoint(entry, pageCount);
    const target = normalizeSourceTarget(entry.target);
    return Object.freeze({ ...point, radius: entry.radius, target });
  });
  return Object.freeze({
    digest: map.digest,
    sourceToPreview: Object.freeze(sourceToPreview),
    previewToSource: Object.freeze(previewToSource),
  });
}

function normalizePagePoint(point: PreviewPagePoint, pageCount: number): PreviewPagePoint {
  if (!Number.isSafeInteger(point.pageIndex) || point.pageIndex < 0 || point.pageIndex >= pageCount) {
    throw new Error("Preview location page is outside the artifact");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error("Preview location coordinates must be normalized to 0..1");
  }
  return Object.freeze({ pageIndex: point.pageIndex, x: point.x, y: point.y });
}

function isWirePosition(value: unknown): value is PreviewWirePosition {
  return Boolean(
    value
    && typeof value === "object"
    && "line" in value
    && Number.isSafeInteger(value.line)
    && Number(value.line) >= 0
    && "character" in value
    && Number.isSafeInteger(value.character)
    && Number(value.character) >= 0,
  );
}

function isWireRange(value: unknown): value is PreviewWireRange {
  if (!value || typeof value !== "object" || !("start" in value) || !("end" in value)
    || !isWirePosition(value.start) || !isWirePosition(value.end)) {
    return false;
  }
  return value.start.line < value.end.line
    || (value.start.line === value.end.line && value.start.character <= value.end.character);
}

function normalizeWireRange(range: PreviewWireRange): PreviewWireRange {
  for (const position of [range.start, range.end]) {
    if (!Number.isSafeInteger(position.line) || position.line < 0 || !Number.isSafeInteger(position.character) || position.character < 0) {
      throw new Error("Preview source positions must be non-negative integers");
    }
  }
  if (range.end.line < range.start.line || (range.end.line === range.start.line && range.end.character < range.start.character)) {
    throw new Error("Preview source range is reversed");
  }
  return Object.freeze({ start: Object.freeze({ ...range.start }), end: Object.freeze({ ...range.end }) });
}

function normalizeSourceTarget(target: PreviewSourceTarget): PreviewSourceTarget {
  if (target.kind === "staleUnknown") return Object.freeze({ kind: target.kind });
  const uri = requireNonEmpty(target.uri ?? "", "preview source target URI");
  if (!target.range) throw new Error("Preview source target must contain a range");
  return Object.freeze({ ...target, uri, range: normalizeWireRange(target.range) });
}

function validateLocationProviderKey(key: LocationProviderKey): void {
  requireNonEmpty(key.coordinateVersion, "location coordinate version");
  if (key.kind === "provider") {
    requireNonEmpty(key.backendOrTraceArtifactDigest, "location provider artifact digest");
    requireNonEmpty(key.method, "location provider method");
    if (!Number.isSafeInteger(key.backendGeneration) || key.backendGeneration < 0) throw new Error("Location provider generation must be a non-negative integer");
  } else if (key.kind === "renderer-provider") {
    requireNonEmpty(key.sessionId, "renderer location provider session id");
    requireNonEmpty(key.snapshotToken, "renderer location provider snapshot token");
    requireNonEmpty(key.artifactDigest, "renderer location provider artifact digest");
    requireNonEmpty(key.method, "renderer location provider method");
    if (!/^[0-9a-f]{64}$/.test(key.artifactDigest)) throw new Error("Renderer location provider artifact digest must be lowercase SHA-256");
    if (!Number.isSafeInteger(key.backendGeneration) || key.backendGeneration <= 0
      || !Number.isSafeInteger(key.rendererGeneration) || key.rendererGeneration <= 0) {
      throw new Error("Renderer location provider generations must be positive integers");
    }
  } else {
    requireNonEmpty(key.digest, "immutable location map digest");
  }
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

interface CacheEntry { artifact: PreviewArtifact; pins: number }

export class PreviewArtifactStore implements RuntimeOwnedResource {
  readonly #entries = new Map<RenderKey, CacheEntry>();
  readonly #documents = new Map<string, PreviewDocumentState>();
  #bytes = 0;
  #disposed = false;
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Preview cache byte limit must be a positive integer");
    this.maxBytes = maxBytes;
  }

  get byteSize(): number { return this.#bytes; }
  get size(): number { return this.#entries.size; }

  get(renderKey: RenderKey): PreviewArtifact | undefined {
    this.#assertActive();
    const entry = this.#entries.get(renderKey);
    if (!entry) return undefined;
    this.#entries.delete(renderKey);
    this.#entries.set(renderKey, entry);
    return entry.artifact;
  }

  put(artifact: PreviewArtifact): void {
    this.#assertActive();
    if (artifact.byteSize > this.maxBytes) throw new Error("Preview artifact exceeds cache byte limit");
    const existing = this.#entries.get(artifact.renderKey);
    if (existing && existing.artifact !== artifact) throw new Error("RenderKey is already bound to a different immutable artifact");
    if (existing) { this.get(artifact.renderKey); return; }
    this.#entries.set(artifact.renderKey, { artifact, pins: 0 });
    this.#bytes += artifact.byteSize;
    this.#evict();
  }

  replaceRendererArtifact(artifact: PreviewArtifact): void {
    this.#assertActive();
    if (artifact.visualSnapshot.kind !== "renderer") {
      throw new Error("Only renderer artifacts can replace an equivalent cached publication");
    }
    if (artifact.byteSize > this.maxBytes) throw new Error("Preview artifact exceeds cache byte limit");
    const existing = this.#entries.get(artifact.renderKey);
    if (!existing) {
      this.put(artifact);
      return;
    }
    if (existing.artifact.visualSnapshot.kind !== "renderer"
      || existing.artifact.sourceUri !== artifact.sourceUri) {
      throw new Error("RenderKey is already bound to a different immutable artifact");
    }
    this.#replaceCached(artifact);
    this.get(artifact.renderKey);
    this.#evict();
  }

  pin(renderKey: RenderKey): () => void {
    const entry = this.#entries.get(renderKey);
    if (!entry) throw new Error("ArtifactUnavailable");
    entry.pins += 1;
    let released = false;
    return () => {
      if (released || this.#disposed) return;
      released = true;
      entry.pins -= 1;
      this.#evict();
    };
  }

  document(sourceUri: string): PreviewDocumentState {
    this.#assertActive();
    return this.#documents.get(sourceUri) ?? Object.freeze({ sourceUri, status: "idle", viewport: DEFAULT_VIEWPORT });
  }

  request(sourceUri: string, renderKey: RenderKey): PreviewDocumentState {
    const previous = this.document(sourceUri);
    const displayedArtifact = previous.displayedArtifact && previous.displayedArtifact.renderKey !== renderKey
      ? markPreviewArtifactStale(previous.displayedArtifact)
      : previous.displayedArtifact;
    if (displayedArtifact?.stale) this.#replaceCached(displayedArtifact);
    const next = Object.freeze({ ...previous, requestedRenderKey: renderKey, displayedArtifact, status: displayedArtifact?.stale ? "stale" : "queued" } satisfies PreviewDocumentState);
    this.#documents.set(sourceUri, next);
    return next;
  }

  display(sourceUri: string, renderKey: RenderKey): PreviewDocumentState {
    const artifact = this.get(renderKey);
    if (!artifact || artifact.sourceUri !== sourceUri) throw new Error("ArtifactUnavailable");
    const previous = this.document(sourceUri);
    const next = Object.freeze({ ...previous, requestedRenderKey: renderKey, displayedArtifact: artifact, status: artifact.stale ? "stale" : "ready" } satisfies PreviewDocumentState);
    this.#documents.set(sourceUri, next);
    return next;
  }

  markStale(sourceUri: string): PreviewDocumentState {
    const previous = this.document(sourceUri);
    const displayedArtifact = previous.displayedArtifact
      ? markPreviewArtifactStale(previous.displayedArtifact)
      : undefined;
    if (displayedArtifact) this.#replaceCached(displayedArtifact);
    const next = Object.freeze({ ...previous, displayedArtifact, status: "stale" } satisfies PreviewDocumentState);
    this.#documents.set(sourceUri, next);
    return next;
  }
  fail(sourceUri: string, renderKey?: RenderKey): PreviewDocumentState {
    const previous = this.document(sourceUri);
    if (renderKey && previous.requestedRenderKey && previous.requestedRenderKey !== renderKey) return previous;
    const next = Object.freeze({
      ...previous,
      requestedRenderKey: renderKey ?? previous.requestedRenderKey,
      status: "failed",
    } satisfies PreviewDocumentState);
    this.#documents.set(sourceUri, next);
    return next;
  }


  closeSource(sourceUri: string): void { this.#documents.delete(sourceUri); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entries.clear();
    this.#documents.clear();
    this.#bytes = 0;
  }

  #replaceCached(artifact: PreviewArtifact): void {
    const entry = this.#entries.get(artifact.renderKey);
    if (!entry) return;
    this.#bytes += artifact.byteSize - entry.artifact.byteSize;
    entry.artifact = artifact;
  }

  #evict(): void {
    while (this.#bytes > this.maxBytes) {
      const candidate = [...this.#entries].find(([, entry]) => entry.pins === 0);
      if (!candidate) throw new Error("Preview cache capacity is exhausted by pinned artifacts");
      this.#entries.delete(candidate[0]);
      this.#bytes -= candidate[1].artifact.byteSize;
    }
  }

  #assertActive(): void { if (this.#disposed) throw new Error("Preview artifact store is disposed"); }
}

const DEFAULT_VIEWPORT = Object.freeze({ page: 0, x: 0, y: 0, zoom: 1, fitMode: "width" as const });
