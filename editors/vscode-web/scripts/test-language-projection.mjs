import assert from "node:assert/strict";
import { advanceLanguageProjection, RevisionPinnedPreviewClock, waitForSynchronizedLanguageProjection } from "../src/languageProjection.ts";

const latest = new Map();
const retired = new Map();
const sourceUri = "mmtfs://workspace/story.mmt";
const first = advanceLanguageProjection(
  { sourceUri, sourceVersion: 1, entryUri: "untitled:/mmt-projection/a/main-1.typ", revision: 1, full: true },
  "untitled:/mmt-projection/a",
  latest,
  retired
);
assert.equal(first?.advanced, true);
assert.equal(latest.get(sourceUri), first?.token);

const clock = new RevisionPinnedPreviewClock();
const pinned = clock.timestamp(first.token, false, () => new Date(1_000));
assert.equal(clock.timestamp(first.token, false, () => new Date(2_000)), pinned);
assert.equal(pinned.unixMillis, 1_000, "one projection revision must retain one preview instant");
const refreshed = clock.timestamp(first.token, true, () => new Date(3_000));
assert.equal(refreshed.unixMillis, 3_000, "explicit refresh must advance the preview instant");
assert.notEqual(refreshed, pinned);

const duplicate = advanceLanguageProjection(
  { sourceUri, sourceVersion: 1, entryUri: first.token.entryUri, revision: 1, full: true },
  first.token.session,
  latest,
  retired
);
assert.equal(duplicate?.advanced, false, "duplicate notifications must not reapply a revision");
assert.equal(duplicate?.token, first.token, "duplicates must retain token identity for render retry gating");
assert.equal(first.token.sourceVersion, 1, "projection tokens must bind the authored source version");
assert.equal(advanceLanguageProjection(
  { sourceUri, sourceVersion: 2, entryUri: first.token.entryUri, revision: 1, full: true },
  first.token.session,
  latest,
  retired
), undefined, "same-revision updates for another source version must be rejected");

assert.equal(advanceLanguageProjection(
  { sourceUri, sourceVersion: 0, entryUri: first.token.entryUri, revision: 0, full: false },
  first.token.session,
  latest,
  retired
), undefined, "older deltas must be rejected");

assert.equal(advanceLanguageProjection(
  { sourceUri, sourceVersion: 1, entryUri: "untitled:/mmt-projection/a/main-1-recovered.typ", revision: 1, full: true },
  first.token.session,
  latest,
  retired
), undefined, "same-session same-revision entry changes must be rejected");
assert.equal(latest.get(sourceUri), first.token);

assert.equal(advanceLanguageProjection(
  { sourceUri, sourceVersion: 2, entryUri: "untitled:/mmt-projection/b/main-2.typ", revision: 2, full: false },
  "untitled:/mmt-projection/b",
  latest,
  retired
), undefined, "a new session must begin with a full snapshot");

const replacement = advanceLanguageProjection(
  { sourceUri, sourceVersion: 2, entryUri: "untitled:/mmt-projection/b/main-2.typ", revision: 2, full: true },
  "untitled:/mmt-projection/b",
  latest,
  retired
);
assert.equal(replacement?.advanced, true);
const replacementTime = clock.timestamp(replacement.token, false, () => new Date(4_000));
assert.equal(replacementTime.unixMillis, 4_000, "a new projection revision must receive a new instant");
assert.equal(retired.get(sourceUri)?.has(first.token.session), true);
assert.equal(advanceLanguageProjection(
  { sourceUri, sourceVersion: 3, entryUri: "untitled:/mmt-projection/a/main-3.typ", revision: 3, full: true },
  first.token.session,
  latest,
  retired
), undefined, "retired sessions must not revive");

const synchronizedProject = { sourceVersion: 3, revision: 7 };
let synchronizationRequests = 0;
const synchronized = await waitForSynchronizedLanguageProjection(async () => {
  synchronizationRequests += 1;
  if (synchronizationRequests === 1) return null;
  if (synchronizationRequests === 2) return { sourceVersion: 2, revision: 6 };
  return synchronizedProject;
}, 3, 1_000);
assert.equal(synchronized, synchronizedProject, "preview open must wait for the current document version");
assert.equal(synchronizationRequests, 3, "null and stale projections must be retried");

let failedRequests = 0;
await assert.rejects(
  waitForSynchronizedLanguageProjection(async () => {
    failedRequests += 1;
    throw new Error("deterministic projection failure");
  }, 1, 1_000),
  /deterministic projection failure/,
  "projection build failures must be surfaced immediately"
);
assert.equal(failedRequests, 1, "deterministic projection failures must not be retried");

console.log(JSON.stringify({ duplicateApplied: false, duplicateRetryTokenPreserved: true, sessionRetirement: true, revisionPinnedClock: true }));
