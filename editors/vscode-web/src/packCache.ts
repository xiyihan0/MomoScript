import type { PackCacheStore } from "../../vscode/src/packSync";

const DATABASE = "momoscript-pack-cache-v1";
const ACTIVE = "active";
const STAGING = "staging";
const META = "meta";

export class IndexedDbPackCache implements PackCacheStore {
  readonly #etags = new Map<string, string>();

  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<IndexedDbPackCache> {
    const database = await openDatabase();
    const cache = new IndexedDbPackCache(database);
    const etags = await getAll<{ url: string; etag: string }>(database, META);
    for (const item of etags) cache.#etags.set(item.url, item.etag);
    return cache;
  }

  async read(url: string): Promise<string | undefined> {
    return (await get<{ url: string; json: string }>(this.database, ACTIVE, url))?.json;
  }

  stage(url: string, revision: number, json: string): Promise<void> {
    return put(this.database, STAGING, { key: stageKey(url, revision), url, json });
  }

  async promote(url: string, revision: number): Promise<void> {
    const staged = await get<{ key: string; url: string; json: string }>(this.database, STAGING, stageKey(url, revision));
    if (!staged) throw new Error(`Missing staged pack manifest for ${url}`);
    await transaction(this.database, [ACTIVE, STAGING], "readwrite", (stores) => {
      stores.get(ACTIVE)?.put({ url, json: staged.json });
      stores.get(STAGING)?.delete(staged.key);
    });
  }

  discard(url: string, revision: number): Promise<void> {
    return remove(this.database, STAGING, stageKey(url, revision));
  }

  getEtag(url: string): string | undefined {
    return this.#etags.get(url);
  }

  async setEtag(url: string, etag: string | undefined): Promise<void> {
    if (etag === undefined) {
      this.#etags.delete(url);
      await remove(this.database, META, url);
      return;
    }
    await put(this.database, META, { url, etag });
    this.#etags.set(url, etag);
  }

  dispose(): void {
    this.database.close();
  }
}

function stageKey(url: string, revision: number): string {
  return `${revision}:${url}`;
}

function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(ACTIVE, { keyPath: "url" });
    request.result.createObjectStore(STAGING, { keyPath: "key" });
    request.result.createObjectStore(META, { keyPath: "url" });
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
  return transaction(database, [storeName], "readwrite", (stores) => {
    stores.get(storeName)?.put(value);
  });
}

function remove(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return transaction(database, [storeName], "readwrite", (stores) => {
    stores.get(storeName)?.delete(key);
  });
}

function transaction(
  database: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  body: (stores: Map<string, IDBObjectStore>) => void
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const current = database.transaction(storeNames, mode);
  const stores = new Map(storeNames.map((name) => [name, current.objectStore(name)]));
  current.oncomplete = () => resolve();
  current.onerror = () => reject(current.error);
  current.onabort = () => reject(current.error ?? new Error("IndexedDB transaction aborted"));
  body(stores);
  return promise;
}
