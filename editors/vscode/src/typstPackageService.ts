import type { TypstProjectUpdate } from "./tinymistClient";
import {
  acquireTypstPackage,
  canonicalArchivePath,
  OfficialPreviewRegistry,
  TypstPackageAcquisitionError,
  type PackageFetch,
  type PackageRegistryAdapter,
  type TypstPackageLimits,
  type ValidatedPackageArchive,
  type ValidatedPackageFile
} from "./typstPackageArchive";
import {
  checkedTypstPackageRequest,
  packageSpecKey,
  parseAuthoredPackageSpec,
  type PackageSpec,
  type TypstPackageRequestParams,
  type TypstPackageResponse,
  type TypstPackageWireFile
} from "./typstPackageProtocol";

export interface TypstPackageGeneration extends ValidatedPackageArchive {
  readonly internalRootUri: string;
  readonly internalFiles: readonly TypstPackageInternalFile[];
}

export interface TypstPackageInternalFile extends ValidatedPackageFile {
  readonly uri: string;
}

export interface TypstPackageCacheAdapter {
  active(spec: PackageSpec): Promise<TypstPackageGeneration | undefined>;
  activate(generation: TypstPackageGeneration, signal: AbortSignal): Promise<TypstPackageGeneration>;
  read(uri: string): Promise<Uint8Array | undefined>;
  evict(packageGeneration: string): Promise<void>;
}

export interface TypstPackageDependency {
  readonly projectSnapshot: string;
  readonly sourceUri: string;
  readonly packageSpec: PackageSpec;
  readonly packageGeneration: string;
  readonly filesDigest: string;
  readonly internalRootUri: string;
}

export interface TypstPackageDependencyGraph {
  activate(dependency: TypstPackageDependency): void;
  removeProject(projectSnapshot: string): void;
  invalidateGeneration(packageGeneration: string): readonly string[];
  forProject(projectSnapshot: string): readonly TypstPackageDependency[];
}

export interface TypstPackageAuthoredRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface TypstPackageStatus {
  readonly backendGeneration: number;
  readonly projectSnapshot: string;
  readonly sourceUri: string;
  readonly packageSpec: PackageSpec;
  readonly state: "ready" | "unavailable" | "error" | "cancelled";
  readonly message: string;
  readonly dependencyChain: readonly string[];
  readonly authoredRange?: TypstPackageAuthoredRange;
}

export interface TypstPackageServiceOptions {
  readonly cache: TypstPackageCacheAdapter;
  readonly registries?: readonly PackageRegistryAdapter[];
  readonly fetchPackage?: PackageFetch;
  readonly limits?: TypstPackageLimits;
  readonly offline?: () => boolean;
  readonly status?: (status: TypstPackageStatus) => void;
  readonly dependencies?: TypstPackageDependencyGraph;
}

interface PackageImportSite {
  readonly uri: string;
  readonly range: TypstPackageAuthoredRange;
}

interface PackageProject {
  readonly backendGeneration: number;
  readonly snapshot: string;
  readonly sourceUri: string;
  readonly imports: ReadonlyMap<string, readonly PackageImportSite[]>;
}

interface SharedAcquisition {
  readonly controller: AbortController;
  readonly promise: Promise<ValidatedPackageArchive>;
  dependents: number;
  settled: boolean;
}

export class InMemoryTypstPackageCache implements TypstPackageCacheAdapter {
  readonly #activeBySpec = new Map<string, TypstPackageGeneration>();
  readonly #byGeneration = new Map<string, TypstPackageGeneration>();

  async active(spec: PackageSpec): Promise<TypstPackageGeneration | undefined> {
    return this.#activeBySpec.get(packageSpecKey(spec));
  }

  async activate(generation: TypstPackageGeneration, signal: AbortSignal): Promise<TypstPackageGeneration> {
    if (signal.aborted) throw abortReason(signal);
    const existing = this.#byGeneration.get(generation.packageGeneration);
    if (existing) {
      this.#activeBySpec.set(packageSpecKey(generation.spec), existing);
      return existing;
    }
    if (signal.aborted) throw abortReason(signal);
    this.#byGeneration.set(generation.packageGeneration, generation);
    this.#activeBySpec.set(packageSpecKey(generation.spec), generation);
    return generation;
  }

