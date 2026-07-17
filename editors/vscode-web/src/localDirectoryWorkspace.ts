import type { WorkspaceBackend, WorkspaceBackendMetadata, WorkspaceEntry, WorkspaceMutationStore } from "./workspace";
import { normalizeWorkspacePath } from "./workspace";

interface JournalRecord {
  id: string;
  workspaceId: string;
  state: "pending" | "complete" | "aborted" | "conflict";
  path: string;
  before?: Uint8Array;
  intended?: Uint8Array;
  observed?: Uint8Array;
  createdAt: number;
  message?: string;
}

export interface ReconcileResult {
  readonly changed: readonly WorkspaceEntry[];
  readonly deleted: readonly string[];
  readonly stable: boolean;
}

export class LocalDirectoryWorkspaceBackend implements WorkspaceBackend {
  readonly capabilities = { paths: { caseSensitive: true, separator: "/" as const }, atomicCurrentFileTransaction: false };
  readonly metadata: WorkspaceBackendMetadata;
  readonly #cache = new Map<string, WorkspaceEntry>();
  readonly #journal: LocalDirectoryJournal;

  private constructor(
    readonly handle: FileSystemDirectoryHandle,
    metadata: WorkspaceBackendMetadata,
    journal: LocalDirectoryJournal
  ) {
    this.metadata = metadata;
    this.#journal = journal;
  }

  static supported(): boolean {
    return typeof window !== "undefined" && "showDirectoryPicker" in window;
  }

  static async pick(workspaceId = crypto.randomUUID(), generation = 1): Promise<LocalDirectoryWorkspaceBackend> {
    if (!this.supported()) throw new Error("File System Access API is unavailable");
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    return this.open(handle, workspaceId, generation);
  }

  static async open(
    handle: FileSystemDirectoryHandle,
    workspaceId: string,
    generation: number
  ): Promise<LocalDirectoryWorkspaceBackend> {
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("Local directory permission requires a user gesture");
    const now = Date.now();
    const metadata: WorkspaceBackendMetadata = {
      workspaceId,
      displayName: handle.name,
      createdAt: now,
      activeBackend: { kind: "local-directory", id: workspaceId },
      backendGeneration: generation,
      headSequence: 0,
      paths: { caseSensitive: true, separator: "/" },
      migration: { state: "complete", migrationId: crypto.randomUUID() },
      storage: { quotaBlocked: false, historyDegraded: false, unreconciled: false, pendingJournal: false },
    };
    const backend = new LocalDirectoryWorkspaceBackend(handle, metadata, await LocalDirectoryJournal.open());
    await backend.recoverJournal();
    return backend;
  }

  async requestPermission(): Promise<PermissionState> {
    return this.handle.requestPermission({ mode: "readwrite" });
  }

  async load(): Promise<readonly WorkspaceEntry[]> {
    const snapshot = await scanDirectory(this.handle);
    this.#cache.clear();
    for (const entry of snapshot) this.#cache.set(entry.path, clone(entry));
    return snapshot;
  }

  async put(entry: WorkspaceEntry): Promise<void> {
    const path = normalizeWorkspacePath(entry.path);
    if (entry.type === 2) {
      await ensureDirectory(this.handle, path);
      this.#cache.set(path, clone(entry));
      return;
    }
    if (entry.type !== 1) throw new Error(`Unsupported entry type ${entry.type}`);
    await this.writeJournaled(path, entry.data);
    this.#cache.set(path, clone(entry));
  }

  async transact(body: (store: WorkspaceMutationStore) => void): Promise<void> {
    const operations: Array<{ kind: "put"; entry: WorkspaceEntry } | { kind: "delete"; path: string }> = [];
    body({
      put: (entry) => operations.push({ kind: "put", entry: clone(entry) }),
      delete: (path) => operations.push({ kind: "delete", path: normalizeWorkspacePath(path) })
    });
    for (const operation of operations) {
      if (operation.kind === "put") await this.put(operation.entry);
      else await this.deleteJournaled(operation.path);
    }
  }

