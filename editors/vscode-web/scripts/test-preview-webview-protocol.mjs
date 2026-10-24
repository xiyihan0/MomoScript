import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PreviewRendererSessionOwner } from "../src/previewRendererSession.ts";
import {
  PREVIEW_RENDERER_PROTOCOL_VERSION,
  preparePreviewProject,
} from "../../vscode/src/previewRendererProtocol.ts";
import {
  acceptsComposerIntent,
  isComposerIntentMessage,
  isComposerStateMessage,
  isComposerDrainedMessage,
  base64ToBytes,
  bytesToBase64,
  escapeHtml,
  float32CoordinatePrecision,
  isPreviewHostToWebviewMessage,
  isPreviewContextPointMessage,
  isPreviewWebviewToHostMessage,
  isPreviewSurfacePresentation,
  previewPresentationAcceptsPreset,
} from "../src/previewWebviewProtocol.ts";

const renderKey = "render-key";
const point = { pageIndex: 0, x: 0.25, y: 0.75 };
const anchor = { screenX: 640, screenY: 360 };
const clipboardAuthorization = "00000000-0000-4000-8000-000000000001";
const viewport = { page: 0, x: 0.25, y: 0.75, zoom: 1, fitMode: "width" };
const exactExportState = {
  mode: "exact",
  availability: "ready",
  phase: "idle",
  message: "Ready",
  canSelectFormat: true,
  canExportDisplayed: false,
  canWaitForLatest: false,
  canCancel: false,
};

const hostMessages = [
  {
    type: "render",
    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    imageAssets: [{ digest: "sha256:image", mimeType: "image/png", dataBase64: "AA==" }],
    pageSize: { width: 100, height: 200 },
    requestSequence: 1,
    traceId: "trace",
    renderKey,
    renderPreset: { kind: "output" },
    spans: [{ span: "1", start: 0, end: 1 }],
  },
  {
    type: "render-frame",
    sessionId: "session",
    frameKind: "new",
    dataBase64: "AA==",
    byteLength: 1,
    artifactDigest: "digest",
    sourceDigest: "source",
    backendGeneration: 1,
    rendererGeneration: 1,
    baseGeneration: 0,
    requestSequence: 2,
    traceId: "trace",
    renderKey,
    renderPreset: { kind: "output" },
    publishedAtEpochMs: 1,
  },
  { type: "renderer-reset" },
  { type: "status", message: "Rendering", error: false },
  { type: "restoreViewport", viewport, presentation: "layout" },
  { type: "indicator", point },
  { type: "cursor" },
  { type: "exactExportState", state: exactExportState },
  { type: "presentation", presentation: "chat" },
  { type: "presentation", presentation: "layout" },
  { type: "presentation", presentation: "preview" },
];

const renderer = {
  sessionId: "session",
  artifactDigest: "digest",
  sourceDigest: "source",
  backendGeneration: 1,
  generation: 1,
  baseGeneration: 0,
  frameKind: "new",
  byteLength: 1,
  pageGeometries: [{ pageIndex: 0, offsetY: 0, width: 100, height: 200 }],
  patchedNodes: 1,
  reusedNodes: 0,
  removedNodes: 0,
  pageBuffers: 1,
  frameDecodeMs: 1,
  rendererApplyMs: 1,
};
const webviewMessages = [
  { type: "ready" },
  {
    type: "visual-ready",
    requestSequence: 1,
    traceId: "trace",
    renderKey,
    locations: [],
    domUpdateMs: 1,
    locationMeasureMs: 0,
    renderer,
    viewportRenderMs: 1,
    iframeTransferMs: 1,
  },
  { type: "viewport", renderKey, presentation: "layout", viewport },
  { type: "navigate", point },
  { type: "navigate", point: { ...point, text: "1234abcd", textOffset: 4 } },
  { type: "context-point", point, anchor, trigger: "menu" },
  { type: "context-point", point: { ...point, text: "1234abcd", textOffset: 4 }, anchor, trigger: "select" },
  { type: "exact-export", format: "pdf", staleChoice: "wait-for-latest" },
  { type: "exact-export", format: "svg", pageIndex: 1, staleChoice: "export-displayed" },
  { type: "exact-export", format: "png", pageIndex: 0 },
  { type: "exact-export-cancel" },
  { type: "render-rejected", requestSequence: 1, renderKey, error: "rejected" },
  { type: "renderer-resync-needed", sessionId: "session", generation: 1 },
];

for (const message of hostMessages) {
  assert.equal(isPreviewHostToWebviewMessage(structuredClone(message)), true, `host message ${message.type} must round-trip`);
}
for (const message of webviewMessages) {
  assert.equal(isPreviewWebviewToHostMessage(structuredClone(message)), true, `webview message ${message.type} must round-trip`);
}

