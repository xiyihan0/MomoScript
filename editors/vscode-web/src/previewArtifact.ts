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

export interface PreviewArtifact {
  readonly renderKey: RenderKey;
  readonly sourceUri: string;
  readonly locationProviderKey: LocationProviderKey;
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
  readonly pages: readonly PreviewPage[];
  readonly warnings?: readonly string[];
}

const encoder = new TextEncoder();
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createPreviewArtifact(input: PreviewArtifactInput): PreviewArtifact {
  requireNonEmpty(input.renderKey, "RenderKey");
  requireNonEmpty(input.sourceUri, "source URI");
  validateLocationProviderKey(input.locationProviderKey);
  if (input.pages.length === 0) throw new Error("Preview artifact must contain at least one page");
  const pages = input.pages.map((page, index) => normalizePreviewPage(page, index));
  const warnings = Object.freeze([...(input.warnings ?? [])].map((warning) => String(warning)));
  const byteSize = pages.reduce((total, page) => total + encoder.encode(page.sanitizedSvg).byteLength + 8 * 6, 0)
    + encoder.encode(input.sourceUri).byteLength
    + encoder.encode(JSON.stringify(input.locationProviderKey)).byteLength
    + warnings.reduce((total, warning) => total + encoder.encode(warning).byteLength, 0);
  return Object.freeze({
    renderKey: input.renderKey,
    sourceUri: input.sourceUri,
    locationProviderKey: Object.freeze({ ...input.locationProviderKey }),
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

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
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
