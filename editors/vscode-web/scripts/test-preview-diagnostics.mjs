import assert from "node:assert/strict";
import { isCurrentPreviewUpdate, PreviewBuildState } from "../src/previewDiagnostics.ts";

const state = new PreviewBuildState();
const sourceUri = "mmtfs://workspace/story.mmt";
const older = { sourceUri, sourceVersion: 7, revision: 12 };
const current = { sourceUri, sourceVersion: 8, revision: 13 };
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
assert.equal(visibleStatus, "current WASM initialization");
visibleStatus = "waiting";

state.activate(older);
state.activate(current);

const publishFailure = (revision, phase, message) => {
  if (!state.fail(revision, phase, message)) return false;
  visibleStatus = `${phase}: ${message}`;
  return true;
};
const publishSuccess = (revision, output) => {
  if (!state.isCurrent(revision)) return false;
  visiblePreview = output;
  visibleStatus = "ready";
  return true;
};

assert.equal(publishFailure(older, "fetch", "late network error"), false);
assert.equal(publishSuccess(older, "stale SVG"), false);
assert.equal(visiblePreview, "initial", "a stale render success must not replace preview output");
assert.equal(visibleStatus, "waiting", "stale completion must not replace preview status");
assert.deepEqual(state.diagnostics(sourceUri), []);

assert.equal(publishFailure(current, "fetch", "HTTP 503"), true);
assert.equal(publishFailure(current, "decode", "invalid AVIFS frame"), true);
assert.equal(publishFailure(current, "render-layout", "SVG has no positive page size"), true);
assert.deepEqual(
  state.diagnostics(sourceUri).map(({ sourceVersion, revision, phase }) => ({ sourceVersion, revision, phase })),
  [
    { sourceVersion: 8, revision: 13, phase: "fetch" },
    { sourceVersion: 8, revision: 13, phase: "decode" },
    { sourceVersion: 8, revision: 13, phase: "render-layout" }
  ],
  "current failures must remain distinct and revision-bound"
);
assert.match(visibleStatus, /^render-layout:/);

const newest = { sourceUri, sourceVersion: 9, revision: 14 };
state.activate(newest);
assert.deepEqual(state.diagnostics(sourceUri), [], "a new revision starts with clean build diagnostics");
assert.equal(publishFailure(current, "decode", "late decoder rejection"), false);
assert.equal(publishSuccess(current, "late SVG"), false);
assert.equal(publishSuccess(newest, "current SVG"), true);
assert.equal(visiblePreview, "current SVG");
assert.equal(visibleStatus, "ready");

console.log(JSON.stringify({ phases: ["fetch", "decode", "render-layout"], staleInitializationStatusRejected: true, staleFailureRejected: true, staleSuccessRejected: true }));
