export const ORIGIN_STORAGE_PROTOCOL = "mmt-origin-storage.v1" as const;
export const ORIGIN_STORAGE_SCHEMA_VERSION = 1 as const;
export const ORIGIN_STORAGE_DEFAULT_TTL_MS = 5 * 60_000;

const MIB = 1024 * 1024;
const DB_NAME = "momoscript-origin-storage";
const INVENTORY_STORE = "inventory";
const RESERVATION_STORE = "reservations";
const ORIGIN_LOCK = "momoscript-origin-storage-coordinator";

export type StorageOwner = "workspace" | "history" | "shell" | "pack" | "materializer";
export type StorageClass =
  | "workspace-protected"
  | "history-managed"
  | "shell-active"
  | "shell-previous"
  | "shell-staging"
  | "pack-active"
  | "pack-previous"
  | "pack-staging"
  | "materialization-cache";

export interface StorageInventoryEntry {
  readonly id: string;
  readonly owner: StorageOwner;
  readonly class: StorageClass;
  readonly bytes: number;
  readonly reproducible: boolean;
  readonly active: boolean;
  readonly updatedAt: number;
}

export interface StorageReservationRequest {
  readonly owner: StorageOwner;
  readonly purpose: string;
  readonly decodedBytes: number;
  readonly metadataBytes: number;
  readonly workspaceGrowthBytes: number;
  readonly ttlMs?: number;
}

export interface StorageReservation {
  readonly token: string;
  readonly owner: StorageOwner;
  readonly purpose: string;
  readonly reservedBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "active" | "committed" | "released" | "expired";
}

export interface StoragePlan {
  readonly browserUsage: number;
  readonly trackedUsage: number;
  readonly accountedUsage: number;
  readonly quota: number;
  readonly reserved: number;
  readonly decodedBytes: number;
  readonly metadataBytes: number;
  readonly workspaceGrowthBytes: number;
  readonly margin: number;
  readonly required: number;
  readonly protectedBytes: number;
  readonly reclaimableBytes: number;
  readonly reclaim: readonly StorageInventoryEntry[];
}

export interface OriginStorageSnapshot {
  readonly schemaVersion: typeof ORIGIN_STORAGE_SCHEMA_VERSION;
  readonly inventory: readonly StorageInventoryEntry[];
  readonly reservations: readonly StorageReservation[];
}

export type OriginStorageRequest =
  | { readonly protocol: typeof ORIGIN_STORAGE_PROTOCOL; readonly type: "snapshot"; readonly requestId: string }
  | { readonly protocol: typeof ORIGIN_STORAGE_PROTOCOL; readonly type: "register-inventory"; readonly requestId: string; readonly inventory: readonly Omit<StorageInventoryEntry, "updatedAt">[] }
  | { readonly protocol: typeof ORIGIN_STORAGE_PROTOCOL; readonly type: "reserve"; readonly requestId: string; readonly reservation: StorageReservationRequest }
  | { readonly protocol: typeof ORIGIN_STORAGE_PROTOCOL; readonly type: "release"; readonly requestId: string; readonly token: string }
  | { readonly protocol: typeof ORIGIN_STORAGE_PROTOCOL; readonly type: "commit"; readonly requestId: string; readonly token: string; readonly inventory: Omit<StorageInventoryEntry, "updatedAt"> };

export type OriginStorageResponse =
  | { readonly protocol: typeof ORIGIN_STORAGE_PROTOCOL; readonly requestId: string; readonly ok: true; readonly snapshot?: OriginStorageSnapshot; readonly reservation?: StorageReservation }
  | { readonly protocol: typeof ORIGIN_STORAGE_PROTOCOL; readonly requestId: string; readonly ok: false; readonly error: { readonly code: "InvalidRequest" | "QuotaBlocked" | "UnknownReservation" | "ReservationInactive"; readonly message: string } };

export class OriginStorageCoordinator {
  #queue = Promise.resolve();

  readonly database: IDBDatabase;

  private constructor(database: IDBDatabase) {
    this.database = database;
  }

