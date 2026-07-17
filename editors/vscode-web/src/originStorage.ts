export const ORIGIN_STORAGE_PROTOCOL = "mmt-origin-storage.v1" as const;
export type StorageClass = "workspace-protected" | "history-managed" | "shell-active" | "shell-previous" | "shell-staging" | "pack-active" | "pack-previous" | "pack-staging" | "materialization-cache";
export interface StorageInventoryEntry { readonly id: string; readonly owner: "workspace" | "history" | "shell" | "pack" | "materializer"; readonly class: StorageClass; readonly bytes: number; readonly reproducible: boolean; readonly active: boolean; readonly updatedAt: number; }
export interface StorageReservation { readonly token: string; readonly owner: StorageInventoryEntry["owner"]; readonly purpose: string; readonly bytes: number; readonly createdAt: number; readonly expiresAt: number; readonly state: "active" | "committed" | "released"; }
export interface StoragePlan { readonly usage: number; readonly quota: number; readonly reserved: number; readonly required: number; readonly margin: number; readonly reclaim: readonly StorageInventoryEntry[]; }
export type OriginStorageMessage =
  | { protocol: typeof ORIGIN_STORAGE_PROTOCOL; type: "reserve"; requestId: string; owner: StorageReservation["owner"]; purpose: string; bytes: number }
  | { protocol: typeof ORIGIN_STORAGE_PROTOCOL; type: "release"; requestId: string; token: string }
  | { protocol: typeof ORIGIN_STORAGE_PROTOCOL; type: "commit"; requestId: string; token: string; inventory: StorageInventoryEntry }
  | { protocol: typeof ORIGIN_STORAGE_PROTOCOL; type: "snapshot"; requestId: string };

const DB = "momoscript-origin-storage";
const INVENTORY = "inventory";
const RESERVATIONS = "reservations";
const STATE = "state";
const DEFAULT_RESERVATION_TTL_MS = 5 * 60_000;

export class OriginStorageCoordinator {
  #queue = Promise.resolve();
  private constructor(readonly database: IDBDatabase) {}

