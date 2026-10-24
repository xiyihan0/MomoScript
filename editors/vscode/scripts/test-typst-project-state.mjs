import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = await build({
  stdin: {
    contents: "export * from './typstProjectState.ts'; export { isRenderPreset, parseRenderPreset } from './tinymistClient.ts';",
    resolveDir: path.join(root, "src"),
    sourcefile: "render-project-state-fixture.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent"
});
const source = result.outputFiles[0].text;
const {
  applyRenderProjectUpdate,
  isRenderPreset,
  parseRenderPreset,
  RenderProjectSnapshotStore,
  TypstProjectState,
  TypstProjectInvariantError
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

for (const preset of [
  { kind: "output" },
  { kind: "chat", widthPt: 240 },
  { kind: "chat", widthPt: 390 },
  { widthPt: 720, kind: "chat" }
]) {
  assert.equal(isRenderPreset(preset), true);
  assert.deepEqual(parseRenderPreset(preset), preset);
}
for (const preset of [
  undefined, null, false, "output", [], {},
  { kind: "unknown" },
  { kind: "output", widthPt: 390 },
  { kind: "output", extra: true },
  { kind: "chat" },
  { kind: "chat", widthPt: "390" },
  { kind: "chat", widthPt: 239 },
  { kind: "chat", widthPt: 721 },
  { kind: "chat", widthPt: 390.5 },
  { kind: "chat", widthPt: NaN },
  { kind: "chat", widthPt: Infinity },
  { kind: "chat", widthPt: 390, extra: true },
  { kind: "chat", width_pt: 390 },
  { kind: "Chat", widthPt: 390 }
]) {
  assert.equal(isRenderPreset(preset), false);
  assert.throws(() => parseRenderPreset(preset), /Invalid render preset/);
}

function fileDigest(text) {
  const hash = createHash("sha256");
  for (const field of [Buffer.from("mmt-project-file-v1"), Buffer.from(text)]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.byteLength));
    hash.update(length);
    hash.update(field);
  }
  return hash.digest("hex");
}

const renderHelper = {
  uri: "untitled:/render/a/helper.typ",
  text: "#let value = 1",
  digest: fileDigest("#let value = 1")
};
const renderEntry1 = {
  uri: "untitled:/render/a/main-1.typ",
  text: "#value",
  digest: fileDigest("#value")
};
const renderBase = await applyRenderProjectUpdate(undefined, {
  sourceUri: "logical-source:render",
  renderPreset: { kind: "output" },
  sourceVersion: 1,
  revision: 1,
  entryUri: renderEntry1.uri,
  full: true,
  files: [renderHelper, renderEntry1],
  projectDigest: "project-1"
});
const renderEntry2 = {
  uri: "untitled:/render/a/main-2.typ",
  text: "#value + 1",
  digest: fileDigest("#value + 1")
};
const renderNext = await applyRenderProjectUpdate(renderBase, {
  ...renderBase,
  sourceVersion: 2,
  revision: 2,
  entryUri: renderEntry2.uri,
  full: false,
  files: [renderEntry2],
  baseRevision: 1,
  baseProjectDigest: "project-1",
  deletedUris: [renderEntry1.uri],
  projectDigest: "project-2"
});
assert.deepEqual(renderNext.files.map((file) => file.uri).sort(), [renderEntry2.uri, renderHelper.uri].sort());
await assert.rejects(
  applyRenderProjectUpdate(renderBase, {
    ...renderNext,
    revision: 3,
    full: false,
    files: [{ ...renderEntry2, text: "#corrupted" }],
    baseRevision: 1,
    baseProjectDigest: "project-1"
  }),
  /failed content digest validation/
);
await assert.rejects(
  applyRenderProjectUpdate(renderBase, {
    ...renderNext,
    renderPreset: { kind: "chat", widthPt: 390 },
    full: false,
    files: [renderEntry2],
    baseRevision: 1,
    baseProjectDigest: "project-1"
  }),
  /base identity does not match/
);
const { renderPreset: omittedRenderPreset, ...missingRenderPreset } = renderBase;
await assert.rejects(
  applyRenderProjectUpdate(undefined, missingRenderPreset),
  /Invalid render preset/
);

