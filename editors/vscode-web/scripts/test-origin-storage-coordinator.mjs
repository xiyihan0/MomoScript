import assert from "node:assert/strict";
import {
  ORIGIN_STORAGE_PROTOCOL,
  ORIGIN_STORAGE_SCHEMA_VERSION,
  OriginStorageCoordinator,
  StorageQuotaBlocked,
} from "../src/originStorage.ts";

const MIB = 1024 * 1024;
const databases = new Map();
let quota = 160 * MIB;
let usage = 8 * MIB;

class FakeRequest {
  result;
  error = null;
  onsuccess = null;
  onerror = null;
  onupgradeneeded = null;
}

class FakeObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.name = name;
  }

  getAll() {
    return this.transaction.request(() => [...this.transaction.store(this.name).records.values()].map((value) => structuredClone(value)));
  }

  get(key) {
    return this.transaction.request(() => {
      const value = this.transaction.store(this.name).records.get(key);
      return value === undefined ? undefined : structuredClone(value);
    });
  }

  put(value) {
    return this.transaction.request(() => {
      const store = this.transaction.store(this.name);
      const key = value[store.keyPath];
      if (key === undefined) throw new Error(`Missing keyPath ${store.keyPath}`);
      store.records.set(key, structuredClone(value));
      return key;
    });
  }

  delete(key) {
    return this.transaction.request(() => this.transaction.store(this.name).records.delete(key));
  }
}

class FakeTransaction {
  error = null;
  oncomplete = null;
  onerror = null;
  onabort = null;
  #aborted = false;
  #pending = 0;
  #completionQueued = false;