for (const malformed of [
  null,
  { type: "render" },
  { ...hostMessages[0], svg: 1 },
  { type: "status", message: "bad", error: "false" },
  { type: "restoreViewport", presentation: "layout", viewport: { ...viewport, zoom: "1" } },
  { type: "restoreViewport", viewport },
  { type: "restoreViewport", presentation: "gui", viewport },
  { type: "restoreViewport", presentation: "chat", viewport, extra: true },
  { type: "presentation" },
  { type: "presentation", presentation: "source" },
  { type: "presentation", presentation: "gui" },
  { type: "presentation", presentation: true },
  { type: "presentation", presentation: "chat", enabled: true },
  { type: "presentation", presentation: "preview", sessionId: "not-edit-authority" },
  { type: "exactExportState", state: { ...exactExportState, phase: "downloaded" } },
  { type: "exactExportState", state: { ...exactExportState, availability: "guess" } },
  { type: "exactExportState", state: { ...exactExportState, completedPageIndex: -1 } },
  { type: "exactExportState", state: { ...exactExportState, completedFormat: "pdf", completedPageIndex: 0, completedPageCount: 2 } },
  { type: "exactExportState", state: { ...exactExportState, completedFormat: "svg", completedPageIndex: 2, completedPageCount: 2 } },
  { type: "exactExportState", state: { ...exactExportState, extra: true } },
  { type: "exactExportState", state: exactExportState, extra: true },
  { type: "unknown-host" },
]) {
  assert.equal(isPreviewHostToWebviewMessage(malformed), false);
}
for (const malformed of [
  null,
  { type: "visual-ready", requestSequence: 1 },
  { ...webviewMessages[1], domUpdateMs: "1" },
  { type: "viewport", renderKey, presentation: "layout", viewport: { ...viewport, fitMode: "unknown" } },
  { type: "viewport", presentation: "layout", viewport },
  { type: "viewport", renderKey: "", presentation: "layout", viewport },
  { type: "viewport", renderKey: 1, presentation: "layout", viewport },
  { type: "viewport", renderKey, presentation: "layout", viewport, extra: true },
  { type: "viewport", renderKey, viewport },
  { type: "viewport", renderKey, presentation: "gui", viewport },
  { type: "viewport", renderKey, presentation: "source", viewport },
  { type: "navigate", point: { ...point, x: "0.25" } },
  { type: "navigate", point: { ...point, text: "1234abcd" } },
  { type: "navigate", point: { ...point, text: "1234abcd", textOffset: 8 } },
  { type: "navigate", point: { ...point, text: "1234abcd", textOffset: 4.5 } },
  { type: "context-point", point: { ...point, x: "0.25" }, anchor },
  { type: "context-point", point: { ...point, pageIndex: -1 }, anchor },
  { type: "context-point", point: { ...point, pageIndex: 0.5 }, anchor },
  { type: "context-point", point: { ...point, x: Number.NaN }, anchor },
  { type: "context-point", point: { ...point, x: Number.POSITIVE_INFINITY }, anchor },
  { type: "context-point", point: { ...point, x: -0.01 }, anchor },
  { type: "context-point", point: { ...point, y: 1.01 }, anchor },
  { type: "context-point", point: { ...point, text: "1234abcd" }, anchor },
  { type: "context-point", point: { ...point, text: "1234abcd", textOffset: 8 }, anchor },
  { type: "context-point", point: { ...point, text: "", textOffset: 0 }, anchor },
  { type: "context-point", point: { ...point, text: "1234abcd", textOffset: -1 }, anchor },
  { type: "context-point", point: { ...point, text: "1234abcd", textOffset: 4.5 }, anchor },
  { type: "context-point", point: { ...point, extra: true }, anchor },
  { type: "context-point", point, anchor: { ...anchor, screenX: Number.NaN } },
  { type: "context-point", point, anchor: { ...anchor, extra: true } },
  { type: "context-point", point },
  { type: "context-point", point, anchor, extra: true },
  { type: "exact-export", format: "txt" },
  { type: "exact-export", format: "svg", pageIndex: -1 },
  { type: "exact-export", format: "svg", pageIndex: 0.5 },
  { type: "exact-export", format: "svg", pageIndex: Number.NaN },
  { type: "exact-export", format: "svg", pageIndex: Number.POSITIVE_INFINITY },
  { type: "exact-export", format: "svg", pageIndex: Number.MAX_SAFE_INTEGER + 1 },
  { type: "exact-export", format: "svg", pageIndex: "1" },
  { type: "exact-export", format: "svg", pageIndex: undefined },
  { type: "exact-export", format: "pdf", pageIndex: 0 },
  { type: "exact-export", format: "png", staleChoice: "current" },
  { type: "exact-export", format: "png", staleChoice: undefined },
  { type: "exact-export", format: "png", pageIndex: 0, extra: true },
  { type: "exact-export-cancel", extra: true },
  { type: "render-rejected", requestSequence: "1", renderKey, error: "bad" },
  { type: "renderer-resync-needed", sessionId: "session", generation: 0 },
  { type: "unknown-webview" },
]) {
  const candidate = malformed?.type === "context-point" ? { trigger: "menu", ...malformed } : malformed;
  assert.equal(isPreviewWebviewToHostMessage(candidate), false);
}

for (const presentation of ["chat", "layout", "preview"]) {
  assert.equal(isPreviewSurfacePresentation(presentation), true);
  assert.equal(previewPresentationAcceptsPreset(presentation, { kind: "output" }), presentation !== "chat");
  for (const widthPt of [240, 390, 720]) {
    assert.equal(previewPresentationAcceptsPreset(presentation, { kind: "chat", widthPt }), presentation === "chat",
      "retained output/chat artifacts must not be reinterpreted when the presentation changes");
  }
}
for (const presentation of [undefined, null, "gui", "source", {}, true]) {
  assert.equal(isPreviewSurfacePresentation(presentation), false);
}
for (const message of hostMessages.filter((message) => message.type === "render" || message.type === "render-frame")) {
  for (const widthPt of [240, 390, 720]) {
    assert.equal(isPreviewHostToWebviewMessage({ ...message, renderPreset: { kind: "chat", widthPt } }), true);
  }
  const { renderPreset: _preset, ...missingPreset } = message;
  assert.equal(isPreviewHostToWebviewMessage(missingPreset), false, "presentation-free publications are forbidden");
  for (const renderPreset of [
    undefined, null, {}, { kind: "preview" }, { kind: "gui" }, { kind: "output", widthPt: 390 },
    { kind: "chat" }, { kind: "chat", widthPt: "390" }, { kind: "chat", widthPt: 239 },
    { kind: "chat", widthPt: 721 }, { kind: "chat", widthPt: 390.5 },
    { kind: "chat", widthPt: Number.NaN }, { kind: "chat", widthPt: Number.POSITIVE_INFINITY },
    { kind: "chat", widthPt: 390, version: 1 },
  ]) {
    assert.equal(isPreviewHostToWebviewMessage({ ...message, renderPreset }), false, "malformed preset reached renderer");
  }
  assert.equal(isPreviewHostToWebviewMessage({ ...message, presentation: "chat" }), false,
    "a caller cannot relabel an output publication using an extra presentation field");
}

