import assert from "node:assert/strict";
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
} from "../src/previewWebviewProtocol.ts";

const renderKey = "render-key";
const point = { pageIndex: 0, x: 0.25, y: 0.75 };
const anchor = { screenX: 640, screenY: 360 };
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
    publishedAtEpochMs: 1,
  },
  { type: "renderer-reset" },
  { type: "status", message: "Rendering", error: false },
  { type: "restoreViewport", viewport },
  { type: "indicator", point },
  { type: "cursor" },
  { type: "exactExportState", state: exactExportState },
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
  { type: "viewport", viewport },
  { type: "navigate", point },
  { type: "navigate", point: { ...point, text: "1234abcd", textOffset: 4 } },
  { type: "context-point", point, anchor },
  { type: "context-point", point: { ...point, text: "1234abcd", textOffset: 4 }, anchor },
  { type: "exact-export", format: "pdf", staleChoice: "wait-for-latest" },
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
  { type: "restoreViewport", viewport: { ...viewport, zoom: "1" } },
  { type: "unknown-host" },
]) {
  assert.equal(isPreviewHostToWebviewMessage(malformed), false);
}
for (const malformed of [
  null,
  { type: "visual-ready", requestSequence: 1 },
  { ...webviewMessages[1], domUpdateMs: "1" },
  { type: "viewport", viewport: { ...viewport, fitMode: "unknown" } },
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
  { type: "render-rejected", requestSequence: "1", renderKey, error: "bad" },
  { type: "renderer-resync-needed", sessionId: "session", generation: 0 },
  { type: "unknown-webview" },
]) {
  assert.equal(isPreviewWebviewToHostMessage(malformed), false);
}

assert.equal(isPreviewContextPointMessage({ type: "context-point", point, anchor }), true);
assert.equal(isPreviewContextPointMessage({ type: "context-point", point, anchor, extra: true }), false);


const composerState = {
  type: "composer-state",
  sessionId: "composer-session",
  sequence: 0,
  renderKey,
  status: "ready",
  screenCoordinatePrecision: 2 ** -13,
  carets: [{ pageIndex: 0, x: 0.25, y: 0.3, width: 0, height: 0.04, affinity: "after" }],
  boxes: [],
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
  { kind: "move", direction: "left", granularity: "grapheme", extend: false },
  { kind: "move", direction: "right", granularity: "word", extend: true },
  { kind: "move", direction: "up", granularity: "visualLine", extend: false },
  { kind: "move", direction: "down", granularity: "document", extend: true },
  replaceIntent,
  { kind: "replace", text: "plain\r\n> text", origin: "paste" },
  { kind: "replace", text: "", origin: "cut" },
  deleteIntent,
  { ...deleteIntent, direction: "forward", granularity: "word" },
  { kind: "composition", phase: "start", text: "" },
  { kind: "composition", phase: "update", text: "拼" },
  { kind: "composition", phase: "end", text: "拼音" },
  { kind: "composition", phase: "cancel", text: "未提交" },
  { kind: "history", direction: "undo" },
  { kind: "history", direction: "redo" },
  { kind: "copy" },
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
  { ...pointerIntent, clickCount: 3 },
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
  { kind: "replace", origin: "delete", text: "" },
  { ...deleteIntent, text: "x" },
  { ...deleteIntent, direction: "left" },
  { ...deleteIntent, granularity: "document" },
  { kind: "composition", phase: "commit", text: "拼" },
  { kind: "composition", phase: "start", text: "must-start-empty" },
  { kind: "history", direction: "previous" },
  { kind: "copy", text: "iframe-text-is-not-authoritative" },
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
};
for (const state of [
  composerState,
  selectionState,
  { ...selectionState, status: "pending", sequence: 3 },
  { ...composerState, status: "ready", carets: [] },
  { ...composerState, status: "blocked", carets: [] },
]) {
  assert.equal(isComposerStateMessage(structuredClone(state)), true);
  assert.equal(isPreviewHostToWebviewMessage(structuredClone(state)), true);
}
for (const state of [
  { ...composerState, extra: true },
  { ...composerState, status: "idle" },
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
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { sequence: 4 }), { ...composerState, sequence: 2 }, 3), true);

const issuedKeys = new Set(["prior-render", renderKey]);
assert.equal(acceptsComposerIntent(composerMessage(replaceIntent, { renderKey: "prior-render" }), composerState, 0, issuedKeys), true, "published prior-frame typing was lost during own rerender");
assert.equal(acceptsComposerIntent(composerMessage(pointerIntent, { renderKey: "prior-render" }), composerState, 0, issuedKeys), false, "prior-frame pointer became writable");
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
console.log("preview webview protocol contract passed");
