import * as vscode from "vscode";
import {
  canonicalArchivePath,
  digestPackageFiles,
  packageGenerationDigest,
  validateTypstManifest,
  type ValidatedPackageFile
} from "./typstPackageArchive";
import { checkedPackageSpec, packageSpecKey, type PackageSpec } from "./typstPackageProtocol";
import {
  materializePackageGeneration,
  type TypstPackageCacheAdapter,
  type TypstPackageGeneration
} from "./typstPackageService";

interface DesktopPackageIndex {
  readonly schema: "mmt-typst-package-cache.v1";
  readonly active: Readonly<Record<string, string>>;
}

interface DesktopGenerationRecord {
  readonly schema: "mmt-typst-package-generation.v1";
  readonly spec: PackageSpec;
  readonly registryId: string;
  readonly archiveDigest: string;
  readonly filesDigest: string;
  readonly packageGeneration: string;
  readonly entrypoint: string;
  readonly expandedBytes: number;
  readonly files: readonly { readonly path: string; readonly contentBase64: string }[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class DesktopTypstPackageCache implements TypstPackageCacheAdapter {
  readonly #active = new Map<string, string>();
  readonly #loaded = new Map<string, TypstPackageGeneration>();
  #queue = Promise.resolve();

  private constructor(readonly root: vscode.Uri) {}

  static async open(context: vscode.ExtensionContext): Promise<DesktopTypstPackageCache> {
    const root = vscode.Uri.joinPath(context.globalStorageUri, "typst-packages-v1");
    await vscode.workspace.fs.createDirectory(root);
    const cache = new DesktopTypstPackageCache(root);
    await cache.loadIndex();
    return cache;
  }

  async active(spec: PackageSpec): Promise<TypstPackageGeneration | undefined> {
    const generation = this.#active.get(packageSpecKey(spec));
    return generation ? this.loadGeneration(generation) : undefined;
  }

  activate(generation: TypstPackageGeneration, signal: AbortSignal): Promise<TypstPackageGeneration> {
    return this.serialized(async () => {
      if (signal.aborted) throw abortReason(signal);
      const existing = await this.loadGeneration(generation.packageGeneration);
      const immutable = existing ?? generation;
      if (!existing) await this.writeGeneration(immutable, signal);
      if (signal.aborted) throw abortReason(signal);
      const next = new Map(this.#active);
      next.set(packageSpecKey(immutable.spec), immutable.packageGeneration);
      await this.writeIndex(next, signal);
      this.#active.clear();
      for (const [key, value] of next) this.#active.set(key, value);
      this.#loaded.set(immutable.packageGeneration, immutable);
      return immutable;
    });
  }

  async read(uri: string): Promise<Uint8Array | undefined> {
    const parsed = new URL(uri);
    if (parsed.protocol !== "mmt-package:") return undefined;
    const digest = parsed.searchParams.get("digest");
    if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
    const generation = await this.loadGeneration(digest);
    const file = generation?.internalFiles.find((candidate) => candidate.uri === uri);
    return file?.bytes.slice();
  }

  evict(packageGeneration: string): Promise<void> {
    return this.serialized(async () => {
      if (!/^[0-9a-f]{64}$/.test(packageGeneration)) throw new Error("Invalid Typst package generation digest");
      const next = new Map([...this.#active].filter(([, generation]) => generation !== packageGeneration));
      await this.writeIndex(next, new AbortController().signal);
      await Promise.resolve(vscode.workspace.fs.delete(this.generationUri(packageGeneration), { recursive: false, useTrash: false })).catch(() => {});
      this.#active.clear();
      for (const [key, value] of next) this.#active.set(key, value);
      this.#loaded.delete(packageGeneration);
    });
  }

  private async loadIndex(): Promise<void> {
    try {
      const value = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(this.indexUri()))) as unknown;
      if (!isRecord(value) || value.schema !== "mmt-typst-package-cache.v1" || !isRecord(value.active)) {
        throw new Error("Invalid desktop Typst package cache index");
      }
      for (const [key, generation] of Object.entries(value.active)) {
        if (typeof generation === "string" && /^[0-9a-f]{64}$/.test(generation)) this.#active.set(key, generation);
      }
    } catch {
      this.#active.clear();
    }
  }

  private async loadGeneration(packageGeneration: string): Promise<TypstPackageGeneration | undefined> {
    const loaded = this.#loaded.get(packageGeneration);
    if (loaded) return loaded;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.generationUri(packageGeneration));
    } catch {
      return undefined;
    }
    const generation = await decodeGenerationRecord(JSON.parse(decoder.decode(bytes)) as unknown);
    if (generation.packageGeneration !== packageGeneration) throw new Error("Desktop Typst package generation filename does not match its digest");
    this.#loaded.set(packageGeneration, generation);
    return generation;
  }

  private async writeGeneration(generation: TypstPackageGeneration, signal: AbortSignal): Promise<void> {
    const target = this.generationUri(generation.packageGeneration);
    const staging = vscode.Uri.joinPath(this.root, `.staging-${generation.packageGeneration}-${crypto.randomUUID()}.json`);
    const record: DesktopGenerationRecord = {
      schema: "mmt-typst-package-generation.v1",
      spec: generation.spec,
      registryId: generation.registryId,
      archiveDigest: generation.archiveDigest,
      filesDigest: generation.filesDigest,
      packageGeneration: generation.packageGeneration,
      entrypoint: generation.entrypoint,
      expandedBytes: generation.expandedBytes,
      files: generation.files.map((file) => ({ path: file.path, contentBase64: Buffer.from(file.bytes).toString("base64") }))
    };
    try {
      await vscode.workspace.fs.writeFile(staging, encoder.encode(JSON.stringify(record)));
      if (signal.aborted) throw abortReason(signal);
      try {
        await vscode.workspace.fs.rename(staging, target, { overwrite: false });
      } catch {
        const existing = await this.loadGeneration(generation.packageGeneration);
        if (!existing) throw new Error("Failed to activate immutable desktop Typst package generation");
      }
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(staging, { recursive: false, useTrash: false })).catch(() => {});
    }
  }