assert.equal(isPreviewContextPointMessage({ type: "context-point", point, anchor, trigger: "menu" }), true);
assert.equal(isPreviewContextPointMessage({ type: "context-point", point, anchor, trigger: "select" }), true);
assert.equal(isPreviewContextPointMessage({ type: "context-point", point, anchor }), false);
assert.equal(isPreviewContextPointMessage({ type: "context-point", point, anchor, trigger: "click" }), false);
assert.equal(isPreviewContextPointMessage({ type: "context-point", point, anchor, trigger: "menu", extra: true }), false);


const composerState = {
  type: "composer-state",
  sessionId: "composer-session",
  sequence: 0,
  renderKey,
  status: "ready",
  screenCoordinatePrecision: 2 ** -13,
  carets: [{ pageIndex: 0, x: 0.25, y: 0.3, width: 0, height: 0.04, affinity: "after" }],
  boxes: [],
  clipboard: null,
};
const pointerIntent = { kind: "pointer", phase: "start", point, uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 1 };
const replaceIntent = { kind: "replace", text: "😀e\u0301\n> @不是语法 \"\"\"", origin: "typing" };
const deleteIntent = { kind: "replace", text: "", origin: "delete", direction: "backward", granularity: "grapheme" };
const composerMessage = (intent, overrides = {}) => ({
  type: "composer-intent", sessionId: composerState.sessionId, sequence: 1, renderKey, intent, ...overrides,
});
const validIntents = [
  pointerIntent,
  { ...pointerIntent, phase: "move", extend: true },
  { ...pointerIntent, phase: "end" },
  { ...pointerIntent, phase: "cancel" },
  { ...pointerIntent, clickCount: 2 },
  { ...pointerIntent, clickCount: 3 },
  { kind: "move", direction: "left", granularity: "grapheme", extend: false },
  { kind: "move", direction: "right", granularity: "word", extend: true },
  { kind: "move", direction: "up", granularity: "visualLine", extend: false },
  { kind: "move", direction: "down", granularity: "document", extend: true },
  replaceIntent,
  { kind: "replace", text: "plain\r\n> text", origin: "paste" },
  { kind: "clipboard", action: "cut", authorization: clipboardAuthorization },
  deleteIntent,
  { ...deleteIntent, direction: "forward", granularity: "word" },
  { kind: "composition", phase: "start", text: "" },
  { kind: "composition", phase: "update", text: "拼" },
  { kind: "composition", phase: "end", text: "拼音" },
  { kind: "composition", phase: "cancel", text: "未提交" },
  { kind: "history", direction: "undo" },
  { kind: "history", direction: "redo" },
  { kind: "clipboard", action: "copy", authorization: clipboardAuthorization },
  { kind: "clipboardRequest", action: "copy" },
  { kind: "clipboardRequest", action: "cut" },
  { kind: "contextMenu", anchor },
  { kind: "focus", backward: false },
  { kind: "focus", backward: true },
];
for (const intent of validIntents) {
  const message = structuredClone(composerMessage(intent));
  assert.equal(isComposerIntentMessage(message), true, `valid ${intent.kind} intent rejected`);
  assert.equal(isPreviewWebviewToHostMessage(message), true);
  assert.equal(acceptsComposerIntent(message, composerState, 0), true);
  assert.equal(isComposerIntentMessage({ ...message, extra: true }), false);
  assert.equal(isComposerIntentMessage({ ...message, intent: { ...intent, extra: true } }), false);
}

