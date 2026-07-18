import * as vscode from "vscode";
import {
  canonicalArchivePath,
  digestPackageFiles,
  packageGenerationDigest,
  validateTypstManifest,
  type ValidatedPackageFile
} from "../../vscode/src/typstPackageArchive";
import { checkedPackageSpec, packageSpecKey, type PackageSpec } from "../../vscode/src/typstPackageProtocol";
import {
  materializePackageGeneration,
  type TypstPackageCacheAdapter,
  type TypstPackageGeneration
} from "../../vscode/src/typstPackageService";
import type { TypstPackageCacheStorageOwner } from "./packageCacheStorage";
import type { RuntimeOwnedResource } from "./runtimeOwner";

const DATABASE = "momoscript-typst-package-cache-v1";
const GENERATIONS = "generations";
const ACTIVE = "active";

interface StoredGeneration {
  readonly packageGeneration: string;
  readonly spec: PackageSpec;
  readonly registryId: string;
  readonly archiveDigest: string;
  readonly filesDigest: string;
  readonly entrypoint: string;
  readonly expandedBytes: number;
  readonly files: readonly { readonly path: string; readonly bytes: ArrayBuffer }[];
}

interface ActiveGeneration {
  readonly specKey: string;
  readonly packageGeneration: string;
}

export class IndexedDbTypstPackageCache implements TypstPackageCacheAdapter, RuntimeOwnedResource {
  readonly #loaded = new Map<string, TypstPackageGeneration>();
  #queue = Promise.resolve();
  #disposed = false;

  private constructor(
    readonly database: IDBDatabase,
    private readonly storage: TypstPackageCacheStorageOwner,
    private readonly invalidateDependents: (packageGeneration: string) => void | Promise<void>
  ) {}

  static async open(
    storage: TypstPackageCacheStorageOwner,
    invalidateDependents: (packageGeneration: string) => void | Promise<void>
  ): Promise<IndexedDbTypstPackageCache> {
    const database = await openDatabase();
    const cache = new IndexedDbTypstPackageCache(database, storage, invalidateDependents);
    for (const record of await getAll<StoredGeneration>(database, GENERATIONS)) {
      const generation = await decodeStoredGeneration(record);
      cache.#loaded.set(generation.packageGeneration, generation);
      await storage.registerExisting(cache.registration(generation));
    }
    return cache;
  }

  async active(spec: PackageSpec): Promise<TypstPackageGeneration | undefined> {
    this.assertActive();
    const pointer = await get<ActiveGeneration>(this.database, ACTIVE, packageSpecKey(spec));
    return pointer ? this.loadGeneration(pointer.packageGeneration) : undefined;
  }

  activate(generation: TypstPackageGeneration, signal: AbortSignal): Promise<TypstPackageGeneration> {
    return this.serialized(async () => {
      this.assertActive();
      if (signal.aborted) throw abortReason(signal);
      let immutable = await this.loadGeneration(generation.packageGeneration);
      if (!immutable) {
        const metadataBytes = generation.files.reduce((total, file) => total + file.path.length * 2 + 32, 256);
        const reservation = await this.storage.reserve({
          purpose: `typst-package:${generation.packageGeneration}`,
          decodedBytes: generation.expandedBytes,
          metadataBytes,
          workspaceGrowthBytes: 0
        });
        try {
          await put(this.database, GENERATIONS, encodeStoredGeneration(generation));
          if (signal.aborted) throw abortReason(signal);
          await this.storage.commit(reservation.token, this.registration(generation));
          immutable = generation;
          this.#loaded.set(generation.packageGeneration, generation);
        } catch (error) {
          await remove(this.database, GENERATIONS, generation.packageGeneration).catch(() => {});
          await this.storage.release(reservation.token).catch(() => {});
          throw error;
        }
      }
      if (signal.aborted) throw abortReason(signal);
      await put(this.database, ACTIVE, {
        specKey: packageSpecKey(immutable.spec),
        packageGeneration: immutable.packageGeneration
      } satisfies ActiveGeneration);
      return immutable;
    });
  }

  async read(uri: string): Promise<Uint8Array | undefined> {
    this.assertActive();
    const parsed = new URL(uri);
    if (parsed.protocol !== "mmt-package:") return undefined;
    const digest = parsed.searchParams.get("digest");
    if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
    const generation = await this.loadGeneration(digest);
    return generation?.internalFiles.find((file) => file.uri === uri)?.bytes.slice();
  }

  evict(packageGeneration: string): Promise<void> {
    return this.serialized(() => this.evictBytes(packageGeneration));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loaded.clear();
    this.database.close();
  }

  private async loadGeneration(packageGeneration: string): Promise<TypstPackageGeneration | undefined> {
    const loaded = this.#loaded.get(packageGeneration);
    if (loaded) return loaded;
    const record = await get<StoredGeneration>(this.database, GENERATIONS, packageGeneration);
    if (!record) return undefined;
    const generation = await decodeStoredGeneration(record);
    this.#loaded.set(packageGeneration, generation);
    return generation;
  }

