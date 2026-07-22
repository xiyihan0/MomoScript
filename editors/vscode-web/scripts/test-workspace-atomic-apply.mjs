import assert from "node:assert/strict";
import { WorkspaceAtomicApplyBlocked, WorkspaceCoordinator, normalizeWorkspacePath } from "../src/workspace.ts";
import { HistoryQuotaBlocked, WorkspaceHistory, resumeV2Migration, workspaceInventory } from "../src/workspaceHistory.ts";

const bytes = (value) => new TextEncoder().encode(value);
const entry = (path, value = "", type = 1, time = 1) => ({ path, type, ctime: time, mtime: time, data: bytes(value) });
const tree = (...entries) => new Map(entries.map((value) => [value.path, value]));

assert.equal(normalizeWorkspacePath("story.mmt"), "/story.mmt");
for (const invalid of ["a//b", "../a", "a\\b", "a/./b", "a\0b"]) {
  assert.throws(() => normalizeWorkspacePath(invalid));
}

const history = new WorkspaceHistory(1024 * 1024);
const root = entry("/", "", 2);
const storyA = entry("/story.mmt", "A", 1, 2);
const baseline = await history.commit("import", new Map(), tree(root, storyA), { now: 1, label: "v1 baseline", pin: true });
const storyB = entry("/story.mmt", "B", 1, 3);
const firstEdit = await history.commit("edit", tree(storyA), tree(storyB), { now: 2_000 });
const storyC = entry("/story.mmt", "C", 1, 4);
const groupedEdit = await history.commit("edit", tree(storyB), tree(storyC), { now: 4_000 });
assert.equal(firstEdit, groupedEdit, "edits inside idle/max windows must share one revision");
const grouped = history.snapshot.revisions.at(-1);
assert.equal(history.textDiff(grouped.id, "/story.mmt").before, "A");
assert.equal(history.textDiff(grouped.id, "/story.mmt").after, "C");

const noOpHistory = new WorkspaceHistory(1024 * 1024);
const noOpBaseline = await noOpHistory.commit("import", new Map(), tree(root, storyA), { now: 1, label: "baseline", pin: true });
const transient = entry("/story.mmt", "transient", 1, 5);
await noOpHistory.commit("edit", tree(storyA), tree(transient), { now: 2_000 });
const revertedHead = await noOpHistory.commit("edit", tree(transient), tree(storyA), { now: 3_000 });
assert.equal(revertedHead, noOpBaseline, "an edit group returning to its parent state must be elided");
assert.equal(noOpHistory.snapshot.revisions.length, 1, "net-no-op edit groups must not appear as duplicate history versions");
assert.equal(new TextDecoder().decode(noOpHistory.snapshot.current.get("/story.mmt").data), "A");

const asset = entry("/assets", "", 2, 5);
const nested = entry("/assets/a.typ", "nested", 1, 6);
await history.commit("create", new Map(), tree(asset, nested), { now: 4_100 });
const renamed = entry("/renamed.typ", "nested", 1, 7);
await history.commit("rename", tree(asset, nested), tree(renamed), { now: 4_200 });
assert.equal(history.snapshot.current.has("/assets/a.typ"), false);
assert.equal(new TextDecoder().decode(history.snapshot.current.get("/renamed.typ").data), "nested");
await history.commit("delete", tree(renamed), new Map(), { now: 4_300 });
assert.equal(history.snapshot.current.has("/renamed.typ"), false);
const checkpoint = await history.checkpoint("before experiment", 5_000);
await history.commit("edit", tree(storyC), tree(entry("/story.mmt", "D", 1, 8)), { now: 6_000 });
await history.restore(checkpoint, 7_000);
assert.equal(new TextDecoder().decode(history.snapshot.current.get("/story.mmt").data), "C");
assert.equal(history.snapshot.revisions.some((revision) => revision.id === checkpoint && revision.pinned), true);
assert.equal(history.snapshot.revisions.at(-1).reason, "restore");
assert.equal(history.snapshot.revisions.some((revision) => revision.id === baseline), true);

const tiny = new WorkspaceHistory(1);
await assert.rejects(
  tiny.commit("create", new Map(), tree(entry("/large.typ", "too large"))),
  HistoryQuotaBlocked,
);
assert.equal(tiny.snapshot.current.size, 0, "quota failure must not advance current tree");
assert.equal(tiny.snapshot.revisions.length, 0, "quota failure must not advance revision/head");

