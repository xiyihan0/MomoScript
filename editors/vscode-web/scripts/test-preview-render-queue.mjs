import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { LatestPreviewRenderQueue } from "../src/previewRenderQueue.ts";

const sourceUri = "mmtfs://workspace/story.mmt";
const token = (revision) => ({
  entryUri: `untitled:/mmt-projection/session/${revision}/main.typ`,
  session: "session",
  sourceVersion: revision,
  revision,
});
const previewRequest = (revision, kind = "typing") => ({
  sourceUri,
  token: token(revision),
  kind,
  traceId: `trace-${revision}`,
});

const debounceQueue = new LatestPreviewRenderQueue(32);
const debounceRuns = [];
debounceQueue.enqueuePreview(previewRequest(1), async (request) => { debounceRuns.push(request.sequence); });
const newestDebounceSequence = debounceQueue.enqueuePreview(previewRequest(2), async (request) => { debounceRuns.push(request.sequence); });
await delay(80);
await Promise.allSettled(debounceQueue.pending());
assert.deepEqual(debounceRuns, [newestDebounceSequence], "only the newest debounced typing request may run");
debounceQueue.dispose();

const manualQueue = new LatestPreviewRenderQueue(32);
const releaseManual = Promise.withResolvers();
const manualEvents = [];
const manualSequence = manualQueue.enqueuePreview(previewRequest(3, "manual-render"), async (request, signal) => {
  manualEvents.push(`manual:${request.sequence}:start`);
  await releaseManual.promise;
  assert.equal(signal.aborted, false, "later typing must not cancel an active manual render");
  manualEvents.push(`manual:${request.sequence}:end`);
});
await delay(0);
const typingAfterManual = manualQueue.enqueuePreview(previewRequest(4), async (request) => {
  manualEvents.push(`typing:${request.sequence}`);
});
await delay(50);
assert.deepEqual(manualEvents, [`manual:${manualSequence}:start`]);
releaseManual.resolve();
await delay(80);
await Promise.allSettled(manualQueue.pending());
assert.deepEqual(manualEvents, [
  `manual:${manualSequence}:start`,
  `manual:${manualSequence}:end`,
  `typing:${typingAfterManual}`,
]);
manualQueue.dispose();

const supersedeQueue = new LatestPreviewRenderQueue(32);
let typingAborted = false;
supersedeQueue.enqueuePreview(previewRequest(5), async (_request, signal) => {
  const aborted = Promise.withResolvers();
  signal.addEventListener("abort", aborted.resolve, { once: true });
  await aborted.promise;
  typingAborted = true;
});
await delay(50);
let manualRan = false;
supersedeQueue.enqueuePreview(previewRequest(6, "manual-render"), async () => { manualRan = true; });
await delay(20);
await Promise.allSettled(supersedeQueue.pending());
assert.equal(typingAborted, true);
assert.equal(manualRan, true);
supersedeQueue.dispose();

const isolatedQueue = new LatestPreviewRenderQueue(32);
const releaseExport = Promise.withResolvers();
let exportAborted = false;
isolatedQueue.enqueueExport({ sourceUri, renderKey: "render-1", traceId: "export-1" }, async (_request, signal) => {
  signal.addEventListener("abort", () => { exportAborted = true; }, { once: true });
  await releaseExport.promise;
});
await delay(0);
isolatedQueue.enqueuePreview(previewRequest(7, "manual-render"), async () => undefined);
await delay(20);
assert.equal(exportAborted, false, "preview work must not cancel exact export work");
isolatedQueue.enqueueExport({ sourceUri, renderKey: "render-2", traceId: "export-2" }, async () => undefined);
await delay(0);
assert.equal(exportAborted, true, "a newer export must supersede the older export");
releaseExport.resolve();
await delay(20);
await Promise.allSettled(isolatedQueue.pending());
isolatedQueue.dispose();

console.log(JSON.stringify({
  debouncedLatestWins: true,
  manualPriority: true,
  typingCancellation: true,
  exportIsolation: true,
}));
