import assert from "node:assert/strict";
import { EditorRuntimeController } from "../src/runtimeController.ts";

let releaseStartup;
let secondaryInitializerCalls = 0;
const serialized = new EditorRuntimeController();
const firstStartup = serialized.start(async (runtime) => {
  runtime.own({ dispose() {} });
  await new Promise((resolve) => { releaseStartup = resolve; });
});
const secondStartup = serialized.start(() => { secondaryInitializerCalls += 1; });
assert.equal(firstStartup, secondStartup, "concurrent startup must share one operation");
assert.equal(serialized.state, "starting");
releaseStartup();
await firstStartup;
assert.equal(serialized.state, "ready");
assert.equal(secondaryInitializerCalls, 0, "only the first initializer may construct the runtime");
await serialized.dispose();

const startupRollbackOrder = [];
const failedStartup = new EditorRuntimeController();
await assert.rejects(failedStartup.start((runtime) => {
  runtime.own({ dispose() { startupRollbackOrder.push("workspace"); } });
  runtime.subscribe({ async dispose() { await Promise.resolve(); startupRollbackOrder.push("documents"); } });
  runtime.own({ dispose() { startupRollbackOrder.push("language-worker"); } });
  throw new Error("injected startup failure");
}), /injected startup failure/);
assert.deepEqual(startupRollbackOrder, ["language-worker", "documents", "workspace"]);
assert.equal(failedStartup.state, "disposed");
let startupDeadlineTerminations = 0;
const startupDeadline = new EditorRuntimeController({ disposeDeadlineMs: 5 });
await assert.rejects(startupDeadline.start((runtime) => {
  runtime.registerTermination(() => { startupDeadlineTerminations += 1; });
  runtime.own({ async dispose() { await new Promise(() => {}); } });
  throw new Error("injected startup deadline failure");
}), /injected startup deadline failure/);
assert.equal(startupDeadlineTerminations, 1, "startup rollback must terminate a child that misses the deadline");
assert.equal(startupDeadline.state, "disposed");


const reverseDisposeOrder = [];
const reverseDispose = new EditorRuntimeController();
await reverseDispose.start((runtime) => {
  runtime.own({ dispose() { reverseDisposeOrder.push("foundation"); } });
  runtime.subscribe({ dispose() { reverseDisposeOrder.push("project-subscription"); } });
  runtime.own({ async dispose() { await Promise.resolve(); reverseDisposeOrder.push("preview"); } });
});
await reverseDispose.dispose();
assert.deepEqual(reverseDisposeOrder, ["preview", "project-subscription", "foundation"]);

const rejectedQuiesce = new EditorRuntimeController();
await rejectedQuiesce.start(() => {});
rejectedQuiesce.stores.persistenceByUri.set("mmtfs://workspace/story.mmt", Promise.reject(new Error("durable write rejected")));
await assert.rejects(rejectedQuiesce.quiesce(), /durable write rejected/);
assert.equal(rejectedQuiesce.state, "ready", "rejected barriers must leave the runtime retryable");
assert.equal(rejectedQuiesce.acceptingWork, true, "rejected quiesce must resume work admission");
rejectedQuiesce.stores.persistenceByUri.clear();
await rejectedQuiesce.quiesce();
assert.equal(rejectedQuiesce.state, "quiescing");
assert.equal(rejectedQuiesce.acceptingWork, false);
await rejectedQuiesce.dispose();

let deadlineTerminations = 0;
let deadlineFallbacks = 0;
const deadline = new EditorRuntimeController({ disposeDeadlineMs: 5 });
await deadline.start((runtime) => {
  runtime.registerTermination(() => { deadlineTerminations += 1; });
  runtime.own({ async dispose() { await new Promise(() => {}); } });
});
await deadline.dispose(5, () => { deadlineFallbacks += 1; });
assert.equal(deadlineTerminations, 1, "a missed graceful deadline must synchronously invoke termination fallback");
assert.equal(deadlineFallbacks, 1);
assert.equal(deadline.state, "disposed");
deadline.terminate();
assert.equal(deadlineTerminations, 1, "termination fallback must be idempotent");

let unloadTerminations = 0;
const unload = new EditorRuntimeController();
await unload.start((runtime) => {
  runtime.registerTermination(() => { unloadTerminations += 1; });
  runtime.own({ async dispose() { await Promise.resolve(); } });
});
unload.terminateAndDispose();
assert.equal(unloadTerminations, 1, "unload must terminate synchronously before returning");
await unload.dispose();
unload.terminateAndDispose();
assert.equal(unloadTerminations, 1);

const stores = new EditorRuntimeController({ captureAcceptedPreviewProjects: true });
await stores.start(() => {});
const controller = new AbortController();
stores.stores.materializationControllers.set("source", controller);
stores.stores.latestProjectBySource.set("source", { session: "s", sourceVersion: 1, revision: 2 });
stores.stores.retiredProjectSessions.set("source", new Set(["old"]));
stores.stores.renderRequestIdBySource.set("source", 3);
stores.stores.closeSource("source");
assert.equal(controller.signal.aborted, true);
assert.equal(stores.stores.latestProjectBySource.has("source"), false);
assert.equal(stores.stores.retiredProjectSessions.has("source"), false);
assert.equal(stores.stores.renderRequestIdBySource.has("source"), false);
await stores.dispose();

let originOpenCalls = 0;
let originDisposeCalls = 0;
const registeredInventory = [];
const fakeOriginCoordinator = {
  async register(entry) { registeredInventory.push(entry); },
  async commit() { throw new Error("not exercised"); },
  async reserveWithReclamation() { throw new Error("not exercised"); },
  close() { originDisposeCalls += 1; },
  dispose() { this.close(); },
};
const storageRuntime = new EditorRuntimeController();
let packageCacheStorage;
await storageRuntime.start(async (runtime) => {
  const open = async () => {
    originOpenCalls += 1;
    await Promise.resolve();
    return fakeOriginCoordinator;
  };
  const first = runtime.initializeOriginStorage(open);
  const second = runtime.initializeOriginStorage(open);
  const [firstStore, secondStore] = await Promise.all([first, second]);
  assert.equal(firstStore, secondStore, "one runtime must open and own one origin/package cache store");
  assert.equal(runtime.originStorage, fakeOriginCoordinator);
  assert.equal(runtime.packageCacheStorage, firstStore);
  packageCacheStorage = firstStore;
  await firstStore.registerExisting({
    generationId: "preview/runtime-owned@1.0.0#digest",
    bytes: 4,
    evictBytes() {},
    invalidateDependents() {},
  });
});
assert.equal(originOpenCalls, 1, "concurrent initialization must share one origin storage open");
assert.equal(registeredInventory[0].class, "typst-package-cache");
await storageRuntime.dispose();
assert.equal(originDisposeCalls, 1, "the runtime controller must dispose its origin coordinator exactly once");
await assert.rejects(packageCacheStorage.registerExisting({
  generationId: "preview/after-dispose@1.0.0#digest",
  bytes: 1,
  evictBytes() {},
  invalidateDependents() {},
}), /disposed/, "the package cache store must share the runtime lifecycle");

console.log(JSON.stringify({
  serializedStartup: true,
  reverseStartupRollback: true,
  startupDeadlineFallback: true,
  reverseDispose: true,
  quiesceRejectionRecovery: true,
  gracefulDeadlineFallback: true,
  unloadImmediateTermination: true,
  controllerOwnedTypedStores: true,
  originPackageStorageOwnership: true,
}));
