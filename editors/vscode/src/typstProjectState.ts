import type { TypstProjectUpdate, TypstVirtualFile } from "./tinymistClient";

export const DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS = 30_000;

export function canonicalTypstUri(uri: string): string {
  if (!uri.startsWith("untitled:")) return uri;
  return `untitled:/${uri.slice("untitled:".length).replace(/^\/+/, "")}`;
}

export function projectionSessionKey(entryUri: string): string {
  const canonical = canonicalTypstUri(entryUri);
  const separator = canonical.lastIndexOf("/");
  return separator < 0 ? canonical : canonical.slice(0, separator);
}

export function mergeProjectFiles(current: TypstVirtualFile[], changed: TypstVirtualFile[]): TypstVirtualFile[] {
  const files = new Map(current.map((file) => [canonicalTypstUri(file.uri), file]));
  for (const file of changed) files.set(canonicalTypstUri(file.uri), file);
  return [...files.values()];
}

export interface ProjectFileRotation {
  retained: Set<string>[];
  close: string[];
}

export function rotateProjectFileGenerations(
  current: ReadonlySet<string>,
  applied: Set<string> | undefined,
  retained: ReadonlyArray<Set<string>>,
  maxRetainedGenerations = 2
): ProjectFileRotation {
  const nextRetained = applied ? [new Set(applied), ...retained.map((files) => new Set(files))] : [];
  const evicted = nextRetained.splice(maxRetainedGenerations);
  const stillOwned = new Set(current);
  for (const generation of nextRetained) {
    for (const uri of generation) stillOwned.add(uri);
  }
  const close: string[] = [];
  for (const generation of evicted) {
    for (const uri of generation) {
      if (!stillOwned.has(uri) && !close.includes(uri)) close.push(uri);
    }
  }
  return { retained: nextRetained, close };
}

export class ProjectFileCloseRegistry {
  private readonly bySource = new Map<string, Set<string>>();

  has(sourceUri: string, uri: string): boolean {
    return this.bySource.get(sourceUri)?.has(canonicalTypstUri(uri)) ?? false;
  }

  hasUri(uri: string): boolean {
    const key = canonicalTypstUri(uri);
    for (const files of this.bySource.values()) if (files.has(key)) return true;
    return false;
  }

  add(sourceUri: string, uri: string): void {
    const files = this.bySource.get(sourceUri) ?? new Set<string>();
    files.add(canonicalTypstUri(uri));
    this.bySource.set(sourceUri, files);
  }

  delete(sourceUri: string, uri: string): void {
    const files = this.bySource.get(sourceUri);
    files?.delete(canonicalTypstUri(uri));
    if (files?.size === 0) this.bySource.delete(sourceUri);
  }

  deleteUri(uri: string): boolean {
    const key = canonicalTypstUri(uri);
    let deleted = false;
    for (const [sourceUri, files] of this.bySource) {
      deleted = files.delete(key) || deleted;
      if (files.size === 0) this.bySource.delete(sourceUri);
    }
    return deleted;
  }

  clear(): void {
    this.bySource.clear();
  }
}

export function projectFileIsOwned(
  uri: string,
  projectFiles: ReadonlyMap<string, ReadonlySet<string>>,
  appliedProjectFiles: ReadonlyMap<string, ReadonlySet<string>>,
  retainedProjectFiles: ReadonlyMap<string, ReadonlyArray<ReadonlySet<string>>>
): boolean {
  const key = canonicalTypstUri(uri);
  for (const files of projectFiles.values()) if (files.has(key)) return true;
  for (const files of appliedProjectFiles.values()) if (files.has(key)) return true;
  for (const generations of retainedProjectFiles.values()) {
    for (const files of generations) if (files.has(key)) return true;
  }
  return false;
}

