export type WorkspaceMutationReason =
  | "edit"
  | "create"
  | "delete"
  | "rename"
  | "restore"
  | "import"
  | "external-change"
  | "webdav-pull"
  | "checkpoint"
  | "backend-migration";

export interface WorkspacePathCapabilities {
  readonly caseSensitive: boolean;
  readonly separator: "/";
}

export interface WorkspaceBackendCapabilities {
  readonly paths: WorkspacePathCapabilities;
  readonly atomicCurrentFileTransaction: boolean;
}

export interface WorkspaceActiveBackend {
  readonly kind: "indexeddb" | "local-directory" | "native";
  readonly id: string;
}

export type WorkspaceMigrationState =
  | { readonly state: "v1-baseline-pending"; readonly migrationId: string; readonly cursor?: string }
  | { readonly state: "migration-failed"; readonly migrationId: string; readonly cursor?: string; readonly error: string }
  | { readonly state: "complete"; readonly migrationId: string };

export interface WorkspaceStorageState {
  readonly quotaBlocked: boolean;
  readonly historyDegraded: boolean;
  readonly unreconciled: boolean;
  readonly pendingJournal: boolean;
}

export interface WorkspaceBackendMetadata {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly activeBackend: WorkspaceActiveBackend;
  readonly backendGeneration: number;
  readonly headSequence: number;
  readonly paths: WorkspacePathCapabilities;
  readonly migration: WorkspaceMigrationState;
  readonly storage: WorkspaceStorageState;
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly type: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly data: Uint8Array;
}

export interface WorkspaceMutationStore {
  put(entry: WorkspaceEntry): void;
  delete(path: string): void;
}

export interface WorkspaceAtomicJournalTarget {
  readonly key: string;
  readonly preimage: unknown;
  readonly intended: unknown;
}

export type WorkspaceAtomicJournalState = "pending" | "committed" | "aborted" | "blocked";

export interface WorkspaceAtomicJournal {
  readonly id: string;
  readonly workspaceId: string;
  readonly reason: WorkspaceMutationReason;
  readonly createdAt: number;
  readonly state: WorkspaceAtomicJournalState;
  readonly targets: readonly WorkspaceAtomicJournalTarget[];
  readonly error?: string;
}

export interface WorkspaceBackend {
  readonly metadata: WorkspaceBackendMetadata;
  readonly capabilities: WorkspaceBackendCapabilities;
  load(): Promise<readonly WorkspaceEntry[]>;
  put(entry: WorkspaceEntry): Promise<void>;
  transact(body: (store: WorkspaceMutationStore) => void): Promise<void>;
  prepareAtomicJournal?(journal: WorkspaceAtomicJournal): Promise<void>;
  finishAtomicJournal?(id: string, state: Exclude<WorkspaceAtomicJournalState, "pending">, error?: string): Promise<void>;
  pendingAtomicJournals?(): Promise<readonly WorkspaceAtomicJournal[]>;
  flushEditGroups?(): Promise<void>;
  close(): void;
}

export interface WorkspaceAtomicApplyTarget<Preimage = unknown> {
  readonly key: string;
  readonly intended: unknown;
  capture(): Promise<Preimage>;
  commit(): Promise<void>;
  restore(preimage: Preimage): Promise<void>;
  publish?(): void;
}

export type WorkspaceLeaseState = "writer" | "readonly" | "unsupported";

export interface WorkspaceCoordinatorState {
  readonly metadata: WorkspaceBackendMetadata;
  readonly lease: WorkspaceLeaseState;
  readonly mutationInFlight: boolean;
  readonly blocked: boolean;
  readonly pendingJournalIds: readonly string[];
}

export class WorkspaceAtomicApplyBlocked extends Error {
  readonly journalId: string;
  readonly rollbackErrors: readonly unknown[];

  constructor(journalId: string, cause: unknown, rollbackErrors: readonly unknown[]) {
    super(`Atomic workspace batch ${journalId} could not restore every preimage`, { cause });
    this.name = "WorkspaceAtomicApplyBlocked";
    this.journalId = journalId;
    this.rollbackErrors = rollbackErrors;
  }
}

