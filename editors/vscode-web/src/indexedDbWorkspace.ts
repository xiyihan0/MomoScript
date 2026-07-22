import type { WorkspaceAtomicJournal, WorkspaceAtomicJournalState, WorkspaceBackend, WorkspaceBackendMetadata, WorkspaceEntry, WorkspaceMutationStore } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

export const WORKSPACE_DATABASE = "momoscript-workspace-v1";
export const WORKSPACE_DATABASE_VERSION = 3;
export const WORKSPACE_STORES = {
  files: "files",
  metadata: "metadata",
  blobs: "blobs",
  revisions: "revisions",
  changes: "changes",
  snapshots: "snapshots",
  heads: "heads",
  journal: "journal",
  syncBaselines: "sync-baselines",
  handles: "handles"
} as const;

export const HISTORY_BUDGET_BYTES = 50 * 1024 * 1024;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;

const REVISION_PAGE_INDEX = "workspace-created-id";
const CHANGE_REVISION_INDEX = "revision";
const SNAPSHOT_REVISION_INDEX = "revision";
const META_HISTORY_SNAPSHOTS = "history-snapshots-v3";
const META_HISTORY_USAGE = "history-usage-v3";

interface MetadataRecord { key: string; value: unknown }
interface BlobRecord { digest: string; bytes: Uint8Array; size: number }
interface SnapshotRecord {
  id: string;
  revision: string;
  path: string;
  digest?: string;
  entry: Omit<WorkspaceEntry, "data">;
}
export interface WorkspaceRevision {
  id: string;
  workspaceId: string;
  parent?: string;
  reason: string;
  createdAt: number;
  updatedAt: number;
  checkpoint?: string;
  protected?: boolean;
}
export interface WorkspaceHistoryChange {
  id: string;
  revision: string;
  path: string;
  before?: string;
  after?: string;
  beforeEntry?: Omit<WorkspaceEntry, "data">;
  afterEntry?: Omit<WorkspaceEntry, "data">;
  beforeSize?: number;
  afterSize?: number;
  mediaType?: string;
}

export interface WorkspaceHistoryRevision extends WorkspaceRevision {
  changes: readonly WorkspaceHistoryChange[];
}

export interface WorkspaceHistoryCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface WorkspaceHistoryPage {
  readonly revisions: readonly WorkspaceHistoryRevision[];
  readonly nextCursor?: WorkspaceHistoryCursor;
}

export interface WorkspaceHistoryUsage {
  readonly totalBytes: number;
  readonly budgetBytes: number;
  readonly protectedBytes: number;
  readonly checkpointBytes: number;
  readonly checkpointCount: number;
  readonly retentionMs: number;
  readonly quotaBlocked: boolean;
}

interface StoredHistoryUsage extends WorkspaceHistoryUsage {
  readonly lastGcAt: number;
}
interface HeadRecord { workspaceId: string; revision: string }

const META_WORKSPACE = "workspace";
const META_MIGRATION = "migration";

export class IndexedDbWorkspaceBackend implements WorkspaceBackend {
  readonly capabilities = { paths: { caseSensitive: true, separator: "/" as const }, atomicCurrentFileTransaction: true };
  metadata: WorkspaceBackendMetadata;

  private constructor(readonly database: IDBDatabase, metadata: WorkspaceBackendMetadata) {
    this.metadata = metadata;
  }

  static async open(): Promise<IndexedDbWorkspaceBackend> {
    const database = await openDatabase();
    const metadata = await ensureWorkspaceMetadata(database);
    const backend = new IndexedDbWorkspaceBackend(database, metadata);
    await backend.ensureRevisionSnapshots();
    await backend.gc();
    return backend;
  }

  async load(): Promise<readonly WorkspaceEntry[]> {
    const records = await requestResult<WorkspaceEntry[]>(
      this.database.transaction(WORKSPACE_STORES.files).objectStore(WORKSPACE_STORES.files).getAll()
    );
    return records.map(cloneEntry);
  }

  put(entry: WorkspaceEntry): Promise<void> {
    return transactionDone(this.database, [WORKSPACE_STORES.files], "readwrite", (transaction) => {
      transaction.objectStore(WORKSPACE_STORES.files).put(cloneEntry(entry));
    });
  }

  transact(body: (store: WorkspaceMutationStore) => void): Promise<void> {
    return transactionDone(this.database, [WORKSPACE_STORES.files], "readwrite", (transaction) => {
      const objectStore = transaction.objectStore(WORKSPACE_STORES.files);
      body({
        put: (entry) => objectStore.put(cloneEntry(entry)),
        delete: (path) => objectStore.delete(normalizeWorkspacePath(path))
      });
    });
  }

