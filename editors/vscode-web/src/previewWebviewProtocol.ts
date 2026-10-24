import type { ExactExportFormat, StaleExportChoice } from "./exactExport.ts";
import type { ExactExportUiState } from "./exactExportUi.ts";
import type { RenderKey } from "../../vscode/src/runtimeIdentity.ts";
import type { PreviewRendererPointUncertainty } from "../../vscode/src/previewRendererProtocol.ts";
import { isRenderPreset, type RenderPreset } from "../../vscode/src/renderPreset.ts";

export type PreviewFitMode = "manual" | "width" | "page";
export type PreviewSurfacePresentation = "chat" | "layout" | "preview";

export interface PreviewPagePoint {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
}

export interface PreviewNavigationPoint extends PreviewPagePoint {
  /** UTF-16 caret offset nearest the pointer, clamped inside the rendered text. */
  readonly textOffset?: number;
  readonly text?: string;
}

export interface PreviewContextMenuAnchor {
  readonly screenX: number;
  readonly screenY: number;
}

export interface PreviewViewport {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly fitMode: PreviewFitMode;
}

export interface PreviewImageAssetMessage {
  readonly digest: string;
  readonly mimeType: string;
  readonly dataBase64: string;
}

export interface PreviewMeasurementSpan {
  readonly span: string;
  readonly start: number;
  readonly end: number;
}