  constructor(databaseRecord, names, mode) {
    this.databaseRecord = databaseRecord;
    this.names = names;
    this.mode = mode;
    this.working = new Map(names.map((name) => {
      const store = databaseRecord.stores.get(name);
      if (!store) throw new Error(`Unknown object store ${name}`);
      return [name, { keyPath: store.keyPath, records: new Map([...store.records].map(([key, value]) => [key, structuredClone(value)])) }];
    }));
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is outside this transaction`);
    return new FakeObjectStore(this, name);
  }

  store(name) {
    return this.working.get(name);
  }

  request(operation) {
    const request = new FakeRequest();
    this.#pending += 1;
    queueMicrotask(() => {
      if (this.#aborted) return;
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.({ target: request });
        this.#aborted = true;
        this.onerror?.({ target: this });
        return;
      } finally {
        this.#pending -= 1;
      }
      this.#queueCompletion();
    });
    return request;
  }

  abort() {
    if (this.#aborted) return;
    this.#aborted = true;
    queueMicrotask(() => this.onabort?.({ target: this }));
  }

  #queueCompletion() {
    if (this.#pending !== 0 || this.#completionQueued || this.#aborted) return;
    this.#completionQueued = true;
    queueMicrotask(() => {
      if (this.#aborted) return;
      if (this.mode === "readwrite") {
        for (const [name, store] of this.working) this.databaseRecord.stores.set(name, store);
      }
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeDatabase {
  constructor(record) {
    this.record = record;
  }

  get objectStoreNames() {
    return { contains: (name) => this.record.stores.has(name) };
  }

  createObjectStore(name, { keyPath }) {
    if (this.record.stores.has(name)) throw new Error(`Object store ${name} already exists`);
    const store = { keyPath, records: new Map() };
    this.record.stores.set(name, store);
    return store;
  }

  transaction(names, mode = "readonly") {
    return new FakeTransaction(this.record, typeof names === "string" ? [names] : [...names], mode);
  }

  close() {}
}

const fakeIndexedDb = {
  open(name, version) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      let record = databases.get(name);
      const oldVersion = record?.version ?? 0;
      if (!record) {
        record = { version, stores: new Map() };
        databases.set(name, record);
      }
      if (version < oldVersion) {
        request.error = new Error("VersionError");
        request.onerror?.({ target: request });
        return;
      }
      record.version = version;
      request.result = new FakeDatabase(record);
      if (version > oldVersion) request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
      queueMicrotask(() => request.onsuccess?.({ target: request }));
    });
    return request;
  },
};

let lockTail = Promise.resolve();
const locks = {
  request(_name, _options, operation) {
    const result = lockTail.then(operation);
    lockTail = result.then(() => undefined, () => undefined);
    return result;
  },
};

Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    locks,
    storage: {
      estimate: async () => ({ quota, usage }),
      persisted: async () => false,
      persist: async () => false,
    },
  },
});

const request = (owner, purpose, decodedBytes, ttlMs) => ({
  owner,
  purpose,
  decodedBytes,
  metadataBytes: 2 * MIB,
  workspaceGrowthBytes: 6 * MIB,
  ...(ttlMs === undefined ? {} : { ttlMs }),
});

assert.equal(ORIGIN_STORAGE_PROTOCOL, "mmt-origin-storage.v1");
assert.equal(ORIGIN_STORAGE_SCHEMA_VERSION, 1);

let coordinator = await OriginStorageCoordinator.open();
await coordinator.register({
  id: "workspace:current",
  owner: "workspace",
  class: "workspace-protected",
  bytes: 24 * MIB,
  reproducible: false,
  active: true,
});
const plan = await coordinator.plan(request("shell", "shell-B", 8 * MIB));
assert.equal(plan.trackedUsage, 24 * MIB, "tracked inventory must dominate a stale low browser estimate");
assert.equal(plan.accountedUsage, 24 * MIB);
assert.equal(plan.margin, 64 * MIB, "margin must be based on operation bytes, not quota");
assert.equal(plan.required, 80 * MIB, "decoded, metadata, margin, and workspace growth must all be reserved");

const first = await coordinator.reserve(request("shell", "shell-B", 8 * MIB));
assert.equal(first.reservedBytes, 80 * MIB);
assert.equal((await coordinator.snapshot()).reservations.length, 1);
coordinator.close();
coordinator = await OriginStorageCoordinator.open();
assert.equal((await coordinator.inventory())[0].id, "workspace:current", "inventory must survive coordinator restart");
assert.equal((await coordinator.reservations()).length, 1, "live reservation must survive coordinator restart");
await coordinator.release(first.token);
await coordinator.release(first.token);
assert.equal((await coordinator.reservations()).length, 0, "release must be durable and idempotent");

const expiring = await coordinator.reserve(request("pack", "crash-expiry", 1 * MIB, 5));
assert.equal((await coordinator.reservations()).some((entry) => entry.token === expiring.token), true);
coordinator.close();
await new Promise((resolve) => setTimeout(resolve, 15));
coordinator = await OriginStorageCoordinator.open();
assert.equal((await coordinator.reservations()).length, 0, "open after a crash must expire abandoned reservations");

quota = 120 * MIB;
usage = 8 * MIB;
const peer = await OriginStorageCoordinator.open();
const concurrent = await Promise.allSettled([
  coordinator.reserve(request("shell", "concurrent-shell", 1 * MIB)),
  peer.reserve(request("pack", "concurrent-pack", 1 * MIB)),
]);
const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
const rejected = concurrent.filter((result) => result.status === "rejected");
assert.equal(fulfilled.length, 1, "only one concurrent reservation may consume the remaining free bytes");
assert.equal(rejected.length, 1);
assert.equal(rejected[0].reason instanceof StorageQuotaBlocked, true, "the competing request must receive the normalized quota error");
assert.equal((await coordinator.reservations()).length, 1, "durable registry must contain exactly one winning reservation");
await coordinator.release(fulfilled[0].value.token);

quota = 240 * MIB;
const history = await coordinator.registerAndReserveHistory([
  {
    id: "workspace:current",
    owner: "workspace",
    class: "workspace-protected",
    bytes: 30 * MIB,
    reproducible: false,
    active: true,
  },
  {
    id: "history:pinned",
    owner: "history",
    class: "history-managed",
    bytes: 10 * MIB,
    reproducible: false,
    active: true,
  },
], 12 * MIB);
assert.equal(history.owner, "history");
assert.equal(history.purpose, "history-desired-budget");
assert.deepEqual((await coordinator.inventory()).map((entry) => entry.id).sort(), ["history:pinned", "workspace:current"]);
await coordinator.release(history.token);

peer.close();
coordinator.close();
console.log(JSON.stringify({
  protocol: ORIGIN_STORAGE_PROTOCOL,
  schemaVersion: ORIGIN_STORAGE_SCHEMA_VERSION,
  durableInventory: { positive: true },
  reservation: { positive: true, quotaBlockedNegative: true },
  release: { positive: true, idempotent: true },
  crashExpiry: { positive: true, abandonedReservationVisibleNegative: true },
  concurrentUniqueness: { positive: true, winners: 1, rejected: 1 },
  historyBudgetFoundation: { positive: true },
}));
