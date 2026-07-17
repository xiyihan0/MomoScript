import type { WorkspaceBackend, WorkspaceBackendMetadata, WorkspaceEntry, WorkspaceMutationStore } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

export const WORKSPACE_DATABASE = "momoscript-workspace-v1";
export const WORKSPACE_DATABASE_VERSION = 2;
export const WORKSPACE_STORES = {
  files: "files",
  metadata: "metadata",
  blobs: "blobs",
  revisions: "revisions",
  changes: "changes",
  heads: "heads",
  journal: "journal",
  syncBaselines: "sync-baselines",
  handles: "handles"
} as const;

interface MetadataRecord { key: string; value: unknown }
interface BlobRecord { digest: string; bytes: Uint8Array; size: number }
export interface WorkspaceRevision {
  id: string;
  workspaceId: string;
  parent?: string;
  reason: string;
  createdAt: number;
  updatedAt: number;
  checkpoint?: string;
}
interface ChangeRecord {
  id: string;
  revision: string;
  path: string;
  before?: string;
  after?: string;
  beforeEntry?: Omit<WorkspaceEntry, "data">;
  afterEntry?: Omit<WorkspaceEntry, "data">;
}
interface HeadRecord { workspaceId: string; revision: string }

const META_WORKSPACE = "workspace";
const META_MIGRATION = "migration";

export class IndexedDbWorkspaceBackend implements WorkspaceBackend {
  readonly metadata: WorkspaceBackendMetadata;

  private constructor(readonly database: IDBDatabase, metadata: WorkspaceBackendMetadata) {
    this.metadata = metadata;
  }

  static async open(): Promise<IndexedDbWorkspaceBackend> {
    const database = await openDatabase();
    const metadata = await ensureWorkspaceMetadata(database);
    return new IndexedDbWorkspaceBackend(database, metadata);
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
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const digests = new Map<string, string>();
    for (const path of paths) {
      const left = before.get(path);
      const right = after.get(path);
      if (left?.type === 1) digests.set(`before:${path}`, await sha256(left.data));
      if (right?.type === 1) digests.set(`after:${path}`, await sha256(right.data));
    }
    const head = await this.head();
    const previousRevision = head ? await this.revision(head) : undefined;
    const now = Date.now();
    const grouped = reason === "edit"
      && previousRevision?.reason === "edit"
      && now - previousRevision.updatedAt < 5_000
      && now - previousRevision.createdAt < 30_000;
    const revision = grouped ? previousRevision.id : crypto.randomUUID();
    const existingChanges = grouped ? await this.changes(revision) : new Map<string, ChangeRecord>();
    await transactionDone(
      this.database,
      [WORKSPACE_STORES.files, WORKSPACE_STORES.blobs, WORKSPACE_STORES.revisions, WORKSPACE_STORES.changes, WORKSPACE_STORES.heads],
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
          const existing = existingChanges.get(path);
          changes.put({
            id: `${revision}:${path}`,
            revision,
            path,
            before: existing?.before ?? beforeDigest,
            after: afterDigest,
            beforeEntry: existing?.beforeEntry ?? (previous && metadataOnly(previous)),
            afterEntry: next && metadataOnly(next)
          } satisfies ChangeRecord);
        }
        transaction.objectStore(WORKSPACE_STORES.revisions).put({
          id: revision,
          workspaceId: this.metadata.workspaceId,
          parent: grouped ? previousRevision.parent : head,
          reason,
          createdAt: grouped ? previousRevision.createdAt : now,
          updatedAt: now,
          checkpoint
        } satisfies WorkspaceRevision);
        transaction.objectStore(WORKSPACE_STORES.heads).put({ workspaceId: this.metadata.workspaceId, revision } satisfies HeadRecord);
      }
    );
    return revision;
  }

  async revision(id: string): Promise<WorkspaceRevision | undefined> {
    return requestResult<WorkspaceRevision | undefined>(
      this.database.transaction(WORKSPACE_STORES.revisions).objectStore(WORKSPACE_STORES.revisions).get(id)
    );
  }

  async changes(revision: string): Promise<Map<string, ChangeRecord>> {
    const records = await requestResult<ChangeRecord[]>(
      this.database.transaction(WORKSPACE_STORES.changes).objectStore(WORKSPACE_STORES.changes).getAll()
    );
    return new Map(records.filter((record) => record.revision === revision).map((record) => [record.path, record]));
  }

  async head(): Promise<string | undefined> {
    const record = await requestResult<HeadRecord | undefined>(
      this.database.transaction(WORKSPACE_STORES.heads).objectStore(WORKSPACE_STORES.heads).get(this.metadata.workspaceId)
    );
    return record?.revision;
  }

  async revisions(limit = 100): Promise<readonly WorkspaceRevision[]> {
    const records = await requestResult<WorkspaceRevision[]>(
      this.database.transaction(WORKSPACE_STORES.revisions).objectStore(WORKSPACE_STORES.revisions).getAll()
    );
    return records
      .filter((record) => record.workspaceId === this.metadata.workspaceId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit);
  }

  async restoreRevision(revision: string): Promise<ReadonlyMap<string, WorkspaceEntry>> {
    const revisions = await this.revisions(Number.MAX_SAFE_INTEGER);
    const byId = new Map(revisions.map((entry) => [entry.id, entry]));
    if (!byId.has(revision)) throw new Error(`Unknown revision ${revision}`);
    const chain: string[] = [];
    for (let cursor: string | undefined = revision; cursor; cursor = byId.get(cursor)?.parent) chain.push(cursor);
    chain.reverse();
    const transaction = this.database.transaction([WORKSPACE_STORES.changes, WORKSPACE_STORES.blobs]);
    const [allChanges, allBlobs] = await Promise.all([
      requestResult<ChangeRecord[]>(transaction.objectStore(WORKSPACE_STORES.changes).getAll()),
      requestResult<BlobRecord[]>(transaction.objectStore(WORKSPACE_STORES.blobs).getAll())
    ]);
    const blobs = new Map(allBlobs.map((blob) => [blob.digest, blob]));
    const state = new Map<string, WorkspaceEntry>();
    for (const id of chain) {
      for (const change of allChanges.filter((candidate) => candidate.revision === id).sort((a, b) => a.path.localeCompare(b.path))) {
        if (!change.afterEntry) { state.delete(change.path); continue; }
        const blob = change.after ? blobs.get(change.after) : undefined;
        if (change.after && !blob) throw new Error(`Missing history blob ${change.after}`);
        state.set(change.path, { ...change.afterEntry, data: blob ? new Uint8Array(blob.bytes) : new Uint8Array() });
      }
    }
    return state;
  }

  async historyBytes(): Promise<number> {
    const blobs = await requestResult<BlobRecord[]>(
      this.database.transaction(WORKSPACE_STORES.blobs).objectStore(WORKSPACE_STORES.blobs).getAll()
    );
    return blobs.reduce((total, blob) => total + blob.size, 0);
  }

  close(): void { this.database.close(); }

  async resumeV1BaselineMigration(): Promise<void> {
    const migration = await getMetadata<{ state: string; cursor?: string }>(this.database, META_MIGRATION);
    if (!migration || migration.state === "complete") return;
    const entries = (await this.load()).slice().sort((left, right) => left.path.localeCompare(right.path));
    const start = migration.cursor ? Math.max(0, entries.findIndex((entry) => entry.path > migration.cursor!)) : 0;
    const batch = entries.slice(start, start + 64);
    if (batch.length > 0) {
      const before = new Map<string, WorkspaceEntry>();
      const after = new Map(batch.map((entry) => [entry.path, entry]));
      await this.commitMutation("migration", before, after, start === 0 ? "Imported version-1 baseline" : undefined);
      await setMetadata(this.database, META_MIGRATION, { state: "v1-baseline-pending", cursor: batch.at(-1)!.path });
      return this.resumeV1BaselineMigration();
    }
    await setMetadata(this.database, META_MIGRATION, { state: "complete" });
  }
}

