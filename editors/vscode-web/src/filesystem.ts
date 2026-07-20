import * as vscode from "vscode";
import type { FileChangeEvent, FileStat, FileSystemProvider, Uri } from "vscode";
import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  FileChangeType as WorkbenchFileChangeType,
  FileSystemProviderCapabilities,
  type IFileChange,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
  type IWatchOptions
} from "@codingame/monaco-vscode-files-service-override";
import { IndexedDbWorkspaceBackend, type WorkspaceHistoryRevision, type WorkspaceRevision } from "./indexedDbWorkspace";
import { WorkspaceCoordinator, normalizeWorkspacePath as normalize, type WorkspaceEntry } from "./workspace";


interface StoredEntry {
  path: string;
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  data: Uint8Array;
}

export class MmtIndexedDbFileSystemProvider implements FileSystemProvider {
  readonly #changes = new vscode.EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile = this.#changes.event;
  readonly #entries = new Map<string, StoredEntry>();

  private constructor(
    private readonly backend: IndexedDbWorkspaceBackend,
    readonly coordinator: WorkspaceCoordinator
  ) {}

  static async open(): Promise<MmtIndexedDbFileSystemProvider> {
    const backend = await IndexedDbWorkspaceBackend.open();
    const coordinator = new WorkspaceCoordinator(backend);
    try {
      await coordinator.initialize();
      await coordinator.acquireWriter();
      if (coordinator.state.lease !== "readonly") {
        await coordinator.mutate("backend-migration", () => backend.resumeV1BaselineMigration());
      }
      const provider = new MmtIndexedDbFileSystemProvider(backend, coordinator);
      await provider.load();
      return provider;
    } catch (error) {
      coordinator.dispose();
      throw error;
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: Uri): FileStat {
    const entry = this.require(uri.path);
    return { type: entry.type, ctime: entry.ctime, mtime: entry.mtime, size: entry.data.byteLength };
  }

  readDirectory(uri: Uri): [string, vscode.FileType][] {
    this.requireDirectory(uri.path);
    const parent = normalize(uri.path);
    const prefix = parent === "/" ? "/" : `${parent}/`;
    return [...this.#entries.values()]
      .filter((entry) => entry.path.startsWith(prefix) && entry.path !== prefix)
      .map((entry) => [entry.path.slice(prefix.length), entry.type] as [string, vscode.FileType])
      .filter(([name]) => name.length > 0 && !name.includes("/"));
  }

  async createDirectory(uri: Uri): Promise<void> {
    const path = normalize(uri.path);
    if (this.#entries.has(path)) throw vscode.FileSystemError.FileExists(uri);
    this.requireDirectory(parentPath(path));
    const entry = makeEntry(path, vscode.FileType.Directory);
    await this.coordinator.mutate("create", async () => {
      await this.backend.commitMutation("create", new Map(), new Map([[path, entry]]));
      this.#entries.set(path, entry);
      this.#changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
    });
  }

  readFile(uri: Uri): Uint8Array {
    const entry = this.require(uri.path);
    if (entry.type !== vscode.FileType.File) throw vscode.FileSystemError.FileIsADirectory(uri);
    return entry.data.slice();
  }

  async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const path = normalize(uri.path);
    this.requireDirectory(parentPath(path));
    const previous = this.#entries.get(path);
    if (previous?.type === vscode.FileType.Directory) throw vscode.FileSystemError.FileIsADirectory(uri);
    if (!previous && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (previous && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    if (
      previous
      && previous.data.byteLength === content.byteLength
      && previous.data.every((value, index) => value === content[index])
    ) return;
    const now = Date.now();
    const entry: StoredEntry = {
      path,
      type: vscode.FileType.File,
      ctime: previous?.ctime ?? now,
      mtime: now,
      data: content.slice()
    };
    await this.coordinator.mutate(previous ? "edit" : "create", async () => {
      await this.backend.commitMutation(
        previous ? "edit" : "create",
        previous ? new Map([[path, previous]]) : new Map(),
        new Map([[path, entry]])
      );
      this.#entries.set(path, entry);
      this.#changes.fire([{ type: previous ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    });
  }

  async delete(uri: Uri, options: { readonly recursive: boolean }): Promise<void> {
    const path = normalize(uri.path);
    this.require(path);
    const descendants = this.subtree(path);
    if (!options.recursive && descendants.length > 1) throw vscode.FileSystemError.NoPermissions("Directory is not empty");
    await this.coordinator.mutate("delete", async () => {
      await this.backend.commitMutation(
        "delete",
        new Map(descendants.map((entry) => [entry.path, entry])),
        new Map()
      );
      descendants.forEach((entry) => this.#entries.delete(entry.path));
      this.#changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    });
  }

  async rename(
    oldUri: Uri,
    newUri: Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const oldPath = normalize(oldUri.path);
    const newPath = normalize(newUri.path);
    this.require(oldPath);
    this.requireDirectory(parentPath(newPath));
    if (newPath.startsWith(`${oldPath}/`)) throw vscode.FileSystemError.NoPermissions("Cannot move a directory into itself");
    const target = this.#entries.get(newPath);
    if (target && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
    const sourceEntries = this.subtree(oldPath);
    const targetEntries = target ? this.subtree(newPath) : [];
    const moved = sourceEntries.map((entry) => ({
      ...entry,
      path: `${newPath}${entry.path.slice(oldPath.length)}`,
      mtime: Date.now(),
      data: entry.data.slice()
    }));
    await this.coordinator.mutate("rename", async () => {
      await this.backend.commitMutation(
        "rename",
        new Map([...targetEntries, ...sourceEntries].map((entry) => [entry.path, entry])),
        new Map(moved.map((entry) => [entry.path, entry]))
      );
      targetEntries.forEach((entry) => this.#entries.delete(entry.path));
      sourceEntries.forEach((entry) => this.#entries.delete(entry.path));
      moved.forEach((entry) => this.#entries.set(entry.path, entry));
      this.#changes.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
    });
  }

  workspaceStatus(): { workspaceId: string; generation: number; backend: string; lease: string } {
    const { metadata, lease } = this.coordinator.state;
    return { workspaceId: metadata.workspaceId, generation: metadata.backendGeneration, backend: metadata.activeBackend.kind, lease };
  }

  revisions(limit = 100): Promise<readonly WorkspaceRevision[]> {
    return this.backend.revisions(limit);
  }

  history(limit = 100): Promise<readonly WorkspaceHistoryRevision[]> {
    return this.backend.history(limit);
  }

  snapshotEntry(revision: string, path: string): Promise<WorkspaceEntry | undefined> {
    return this.backend.snapshotEntry(revision, path);
  }

  historyBytes(): Promise<number> {
    return this.backend.historyBytes();
  }

  async createCheckpoint(name: string): Promise<string> {
    const checkpoint = name.trim();
    if (!checkpoint) throw new Error("Checkpoint name is required");
    let revision = "";
    await this.coordinator.mutate("checkpoint", async () => {
      revision = await this.backend.commitMutation("checkpoint", new Map(), new Map(), checkpoint);
    });
    return revision;
  }

  async restore(revision: string): Promise<void> {
    const restored = await this.backend.restoreRevision(revision);
    const desired = new Map(restored);
    if (!desired.has("/")) desired.set("/", this.#entries.get("/") ?? makeEntry("/", vscode.FileType.Directory));
    const before = new Map(this.#entries);
    await this.coordinator.mutate("restore", async () => {
      await this.backend.commitMutation(
        "checkpoint",
        new Map(),
        new Map(),
        `Before restore ${revision.slice(0, 8)}`
      );
      await this.backend.commitMutation("restore", before, desired);
      this.#entries.clear();
      for (const [path, entry] of desired) {
        this.#entries.set(path, { ...entry, type: entry.type as vscode.FileType, data: new Uint8Array(entry.data) });
      }
      if (!this.#entries.has("/")) this.#entries.set("/", makeEntry("/", vscode.FileType.Directory));
      this.#changes.fire([{ type: vscode.FileChangeType.Changed, uri: vscode.Uri.parse("mmtfs://workspace/") }]);
    });
  }

  async restoreFile(revision: string, rawPath: string): Promise<void> {
    const path = normalize(rawPath);
    const historical = await this.backend.snapshotEntry(revision, path);
    const current = this.#entries.get(path);
    if (!historical && !current) return;
    const before = current ? new Map([[path, current]]) : new Map<string, StoredEntry>();
    const after = historical
      ? new Map([[path, { ...historical, type: historical.type as vscode.FileType, data: historical.data.slice() }]])
      : new Map<string, StoredEntry>();
    await this.coordinator.mutate("restore", async () => {
      await this.backend.commitMutation("checkpoint", new Map(), new Map(), `Before restoring ${path}`);
      await this.backend.commitMutation("restore", before, after);
      if (historical) {
        const restored = { ...historical, type: historical.type as vscode.FileType, data: historical.data.slice() };
        this.#entries.set(path, restored);
        this.#changes.fire([{ type: current ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri: vscode.Uri.parse(`mmtfs://workspace${path}`) }]);
      } else {
        this.#entries.delete(path);
        this.#changes.fire([{ type: vscode.FileChangeType.Deleted, uri: vscode.Uri.parse(`mmtfs://workspace${path}`) }]);
      }
    });
  }

  takeOverWriter(): Promise<string> {
    return this.coordinator.acquireWriter(true);
  }

  exportEntries(): readonly StoredEntry[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry, data: entry.data.slice() }));
  }

  dispose(): void {
    this.#changes.dispose();
    this.coordinator.dispose();
  }

  private async load(): Promise<void> {
    const entries = await this.backend.load();
    entries.forEach((entry) => this.#entries.set(entry.path, { ...entry, type: entry.type as vscode.FileType, data: new Uint8Array(entry.data) }));
    if (!this.#entries.has("/")) {
      const root = makeEntry("/", vscode.FileType.Directory);
      if (this.coordinator.state.lease === "readonly") this.#entries.set("/", root);
      else await this.coordinator.mutate("backend-migration", () => this.persistAndRemember(root));
    }
    const legacyWorkspace = this.#entries.get("/workspace");
    if (
      this.coordinator.state.lease !== "readonly"
      && legacyWorkspace?.type === vscode.FileType.Directory
      && this.subtree("/workspace").length === 1
    ) {
      await this.coordinator.mutate("backend-migration", async () => {
        await this.backend.transact((store) => store.delete("/workspace"));
        this.#entries.delete("/workspace");
      });
    }
  }

  private subtree(path: string): StoredEntry[] {
    return [...this.#entries.values()].filter((entry) => entry.path === path || entry.path.startsWith(`${path}/`));
  }

  private require(path: string): StoredEntry {
    const entry = this.#entries.get(normalize(path));
    if (!entry) throw vscode.FileSystemError.FileNotFound(path);
    return entry;
  }

  private requireDirectory(path: string): StoredEntry {
    const entry = this.require(path);
    if (entry.type !== vscode.FileType.Directory) throw vscode.FileSystemError.FileNotADirectory(path);
    return entry;
  }

  private async persistAndRemember(entry: StoredEntry): Promise<void> {
    await this.backend.put(entry);
    this.#entries.set(entry.path, entry);
  }
}

export class MmtWorkbenchFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  readonly #changes = new Emitter<readonly IFileChange[]>();
  readonly onDidChangeFile = this.#changes.event;
  readonly #subscription: vscode.Disposable;

  constructor(private readonly provider: MmtIndexedDbFileSystemProvider) {
    this.#subscription = provider.onDidChangeFile((changes) => {
      this.#changes.fire(
        changes.map((change) => ({
          type:
            change.type === vscode.FileChangeType.Created
              ? WorkbenchFileChangeType.ADDED
              : change.type === vscode.FileChangeType.Deleted
                ? WorkbenchFileChangeType.DELETED
                : WorkbenchFileChangeType.UPDATED,
          resource: change.uri
        }))
      );
    });
  }

  watch(_resource: URI, _options: IWatchOptions): vscode.Disposable {
    return this.provider.watch();
  }

  async stat(resource: URI): Promise<IStat> {
    return this.provider.stat(resource);
  }

  mkdir(resource: URI): Promise<void> {
    return this.provider.createDirectory(resource);
  }

  readdir(resource: URI): Promise<[string, vscode.FileType][]> {
    return Promise.resolve(this.provider.readDirectory(resource));
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    return this.provider.readFile(resource);
  }

  writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<void> {
    return this.provider.writeFile(resource, content, options);
  }

  delete(resource: URI, options: { recursive: boolean }): Promise<void> {
    return this.provider.delete(resource, options);
  }

  rename(from: URI, to: URI, options: { overwrite: boolean }): Promise<void> {
    return this.provider.rename(from, to, options);
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#changes.dispose();
  }
}


function parentPath(value: string): string {
  const normalized = normalize(value);
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

function makeEntry(path: string, type: vscode.FileType): StoredEntry {
  const now = Date.now();
  return { path: normalize(path), type, ctime: now, mtime: now, data: new Uint8Array() };
}