  async commitMutation(
    reason: string,
    before: ReadonlyMap<string, WorkspaceEntry>,
    after: ReadonlyMap<string, WorkspaceEntry>,
    checkpoint?: string
  ): Promise<string> {
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort(comparePaths);
    const digests = new Map<string, string>();
    for (const path of paths) {
      const left = before.get(path);
      const right = after.get(path);
      if (left?.type === 1) digests.set(`before:${path}`, await sha256(left.data));
      if (right?.type === 1) digests.set(`after:${path}`, await sha256(right.data));
    }
    const candidateBlobSizes = new Map<string, number>();
    for (const path of paths) {
      const previous = before.get(path);
      const next = after.get(path);
      const beforeDigest = digests.get(`before:${path}`);
      const afterDigest = digests.get(`after:${path}`);
      if (previous?.type === 1 && beforeDigest) candidateBlobSizes.set(beforeDigest, previous.data.byteLength);
      if (next?.type === 1 && afterDigest) candidateBlobSizes.set(afterDigest, next.data.byteLength);
    }
    const existingBlobs = await this.blobs([...candidateBlobSizes.keys()]);
    const addedBlobBytes = [...candidateBlobSizes].reduce((total, [digest, size]) => total + (existingBlobs.has(digest) ? 0 : size), 0);
    const head = await this.head();
    const previousRevision = head ? await this.revision(head) : undefined;
    const now = Date.now();
    const grouped = reason === "edit"
      && previousRevision?.reason === "edit"
      && !previousRevision.checkpoint
      && now - previousRevision.updatedAt < 5_000
      && now - previousRevision.createdAt < 30_000;
    const revision = grouped ? previousRevision.id : crypto.randomUUID();
    const existingChanges = grouped
      ? new Map(
          [...(await this.changes(revision))]
            .filter(([, change]) => historyChangeHasEffect(change))
        )
      : new Map<string, WorkspaceHistoryChange>();
    const effectiveChanges = new Map(existingChanges);
    for (const path of paths) {
      const previous = before.get(path);
      const next = after.get(path);
      const existing = existingChanges.get(path);
      const change: WorkspaceHistoryChange = {
        id: `${revision}:${path}`,
        revision,
        path,
        before: existing?.before ?? (previous?.type === 1 ? digests.get(`before:${path}`) : undefined),
        after: next?.type === 1 ? digests.get(`after:${path}`) : undefined,
        beforeEntry: existing?.beforeEntry ?? (previous && metadataOnly(previous)),
        afterEntry: next && metadataOnly(next),
        beforeSize: existing?.beforeSize ?? (previous?.type === 1 ? previous.data.byteLength : undefined),
        afterSize: next?.type === 1 ? next.data.byteLength : undefined,
        mediaType: mediaType(path)
      };
      if (historyChangeHasEffect(change)) effectiveChanges.set(path, change);
      else effectiveChanges.delete(path);
    }
    const elideGroupedRevision = grouped
      && previousRevision.parent !== undefined
      && effectiveChanges.size === 0;
    const snapshot = elideGroupedRevision
      ? new Map<string, SnapshotRecord>()
      : head ? await this.snapshotRecords(head) : new Map<string, SnapshotRecord>();
    for (const path of paths) {
      const next = after.get(path);
      if (!next) {
        snapshot.delete(path);
        continue;
      }
      snapshot.set(path, {
        id: `${revision}:${path}`,
        revision,
        path,
        digest: next.type === 1 ? digests.get(`after:${path}`) : undefined,
        entry: metadataOnly(next)
      });
    }
    try {
      await transactionDone(
        this.database,
        [WORKSPACE_STORES.files, WORKSPACE_STORES.blobs, WORKSPACE_STORES.revisions, WORKSPACE_STORES.changes, WORKSPACE_STORES.snapshots, WORKSPACE_STORES.heads],
        "readwrite",
        (transaction) => {
          const files = transaction.objectStore(WORKSPACE_STORES.files);
          const blobs = transaction.objectStore(WORKSPACE_STORES.blobs);
          const changes = transaction.objectStore(WORKSPACE_STORES.changes);
          for (const path of paths) {
            const previous = before.get(path);
            const next = after.get(path);
            if (next) files.put(cloneEntry(next)); else files.delete(path);
            const beforeDigest = previous?.type === 1 ? digests.get(`before:${path}`) : undefined;
            const afterDigest = next?.type === 1 ? digests.get(`after:${path}`) : undefined;
            if (previous?.type === 1 && beforeDigest) blobs.put({ digest: beforeDigest, bytes: previous.data.slice(), size: previous.data.byteLength } satisfies BlobRecord);
            if (next?.type === 1 && afterDigest) blobs.put({ digest: afterDigest, bytes: next.data.slice(), size: next.data.byteLength } satisfies BlobRecord);
            if (!elideGroupedRevision) {
              const change = effectiveChanges.get(path);
              if (change) changes.put(change);
              else changes.delete(`${revision}:${path}`);
            }
          }
          const revisionStore = transaction.objectStore(WORKSPACE_STORES.revisions);
          const snapshotStore = transaction.objectStore(WORKSPACE_STORES.snapshots);
          const headStore = transaction.objectStore(WORKSPACE_STORES.heads);
          if (elideGroupedRevision) {
            revisionStore.delete(revision);
            for (const change of existingChanges.values()) {
              changes.delete(change.id);
              snapshotStore.delete(`${revision}:${change.path}`);
            }
            headStore.put({ workspaceId: this.metadata.workspaceId, revision: previousRevision.parent! } satisfies HeadRecord);
          } else {
            if (grouped) {
              for (const path of paths) {
                const record = snapshot.get(path);
                if (record) snapshotStore.put({ ...record, id: `${revision}:${path}`, revision });
                else snapshotStore.delete(`${revision}:${path}`);
              }
            } else {
              for (const [path, record] of snapshot) snapshotStore.put({ ...record, id: `${revision}:${path}`, revision, path });
            }
            revisionStore.put({
              id: revision,
              workspaceId: this.metadata.workspaceId,
              parent: grouped ? previousRevision.parent : head,
              reason,
              createdAt: grouped ? previousRevision.createdAt : now,
              updatedAt: now,
              checkpoint,
              protected: Boolean(checkpoint)
            } satisfies WorkspaceRevision);
            headStore.put({ workspaceId: this.metadata.workspaceId, revision } satisfies HeadRecord);
          }
        }
      );
    } catch (error) {
      if (isQuotaError(error)) await this.publishStorage({ ...this.metadata.storage, quotaBlocked: true });
      throw error;
    }
    if (elideGroupedRevision) {
      await this.gc(now);
      return previousRevision.parent!;
    }
    await this.finishHistoryMutation(reason, addedBlobBytes, now);
    return revision;
  }