export interface PreviewRenderArtifactLocation extends PreviewPagePoint, PreviewMeasurementSpan {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PreviewRenderMessage {
  readonly type: "render";
  readonly svg: string;
  readonly imageAssets: readonly PreviewImageAssetMessage[];
  readonly pageSize: { readonly width: number; readonly height: number };
  readonly requestSequence: number;
  readonly traceId?: string;
  readonly renderKey: RenderKey;
  readonly renderPreset: RenderPreset;
  readonly spans: readonly PreviewMeasurementSpan[];
}

export interface PreviewRendererFrameMessage {
  readonly type: "render-frame";
  readonly sessionId: string;
  readonly frameKind: "new" | "diff-v1";
  readonly dataBase64: string;
  readonly byteLength: number;
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly backendGeneration: number;
  readonly rendererGeneration: number;
  readonly baseGeneration: number;
  readonly requestSequence: number;
  readonly traceId?: string;
  readonly renderKey: RenderKey;
  readonly renderPreset: RenderPreset;
  readonly publishedAtEpochMs: number;
}

export interface PreviewRendererPageGeometry {
  readonly pageIndex: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

export type PreviewExactExportState = ExactExportUiState;

export interface PreviewRendererReadyMetadata {
  readonly sessionId: string;
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly backendGeneration: number;
  readonly generation: number;
  readonly baseGeneration: number;
  readonly frameKind: "new" | "diff-v1";
  readonly byteLength: number;
  readonly pageGeometries: readonly PreviewRendererPageGeometry[];
  readonly patchedNodes: number;
  readonly reusedNodes: number;
  readonly removedNodes: number;
  readonly pageBuffers: number;
  readonly frameDecodeMs: number;
  readonly rendererApplyMs: number;
}

export interface PreviewVisualReadyMessage {
  readonly type: "visual-ready";
  readonly requestSequence: number;
  readonly traceId?: string;
  readonly renderKey: RenderKey;
  readonly locations: readonly PreviewRenderArtifactLocation[];
  readonly domUpdateMs: number;
  readonly locationMeasureMs: number;
  readonly renderer?: PreviewRendererReadyMetadata;
  readonly viewportRenderMs?: number;
  readonly iframeTransferMs?: number;
}

/** Semantic input only. The iframe never supplies authored ranges or edit plans. */
export type ComposerIntent =
  | {
      readonly kind: "pointer";
      readonly phase: "start" | "move" | "end" | "cancel";
      readonly point: PreviewPagePoint;
      readonly uncertainty: PreviewRendererPointUncertainty;
      readonly extend: boolean;
      readonly clickCount: 1 | 2 | 3;
    }
  | {
      readonly kind: "move";
      readonly direction: "left" | "right" | "up" | "down";
      readonly granularity: "grapheme" | "word" | "visualLine" | "document";
      readonly extend: boolean;
    }
  | { readonly kind: "replace"; readonly text: string; readonly origin: "typing" | "paste" }
  | {
      readonly kind: "replace";
      readonly text: "";
      readonly origin: "delete";
      readonly direction: "backward" | "forward";
      readonly granularity: "grapheme" | "word";
    }
  | { readonly kind: "composition"; readonly phase: "start" | "update" | "end" | "cancel"; readonly text: string }
  | { readonly kind: "history"; readonly direction: "undo" | "redo" }
  | { readonly kind: "focus"; readonly backward: boolean }
  | { readonly kind: "clipboard"; readonly action: "copy" | "cut"; readonly authorization: string }
  | { readonly kind: "clipboardRequest"; readonly action: "copy" | "cut" }
  | { readonly kind: "contextMenu"; readonly anchor: PreviewContextMenuAnchor };

export interface ComposerIntentMessage {
  readonly type: "composer-intent";
  readonly sessionId: string;
  readonly sequence: number;
  readonly renderKey: RenderKey;
  readonly intent: ComposerIntent;
}

/** FIFO acknowledgement after the bridge has stopped admitting work for a blocked session. */
export interface ComposerDrainedMessage {
  readonly type: "composer-drained";
  readonly sessionId: string;
  readonly sequence: number;
}

export interface ComposerSelectionBox extends PreviewPagePoint {
  readonly width: number;
  readonly height: number;
}

export interface ComposerCaret extends ComposerSelectionBox {
  readonly affinity: "before" | "after";
}

/** Ephemeral Rust-authorized plain text for one exact, current semantic selection. */
export interface ComposerClipboardPayload {
  readonly authorization: string;
  readonly text: string;
}

export interface ComposerState {
  readonly type: "composer-state";
  readonly sessionId: string;
  /** Latest handled intent sequence, including rejection; geometry may advance independently. */
  readonly sequence: number;
  readonly renderKey: RenderKey;
  readonly status: "ready" | "pending" | "blocked";
  /** A collapsed selection has one caret; otherwise [anchor, focus]. */
  readonly carets: readonly ComposerCaret[];
  readonly boxes: readonly ComposerSelectionBox[];
  /** Null while input, source, selection, or committed geometry is not exact-current. */
  readonly clipboard: ComposerClipboardPayload | null;
}

export interface ComposerStateMessage extends ComposerState {
  /** Conservative Float32 coordinate radius in top-level CSS pixels. */
  readonly screenCoordinatePrecision: number;
}

/** One adjacent binary32 step, using the larger side at powers of two. */
export function float32CoordinatePrecision(magnitude: number): number {
  const rounded = Math.fround(Math.abs(magnitude));
  if (!Number.isFinite(rounded)) return Number.POSITIVE_INFINITY;
  if (rounded === 0) return 2 ** -149;
  return 2 ** Math.max(-149, Math.floor(Math.log2(rounded)) - 23);
}

export type PreviewHostToWebviewMessage =
  | PreviewRenderMessage
  | PreviewRendererFrameMessage
  | ComposerStateMessage
  | { readonly type: "presentation"; readonly presentation: PreviewSurfacePresentation }
  | { readonly type: "renderer-reset" }
  | { readonly type: "status"; readonly message: string; readonly error: boolean }
  | { readonly type: "restoreViewport"; readonly viewport: PreviewViewport; readonly presentation: PreviewSurfacePresentation }
  | { readonly type: "indicator"; readonly point?: PreviewPagePoint }
  | { readonly type: "cursor"; readonly point?: PreviewPagePoint }
  | { readonly type: "exactExportState"; readonly state: PreviewExactExportState };

export type PreviewWebviewToHostMessage =
  | { readonly type: "ready" }
  | ComposerIntentMessage
  | ComposerDrainedMessage
  | PreviewVisualReadyMessage
  | { readonly type: "viewport"; readonly renderKey: RenderKey; readonly presentation: PreviewSurfacePresentation; readonly viewport: PreviewViewport }
  | { readonly type: "navigate"; readonly point: PreviewNavigationPoint }
  | {
    readonly type: "context-point";
    readonly point: PreviewNavigationPoint;
    readonly anchor: PreviewContextMenuAnchor;
    readonly trigger: "select" | "menu";
  }
  | { readonly type: "exact-export"; readonly format: ExactExportFormat; readonly staleChoice?: StaleExportChoice; readonly pageIndex?: number }
  | { readonly type: "exact-export-cancel" }
  | { readonly type: "render-rejected"; readonly requestSequence: number; readonly renderKey: RenderKey; readonly error: string }
  | { readonly type: "renderer-resync-needed"; readonly sessionId: string; readonly generation: number };

export function isPreviewSurfacePresentation(value: unknown): value is PreviewSurfacePresentation {
  return value === "chat" || value === "layout" || value === "preview";
}

/** Presentation changes never reinterpret an artifact produced by another preset. */
export function previewPresentationAcceptsPreset(presentation: PreviewSurfacePresentation, preset: RenderPreset): boolean {
  return (presentation === "chat") === (preset.kind === "chat");
}

export function isPreviewHostToWebviewMessage(value: unknown): value is PreviewHostToWebviewMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  switch (value.type) {
    case "composer-state":
      return isComposerStateMessage(value);
    case "presentation":
      return hasExactKeys(value, ["type", "presentation"])
        && isPreviewSurfacePresentation(value.presentation);
    case "render":
      return hasExactKeys(value, ["type", "svg", "imageAssets", "pageSize", "requestSequence", "renderKey", "renderPreset", "spans"], ["traceId"])
        && typeof value.svg === "string"
        && isRenderPreset(value.renderPreset)
        && "imageAssets" in value && Array.isArray(value.imageAssets)
        && value.imageAssets.every(isImageAssetMessage)
        && "pageSize" in value && isPageSize(value.pageSize)
        && "requestSequence" in value && Number.isSafeInteger(value.requestSequence)
        && (!("traceId" in value) || value.traceId === undefined || typeof value.traceId === "string")
        && "renderKey" in value && typeof value.renderKey === "string"
        && "spans" in value && Array.isArray(value.spans)
        && value.spans.every(isMeasurementSpan);
    case "render-frame":
      return hasExactKeys(value, ["type", "sessionId", "frameKind", "dataBase64", "byteLength", "artifactDigest", "sourceDigest", "backendGeneration", "rendererGeneration", "baseGeneration", "requestSequence", "renderKey", "renderPreset", "publishedAtEpochMs"], ["traceId"])
        && typeof value.sessionId === "string"
        && isRenderPreset(value.renderPreset)
        && "frameKind" in value && (value.frameKind === "new" || value.frameKind === "diff-v1")
        && "dataBase64" in value && typeof value.dataBase64 === "string"
        && "byteLength" in value && Number.isSafeInteger(value.byteLength)
        && "artifactDigest" in value && typeof value.artifactDigest === "string"
        && "sourceDigest" in value && typeof value.sourceDigest === "string"
        && "backendGeneration" in value && Number.isSafeInteger(value.backendGeneration)
        && "rendererGeneration" in value && Number.isSafeInteger(value.rendererGeneration)
        && "baseGeneration" in value && Number.isSafeInteger(value.baseGeneration)
        && "requestSequence" in value && Number.isSafeInteger(value.requestSequence)
        && (!("traceId" in value) || value.traceId === undefined || typeof value.traceId === "string")
        && "renderKey" in value && typeof value.renderKey === "string"
        && "publishedAtEpochMs" in value && typeof value.publishedAtEpochMs === "number";
    case "renderer-reset":
      return true;
    case "status":
      return "message" in value && typeof value.message === "string"
        && "error" in value && typeof value.error === "boolean";
    case "restoreViewport":
      return hasExactKeys(value, ["type", "viewport", "presentation"])
        && isPreviewSurfacePresentation(value.presentation)
        && isPreviewViewport(value.viewport);
    case "indicator":
    case "cursor":
      return !("point" in value) || value.point === undefined || isPreviewPagePoint(value.point);
    case "exactExportState":
      return hasExactKeys(value, ["type", "state"]) && isPreviewExactExportState(value.state);
    default:
      return false;
  }
}

export function isPreviewWebviewToHostMessage(value: unknown): value is PreviewWebviewToHostMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  switch (value.type) {
    case "composer-intent": return isComposerIntentMessage(value);
    case "composer-drained": return isComposerDrainedMessage(value);
    case "ready": return isPreviewWebviewReadyMessage(value);
    case "visual-ready": return isPreviewVisualReadyMessage(value);
    case "viewport": return isPreviewViewportMessage(value);
    case "navigate": return isPreviewNavigateMessage(value);
    case "context-point": return isPreviewContextPointMessage(value);
    case "exact-export": return isExportMessage(value);
    case "exact-export-cancel": return isExactExportCancelMessage(value);
    case "render-rejected": return isPreviewRenderRejectedMessage(value);
    case "renderer-resync-needed": return isPreviewRendererResyncNeededMessage(value);
    default: return false;
  }
}

