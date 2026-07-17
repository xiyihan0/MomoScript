import assert from "node:assert/strict";
import {
  ORIGIN_STORAGE_PROTOCOL,
  ORIGIN_STORAGE_SCHEMA_VERSION,
  OriginStorageCoordinator,
  StorageQuotaBlocked,
  StorageOperationBlocked,
} from "../src/originStorage.ts";
import { TypstPackageCacheStorageOwner } from "../src/packageCacheStorage.ts";

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

const protectedInventory = (await coordinator.inventory())
  .filter((entry) => entry.owner === "workspace" || entry.owner === "history")
  .map(({ id, bytes, class: storageClass }) => ({ id, bytes, class: storageClass }))
  .sort((left, right) => left.id.localeCompare(right.id));
const packageEvents = [];
const packageStorage = new TypstPackageCacheStorageOwner(coordinator);
await packageStorage.registerExisting({
  generationId: "preview/demo@1.0.0#evictable",
  bytes: 20 * MIB,
  evictBytes() { packageEvents.push("evict:evictable"); },
  invalidateDependents(generationId) { packageEvents.push(`invalidate:${generationId}`); },
});
await packageStorage.registerExisting({
  generationId: "preview/demo@1.0.0#pinned",
  bytes: 12 * MIB,
  evictBytes() { packageEvents.push("evict:pinned"); },
  invalidateDependents(generationId) { packageEvents.push(`invalidate:${generationId}`); },
});
const firstPin = packageStorage.pin("preview/demo@1.0.0#pinned");
const secondPin = packageStorage.pin("preview/demo@1.0.0#pinned");
firstPin.dispose();
firstPin.dispose();
quota = 116 * MIB;
const packageReservation = await packageStorage.reserve({
  purpose: "typst-package-staging",
  decodedBytes: 0,
  metadataBytes: 0,
  workspaceGrowthBytes: 0,
});
assert.deepEqual(packageEvents, [
  "evict:evictable",
  "invalidate:preview/demo@1.0.0#evictable",
], "quota pressure must evict bytes before invalidating dependent identities while retaining pins");
assert.deepEqual((await coordinator.inventory())
  .filter((entry) => entry.owner === "workspace" || entry.owner === "history")
  .map(({ id, bytes, class: storageClass }) => ({ id, bytes, class: storageClass }))
  .sort((left, right) => left.id.localeCompare(right.id)), protectedInventory, "package reclamation must not change protected workspace/history inventory");
await coordinator.release(packageReservation.token);

quota = 104 * MIB;
await assert.rejects(packageStorage.reserve({
  purpose: "typst-package-pinned-pressure",
  decodedBytes: 0,
  metadataBytes: 0,
  workspaceGrowthBytes: 0,
}), (error) => {
  assert.equal(error instanceof StorageQuotaBlocked, true);
  assert.equal(error.plan.reclaimableBytes, 0, "a render/export pin must remove its generation from the reclaimable plan");
  assert.equal(error.plan.protectedBytes, 52 * MIB, "workspace/history and runtime pins must dominate quota pressure");
  return true;
});
assert.equal(packageEvents.length, 2, "a blocked reservation must not invoke cache eviction callbacks");
secondPin.dispose();
const releasedPinReservation = await packageStorage.reserve({
  purpose: "typst-package-released-pin",
  decodedBytes: 0,
  metadataBytes: 0,
  workspaceGrowthBytes: 0,
});
assert.deepEqual(packageEvents.slice(2), [
  "evict:pinned",
  "invalidate:preview/demo@1.0.0#pinned",
]);
await coordinator.release(releasedPinReservation.token);

const raceGenerationId = "preview/demo@1.0.0#eviction-race";
const evictionStarted = Promise.withResolvers();
const finishEviction = Promise.withResolvers();
const raceEvents = [];
await packageStorage.registerExisting({
  generationId: raceGenerationId,
  bytes: 8 * MIB,
  async evictBytes() {
    raceEvents.push("evict:start");
    evictionStarted.resolve();
    await finishEviction.promise;
    raceEvents.push("evict:complete");
  },
  invalidateDependents(generationId) { raceEvents.push(`invalidate:${generationId}`); },
});
quota = 104 * MIB;
const racingReservation = packageStorage.reserve({
  purpose: "typst-package-eviction-race",
  decodedBytes: 0,
  metadataBytes: 0,
  workspaceGrowthBytes: 0,
});
await evictionStarted.promise;
let racedPin;
assert.throws(() => {
  racedPin = packageStorage.pin(raceGenerationId);
}, /evicting/, "a generation must reject new consumers as soon as byte eviction starts");
assert.equal(racedPin, undefined, "no consumer may receive a valid pin that outlives the evicted bytes");
finishEviction.resolve();
const completedRacingReservation = await racingReservation;
assert.deepEqual(raceEvents, [
  "evict:start",
  "evict:complete",
  `invalidate:${raceGenerationId}`,
], "byte eviction must finish before dependent invalidation");
assert.equal((await coordinator.inventory()).some((entry) => entry.id === `typst-package:${raceGenerationId}`), false);
await coordinator.release(completedRacingReservation.token);
packageStorage.dispose();
packageStorage.dispose();
assert.throws(() => packageStorage.pin(raceGenerationId), /disposed/, "storage owner disposal must be idempotent and terminal");

quota = 112 * MIB;
const activePackId = "offline-pack:active:demo";
await coordinator.register({
  id: activePackId,
  owner: "pack",
  class: "pack-active",
  bytes: 8 * MIB,
  reproducible: true,
  active: true,
});
const activePackEvents = [];
const activePackRequest = request("pack", "active-pack-confirmation", 0);
const activePackReclaimer = {
  canReclaim: () => true,
  evict: (entry) => { activePackEvents.push(`evict:${entry.id}`); },
  invalidate: (entry) => { activePackEvents.push(`invalidate:${entry.id}`); },
};
await assert.rejects(
  coordinator.reserveWithReclamation(activePackRequest, activePackReclaimer),
  StorageQuotaBlocked,
  "an active offline pack must not be reclaimed without explicit author confirmation",
);
assert.deepEqual(activePackEvents, []);
const confirmedActivePackReservation = await coordinator.reserveWithReclamation(activePackRequest, {
  ...activePackReclaimer,
  confirmedActivePackIds: new Set([activePackId]),
});
assert.deepEqual(activePackEvents, [`evict:${activePackId}`, `invalidate:${activePackId}`]);
await coordinator.release(confirmedActivePackReservation.token);

await coordinator.register({
  id: "workspace:blocked-gate",
  owner: "workspace",
  class: "workspace-protected",
  bytes: 0,
  reproducible: false,
  active: true,
  blocked: true,
});
await assert.rejects(coordinator.reserve(request("shell", "blocked-shell", 1)), StorageOperationBlocked);
await assert.rejects(coordinator.reserve(request("pack", "blocked-pack", 1)), StorageOperationBlocked);
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
  workspaceHardGate: { shellRejected: true, packRejected: true, freshInventoryRequired: true },
  historyBudgetFoundation: { positive: true },
  typstPackageCache: { quotaPressure: true, pins: true, evictionPinRace: true, evictionInvalidation: true, protectedPrecedence: true, disposalIdempotent: true },
  activeOfflinePack: { unconfirmedProtected: true, confirmedReclaimable: true },
}));