  async revision(id: string): Promise<WorkspaceRevision | undefined> {
    return requestResult<WorkspaceRevision | undefined>(
      this.database.transaction(WORKSPACE_STORES.revisions).objectStore(WORKSPACE_STORES.revisions).get(id)
    );
  }

  async changes(revision: string): Promise<Map<string, WorkspaceHistoryChange>> {
    const records = await requestResult<WorkspaceHistoryChange[]>(
      this.database.transaction(WORKSPACE_STORES.changes)
        .objectStore(WORKSPACE_STORES.changes)
        .index(CHANGE_REVISION_INDEX)
        .getAll(IDBKeyRange.only(revision))
    );
    return new Map(records.map((record) => [record.path, record]));
  }

  async head(): Promise<string | undefined> {
    const record = await requestResult<HeadRecord | undefined>(
      this.database.transaction(WORKSPACE_STORES.heads).objectStore(WORKSPACE_STORES.heads).get(this.metadata.workspaceId)
    );
    return record?.revision;
  }

  async revisions(limit = 100): Promise<readonly WorkspaceRevision[]> {
    return (await this.historyPage(limit)).revisions.map(({ changes: _changes, ...revision }) => revision);
  }

  async history(limit = 100): Promise<readonly WorkspaceHistoryRevision[]> {
    return (await this.historyPage(limit)).revisions;
  }