export function releasePendingProjectFile(
  scheduled: ProjectFileCloseRegistry,
  uri: string,
  isOpen: (uri: string) => boolean,
  projectFiles: ReadonlyMap<string, ReadonlySet<string>>,
  appliedProjectFiles: ReadonlyMap<string, ReadonlySet<string>>,
  retainedProjectFiles: ReadonlyMap<string, ReadonlyArray<ReadonlySet<string>>>,
  close: (uri: string) => void
): boolean {
  const key = canonicalTypstUri(uri);
  if (!scheduled.hasUri(key)) return false;
  if (isOpen(key) && !projectFileIsOwned(key, projectFiles, appliedProjectFiles, retainedProjectFiles)) close(key);
  if (!projectFileIsOwned(key, projectFiles, appliedProjectFiles, retainedProjectFiles)) scheduled.deleteUri(key);
  return !scheduled.hasUri(key);
}

export function releasePendingProjectFileAfterGrace(
  scheduled: ProjectFileCloseRegistry,
  uri: string,
  expectedRevision: number,
  openRevision: (uri: string) => number | undefined,
  projectFiles: ReadonlyMap<string, ReadonlySet<string>>,
  appliedProjectFiles: ReadonlyMap<string, ReadonlySet<string>>,
  retainedProjectFiles: ReadonlyMap<string, ReadonlyArray<ReadonlySet<string>>>,
  close: (uri: string) => void
): boolean {
  const key = canonicalTypstUri(uri);
  if (openRevision(key) !== expectedRevision) return false;
  return releasePendingProjectFile(
    scheduled,
    key,
    (candidate) => openRevision(candidate) !== undefined,
    projectFiles,
    appliedProjectFiles,
    retainedProjectFiles,
    close
  );
}

export type TypstProjectInvariantCode =
  | "UnknownSessionDelta"
  | "RetiredSession"
  | "NonIncreasingRevision"
  | "ProjectQueueFull"
  | "PrimeQueueFull"
  | "CloseQueueFull"
  | "RequestQueueFull"
  | "ReplayQueueFull"
  | "BackendUnavailable"
  | "Cancelled"
  | "StaleBackendGeneration";

export class TypstProjectInvariantError extends Error {
  constructor(readonly code: TypstProjectInvariantCode, message: string) {
    super(message);
    this.name = "TypstProjectInvariantError";
  }
}

export interface TypstProjectStatePort {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params: unknown): void;
  emit(method: string, params: unknown): void;
}

export interface TypstProjectStateLimits {
  maxProjects: number;
  maxRequests: number;
  maxPrimes: number;
  maxCloses: number;
  maxReplay: number;
  retainedGenerations: number;
}

export interface TypstProjectStateOptions {
  closeGraceMs?: number;
  primeDebounceMs?: number;
  limits?: Partial<TypstProjectStateLimits>;
}

export interface ProjectTransitionResult {
  accepted: boolean;
  project?: TypstProjectUpdate;
  error?: TypstProjectInvariantError;
}

interface ProjectionVersion {
  session: string;
  revision: number;
}

interface PrimeJob extends ProjectionVersion {
  sourceUri: string;
  entryUri: string;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  settled: boolean;
}

interface InFlightPrime {
  token: symbol;
  job: PrimeJob;
  controller: AbortController;
}

const DEFAULT_LIMITS: TypstProjectStateLimits = {
  maxProjects: 128,
  maxRequests: 256,
  maxPrimes: 128,
  maxCloses: 4096,
  maxReplay: 128,
  retainedGenerations: 2
};

export class TypstProjectState {
  private readonly openFiles = new Map<string, number>();
  private readonly projectFiles = new Map<string, Set<string>>();
  private readonly appliedProjectFiles = new Map<string, Set<string>>();
  private readonly retainedProjectFiles = new Map<string, Set<string>[]>();
  private readonly projectsByEntry = new Map<string, TypstProjectUpdate>();
  private readonly latestProjectionBySource = new Map<string, ProjectionVersion>();
  private readonly retiredSessionsBySource = new Map<string, Set<string>>();
  private readonly appliedProjectionBySource = new Map<string, ProjectionVersion>();
  private readonly scheduledFileCloses = new ProjectFileCloseRegistry();
  private readonly scheduledCloseFallbacks = new Map<string, { revision: number; timeout: NodeJS.Timeout }>();
  private readonly projectPrimeTimers = new Map<string, NodeJS.Timeout>();
  private readonly projectPrimeQueue = new Map<string, PrimeJob>();
  private readonly projectPrimeInFlight = new Map<string, InFlightPrime>();
  private readonly projectPrimeByEntry = new Map<string, PrimeJob>();
  private readonly requestControllers = new Set<AbortController>();
  private activeGeneration = 0;
  private readonly closeGraceMs: number;
  private readonly primeDebounceMs: number;
  private readonly limits: TypstProjectStateLimits;