  async reconcile(): Promise<ReconcileResult> {
    const first = await scanDirectory(this.handle);
    const second = await scanDirectory(this.handle);
    if (snapshotDigest(first) !== snapshotDigest(second)) return { changed: [], deleted: [], stable: false };
    const next = new Map(second.map((entry) => [entry.path, entry]));
    const changed: WorkspaceEntry[] = [];
    for (const [path, entry] of next) {
      const previous = this.#cache.get(path);
      if (!previous || previous.type !== entry.type || previous.mtime !== entry.mtime || previous.data.byteLength !== entry.data.byteLength || await bytesDiffer(previous.data, entry.data)) {
        changed.push(clone(entry));
      }
    }
    const deleted = [...this.#cache.keys()].filter((path) => !next.has(path));
    this.#cache.clear();
    for (const [path, entry] of next) this.#cache.set(path, clone(entry));
    return { changed, deleted, stable: true };
  }

  async journalConflicts(): Promise<readonly JournalRecord[]> {
    return (await this.#journal.records(this.metadata.workspaceId)).filter((record) => record.state === "conflict" || record.state === "aborted");
  }

  close(): void { this.#journal.close(); }

  private async writeJournaled(path: string, intended: Uint8Array): Promise<void> {
    const before = await readOptionalFile(this.handle, path);
    const record: JournalRecord = {
      id: crypto.randomUUID(), workspaceId: this.metadata.workspaceId, state: "pending", path,
      before, intended: intended.slice(), createdAt: Date.now()
    };
    await this.#journal.put(record);
    try {
      const parent = await resolveParent(this.handle, path, true);
      const file = await parent.directory.getFileHandle(parent.name, { create: true });
      const writable = await file.createWritable();
      await writable.write(intended.slice().buffer as ArrayBuffer);
      await writable.close();
      const observed = await readOptionalFile(this.handle, path);
      if (!observed || await bytesDiffer(observed, intended)) throw new Error("Local write verification failed");
      await this.#journal.put({ ...record, state: "complete", observed });
    } catch (error) {
      await this.#journal.put({ ...record, state: "aborted", message: String(error) });
      throw error;
    }
  }

  private async deleteJournaled(path: string): Promise<void> {
    const before = await readOptionalFile(this.handle, path);
    const record: JournalRecord = {
      id: crypto.randomUUID(), workspaceId: this.metadata.workspaceId, state: "pending", path,
      before, createdAt: Date.now()
    };
    await this.#journal.put(record);
    try {
      const parent = await resolveParent(this.handle, path, false);
      await parent.directory.removeEntry(parent.name, { recursive: true });
      const observed = await readOptionalFile(this.handle, path);
      if (observed) throw new Error("Local delete verification failed");
      await this.#journal.put({ ...record, state: "complete" });
      for (const cached of [...this.#cache.keys()]) {
        if (cached === path || cached.startsWith(`${path}/`)) this.#cache.delete(cached);
      }
    } catch (error) {
      await this.#journal.put({ ...record, state: "aborted", message: String(error) });
      throw error;
    }
  }

  private async recoverJournal(): Promise<void> {
    for (const record of await this.#journal.records(this.metadata.workspaceId)) {
      if (record.state !== "pending") continue;
      const observed = await readOptionalFile(this.handle, record.path);
      if (equalOptional(observed, record.before)) {
        await this.#journal.put({ ...record, state: "aborted", observed, message: "Disk retained before state" });
      } else if (equalOptional(observed, record.intended)) {
        await this.#journal.put({ ...record, state: "complete", observed });
      } else {
        await this.#journal.put({ ...record, state: "conflict", observed, message: "Disk differs from before and intended state" });
      }
    }
  }
}

class LocalDirectoryJournal {
  private constructor(readonly database: IDBDatabase) {}
  static async open(): Promise<LocalDirectoryJournal> {
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("momoscript-local-directory-journal", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("journal", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    return new LocalDirectoryJournal(await promise);
  }
  put(record: JournalRecord): Promise<void> {
    const transaction = this.database.transaction("journal", "readwrite");
    transaction.objectStore("journal").put(record);
    return done(transaction);
  }
  async records(workspaceId: string): Promise<JournalRecord[]> {
    const request = this.database.transaction("journal").objectStore("journal").getAll();
    const records = await result<JournalRecord[]>(request);
    return records.filter((record) => record.workspaceId === workspaceId);
  }
  close(): void { this.database.close(); }
}

async function scanDirectory(root: FileSystemDirectoryHandle): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [{ path: "/", type: 2, ctime: 0, mtime: 0, data: new Uint8Array() }];
  const visit = async (directory: FileSystemDirectoryHandle, parent: string): Promise<void> => {
    const children: Array<[string, FileSystemHandle]> = [];
    for await (const child of directory.values()) children.push([child.name, child]);
    children.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const folded = new Set<string>();
    for (const [name, child] of children) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error(`Invalid local entry ${name}`);
      const lower = name.toLocaleLowerCase("und");
      if (folded.has(lower)) throw new Error(`Case-colliding local entries under ${parent}`);
      folded.add(lower);
      const path = normalizeWorkspacePath(`${parent}/${name}`);
      if (child.kind === "directory") {
        entries.push({ path, type: 2, ctime: 0, mtime: 0, data: new Uint8Array() });
        await visit(child as FileSystemDirectoryHandle, path);
      } else {
        const file = await (child as FileSystemFileHandle).getFile();
        entries.push({ path, type: 1, ctime: file.lastModified, mtime: file.lastModified, data: new Uint8Array(await file.arrayBuffer()) });
      }
    }
  };
  await visit(root, "");
  return entries;
}

async function ensureDirectory(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of normalizeWorkspacePath(path).split("/").filter(Boolean)) current = await current.getDirectoryHandle(segment, { create: true });
  return current;
}

async function resolveParent(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
  const segments = normalizeWorkspacePath(path).split("/").filter(Boolean);
  const name = segments.pop();
  if (!name) throw new Error("Workspace root has no parent");
  let directory = root;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create });
  return { directory, name };
}

async function readOptionalFile(root: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | undefined> {
  try {
    const parent = await resolveParent(root, path, false);
    const file = await (await parent.directory.getFileHandle(parent.name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
}

async function bytesDiffer(left: Uint8Array, right: Uint8Array): Promise<boolean> {
  if (left.byteLength !== right.byteLength) return true;
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  return a !== b;
}
function equalOptional(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function snapshotDigest(entries: readonly WorkspaceEntry[]): string {
  return entries.map((entry) => `${entry.path}\0${entry.type}\0${entry.mtime}\0${entry.data.byteLength}`).join("\n");
}
function clone(entry: WorkspaceEntry): WorkspaceEntry { return { ...entry, data: entry.data.slice() }; }
function result<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); return promise;
}
function done(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  return promise;
}