const malformedIntents = [
  { ...pointerIntent, phase: "hover" },
  { ...pointerIntent, clickCount: 0 },
  { ...pointerIntent, clickCount: 4 },
  { ...pointerIntent, clickCount: undefined },
  { ...pointerIntent, extend: 1 },
  { ...pointerIntent, point: { ...point, range: { start: 0, end: 1 } } },
  { ...pointerIntent, point: { ...point, pageIndex: -1 } },
  { ...pointerIntent, point: { ...point, pageIndex: 0.5 } },
  { ...pointerIntent, point: { ...point, pageIndex: 100_000 } },
  { ...pointerIntent, point: { ...point, x: Number.NaN } },
  { ...pointerIntent, point: { ...point, x: Number.POSITIVE_INFINITY } },
  { ...pointerIntent, point: { ...point, y: -0.01 } },
  { ...pointerIntent, point: { ...point, x: 1.01 } },
  { ...pointerIntent, uncertainty: undefined },
  { ...pointerIntent, uncertainty: { x: 0 } },
  { ...pointerIntent, uncertainty: { x: 0, y: 0, radius: 0 } },
  { ...pointerIntent, uncertainty: { x: Number.NaN, y: 0 } },
  { ...pointerIntent, uncertainty: { x: 0, y: Number.POSITIVE_INFINITY } },
  { ...pointerIntent, uncertainty: { x: -0.01, y: 0 } },
  { ...pointerIntent, uncertainty: { x: 0, y: 1.01 } },
  { kind: "move", direction: "start", granularity: "grapheme", extend: false },
  { kind: "move", direction: "left", granularity: "scalar", extend: false },
  { kind: "move", direction: "left", granularity: "word", extend: "false" },
  { ...replaceIntent, origin: "source" },
  { ...replaceIntent, text: "x".repeat(131_073) },
  { ...replaceIntent, text: "\ud83d" },
  { ...replaceIntent, text: null },
  { ...replaceIntent, direction: "backward", granularity: "grapheme" },
  { kind: "replace", origin: "cut", text: "must-read-from-Rust" },
  { kind: "replace", origin: "cut", text: "" },
  { kind: "replace", origin: "delete", text: "" },
  { ...deleteIntent, text: "x" },
  { ...deleteIntent, direction: "left" },
  { ...deleteIntent, granularity: "document" },
  { kind: "composition", phase: "commit", text: "拼" },
  { kind: "composition", phase: "start", text: "must-start-empty" },
  { kind: "history", direction: "previous" },
  { kind: "copy", text: "iframe-text-is-not-authoritative" },
  { kind: "copy" },
  { kind: "clipboard", action: "paste", authorization: clipboardAuthorization },
  { kind: "clipboard", action: "cut", authorization: "" },
  { kind: "clipboard", action: "cut", authorization: "not-issued" },
  { kind: "clipboard", action: "cut", authorization: clipboardAuthorization, text: "not-authority" },
  { kind: "clipboardRequest", action: "paste" },
  { kind: "clipboardRequest", action: "cut", authorization: clipboardAuthorization },
  { kind: "clipboardRequest", action: "copy", text: "iframe text is not authority" },
  { kind: "contextMenu", anchor: { ...anchor, screenX: Number.NaN } },
  { kind: "contextMenu", anchor: { ...anchor, extra: true } },
  { kind: "contextMenu", anchor, selection: { start: 0, end: 10 } },
  { kind: "focus", backward: "false" },
  { kind: "edit", edits: [] },
];
for (const intent of malformedIntents) {
  assert.equal(isPreviewWebviewToHostMessage(composerMessage(intent)), false, `malformed ${intent.kind} intent accepted`);
}
for (const overrides of [
  { sessionId: "" }, { sessionId: "s".repeat(257) }, { sessionId: null },
  { renderKey: "" }, { renderKey: "r".repeat(4097) }, { renderKey: 1 },
  { sequence: 0 }, { sequence: -1 }, { sequence: 0.5 },
  { sequence: Number.MAX_SAFE_INTEGER + 1 }, { sequence: Number.NaN },
]) {
  assert.equal(isComposerIntentMessage(composerMessage(replaceIntent, overrides)), false);
}

const selectionState = {
  ...composerState,
  carets: [composerState.carets[0], { pageIndex: 1, x: 0.8, y: 0.6, width: 0.001, height: 0.04, affinity: "before" }],
  boxes: [{ pageIndex: 0, x: 0.25, y: 0.3, width: 0.6, height: 0.04 }],
  clipboard: { authorization: clipboardAuthorization, text: "Rust 选区\n😀" },
};
for (const state of [
  composerState,
  selectionState,
  { ...selectionState, status: "pending", sequence: 3, clipboard: null },
  { ...composerState, status: "ready", carets: [] },
  { ...composerState, status: "blocked", carets: [] },
]) {
  assert.equal(isComposerStateMessage(structuredClone(state)), true);
  assert.equal(isPreviewHostToWebviewMessage(structuredClone(state)), true);
}
for (const state of [
  { ...composerState, extra: true },
  { ...composerState, status: "idle" },
  { ...composerState, clipboard: undefined },
  { ...composerState, clipboard: { authorization: clipboardAuthorization, text: "no range" } },
  { ...selectionState, status: "pending" },
  { ...selectionState, clipboard: { authorization: "not-issued", text: "text" } },
  { ...selectionState, clipboard: { authorization: clipboardAuthorization, text: "\ud83d" } },
  { ...selectionState, clipboard: { authorization: clipboardAuthorization, text: "text", extra: true } },
  { ...composerState, status: "blocked" },
  { ...composerState, sessionId: "" },
  { ...composerState, sequence: -1 },
  { ...composerState, sequence: Number.MAX_SAFE_INTEGER + 1 },
  { ...composerState, screenCoordinatePrecision: undefined },
  { ...composerState, screenCoordinatePrecision: Number.NaN },
  { ...composerState, screenCoordinatePrecision: Number.POSITIVE_INFINITY },
  { ...composerState, screenCoordinatePrecision: -0.01 },
  { ...composerState, screenCoordinatePrecision: 1.01 },
  { ...composerState, carets: new Array(3).fill(composerState.carets[0]) },
  { ...composerState, carets: [{ ...composerState.carets[0], affinity: "middle" }] },
  { ...composerState, carets: [{ ...composerState.carets[0], width: -0.1 }] },
  { ...composerState, carets: [{ ...composerState.carets[0], height: 0 }] },
  { ...composerState, carets: [{ ...composerState.carets[0], height: Number.NaN }] },
  { ...composerState, carets: [{ ...composerState.carets[0], x: 0.99, width: 0.02 }] },
  { ...composerState, boxes: [{ pageIndex: 0, x: 0, y: 0.99, width: 0.1, height: 0.02 }] },
  { ...composerState, boxes: [{ ...selectionState.boxes[0], extra: true }] },
  { ...composerState, boxes: new Array(65_537).fill(selectionState.boxes[0]) },
  { ...composerState, boxes: null },
]) {
  assert.equal(isPreviewHostToWebviewMessage(state), false, "malformed composer state reached the input surface");
}

assert.equal(acceptsComposerIntent(composerMessage(replaceIntent), undefined, 0), false);
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent), { ...composerState, status: "blocked", carets: [] }, 0), false);
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { sessionId: "old-session" }), composerState, 0), false);
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { renderKey: "old-render" }), composerState, 0), false);
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent), composerState, 1), false, "duplicate input was admitted twice");
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent), { ...composerState, sequence: 2 }, 0), false);
assert.equal(acceptsComposerIntent(composerMessage(pointerIntent), { ...composerState, status: "pending" }, 0), false, "pending geometry authorized a pointer");
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent), { ...composerState, status: "pending" }, 0), true, "render latency discarded typing");
assert.equal(acceptsComposerIntent(composerMessage({ kind: "clipboardRequest", action: "copy" }),
  { ...composerState, status: "pending" }, 0), true, "ordered Copy must wait behind accepted selection movement");