  static async open(): Promise<OriginStorageCoordinator> {
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const operation = indexedDB.open(DB_NAME, ORIGIN_STORAGE_SCHEMA_VERSION);
    operation.onupgradeneeded = () => {
      const database = operation.result;
      if (!database.objectStoreNames.contains(INVENTORY_STORE)) database.createObjectStore(INVENTORY_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(RESERVATION_STORE)) database.createObjectStore(RESERVATION_STORE, { keyPath: "token" });
    };
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
    const coordinator = new OriginStorageCoordinator(await promise);
    await coordinator.withOriginLock(() => coordinator.expireReservations());
    return coordinator;
  }

  async snapshot(): Promise<OriginStorageSnapshot> {
    return this.withOriginLock(async () => {
      await this.expireReservations();
      return {
        schemaVersion: ORIGIN_STORAGE_SCHEMA_VERSION,
        inventory: await this.readInventory(),
        reservations: await this.readActiveReservations(),
      };
    });
  }

  async inventory(): Promise<readonly StorageInventoryEntry[]> {
    return this.readInventory();
  }

  async reservations(): Promise<readonly StorageReservation[]> {
    return this.withOriginLock(async () => {
      await this.expireReservations();
      return this.readActiveReservations();
    });
  }

  async register(entry: Omit<StorageInventoryEntry, "updatedAt">): Promise<void> {
    await this.withOriginLock(async () => {
      validateInventory(entry);
      await transaction(this.database, [INVENTORY_STORE], (tx) => {
        tx.objectStore(INVENTORY_STORE).put({ ...entry, updatedAt: Date.now() } satisfies StorageInventoryEntry);
      });
    });
  }

  async unregister(id: string): Promise<void> {
    await this.withOriginLock(async () => {
      const existing = (await this.readInventory()).find((entry) => entry.id === id);
      if (existing && (!existing.reproducible || existing.class === "workspace-protected" || existing.class === "history-managed" || existing.class === "shell-active")) {
        throw new Error(`Protected storage entry cannot be removed: ${id}`);
      }
      await transaction(this.database, [INVENTORY_STORE], (tx) => tx.objectStore(INVENTORY_STORE).delete(id));
    });
  }

  async plan(request: StorageReservationRequest): Promise<StoragePlan> {
    return this.withOriginLock(async () => {
      validateReservationRequest(request);
      await this.expireReservations();
      return this.buildPlan(request, await this.readInventory(), await this.readActiveReservations());
    });
  }

  async reserve(request: StorageReservationRequest): Promise<StorageReservation> {
    return this.withOriginLock(async () => {
      validateReservationRequest(request);
      await this.expireReservations();
      const plan = await this.buildPlan(request, await this.readInventory(), await this.readActiveReservations());
      if (plan.accountedUsage + plan.reserved + plan.required > plan.quota) throw new StorageQuotaBlocked(plan);
      const now = Date.now();
      const reservation: StorageReservation = {
        token: crypto.randomUUID(),
        owner: request.owner,
        purpose: request.purpose,
        reservedBytes: plan.required,
        createdAt: now,
        expiresAt: now + (request.ttlMs ?? ORIGIN_STORAGE_DEFAULT_TTL_MS),
        state: "active",
      };
      await transaction(this.database, [RESERVATION_STORE], (tx) => tx.objectStore(RESERVATION_STORE).put(reservation));
      return reservation;
    });
  }

  async commit(token: string, entry: Omit<StorageInventoryEntry, "updatedAt">): Promise<void> {
    await this.withOriginLock(async () => {
      await this.expireReservations();
      const reservation = await this.requireReservation(token);
      assertActiveReservation(reservation);
      validateInventory(entry);
      if (entry.owner !== reservation.owner) throw new Error("Reservation owner mismatch");
      if (entry.bytes > reservation.reservedBytes) throw new Error("Inventory exceeds reserved bytes");
      await transaction(this.database, [INVENTORY_STORE, RESERVATION_STORE], (tx) => {
        tx.objectStore(INVENTORY_STORE).put({ ...entry, updatedAt: Date.now() } satisfies StorageInventoryEntry);
        tx.objectStore(RESERVATION_STORE).put({ ...reservation, state: "committed" } satisfies StorageReservation);
      });
    });
  }