  static async open(): Promise<OriginStorageCoordinator> {
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INVENTORY)) database.createObjectStore(INVENTORY, { keyPath: "id" });
      if (!database.objectStoreNames.contains(RESERVATIONS)) database.createObjectStore(RESERVATIONS, { keyPath: "token" });
      if (!database.objectStoreNames.contains(STATE)) database.createObjectStore(STATE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    const coordinator = new OriginStorageCoordinator(await promise);
    await coordinator.expireReservations();
    return coordinator;
  }

  async inventory(): Promise<readonly StorageInventoryEntry[]> { return getAll<StorageInventoryEntry>(this.database, INVENTORY); }
  async reservations(): Promise<readonly StorageReservation[]> { return (await getAll<StorageReservation>(this.database, RESERVATIONS)).filter((entry) => entry.state === "active"); }

  async register(entry: Omit<StorageInventoryEntry, "updatedAt">): Promise<void> {
    validateBytes(entry.bytes);
    await transaction(this.database, [INVENTORY], (tx) => tx.objectStore(INVENTORY).put({ ...entry, updatedAt: Date.now() } satisfies StorageInventoryEntry));
  }

  async unregister(id: string): Promise<void> {
    const existing = (await this.inventory()).find((entry) => entry.id === id);
    if (existing?.class === "workspace-protected" || (existing?.active && existing.class === "shell-active")) throw new Error(`Protected storage entry cannot be removed: ${id}`);
    await transaction(this.database, [INVENTORY], (tx) => tx.objectStore(INVENTORY).delete(id));
  }

  async plan(bytes: number): Promise<StoragePlan> {
    validateBytes(bytes);
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0; const quota = estimate.quota ?? 0;
    const reserved = (await this.reservations()).reduce((total, entry) => total + entry.bytes, 0);
    const margin = Math.max(64 * 1024 * 1024, Math.ceil(quota * 0.2));
    const required = bytes + reserved + margin;
    const shortage = Math.max(0, usage + required - quota);
    const rank: Record<StorageClass, number> = { "shell-staging": 0, "pack-staging": 0, "materialization-cache": 1, "pack-previous": 2, "shell-previous": 3, "pack-active": 4, "history-managed": 99, "workspace-protected": 99, "shell-active": 99 };
    const candidates = (await this.inventory()).filter((entry) => entry.reproducible && rank[entry.class] < 99).sort((a, b) => rank[a.class] - rank[b.class] || a.updatedAt - b.updatedAt || compareBytes(a.id, b.id));
    const reclaim: StorageInventoryEntry[] = []; let reclaimed = 0;
    for (const entry of candidates) { if (reclaimed >= shortage) break; reclaim.push(entry); reclaimed += entry.bytes; }
    return { usage, quota, reserved, required, margin, reclaim };
  }

  async reserve(owner: StorageReservation["owner"], purpose: string, bytes: number, ttlMs = DEFAULT_RESERVATION_TTL_MS): Promise<StorageReservation> {
    return this.withOriginLock(async () => {
      const plan = await this.plan(bytes);
      if (plan.usage + plan.required > plan.quota || plan.reclaim.length > 0) throw new StorageQuotaBlocked(plan);
      const reservation: StorageReservation = { token: crypto.randomUUID(), owner, purpose, bytes, createdAt: Date.now(), expiresAt: Date.now() + ttlMs, state: "active" };
      await transaction(this.database, [RESERVATIONS], (tx) => tx.objectStore(RESERVATIONS).put(reservation));
      return reservation;
    });
  }

  async commit(token: string, entry: Omit<StorageInventoryEntry, "updatedAt">): Promise<void> {
    await this.withOriginLock(async () => {
      const reservation = await this.requireReservation(token);
      assertActiveReservation(reservation);
      validateBytes(entry.bytes);
      if (entry.owner !== reservation.owner) throw new Error("Reservation owner mismatch");
      if (entry.bytes > reservation.bytes) throw new Error("Inventory exceeds reserved bytes");
      await transaction(this.database, [INVENTORY, RESERVATIONS], (tx) => {
        tx.objectStore(INVENTORY).put({ ...entry, updatedAt: Date.now() } satisfies StorageInventoryEntry);
        tx.objectStore(RESERVATIONS).put({ ...reservation, state: "committed" } satisfies StorageReservation);
      });
    });
  }

  async registerAndReserveHistory(current: readonly Omit<StorageInventoryEntry, "updatedAt">[], desiredHistoryBytes: number): Promise<StorageReservation> {
    return this.withOriginLock(async () => {
      for (const entry of current) if (entry.owner !== "workspace" && entry.owner !== "history") throw new Error("History allocation may only register workspace/history inventory");
      const plan = await this.plan(desiredHistoryBytes);
      if (plan.usage + plan.required > plan.quota || plan.reclaim.length > 0) throw new StorageQuotaBlocked(plan);
      const reservation: StorageReservation = { token: crypto.randomUUID(), owner: "history", purpose: "history-desired-budget", bytes: desiredHistoryBytes, createdAt: Date.now(), expiresAt: Date.now() + DEFAULT_RESERVATION_TTL_MS, state: "active" };
      await transaction(this.database, [INVENTORY, RESERVATIONS], (tx) => {
        const inventory = tx.objectStore(INVENTORY); for (const entry of current) inventory.put({ ...entry, updatedAt: Date.now() } satisfies StorageInventoryEntry);
        tx.objectStore(RESERVATIONS).put(reservation);
      });
      return reservation;
    });
  }

  async release(token: string): Promise<void> {
    await this.withOriginLock(async () => {
      const reservation = await this.requireReservation(token);
      if (reservation.state !== "active") return;
      await transaction(this.database, [RESERVATIONS], (tx) => tx.objectStore(RESERVATIONS).put({ ...reservation, state: "released" } satisfies StorageReservation));
    });
  }
  async persisted(): Promise<boolean> { return navigator.storage.persisted(); }
  async requestPersistence(): Promise<boolean> { return navigator.storage.persist(); }
  close(): void { this.database.close(); }

  private async requireReservation(token: string): Promise<StorageReservation> { const value = await get<StorageReservation>(this.database, RESERVATIONS, token); if (!value) throw new Error(`Unknown storage reservation ${token}`); return value; }
  private async expireReservations(): Promise<void> {
    const expired = (await getAll<StorageReservation>(this.database, RESERVATIONS)).filter((entry) => entry.state === "active" && entry.expiresAt <= Date.now());
    if (expired.length) await transaction(this.database, [RESERVATIONS], (tx) => { for (const entry of expired) tx.objectStore(RESERVATIONS).put({ ...entry, state: "released" } satisfies StorageReservation); });
  }
  private async withOriginLock<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#queue.then(async () => {
      const locks = globalThis.navigator?.locks;
      if (!locks) return operation();
      return new Promise<T>((resolve, reject) => {
        locks.request("momoscript-origin-storage-coordinator", { mode: "exclusive" }, async () => { try { resolve(await operation()); } catch (error) { reject(error); } }).catch(reject);
      });
    });
    this.#queue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

export class StorageQuotaBlocked extends Error {
  constructor(readonly plan: StoragePlan) {
    super(plan.reclaim.length ? "Origin storage requires explicit reclamation before reservation" : "Origin storage does not have enough space");
    this.name = "StorageQuotaBlocked";
  }
}
function assertActiveReservation(reservation: StorageReservation): void {
  if (reservation.state !== "active") throw new Error(`Storage reservation is not active: ${reservation.token}`);
  if (reservation.expiresAt <= Date.now()) throw new Error(`Storage reservation expired: ${reservation.token}`);
}
function validateBytes(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid byte count ${value}`); }
function compareBytes(left: string, right: string): number { const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right); for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }
function getAll<T>(database: IDBDatabase, store: string): Promise<T[]> { return request<T[]>(database.transaction(store).objectStore(store).getAll()); }
function get<T>(database: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> { return request<T | undefined>(database.transaction(store).objectStore(store).get(key)); }
function request<T>(operation: IDBRequest<T>): Promise<T> { const { promise, resolve, reject } = Promise.withResolvers<T>(); operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); return promise; }
function transaction(database: IDBDatabase, stores: readonly string[], body: (transaction: IDBTransaction) => void): Promise<void> { const tx = database.transaction(stores, "readwrite"); const { promise, resolve, reject } = Promise.withResolvers<void>(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); try { body(tx); } catch (error) { tx.abort(); reject(error); } return promise; }
