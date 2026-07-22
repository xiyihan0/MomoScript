import type {
  ProjectionKey,
  RenderKey,
  SourceContentKey,
  SourceStaleToken,
  TypstProjectSnapshotKey,
} from "../../vscode/src/runtimeIdentity";
import {
  locationProviderKeyId,
  type LocationProviderKey,
  type PreviewArtifact,
  type PreviewFitMode,
  type PreviewPage,
  type PreviewPagePoint,
  type PreviewSourceTarget,
  type PreviewViewport,
  type PreviewWireRange,
} from "./previewArtifact.ts";

export interface PreviewSourceIdentity {
  readonly workspaceId: string;
  readonly sourceUri: string;
  readonly sourceContent: SourceContentKey;
  readonly sourceStaleToken: SourceStaleToken;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey?: ProjectionKey;
  readonly revision: number;
  readonly entryUri: string;
  readonly languageId: "mmt" | "typst";
  readonly backendEncoding: "utf-8" | "utf-16" | "utf-32";
}

export interface PreviewEditorSelection {
  readonly identity: PreviewSourceIdentity;
  readonly range: PreviewWireRange;
}

export interface ProjectedPreviewSelection {
  readonly revision: number;
  readonly entryUri: string;
  readonly range: PreviewWireRange;
  readonly positionEncoding: "utf-8" | "utf-16" | "utf-32";
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
}

export interface PreviewBackendLocation {
  readonly uri: string;
  readonly range: PreviewWireRange;
}

export interface PreviewProviderSelectionRequest {
  readonly renderKey: RenderKey;
  readonly locationProviderKey: LocationProviderKey;
  readonly sourceUri: string;
  readonly sourceContent: SourceContentKey;
  readonly projectionKey?: ProjectionKey;
  readonly range: PreviewWireRange;
  readonly positionEncoding: "utf-8" | "utf-16" | "utf-32";
}

export interface PreviewProviderPointRequest extends PreviewPagePoint {
  readonly renderKey: RenderKey;
  readonly locationProviderKey: LocationProviderKey;
}

export interface PreviewLocationResolver {
  readonly key: LocationProviderKey;
  locateSelection(request: PreviewProviderSelectionRequest, signal: AbortSignal): Promise<readonly PreviewPagePoint[]>;
  locatePoint(request: PreviewProviderPointRequest, signal: AbortSignal): Promise<PreviewBackendLocation | undefined>;
}

export interface PreviewViewportPersistence {
  load(workspaceId: string, sourceUri: string): PreviewViewport | undefined;
  save(workspaceId: string, sourceUri: string, viewport: PreviewViewport): void;
}

export interface PreviewIndicator {
  readonly renderKey: RenderKey;
  readonly providerKeyId: string;
  readonly point: PreviewPagePoint;
  readonly bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
}

export interface PreviewCursorOverlay {
  readonly renderKey: RenderKey;
  readonly providerKeyId: string;
  readonly sourceContent: SourceContentKey;
  readonly point: PreviewPagePoint;
}

export type PreviewInteractionStatus = "ready" | "stale" | "unavailable" | "unmapped";

export interface PreviewInteractionEvents {
  statusChanged?(status: PreviewInteractionStatus, message: string): void;
  indicatorChanged?(indicator: PreviewIndicator | undefined): void;
  cursorChanged?(cursor: PreviewCursorOverlay | undefined): void;
  viewportChanged?(viewport: PreviewViewport): void;
  sourceOpened?(target: PreviewSourceTarget): void;
  fullRefreshRequested?(reason: PreviewFullRefreshReason): void;
}

export interface PreviewInteractionDependencies {
  readonly persistence?: PreviewViewportPersistence;
  readonly events?: PreviewInteractionEvents;
  readonly debounceMilliseconds?: number;
  readonly currentIdentity?: (sourceUri: string) => PreviewSourceIdentity | undefined;
  readonly mapProjectedSelection?: (selection: PreviewEditorSelection, signal: AbortSignal) => Promise<ProjectedPreviewSelection | undefined>;
  readonly mapPreviewSource?: (
    identity: PreviewSourceIdentity,
    location: PreviewBackendLocation,
    signal: AbortSignal,
  ) => Promise<PreviewSourceTarget | undefined>;
  readonly openSource?: (target: PreviewSourceTarget) => Promise<void>;
  readonly setTimer?: (callback: () => void, milliseconds: number) => number;
  readonly clearTimer?: (handle: number) => void;
}