export function isComposerIntentMessage(value: unknown): value is ComposerIntentMessage {
  return hasExactKeys(value, ["type", "sessionId", "sequence", "renderKey", "intent"])
    && value.type === "composer-intent"
    && isComposerIdentity(value)
    && Number(value.sequence) > 0
    && isComposerIntent(value.intent);
}

export function isComposerDrainedMessage(value: unknown): value is ComposerDrainedMessage {
  return hasExactKeys(value, ["type", "sessionId", "sequence"])
    && value.type === "composer-drained"
    && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 256
    && nonNegativeSafeInteger(value.sequence);
}

export function isComposerStateMessage(value: unknown): value is ComposerStateMessage {
  return hasExactKeys(value, ["type", "sessionId", "sequence", "renderKey", "status", "carets", "boxes", "clipboard", "screenCoordinatePrecision"])
    && value.type === "composer-state"
    && isComposerIdentity(value)
    && normalizedFinite(value.screenCoordinatePrecision)
    && (value.status === "ready" || value.status === "pending" || value.status === "blocked")
    && Array.isArray(value.carets) && value.carets.length <= 2
    && value.carets.every((caret) => isComposerBox(caret, true))
    && Array.isArray(value.boxes) && value.boxes.length <= 65_536
    && value.boxes.every((box) => isComposerBox(box, false))
    && (value.clipboard === null || (
      value.status === "ready" && value.carets.length === 2
      && hasExactKeys(value.clipboard, ["authorization", "text"])
      && isClipboardAuthorization(value.clipboard.authorization)
      && typeof value.clipboard.text === "string"
      && value.clipboard.text.isWellFormed()
    ))
    && (value.status !== "blocked" || (value.carets.length === 0 && value.boxes.length === 0));
}

