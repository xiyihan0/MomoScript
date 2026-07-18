import assert from "node:assert/strict";
import { EditorRuntimeStatus } from "../src/runtimeStatus.ts";

const status = new EditorRuntimeStatus({
  backendVersion: "0.15.2",
  artifactDigest: "0123456789abcdef",
  positionEncoding: "utf-16",
});
const changes = [];
const subscription = status.onDidChange((snapshot) => changes.push(snapshot));

assert.deepEqual(status.snapshot(), {
  backendVersion: "0.15.2",
  artifactDigestPrefix: "0123456789ab",
  positionEncoding: "utf-16",
  recoveryState: "starting",
  generation: 0,
  queuedProjectCount: 0,
});
status.update({
  recoveryState: "recovering",
  generation: 3,
  queuedProjectCount: 2,
  lastFailure: "fixture restart",
});
assert.match(status.tooltip("Preview stale", 17, 4), /Tinymist 0\.15\.2 \(0123456789ab\)/);
assert.match(status.tooltip("Preview stale", 17, 4), /recovery recovering; generation 3; queued projects 2/);
assert.match(status.tooltip("Preview stale", 17, 4), /preview revision 17; diagnostics 4/);
assert.match(status.tooltip("Preview stale", 17, 4), /last runtime failure: fixture restart/);

status.update({ recoveryState: "ready", queuedProjectCount: 0 });
assert.equal(status.snapshot().lastFailure, undefined, "successful recovery retained stale failure text");
assert.equal(changes.length, 2);
assert.throws(() => status.update({ queuedProjectCount: -1 }), /non-negative safe integer/);
subscription.dispose();
status.update({ recoveryState: "stopped" });
assert.equal(changes.length, 2, "disposed listener observed another status transition");

console.log(JSON.stringify({ checked: true, identity: true, recovery: true, queue: true, tooltip: true }));