  async registerAndReserveHistory(current: readonly Omit<StorageInventoryEntry, "updatedAt">[], desiredHistoryBytes: number): Promise<StorageReservation> {
    return this.withOriginLock(async () => {
      validateBytes(desiredHistoryBytes);
      for (const entry of current) {
        validateInventory(entry);
        if (entry.owner !== "workspace" && entry.owner !== "history") throw new Error("History allocation may only register workspace/history inventory");
      }
      await this.expireReservations();
      const previous = await this.readInventory();
      const replacementIds = new Set(current.map((entry) => entry.id));
      const nextInventory = [...previous.filter((entry) => !replacementIds.has(entry.id)), ...current.map((entry) => ({ ...entry, updatedAt: Date.now() }))];
      const request: StorageReservationRequest = {
        owner: "history",
        purpose: "history-desired-budget",
        decodedBytes: desiredHistoryBytes,
        metadataBytes: 0,
        workspaceGrowthBytes: 0,
      };
      const plan = await this.buildPlan(request, nextInventory, await this.readActiveReservations());
      if (plan.accountedUsage + plan.reserved + plan.required > plan.quota) throw new StorageQuotaBlocked(plan);
      const now = Date.now();
      const reservation: StorageReservation = {
        token: crypto.randomUUID(),
        owner: "history",
        purpose: request.purpose,
        reservedBytes: plan.required,
        createdAt: now,
        expiresAt: now + ORIGIN_STORAGE_DEFAULT_TTL_MS,
        state: "active",
      };
      await transaction(this.database, [INVENTORY_STORE, RESERVATION_STORE], (tx) => {
        const inventory = tx.objectStore(INVENTORY_STORE);
        for (const entry of current) inventory.put({ ...entry, updatedAt: now } satisfies StorageInventoryEntry);
        tx.objectStore(RESERVATION_STORE).put(reservation);
      });
      return reservation;
    });
  }

  async release(token: string): Promise<void> {
    await this.withOriginLock(async () => {
      const reservation = await this.requireReservation(token);
      if (reservation.state !== "active") return;
      await transaction(this.database, [RESERVATION_STORE], (tx) => {
        tx.objectStore(RESERVATION_STORE).put({ ...reservation, state: "released" } satisfies StorageReservation);
      });
    });
  }

  async persisted(): Promise<boolean> {
    return navigator.storage.persisted();
  }

  async requestPersistence(): Promise<boolean> {
    return navigator.storage.persist();
  }

  close(): void {
    this.database.close();
  }

  private async buildPlan(request: StorageReservationRequest, inventory: readonly StorageInventoryEntry[], reservations: readonly StorageReservation[]): Promise<StoragePlan> {
    const estimate = await navigator.storage.estimate();
    const browserUsage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    validateBytes(browserUsage);
    validateBytes(quota);
    const trackedUsage = inventory.reduce((total, entry) => total + entry.bytes, 0);
    const accountedUsage = Math.max(browserUsage, trackedUsage);
    const reserved = reservations.reduce((total, entry) => total + entry.reservedBytes, 0);
    const margin = Math.max(64 * MIB, Math.ceil(request.decodedBytes * 0.2));
    const required = request.decodedBytes + request.metadataBytes + request.workspaceGrowthBytes + margin;
    if (!Number.isSafeInteger(required)) throw new Error("Storage reservation exceeds the safe integer range");
    const protectedBytes = inventory.filter((entry) => !entry.reproducible || entry.class === "workspace-protected" || entry.class === "history-managed" || entry.class === "shell-active").reduce((total, entry) => total + entry.bytes, 0);
    const rank: Record<StorageClass, number> = {
      "shell-staging": 0,
      "pack-staging": 0,
      "materialization-cache": 1,
      "pack-previous": 2,
      "shell-previous": 3,
      "pack-active": 4,
      "history-managed": 99,
      "workspace-protected": 99,
      "shell-active": 99,
    };
    const candidates = inventory
      .filter((entry) => entry.reproducible && rank[entry.class] < 99)
      .sort((left, right) => rank[left.class] - rank[right.class] || left.updatedAt - right.updatedAt || compareBytes(left.id, right.id));
    const reclaimableBytes = candidates.reduce((total, entry) => total + entry.bytes, 0);
    const shortage = Math.max(0, accountedUsage + reserved + required - quota);
    const reclaim: StorageInventoryEntry[] = [];
    let reclaimed = 0;
    for (const entry of candidates) {
      if (reclaimed >= shortage) break;
      reclaim.push(entry);
      reclaimed += entry.bytes;
    }
    return {
      browserUsage,
      trackedUsage,
      accountedUsage,
      quota,
      reserved,
      decodedBytes: request.decodedBytes,
      metadataBytes: request.metadataBytes,
      workspaceGrowthBytes: request.workspaceGrowthBytes,
      margin,
      required,
      protectedBytes,
      reclaimableBytes,
      reclaim,
    };
  }