/** The host also checks the active editable runtime before forwarding admitted input. */
export function acceptsComposerIntent(
  message: unknown,
  state: ComposerState | undefined,
  lastSequence: number,
  publishedRenderKeys?: ReadonlySet<string>,
): message is ComposerIntentMessage {
  return isComposerIntentMessage(message)
    && state !== undefined && state.status !== "blocked"
    && message.sessionId === state.sessionId
    && message.sequence > Math.max(lastSequence, state.sequence)
    && (message.intent.kind === "pointer" || message.intent.kind === "contextMenu" || message.intent.kind === "clipboard"
      ? state.status === "ready" && message.renderKey === state.renderKey
      : (publishedRenderKeys?.has(message.renderKey) ?? message.renderKey === state.renderKey));
}

function isComposerIdentity(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 256
    && typeof value.renderKey === "string" && value.renderKey.length > 0 && value.renderKey.length <= 4096
    && nonNegativeSafeInteger(value.sequence);
}

function isComposerIntent(value: unknown): value is ComposerIntent {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  switch (value.kind) {
    case "pointer":
      return hasExactKeys(value, ["kind", "phase", "point", "uncertainty", "extend", "clickCount"])
        && (value.phase === "start" || value.phase === "move" || value.phase === "end" || value.phase === "cancel")
        && hasExactKeys(value.point, ["pageIndex", "x", "y"])
        && nonNegativeSafeInteger(value.point.pageIndex) && Number(value.point.pageIndex) < 100_000
        && normalizedFinite(value.point.x) && normalizedFinite(value.point.y)
        && hasExactKeys(value.uncertainty, ["x", "y"])
        && normalizedFinite(value.uncertainty.x) && normalizedFinite(value.uncertainty.y)
        && typeof value.extend === "boolean" && (value.clickCount === 1 || value.clickCount === 2 || value.clickCount === 3);
    case "move":
      return hasExactKeys(value, ["kind", "direction", "granularity", "extend"])
        && (value.direction === "left" || value.direction === "right" || value.direction === "up" || value.direction === "down")
        && (value.granularity === "grapheme" || value.granularity === "word"
          || value.granularity === "visualLine" || value.granularity === "document")
        && typeof value.extend === "boolean";
    case "replace":
      if ("origin" in value && value.origin === "delete") {
        return hasExactKeys(value, ["kind", "text", "origin", "direction", "granularity"])
          && value.text === "" && (value.direction === "backward" || value.direction === "forward")
          && (value.granularity === "grapheme" || value.granularity === "word");
      }
      return hasExactKeys(value, ["kind", "text", "origin"])
        && (value.origin === "typing" || value.origin === "paste")
        && isComposerInputText(value.text);
    case "composition":
      return hasExactKeys(value, ["kind", "phase", "text"])
        && (value.phase === "start" || value.phase === "update" || value.phase === "end" || value.phase === "cancel")
        && isComposerInputText(value.text)
        && (value.phase !== "start" || value.text === "");
    case "history":
      return hasExactKeys(value, ["kind", "direction"])
        && (value.direction === "undo" || value.direction === "redo");
    case "focus":
      return hasExactKeys(value, ["kind", "backward"]) && typeof value.backward === "boolean";
    case "clipboard":
      return hasExactKeys(value, ["kind", "action", "authorization"])
        && (value.action === "copy" || value.action === "cut") && isClipboardAuthorization(value.authorization);
    case "clipboardRequest":
      return hasExactKeys(value, ["kind", "action"]) && (value.action === "copy" || value.action === "cut");
    case "contextMenu":
      return hasExactKeys(value, ["kind", "anchor"]) && isPreviewContextMenuAnchor(value.anchor);
    default:
      return false;
  }
}