  async read(uri: string): Promise<Uint8Array | undefined> {
    for (const generation of this.#byGeneration.values()) {
      const file = generation.internalFiles.find((candidate) => candidate.uri === uri);
      if (file) return file.bytes.slice();
    }
    return undefined;
  }

  async evict(packageGeneration: string): Promise<void> {
    const generation = this.#byGeneration.get(packageGeneration);
    if (!generation) return;
    this.#byGeneration.delete(packageGeneration);
    const key = packageSpecKey(generation.spec);
    if (this.#activeBySpec.get(key)?.packageGeneration === packageGeneration) this.#activeBySpec.delete(key);
  }
}

export class InMemoryTypstPackageDependencyGraph implements TypstPackageDependencyGraph {
  readonly #byProject = new Map<string, Map<string, TypstPackageDependency>>();

  activate(dependency: TypstPackageDependency): void {
    const current = this.#byProject.get(dependency.projectSnapshot) ?? new Map();
    current.set(packageSpecKey(dependency.packageSpec), Object.freeze({ ...dependency }));
    this.#byProject.set(dependency.projectSnapshot, current);
  }

  removeProject(projectSnapshot: string): void {
    this.#byProject.delete(projectSnapshot);
  }

  invalidateGeneration(packageGeneration: string): readonly string[] {
    const invalidated: string[] = [];
    for (const [snapshot, dependencies] of this.#byProject) {
      for (const [spec, dependency] of dependencies) {
        if (dependency.packageGeneration !== packageGeneration) continue;
        dependencies.delete(spec);
        if (!invalidated.includes(snapshot)) invalidated.push(snapshot);
      }
      if (dependencies.size === 0) this.#byProject.delete(snapshot);
    }
    return Object.freeze(invalidated.sort());
  }

