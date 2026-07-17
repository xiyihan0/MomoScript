import assert from "node:assert/strict";
import { RuntimeOwner, disposeWithFallback, terminateOnUnload } from "../src/runtimeOwner.ts";

const order = [];
const owner = new RuntimeOwner();
owner.add({ async dispose() { order.push("first:start"); await new Promise((resolve) => setTimeout(resolve, 5)); order.push("first:end"); } });
owner.add({ async dispose() { order.push("second:start"); await new Promise((resolve) => setTimeout(resolve, 5)); order.push("second:end"); } });
owner.add({ dispose() { order.push("third"); throw new Error("injected rollback failure"); } });
owner.ready();
await owner.dispose(1_000);
assert.deepEqual(order, ["third", "second:start", "second:end", "first:start", "first:end"], "resources must dispose sequentially in reverse registration order and continue after failure");
assert.equal(owner.state, "disposed");
await owner.dispose();
assert.equal(order.length, 5, "dispose must be idempotent");

const concurrent = new RuntimeOwner();
let releaseConcurrent;
let concurrentFinished = false;
concurrent.add({ async dispose() { await new Promise((resolve) => { releaseConcurrent = resolve; }); concurrentFinished = true; } });
const firstDispose = concurrent.dispose(1_000);
const secondDispose = concurrent.dispose(1_000);
assert.equal(firstDispose, secondDispose, "concurrent dispose calls must share one lifecycle promise");
await Promise.resolve();
assert.equal(concurrent.state, "quiescing");
assert.throws(() => concurrent.add({ dispose() {} }), /quiescing/, "resources cannot be added while disposal is active");
releaseConcurrent();
await Promise.all([firstDispose, secondDispose]);
assert.equal(concurrentFinished, true);
assert.equal(concurrent.state, "disposed");

const rollback = new RuntimeOwner();
const rollbackOrder = [];
rollback.add({ dispose() { rollbackOrder.push("foundation"); } });
rollback.add({ async dispose() { await Promise.resolve(); rollbackOrder.push("dependent"); } });
await rollback.dispose();
assert.deepEqual(rollbackOrder, ["dependent", "foundation"], "startup failure must roll back acquired resources");

const startupFailure = new RuntimeOwner();
const startupRollback = [];
try {
  startupFailure.add({ dispose() { startupRollback.push("workspace"); } });
  startupFailure.add({ async dispose() { await Promise.resolve(); startupRollback.push("worker"); } });
  throw new Error("injected mid-start failure");
} catch {
  await startupFailure.dispose();
}
assert.deepEqual(startupRollback, ["worker", "workspace"], "mid-start failure must roll back every acquired resource in reverse order");

const productionTopology = new RuntimeOwner();
const productionOrder = [];
const productionOwn = (name) => productionTopology.add({ dispose() { productionOrder.push(name); } });
productionOwn("layout");
productionOwn("view");
productionOwn("subscription");
productionOwn("tinymist");
productionOwn("mmt");
try { throw new Error("injected production mid-start failure"); } catch { await productionTopology.dispose(); }
assert.deepEqual(productionOrder, ["mmt", "tinymist", "subscription", "view", "layout"], "production resources must roll back in global acquisition order");

let terminated = 0;
let release;
const unload = terminateOnUnload({ terminate() { terminated += 1; } }, () => new Promise((resolve) => { release = resolve; }), 5);
unload();
unload();
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(terminated, 1, "unload fallback must synchronously terminate once after graceful deadline");

let hmrTerminated = 0;
await disposeWithFallback(() => new Promise((resolve) => setTimeout(resolve, 2)), () => { hmrTerminated += 1; }, 20);
assert.equal(hmrTerminated, 0, "HMR graceful disposal should not terminate when it meets the deadline");
await disposeWithFallback(() => new Promise(() => {}), () => { hmrTerminated += 1; }, 5);
assert.equal(hmrTerminated, 1, "HMR should terminate when graceful disposal misses the deadline");
await disposeWithFallback(async () => { throw new Error("injected dispose failure"); }, () => { hmrTerminated += 1; }, 20);
assert.equal(hmrTerminated, 2, "HMR should terminate and resolve when graceful disposal rejects");
release();

console.log(JSON.stringify({ reverseSequential: true, rollbackAfterFailure: true, midStartRollback: true, productionTopologyRollback: true, concurrentIdempotent: true, rejectDuringQuiesce: true, idempotent: true, unloadImmediateTerminate: true, hmrDeadlineFallback: true, hmrRejectFallback: true }));