function isClipboardAuthorization(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isComposerInputText(value: unknown): value is string {
  // Rust owns the normalized UTF-8 body limit. Bound transport without truncating input.
  return typeof value === "string" && value.length <= 131_072 && value.isWellFormed();
}

function isComposerBox(value: unknown, caret: boolean): boolean {
  return hasExactKeys(value, caret
    ? ["pageIndex", "x", "y", "width", "height", "affinity"]
    : ["pageIndex", "x", "y", "width", "height"])
    && nonNegativeSafeInteger(value.pageIndex) && Number(value.pageIndex) < 100_000
    && normalizedFinite(value.x) && normalizedFinite(value.y)
    && normalizedFinite(value.width) && positiveFinite(value.height)
    && Number(value.x) + Number(value.width) <= 1 + Number.EPSILON
    && Number(value.y) + Number(value.height) <= 1 + Number.EPSILON
    && (!caret || value.affinity === "before" || value.affinity === "after");
}

export function isExportMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "exact-export" }> {
  return hasExactKeys(value, ["type", "format"], ["staleChoice", "pageIndex"])
    && value.type === "exact-export"
    && (value.format === "pdf" || value.format === "png" || value.format === "jpg" || value.format === "svg")
    && (!("staleChoice" in value)
      || value.staleChoice === "export-displayed" || value.staleChoice === "wait-for-latest")
    && (!("pageIndex" in value) || (value.format !== "pdf" && nonNegativeSafeInteger(value.pageIndex)));
}

