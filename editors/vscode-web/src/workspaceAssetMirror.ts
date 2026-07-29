import * as vscode from "vscode";
import type { TypstRenderProjectUpdate, TypstVirtualFile } from "../../vscode/src/tinymistClient";
import { canonicalBytesDigest } from "../../vscode/src/runtimeIdentity";

interface CachedWorkspaceAsset {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly dataBase64: string;
}

interface WorkspaceAssetState {
  readonly root: vscode.Uri;
  readonly assets: Map<string, CachedWorkspaceAsset>;
  initialize: Promise<void>;
}

export class WorkspaceAssetMirror implements vscode.Disposable {
  static readonly MAX_FILES = 256;
  static readonly MAX_DIRECTORIES = 64;
  static readonly MAX_FILE_BYTES = 8 * 1024 * 1024;
  static readonly MAX_TOTAL_BYTES = 32 * 1024 * 1024;
  static readonly IMAGE_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i;

  readonly #states = new Map<string, WorkspaceAssetState>();
  readonly #subscriptions: vscode.Disposable[];
  readonly #reuse: boolean;
  #updates: Promise<void> = Promise.resolve();
  #updateError: unknown;

  constructor(reuse = true) {
    this.#reuse = reuse;
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{png,jpg,jpeg,gif,webp,svg,bmp,avif}");
    this.#subscriptions = [
      watcher,
      watcher.onDidCreate((uri) => this.#schedule(uri, false)),
      watcher.onDidChange((uri) => this.#schedule(uri, false)),
      watcher.onDidDelete((uri) => this.#schedule(uri, true)),
    ];
  }

  async snapshot(project: TypstRenderProjectUpdate, signal: AbortSignal): Promise<readonly TypstVirtualFile[]> {
    const source = vscode.Uri.parse(project.sourceUri);
    const root = vscode.Uri.parse(`${source.scheme}://${source.authority}/`);
    const key = root.toString();
    if (!this.#reuse) this.#states.delete(key);
    let state = this.#states.get(key);
    if (!state) {
      state = { root, assets: new Map(), initialize: Promise.resolve() };
      this.#states.set(key, state);
      state.initialize = this.#initialize(state);
    }
    try {
      await withAbort(state.initialize, signal);
    } catch (error) {
      if (!signal.aborted && this.#states.get(key) === state) this.#states.delete(key);
      throw error;
    }
    await withAbort(this.#updates, signal);
    if (this.#updateError !== undefined) {
      const error = this.#updateError;
      this.#updateError = undefined;
      throw error;
    }
    signal.throwIfAborted();

    const entry = vscode.Uri.parse(project.entryUri);
    const basePath = entry.path.slice(0, entry.path.lastIndexOf("/") + 1);
    const existing = new Set(project.files.map((file) => file.uri));
    const files: TypstVirtualFile[] = [];
    for (const asset of [...state.assets.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
      const uri = entry.with({ path: `${basePath}${asset.relativePath}` }).toString();
      if (existing.has(uri)) continue;
      existing.add(uri);
      files.push({ uri, digest: asset.digest, dataBase64: asset.dataBase64 });
    }
    return files;
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#states.clear();
  }

  async #initialize(state: WorkspaceAssetState): Promise<void> {
    let visitedDirectories = 0;
    let totalBytes = 0;
    const visit = async (directory: vscode.Uri, segments: readonly string[]): Promise<void> => {
      if (
        state.assets.size >= WorkspaceAssetMirror.MAX_FILES
        || visitedDirectories >= WorkspaceAssetMirror.MAX_DIRECTORIES
      ) return;
      visitedDirectories += 1;
      for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
        if (state.assets.size >= WorkspaceAssetMirror.MAX_FILES) return;
        if (!safeWorkspaceAssetName(name)) continue;
        const uri = vscode.Uri.joinPath(directory, name);
        const relativeSegments = [...segments, name];
        if (type === vscode.FileType.Directory) {
          await visit(uri, relativeSegments);
          continue;
        }
        if (type !== vscode.FileType.File || !WorkspaceAssetMirror.IMAGE_PATTERN.test(name)) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (
          bytes.byteLength > WorkspaceAssetMirror.MAX_FILE_BYTES
          || totalBytes + bytes.byteLength > WorkspaceAssetMirror.MAX_TOTAL_BYTES
        ) continue;
        totalBytes += bytes.byteLength;
        const relativePath = relativeSegments.join("/");
        state.assets.set(relativePath, await cachedWorkspaceAsset(relativePath, bytes));
      }
    };
    await visit(state.root, []);
  }

  #schedule(uri: vscode.Uri, deleted: boolean): void {
    for (const state of this.#states.values()) {
      if (uri.scheme !== state.root.scheme || uri.authority !== state.root.authority) continue;
      const rootPath = state.root.path.endsWith("/") ? state.root.path : `${state.root.path}/`;
      if (!uri.path.startsWith(rootPath)) continue;
      const relativePath = uri.path.slice(rootPath.length).replace(/^\/+/, "");
      if (!relativePath || relativePath.split("/").some((segment) => !safeWorkspaceAssetName(segment))) continue;
      this.#updates = this.#updates.then(async () => {
        await state.initialize;
        if (deleted) {
          state.assets.delete(relativePath);
          for (const path of state.assets.keys()) {
            if (path.startsWith(`${relativePath}/`)) state.assets.delete(path);
          }
          return;
        }
        if (!WorkspaceAssetMirror.IMAGE_PATTERN.test(relativePath)) {
          state.assets.delete(relativePath);
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > WorkspaceAssetMirror.MAX_FILE_BYTES) {
          state.assets.delete(relativePath);
          return;
        }
        const previous = state.assets.get(relativePath);
        const retainedBytes = [...state.assets.values()]
          .reduce((total, asset) => total + asset.byteLength, 0) - (previous?.byteLength ?? 0);
        if (
          (!previous && state.assets.size >= WorkspaceAssetMirror.MAX_FILES)
          || retainedBytes + bytes.byteLength > WorkspaceAssetMirror.MAX_TOTAL_BYTES
        ) return;
        state.assets.set(relativePath, await cachedWorkspaceAsset(relativePath, bytes));
      }).catch((error: unknown) => {
        this.#updateError = error;
      });
    }
  }
}

function safeWorkspaceAssetName(name: string): boolean {
  return name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

async function cachedWorkspaceAsset(relativePath: string, bytes: Uint8Array): Promise<CachedWorkspaceAsset> {
  return {
    relativePath,
    byteLength: bytes.byteLength,
    digest: await canonicalBytesDigest("mmt-project-file-v1", [bytes]),
    dataBase64: bytesToBase64(bytes),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Workspace mirror aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