assert.equal(acceptsComposerIntent(composerMessage({ kind: "clipboardRequest", action: "cut" }),
  { ...composerState, status: "blocked", carets: [] }, 0), false, "blocked sessions cannot enqueue clipboard requests");
assert.equal(acceptsComposerIntent(composerMessage({ kind: "clipboardRequest", action: "cut" },
  { sessionId: "retired-session" }), composerState, 0), false, "clipboard requests cannot revive retired sessions");
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { sequence: 4 }), { ...composerState, sequence: 2 }, 3), true);

const issuedKeys = new Set(["prior-render", renderKey]);
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { renderKey: "prior-render" }), composerState, 0, issuedKeys), true, "published prior-frame typing was lost during own rerender");
assert.equal(acceptsComposerIntent(composerMessage(pointerIntent, { renderKey: "prior-render" }), composerState, 0, issuedKeys), false, "prior-frame pointer became writable");
assert.equal(acceptsComposerIntent(composerMessage({ kind: "clipboard", action: "cut", authorization: clipboardAuthorization },
  { renderKey: "prior-render" }), composerState, 0, issuedKeys), false, "prior-frame clipboard proof became writable");
assert.equal(acceptsComposerIntent(composerMessage({ kind: "contextMenu", anchor },
  { renderKey: "prior-render" }), composerState, 0, issuedKeys), false, "prior-frame native menu was admitted");
assert.equal(acceptsComposerIntent(composerMessage({ kind: "clipboard", action: "copy", authorization: clipboardAuthorization }),
  { ...composerState, status: "pending" }, 0), false, "pending selection exposed ephemeral clipboard text");
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { renderKey: "unknown-render" }), composerState, 0, issuedKeys), false);
issuedKeys.delete("prior-render");
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { renderKey: "prior-render" }), composerState, 0, issuedKeys), false, "retired issued key re-entered the input chain");
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent), { ...composerState, status: "blocked", carets: [] }, 0, issuedKeys), false, "blocked chain accepted an issued key");

const drained = { type: "composer-drained", sessionId: composerState.sessionId, sequence: 3 };
assert.equal(isComposerDrainedMessage(drained), true);
assert.equal(isPreviewWebviewToHostMessage({ ...drained, sequence: 0 }), true);
for (const malformed of [
  { ...drained, sequence: -1 }, { ...drained, sequence: 0.5 },
  { ...drained, sequence: Number.MAX_SAFE_INTEGER + 1 },
  { ...drained, sessionId: "" }, { ...drained, sessionId: "s".repeat(257) },
  { ...drained, renderKey }, { ...drained, extra: true },
]) {
  assert.equal(isPreviewWebviewToHostMessage(malformed), false, "malformed drain barrier retired an input session");
}
assert.equal(float32CoordinatePrecision(0), 2 ** -149);
assert.equal(float32CoordinatePrecision(1024 - 2 ** -17), 2 ** -13,
  "rounding up to a Float32 exponent boundary must use the larger adjacent step");
assert.equal(float32CoordinatePrecision(-1024), 2 ** -13);

const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
assert.equal(escapeHtml(`<tag a="'&">`), "&lt;tag a=&quot;&#39;&amp;&quot;&gt;");