const v1 = [entry("/", "", 2, 10), entry("/a.mmt", "α", 1, 11), entry("/z.typ", "Z", 1, 12)];
let marker = {
  migrationId: "migration-1",
  state: "v1-baseline-pending",
  staged: new Map(),
  baselineRevisionId: "baseline-1",
};
marker = await resumeV2Migration(v1, marker, 1);
assert.equal(marker.cursor, "/");
marker = await resumeV2Migration(v1, marker, 1);
const resumed = structuredClone(marker);
marker = await resumeV2Migration(v1, marker, 1);
marker = await resumeV2Migration(v1, marker, 1);
assert.equal(marker.state, "complete");
assert.equal(marker.baselineRevisionId, "baseline-1");
assert.equal(marker.staged.size, 3);
assert.deepEqual([...marker.staged.keys()], ["/", "/a.mmt", "/z.typ"]);
const resumedAgain = await resumeV2Migration(v1, resumed, 8);
const completedAgain = await resumeV2Migration(v1, resumedAgain, 8);
assert.equal(completedAgain.state, "complete");
assert.equal(completedAgain.baselineRevisionId, marker.baselineRevisionId, "resume must publish the same baseline identity");
const failed = await resumeV2Migration(v1, { ...resumed, state: "v1-baseline-pending" }, 8, (phase, path) => {
  if (phase === "hash" && path === "/z.typ") throw new Error("injected hash failure");
});
assert.equal(failed.state, "migration-failed");
assert.match(failed.error, /injected hash failure/);
assert.deepEqual(v1.map((value) => new TextDecoder().decode(value.data)), ["", "α", "Z"], "v1 bytes remain exportable");

const metadata = {
  workspaceId: "workspace-1",
  displayName: "Fixture",
  createdAt: 1,
  activeBackend: { kind: "indexeddb", id: "workspace-1" },
  backendGeneration: 1,
  headSequence: 0,
  paths: { caseSensitive: true, separator: "/" },
  migration: { state: "complete", migrationId: "migration-1" },
  storage: { quotaBlocked: false, historyDegraded: false, unreconciled: false, pendingJournal: false },
};
const journals = new Map();
const backend = {
  metadata,
  capabilities: { paths: metadata.paths, atomicCurrentFileTransaction: true },
  async load() { return []; },
  async put() {},
  async transact() {},
  async prepareAtomicJournal(journal) { journals.set(journal.id, structuredClone(journal)); },
  async finishAtomicJournal(id, state, error) { journals.set(id, { ...journals.get(id), state, error }); },
  async pendingAtomicJournals() { return [...journals.values()].filter((journal) => journal.state === "pending" || journal.state === "blocked"); },
  close() {},
};
const coordinator = new WorkspaceCoordinator(backend);
await coordinator.initialize();
await coordinator.acquireWriter();
const documents = new Map([["a", "before-a"], ["b", "before-b"]]);
const published = [];
const targets = ["a", "b"].map((key) => ({
  key: `/project/${key}.typ`,
  intended: `after-${key}`,
  async capture() { return documents.get(key); },
  async commit() {
    if (key === "b") throw new Error("injected second target commit failure");
    documents.set(key, `after-${key}`);
  },
  async restore(preimage) { documents.set(key, preimage); },
  publish() { published.push(key); },
}));
await assert.rejects(coordinator.atomicApply("edit", targets), /second target commit failure/);
assert.deepEqual([...documents], [["a", "before-a"], ["b", "before-b"]], "all preimages must be restored");
assert.deepEqual(published, [], "events publish only after every target commits");
assert.equal([...journals.values()].at(-1).state, "aborted");
assert.equal(coordinator.state.blocked, false);

const blockedTargets = [
  {
    key: "/project/a.typ", intended: "after-a",
    async capture() { return documents.get("a"); },
    async commit() { documents.set("a", "after-a"); },
    async restore() { throw new Error("injected rollback failure"); },
  },
  {
    key: "/project/b.typ", intended: "after-b",
    async capture() { return documents.get("b"); },
    async commit() { throw new Error("commit failed"); },
    async restore(preimage) { documents.set("b", preimage); },
  },
];
await assert.rejects(coordinator.atomicApply("edit", blockedTargets), WorkspaceAtomicApplyBlocked);
assert.equal(coordinator.state.blocked, true);
assert.equal([...journals.values()].at(-1).state, "blocked");
await assert.rejects(coordinator.mutate("edit", async () => undefined), /blocked/);
coordinator.dispose();

const safeInventory = workspaceInventory("workspace-1", 100, 40, metadata.storage);
assert.equal(safeInventory.hardGate, false);
assert.deepEqual(safeInventory.entries.map((item) => item.class), ["workspace-protected", "history-managed"]);
assert.equal(safeInventory.entries.every((item) => item.reproducible === false), true, "shell/pack cannot reclaim workspace/history");
const blockedInventory = workspaceInventory("workspace-1", 100, 40, { ...metadata.storage, historyDegraded: true, unreconciled: true });
assert.equal(blockedInventory.hardGate, true, "blocked/degraded inventory invalidates external reservations");

console.log(JSON.stringify({
  backendTranscript: { pathNormalization: true, sourceOrder: true },
  migration: { resumable: true, idempotentBaseline: true, failureReadOnlyExport: true },
  history: { sha256: true, editGrouping: true, treeRenameDelete: true, checkpointDiffRestore: true },
  quota: { atomicFailure: true },
  origin: { protectedWorkspace: true, protectedHistory: true, blockedFreshInventory: true },
  atomicApply: { secondTargetRollback: true, publishDeferred: true, rollbackFailureBlocked: true },
}));
