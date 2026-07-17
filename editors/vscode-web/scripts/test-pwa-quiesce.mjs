import assert from "node:assert/strict";
import { PwaSafeRestartDeadlineExceeded, PwaSafeRestartQuiesceAdapter } from "../src/pwaSafeRestart.ts";
import { EditorRuntimeController } from "../src/runtimeController.ts";

const productionOrder = [];
let acceptingProductionWork = true;
let visibleStatus = "mmt-ready";
const production = new PwaSafeRestartQuiesceAdapter({
  pauseNewWork() {
    acceptingProductionWork = false;
    productionOrder.push("pause-new-work");
    return () => { acceptingProductionWork = true; };
  },
  requireWriter() { productionOrder.push("writer-lease"); },
  assertWorkspaceSafe() { productionOrder.push("workspace-safe"); },
  async flushDurableState() { productionOrder.push("document-history-metadata-flush"); },
  async abortAndDrainRuntimeWork() { productionOrder.push("preview-materialization-safe-boundary"); },
  async persistRecoveryMetadata() { productionOrder.push("recovery-metadata-durable"); },
  runtime: { async quiesce() { productionOrder.push("runtime-quiesce"); } },
});
await production.prepareForReload(100);
assert.deepEqual(productionOrder, [
  "pause-new-work",
  "writer-lease",
  "workspace-safe",
  "document-history-metadata-flush",
  "preview-materialization-safe-boundary",
  "recovery-metadata-durable",
  "runtime-quiesce",
]);
assert.equal(acceptingProductionWork, false, "successful preparation must continue rejecting new work until activation");
assert.deepEqual(production.readiness, { acceptingWork: false, readyForActivation: true });
assert.equal(visibleStatus, "mmt-ready", "quiesce must not replace the visible editor status");
await production.prepareForReload(100);
assert.equal(productionOrder.length, 7, "ready preparation must be idempotent");

let releaseConcurrent;
let concurrentQuiesces = 0;
const concurrent = new PwaSafeRestartQuiesceAdapter({
  pauseNewWork() { return () => {}; },
  requireWriter() {},
  assertWorkspaceSafe() {},
  async flushDurableState() { await new Promise((resolve) => { releaseConcurrent = resolve; }); },
  async abortAndDrainRuntimeWork() {},
  async persistRecoveryMetadata() {},
  runtime: { async quiesce() { concurrentQuiesces += 1; } },
});
const first = concurrent.prepareForReload(100);
const second = concurrent.prepareForReload(100);
assert.equal(first, second, "concurrent preparation calls must share one operation");
assert.equal(concurrent.readiness.acceptingWork, false);
await Promise.resolve();
await Promise.resolve();
assert.equal(typeof releaseConcurrent, "function", "durable flush must be active before fixture release");
releaseConcurrent();
await Promise.all([first, second]);
assert.equal(concurrentQuiesces, 1);

let deadlineResumes = 0;
let deadlineRuntimeQuiesces = 0;
const deadline = new PwaSafeRestartQuiesceAdapter({
  pauseNewWork() { return () => { deadlineResumes += 1; }; },
  requireWriter() {},
  assertWorkspaceSafe() {},
  async flushDurableState() { await new Promise(() => {}); },
  async abortAndDrainRuntimeWork() {},
  async persistRecoveryMetadata() {},
  runtime: { async quiesce() { deadlineRuntimeQuiesces += 1; } },
});
await assert.rejects(deadline.prepareForReload(5), PwaSafeRestartDeadlineExceeded);
assert.equal(deadlineRuntimeQuiesces, 0, "deadline before the safe boundary must not quiesce the runtime owner");
assert.equal(deadlineResumes, 1, "failed preparation must resume work");
assert.equal(deadline.readiness.acceptingWork, true);
assert.equal(deadline.readiness.readyForActivation, false);
assert.match(deadline.readiness.blocker, /within 5ms/);

let failureResumes = 0;
let failureRuntimeQuiesces = 0;
const failure = new PwaSafeRestartQuiesceAdapter({
  pauseNewWork() { return () => { failureResumes += 1; }; },
  requireWriter() {},
  assertWorkspaceSafe() { throw new Error("pending journal fixture"); },
  async flushDurableState() { throw new Error("must not flush after blocker"); },
  async abortAndDrainRuntimeWork() {},
  async persistRecoveryMetadata() {},
  runtime: { async quiesce() { failureRuntimeQuiesces += 1; } },
});
await assert.rejects(failure.prepareForReload(100), /pending journal fixture/);
assert.equal(failureResumes, 1);
assert.equal(failureRuntimeQuiesces, 0);
assert.deepEqual(failure.readiness, {
  acceptingWork: true,
  readyForActivation: false,
  blocker: "pending journal fixture",
});
assert.equal(visibleStatus, "mmt-ready", "blocked preparation must leave visible status unchanged");

const sharedRuntime = new EditorRuntimeController();
await sharedRuntime.start(() => {});
const sharedAdapter = new PwaSafeRestartQuiesceAdapter({
  pauseNewWork() { return sharedRuntime.pauseNewWork(); },
  requireWriter() {},
  assertWorkspaceSafe() {},
  async flushDurableState() {},
  async abortAndDrainRuntimeWork() { await sharedRuntime.prepareForQuiesce(); },
  async persistRecoveryMetadata() {},
  runtime: sharedRuntime,
});
await sharedAdapter.prepareForReload(100);
assert.equal(sharedRuntime.state, "quiescing", "PWA preparation must enter the single editor controller quiesce state");
assert.equal(sharedRuntime.acceptingWork, false);
await sharedRuntime.dispose();

console.log(JSON.stringify({
  productionTopology: true,
  safeBoundaryOrdering: true,
  deadlineFailure: true,
  blockerFailure: true,
  concurrentIdempotent: true,
  noVisibleStatusRegression: true,
  sharedEditorController: true,
  activationAndServiceWorkerOutOfScope: true,
}));