// Exercise the production zoom functions against native integer scroll offsets
// and 1/64-pixel layout, without loading the renderer or rewriting their bodies.
const viewportRuntimeSource = await readFile(new URL("../src/previewWebviewRuntime.ts", import.meta.url), "utf8");
const viewportRuntimeAst = ts.createSourceFile(
  "previewWebviewRuntime.ts", viewportRuntimeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
);
const zoomFunctionNames = [
  "applyZoom", "applyZoomAroundPoint", "applyZoomAtViewportCenter", "zoomForFit", "fitWidth", "fitPage",
];
const zoomFunctionNodes = viewportRuntimeAst.statements.filter((node) => (
  ts.isFunctionDeclaration(node) && zoomFunctionNames.includes(node.name?.text)
));
assert.equal(zoomFunctionNodes.length, zoomFunctionNames.length, "the production zoom entry points must remain covered");
const zoomRuntimeCode = ts.transpileModule(zoomFunctionNodes.map((node) => node.getText(viewportRuntimeAst)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function createZoomViewport({ intrinsicHeight = 7018, initialScrollTop = 15585 } = {}) {
  let scrollLeft = 0;
  let scrollTop = initialScrollTop;
  const style = { width: "1233px", height: `${intrinsicHeight * 4.11}px` };
  const layout = (value) => Math.floor(Number.parseFloat(value) * 64) / 64;
  const zoomViewport = {
    clientWidth: 1280,
    clientHeight: 556,
    get scrollWidth() { return Math.max(this.clientWidth, Math.round(layout(style.width) + 48)); },
    get scrollHeight() { return Math.max(this.clientHeight, Math.round(layout(style.height) + 48)); },
    get scrollLeft() { return scrollLeft = Math.max(0, Math.min(scrollLeft, this.scrollWidth - this.clientWidth)); },
    set scrollLeft(value) { scrollLeft = Math.round(Math.max(0, Math.min(value, this.scrollWidth - this.clientWidth))); },
    get scrollTop() { return scrollTop = Math.max(0, Math.min(scrollTop, this.scrollHeight - this.clientHeight)); },
    set scrollTop(value) { scrollTop = Math.round(Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
    getBoundingClientRect() { return { left: 0, top: 53, width: this.clientWidth, height: this.clientHeight }; },
  };
  const zoomPage = {
    style,
    querySelector() { return null; },
    getBoundingClientRect() {
      const width = layout(style.width);
      return {
        left: Math.max(24, (zoomViewport.clientWidth - width) / 2) - zoomViewport.scrollLeft,
        top: 53 + 24 - zoomViewport.scrollTop,
        width,
        height: layout(style.height),
      };
    },
  };
  const runtime = {
    intrinsicWidth: 300,
    intrinsicHeight,
    zoom: 4.11,
    fitMode: "manual",
    presentation: "layout",
    renderGeneration: 1,
    zoomScrollRounding: undefined,
    viewport: zoomViewport,
    page: zoomPage,
    zoomLabel: {},
    indicatorPoint: undefined,
    cursorPoint: undefined,
    showOverlay() {},
    composerInput: { layout() {} },
    persistentRenderer: { viewportChanged() {} },
    reportViewport() {},
  };
  const operations = runInNewContext(`${zoomRuntimeCode}\n({ ${zoomFunctionNames.join(", ")} });`, runtime);
  const reading = () => {
    const visible = zoomViewport.getBoundingClientRect();
    const rendered = zoomPage.getBoundingClientRect();
    return {
      x: (visible.left + visible.width / 2 - rendered.left) / rendered.width,
      y: (visible.top + visible.height / 2 - rendered.top) / rendered.height,
      width: rendered.width,
      height: rendered.height,
    };
  };
  return { operations, viewport: zoomViewport, runtime, reading };
}

function assertZoomReading(fixture, expected, message) {
  const current = fixture.reading();
  assert.ok(Math.max(
    Math.abs(current.x - expected.x) * current.width,
    Math.abs(current.y - expected.y) * current.height,
  ) <= 1, message);
}

{
  // Recorded GUI failure: 4.11 -> 4.01 -> 3.91 -> 3.81 rounded scrollTop
  // 15585 -> 15200 -> 14815 -> 14430 and accumulated 1.1266897 CSS px.
  const fixture = createZoomViewport();
  const before = fixture.reading();
  for (const nextZoom of [4.01, 3.91, 3.81]) {
    fixture.operations.applyZoomAtViewportCenter(nextZoom);
    assertZoomReading(fixture, before, "successive manual zooms must not accumulate native scroll rounding");
  }
  const beforeFit = fixture.reading();
  fixture.operations.fitWidth();
  assertZoomReading(fixture, beforeFit, "switching to fit width must anchor the current reading point");
  const beforeResize = fixture.reading();
  fixture.viewport.clientWidth = 1360;
  fixture.operations.fitWidth();
  assertZoomReading(fixture, beforeResize, "fitted width resizing must retain the reading point");
  const beforePage = fixture.reading();
  fixture.operations.fitPage();
  assertZoomReading(fixture, beforePage, "a reachable fit-page center must retain the reading point");
}

{
  const fixture = createZoomViewport();
  fixture.operations.applyZoomAtViewportCenter(4.01);
  fixture.viewport.scrollTop += 2000;
  const afterNativeScroll = fixture.reading();
  fixture.operations.applyZoomAtViewportCenter(3.91);
  assertZoomReading(fixture, afterNativeScroll, "native scrolling must replace the prior zoom anchor");
  fixture.operations.applyZoom(3.81, "manual", false);
  const afterRestore = fixture.reading();
  fixture.operations.applyZoomAtViewportCenter(3.71);
  assertZoomReading(fixture, afterRestore, "an explicit viewport restore must discard prior zoom rounding");
}

{
  const fixture = createZoomViewport({ intrinsicHeight: 300, initialScrollTop: 650 });
  fixture.operations.applyZoomAtViewportCenter(1.69);
  assert.equal(fixture.viewport.scrollTop, 0, "a page shorter than the viewport cannot retain its former center");
  const clamped = fixture.reading();
  fixture.operations.applyZoomAtViewportCenter(4.11);
  assertZoomReading(fixture, clamped, "unreachable scroll-bound displacement must not survive as rounding");
}

// Load the production host with only its browser/webview collaborators replaced.
// No lifecycle source is rewritten: publications and acknowledgements use its
// real transport and ownership methods.
register(`data:text/javascript,${encodeURIComponent(`
  let mocks;
  export function initialize(data) { mocks = data; }
  export async function resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(mocks, specifier)) {
      return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, {
  parentURL: import.meta.url,
  data: {
    "@codingame/monaco-vscode-api/vscode/vs/base/browser/window":
      "export const mainWindow = globalThis.window;",
    "@codingame/monaco-vscode-api/vscode/vs/base/common/uri":
      "export const URI = { parse: (value) => new URL(value) };",
    "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webview/common/webview":
      'export const asWebviewUri = (uri) => uri; export const webviewGenericCspSource = "https://webview.test";',
    "./previewWebviewRuntime.ts?worker&url":
      'export default "https://webview.test/preview-runtime.js";',
  },
});
const savedHostGlobals = new Map(["window", "location", "ResizeObserver"].map((key) => (
  [key, Object.getOwnPropertyDescriptor(globalThis, key)]
)));
const hostWindow = {
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener() {},
  removeEventListener() {},
  getComputedStyle() { return { visibility: "visible" }; },
  setTimeout,
  clearTimeout,
};
Object.defineProperties(globalThis, {
  window: { value: hostWindow, configurable: true, writable: true },
  location: { value: new URL("https://workbench.test/"), configurable: true, writable: true },
  ResizeObserver: {
    value: class { observe() {} disconnect() {} },
    configurable: true,
    writable: true,
  },
});
try {
  const { PreviewWebviewHost } = await import("../src/previewWebviewHost.ts");
  const postedHostMessages = [];
  const framePosts = [];
  const frameDeliveries = [];
  let receiveHostMessage;
  const retainedWebview = {
    container: { style: {}, inert: false },
    onMessage(callback) { receiveHostMessage = callback; return { dispose() {} }; },
    setHtml() {},
    claim() {},
    release() {},
    layoutWebviewOverElement() {},
    dispose() {},
    postMessage(message) {
      postedHostMessages.push(message);
      if (message.type === "render-frame") {
        framePosts.shift().resolve(message);
        return frameDeliveries.shift() ?? true;
      }
      return true;
    },
  };
  const host = new PreviewWebviewHost({
    viewportChanged() {},
    navigationRequested() {},
    contextMenuRequested() {},
    composerIntent() {},
    composerDrained() {},
    exactExportRequested() {},
    exactExportCancelled() {},
  }, {
    webviewService: { createWebviewOverlay: () => retainedWebview },
  });
  const hostDocument = { defaultView: hostWindow };
  const hostSurface = {
    ownerDocument: hostDocument,
    isConnected: true,
    getBoundingClientRect: () => ({ width: 400, height: 800 }),
  };
  const preset = { kind: "output" };
  const hostCandidate = (sessionId, generation, frameKind = "new", baseGeneration = 0) => ({
    sourceUri: "mmtfs://workspace/host.mmt",
    sessionId,
    backendGeneration: 1,
    ready: {
      sessionId,
      snapshotToken: `${sessionId}-${generation}`,
      artifactDigest: `artifact-${sessionId}-${generation}`,
      sourceDigest: `source-${sessionId}-${generation}`,
      generation,
      frameKind,
      baseGeneration,
      dataBase64: "AA==",
      byteLength: 1,
      pageCount: 1,
    },
  });
  const beginHostPublication = async (candidate, signal) => {
    const posted = Promise.withResolvers();
    framePosts.push(posted);
    const publication = host.publishRendererFrame(candidate, {
      renderKey: candidate.ready.snapshotToken,
      renderPreset: preset,
      signal,
    });
    return { publication, message: await posted.promise };
  };
  const acknowledgeHostFrame = (message, overrides = {}) => receiveHostMessage({
    message: {
      type: "visual-ready",
      requestSequence: message.requestSequence,
      renderKey: message.renderKey,
      locations: [],
      domUpdateMs: 0,
      locationMeasureMs: 0,
      renderer: {
        ...renderer,
        sessionId: message.sessionId,
        artifactDigest: message.artifactDigest,
        sourceDigest: message.sourceDigest,
        backendGeneration: message.backendGeneration,
        generation: message.rendererGeneration,
        baseGeneration: message.baseGeneration,
        frameKind: message.frameKind,
        byteLength: message.byteLength,
        ...overrides,
      },
    },
  });
  const resetsPosted = () => postedHostMessages.filter((message) => message.type === "renderer-reset").length;
  try {
    host.attachSurface({}, hostSurface, hostSurface, "layout");
    receiveHostMessage({ message: { type: "ready" } });
    const committedFrame = hostCandidate("old-session", 1);
    const firstPublication = await beginHostPublication(committedFrame);
    acknowledgeHostFrame(firstPublication.message);
    await firstPublication.publication;
    host.commitRendererCandidate(committedFrame, preset);

    const supersededFrame = hostCandidate("old-session", 2, "diff-v1", 1);
    const supersededPublication = await beginHostPublication(supersededFrame);
    const retiredPublication = assert.rejects(supersededPublication.publication, /no longer the published frame/);
    const freshFrame = hostCandidate("new-session", 1);
    const freshPublication = await beginHostPublication(freshFrame);
    host.resetRenderer(supersededFrame);
    host.resetRenderer(committedFrame);
    assert.equal(resetsPosted(), 0, "old cleanup must not reset a newer publication awaiting visual-ready");
    acknowledgeHostFrame(supersededPublication.message);
    await retiredPublication;
    acknowledgeHostFrame(freshPublication.message);
    await freshPublication.publication;
    host.resetRenderer(supersededFrame);
    assert.equal(resetsPosted(), 0, "old cleanup must not reset visual-ready before producer commit");
    assert.throws(() => host.commitRendererCandidate(supersededFrame, preset), /no longer the published frame/);
    host.commitRendererCandidate(freshFrame, preset);
    const freshDelta = hostCandidate("new-session", 2, "diff-v1", 1);
    assert.equal(host.acceptsRendererCandidate(freshDelta, preset), true,
      "the newly committed consumer frame must remain a usable delta baseline");

    const deltaPublication = await beginHostPublication(freshDelta);
    host.resetRenderer(freshFrame);
    assert.equal(resetsPosted(), 0, "older same-session generation cleanup must not reset a pending delta");
    acknowledgeHostFrame(deltaPublication.message);
    await deltaPublication.publication;
    host.commitRendererCandidate(freshDelta, preset);
    host.resetRenderer(freshFrame);
    const nextDelta = hostCandidate("new-session", 3, "diff-v1", 2);
    assert.equal(host.acceptsRendererCandidate(nextDelta, preset), true);
    host.resetRenderer(freshDelta);
    assert.equal(resetsPosted(), 1, "the owning candidate must still be able to reset its frame");
    assert.equal(host.acceptsRendererCandidate(nextDelta, preset), false);

    const invalidFrame = hostCandidate("invalid-ack-session", 1);
    const invalidPublication = await beginHostPublication(invalidFrame);
    const invalidAcknowledgement = assert.rejects(invalidPublication.publication, /acknowledgement identity mismatch/);
    acknowledgeHostFrame(invalidPublication.message, { generation: 2 });
    await invalidAcknowledgement;
    host.resetRenderer(invalidFrame);
    assert.equal(resetsPosted(), 2, "invalid acknowledgements must still allow exact-candidate cleanup");
    host.resetRenderer();
    assert.equal(resetsPosted(), 3, "explicit force resets must remain unconditional");

    const transactionSourceUri = "mmtfs://workspace/delivery-cancellation.mmt";
    const transactionEntryUri = "untitled:/mmt-projection/delivery-cancellation/main.typ";
    const transactionMount = { logicalSourceId: "a".repeat(64) };
    const transactionProject = (revision) => ({
      sourceUri: transactionSourceUri,
      sourceVersion: revision,
      revision,
      entryUri: transactionEntryUri,
      files: [{ uri: transactionEntryUri, text: `[revision ${revision}]`, digest: "f".repeat(64) }],
      full: true,
      sourceContent: "b".repeat(64),
      projectDigest: "c".repeat(64),
      projectionKey: "d".repeat(64),
      mappingDigest: "e".repeat(64),
    });
    const transactionSessions = new Map();
    const transactionCloses = [];
    let transactionSessionSequence = 0;
    const transactions = new PreviewRendererSessionOwner({
      createSessionId: () => `delivery-session-${++transactionSessionSequence}`,
      backend: {
        backendGeneration: () => 1,
        async previewRenderer(project, mount, options) {
          const synchronized = await preparePreviewProject(project, mount);
          const generation = (options.baseGeneration ?? 0) + 1;
          const frameKind = options.forceFull ? "new" : "diff-v1";
          const payload = new TextEncoder().encode(`${frameKind},delivery-${generation}`);
          const ready = {
            status: "ready",
            protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
            sessionId: options.sessionId,
            snapshotToken: options.snapshotToken,
            sourceDigest: synchronized.sourceDigest,
            artifactDigest: Buffer.from(await crypto.subtle.digest("SHA-256", payload)).toString("hex"),
            compilerRevision: generation,
            generation,
            baseGeneration: options.baseGeneration ?? 0,
            frameKind,
            dataBase64: Buffer.from(payload).toString("base64"),
            byteLength: payload.byteLength,
            pageCount: 1,
            diagnostics: [],
          };
          transactionSessions.set(options.sessionId, ready);
          return { synchronized, response: ready };
        },
        async transitionPreviewRenderer(transition) {
          const staged = transactionSessions.get(transition.sessionId);
          assert.equal(staged?.snapshotToken, transition.snapshotToken);
          assert.equal(staged?.generation, transition.generation);
          transactionSessions.delete(transition.sessionId);
          return {
            status: transition.action === "commit" ? "committed" : "discarded",
            protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
            sessionId: transition.sessionId,
            snapshotToken: transition.snapshotToken,
            generation: transition.generation,
          };
        },
        async closePreviewRenderer(sessionId) {
          transactionCloses.push(sessionId);
          transactionSessions.delete(sessionId);
          return { status: "closed", protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION, sessionId };
        },
      },
    });
    try {
      const deliveryAbort = new AbortController();
      const pendingFrame = await transactions.render(
        transactionProject(1), transactionMount, "1".repeat(64), deliveryAbort.signal,
      );
      const delivery = Promise.withResolvers();
      frameDeliveries.push(delivery.promise);
      const pendingPublication = await beginHostPublication(pendingFrame, deliveryAbort.signal);
      const publicationCleanup = pendingPublication.publication.catch(async (error) => {
        await transactions.closeSource(transactionSourceUri, pendingFrame);
        host.resetRenderer(pendingFrame);
        throw error;
      });
      const cancelledDelivery = assert.rejects(publicationCleanup, /surface closed during frame delivery/);
      await assert.rejects(
        () => transactions.render(transactionProject(2), transactionMount, "2".repeat(64)),
        /already has a staged generation/,
        "a candidate awaiting publication must remain staged until its actual lifecycle cleanup",
      );
      deliveryAbort.abort(new DOMException("surface closed during frame delivery", "AbortError"));
      delivery.resolve(true);
      await cancelledDelivery;
      assert.deepEqual(transactionCloses, [pendingFrame.sessionId],
        "abort during postMessage must settle publication and run exact candidate cleanup without visual-ready");
      assert.equal(transactionSessions.has(pendingFrame.sessionId), false);

      const reopenedFrame = await transactions.render(transactionProject(2), transactionMount, "2".repeat(64));
      assert.notEqual(reopenedFrame.sessionId, pendingFrame.sessionId);
      assert.equal(reopenedFrame.ready.frameKind, "new");
      const reopenedPublication = await beginHostPublication(reopenedFrame);
      acknowledgeHostFrame(reopenedPublication.message);
      await reopenedPublication.publication;
      await transactions.commit(reopenedFrame);
      host.commitRendererCandidate(reopenedFrame, preset);
      const reopenedDelta = await transactions.render(transactionProject(3), transactionMount, "3".repeat(64));
      assert.equal(reopenedDelta.sessionId, reopenedFrame.sessionId);
      assert.equal(host.acceptsRendererCandidate(reopenedDelta, preset), true,
        "reopening after cancelled delivery must retain the new exact committed frame");
      const reopenedDeltaPublication = await beginHostPublication(reopenedDelta);
      acknowledgeHostFrame(reopenedDeltaPublication.message);
      await reopenedDeltaPublication.publication;
      await transactions.commit(reopenedDelta);
      host.commitRendererCandidate(reopenedDelta, preset);
      assert.equal(reopenedDelta.ready.snapshotToken, "3".repeat(64));
    } finally {
      await transactions.closeAll();
      transactions.dispose();
    }
  } finally {
    host.dispose();
  }
} finally {
  for (const [key, descriptor] of savedHostGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

console.log("preview webview protocol contract passed");