const renderSnapshots = new RenderProjectSnapshotStore();
assert.equal((await renderSnapshots.accept(renderBase)).advanced, true);
assert.equal((await renderSnapshots.accept(renderBase)).advanced, false);
assert.equal((await renderSnapshots.accept(renderNext)).advanced, true);
assert.equal(renderSnapshots.get(renderBase.sourceUri)?.projectDigest, "project-2");
const renderChat = {
  ...renderBase,
  renderPreset: { kind: "chat", widthPt: 390 },
  projectDigest: "chat-390"
};
const renderChatWide = {
  ...renderBase,
  renderPreset: { kind: "chat", widthPt: 720 },
  projectDigest: "chat-720"
};
assert.equal((await renderSnapshots.accept(renderChat)).advanced, true);
assert.equal((await renderSnapshots.accept(renderChatWide)).advanced, true);
assert.equal(renderSnapshots.get(renderBase.sourceUri)?.projectDigest, "project-2");
assert.equal(renderSnapshots.get(renderBase.sourceUri, { kind: "output" })?.projectDigest, "project-2");
assert.equal(renderSnapshots.get(renderBase.sourceUri, { kind: "chat", widthPt: 390 })?.projectDigest, "chat-390");
assert.equal(renderSnapshots.get(renderBase.sourceUri, { kind: "chat", widthPt: 720 })?.projectDigest, "chat-720");
assert.equal((await renderSnapshots.accept(renderChat)).advanced, false);
await assert.rejects(
  renderSnapshots.accept({ ...renderChat, renderPreset: { kind: "chat", widthPt: 390, extra: true } }),
  /Invalid render preset/
);
await assert.rejects(
  renderSnapshots.accept({
    ...renderNext,
    renderPreset: { kind: "chat", widthPt: 390 },
    full: false,
    files: [renderEntry2],
    baseRevision: 1,
    baseProjectDigest: "project-1"
  }),
  /base identity does not match/
);
await assert.rejects(
  renderSnapshots.accept(renderBase),
  /does not advance the accepted snapshot/
);
renderSnapshots.close(renderBase.sourceUri);
assert.equal(renderSnapshots.get(renderBase.sourceUri), undefined);
assert.equal(renderSnapshots.get(renderBase.sourceUri, { kind: "chat", widthPt: 390 }), undefined);
assert.equal(renderSnapshots.get(renderBase.sourceUri, { kind: "chat", widthPt: 720 }), undefined);

