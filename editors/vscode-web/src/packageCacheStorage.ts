import type {
  StorageInventoryEntry,
  StorageReclaimer,
  StorageReservation,
  StorageReservationRequest,
} from "./originStorage.ts";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";

export interface TypstPackageGenerationRegistration {
  readonly generationId: string;
  readonly bytes: number;
  evictBytes(): void | Promise<void>;
  invalidateDependents(generationId: string): void | Promise<void>;
}

export interface TypstPackageGenerationPin extends RuntimeOwnedResource {
  readonly generationId: string;
}

export interface PackageCacheStorageCoordinator {
  register(entry: Omit<StorageInventoryEntry, "updatedAt">): Promise<void>;
  commit(token: string, entry: Omit<StorageInventoryEntry, "updatedAt">): Promise<void>;
  reserveWithReclamation(request: StorageReservationRequest, reclaimer: StorageReclaimer): Promise<StorageReservation>;
}

/**
 * Runtime-owned bridge between immutable Typst package generations and the
 * origin-wide storage coordinator. Package bytes remain owned by the future
 * package service; this store owns only inventory, pins, and invalidation.
 */
export class TypstPackageCacheStorageOwner implements RuntimeOwnedResource {
  readonly #coordinator: PackageCacheStorageCoordinator;
  readonly #registrations = new Map<string, TypstPackageGenerationRegistration>();
  readonly #pinCounts = new Map<string, number>();
  #disposed = false;

  constructor(coordinator: PackageCacheStorageCoordinator) {
    this.#coordinator = coordinator;
  }

  async registerExisting(registration: TypstPackageGenerationRegistration): Promise<void> {
    const id = this.prepareRegistration(registration);
    await this.#coordinator.register(inventoryEntry(id, registration.bytes));
    this.#registrations.set(id, registration);
  }

  async commit(token: string, registration: TypstPackageGenerationRegistration): Promise<void> {
    const id = this.prepareRegistration(registration);
    await this.#coordinator.commit(token, inventoryEntry(id, registration.bytes));
    this.#registrations.set(id, registration);
  }

  pin(generationId: string): TypstPackageGenerationPin {
    this.assertActive();
    const id = inventoryId(generationId);
    if (!this.#registrations.has(id)) throw new Error(`Unknown Typst package generation ${generationId}`);
    this.#pinCounts.set(id, (this.#pinCounts.get(id) ?? 0) + 1);
    let released = false;
    return {
      generationId,
      dispose: () => {
        if (released) return;
        released = true;
        const count = this.#pinCounts.get(id);
        if (count === undefined || count <= 1) this.#pinCounts.delete(id);
        else this.#pinCounts.set(id, count - 1);
      },
    };
  }

  reserve(request: Omit<StorageReservationRequest, "owner">): Promise<StorageReservation> {
    this.assertActive();
    return this.#coordinator.reserveWithReclamation(
      { ...request, owner: "pack" },
      {
        canReclaim: (entry) => this.#registrations.has(entry.id) && !this.#pinCounts.has(entry.id),
        evict: async (entry) => {
          const registration = this.#registrations.get(entry.id);
          if (!registration) throw new Error(`Unowned storage reclamation ${entry.id}`);
          await registration.evictBytes();
        },
        invalidate: async (entry) => {
          const registration = this.#registrations.get(entry.id);
          if (!registration) throw new Error(`Unowned storage invalidation ${entry.id}`);
          this.#registrations.delete(entry.id);
          this.#pinCounts.delete(entry.id);
          await registration.invalidateDependents(registration.generationId);
        },
      },
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#registrations.clear();
    this.#pinCounts.clear();
  }

  private prepareRegistration(registration: TypstPackageGenerationRegistration): string {
    this.assertActive();
    const id = inventoryId(registration.generationId);
    if (this.#registrations.has(id)) throw new Error(`Typst package generation is already registered: ${registration.generationId}`);
    if (!Number.isSafeInteger(registration.bytes) || registration.bytes < 0) {
      throw new RangeError(`Invalid Typst package generation byte count ${registration.bytes}`);
    }
    return id;
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error("Typst package cache storage owner is disposed");
  }
}

function inventoryId(generationId: string): string {
  if (generationId.trim().length === 0) throw new Error("Typst package generation identity must not be empty");
  return `typst-package:${generationId}`;
}

function inventoryEntry(id: string, bytes: number): Omit<StorageInventoryEntry, "updatedAt"> {
  return {
    id,
    owner: "pack",
    class: "typst-package-cache",
    bytes,
    reproducible: true,
    active: true,
  };
}
