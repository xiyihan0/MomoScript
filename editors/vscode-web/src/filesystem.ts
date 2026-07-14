import * as vscode from "vscode";
import type { FileChangeEvent, FileStat, FileSystemProvider, Uri } from "vscode";
import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  FileChangeType as WorkbenchFileChangeType,
  FileSystemProviderCapabilities,
  type IFileChange,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
  type IWatchOptions
} from "@codingame/monaco-vscode-files-service-override";

const DATABASE = "momoscript-workspace-v1";
const STORE = "files";

interface StoredEntry {
  path: string;
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  data: Uint8Array;
}

export class MmtIndexedDbFileSystemProvider implements FileSystemProvider {
  readonly #changes = new vscode.EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile = this.#changes.event;
  readonly #entries = new Map<string, StoredEntry>();

  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<MmtIndexedDbFileSystemProvider> {
    const provider = new MmtIndexedDbFileSystemProvider(await openDatabase());
    await provider.load();
    return provider;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: Uri): FileStat {
    const entry = this.require(uri.path);
    return { type: entry.type, ctime: entry.ctime, mtime: entry.mtime, size: entry.data.byteLength };
  }

  readDirectory(uri: Uri): [string, vscode.FileType][] {
    this.requireDirectory(uri.path);
    const parent = normalize(uri.path);
    const prefix = parent === "/" ? "/" : `${parent}/`;
    return [...this.#entries.values()]
      .filter((entry) => entry.path.startsWith(prefix) && entry.path !== prefix)
      .map((entry) => [entry.path.slice(prefix.length), entry.type] as [string, vscode.FileType])
      .filter(([name]) => name.length > 0 && !name.includes("/"));
  }

  async createDirectory(uri: Uri): Promise<void> {
    const path = normalize(uri.path);
    if (this.#entries.has(path)) throw vscode.FileSystemError.FileExists(uri);
    this.requireDirectory(parentPath(path));
    const entry = makeEntry(path, vscode.FileType.Directory);
    await this.persist(entry);
    this.#entries.set(path, entry);
    this.#changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  readFile(uri: Uri): Uint8Array {
    const entry = this.require(uri.path);
    if (entry.type !== vscode.FileType.File) throw vscode.FileSystemError.FileIsADirectory(uri);
    return entry.data.slice();
  }

  async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const path = normalize(uri.path);
    this.requireDirectory(parentPath(path));
    const previous = this.#entries.get(path);
    if (previous?.type === vscode.FileType.Directory) throw vscode.FileSystemError.FileIsADirectory(uri);
    if (!previous && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (previous && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    const now = Date.now();
    const entry: StoredEntry = {
      path,
      type: vscode.FileType.File,
      ctime: previous?.ctime ?? now,
      mtime: now,
      data: content.slice()
    };
    await this.persist(entry);
    this.#entries.set(path, entry);
    this.#changes.fire([{ type: previous ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: Uri, options: { readonly recursive: boolean }): Promise<void> {
    const path = normalize(uri.path);
    this.require(path);
    const descendants = this.subtree(path);
    if (!options.recursive && descendants.length > 1) throw vscode.FileSystemError.NoPermissions("Directory is not empty");
    await runTransaction(this.database, (store) => descendants.forEach((entry) => store.delete(entry.path)));
    descendants.forEach((entry) => this.#entries.delete(entry.path));
    this.#changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    oldUri: Uri,
    newUri: Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const oldPath = normalize(oldUri.path);
    const newPath = normalize(newUri.path);
    this.require(oldPath);
    this.requireDirectory(parentPath(newPath));
    if (newPath.startsWith(`${oldPath}/`)) throw vscode.FileSystemError.NoPermissions("Cannot move a directory into itself");
    const target = this.#entries.get(newPath);
    if (target && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
    const sourceEntries = this.subtree(oldPath);
    const targetEntries = target ? this.subtree(newPath) : [];
    const moved = sourceEntries.map((entry) => ({
      ...entry,
      path: `${newPath}${entry.path.slice(oldPath.length)}`,
      mtime: Date.now(),
      data: entry.data.slice()
    }));
    await runTransaction(this.database, (store) => {
      targetEntries.forEach((entry) => store.delete(entry.path));
      sourceEntries.forEach((entry) => store.delete(entry.path));
      moved.forEach((entry) => store.put(entry));
    });
    targetEntries.forEach((entry) => this.#entries.delete(entry.path));
    sourceEntries.forEach((entry) => this.#entries.delete(entry.path));
    moved.forEach((entry) => this.#entries.set(entry.path, entry));
    this.#changes.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    ]);
  }

  dispose(): void {
    this.#changes.dispose();
    this.database.close();
  }

  private async load(): Promise<void> {
    const entries = await readAll(this.database);
    entries.forEach((entry) => this.#entries.set(entry.path, { ...entry, data: new Uint8Array(entry.data) }));
    if (!this.#entries.has("/")) await this.persistAndRemember(makeEntry("/", vscode.FileType.Directory));
    const legacyWorkspace = this.#entries.get("/workspace");
    if (
      legacyWorkspace?.type === vscode.FileType.Directory
      && this.subtree("/workspace").length === 1
    ) {
      await runTransaction(this.database, (store) => store.delete("/workspace"));
      this.#entries.delete("/workspace");
    }
  }

  private subtree(path: string): StoredEntry[] {
    return [...this.#entries.values()].filter((entry) => entry.path === path || entry.path.startsWith(`${path}/`));
  }

  private require(path: string): StoredEntry {
    const entry = this.#entries.get(normalize(path));
    if (!entry) throw vscode.FileSystemError.FileNotFound(path);
    return entry;
  }

  private requireDirectory(path: string): StoredEntry {
    const entry = this.require(path);
    if (entry.type !== vscode.FileType.Directory) throw vscode.FileSystemError.FileNotADirectory(path);
    return entry;
  }

  private async persistAndRemember(entry: StoredEntry): Promise<void> {
    await this.persist(entry);
    this.#entries.set(entry.path, entry);
  }

  private persist(entry: StoredEntry): Promise<void> {
    return runTransaction(this.database, (store) => {
      store.put(entry);
    });
  }
}

export class MmtWorkbenchFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  readonly #changes = new Emitter<readonly IFileChange[]>();
  readonly onDidChangeFile = this.#changes.event;
  readonly #subscription: vscode.Disposable;

  constructor(private readonly provider: MmtIndexedDbFileSystemProvider) {
    this.#subscription = provider.onDidChangeFile((changes) => {
      this.#changes.fire(
        changes.map((change) => ({
          type:
            change.type === vscode.FileChangeType.Created
              ? WorkbenchFileChangeType.ADDED
              : change.type === vscode.FileChangeType.Deleted
                ? WorkbenchFileChangeType.DELETED
                : WorkbenchFileChangeType.UPDATED,
          resource: change.uri
        }))
      );
    });
  }

  watch(_resource: URI, _options: IWatchOptions): vscode.Disposable {
    return this.provider.watch();
  }

  async stat(resource: URI): Promise<IStat> {
    return this.provider.stat(resource);
  }

  mkdir(resource: URI): Promise<void> {
    return this.provider.createDirectory(resource);
  }

  readdir(resource: URI): Promise<[string, vscode.FileType][]> {
    return Promise.resolve(this.provider.readDirectory(resource));
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    return this.provider.readFile(resource);
  }

  writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<void> {
    return this.provider.writeFile(resource, content, options);
  }

  delete(resource: URI, options: { recursive: boolean }): Promise<void> {
    return this.provider.delete(resource, options);
  }

  rename(from: URI, to: URI, options: { overwrite: boolean }): Promise<void> {
    return this.provider.rename(from, to, options);
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#changes.dispose();
  }
}

function normalize(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function parentPath(value: string): string {
  const normalized = normalize(value);
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

function makeEntry(path: string, type: vscode.FileType): StoredEntry {
  const now = Date.now();
  return { path: normalize(path), type, ctime: now, mtime: now, data: new Uint8Array() };
}

function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "path" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked"));
  return promise;
}

function readAll(database: IDBDatabase): Promise<StoredEntry[]> {
  const { promise, resolve, reject } = Promise.withResolvers<StoredEntry[]>();
  const request = database.transaction(STORE).objectStore(STORE).getAll();
  request.onsuccess = () => resolve(request.result as StoredEntry[]);
  request.onerror = () => reject(request.error);
  return promise;
}

function runTransaction(database: IDBDatabase, body: (store: IDBObjectStore) => void): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const transaction = database.transaction(STORE, "readwrite");
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  body(transaction.objectStore(STORE));
  return promise;
}