export function isExactExportCancelMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "exact-export-cancel" }> {
  return hasExactKeys(value, ["type"]) && value.type === "exact-export-cancel";
}

export function isPreviewWebviewReadyMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "ready" }> {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "ready");
}

export function isPreviewRenderRejectedMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "render-rejected" }> {
  return Boolean(value && typeof value === "object"
    && "type" in value && value.type === "render-rejected"
    && "requestSequence" in value && Number.isSafeInteger(value.requestSequence)
    && "renderKey" in value && typeof value.renderKey === "string"
    && "error" in value && typeof value.error === "string");
}

export function isPreviewRendererResyncNeededMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "renderer-resync-needed" }> {
  return Boolean(value && typeof value === "object"
    && "type" in value && value.type === "renderer-resync-needed"
    && "sessionId" in value && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && "generation" in value && Number.isSafeInteger(value.generation)
    && Number(value.generation) > 0);
}

export function isPreviewVisualReadyMessage(value: unknown): value is PreviewVisualReadyMessage {
  return Boolean(value && typeof value === "object"
    && "type" in value && value.type === "visual-ready"
    && "requestSequence" in value && Number.isSafeInteger(value.requestSequence)
    && "renderKey" in value && typeof value.renderKey === "string"
    && "locations" in value && Array.isArray(value.locations)
    && "domUpdateMs" in value && nonNegativeFinite(value.domUpdateMs)
    && "locationMeasureMs" in value && nonNegativeFinite(value.locationMeasureMs)
    && (!("viewportRenderMs" in value) || value.viewportRenderMs === undefined || nonNegativeFinite(value.viewportRenderMs))
    && (!("iframeTransferMs" in value) || value.iframeTransferMs === undefined || nonNegativeFinite(value.iframeTransferMs))
    && (!("renderer" in value) || value.renderer === undefined || isPreviewRendererReadyMetadata(value.renderer)));
}

export function isPreviewRendererReadyMetadata(value: unknown): value is PreviewRendererReadyMetadata {
  return Boolean(value && typeof value === "object"
    && "sessionId" in value && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && "artifactDigest" in value && typeof value.artifactDigest === "string"
    && "sourceDigest" in value && typeof value.sourceDigest === "string"
    && "backendGeneration" in value && Number.isSafeInteger(value.backendGeneration)
    && Number(value.backendGeneration) > 0
    && "generation" in value && Number.isSafeInteger(value.generation)
    && Number(value.generation) > 0
    && "baseGeneration" in value && Number.isSafeInteger(value.baseGeneration)
    && Number(value.baseGeneration) >= 0
    && "frameKind" in value && (value.frameKind === "new" || value.frameKind === "diff-v1")
    && "byteLength" in value && Number.isSafeInteger(value.byteLength)
    && Number(value.byteLength) > 0
    && "pageGeometries" in value && Array.isArray(value.pageGeometries)
    && value.pageGeometries.length > 0
    && value.pageGeometries.every(isRendererPageGeometry)
    && value.pageGeometries.every((geometry, index, geometries) => (
      geometry.pageIndex === index
      && geometry.offsetY === (index === 0 ? 0 : geometries[index - 1].offsetY + geometries[index - 1].height)
    ))
    && "patchedNodes" in value && nonNegativeSafeInteger(value.patchedNodes)
    && "reusedNodes" in value && nonNegativeSafeInteger(value.reusedNodes)
    && "removedNodes" in value && nonNegativeSafeInteger(value.removedNodes)
    && "pageBuffers" in value && nonNegativeSafeInteger(value.pageBuffers)
    && Number(value.pageBuffers) <= 8
    && "frameDecodeMs" in value && nonNegativeFinite(value.frameDecodeMs)
    && "rendererApplyMs" in value && nonNegativeFinite(value.rendererApplyMs));
}

