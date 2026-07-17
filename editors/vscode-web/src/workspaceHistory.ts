import type { StorageInventoryEntry } from "./originStorage";
import type { WorkspaceEntry, WorkspaceMutationReason, WorkspaceStorageState } from "./workspace";

export const HISTORY_IDLE_MS = 5_000;
export const HISTORY_MAX_GROUP_MS = 30_000;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface HistoryChange {
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
  readonly beforeEntry?: Omit<WorkspaceEntry, "data">;
  readonly afterEntry?: Omit<WorkspaceEntry, "data">;
}

export interface HistoryRevision {
  readonly id: string;
  readonly parent?: string;
  readonly reason: WorkspaceMutationReason;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly label?: string;
  readonly pinned: boolean;
  readonly changes: readonly HistoryChange[];
}

export interface HistorySnapshot {
  readonly current: ReadonlyMap<string, WorkspaceEntry>;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly revisions: readonly HistoryRevision[];
  readonly head?: string;
}

export class HistoryQuotaBlocked extends Error {
  readonly requiredBytes: number;
  readonly budgetBytes: number;
  constructor(requiredBytes: number, budgetBytes: number) {
    super(`History requires ${requiredBytes} bytes but budget is ${budgetBytes}`);
    this.name = "HistoryQuotaBlocked";
    this.requiredBytes = requiredBytes;
    this.budgetBytes = budgetBytes;
  }
}

export class WorkspaceHistory {
  #current = new Map<string, WorkspaceEntry>();
  #blobs = new Map<string, Uint8Array>();
  #revisions: HistoryRevision[] = [];
  #head?: string;

  readonly budgetBytes: number;
  constructor(budgetBytes: number) {
    this.budgetBytes = budgetBytes;
  }