export function normalizeWorkspacePath(value: string): string {
  if (value.includes("\0") || value.includes("\\")) throw new Error(`Invalid workspace path: ${value}`);
  if (value === "" || value === "/") return "/";
  const raw = value.startsWith("/") ? value.slice(1) : value;
  const parts = raw.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Invalid workspace path: ${value}`);
  }
  return `/${parts.join("/")}`;
}

export class WorkspaceCoordinator {
  readonly #listeners = new Set<(state: WorkspaceCoordinatorState) => void>();
  readonly backend: WorkspaceBackend;
  readonly #owner = crypto.randomUUID();
  readonly #channel?: BroadcastChannel;
  #tail = Promise.resolve();
  #lease: WorkspaceLeaseState = "unsupported";
  #releaseLease?: () => void;
  #mutationInFlight = false;
  #blocked = false;
  #pendingJournalIds: string[] = [];
  #disposed = false;

  constructor(backend: WorkspaceBackend) {
    this.backend = backend;
    if (typeof BroadcastChannel !== "undefined") {
      this.#channel = new BroadcastChannel(`momoscript-workspace:${backend.metadata.workspaceId}`);
      this.#channel.onmessage = (event: MessageEvent<{ type?: string; owner?: string }>) => {
        if (event.data?.type !== "takeover" || event.data.owner === this.#owner || this.#lease !== "writer") return;
        this.#lease = "readonly";
        const release = this.#releaseLease;
        this.#emit();
        void this.#tail.finally(() => {
          if (this.#releaseLease === release) this.#releaseLease = undefined;
          release?.();
        });
      };
    }
  }

  get state(): WorkspaceCoordinatorState {
    return {
      metadata: this.backend.metadata,
      lease: this.#lease,
      mutationInFlight: this.#mutationInFlight,
      blocked: this.#blocked,
      pendingJournalIds: this.#pendingJournalIds,
    };
  }

  async initialize(): Promise<void> {
    const pending = await this.backend.pendingAtomicJournals?.() ?? [];
    this.#pendingJournalIds = pending.map((journal) => journal.id);
    this.#blocked = pending.some((journal) => journal.state === "pending" || journal.state === "blocked");
    this.#emit();
  }

  onDidChange(listener: (state: WorkspaceCoordinatorState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async acquireWriter(takeover = false): Promise<WorkspaceLeaseState> {
    const locks = globalThis.navigator?.locks;
    if (!locks) {
      this.#lease = "unsupported";
      this.#emit();
      return this.#lease;
    }
    const name = `momoscript-workspace:${this.backend.metadata.workspaceId}`;
    if (takeover) this.#channel?.postMessage({ type: "takeover", owner: this.#owner });
    const acquired = Promise.withResolvers<boolean>();
    void locks.request(name, { ifAvailable: !takeover, mode: "exclusive" }, async (lock) => {
      if (!lock) {
        acquired.resolve(false);
        return;
      }
      acquired.resolve(true);
      try {
        await new Promise<void>((resolve) => { this.#releaseLease = resolve; });
      } finally {
        this.#releaseLease = undefined;
        if (!this.#disposed && this.#lease === "writer") {
          this.#lease = "readonly";
          this.#emit();
        }
      }
    }).catch(() => {
      acquired.resolve(false);
      if (!this.#disposed && this.#lease === "writer") {
        this.#lease = "readonly";
        this.#emit();
      }
    });
    this.#lease = (await acquired.promise) ? "writer" : "readonly";
    this.#emit();
    return this.#lease;
  }

  async mutate<T>(reason: WorkspaceMutationReason, run: () => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      this.#assertWritable(reason);
      return run();
    });
  }

  async atomicApply<Preimage>(
    reason: WorkspaceMutationReason,
    targets: readonly WorkspaceAtomicApplyTarget<Preimage>[],
  ): Promise<void> {
    if (targets.length === 0) return;
    const keys = targets.map((target) => normalizeAtomicTargetKey(target.key));
    if (new Set(keys).size !== keys.length) throw new Error("Atomic workspace batch contains duplicate targets");
    if (!this.backend.prepareAtomicJournal || !this.backend.finishAtomicJournal) {
      throw new Error("Active workspace backend does not support journaled atomic batches");
    }
    const prepareJournal = this.backend.prepareAtomicJournal;
    const finishJournal = this.backend.finishAtomicJournal;
    await this.#enqueue(async () => {
      this.#assertWritable(reason);
      const preimages: Preimage[] = [];
      for (const target of targets) preimages.push(await target.capture());
      const journalId = crypto.randomUUID();
      const journal: WorkspaceAtomicJournal = {
        id: journalId,
        workspaceId: this.backend.metadata.workspaceId,
        reason,
        createdAt: Date.now(),
        state: "pending",
        targets: targets.map((target, index) => ({ key: keys[index], preimage: preimages[index], intended: target.intended })),
      };
      await prepareJournal(journal);
      this.#pendingJournalIds = [...this.#pendingJournalIds, journalId];
      this.#emit();
      try {
        for (const target of targets) await target.commit();
        await finishJournal(journalId, "committed");
        this.#pendingJournalIds = this.#pendingJournalIds.filter((id) => id !== journalId);
        for (const target of targets) target.publish?.();
        this.#emit();
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (let index = targets.length - 1; index >= 0; index -= 1) {
          try {
            await targets[index].restore(preimages[index]);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length === 0) {
          await finishJournal(journalId, "aborted", errorMessage(error));
          this.#pendingJournalIds = this.#pendingJournalIds.filter((id) => id !== journalId);
          this.#emit();
          throw error;
        }
        this.#blocked = true;
        try {
          await finishJournal(journalId, "blocked", [errorMessage(error), ...rollbackErrors.map(errorMessage)].join("; "));
        } finally {
          this.#emit();
        }
        throw new WorkspaceAtomicApplyBlocked(journalId, error, rollbackErrors);
      }
    });
  }

  async flush(): Promise<void> {
    await this.#tail;
    await this.backend.flushEditGroups?.();
  }

  dispose(): void {
    this.#disposed = true;
    this.#releaseLease?.();
    this.#releaseLease = undefined;
    this.#channel?.close();
    this.backend.close();
    this.#listeners.clear();
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#tail.then(async () => {
      this.#mutationInFlight = true;
      this.#emit();
      try {
        return await operation();
      } finally {
        this.#mutationInFlight = false;
        this.#emit();
      }
    });
    this.#tail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  #assertWritable(reason: WorkspaceMutationReason): void {
    if (this.#lease === "readonly") throw new Error("Workspace is read-only in this tab");
    if (this.#blocked || this.backend.metadata.storage.pendingJournal) throw new Error("Workspace mutations are blocked by a pending atomic journal");
    if (this.backend.metadata.storage.quotaBlocked) throw new Error("Workspace mutations are quota/history blocked");
    if (this.backend.metadata.storage.historyDegraded && this.backend.metadata.storage.unreconciled) {
      throw new Error("Workspace mutations are blocked until history is reconciled");
    }
    if (reason !== "backend-migration" && this.backend.metadata.migration.state !== "complete") {
      throw new Error("Workspace migration is incomplete; recovery/export is read-only");
    }
  }

  #emit(): void {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }
}

function normalizeAtomicTargetKey(value: string): string {
  if (value.includes("://")) return value;
  return normalizeWorkspacePath(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