  constructor(private readonly port: TypstProjectStatePort, options: TypstProjectStateOptions = {}) {
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS;
    this.primeDebounceMs = options.primeDebounceMs ?? 250;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  backendGeneration(): number {
    return this.activeGeneration;
  }

  syncProject(update: TypstProjectUpdate): ProjectTransitionResult {
    const session = projectionSessionKey(update.entryUri);
    const latest = this.latestProjectionBySource.get(update.sourceUri);
    const retired = this.retiredSessionsBySource.get(update.sourceUri);
    let error: TypstProjectInvariantError | undefined;
    if (retired?.has(session)) {
      error = new TypstProjectInvariantError("RetiredSession", `Projection session is retired: ${session}`);
    } else if ((!latest || latest.session !== session) && !update.full) {
      error = new TypstProjectInvariantError("UnknownSessionDelta", `Projection delta has no accepted full session: ${session}`);
    } else if (latest?.session === session && update.revision <= latest.revision) {
      error = new TypstProjectInvariantError(
        "NonIncreasingRevision",
        `Projection revision ${update.revision} does not advance ${latest.revision}`
      );
    } else if (!latest && this.projectsByEntry.size >= this.limits.maxProjects) {
      error = new TypstProjectInvariantError("ProjectQueueFull", `Project limit ${this.limits.maxProjects} reached`);
    }
    if (error) {
      this.port.emit("tinymist/projectRejected", { sourceUri: update.sourceUri, code: error.code, message: error.message });
      return { accepted: false, error };
    }
    if (latest && latest.session !== session) {
      const nextRetired = retired ?? new Set<string>();
      nextRetired.add(latest.session);
      this.retiredSessionsBySource.set(update.sourceUri, nextRetired);
    }
    const previous = latest?.session === session
      ? [...this.projectsByEntry.values()].find((project) => project.sourceUri === update.sourceUri)
      : undefined;
    const previousFiles = previous && canonicalTypstUri(previous.entryUri) !== canonicalTypstUri(update.entryUri)
      ? previous.files.filter((file) => canonicalTypstUri(file.uri) !== canonicalTypstUri(previous.entryUri))
      : previous?.files;
    const files = update.full || !previousFiles ? update.files : mergeProjectFiles(previousFiles, update.files);
    const complete = { ...update, full: true, files };
    for (const [entryUri, project] of this.projectsByEntry) {
      if (project.sourceUri === update.sourceUri) this.projectsByEntry.delete(entryUri);
    }
    this.latestProjectionBySource.set(update.sourceUri, { session, revision: update.revision });
    this.projectFiles.set(
      update.sourceUri,
      new Set(files.filter((file) => typeof file.text === "string").map((file) => canonicalTypstUri(file.uri)))
    );
    this.projectsByEntry.set(canonicalTypstUri(update.entryUri), complete);
    if (this.activeGeneration !== 0) this.applyProject(update.full ? complete : update);
    return { accepted: true, project: complete };
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    return this.projectsByEntry.get(canonicalTypstUri(entryUri));
  }

  closeProject(sourceUri: string, entryUri: string): boolean {
    if (this.projectForEntry(entryUri)?.sourceUri !== sourceUri) return false;
    for (const [projectEntryUri, project] of this.projectsByEntry) {
      if (project.sourceUri === sourceUri) this.projectsByEntry.delete(projectEntryUri);
    }
    const files = new Set(this.projectFiles.get(sourceUri) ?? []);
    for (const uri of this.appliedProjectFiles.get(sourceUri) ?? []) files.add(uri);
    for (const generation of this.retainedProjectFiles.get(sourceUri) ?? []) {
      for (const uri of generation) files.add(uri);
    }
    this.projectFiles.delete(sourceUri);
    this.appliedProjectFiles.delete(sourceUri);
    this.retainedProjectFiles.delete(sourceUri);
    this.appliedProjectionBySource.delete(sourceUri);
    this.latestProjectionBySource.delete(sourceUri);
    this.retiredSessionsBySource.delete(sourceUri);
    this.cancelProjectPrime(sourceUri, new Error("Tinymist projection prime cancelled"));
    if (this.activeGeneration !== 0) for (const uri of files) this.scheduleFileClose(sourceUri, uri);
    return true;
  }

  async activateBackend(generation: number): Promise<void> {
    if (generation <= this.activeGeneration) {
      throw new TypstProjectInvariantError(
        "StaleBackendGeneration",
        `Backend generation ${generation} does not advance ${this.activeGeneration}`
      );
    }
    this.cancelBackendWork(new TypstProjectInvariantError("StaleBackendGeneration", "Backend generation retired"));
    this.activeGeneration = generation;
    this.openFiles.clear();
    this.appliedProjectFiles.clear();
    this.retainedProjectFiles.clear();
    this.appliedProjectionBySource.clear();
    const replay = [...this.projectsByEntry.values()];
    if (replay.length > this.limits.maxReplay) {
      throw new TypstProjectInvariantError("ReplayQueueFull", `Replay limit ${this.limits.maxReplay} exceeded`);
    }
    for (const project of replay) this.applyProject(project);
  }

  deactivateBackend(generation: number, reason: Error): void {
    if (generation !== this.activeGeneration) return;
    this.activeGeneration = 0;
    this.cancelBackendWork(reason);
    this.openFiles.clear();
    this.appliedProjectFiles.clear();
    this.retainedProjectFiles.clear();
    this.appliedProjectionBySource.clear();
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.activeGeneration === 0) {
      throw new TypstProjectInvariantError("BackendUnavailable", "Tinymist backend unavailable");
    }
    if (this.requestControllers.size >= this.limits.maxRequests) {
      throw new TypstProjectInvariantError("RequestQueueFull", `Request limit ${this.limits.maxRequests} reached`);
    }
    const generation = this.activeGeneration;
    const controller = new AbortController();
    const abort = () => {
      const reason = signal?.reason;
      const cancellation = new TypstProjectInvariantError("Cancelled", "Tinymist request cancelled");
      controller.abort(reason instanceof DOMException && reason.name === "AbortError"
        ? cancellation
        : reason ?? cancellation);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.requestControllers.add(controller);
    try {
      await this.waitForProjectPrime(params, controller.signal);
      const value = await this.port.request<T>(method, params, controller.signal);
      if (generation !== this.activeGeneration) {
        throw new TypstProjectInvariantError("StaleBackendGeneration", "Tinymist response belongs to a retired backend generation");
      }
      return value;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.requestControllers.delete(controller);
    }
  }

  dispose(reason = new Error("Tinymist project state disposed")): void {
    this.activeGeneration = 0;
    this.cancelBackendWork(reason);
    this.projectsByEntry.clear();
    this.projectFiles.clear();
    this.latestProjectionBySource.clear();
    this.retiredSessionsBySource.clear();
  }

  private applyProject(update: TypstProjectUpdate): void {
    const session = projectionSessionKey(update.entryUri);
    const applied = this.appliedProjectionBySource.get(update.sourceUri);
    if (applied?.session === session && update.revision <= applied.revision) return;
    const currentFiles = this.projectFiles.get(update.sourceUri) ?? new Set<string>();
    this.port.notify("mmt/typstPackageContext.v1", {
      backend_generation: this.activeGeneration,
      typst_project_snapshot_key: update.projectDigest
    });
    for (const file of update.files) {
      if (typeof file.text !== "string") continue;
      const uri = canonicalTypstUri(file.uri);
      this.cancelScheduledFileClose(uri);
      if (this.openFiles.has(uri)) {
        this.port.notify("textDocument/didChange", {
          textDocument: { uri, version: update.revision },
          contentChanges: [{ text: file.text }]
        });
      } else {
        this.port.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typst", version: update.revision, text: file.text }
        });
      }
      this.openFiles.set(uri, update.revision);
    }
    const rotation = rotateProjectFileGenerations(
      currentFiles,
      this.appliedProjectFiles.get(update.sourceUri),
      this.retainedProjectFiles.get(update.sourceUri) ?? [],
      this.limits.retainedGenerations
    );
    this.retainedProjectFiles.set(update.sourceUri, rotation.retained);
    this.appliedProjectFiles.set(update.sourceUri, currentFiles);
    this.appliedProjectionBySource.set(update.sourceUri, { session, revision: update.revision });
    for (const uri of rotation.close) this.scheduleFileClose(update.sourceUri, uri);
    this.primeProject(update.sourceUri, update.entryUri, session, update.revision);
  }

  private primeProject(sourceUri: string, entryUri: string, session: string, revision: number): void {
    const existing = this.projectPrimeQueue.get(sourceUri);
    if (!existing && this.projectPrimeQueue.size + this.projectPrimeInFlight.size >= this.limits.maxPrimes) {
      this.port.emit("tinymist/projectPrimeFailed", {
        sourceUri,
        entryUri,
        error: new TypstProjectInvariantError("PrimeQueueFull", `Prime limit ${this.limits.maxPrimes} reached`).message
      });
      return;
    }
    if (existing) this.settlePrime(existing, new Error("Tinymist projection prime superseded"));
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    void promise.catch(() => {});
    const job: PrimeJob = {
      sourceUri,
      entryUri: canonicalTypstUri(entryUri),
      session,
      revision,
      promise,
      resolve: () => resolvePromise?.(),
      reject: (error) => rejectPromise?.(error),
      settled: false
    };
    this.projectPrimeQueue.set(sourceUri, job);
    this.projectPrimeByEntry.set(job.entryUri, job);
    if (!this.projectPrimeInFlight.has(sourceUri)) this.scheduleProjectPrime(sourceUri);
  }

  private scheduleProjectPrime(sourceUri: string): void {
    const previous = this.projectPrimeTimers.get(sourceUri);
    if (previous) clearTimeout(previous);
    this.projectPrimeTimers.set(sourceUri, setTimeout(() => this.runProjectPrime(sourceUri), this.primeDebounceMs));
  }

  private runProjectPrime(sourceUri: string): void {
    this.projectPrimeTimers.delete(sourceUri);
    if (this.projectPrimeInFlight.has(sourceUri)) return;
    const job = this.projectPrimeQueue.get(sourceUri);
    if (!job) return;
    this.projectPrimeQueue.delete(sourceUri);
    const controller = new AbortController();
    const active: InFlightPrime = { token: Symbol(sourceUri), job, controller };
    this.projectPrimeInFlight.set(sourceUri, active);
    void this.port.request("textDocument/foldingRange", { textDocument: { uri: job.entryUri } }, controller.signal)
      .then(() => {
        if (this.projectPrimeInFlight.get(sourceUri)?.token !== active.token) return;
        this.port.emit("tinymist/projectPrimed", {
          sourceUri,
          entryUri: job.entryUri,
          session: job.session,
          revision: job.revision
        });
        this.settlePrime(job);
      }, (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.port.emit("tinymist/projectPrimeFailed", {
          sourceUri,
          entryUri: job.entryUri,
          session: job.session,
          revision: job.revision,
          error: String(failure)
        });
        this.settlePrime(job, failure);
      })
      .finally(() => {
        if (this.projectPrimeInFlight.get(sourceUri)?.token !== active.token) return;
        this.projectPrimeInFlight.delete(sourceUri);
        if (this.projectPrimeQueue.has(sourceUri)) this.scheduleProjectPrime(sourceUri);
      });
  }

  private async waitForProjectPrime(params: unknown, signal?: AbortSignal): Promise<void> {
    const entryUri = this.requestTextDocumentUri(params);
    if (!entryUri) return;
    while (true) {
      const job = this.projectPrimeByEntry.get(entryUri);
      if (!job) return;
      if (!signal) await job.promise;
      else await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new Error("Tinymist request cancelled"));
          return;
        }
        const abort = () => reject(signal.reason ?? new Error("Tinymist request cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        void job.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
      if (this.projectPrimeByEntry.get(entryUri) === job) return;
    }
  }

  private requestTextDocumentUri(params: unknown): string | undefined {
    if (!params || typeof params !== "object") return undefined;
    const textDocument = Reflect.get(params, "textDocument");
    if (!textDocument || typeof textDocument !== "object") return undefined;
    const uri = Reflect.get(textDocument, "uri");
    return typeof uri === "string" ? canonicalTypstUri(uri) : undefined;
  }

  private settlePrime(job: PrimeJob, error?: Error): void {
    if (job.settled) return;
    job.settled = true;
    if (this.projectPrimeByEntry.get(job.entryUri) === job) this.projectPrimeByEntry.delete(job.entryUri);
    if (error) job.reject(error);
    else job.resolve();
  }

  private cancelProjectPrime(sourceUri: string, reason: Error): void {
    const timeout = this.projectPrimeTimers.get(sourceUri);
    if (timeout) clearTimeout(timeout);
    this.projectPrimeTimers.delete(sourceUri);
    const queued = this.projectPrimeQueue.get(sourceUri);
    if (queued) this.settlePrime(queued, reason);
    this.projectPrimeQueue.delete(sourceUri);
    const active = this.projectPrimeInFlight.get(sourceUri);
    if (active) {
      active.controller.abort(reason);
      this.settlePrime(active.job, reason);
    }
    this.projectPrimeInFlight.delete(sourceUri);
  }

  private scheduleFileClose(sourceUri: string, uri: string): void {
    const key = canonicalTypstUri(uri);
    if (!this.scheduledCloseFallbacks.has(key) && this.scheduledCloseFallbacks.size >= this.limits.maxCloses) {
      this.port.emit("tinymist/projectInvariant", {
        sourceUri,
        uri: key,
        code: "CloseQueueFull",
        message: `Close limit ${this.limits.maxCloses} reached`
      });
      return;
    }
    this.scheduledFileCloses.add(sourceUri, key);
    if (this.scheduledCloseFallbacks.has(key)) return;
    const revision = this.openFiles.get(key);
    if (revision === undefined) return;
    const timeout = setTimeout(() => {
      this.scheduledCloseFallbacks.delete(key);
      releasePendingProjectFileAfterGrace(
        this.scheduledFileCloses,
        key,
        revision,
        (candidate) => this.openFiles.get(candidate),
        this.projectFiles,
        this.appliedProjectFiles,
        this.retainedProjectFiles,
        (candidate) => this.closeFile(candidate)
      );
    }, this.closeGraceMs);
    this.scheduledCloseFallbacks.set(key, { revision, timeout });
  }

  private cancelScheduledFileClose(uri: string): void {
    const key = canonicalTypstUri(uri);
    this.scheduledFileCloses.deleteUri(key);
    const fallback = this.scheduledCloseFallbacks.get(key);
    if (fallback) clearTimeout(fallback.timeout);
    this.scheduledCloseFallbacks.delete(key);
  }

  private closeFile(uri: string): void {
    const key = canonicalTypstUri(uri);
    this.cancelScheduledFileClose(key);
    this.port.notify("textDocument/didClose", { textDocument: { uri: key } });
    this.openFiles.delete(key);
    this.port.emit("tinymist/virtualFileClosed", { uri: key });
  }

  private cancelBackendWork(reason: Error): void {
    for (const controller of this.requestControllers) controller.abort(reason);
    this.requestControllers.clear();
    for (const sourceUri of new Set([
      ...this.projectPrimeTimers.keys(),
      ...this.projectPrimeQueue.keys(),
      ...this.projectPrimeInFlight.keys()
    ])) this.cancelProjectPrime(sourceUri, reason);
    for (const fallback of this.scheduledCloseFallbacks.values()) clearTimeout(fallback.timeout);
    this.scheduledCloseFallbacks.clear();
    this.scheduledFileCloses.clear();
  }
}