  get snapshot(): HistorySnapshot {
    return {
      current: cloneTree(this.#current),
      blobs: new Map([...this.#blobs].map(([digest, bytes]) => [digest, bytes.slice()])),
      revisions: structuredClone(this.#revisions),
      head: this.#head,
    };
  }

  async commit(
    reason: WorkspaceMutationReason,
    before: ReadonlyMap<string, WorkspaceEntry>,
    after: ReadonlyMap<string, WorkspaceEntry>,
    options: { readonly now?: number; readonly label?: string; readonly pin?: boolean } = {},
  ): Promise<string> {
    const now = options.now ?? Date.now();
    const stagedBlobs = new Map(this.#blobs);
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8);
    const rawChanges: HistoryChange[] = [];
    for (const path of paths) {
      const previous = before.get(path);
      const next = after.get(path);
      const beforeDigest = previous?.type === 1 ? await storeBlob(stagedBlobs, previous.data) : undefined;
      const afterDigest = next?.type === 1 ? await storeBlob(stagedBlobs, next.data) : undefined;
      rawChanges.push({
        path,
        before: beforeDigest,
        after: afterDigest,
        beforeEntry: previous && metadataOnly(previous),
        afterEntry: next && metadataOnly(next),
      });
    }

    const previousRevision = this.#revisions.at(-1);
    const grouped = reason === "edit"
      && previousRevision?.reason === "edit"
      && !previousRevision.pinned
      && !options.label
      && now - previousRevision.updatedAt < HISTORY_IDLE_MS
      && now - previousRevision.createdAt < HISTORY_MAX_GROUP_MS;
    const revisionId = grouped ? previousRevision.id : crypto.randomUUID();
    const changes = grouped ? mergeChanges(previousRevision.changes, rawChanges) : rawChanges;
    const revision: HistoryRevision = {
      id: revisionId,
      parent: grouped ? previousRevision.parent : this.#head,
      reason,
      createdAt: grouped ? previousRevision.createdAt : now,
      updatedAt: now,
      ...(options.label ? { label: options.label } : {}),
      pinned: options.pin ?? Boolean(options.label),
      changes,
    };
    const revisions = grouped ? [...this.#revisions.slice(0, -1), revision] : [...this.#revisions, revision];
    const current = cloneTree(this.#current);
    for (const path of paths) {
      const entry = after.get(path);
      if (entry) current.set(path, cloneEntry(entry));
      else current.delete(path);
    }
    const required = blobBytes(stagedBlobs);
    if (required > this.budgetBytes) throw new HistoryQuotaBlocked(required, this.budgetBytes);
    this.#blobs = stagedBlobs;
    this.#revisions = revisions;
    this.#current = current;
    this.#head = revisionId;
    return revisionId;
  }

  checkpoint(label: string, now = Date.now()): Promise<string> {
    if (!label.trim()) throw new Error("Checkpoint label is required");
    return this.commit("checkpoint", new Map(), new Map(), { now, label: label.trim(), pin: true });
  }

  async restore(revisionId: string, now = Date.now()): Promise<string> {
    const desired = this.treeAt(revisionId);
    await this.checkpoint(`Before restore ${revisionId.slice(0, 8)}`, now);
    return this.commit("restore", this.#current, desired, { now: now + 1 });
  }

  treeAt(revisionId: string): ReadonlyMap<string, WorkspaceEntry> {
    const index = this.#revisions.findIndex((revision) => revision.id === revisionId);
    if (index < 0) throw new Error(`Unknown revision ${revisionId}`);
    const tree = new Map<string, WorkspaceEntry>();
    for (const revision of this.#revisions.slice(0, index + 1)) {
      for (const change of revision.changes) {
        if (!change.afterEntry) {
          tree.delete(change.path);
          continue;
        }
        const bytes = change.after ? this.#blobs.get(change.after) : new Uint8Array();
        if (!bytes) throw new Error(`Missing history blob ${change.after}`);
        tree.set(change.path, { ...change.afterEntry, data: bytes.slice() });
      }
    }
    return tree;
  }

  textDiff(revisionId: string, path: string): { readonly before: string; readonly after: string } {
    const revision = this.#revisions.find((candidate) => candidate.id === revisionId);
    const change = revision?.changes.find((candidate) => candidate.path === path);
    if (!change) throw new Error(`Revision ${revisionId} does not change ${path}`);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      before: change.before ? decoder.decode(this.#blobs.get(change.before)) : "",
      after: change.after ? decoder.decode(this.#blobs.get(change.after)) : "",
    };
  }

  gc(now = Date.now()): number {
    const retained = this.#revisions.filter((revision) => revision.pinned || revision.reason !== "edit" || now - revision.updatedAt <= HISTORY_RETENTION_MS);
    const referenced = new Set<string>();
    for (const revision of retained) for (const change of revision.changes) {
      if (change.before) referenced.add(change.before);
      if (change.after) referenced.add(change.after);
    }
    for (const path of this.#current.keys()) {
      for (let index = this.#revisions.length - 1; index >= 0; index -= 1) {
        const change = this.#revisions[index].changes.find((candidate) => candidate.path === path);
        if (!change) continue;
        if (change.after) referenced.add(change.after);
        break;
      }
    }
    let reclaimed = 0;
    for (const [digest, bytes] of this.#blobs) {
      if (!referenced.has(digest)) {
        reclaimed += bytes.byteLength;
        this.#blobs.delete(digest);
      }
    }
    this.#revisions = retained;
    return reclaimed;
  }
}

export interface V2MigrationMarker {
  readonly migrationId: string;
  readonly state: "v1-baseline-pending" | "migration-failed" | "complete";
  readonly cursor?: string;
  readonly staged: ReadonlyMap<string, { readonly entry: WorkspaceEntry; readonly digest?: string }>;
  readonly baselineRevisionId: string;
  readonly error?: string;
}

export async function resumeV2Migration(
  entries: readonly WorkspaceEntry[],
  marker: V2MigrationMarker,
  batchSize = 64,
  injectFailure?: (phase: "hash" | "stage" | "publish", path?: string) => void,
): Promise<V2MigrationMarker> {
  if (marker.state === "complete") return marker;
  const ordered = entries.slice().sort((left, right) => compareUtf8(left.path, right.path));
  const start = marker.cursor ? ordered.findIndex((entry) => compareUtf8(entry.path, marker.cursor!) > 0) : 0;
  const offset = start < 0 ? ordered.length : start;
  const batch = ordered.slice(offset, offset + batchSize);
  const staged = new Map(marker.staged);
  try {
    for (const entry of batch) {
      injectFailure?.("hash", entry.path);
      const digest = entry.type === 1 ? await sha256(entry.data) : undefined;
      injectFailure?.("stage", entry.path);
      staged.set(entry.path, { entry: cloneEntry(entry), ...(digest ? { digest } : {}) });
    }
    if (batch.length > 0) {
      return { ...marker, state: "v1-baseline-pending", staged, cursor: batch.at(-1)!.path, error: undefined };
    }
    injectFailure?.("publish");
    if (staged.size !== ordered.length) throw new Error("Migration verification did not cover every v1 entry");
    for (const entry of ordered) {
      const migrated = staged.get(entry.path)?.entry;
      if (!migrated || !equalEntry(entry, migrated)) throw new Error(`Migration verification failed for ${entry.path}`);
    }
    return { ...marker, state: "complete", staged, cursor: ordered.at(-1)?.path, error: undefined };
  } catch (error) {
    return { ...marker, state: "migration-failed", staged, error: error instanceof Error ? error.message : String(error) };
  }
}

export function workspaceInventory(
  workspaceId: string,
  currentBytes: number,
  historyBytes: number,
  storage: WorkspaceStorageState,
): { readonly entries: readonly Omit<StorageInventoryEntry, "updatedAt">[]; readonly hardGate: boolean } {
  const hardGate = storage.quotaBlocked || storage.pendingJournal || (storage.historyDegraded && storage.unreconciled);
  return {
    hardGate,
    entries: [
      { id: `workspace:${workspaceId}:current`, owner: "workspace", class: "workspace-protected", bytes: currentBytes, reproducible: false, active: true },
      { id: `workspace:${workspaceId}:history`, owner: "history", class: "history-managed", bytes: historyBytes, reproducible: false, active: true },
      ...(hardGate ? [{ id: `workspace:${workspaceId}:gate`, owner: "workspace" as const, class: "workspace-protected" as const, bytes: 0, reproducible: false, active: true, blocked: true }] : []),
    ],
  };
}

function mergeChanges(existing: readonly HistoryChange[], next: readonly HistoryChange[]): HistoryChange[] {
  const byPath = new Map(existing.map((change) => [change.path, change]));
  for (const change of next) {
    const first = byPath.get(change.path);
    byPath.set(change.path, first ? { ...change, before: first.before, beforeEntry: first.beforeEntry } : change);
  }
  return [...byPath.values()].sort((left, right) => compareUtf8(left.path, right.path));
}

async function storeBlob(blobs: Map<string, Uint8Array>, bytes: Uint8Array): Promise<string> {
  const digest = await sha256(bytes);
  if (!blobs.has(digest)) blobs.set(digest, bytes.slice());
  return digest;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}


function blobBytes(blobs: ReadonlyMap<string, Uint8Array>): number {
  let total = 0;
  for (const bytes of blobs.values()) total += bytes.byteLength;
  return total;
}

function metadataOnly(entry: WorkspaceEntry): Omit<WorkspaceEntry, "data"> {
  return { path: entry.path, type: entry.type, ctime: entry.ctime, mtime: entry.mtime };
}

function cloneEntry(entry: WorkspaceEntry): WorkspaceEntry {
  return { ...entry, data: entry.data.slice() };
}

function cloneTree(tree: ReadonlyMap<string, WorkspaceEntry>): Map<string, WorkspaceEntry> {
  return new Map([...tree].map(([path, entry]) => [path, cloneEntry(entry)]));
}

function equalEntry(left: WorkspaceEntry, right: WorkspaceEntry): boolean {
  return left.path === right.path && left.type === right.type && left.ctime === right.ctime && left.mtime === right.mtime
    && left.data.byteLength === right.data.byteLength && left.data.every((value, index) => value === right.data[index]);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