async function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(WORKSPACE_DATABASE, WORKSPACE_DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.files)) database.createObjectStore(WORKSPACE_STORES.files, { keyPath: "path" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.metadata)) database.createObjectStore(WORKSPACE_STORES.metadata, { keyPath: "key" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.blobs)) database.createObjectStore(WORKSPACE_STORES.blobs, { keyPath: "digest" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.revisions)) database.createObjectStore(WORKSPACE_STORES.revisions, { keyPath: "id" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.changes)) database.createObjectStore(WORKSPACE_STORES.changes, { keyPath: "id" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.heads)) database.createObjectStore(WORKSPACE_STORES.heads, { keyPath: "workspaceId" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.journal)) database.createObjectStore(WORKSPACE_STORES.journal, { keyPath: "id" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.syncBaselines)) database.createObjectStore(WORKSPACE_STORES.syncBaselines, { keyPath: "id" });
    if (!database.objectStoreNames.contains(WORKSPACE_STORES.handles)) database.createObjectStore(WORKSPACE_STORES.handles, { keyPath: "id" });
    const metadata = request.transaction!.objectStore(WORKSPACE_STORES.metadata);
    metadata.put({ key: META_MIGRATION, value: { state: "v1-baseline-pending" } } satisfies MetadataRecord);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked"));
  return promise;
}

async function ensureWorkspaceMetadata(database: IDBDatabase): Promise<WorkspaceBackendMetadata> {
  const existing = await getMetadata<WorkspaceBackendMetadata>(database, META_WORKSPACE);
  if (existing) return existing;
  const metadata: WorkspaceBackendMetadata = {
    workspaceId: crypto.randomUUID(),
    generation: 1,
    kind: "indexeddb",
    paths: { caseSensitive: true, separator: "/" }
  };
  await setMetadata(database, META_WORKSPACE, metadata);
  return metadata;
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

function metadataOnly(entry: WorkspaceEntry): Omit<WorkspaceEntry, "data"> {
  return { path: entry.path, type: entry.type, ctime: entry.ctime, mtime: entry.mtime };
}

function cloneEntry(entry: WorkspaceEntry): WorkspaceEntry { return { ...entry, data: new Uint8Array(entry.data) }; }

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