  async historyPage(limit = 50, cursor?: WorkspaceHistoryCursor): Promise<WorkspaceHistoryPage> {
    const { revisions, hasMore } = await readRevisionPage(this.database, this.metadata.workspaceId, Math.max(1, limit), cursor);
    if (revisions.length === 0) return { revisions: [] };
    const transaction = this.database.transaction(WORKSPACE_STORES.changes);
    const index = transaction.objectStore(WORKSPACE_STORES.changes).index(CHANGE_REVISION_INDEX);
    const groups = await Promise.all(revisions.map((revision) => requestResult<WorkspaceHistoryChange[]>(index.getAll(IDBKeyRange.only(revision.id)))));
    const history = revisions
      .map((revision, index) => ({
        ...revision,
        changes: Object.freeze(
          groups[index]
            .filter(historyChangeHasEffect)
            .sort((left, right) => comparePaths(left.path, right.path))
        )
      }))
      .filter((revision) => revision.reason !== "edit" || revision.changes.length > 0);
    const last = revisions.at(-1);
    return {
      revisions: history,
      ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {})
    };
  }

  async snapshotRecords(revision: string): Promise<Map<string, SnapshotRecord>> {
    const records = await requestResult<SnapshotRecord[]>(
      this.database.transaction(WORKSPACE_STORES.snapshots)
        .objectStore(WORKSPACE_STORES.snapshots)
        .index(SNAPSHOT_REVISION_INDEX)
        .getAll(IDBKeyRange.only(revision))
    );
    return new Map(records.map((record) => [record.path, record]));
  }

  async snapshotEntry(revision: string, path: string): Promise<WorkspaceEntry | undefined> {
    const record = await requestResult<SnapshotRecord | undefined>(
      this.database.transaction(WORKSPACE_STORES.snapshots)
        .objectStore(WORKSPACE_STORES.snapshots)
        .get(`${revision}:${normalizeWorkspacePath(path)}`)
    );
    return record ? this.inflateSnapshot(record) : undefined;
  }

  async changeEntry(revision: string, path: string, side: "before" | "after"): Promise<WorkspaceEntry | undefined> {
    const change = (await this.changes(revision)).get(normalizeWorkspacePath(path));
    const entry = side === "before" ? change?.beforeEntry : change?.afterEntry;
    const digest = side === "before" ? change?.before : change?.after;
    if (!entry) return undefined;
    const blob = digest ? await this.blob(digest) : undefined;
    if (digest && !blob) throw new Error(`Missing history blob ${digest}`);
    return { ...entry, data: blob ? new Uint8Array(blob.bytes) : new Uint8Array() };
  }

  async restoreRevision(revision: string): Promise<ReadonlyMap<string, WorkspaceEntry>> {
    if (!await this.revision(revision)) throw new Error(`Unknown revision ${revision}`);
    const records = await this.snapshotRecords(revision);
    const digests = [...new Set([...records.values()].flatMap((record) => record.digest ? [record.digest] : []))];
    const blobs = await this.blobs(digests);
    const state = new Map<string, WorkspaceEntry>();
    for (const [path, record] of records) {
      const blob = record.digest ? blobs.get(record.digest) : undefined;
      if (record.digest && !blob) throw new Error(`Missing history blob ${record.digest}`);
      state.set(path, { ...record.entry, data: blob ? new Uint8Array(blob.bytes) : new Uint8Array() });
    }
    return state;
  }

  async historyBytes(): Promise<number> {
    return (await this.historyUsage()).totalBytes;
  }

  async historyUsage(): Promise<WorkspaceHistoryUsage> {
    return await getMetadata<StoredHistoryUsage>(this.database, META_HISTORY_USAGE) ?? this.gc();
  }

  async renameCheckpoint(revision: string, label: string): Promise<void> {
    const value = label.trim();
    if (!value) throw new Error("Checkpoint name is required");
    const current = await this.revision(revision);
    if (!current?.checkpoint) throw new Error(`Unknown Checkpoint ${revision}`);
    await transactionDone(this.database, [WORKSPACE_STORES.revisions], "readwrite", (transaction) => {
      transaction.objectStore(WORKSPACE_STORES.revisions).put({ ...current, checkpoint: value, protected: true } satisfies WorkspaceRevision);
    });
    await this.gc();
  }

  async deleteCheckpoint(revision: string): Promise<void> {
    const current = await this.revision(revision);
    if (!current?.checkpoint) throw new Error(`Unknown Checkpoint ${revision}`);
    const head = await this.head();
    const revisions = await this.allRevisions();
    const replacement = current.parent;
    await transactionDone(this.database, [WORKSPACE_STORES.revisions, WORKSPACE_STORES.changes, WORKSPACE_STORES.snapshots], "readwrite", (transaction) => {
      const revisionStore = transaction.objectStore(WORKSPACE_STORES.revisions);
      if (head === revision) {
        revisionStore.put({ ...current, checkpoint: undefined, protected: false } satisfies WorkspaceRevision);
      } else {
        revisionStore.delete(revision);
        for (const candidate of revisions) {
          if (candidate.parent === revision) revisionStore.put({ ...candidate, parent: replacement } satisfies WorkspaceRevision);
        }
        deleteByIndex(transaction.objectStore(WORKSPACE_STORES.changes).index(CHANGE_REVISION_INDEX), revision);
        deleteByIndex(transaction.objectStore(WORKSPACE_STORES.snapshots).index(SNAPSHOT_REVISION_INDEX), revision);
      }
    });
    await this.gc();
  }

  async clearUnprotectedHistory(): Promise<WorkspaceHistoryUsage> {
    const head = await this.head();
    if (head) {
      const current = (await this.allRevisions()).find((revision) => revision.id === head);
      if (current?.reason === "edit") {
        await this.commitMutation("restore", new Map(), new Map(), "Current recovery point");
      }
    }
    return this.gc(Date.now(), true);
  }

  async gc(now = Date.now(), dropAllEdits = false): Promise<WorkspaceHistoryUsage> {
    const [revisions, changes, snapshots, blobs, head] = await Promise.all([
      this.allRevisions(),
      requestResult<WorkspaceHistoryChange[]>(this.database.transaction(WORKSPACE_STORES.changes).objectStore(WORKSPACE_STORES.changes).getAll()),
      requestResult<SnapshotRecord[]>(this.database.transaction(WORKSPACE_STORES.snapshots).objectStore(WORKSPACE_STORES.snapshots).getAll()),
      requestResult<BlobRecord[]>(this.database.transaction(WORKSPACE_STORES.blobs).objectStore(WORKSPACE_STORES.blobs).getAll()),
      this.head()
    ]);
    const retained = new Set(revisions.map((revision) => revision.id));
    const protectedRevision = (revision: WorkspaceRevision) => revision.id === head
      || Boolean(revision.checkpoint || revision.protected)
      || (revision.reason !== "edit" && revision.reason !== "checkpoint");
    const eligible = revisions
      .filter((revision) => !protectedRevision(revision) && revision.reason === "edit")
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id));
    for (const revision of eligible) {
      if (dropAllEdits || now - revision.updatedAt > HISTORY_RETENTION_MS) retained.delete(revision.id);
    }
    const blobSizes = new Map(blobs.map((blob) => [blob.digest, blob.size]));
    const referencedFor = (revisionIds: ReadonlySet<string>): Set<string> => {
      const referenced = new Set<string>();
      for (const change of changes) {
        if (!revisionIds.has(change.revision)) continue;
        if (change.before) referenced.add(change.before);
        if (change.after) referenced.add(change.after);
      }
      for (const snapshot of snapshots) if (revisionIds.has(snapshot.revision) && snapshot.digest) referenced.add(snapshot.digest);
      return referenced;
    };
    const bytesFor = (digests: ReadonlySet<string>) => [...digests].reduce((total, digest) => total + (blobSizes.get(digest) ?? 0), 0);
    let referenced = referencedFor(retained);
    let totalBytes = bytesFor(referenced);
    for (const revision of eligible) {
      if (totalBytes <= HISTORY_BUDGET_BYTES) break;
      if (!retained.delete(revision.id)) continue;
      referenced = referencedFor(retained);
      totalBytes = bytesFor(referenced);
    }
    const protectedIds = new Set(revisions.filter((revision) => retained.has(revision.id) && protectedRevision(revision)).map((revision) => revision.id));
    const checkpointIds = new Set(revisions.filter((revision) => retained.has(revision.id) && Boolean(revision.checkpoint)).map((revision) => revision.id));
    const protectedBytes = bytesFor(referencedFor(protectedIds));
    const checkpointBytes = bytesFor(referencedFor(checkpointIds));
    const quotaBlocked = totalBytes > HISTORY_BUDGET_BYTES;
    const deleted = new Set(revisions.filter((revision) => !retained.has(revision.id)).map((revision) => revision.id));
    const byId = new Map(revisions.map((revision) => [revision.id, revision]));
    const nearestParent = (parent: string | undefined): string | undefined => {
      let cursor = parent;
      while (cursor && deleted.has(cursor)) cursor = byId.get(cursor)?.parent;
      return cursor;
    };
    const storage = { ...this.metadata.storage, quotaBlocked };
    const usage: StoredHistoryUsage = {
      totalBytes,
      budgetBytes: HISTORY_BUDGET_BYTES,
      protectedBytes,
      checkpointBytes,
      checkpointCount: checkpointIds.size,
      retentionMs: HISTORY_RETENTION_MS,
      quotaBlocked,
      lastGcAt: now
    };
    await transactionDone(
      this.database,
      [WORKSPACE_STORES.blobs, WORKSPACE_STORES.revisions, WORKSPACE_STORES.changes, WORKSPACE_STORES.snapshots, WORKSPACE_STORES.metadata],
      "readwrite",
      (transaction) => {
        const revisionStore = transaction.objectStore(WORKSPACE_STORES.revisions);
        const changeStore = transaction.objectStore(WORKSPACE_STORES.changes);
        const snapshotStore = transaction.objectStore(WORKSPACE_STORES.snapshots);
        for (const revision of revisions) {
          if (deleted.has(revision.id)) revisionStore.delete(revision.id);
          else {
            const parent = nearestParent(revision.parent);
            if (parent !== revision.parent) revisionStore.put({ ...revision, parent } satisfies WorkspaceRevision);
          }
        }
        for (const change of changes) if (deleted.has(change.revision)) changeStore.delete(change.id);
        for (const snapshot of snapshots) if (deleted.has(snapshot.revision)) snapshotStore.delete(snapshot.id);
        const blobStore = transaction.objectStore(WORKSPACE_STORES.blobs);
        for (const blob of blobs) if (!referenced.has(blob.digest)) blobStore.delete(blob.digest);
        transaction.objectStore(WORKSPACE_STORES.metadata).put({ key: META_WORKSPACE, value: { ...this.metadata, storage } } satisfies MetadataRecord);
        transaction.objectStore(WORKSPACE_STORES.metadata).put({ key: META_HISTORY_USAGE, value: usage } satisfies MetadataRecord);
      }
    );
    this.metadata = { ...this.metadata, storage };
    return usage;
  }

  async ensureRevisionSnapshots(): Promise<void> {
    if (await getMetadata<boolean>(this.database, META_HISTORY_SNAPSHOTS)) return;
    const allRevisions = await this.allRevisions();
    const revisionsById = new Map(allRevisions.map((revision) => [revision.id, revision]));
    const revisions: WorkspaceRevision[] = [];
    for (let cursor = await this.head(); cursor; cursor = revisionsById.get(cursor)?.parent) {
      const revision = revisionsById.get(cursor);
      if (!revision) break;
      revisions.push(revision);
    }
    revisions.reverse();
    const changes = await requestResult<WorkspaceHistoryChange[]>(
      this.database.transaction(WORKSPACE_STORES.changes).objectStore(WORKSPACE_STORES.changes).getAll()
    );
    const blobSizes = new Map((await requestResult<BlobRecord[]>(
      this.database.transaction(WORKSPACE_STORES.blobs).objectStore(WORKSPACE_STORES.blobs).getAll()
    )).map((blob) => [blob.digest, blob.size]));
    const enrichedChanges = changes.map((change) => ({
      ...change,
      beforeSize: change.beforeSize ?? (change.before ? blobSizes.get(change.before) : undefined),
      afterSize: change.afterSize ?? (change.after ? blobSizes.get(change.after) : undefined),
      mediaType: change.mediaType ?? mediaType(change.path)
    } satisfies WorkspaceHistoryChange));
    const byRevision = new Map<string, WorkspaceHistoryChange[]>();
    for (const change of enrichedChanges) {
      const group = byRevision.get(change.revision) ?? [];
      group.push(change);
      byRevision.set(change.revision, group);
    }
    const state = new Map<string, SnapshotRecord>();
    const records: SnapshotRecord[] = [];
    for (const revision of revisions) {
      for (const change of byRevision.get(revision.id) ?? []) {
        if (!change.afterEntry) state.delete(change.path);
        else state.set(change.path, { id: "", revision: revision.id, path: change.path, digest: change.after, entry: change.afterEntry });
      }
      for (const [path, record] of state) records.push({ ...record, id: `${revision.id}:${path}`, revision: revision.id, path });
    }
    await transactionDone(this.database, [WORKSPACE_STORES.changes, WORKSPACE_STORES.snapshots, WORKSPACE_STORES.metadata], "readwrite", (transaction) => {
      const snapshotStore = transaction.objectStore(WORKSPACE_STORES.snapshots);
      snapshotStore.clear();
      for (const record of records) snapshotStore.put(record);
      const changeStore = transaction.objectStore(WORKSPACE_STORES.changes);
      for (const change of enrichedChanges) changeStore.put(change);
      transaction.objectStore(WORKSPACE_STORES.metadata).put({ key: META_HISTORY_SNAPSHOTS, value: true } satisfies MetadataRecord);
    });
  }

  private async allRevisions(): Promise<WorkspaceRevision[]> {
    const records = await requestResult<WorkspaceRevision[]>(
      this.database.transaction(WORKSPACE_STORES.revisions).objectStore(WORKSPACE_STORES.revisions).getAll()
    );
    return records.filter((record) => record.workspaceId === this.metadata.workspaceId);
  }

  private async blob(digest: string): Promise<BlobRecord | undefined> {
    return requestResult<BlobRecord | undefined>(
      this.database.transaction(WORKSPACE_STORES.blobs).objectStore(WORKSPACE_STORES.blobs).get(digest)
    );
  }

  private async blobs(digests: readonly string[]): Promise<Map<string, BlobRecord>> {
    if (digests.length === 0) return new Map();
    const transaction = this.database.transaction(WORKSPACE_STORES.blobs);
    const store = transaction.objectStore(WORKSPACE_STORES.blobs);
    const records = await Promise.all(digests.map((digest) => requestResult<BlobRecord | undefined>(store.get(digest))));
    return new Map(records.flatMap((record) => record ? [[record.digest, record] as const] : []));
  }

  private async inflateSnapshot(record: SnapshotRecord): Promise<WorkspaceEntry> {
    const blob = record.digest ? await this.blob(record.digest) : undefined;
    if (record.digest && !blob) throw new Error(`Missing history blob ${record.digest}`);
    return { ...record.entry, data: blob ? new Uint8Array(blob.bytes) : new Uint8Array() };
  }

  private async finishHistoryMutation(reason: string, addedBlobBytes: number, now: number): Promise<void> {
    const usage = await getMetadata<StoredHistoryUsage>(this.database, META_HISTORY_USAGE);
    if (!usage || reason !== "edit" || now - usage.lastGcAt >= 60_000 || usage.totalBytes + addedBlobBytes > HISTORY_BUDGET_BYTES) {
      await this.gc(now);
      return;
    }
    const next: StoredHistoryUsage = {
      ...usage,
      totalBytes: usage.totalBytes + addedBlobBytes,
      protectedBytes: Math.min(usage.totalBytes + addedBlobBytes, usage.protectedBytes + addedBlobBytes)
    };
    await setMetadata(this.database, META_HISTORY_USAGE, next);
  }

  private async publishStorage(storage: WorkspaceBackendMetadata["storage"]): Promise<void> {
    this.metadata = { ...this.metadata, storage };
    await setMetadata(this.database, META_WORKSPACE, this.metadata);
  }

  prepareAtomicJournal(journal: WorkspaceAtomicJournal): Promise<void> {
    return transactionDone(this.database, [WORKSPACE_STORES.journal], "readwrite", (transaction) => {
      transaction.objectStore(WORKSPACE_STORES.journal).put(structuredClone(journal));
    });
  }

  async finishAtomicJournal(
    id: string,
    state: Exclude<WorkspaceAtomicJournalState, "pending">,
    error?: string
  ): Promise<void> {
    const store = this.database.transaction(WORKSPACE_STORES.journal).objectStore(WORKSPACE_STORES.journal);
    const journal = await requestResult<WorkspaceAtomicJournal | undefined>(store.get(id));
    if (!journal) throw new Error(`Unknown atomic journal ${id}`);
    await transactionDone(this.database, [WORKSPACE_STORES.journal], "readwrite", (transaction) => {
      transaction.objectStore(WORKSPACE_STORES.journal).put({ ...journal, state, ...(error ? { error } : {}) });
    });
  }

  async pendingAtomicJournals(): Promise<readonly WorkspaceAtomicJournal[]> {
    const journals = await requestResult<WorkspaceAtomicJournal[]>(
      this.database.transaction(WORKSPACE_STORES.journal).objectStore(WORKSPACE_STORES.journal).getAll()
    );
    return journals.filter((journal) => journal.state === "pending" || journal.state === "blocked");
  }

  close(): void { this.database.close(); }

  async resumeV1BaselineMigration(): Promise<void> {
    const migration = await getMetadata<{ state: string; cursor?: string; migrationId?: string }>(this.database, META_MIGRATION);
    if (!migration || migration.state === "complete") {
      if (this.metadata.migration.state !== "complete") await this.#publishMigration({ state: "complete", migrationId: this.metadata.migration.migrationId });
      return;
    }
    try {
      const entries = (await this.load()).slice().sort((left, right) => comparePaths(left.path, right.path));
      const existingHead = await this.head();
      if (!existingHead) {
        await this.commitMutation("backend-migration", new Map(), new Map(entries.map((entry) => [entry.path, entry])), "Imported version-1 baseline");
      }
      const verified = await this.load();
      if (verified.length !== entries.length || verified.some((entry, index) => !equalEntry(entry, entries[index]))) {
        throw new Error("Version-1 baseline byte verification failed");
      }
      await setMetadata(this.database, META_MIGRATION, { state: "complete", migrationId: migration.migrationId ?? this.metadata.migration.migrationId, cursor: entries.at(-1)?.path });
      await this.#publishMigration({ state: "complete", migrationId: migration.migrationId ?? this.metadata.migration.migrationId });
    } catch (error) {
      const failed = { state: "migration-failed" as const, migrationId: migration.migrationId ?? this.metadata.migration.migrationId, cursor: migration.cursor, error: error instanceof Error ? error.message : String(error) };
      await setMetadata(this.database, META_MIGRATION, failed);
      await this.#publishMigration(failed);
      throw error;
    }
  }

  async #publishMigration(migration: WorkspaceBackendMetadata["migration"]): Promise<void> {
    this.metadata = { ...this.metadata, migration };
    await setMetadata(this.database, META_WORKSPACE, this.metadata);
  }
}