interface BoundPreviewArtifact {
  readonly artifact: PreviewArtifact;
  readonly identity: PreviewSourceIdentity;
}

interface PendingSelection {
  readonly handle: number;
  readonly controller: AbortController;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const INDICATOR_RADIUS = 0.025;

export class BrowserPreviewViewportPersistence implements PreviewViewportPersistence {
  readonly #storage: Storage;
  readonly #namespace: string;

  constructor(storage: Storage, namespace = "mmt.preview.viewport.v1") {
    this.#storage = storage;
    this.#namespace = namespace;
  }

  load(workspaceId: string, sourceUri: string): PreviewViewport | undefined {
    try {
      const raw = this.#storage.getItem(this.key(workspaceId, sourceUri));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<PreviewViewport>;
      return normalizeViewport(parsed);
    } catch {
      return undefined;
    }
  }

  save(workspaceId: string, sourceUri: string, viewport: PreviewViewport): void {
    try {
      this.#storage.setItem(this.key(workspaceId, sourceUri), JSON.stringify(normalizeViewport(viewport)));
    } catch {
      // Viewport persistence is presentation state. Storage denial must not break preview.
    }
  }

  private key(workspaceId: string, sourceUri: string): string {
    return `${this.#namespace}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(sourceUri)}`;
  }
}

export class PreviewInteractionController {
  readonly #dependencies: PreviewInteractionDependencies;
  readonly #pendingSelections = new Map<string, PendingSelection>();
  #bound: BoundPreviewArtifact | undefined;
  #resolver: PreviewLocationResolver | undefined;
  #viewport: PreviewViewport = Object.freeze({ page: 0, x: 0, y: 0, zoom: 1, fitMode: "width" });
  #cursor: PreviewCursorOverlay | undefined;
  #indicator: PreviewIndicator | undefined;

  constructor(dependencies: PreviewInteractionDependencies = {}) {
    this.#dependencies = dependencies;
  }

