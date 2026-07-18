import assert from "node:assert/strict";
import { isCurrentPreviewUpdate, PreviewBuildState } from "../src/previewDiagnostics.ts";

const sourceUri = "mmtfs://workspace/story.mmt";
const identity = (sourceVersion, revision, incarnation = `document-${sourceVersion}`) => ({
  sourceUri,
  sourceVersion,
  revision,
  sourceContent: `source-content-${sourceVersion}`,
  sourceStaleToken: {
    hostUri: sourceUri,
    documentIncarnation: incarnation,
    documentVersion: sourceVersion,
  },
});
const older = identity(7, 12);
const current = identity(8, 13);
const published = [];
const cleared = [];
const state = new PreviewBuildState({
  replace(revision, diagnostics) {
    published.push({ revision, diagnostics: [...diagnostics] });
  },
  clear(uri) { cleared.push(uri); },
});
const snapshots = [];
state.subscribe((uri, snapshot) => snapshots.push({ uri, snapshot }));

let visiblePreview = "initial";
let visibleStatus = "waiting";
let controllerGeneration = 1;
const initializationStatus = (generation, message) => {
  if (!isCurrentPreviewUpdate(generation, controllerGeneration, false)) return false;
  visibleStatus = message;
  return true;
};
const oldInitialization = controllerGeneration;
controllerGeneration += 1;
assert.equal(initializationStatus(oldInitialization, "late WASM initialization"), false);
assert.equal(visibleStatus, "waiting", "stale initialization progress must not mutate visible preview status");
assert.equal(initializationStatus(controllerGeneration, "current WASM initialization"), true);
visibleStatus = "waiting";

state.activate(older);
state.activate(current);
assert.equal(state.snapshot(sourceUri).status, "rendering");

const publishFailure = (revision, phase, message, attribution) => {
  if (!state.fail(revision, phase, message, attribution)) return false;
  visibleStatus = `${phase}: ${message}`;
  return true;
};
const publishSuccess = (revision, output) => {
  if (!state.complete(revision)) return false;
  visiblePreview = output;
  visibleStatus = "ready";
  return true;
};

assert.equal(publishFailure(older, "fetch", "late network error"), false);
assert.equal(publishSuccess(older, "stale SVG"), false);
assert.equal(visiblePreview, "initial", "a stale render success must not replace preview output");
assert.equal(visibleStatus, "waiting", "stale completion must not replace preview status");
assert.deepEqual(state.diagnostics(sourceUri), []);

assert.equal(publishFailure(current, "fetch", "HTTP 503", {
  range: { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } },
  dependency: { kind: "image-dir", id: 3, packNamespace: "ba" },
}), true);
assert.equal(publishFailure(current, "decode", "invalid AVIFS frame"), true);
assert.equal(publishFailure(current, "layout", "SVG has no positive page size", { severity: "warning" }), true);
assert.deepEqual(
  state.diagnostics(sourceUri).map(({ sourceVersion, revision, phase, severity }) => ({ sourceVersion, revision, phase, severity })),
  [
    { sourceVersion: 8, revision: 13, phase: "fetch", severity: "error" },
    { sourceVersion: 8, revision: 13, phase: "decode", severity: "error" },
    { sourceVersion: 8, revision: 13, phase: "layout", severity: "warning" },
  ],
  "current failures must remain distinct, attributed, and revision-bound"
);
assert.equal(state.snapshot(sourceUri).status, "failed");
assert.equal(published.at(-1).diagnostics[0].dependency.packNamespace, "ba");

assert.equal(state.stale(sourceUri), true);
assert.equal(state.snapshot(sourceUri).status, "stale");
assert.deepEqual(state.diagnostics(sourceUri), []);
assert.equal(cleared.at(-1), sourceUri, "stale documents must clear durable Problems diagnostics");
assert.equal(publishFailure(current, "decode", "late decoder rejection"), false);
assert.equal(publishSuccess(current, "late SVG"), false);

const newest = identity(9, 14);
state.activate(newest);
assert.equal(state.snapshot(sourceUri).status, "rendering");
assert.equal(publishFailure(newest, "compiler", "recoverable warning", { severity: "warning" }), true);
assert.equal(publishSuccess(newest, "current SVG"), true);
assert.equal(state.snapshot(sourceUri).status, "ready");
assert.equal(visiblePreview, "current SVG");
assert.equal(visibleStatus, "ready");
assert.ok(snapshots.some(({ snapshot }) => snapshot.status === "stale"));
assert.ok(snapshots.some(({ snapshot }) => snapshot.status === "ready"));

console.log(JSON.stringify({
  phases: ["fetch", "decode", "layout", "compiler"],
  staleInitializationStatusRejected: true,
  staleFailureRejected: true,
  staleSuccessRejected: true,
  publisherClearedOnStale: true,
  statusTransitions: true,
}));