async function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(WORKSPACE_DATABASE, WORKSPACE_DATABASE_VERSION);
  request.onupgradeneeded = (event) => {
    const database = request.result;
    const transaction = request.transaction!;
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.files)) database.createObjectStore(WORKSPACE_STORES.files, { keyPath: "path" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.metadata)) database.createObjectStore(WORKSPACE_STORES.metadata, { keyPath: "key" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.blobs)) database.createObjectStore(WORKSPACE_STORES.blobs, { keyPath: "digest" });
    const revisions = database.objectStoreNames.contains(WORKSPACE_STORES.revisions)
      ? transaction.objectStore(WORKSPACE_STORES.revisions)
      : database.createObjectStore(WORKSPACE_STORES.revisions, { keyPath: "id" });
    if (!revisions.indexNames.contains(REVISION_PAGE_INDEX)) revisions.createIndex(REVISION_PAGE_INDEX, ["workspaceId", "createdAt", "id"]);
    const changes = database.objectStoreNames.contains(WORKSPACE_STORES.changes)
      ? transaction.objectStore(WORKSPACE_STORES.changes)
      : database.createObjectStore(WORKSPACE_STORES.changes, { keyPath: "id" });
    if (!changes.indexNames.contains(CHANGE_REVISION_INDEX)) changes.createIndex(CHANGE_REVISION_INDEX, "revision");
    const snapshots = database.objectStoreNames.contains(WORKSPACE_STORES.snapshots)
      ? transaction.objectStore(WORKSPACE_STORES.snapshots)
      : database.createObjectStore(WORKSPACE_STORES.snapshots, { keyPath: "id" });
    if (!snapshots.indexNames.contains(SNAPSHOT_REVISION_INDEX)) snapshots.createIndex(SNAPSHOT_REVISION_INDEX, "revision");
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.heads)) database.createObjectStore(WORKSPACE_STORES.heads, { keyPath: "workspaceId" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.journal)) database.createObjectStore(WORKSPACE_STORES.journal, { keyPath: "id" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.syncBaselines)) database.createObjectStore(WORKSPACE_STORES.syncBaselines, { keyPath: "id" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.handles)) database.createObjectStore(WORKSPACE_STORES.handles, { keyPath: "id" });
    if (event.oldVersion < 2) {
      transaction.objectStore(WORKSPACE_STORES.metadata).put({ key: META_MIGRATION, value: { state: "v1-baseline-pending" } } satisfies MetadataRecord);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked"));
  return promise;
}