  forProject(projectSnapshot: string): readonly TypstPackageDependency[] {
    return Object.freeze([...(this.#byProject.get(projectSnapshot)?.values() ?? [])]);
  }
}

export class TypstPackageService {
  readonly #cache: TypstPackageCacheAdapter;
  readonly #registries: readonly PackageRegistryAdapter[];
  readonly #fetchPackage: PackageFetch;
  readonly #limits: TypstPackageLimits | undefined;
  readonly #offline: () => boolean;
  readonly #statusHandlers = new Set<(status: TypstPackageStatus) => void>();
  readonly #dependencies: TypstPackageDependencyGraph;
  readonly #projects = new Map<string, PackageProject>();
  readonly #latestSnapshotBySource = new Map<string, string>();
  readonly #inflight = new Map<string, SharedAcquisition>();
  readonly #negative = new Map<string, Extract<TypstPackageResponse, { status: "Unavailable" }>>();
  #backendGeneration = 0;

  constructor(options: TypstPackageServiceOptions) {
    this.#cache = options.cache;
    this.#registries = options.registries ?? [new OfficialPreviewRegistry()];
    this.#fetchPackage = options.fetchPackage ?? ((url, init) => fetch(url, init));
    this.#limits = options.limits;
    this.#offline = options.offline ?? (() => typeof navigator !== "undefined" && navigator.onLine === false);
    if (options.status) this.#statusHandlers.add(options.status);
    this.#dependencies = options.dependencies ?? new InMemoryTypstPackageDependencyGraph();
  }
  onStatus(handler: (status: TypstPackageStatus) => void): () => void {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }


  setBackendGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid Typst package backend generation");
    if (generation === this.#backendGeneration) return;
    this.#backendGeneration = generation;
    for (const [snapshot, project] of this.#projects) {
      this.#projects.set(snapshot, Object.freeze({ ...project, backendGeneration: generation }));
    }
    this.#negative.clear();
    for (const acquisition of this.#inflight.values()) {
      acquisition.controller.abort(new DOMException("Tinymist backend generation retired", "AbortError"));
    }
    this.#inflight.clear();
  }

  registerProject(project: TypstProjectUpdate, backendGeneration: number): void {
    if (backendGeneration !== this.#backendGeneration || backendGeneration < 0) return;
    const previousSnapshot = this.#latestSnapshotBySource.get(project.sourceUri);
    if (previousSnapshot && previousSnapshot !== project.projectDigest) this.retireProject(previousSnapshot);
    const imports = collectPackageImportSites(project);
    this.#projects.set(project.projectDigest, Object.freeze({
      backendGeneration,
      snapshot: project.projectDigest,
      sourceUri: project.sourceUri,
      imports
    }));
    this.#latestSnapshotBySource.set(project.sourceUri, project.projectDigest);
  }

  retireProject(projectSnapshot: string): void {
    const project = this.#projects.get(projectSnapshot);
    this.#projects.delete(projectSnapshot);
    if (project && this.#latestSnapshotBySource.get(project.sourceUri) === projectSnapshot) {
      this.#latestSnapshotBySource.delete(project.sourceUri);
    }
    this.#dependencies.removeProject(projectSnapshot);
    for (const key of this.#negative.keys()) {
      if (key.startsWith(`${projectSnapshot}\0`)) this.#negative.delete(key);
    }
  }

  isCurrent(params: Pick<TypstPackageRequestParams, "backend_generation" | "typst_project_snapshot_key">): boolean {
    return params.backend_generation === this.#backendGeneration
      && this.#projects.get(params.typst_project_snapshot_key)?.backendGeneration === params.backend_generation;
  }

  dependenciesForProject(projectSnapshot: string): readonly TypstPackageDependency[] {
    return this.#dependencies.forProject(projectSnapshot);
  }

  async prepareProject(projectSnapshot: string, signal: AbortSignal): Promise<readonly TypstPackageGeneration[]> {
    const project = this.#projects.get(projectSnapshot);
    if (!project || signal.aborted) return Object.freeze([]);
    const generations: TypstPackageGeneration[] = [];
    const importKeys = [...project.imports.keys()].sort();
    const queued = new Set(importKeys);
    for (let index = 0; index < importKeys.length; index += 1) {
      const packageSpec = parseAuthoredPackageSpec(importKeys[index]!);
      const response = await this.resolve({
        backend_generation: project.backendGeneration,
        typst_project_snapshot_key: projectSnapshot,
        request_id: `preview:${projectSnapshot}:${index}`,
        package_spec: packageSpec
      }, signal);
      if (response.status === "Cancelled") return Object.freeze([]);
      if (response.status === "Unavailable") {
        throw new TypstPackageAcquisitionError("Unavailable", response.reason, response.retryable);
      }
      const active = await this.#cache.active(packageSpec);
      if (!active || active.packageGeneration !== response.package_generation) {
        throw new TypstPackageAcquisitionError(
          "Unavailable",
          `Activated Typst package generation disappeared: ${packageSpecKey(packageSpec)}`,
          true
        );
      }
      generations.push(active);
      for (const dependency of collectPackageImportKeys(active.files)) {
        if (queued.has(dependency)) continue;
        queued.add(dependency);
        importKeys.push(dependency);
      }
    }
    if (signal.aborted || !this.#projects.has(projectSnapshot)) return Object.freeze([]);
    return Object.freeze(generations);
  }

  async resolve(value: unknown, signal: AbortSignal): Promise<TypstPackageResponse> {
    const request = checkedTypstPackageRequest(value);
    if (signal.aborted || !this.isCurrent(request)) return this.cancelled(request);
    const project = this.#projects.get(request.typst_project_snapshot_key)!;
    const negativeKey = `${request.typst_project_snapshot_key}\0${packageSpecKey(request.package_spec)}\0${request.requested_path ?? ""}`;
    const cachedNegative = this.#negative.get(negativeKey);
    if (cachedNegative) return cachedNegative;

    let active = await this.#cache.active(request.package_spec);
    if (signal.aborted || !this.isCurrent(request)) return this.cancelled(request, project);
    if (!active) {
      if (this.#offline()) {
        return this.unavailable(request, project, negativeKey, "Package is not cached and the host is offline", true);
      }
      try {
        const archive = await this.acquireShared(request.package_spec, signal);
        if (signal.aborted || !this.isCurrent(request)) return this.cancelled(request, project);
        const generation = materializePackageGeneration(archive);
        active = await this.#cache.activate(generation, signal);
        if (signal.aborted || !this.isCurrent(request)) return this.cancelled(request, project);
      } catch (error) {
        if (signal.aborted || isAbortError(error) || !this.isCurrent(request)) return this.cancelled(request, project);
        if (error instanceof TypstPackageAcquisitionError && error.code === "Unavailable") {
          return this.unavailable(request, project, negativeKey, error.message, error.retryable);
        }
        this.report(project, request.package_spec, "error", error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    if (request.requested_path !== undefined) {
      let requestedPath: string;
      try {
        requestedPath = canonicalArchivePath(request.requested_path);
      } catch (error) {
        this.report(project, request.package_spec, "error", error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (!active.files.some((file) => file.path === requestedPath)) {
        return this.unavailable(request, project, negativeKey, `Package file is unavailable: ${requestedPath}`, false);
      }
    }
    if (signal.aborted || !this.isCurrent(request)) return this.cancelled(request, project);
    this.#dependencies.activate(Object.freeze({
      projectSnapshot: request.typst_project_snapshot_key,
      sourceUri: project.sourceUri,
      packageSpec: request.package_spec,
      packageGeneration: active.packageGeneration,
      filesDigest: active.filesDigest,
      internalRootUri: active.internalRootUri
    }));
    const files = active.files.map<TypstPackageWireFile>((file) => Object.freeze({
      path: file.path,
      content_base64: bytesToBase64(file.bytes)
    }));
    this.report(project, request.package_spec, "ready", `Resolved ${packageSpecKey(request.package_spec)}`);
    return Object.freeze({
      status: "Ready",
      request_id: request.request_id,
      package_generation: active.packageGeneration,
      files_digest: active.filesDigest,
      files: Object.freeze(files)
    });
  }

  private async acquireShared(spec: PackageSpec, signal: AbortSignal): Promise<ValidatedPackageArchive> {
    let distribution;
    for (const registry of this.#registries) {
      distribution = await registry.resolve(spec, signal);
      if (distribution) break;
    }
    if (!distribution) {
      throw new TypstPackageAcquisitionError("Unavailable", `No trusted registry owns ${packageSpecKey(spec)}`, false);
    }
    const key = `${distribution.registryId}\0${packageSpecKey(spec)}`;
    let shared = this.#inflight.get(key);
    if (!shared) {
      const controller = new AbortController();
      const promise = acquireTypstPackage(
        spec,
        distribution,
        this.#fetchPackage,
        controller.signal,
        this.#limits
      );
      shared = { controller, promise, dependents: 0, settled: false };
      this.#inflight.set(key, shared);
      void promise.finally(() => {
        shared!.settled = true;
        if (this.#inflight.get(key) === shared) this.#inflight.delete(key);
      }).catch(() => {});
    }
    shared.dependents += 1;
    try {
      return await waitWithAbort(shared.promise, signal);
    } finally {
      shared.dependents -= 1;
      if (shared.dependents === 0 && !shared.settled) {
        shared.controller.abort(new DOMException("Typst package acquisition has no active dependents", "AbortError"));
      }
    }
  }

  private unavailable(
    request: TypstPackageRequestParams,
    project: PackageProject,
    negativeKey: string,
    reason: string,
    retryable: boolean
  ): Extract<TypstPackageResponse, { status: "Unavailable" }> {
    const response = Object.freeze({
      status: "Unavailable" as const,
      request_id: request.request_id,
      reason,
      retryable
    });
    this.#negative.set(negativeKey, response);
    this.report(project, request.package_spec, "unavailable", reason);
    return response;
  }

  private cancelled(request: TypstPackageRequestParams, project?: PackageProject): Extract<TypstPackageResponse, { status: "Cancelled" }> {
    if (project) this.report(project, request.package_spec, "cancelled", "Package request was cancelled or became stale");
    return Object.freeze({ status: "Cancelled", request_id: request.request_id });
  }

  private report(project: PackageProject, spec: PackageSpec, state: TypstPackageStatus["state"], message: string): void {
    if (project.backendGeneration !== this.#backendGeneration || this.#statusHandlers.size === 0) return;
    const sites = project.imports.get(packageSpecKey(spec)) ?? [];
    const uniquelyAuthored = sites.length === 1 && sites[0]!.uri === project.sourceUri ? sites[0] : undefined;
    const status = Object.freeze({
      backendGeneration: project.backendGeneration,
      projectSnapshot: project.snapshot,
      sourceUri: project.sourceUri,
      packageSpec: spec,
      state,
      message,
      dependencyChain: Object.freeze([project.sourceUri, packageSpecKey(spec)]),
      ...(uniquelyAuthored ? { authoredRange: uniquelyAuthored.range } : {})
    });
    for (const handler of this.#statusHandlers) handler(status);
  }
}

export function materializePackageGeneration(archive: ValidatedPackageArchive): TypstPackageGeneration {
  const internalRootUri = `mmt-package:/${encodeURIComponent(archive.spec.namespace)}/${encodeURIComponent(archive.spec.name)}/${encodeURIComponent(archive.spec.version)}?digest=${archive.packageGeneration}`;
  const internalFiles = archive.files.map((file) => Object.freeze({
    ...file,
    uri: `mmt-package:/${encodeURIComponent(archive.spec.namespace)}/${encodeURIComponent(archive.spec.name)}/${encodeURIComponent(archive.spec.version)}/${file.path.split("/").map(encodeURIComponent).join("/")}?digest=${archive.packageGeneration}`
  }));
  return Object.freeze({ ...archive, internalRootUri, internalFiles: Object.freeze(internalFiles) });
}

const PACKAGE_IMPORT_PATTERN = /@([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?):(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?)/g;

function collectPackageImportKeys(files: readonly ValidatedPackageFile[]): readonly string[] {
  const keys = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    if (!file.path.endsWith(".typ")) continue;
    let source: string;
    try {
      source = decoder.decode(file.bytes);
    } catch {
      continue;
    }
    for (const match of source.matchAll(PACKAGE_IMPORT_PATTERN)) {
      keys.add(packageSpecKey({ namespace: match[1]!, name: match[2]!, version: match[3]! }));
    }
  }
  return Object.freeze([...keys].sort());
}

function collectPackageImportSites(project: TypstProjectUpdate): ReadonlyMap<string, readonly PackageImportSite[]> {
  const sites = new Map<string, PackageImportSite[]>();
  const pattern = PACKAGE_IMPORT_PATTERN;
  for (const file of project.files) {
    if (file.text === undefined) continue;
    const lineStarts = [0];
    for (let index = 0; index < file.text.length; index += 1) if (file.text.charCodeAt(index) === 10) lineStarts.push(index + 1);
    for (const match of file.text.matchAll(pattern)) {
      const offset = match.index;
      const line = upperBound(lineStarts, offset) - 1;
      const start = { line, character: offset - lineStarts[line]! };
      const site = Object.freeze({
        uri: file.uri,
        range: Object.freeze({
          start: Object.freeze(start),
          end: Object.freeze({ line, character: start.character + match[0].length })
        })
      });
      const key = packageSpecKey({ namespace: match[1]!, name: match[2]!, version: match[3]! });
      const current = sites.get(key) ?? [];
      current.push(site);
      sites.set(key, current);
    }
  }
  return new Map([...sites].map(([key, value]) => [key, Object.freeze(value)]));
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : alphabet[third & 63];
  }
  return output;
}

async function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Typst package request cancelled", "AbortError");
}