  get artifact(): PreviewArtifact | undefined { return this.#bound?.artifact; }
  get identity(): PreviewSourceIdentity | undefined { return this.#bound?.identity; }
  get viewport(): PreviewViewport { return this.#viewport; }
  get cursor(): PreviewCursorOverlay | undefined { return this.#cursor; }
  get indicator(): PreviewIndicator | undefined { return this.#indicator; }

  bindArtifact(artifact: PreviewArtifact, identity: PreviewSourceIdentity, resolver?: PreviewLocationResolver): void {
    if (artifact.sourceUri !== identity.sourceUri) throw new Error("Preview artifact/source identity mismatch");
    if (artifact.locationProviderKey.kind === "immutable-map" && !artifact.locationMap) {
      throw new Error("Immutable-map artifact is missing its retained map");
    }
    const retainedResolver = resolver ?? (
      this.#resolver
      && locationProviderKeyId(this.#resolver.key) === locationProviderKeyId(artifact.locationProviderKey)
        ? this.#resolver
        : undefined
    );
    if (retainedResolver && locationProviderKeyId(retainedResolver.key) !== locationProviderKeyId(artifact.locationProviderKey)) {
      throw new Error("Preview resolver does not match the artifact LocationProviderKey");
    }
    this.cancelPendingSelections();
    this.removeCursor();
    this.removeIndicator();
    this.#bound = Object.freeze({ artifact, identity });
    this.#resolver = retainedResolver;
    const restored = this.#dependencies.persistence?.load(identity.workspaceId, identity.sourceUri);
    this.#viewport = normalizeViewport(restored ?? { page: 0, x: 0, y: 0, zoom: 1, fitMode: "width" }, artifact.pages.length);
    this.#dependencies.events?.viewportChanged?.(this.#viewport);
    this.publishAvailability();
  }

  providerRestarted(provider: LocationProviderKey | undefined): void {
    if (!this.#bound || this.#bound.artifact.locationProviderKey.kind === "immutable-map") return;
    const expected = locationProviderKeyId(this.#bound.artifact.locationProviderKey);
    if (!provider || locationProviderKeyId(provider) !== expected) {
      this.#resolver = undefined;
      this.cancelPendingSelections();
      this.removeCursor();
      this.removeIndicator();
      this.#dependencies.events?.statusChanged?.("stale", "Preview navigation is unavailable because the location provider restarted.");
    }
  }

  sourceIdentityAdvanced(identity: PreviewSourceIdentity): void {
    if (!this.#bound || this.#bound.identity.sourceUri !== identity.sourceUri) return;
    if (previewSourceIdentityMatches(this.#bound.identity, identity)) return;
    this.cancelPendingSelections();
    this.removeCursor();
    this.removeIndicator();
    this.#dependencies.events?.statusChanged?.("stale", "Preview is older than the active source snapshot.");
  }

  scheduleEditorSelection(selection: PreviewEditorSelection): void {
    const previous = this.#pendingSelections.get(selection.identity.sourceUri);
    if (previous) {
      this.clearTimer(previous.handle);
      previous.controller.abort();
    }
    const controller = new AbortController();
    const handle = this.setTimer(() => {
      this.#pendingSelections.delete(selection.identity.sourceUri);
      void this.navigateEditorSelection(selection, controller.signal);
    }, this.#dependencies.debounceMilliseconds ?? 120);
    this.#pendingSelections.set(selection.identity.sourceUri, { handle, controller });
  }

  async navigateEditorSelection(selection: PreviewEditorSelection, signal = new AbortController().signal): Promise<PreviewIndicator | undefined> {
    const captured = this.#bound;
    if (!captured || captured.artifact.sourceUri !== selection.identity.sourceUri) return undefined;
    if (!previewSourceIdentityMatches(captured.identity, selection.identity) || !this.identityStillCurrent(selection.identity)) {
      this.#dependencies.events?.statusChanged?.("stale", "Preview navigation rejected a stale editor selection.");
      this.removeCursor();
      this.removeIndicator();
      return undefined;
    }

    let candidates: readonly PreviewPagePoint[] | undefined;
    if (captured.artifact.locationProviderKey.kind === "immutable-map") {
      candidates = immutableSelectionCandidates(captured.artifact, selection);
    } else {
      const resolver = this.#resolver;
      if (!resolver) {
        this.#dependencies.events?.statusChanged?.("unavailable", "No qualified preview location provider is available for this artifact.");
        return undefined;
      }
      let providerSelection: PreviewProviderSelectionRequest;
      if (selection.identity.languageId === "mmt") {
        const mapped = await this.#dependencies.mapProjectedSelection?.(selection, signal);
        if (!mapped || signal.aborted || !projectedSelectionMatchesIdentity(mapped, selection.identity)) {
          this.#dependencies.events?.statusChanged?.("unmapped", "The MMT selection is not wholly inside one current authored projection segment.");
          return undefined;
        }
        providerSelection = {
          renderKey: captured.artifact.renderKey,
          locationProviderKey: captured.artifact.locationProviderKey,
          sourceUri: mapped.entryUri,
          sourceContent: mapped.sourceContent,
          projectionKey: mapped.projectionKey,
          range: mapped.range,
          positionEncoding: mapped.positionEncoding,
        };
      } else {
        providerSelection = {
          renderKey: captured.artifact.renderKey,
          locationProviderKey: captured.artifact.locationProviderKey,
          sourceUri: selection.identity.entryUri,
          sourceContent: selection.identity.sourceContent,
          projectionKey: selection.identity.projectionKey,
          range: selection.range,
          positionEncoding: selection.identity.backendEncoding,
        };
      }
      candidates = await resolver.locateSelection(providerSelection, signal);
    }

    if (signal.aborted || !this.responseStillPublishable(captured, selection.identity) || !candidates || candidates.length === 0) {
      if (!signal.aborted && candidates?.length === 0) this.#dependencies.events?.statusChanged?.("unmapped", "The selected source range has no preview location.");
      return undefined;
    }
    const point = nearestVisiblePage(candidates, this.#viewport.page, captured.artifact.pages.length);
    if (!point) return undefined;
    const providerKeyId = locationProviderKeyId(captured.artifact.locationProviderKey);
    const bounds = Object.freeze({
      left: Math.max(0, point.x - INDICATOR_RADIUS),
      top: Math.max(0, point.y - INDICATOR_RADIUS),
      right: Math.min(1, point.x + INDICATOR_RADIUS),
      bottom: Math.min(1, point.y + INDICATOR_RADIUS),
    });
    this.#indicator = Object.freeze({ renderKey: captured.artifact.renderKey, providerKeyId, point, bounds });
    this.#cursor = Object.freeze({
      renderKey: captured.artifact.renderKey,
      providerKeyId,
      sourceContent: selection.identity.sourceContent,
      point,
    });
    this.#dependencies.events?.indicatorChanged?.(this.#indicator);
    this.#dependencies.events?.cursorChanged?.(this.#cursor);
    this.#dependencies.events?.statusChanged?.("ready", "Preview positioned at the current editor selection.");
    return this.#indicator;
  }

  async navigatePreviewPoint(point: PreviewPagePoint, signal = new AbortController().signal): Promise<PreviewSourceTarget | undefined> {
    const captured = this.#bound;
    if (!captured) return undefined;
    const normalizedPoint = normalizePagePoint(point, captured.artifact.pages.length);
    if (!this.identityStillCurrent(captured.identity)) {
      this.#dependencies.events?.statusChanged?.("stale", "Preview navigation rejected an old source snapshot.");
      this.removeCursor();
      this.removeIndicator();
      return undefined;
    }

    let target: PreviewSourceTarget | undefined;
    if (captured.artifact.locationProviderKey.kind === "immutable-map") {
      target = immutablePointTarget(captured.artifact, normalizedPoint);
    } else {
      const resolver = this.#resolver;
      if (!resolver) {
        this.#dependencies.events?.statusChanged?.("unavailable", "The displayed artifact's location provider is no longer available.");
        return undefined;
      }
      const location = await resolver.locatePoint({
        ...normalizedPoint,
        renderKey: captured.artifact.renderKey,
        locationProviderKey: captured.artifact.locationProviderKey,
      }, signal);
      if (!location || signal.aborted) return undefined;
      if (captured.identity.languageId === "mmt") {
        target = await this.#dependencies.mapPreviewSource?.(captured.identity, location, signal);
      } else {
        target = { kind: "workspaceTypst", uri: location.uri, range: location.range, readOnly: false, retained: true };
      }
    }

    if (signal.aborted || !this.responseStillPublishable(captured, captured.identity)) return undefined;
    if (!target || !previewSourceTargetIsNavigable(target)) {
      this.#dependencies.events?.statusChanged?.("unmapped", "Preview location is stale, unsafe, or no longer retained.");
      return undefined;
    }
    await this.#dependencies.openSource?.(target);
    this.#dependencies.events?.sourceOpened?.(target);
    this.#dependencies.events?.statusChanged?.("ready", "Opened the source mapped by the displayed preview artifact.");
    return target;
  }

  async openMappedTarget(target: PreviewSourceTarget): Promise<boolean> {
    if (!previewSourceTargetIsNavigable(target)) {
      this.#dependencies.events?.statusChanged?.("unmapped", "Outline location is stale, unsafe, or no longer retained.");
      return false;
    }
    await this.#dependencies.openSource?.(target);
    this.#dependencies.events?.sourceOpened?.(target);
    return true;
  }

  updateViewport(viewport: PreviewViewport): PreviewViewport {
    const pageCount = this.#bound?.artifact.pages.length;
    this.#viewport = normalizeViewport(viewport, pageCount);
    const identity = this.#bound?.identity;
    if (identity) this.#dependencies.persistence?.save(identity.workspaceId, identity.sourceUri, this.#viewport);
    this.#dependencies.events?.viewportChanged?.(this.#viewport);
    return this.#viewport;
  }

  removeCursor(): void {
    if (!this.#cursor) return;
    this.#cursor = undefined;
    this.#dependencies.events?.cursorChanged?.(undefined);
  }

  private removeIndicator(): void {
    if (!this.#indicator) return;
    this.#indicator = undefined;
    this.#dependencies.events?.indicatorChanged?.(undefined);
  }

  dispose(): void {
    this.cancelPendingSelections();
    this.#bound = undefined;
    this.#resolver = undefined;
    this.removeCursor();
    this.removeIndicator();
  }

  private identityStillCurrent(identity: PreviewSourceIdentity): boolean {
    const current = this.#dependencies.currentIdentity?.(identity.sourceUri) ?? this.#bound?.identity;
    return current !== undefined && previewSourceIdentityMatches(identity, current);
  }

  private responseStillPublishable(captured: BoundPreviewArtifact, identity: PreviewSourceIdentity): boolean {
    if (this.#bound !== captured || !this.identityStillCurrent(identity)) return false;
    if (captured.artifact.locationProviderKey.kind === "immutable-map") return Boolean(captured.artifact.locationMap);
    return this.#resolver !== undefined
      && locationProviderKeyId(this.#resolver.key) === locationProviderKeyId(captured.artifact.locationProviderKey);
  }

  private publishAvailability(): void {
    const artifact = this.#bound?.artifact;
    if (!artifact) return;
    const retainedMapHasLocations = artifact.locationProviderKey.kind === "immutable-map"
      && Boolean(artifact.locationMap?.sourceToPreview.length || artifact.locationMap?.previewToSource.length);
    if (retainedMapHasLocations || this.#resolver) {
      this.#dependencies.events?.statusChanged?.("ready", "Preview navigation is bound to the displayed artifact.");
    } else {
      this.#dependencies.events?.statusChanged?.("unavailable", "This renderer exposes no qualified location capability for the displayed artifact.");
    }
  }

  private cancelPendingSelections(): void {
    for (const pending of this.#pendingSelections.values()) {
      this.clearTimer(pending.handle);
      pending.controller.abort();
    }
    this.#pendingSelections.clear();
  }

  private setTimer(callback: () => void, milliseconds: number): number {
    return this.#dependencies.setTimer?.(callback, milliseconds) ?? window.setTimeout(callback, milliseconds);
  }

  private clearTimer(handle: number): void {
    if (this.#dependencies.clearTimer) this.#dependencies.clearTimer(handle);
    else window.clearTimeout(handle);
  }
}

export type PreviewBatchMode = "incremental" | "partial";
export type PreviewFullRefreshReason = "gap" | "reordered" | "mixed-render-key" | "mixed-page" | "incomplete";

export interface PreviewProtocolCapabilities {
  readonly protocolVersion: string;
  readonly incrementalVersion?: string;
  readonly partialVersion?: string;
}

export interface PreviewPageBatch {
  readonly mode: PreviewBatchMode;
  readonly protocolVersion: string;
  readonly renderKey: RenderKey;
  readonly sequence: number;
  readonly totalPages: number;
  readonly pages: readonly PreviewPage[];
  readonly complete: boolean;
}

export type PreviewBatchResult =
  | { readonly status: "accepted"; readonly nextSequence: number }
  | { readonly status: "complete"; readonly pages: readonly PreviewPage[] }
  | { readonly status: "capability-unavailable" }
  | { readonly status: "full-refresh"; readonly reason: PreviewFullRefreshReason };

interface PreviewBatchAssembly {
  readonly mode: PreviewBatchMode;
  readonly renderKey: RenderKey;
  readonly totalPages: number;
  readonly pages: Map<number, PreviewPage>;
  nextSequence: number;
}

export class PreviewUpdateCoordinator {
  readonly #capabilities: PreviewProtocolCapabilities;
  readonly #events: PreviewInteractionEvents | undefined;
  #assembly: PreviewBatchAssembly | undefined;

  constructor(capabilities: PreviewProtocolCapabilities, events?: PreviewInteractionEvents) {
    this.#capabilities = capabilities;
    this.#events = events;
  }

  accept(batch: PreviewPageBatch): PreviewBatchResult {
    if (!this.capabilityAllows(batch)) return { status: "capability-unavailable" };
    if (!Number.isSafeInteger(batch.sequence) || batch.sequence < 0 || !Number.isSafeInteger(batch.totalPages) || batch.totalPages <= 0) {
      return this.fullRefresh("incomplete");
    }
    if (!this.#assembly) {
      if (batch.sequence !== 0) return this.fullRefresh("gap");
      this.#assembly = {
        mode: batch.mode,
        renderKey: batch.renderKey,
        totalPages: batch.totalPages,
        pages: new Map(),
        nextSequence: 0,
      };
    }
    const assembly = this.#assembly;
    if (assembly.renderKey !== batch.renderKey) return this.fullRefresh("mixed-render-key");
    if (assembly.mode !== batch.mode || assembly.totalPages !== batch.totalPages) return this.fullRefresh("mixed-page");
    if (batch.sequence < assembly.nextSequence) return this.fullRefresh("reordered");
    if (batch.sequence > assembly.nextSequence) return this.fullRefresh("gap");

    for (const page of batch.pages) {
      if (page.pageIndex < 0 || page.pageIndex >= assembly.totalPages || assembly.pages.has(page.pageIndex)) {
        return this.fullRefresh("mixed-page");
      }
      assembly.pages.set(page.pageIndex, page);
    }
    assembly.nextSequence += 1;
    if (!batch.complete) return { status: "accepted", nextSequence: assembly.nextSequence };
    if (assembly.pages.size !== assembly.totalPages) return this.fullRefresh("incomplete");
    const pages: PreviewPage[] = [];
    for (let pageIndex = 0; pageIndex < assembly.totalPages; pageIndex += 1) {
      const page = assembly.pages.get(pageIndex);
      if (!page) return this.fullRefresh("incomplete");
      pages.push(page);
    }
    this.#assembly = undefined;
    return { status: "complete", pages: Object.freeze(pages) };
  }

  reset(): void { this.#assembly = undefined; }

  private capabilityAllows(batch: PreviewPageBatch): boolean {
    if (batch.protocolVersion !== this.#capabilities.protocolVersion) return false;
    return batch.mode === "incremental"
      ? this.#capabilities.incrementalVersion === batch.protocolVersion
      : this.#capabilities.partialVersion === batch.protocolVersion;
  }

  private fullRefresh(reason: PreviewFullRefreshReason): PreviewBatchResult {
    this.#assembly = undefined;
    this.#events?.fullRefreshRequested?.(reason);
    return { status: "full-refresh", reason };
  }
}

export interface PreviewOutlineSymbol {
  readonly label: string;
  readonly target: PreviewSourceTarget;
  readonly children?: readonly PreviewOutlineSymbol[];
}

export function safePreviewOutline(symbols: readonly PreviewOutlineSymbol[]): readonly PreviewOutlineSymbol[] {
  const safe: PreviewOutlineSymbol[] = [];
  for (const symbol of symbols) {
    if (!previewSourceTargetIsNavigable(symbol.target)) continue;
    const children = symbol.children ? safePreviewOutline(symbol.children) : undefined;
    safe.push(Object.freeze({ ...symbol, children }));
  }
  return Object.freeze(safe);
}

export function previewSourceIdentityMatches(left: PreviewSourceIdentity, right: PreviewSourceIdentity): boolean {
  return left.sourceUri === right.sourceUri
    && left.sourceContent === right.sourceContent
    && left.projectDigest === right.projectDigest
    && left.projectionKey === right.projectionKey
    && left.revision === right.revision
    && left.entryUri === right.entryUri
    && left.sourceStaleToken.hostUri === right.sourceStaleToken.hostUri
    && left.sourceStaleToken.documentIncarnation === right.sourceStaleToken.documentIncarnation
    && left.sourceStaleToken.documentVersion === right.sourceStaleToken.documentVersion;
}

export function normalizeViewport(viewport: Partial<PreviewViewport>, pageCount?: number): PreviewViewport {
  const pageUpperBound = pageCount === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, pageCount - 1);
  const page = Number.isSafeInteger(viewport.page) ? Math.min(pageUpperBound, Math.max(0, viewport.page ?? 0)) : 0;
  const x = Number.isFinite(viewport.x) ? Math.min(1, Math.max(0, viewport.x ?? 0)) : 0;
  const y = Number.isFinite(viewport.y) ? Math.min(1, Math.max(0, viewport.y ?? 0)) : 0;
  const zoom = Number.isFinite(viewport.zoom)
    ? Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom ?? 1)) * 100) / 100
    : 1;
  const fitMode: PreviewFitMode = viewport.fitMode === "manual" || viewport.fitMode === "page" ? viewport.fitMode : "width";
  return Object.freeze({ page, x, y, zoom, fitMode });
}

export function nearestVisiblePage(
  candidates: readonly PreviewPagePoint[],
  visiblePage: number,
  pageCount: number,
): PreviewPagePoint | undefined {
  let nearest: PreviewPagePoint | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    let normalized: PreviewPagePoint;
    try {
      normalized = normalizePagePoint(candidate, pageCount);
    } catch {
      continue;
    }
    const distance = Math.abs(normalized.pageIndex - visiblePage);
    if (distance < nearestDistance) {
      nearest = normalized;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function previewSourceTargetIsNavigable(target: PreviewSourceTarget): boolean {
  if (!target.uri || !target.range || target.kind === "staleUnknown") return false;
  let parsed: URL;
  try {
    parsed = new URL(target.uri);
  } catch {
    return false;
  }
  const path = parsed.pathname.toLowerCase();
  if (target.kind === "authoredIdentity") return path.endsWith(".mmt") || path.endsWith(".mmt.txt");
  if (target.kind === "workspaceTypst") return path.endsWith(".typ") && target.readOnly !== true;
  if (target.kind === "packageFile") return parsed.protocol === "mmt-package:" && target.readOnly === true && target.retained === true;
  return target.kind === "generatedProjection"
    && parsed.protocol === "mmt-projection:"
    && target.readOnly === true
    && target.retained === true;
}

function projectedSelectionMatchesIdentity(selection: ProjectedPreviewSelection, identity: PreviewSourceIdentity): boolean {
  return selection.revision === identity.revision
    && selection.entryUri === identity.entryUri
    && selection.sourceContent === identity.sourceContent
    && selection.projectDigest === identity.projectDigest
    && selection.projectionKey === identity.projectionKey;
}

function immutableSelectionCandidates(
  artifact: PreviewArtifact,
  selection: PreviewEditorSelection,
): readonly PreviewPagePoint[] | undefined {
  return artifact.locationMap?.sourceToPreview.find((entry) =>
    entry.sourceUri === selection.identity.sourceUri
    && entry.sourceContent === selection.identity.sourceContent
    && entry.projectionKey === selection.identity.projectionKey
    && wireRangesEqual(entry.range, selection.range)
  )?.candidates;
}

function immutablePointTarget(artifact: PreviewArtifact, point: PreviewPagePoint): PreviewSourceTarget | undefined {
  let nearest: PreviewSourceTarget | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const entry of artifact.locationMap?.previewToSource ?? []) {
    if (entry.pageIndex !== point.pageIndex) continue;
    const candidateDistance = Math.hypot(entry.x - point.x, entry.y - point.y);
    if (candidateDistance <= entry.radius && candidateDistance < distance) {
      nearest = entry.target;
      distance = candidateDistance;
    }
  }
  return nearest;
}

function wireRangesEqual(left: PreviewWireRange, right: PreviewWireRange): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function normalizePagePoint(point: PreviewPagePoint, pageCount: number): PreviewPagePoint {
  if (!Number.isSafeInteger(point.pageIndex) || point.pageIndex < 0 || point.pageIndex >= pageCount) {
    throw new Error("Preview location page is outside the displayed artifact");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error("Preview location coordinates must be normalized page-relative values");
  }
  return Object.freeze({ pageIndex: point.pageIndex, x: point.x, y: point.y });
}
