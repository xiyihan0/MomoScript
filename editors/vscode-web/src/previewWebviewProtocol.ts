import type { ExactExportFormat, StaleExportChoice } from "./exactExport.ts";
import type { RenderKey } from "../../vscode/src/runtimeIdentity.ts";

export type PreviewFitMode = "manual" | "width" | "page";

export interface PreviewPagePoint {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
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
  readonly publishedAtEpochMs: number;
}

export interface PreviewRendererPageGeometry {
  readonly pageIndex: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

export interface PreviewExactExportState {
  readonly mode: "exact" | "current-preview";
  readonly availability: string;
  readonly phase: string;
  readonly message: string;
  readonly canSelectFormat: boolean;
  readonly canExportDisplayed: boolean;
  readonly canWaitForLatest: boolean;
  readonly canCancel: boolean;
}

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

export type PreviewHostToWebviewMessage =
  | PreviewRenderMessage
  | PreviewRendererFrameMessage
  | { readonly type: "renderer-reset" }
  | { readonly type: "status"; readonly message: string; readonly error: boolean }
  | { readonly type: "restoreViewport"; readonly viewport: PreviewViewport }
  | { readonly type: "indicator"; readonly point?: PreviewPagePoint }
  | { readonly type: "cursor"; readonly point?: PreviewPagePoint }
  | { readonly type: "exactExportState"; readonly state: PreviewExactExportState };

export type PreviewWebviewToHostMessage =
  | { readonly type: "ready" }
  | PreviewVisualReadyMessage
  | { readonly type: "viewport"; readonly viewport: PreviewViewport }
  | { readonly type: "navigate"; readonly point: PreviewPagePoint }
  | { readonly type: "exact-export"; readonly format: ExactExportFormat; readonly staleChoice?: StaleExportChoice }
  | { readonly type: "exact-export-cancel" }
  | { readonly type: "render-rejected"; readonly requestSequence: number; readonly renderKey: RenderKey; readonly error: string }
  | { readonly type: "renderer-resync-needed"; readonly sessionId: string; readonly generation: number };

export function isPreviewHostToWebviewMessage(value: unknown): value is PreviewHostToWebviewMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  switch (value.type) {
    case "render":
      return "svg" in value && typeof value.svg === "string"
        && "imageAssets" in value && Array.isArray(value.imageAssets)
        && value.imageAssets.every(isImageAssetMessage)
        && "pageSize" in value && isPageSize(value.pageSize)
        && "requestSequence" in value && Number.isSafeInteger(value.requestSequence)
        && (!("traceId" in value) || value.traceId === undefined || typeof value.traceId === "string")
        && "renderKey" in value && typeof value.renderKey === "string"
        && "spans" in value && Array.isArray(value.spans)
        && value.spans.every(isMeasurementSpan);
    case "render-frame":
      return "sessionId" in value && typeof value.sessionId === "string"
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
      return "viewport" in value && isPreviewViewport(value.viewport);
    case "indicator":
    case "cursor":
      return !("point" in value) || value.point === undefined || isPreviewPagePoint(value.point);
    case "exactExportState":
      return "state" in value && isPreviewExactExportState(value.state);
    default:
      return false;
  }
}

export function isPreviewWebviewToHostMessage(value: unknown): value is PreviewWebviewToHostMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  switch (value.type) {
    case "ready": return isPreviewWebviewReadyMessage(value);
    case "visual-ready": return isPreviewVisualReadyMessage(value);
    case "viewport": return isPreviewViewportMessage(value);
    case "navigate": return isPreviewNavigateMessage(value);
    case "exact-export": return isExportMessage(value);
    case "exact-export-cancel": return isExactExportCancelMessage(value);
    case "render-rejected": return isPreviewRenderRejectedMessage(value);
    case "renderer-resync-needed": return isPreviewRendererResyncNeededMessage(value);
    default: return false;
  }
}

export function isExportMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "exact-export" }> {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "exact-export") return false;
  if (!("format" in value) || !["pdf", "png", "jpg", "svg"].includes(String(value.format))) return false;
  return !("staleChoice" in value)
    || value.staleChoice === undefined
    || value.staleChoice === "export-displayed"
    || value.staleChoice === "wait-for-latest";
}

export function isExactExportCancelMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "exact-export-cancel" }> {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "exact-export-cancel");
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
  return Boolean(value && typeof value === "object"
    && "type" in value && value.type === "viewport"
    && "viewport" in value && isPreviewViewport(value.viewport));
}

export function isPreviewNavigateMessage(value: unknown): value is Extract<PreviewWebviewToHostMessage, { type: "navigate" }> {
  return Boolean(value && typeof value === "object"
    && "type" in value && value.type === "navigate"
    && "point" in value && isPreviewPagePoint(value.point));
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

function isPreviewViewport(value: unknown): value is PreviewViewport {
  return Boolean(value && typeof value === "object"
    && "page" in value && typeof value.page === "number"
    && "x" in value && typeof value.x === "number"
    && "y" in value && typeof value.y === "number"
    && "zoom" in value && typeof value.zoom === "number"
    && "fitMode" in value && (value.fitMode === "manual" || value.fitMode === "width" || value.fitMode === "page"));
}

function isPreviewExactExportState(value: unknown): value is PreviewExactExportState {
  return Boolean(value && typeof value === "object"
    && "mode" in value && (value.mode === "exact" || value.mode === "current-preview")
    && "availability" in value && typeof value.availability === "string"
    && "phase" in value && typeof value.phase === "string"
    && "message" in value && typeof value.message === "string"
    && "canSelectFormat" in value && typeof value.canSelectFormat === "boolean"
    && "canExportDisplayed" in value && typeof value.canExportDisplayed === "boolean"
    && "canWaitForLatest" in value && typeof value.canWaitForLatest === "boolean"
    && "canCancel" in value && typeof value.canCancel === "boolean");
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

function positiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