export function isPreviewViewportMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "viewport" }> {
  return hasExactKeys(value, ["type", "renderKey", "presentation", "viewport"])
    && value.type === "viewport"
    && typeof value.renderKey === "string" && value.renderKey.length > 0
    && isPreviewSurfacePresentation(value.presentation)
    && isPreviewViewport(value.viewport);
}

export function isPreviewNavigateMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "navigate" }> {
  return Boolean(value && typeof value === "object"
    && "type" in value && value.type === "navigate"
    && "point" in value && isPreviewNavigationPoint(value.point));
}

export function isPreviewContextPointMessage(
  value: unknown,
): value is Extract<PreviewWebviewToHostMessage, { type: "context-point" }> {
  return hasExactKeys(value, ["type", "point", "anchor", "trigger"])
    && value.type === "context-point"
    && isStrictPreviewNavigationPoint(value.point)
    && isPreviewContextMenuAnchor(value.anchor)
    && (value.trigger === "select" || value.trigger === "menu");
}

function isPreviewContextMenuAnchor(value: unknown): value is PreviewContextMenuAnchor {
  return hasExactKeys(value, ["screenX", "screenY"])
    && typeof value.screenX === "number"
    && Number.isFinite(value.screenX)
    && typeof value.screenY === "number"
    && Number.isFinite(value.screenY);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function isImageAssetMessage(value: unknown): value is PreviewImageAssetMessage {
  return Boolean(value && typeof value === "object"
    && "digest" in value && typeof value.digest === "string"
    && "mimeType" in value && typeof value.mimeType === "string"
    && "dataBase64" in value && typeof value.dataBase64 === "string");
}

function isPageSize(value: unknown): value is PreviewRenderMessage["pageSize"] {
  return Boolean(value && typeof value === "object"
    && "width" in value && typeof value.width === "number"
    && "height" in value && typeof value.height === "number");
}

function isMeasurementSpan(value: unknown): value is PreviewMeasurementSpan {
  return Boolean(value && typeof value === "object"
    && "span" in value && typeof value.span === "string"
    && "start" in value && typeof value.start === "number"
    && "end" in value && typeof value.end === "number");
}

function isPreviewPagePoint(value: unknown): value is PreviewPagePoint {
  return Boolean(value && typeof value === "object"
    && "pageIndex" in value && typeof value.pageIndex === "number"
    && "x" in value && typeof value.x === "number"
    && "y" in value && typeof value.y === "number");
}

function isPreviewNavigationPoint(value: unknown): value is PreviewNavigationPoint {
  if (!isPreviewPagePoint(value)) return false;
  const candidate = value as PreviewPagePoint & { readonly textOffset?: unknown; readonly text?: unknown };
  const hasTextOffset = candidate.textOffset !== undefined;
  const hasText = candidate.text !== undefined;
  return hasTextOffset === hasText
    && (!hasTextOffset || (
      Number.isSafeInteger(candidate.textOffset)
      && Number(candidate.textOffset) >= 0
      && typeof candidate.text === "string"
      && candidate.text.length > 0
      && candidate.text.length <= 65_536
      && Number(candidate.textOffset) < candidate.text.length
    ));
}

function isStrictPreviewNavigationPoint(value: unknown): value is PreviewNavigationPoint {
  if (!hasExactKeys(value, ["pageIndex", "x", "y"], ["textOffset", "text"])
    || !nonNegativeSafeInteger(value.pageIndex)
    || !normalizedFinite(value.x)
    || !normalizedFinite(value.y)) {
    return false;
  }
  const hasTextOffset = Object.hasOwn(value, "textOffset");
  const hasText = Object.hasOwn(value, "text");
  return hasTextOffset === hasText
    && (!hasTextOffset || (
      nonNegativeSafeInteger(value.textOffset)
      && typeof value.text === "string"
      && value.text.length > 0
      && value.text.length <= 65_536
      && Number(value.textOffset) < value.text.length
    ));
}

function hasExactKeys<const Keys extends readonly string[]>(
  value: unknown,
  required: Keys,
  optional: readonly string[] = [],
): value is Record<Keys[number], unknown> & Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) return false;
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isPreviewViewport(value: unknown): value is PreviewViewport {
  return Boolean(value && typeof value === "object"
    && "page" in value && typeof value.page === "number"
    && "x" in value && typeof value.x === "number"
    && "y" in value && typeof value.y === "number"
    && "zoom" in value && typeof value.zoom === "number"
    && "fitMode" in value && (value.fitMode === "manual" || value.fitMode === "width" || value.fitMode === "page"));
}

