export type WorkspaceMutationReason =
  | "edit"
  | "create"
  | "delete"
  | "rename"
  | "import"
  | "external-change"
  | "sync"
  | "checkpoint"
  | "restore"
  | "migration";

export interface WorkspacePathCapabilities {
  readonly caseSensitive: boolean;
  readonly separator: "/";
}

export interface WorkspaceBackendMetadata {
  readonly workspaceId: string;
  readonly generation: number;
  readonly kind: "indexeddb" | "local-directory";
  readonly paths: WorkspacePathCapabilities;
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly type: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly data: Uint8Array;
}

export interface WorkspaceMutation {
  readonly reason: WorkspaceMutationReason;
  readonly run: () => Promise<void>;
}

export interface WorkspaceBackend {
  readonly metadata: WorkspaceBackendMetadata;
  load(): Promise<readonly WorkspaceEntry[]>;
  put(entry: WorkspaceEntry): Promise<void>;
  transact(body: (store: WorkspaceMutationStore) => void): Promise<void>;
  close(): void;
}

export interface WorkspaceMutationStore {
  put(entry: WorkspaceEntry): void;
  delete(path: string): void;
}

export type WorkspaceLeaseState = "writer" | "readonly" | "unsupported";

export interface WorkspaceCoordinatorState {
  readonly metadata: WorkspaceBackendMetadata;
  readonly lease: WorkspaceLeaseState;
  readonly mutationInFlight: boolean;
}

export function normalizeWorkspacePath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(`Invalid workspace path: ${value}`);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export class WorkspaceCoordinator {
  readonly #listeners = new Set<(state: WorkspaceCoordinatorState) => void>();
  readonly #owner = crypto.randomUUID();
  readonly #channel?: BroadcastChannel;
  #tail = Promise.resolve();
  #lease: WorkspaceLeaseState = "unsupported";
  #releaseLease?: () => void;
  #mutationInFlight = false;
  #disposed = false;

  constructor(readonly backend: WorkspaceBackend) {
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
    return { metadata: this.backend.metadata, lease: this.#lease, mutationInFlight: this.#mutationInFlight };
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
    locks.request(name, { ifAvailable: !takeover, mode: "exclusive" }, async (lock) => {
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

  async mutate(reason: WorkspaceMutationReason, run: () => Promise<void>): Promise<void> {
    if (this.#lease === "readonly") throw new Error("Workspace is read-only in this tab");
    const operation = this.#tail.then(async () => {
      if (this.#lease === "readonly") throw new Error("Workspace writer lease was lost");
      this.#mutationInFlight = true;
      this.#emit();
      try {
        await run();
      } finally {
        this.#mutationInFlight = false;
        this.#emit();
      }
    });
    this.#tail = operation.catch(() => undefined);
    await operation;
    void reason;
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  dispose(): void {
    this.#disposed = true;
    this.#releaseLease?.();
    this.#releaseLease = undefined;
    this.#channel?.close();
    this.backend.close();
    this.#listeners.clear();
  }

  #emit(): void {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }
}
