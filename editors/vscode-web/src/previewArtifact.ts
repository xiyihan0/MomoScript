import type { RenderKey } from "../../vscode/src/runtimeIdentity";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";

export type PreviewStatus = "idle" | "queued" | "materializing" | "rendering" | "ready" | "stale" | "failed";
export type PreviewFitMode = "manual" | "width" | "page";

export interface PreviewViewport {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly fitMode: PreviewFitMode;
}

export interface QualifiedLocationProviderKey {
  readonly kind: "provider";
  readonly backendOrTraceArtifactDigest: string;
  readonly backendGeneration: number;
  readonly method: string;
  readonly coordinateVersion: string;
}

export interface ImmutableLocationMapKey {
  readonly kind: "immutable-map";
  readonly digest: string;
  readonly coordinateVersion: string;
}

export type LocationProviderKey = QualifiedLocationProviderKey | ImmutableLocationMapKey;

export interface PreviewPageGeometry {
  readonly viewBox: readonly [number, number, number, number];
  readonly cssWidth: number;
  readonly cssHeight: number;
}

export interface PreviewPage {
  readonly pageIndex: number;
  readonly geometry: PreviewPageGeometry;
  readonly sanitizedSvg: string;
}

export interface PreviewWirePosition {
  readonly line: number;
  readonly character: number;
}

export interface PreviewWireRange {
  readonly start: PreviewWirePosition;
  readonly end: PreviewWirePosition;
}

export interface PreviewPagePoint {
  readonly pageIndex: number;
  /** Page-relative normalized coordinate in the inclusive range 0..1. */
  readonly x: number;
  /** Page-relative normalized coordinate in the inclusive range 0..1. */
  readonly y: number;
}

export type PreviewSourceKind = "authoredIdentity" | "workspaceTypst" | "packageFile" | "generatedProjection" | "staleUnknown";

export interface PreviewSourceTarget {
  readonly kind: PreviewSourceKind;
  readonly uri?: string;
  readonly range?: PreviewWireRange;
  readonly readOnly?: boolean;
  readonly retained?: boolean;
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
  readonly pages: readonly PreviewPage[];
  readonly warnings?: readonly string[];
}

const encoder = new TextEncoder();
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createPreviewArtifact(input: PreviewArtifactInput): PreviewArtifact {
  requireNonEmpty(input.renderKey, "RenderKey");
  requireNonEmpty(input.sourceUri, "source URI");
  validateLocationProviderKey(input.locationProviderKey);
  if (input.locationProviderKey.kind === "immutable-map" && !input.locationMap) {
    throw new Error("Immutable LocationProviderKey requires a complete retained location map");
  }
  if (input.pages.length === 0) throw new Error("Preview artifact must contain at least one page");
  const pages = input.pages.map((page, index) => normalizePreviewPage(page, index));
  const locationMap = input.locationMap ? normalizeLocationMap(input.locationMap, input.locationProviderKey, pages.length) : undefined;
  const warnings = Object.freeze([...(input.warnings ?? [])].map((warning) => String(warning)));
  const byteSize = pages.reduce((total, page) => total + encoder.encode(page.sanitizedSvg).byteLength + 8 * 6, 0)
    + encoder.encode(input.sourceUri).byteLength
    + encoder.encode(JSON.stringify(input.locationProviderKey)).byteLength
    + (locationMap ? encoder.encode(JSON.stringify(locationMap)).byteLength : 0)
    + warnings.reduce((total, warning) => total + encoder.encode(warning).byteLength, 0);
  return Object.freeze({
    renderKey: input.renderKey,
    sourceUri: input.sourceUri,
    locationProviderKey: Object.freeze({ ...input.locationProviderKey }),
    locationMap,
    pages: Object.freeze(pages),
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
  return key.kind === "provider"
    ? `provider:${key.backendOrTraceArtifactDigest}:${key.backendGeneration}:${key.method}:${key.coordinateVersion}`
    : `immutable-map:${key.digest}:${key.coordinateVersion}`;
}

export function normalizePreviewPage(page: PreviewPage, expectedIndex = page.pageIndex): PreviewPage {
  if (page.pageIndex !== expectedIndex) throw new Error(`Preview pages must be contiguous from zero (expected ${expectedIndex})`);
  const [x, y, width, height] = page.geometry.viewBox;
  for (const value of [x, y, width, height, page.geometry.cssWidth, page.geometry.cssHeight]) {
    if (!Number.isFinite(value)) throw new Error("Preview page geometry must be finite");
  }
  if (width <= 0 || height <= 0 || page.geometry.cssWidth <= 0 || page.geometry.cssHeight <= 0) {
    throw new Error("Preview page geometry must have positive dimensions");
  }
  validateSanitizedSvg(page.sanitizedSvg);
  const viewBox: readonly [number, number, number, number] = Object.freeze([x, y, width, height]);
  return Object.freeze({
    pageIndex: page.pageIndex,
    geometry: Object.freeze({ viewBox, cssWidth: page.geometry.cssWidth, cssHeight: page.geometry.cssHeight }),
    sanitizedSvg: page.sanitizedSvg,
  });
}

function validateSanitizedSvg(svg: string): void {
  const root = /^\s*<svg\b([^>]*)>/i.exec(svg);
  if (!root || !new RegExp(`\\bxmlns=["']${SVG_NAMESPACE.replaceAll("/", "\\/")}["']`, "i").test(root[1] ?? "")) {
    throw new Error("Preview page must have an SVG namespace root");
  }
  if (/<\/?(?:script|style|iframe|object|embed)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg)) {
    throw new Error("Preview page contains unsafe SVG content");
  }
  for (const match of svg.matchAll(/\s(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi)) {
    const value = match[1] ?? "";
    if (!value.startsWith("#") && !value.startsWith("data:image/")) throw new Error("Preview page contains an unsafe link");
  }
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