  private async writeIndex(next: ReadonlyMap<string, string>, signal: AbortSignal): Promise<void> {
    const active = Object.fromEntries([...next].sort(([left], [right]) => left.localeCompare(right, "en-US")));
    const staging = vscode.Uri.joinPath(this.root, `.index-${crypto.randomUUID()}.json`);
    try {
      await vscode.workspace.fs.writeFile(staging, encoder.encode(JSON.stringify({
        schema: "mmt-typst-package-cache.v1",
        active
      } satisfies DesktopPackageIndex)));
      if (signal.aborted) throw abortReason(signal);
      await vscode.workspace.fs.rename(staging, this.indexUri(), { overwrite: true });
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(staging, { recursive: false, useTrash: false })).catch(() => {});
    }
  }

  private generationUri(packageGeneration: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, `${packageGeneration}.json`);
  }

  private indexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, "active.json");
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#queue.then(operation, operation);
    this.#queue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

export class TypstPackageFileSystemProvider implements vscode.FileSystemProvider {
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = () => ({ dispose() {} });

  constructor(private readonly cache: TypstPackageCacheAdapter) {}

  watch(): vscode.Disposable {
    return { dispose() {} };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.cache.read(uri.toString());
    if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const bytes = await this.cache.read(uri.toString());
    if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
    return bytes;
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }
}

async function decodeGenerationRecord(value: unknown): Promise<TypstPackageGeneration> {
  if (!isRecord(value)
    || value.schema !== "mmt-typst-package-generation.v1"
    || typeof value.registryId !== "string"
    || typeof value.archiveDigest !== "string"
    || typeof value.filesDigest !== "string"
    || typeof value.packageGeneration !== "string"
    || typeof value.entrypoint !== "string"
    || !Number.isSafeInteger(value.expandedBytes)
    || !Array.isArray(value.files)) {
    throw new Error("Invalid desktop Typst package generation record");
  }
  const spec = checkedPackageSpec(value.spec);
  const files: ValidatedPackageFile[] = value.files.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || typeof candidate.contentBase64 !== "string") {
      throw new Error("Invalid desktop Typst package file record");
    }
    return Object.freeze({
      path: canonicalArchivePath(candidate.path),
      bytes: new Uint8Array(Buffer.from(candidate.contentBase64, "base64"))
    });
  });
  const filesDigest = await digestPackageFiles(files);
  if (filesDigest !== value.filesDigest) throw new Error("Desktop Typst package file digest mismatch");
  const packageGeneration = await packageGenerationDigest(value.registryId, spec, value.archiveDigest, filesDigest);
  if (packageGeneration !== value.packageGeneration) throw new Error("Desktop Typst package generation digest mismatch");
  const entrypoint = validateTypstManifest(spec, files);
  if (entrypoint !== value.entrypoint) throw new Error("Desktop Typst package entrypoint mismatch");
  const expandedBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (expandedBytes !== value.expandedBytes) throw new Error("Desktop Typst package expanded byte count mismatch");
  return materializePackageGeneration(Object.freeze({
    spec,
    registryId: value.registryId,
    archiveDigest: value.archiveDigest,
    filesDigest,
    packageGeneration,
    entrypoint,
    expandedBytes,
    files: Object.freeze(files)
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Typst package cache activation cancelled", "AbortError");
}