async function ensureWorkspaceMetadata(database: IDBDatabase): Promise<WorkspaceBackendMetadata> {
  const existing = await getMetadata<WorkspaceBackendMetadata>(database, META_WORKSPACE);
  if (existing) return existing;
  const now = Date.now();
  const workspaceId = crypto.randomUUID();
  const metadata: WorkspaceBackendMetadata = {
    workspaceId,
    displayName: "Browser workspace",
    createdAt: now,
    activeBackend: { kind: "indexeddb", id: workspaceId },
    backendGeneration: 1,
    headSequence: 0,
    paths: { caseSensitive: true, separator: "/" },
    migration: { state: "v1-baseline-pending", migrationId: crypto.randomUUID() },
    storage: { quotaBlocked: false, historyDegraded: false, unreconciled: false, pendingJournal: false },
  };
  await setMetadata(database, META_WORKSPACE, metadata);
  return metadata;
}

async function readRevisionPage(
  database: IDBDatabase,
  workspaceId: string,
  limit: number,
  cursor?: WorkspaceHistoryCursor
): Promise<{ revisions: WorkspaceRevision[]; hasMore: boolean }> {
  const transaction = database.transaction(WORKSPACE_STORES.revisions);
  const index = transaction.objectStore(WORKSPACE_STORES.revisions).index(REVISION_PAGE_INDEX);
  const upper: [string, number, string] = cursor
    ? [workspaceId, cursor.createdAt, cursor.id]
    : [workspaceId, Number.MAX_SAFE_INTEGER, "\uffff"];
  const range = IDBKeyRange.bound([workspaceId, 0, ""], upper, false, Boolean(cursor));
  const { promise, resolve, reject } = Promise.withResolvers<{ revisions: WorkspaceRevision[]; hasMore: boolean }>();
  const revisions: WorkspaceRevision[] = [];
  const request = index.openCursor(range, "prev");
  request.onsuccess = () => {
    const item = request.result;
    if (!item) {
      resolve({ revisions, hasMore: false });
      return;
    }
    if (revisions.length === limit) {
      resolve({ revisions, hasMore: true });
      return;
    }
    revisions.push(item.value as WorkspaceRevision);
    item.continue();
  };
  request.onerror = () => reject(request.error);
  return promise;
}

