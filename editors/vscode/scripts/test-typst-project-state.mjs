import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = await build({
  entryPoints: [path.join(root, "src/typstProjectState.ts")],
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
  RenderProjectSnapshotStore,
  TypstProjectState,
  TypstProjectInvariantError
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

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

const renderSnapshots = new RenderProjectSnapshotStore();
assert.equal((await renderSnapshots.accept(renderBase)).advanced, true);
assert.equal((await renderSnapshots.accept(renderBase)).advanced, false);
assert.equal((await renderSnapshots.accept(renderNext)).advanced, true);
assert.equal(renderSnapshots.get(renderBase.sourceUri)?.projectDigest, "project-2");
await assert.rejects(
  renderSnapshots.accept(renderBase),
  /does not advance the accepted snapshot/
);
renderSnapshots.close(renderBase.sourceUri);
assert.equal(renderSnapshots.get(renderBase.sourceUri), undefined);

const notifications = [];
const events = [];
const held = new Set();
const port = {
  request(method, _params, signal) {
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
state.dispose();
assert.ok(events.some((item) => item.method === "tinymist/projectRejected"));
console.log(JSON.stringify({ checked: true, generation: 2, replay: replayOpens, boundedRequests: true, queuedProjectCount: true, queueTransitions: true }));