function isPreviewExactExportState(value: unknown): value is PreviewExactExportState {
  return hasExactKeys(value, ["mode", "availability", "phase", "message", "canSelectFormat", "canExportDisplayed", "canWaitForLatest", "canCancel"],
    ["sourceUri", "displayedRenderKey", "requestedRenderKey", "completedRenderKey", "completedFormat", "completedFileName", "completedPageIndex", "completedPageCount"])
    && (value.mode === "exact" || value.mode === "current-preview")
    && typeof value.availability === "string"
    && ["no-document", "capability-unavailable", "ready", "stale", "partial", "failed", "evicted"].includes(value.availability)
    && typeof value.phase === "string"
    && ["idle", "waiting", "exporting", "complete", "cancelled", "error"].includes(value.phase)
    && typeof value.message === "string"
    && typeof value.canSelectFormat === "boolean" && typeof value.canExportDisplayed === "boolean"
    && typeof value.canWaitForLatest === "boolean" && typeof value.canCancel === "boolean"
    && ["sourceUri", "displayedRenderKey", "requestedRenderKey", "completedRenderKey", "completedFileName"].every((key) =>
      value[key] === undefined || (typeof value[key] === "string" && value[key].length > 0))
    && (value.completedFormat === undefined || value.completedFormat === "pdf" || value.completedFormat === "png" || value.completedFormat === "jpg" || value.completedFormat === "svg")
    && (value.completedPageIndex === undefined || nonNegativeSafeInteger(value.completedPageIndex))
    && (value.completedPageCount === undefined || (nonNegativeSafeInteger(value.completedPageCount) && Number(value.completedPageCount) > 0))
    && (value.completedPageIndex === undefined || (value.completedFormat !== "pdf"
      && typeof value.completedPageCount === "number" && Number(value.completedPageIndex) < value.completedPageCount));
}

function isRendererPageGeometry(value: unknown): value is PreviewRendererPageGeometry {
  return Boolean(value && typeof value === "object"
    && "pageIndex" in value && Number.isSafeInteger(value.pageIndex)
    && Number(value.pageIndex) >= 0
    && "offsetY" in value && nonNegativeFinite(value.offsetY)
    && "width" in value && positiveFinite(value.width)
    && "height" in value && positiveFinite(value.height));
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonNegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizedFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function positiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