async function getMetadata<T>(database: IDBDatabase, key: string): Promise<T | undefined> {
  const record = await requestResult<MetadataRecord | undefined>(
    database.transaction(WORKSPACE_STORES.metadata).objectStore(WORKSPACE_STORES.metadata).get(key)
  );
  return record?.value as T | undefined;
}

function setMetadata(database: IDBDatabase, key: string, value: unknown): Promise<void> {
  return transactionDone(database, [WORKSPACE_STORES.metadata], "readwrite", (transaction) => {
    transaction.objectStore(WORKSPACE_STORES.metadata).put({ key, value } satisfies MetadataRecord);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

function transactionDone(
  database: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => void
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const transaction = database.transaction(stores, mode);
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  try { body(transaction); } catch (error) { transaction.abort(); reject(error); }
  return promise;
}

function deleteByIndex(index: IDBIndex, key: IDBValidKey): void {
  const request = index.openKeyCursor(IDBKeyRange.only(key));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
}

function historyChangeHasEffect(change: Pick<WorkspaceHistoryChange, "before" | "after" | "beforeEntry" | "afterEntry">): boolean {
  if (change.before !== change.after) return true;
  if (Boolean(change.beforeEntry) !== Boolean(change.afterEntry)) return true;
  return change.beforeEntry?.type !== change.afterEntry?.type;
}

function mediaType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({
    avif: "image/avif", avifs: "image/avif-sequence", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
    json: "application/json", mmt: "text/x-momoscript", pdf: "application/pdf", png: "image/png", svg: "image/svg+xml",
    toml: "application/toml", ts: "text/typescript", typ: "text/x-typst", txt: "text/plain", webp: "image/webp"
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "UnknownError");
}

function metadataOnly(entry: WorkspaceEntry): Omit<WorkspaceEntry, "data"> {
  return { path: entry.path, type: entry.type, ctime: entry.ctime, mtime: entry.mtime };
}

function cloneEntry(entry: WorkspaceEntry): WorkspaceEntry { return { ...entry, data: new Uint8Array(entry.data) }; }

function equalEntry(left: WorkspaceEntry, right: WorkspaceEntry): boolean {
  return left.path === right.path && left.type === right.type && left.ctime === right.ctime && left.mtime === right.mtime
    && left.data.byteLength === right.data.byteLength && left.data.every((value, index) => value === right.data[index]);
}

function comparePaths(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