  private registration(generation: TypstPackageGeneration) {
    return {
      generationId: generation.packageGeneration,
      bytes: generation.expandedBytes,
      evictBytes: () => this.evictBytes(generation.packageGeneration),
      invalidateDependents: () => this.invalidateDependents(generation.packageGeneration)
    };
  }

  private async evictBytes(packageGeneration: string): Promise<void> {
    const active = (await getAll<ActiveGeneration>(this.database, ACTIVE))
      .filter((pointer) => pointer.packageGeneration === packageGeneration);
    await transaction(this.database, [GENERATIONS, ACTIVE], (stores) => {
      stores.get(GENERATIONS)?.delete(packageGeneration);
      for (const pointer of active) stores.get(ACTIVE)?.delete(pointer.specKey);
    });
    this.#loaded.delete(packageGeneration);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#queue.then(operation, operation);
    this.#queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error("IndexedDB Typst package cache is disposed");
  }
}

function encodeStoredGeneration(generation: TypstPackageGeneration): StoredGeneration {
  return {
    packageGeneration: generation.packageGeneration,
    spec: generation.spec,
    registryId: generation.registryId,
    archiveDigest: generation.archiveDigest,
    filesDigest: generation.filesDigest,
    entrypoint: generation.entrypoint,
    expandedBytes: generation.expandedBytes,
    files: generation.files.map((file) => ({
      path: file.path,
      bytes: file.bytes.slice().buffer as ArrayBuffer
    }))
  };
}
export class WebTypstPackageFileSystemProvider implements vscode.FileSystemProvider {
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = () => ({ dispose() {} });

  constructor(private readonly cache: TypstPackageCacheAdapter) {}

  watch(): vscode.Disposable { return { dispose() {} }; }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.cache.read(uri.toString());
    if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const bytes = await this.cache.read(uri.toString());
    if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
    return bytes;
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(oldUri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(oldUri); }
}


async function decodeStoredGeneration(record: StoredGeneration): Promise<TypstPackageGeneration> {
  if (!isRecord(record)
    || typeof record.packageGeneration !== "string"
    || typeof record.registryId !== "string"
    || typeof record.archiveDigest !== "string"
    || typeof record.filesDigest !== "string"
    || typeof record.entrypoint !== "string"
    || !Number.isSafeInteger(record.expandedBytes)
    || !Array.isArray(record.files)) {
    throw new Error("Invalid IndexedDB Typst package generation");
  }
  const spec = checkedPackageSpec(record.spec);
  const files: ValidatedPackageFile[] = record.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== "string" || !(file.bytes instanceof ArrayBuffer)) {
      throw new Error("Invalid IndexedDB Typst package file");
    }
    return Object.freeze({ path: canonicalArchivePath(file.path), bytes: new Uint8Array(file.bytes.slice(0)) });
  });
  const filesDigest = await digestPackageFiles(files);
  if (filesDigest !== record.filesDigest) throw new Error("IndexedDB Typst package file digest mismatch");
  const packageGeneration = await packageGenerationDigest(record.registryId, spec, record.archiveDigest, filesDigest);
  if (packageGeneration !== record.packageGeneration) throw new Error("IndexedDB Typst package generation digest mismatch");
  const entrypoint = validateTypstManifest(spec, files);
  if (entrypoint !== record.entrypoint) throw new Error("IndexedDB Typst package entrypoint mismatch");
  const expandedBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (expandedBytes !== record.expandedBytes) throw new Error("IndexedDB Typst package byte count mismatch");
  return materializePackageGeneration(Object.freeze({
    spec,
    registryId: record.registryId,
    archiveDigest: record.archiveDigest,
    filesDigest,
    packageGeneration,
    entrypoint,
    expandedBytes,
    files: Object.freeze(files)
  }));
}

function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(GENERATIONS)) request.result.createObjectStore(GENERATIONS, { keyPath: "packageGeneration" });
    if (!request.result.objectStoreNames.contains(ACTIVE)) request.result.createObjectStore(ACTIVE, { keyPath: "specKey" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

function get<T>(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
  const request = database.transaction(storeName).objectStore(storeName).get(key);
  request.onsuccess = () => resolve(request.result as T | undefined);
  request.onerror = () => reject(request.error);
  return promise;
}

function getAll<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
  const { promise, resolve, reject } = Promise.withResolvers<T[]>();
  const request = database.transaction(storeName).objectStore(storeName).getAll();
  request.onsuccess = () => resolve(request.result as T[]);
  request.onerror = () => reject(request.error);
  return promise;
}

function put(database: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  return transaction(database, [storeName], (stores) => stores.get(storeName)?.put(value));
}

function remove(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return transaction(database, [storeName], (stores) => stores.get(storeName)?.delete(key));
}

function transaction(
  database: IDBDatabase,
  storeNames: readonly string[],
  body: (stores: Map<string, IDBObjectStore>) => void
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const current = database.transaction(storeNames, "readwrite");
  const stores = new Map(storeNames.map((name) => [name, current.objectStore(name)]));
  current.oncomplete = () => resolve();
  current.onerror = () => reject(current.error);
  current.onabort = () => reject(current.error ?? new Error("IndexedDB Typst package transaction aborted"));
  body(stores);
  return promise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Typst package cache activation cancelled", "AbortError");
}