const notifications = [];
const events = [];
const requests = [];
const held = new Set();
const port = {
  request(method, params, signal) {
    requests.push(structuredClone({ method, params }));
    if (method === "textDocument/foldingRange") return Promise.resolve(null);
    if (method !== "fixture/hold") return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const heldRequest = { resolve, reject };
      held.add(heldRequest);
      const abort = () => {
        held.delete(heldRequest);
        reject(signal?.reason ?? new Error("cancelled"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  },
  notify(method, params) {
    notifications.push(structuredClone({ method, params }));
  },
  emit(method, params) {
    events.push(structuredClone({ method, params }));
  }
};

const state = new TypstProjectState(port, {
  closeGraceMs: 1,
  primeDebounceMs: 0,
  limits: { maxProjects: 2, maxRequests: 1, maxPrimes: 2, maxCloses: 4, maxReplay: 2 }
});
await state.activateBackend(1);
const sourceUri = "logical-source:shared-state";
const sessionA = "untitled:/shared-state/a";
const sessionB = "untitled:/shared-state/b";
const helper = `${sessionA}/helper.typ`;
const entryA1 = `${sessionA}/main-1.typ`;
const entryA2 = `${sessionA}/main-2.typ`;
const entryB = `${sessionB}/main-1.typ`;
const full = {
  sourceUri,
  sourceVersion: 1,
  revision: 1,
  entryUri: entryA1,
  full: true,
  files: [
    { uri: helper, text: "#let value = 1" },
    { uri: entryA1, text: "#value" }
  ]
};
assert.equal(state.syncProject(full).accepted, true);
assert.equal(state.queuedProjectCount(), 1, "complete project was not queued for priming");
assert.equal(state.syncProject({ ...full, revision: 2, entryUri: entryA2, full: false, files: [
  { uri: entryA2, text: "#let value = 2\n#value" }
] }).accepted, true);
assert.equal(state.projectForEntry(entryA1), undefined);
assert.equal(state.projectForEntry(entryA2).files.length, 2);
const duplicate = state.syncProject({ ...full, revision: 2, entryUri: entryA2, full: false, files: [] });
assert.equal(duplicate.accepted, false);
assert.equal(duplicate.error.code, "NonIncreasingRevision");
const unknown = state.syncProject({ ...full, entryUri: entryB, full: false, files: [{ uri: entryB, text: "" }] });
assert.equal(unknown.accepted, false);
assert.equal(unknown.error.code, "UnknownSessionDelta");
assert.equal(state.syncProject({ ...full, entryUri: entryB, full: true, files: [{ uri: entryB, text: "#let current = true" }] }).accepted, true);
assert.equal(state.queuedProjectCount(), 1, "same logical source was counted more than once");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(state.queuedProjectCount(), 0, "in-flight prime was still reported as queued");
assert.ok(events.some((item) => item.method === "tinymist/projectPrimeStarted"), "queue-to-in-flight transition was not published");
const primeRequestCount = requests.filter((item) => item.method === "textDocument/foldingRange").length;
await state.ensureProjectReady(entryB);
assert.equal(
  requests.filter((item) => item.method === "textDocument/foldingRange").length,
  primeRequestCount + 1,
  "explicit readiness did not re-prime an accepted compiler project"
);
const retired = state.syncProject({ ...full, revision: 99, entryUri: entryA2, full: true, files: [] });
assert.equal(retired.accepted, false);
assert.equal(retired.error.code, "RetiredSession");

const defaultCancellation = new AbortController();
defaultCancellation.abort();
await assert.rejects(
  state.request("fixture/hold", {}, defaultCancellation.signal),
  (error) => error instanceof TypstProjectInvariantError
    && error.code === "Cancelled"
    && error.message === "Tinymist request cancelled"
);
assert.equal(held.size, 0);

const cancellation = new AbortController();
const firstRequest = state.request("fixture/hold", {}, cancellation.signal);
await Promise.resolve();
await assert.rejects(
  state.request("fixture/hold", {}),
  (error) => error instanceof TypstProjectInvariantError && error.code === "RequestQueueFull"
);
const customCancellation = new Error("fixture cancellation");
cancellation.abort(customCancellation);
await assert.rejects(firstRequest, (error) => error === customCancellation);
assert.equal(held.size, 0);

notifications.length = 0;
state.deactivateBackend(1, new Error("fixture restart"));
assert.equal(state.queuedProjectCount(), 0, "backend deactivation left queued prime work behind");
await state.activateBackend(2);
assert.equal(state.backendGeneration(), 2);
const replayOpens = notifications
  .filter((item) => item.method === "textDocument/didOpen")
  .map((item) => item.params.textDocument.uri);
assert.deepEqual(replayOpens, [entryB], "restart replayed anything except the newest complete session");
await assert.rejects(
  state.activateBackend(2),
  (error) => error instanceof TypstProjectInvariantError && error.code === "StaleBackendGeneration"
);
const coalescedRequests = [];
const coalescedPort = {
  request(method, params) {
    coalescedRequests.push(structuredClone({ method, params }));
    return Promise.resolve(null);
  },
  notify() {},
  emit() {}
};
const coalescedState = new TypstProjectState(coalescedPort, {
  closeGraceMs: 1,
  primeDebounceMs: 0,
  limits: { maxProjects: 1, maxRequests: 1, maxPrimes: 1, maxCloses: 2, maxReplay: 1 }
});
await coalescedState.activateBackend(1);
const coalescedSourceUri = "logical-source:coalesced-prime";
const coalescedEntryUri = "untitled:/coalesced-prime/main.typ";
const coalescedProject = {
  sourceUri: coalescedSourceUri,
  sourceVersion: 1,
  revision: 1,
  entryUri: coalescedEntryUri,
  full: true,
  files: [{ uri: coalescedEntryUri, text: "= first" }]
};
assert.equal(coalescedState.syncProject(coalescedProject).accepted, true);
const coalescedFeature = coalescedState.request("fixture/read", { textDocument: { uri: coalescedEntryUri } });
assert.equal(coalescedState.syncProject({
  ...coalescedProject,
  sourceVersion: 2,
  revision: 2,
  files: [{ uri: coalescedEntryUri, text: "= second" }]
}).accepted, true);
await coalescedFeature;
assert.equal(
  coalescedRequests.filter((item) => item.method === "fixture/read").length,
  1,
  "same-entry prime coalescing rejected a current feature request"
);
coalescedState.dispose();
const supersededRequests = [];
const supersededState = new TypstProjectState({
  request(method, params) {
    supersededRequests.push(structuredClone({ method, params }));
    return Promise.resolve(null);
  },
  notify() {},
  emit() {}
}, {
  closeGraceMs: 1,
  primeDebounceMs: 0,
  limits: { maxProjects: 1, maxRequests: 1, maxPrimes: 1, maxCloses: 2, maxReplay: 1 }
});
await supersededState.activateBackend(1);
const supersededSourceUri = "logical-source:superseded-prime";
const supersededEntryUri = "untitled:/superseded-prime/main-1.typ";
const replacementEntryUri = "untitled:/superseded-prime/main-2.typ";
const supersededProject = {
  sourceUri: supersededSourceUri,
  sourceVersion: 1,
  revision: 1,
  entryUri: supersededEntryUri,
  full: true,
  files: [{ uri: supersededEntryUri, text: "= stale" }]
};
assert.equal(supersededState.syncProject(supersededProject).accepted, true);
const supersededFeature = supersededState.request("fixture/read", { textDocument: { uri: supersededEntryUri } });
assert.equal(supersededState.syncProject({
  ...supersededProject,
  sourceVersion: 2,
  revision: 2,
  entryUri: replacementEntryUri,
  files: [{ uri: replacementEntryUri, text: "= current" }]
}).accepted, true);
await assert.rejects(supersededFeature, /projection prime superseded/);
assert.equal(
  supersededRequests.filter((item) => item.method === "fixture/read").length,
  0,
  "different-entry prime supersession dispatched a stale feature request"
);
supersededState.dispose();
state.dispose();
assert.ok(events.some((item) => item.method === "tinymist/projectRejected"));
console.log(JSON.stringify({ checked: true, generation: 2, replay: replayOpens, boundedRequests: true, queuedProjectCount: true, queueTransitions: true }));