  private async readInventory(): Promise<StorageInventoryEntry[]> {
    return getAll<StorageInventoryEntry>(this.database, INVENTORY_STORE);
  }

  private async readActiveReservations(): Promise<StorageReservation[]> {
    return (await getAll<StorageReservation>(this.database, RESERVATION_STORE)).filter((entry) => entry.state === "active" && entry.expiresAt > Date.now());
  }

  private async requireReservation(token: string): Promise<StorageReservation> {
    const value = await get<StorageReservation>(this.database, RESERVATION_STORE, token);
    if (!value) throw new Error(`Unknown storage reservation ${token}`);
    return value;
  }

  private async expireReservations(): Promise<void> {
    const expired = (await getAll<StorageReservation>(this.database, RESERVATION_STORE)).filter((entry) => entry.state === "active" && entry.expiresAt <= Date.now());
    if (expired.length === 0) return;
    await transaction(this.database, [RESERVATION_STORE], (tx) => {
      const reservations = tx.objectStore(RESERVATION_STORE);
      for (const entry of expired) reservations.put({ ...entry, state: "expired" } satisfies StorageReservation);
    });
  }

  private async withOriginLock<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#queue.then(async () => {
      const locks = globalThis.navigator?.locks;
      if (!locks) return operation();
      return locks.request(ORIGIN_LOCK, { mode: "exclusive" }, operation);
    });
    this.#queue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

export class StorageQuotaBlocked extends Error {
  readonly plan: StoragePlan;

  constructor(plan: StoragePlan) {
    super(plan.reclaim.length > 0 ? "Origin storage requires explicit reclamation before reservation" : "Origin storage does not have enough space");
    this.name = "StorageQuotaBlocked";
    this.plan = plan;
  }
}

function assertActiveReservation(reservation: StorageReservation): void {
  if (reservation.state !== "active") throw new Error(`Storage reservation is not active: ${reservation.token}`);
  if (reservation.expiresAt <= Date.now()) throw new Error(`Storage reservation expired: ${reservation.token}`);
}

function validateInventory(entry: Omit<StorageInventoryEntry, "updatedAt">): void {
  if (entry.id.length === 0) throw new Error("Storage inventory id must not be empty");
  validateBytes(entry.bytes);
}

function validateReservationRequest(request: StorageReservationRequest): void {
  if (request.purpose.length === 0) throw new Error("Storage reservation purpose must not be empty");
  validateBytes(request.decodedBytes);
  validateBytes(request.metadataBytes);
  validateBytes(request.workspaceGrowthBytes);
  if (request.ttlMs !== undefined && (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0)) throw new Error(`Invalid reservation TTL ${request.ttlMs}`);
}

function validateBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid byte count ${value}`);
}

function compareBytes(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}

function getAll<T>(database: IDBDatabase, store: string): Promise<T[]> {
  return request<T[]>(database.transaction(store).objectStore(store).getAll());
}

function get<T>(database: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return request<T | undefined>(database.transaction(store).objectStore(store).get(key));
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  operation.onsuccess = () => resolve(operation.result);
  operation.onerror = () => reject(operation.error);
  return promise;
}

function transaction(database: IDBDatabase, stores: readonly string[], body: (transaction: IDBTransaction) => void): Promise<void> {
  const operation = database.transaction([...stores], "readwrite");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  operation.oncomplete = () => resolve();
  operation.onerror = () => reject(operation.error);
  operation.onabort = () => reject(operation.error);
  try {
    body(operation);
  } catch (error) {
    operation.abort();
    reject(error);
  }
  return promise;
}
