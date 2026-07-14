type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type TypstVirtualFile =
  | { uri: string; text: string; dataBase64?: never }
  | { uri: string; text?: never; dataBase64: string };

export interface TypstResourceRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export type TypstResourceRequest =
  | {
      kind: "image-dir";
      id: number;
      uri: string;
      packNamespace: string;
      base: string;
      fileName: string;
      range: TypstResourceRange;
    }
  | {
      kind: "image-sequence";
      id: number;
      uri: string;
      packNamespace: string;
      path: string;
      frame: number;
      sha256: string;
      size: [number, number];
      frameCount: number;
      container: string;
      codec: string;
      alpha: boolean;
      profile: unknown;
      range: TypstResourceRange;
    };

export interface TypstProjectUpdate {
  sourceUri: string;
  /** LSP version of the authored MMT document. */
  sourceVersion: number;
  /** Monotonic virtual Typst projection version. */
  revision: number;
  entryUri: string;
  files: TypstVirtualFile[];
  full: boolean;
}

export interface TypstRenderProjectUpdate {
  sourceUri: string;
  /** LSP version of the authored MMT document. */
  sourceVersion: number;
  /** Monotonic virtual Typst projection version. */
  revision: number;
  entryUri: string;
  files: TypstVirtualFile[];
  full: true;
  resources: TypstResourceRequest[];
}

export function isTypstTextFile(file: TypstVirtualFile): file is Extract<TypstVirtualFile, { text: string }> {
  return typeof file.text === "string";
}

export function mergeProjectFiles(current: TypstVirtualFile[], changed: TypstVirtualFile[]): TypstVirtualFile[] {
  const files = new Map(current.map((file) => [file.uri, file]));
  for (const file of changed) files.set(file.uri, file);
  return [...files.values()];
}

export interface ProjectedPosition {
  revision: number;
  entryUri: string;
  position: { line: number; character: number };
}

export interface TinymistHostBackend {
  on(method: string, handler: (params: unknown) => void): void;
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  syncProject(update: TypstProjectUpdate): void;
  closeProject(sourceUri: string, entryUri: string): boolean;
  projectForEntry(entryUri: string): TypstProjectUpdate | undefined;
  stop(): Promise<void>;
}

export function diagnosticVersionMatchesProjection(
  projectionRevision: number,
  diagnosticVersion: number | null | undefined
): boolean {
  if (diagnosticVersion == null) {
    // Compatibility fallback for servers without versioned diagnostics. Such
    // notifications cannot be distinguished from stale results.
    return true;
  }
  return diagnosticVersion === projectionRevision;
}
export function canonicalTypstUri(uri: string): string {
  if (!uri.startsWith("untitled:")) return uri;
  return `untitled:/${uri.slice("untitled:".length).replace(/^\/+/, "")}`;
}


export function projectionSessionKey(entryUri: string): string {
  entryUri = canonicalTypstUri(entryUri);
  const separator = entryUri.lastIndexOf("/");
  return separator < 0 ? entryUri : entryUri.slice(0, separator);
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
  const nextRetained = [...retained];
  if (applied) nextRetained.push(applied);
  const expired: Set<string>[] = [];
  while (nextRetained.length > maxRetainedGenerations) {
    const generation = nextRetained.shift();
    if (generation) expired.push(generation);
  }
  const live = new Set(current);
  for (const generation of nextRetained) {
    for (const uri of generation) live.add(uri);
  }
  const close = new Set<string>();
  for (const generation of expired) {
    for (const uri of generation) {
      if (!live.has(uri)) close.add(uri);
    }
  }
  return { retained: nextRetained, close: [...close] };
}

export class ProjectFileCloseRegistry {
  private readonly bySource = new Map<string, Set<string>>();

  has(sourceUri: string, uri: string): boolean {
    return this.bySource.get(sourceUri)?.has(canonicalTypstUri(uri)) ?? false;
  }

  hasUri(uri: string): boolean {
    const key = canonicalTypstUri(uri);
    for (const files of this.bySource.values()) {
      if (files.has(key)) return true;
    }
    return false;
  }

  add(sourceUri: string, uri: string): void {
    let files = this.bySource.get(sourceUri);
    if (!files) {
      files = new Set<string>();
      this.bySource.set(sourceUri, files);
    }
    files.add(canonicalTypstUri(uri));
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


  take(uri: string): boolean {
    return this.deleteUri(uri);
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
  uri = canonicalTypstUri(uri);
  for (const files of projectFiles.values()) {
    if (files.has(uri)) return true;
  }
  for (const files of appliedProjectFiles.values()) {
    if (files.has(uri)) return true;
  }
  for (const generations of retainedProjectFiles.values()) {
    if (generations.some((files) => files.has(uri))) return true;
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
  uri = canonicalTypstUri(uri);
  if (!scheduled.hasUri(uri)) return false;
  if (
    isOpen(uri) &&
    projectFileIsOwned(uri, projectFiles, appliedProjectFiles, retainedProjectFiles)
  ) {
    return false;
  }
  scheduled.take(uri);
  if (!isOpen(uri)) return false;
  close(uri);
  return true;
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
  uri = canonicalTypstUri(uri);
  if (openRevision(uri) !== expectedRevision) return false;
  return releasePendingProjectFile(
    scheduled,
    uri,
    (candidate) => openRevision(candidate) !== undefined,
    projectFiles,
    appliedProjectFiles,
    retainedProjectFiles,
    close
  );
}

export function projectionRevisionIsCurrent(
  backend: { projectForEntry(entryUri: string): { revision: number } | undefined },
  entryUri: string,
  expectedRevision: number
): boolean {
  return backend.projectForEntry(entryUri)?.revision === expectedRevision;
}

export interface TinymistInitializeResult {
  capabilities?: { completionProvider?: unknown; hoverProvider?: unknown; signatureHelpProvider?: unknown };
  serverInfo?: { name?: string; version?: string };
}

export function validateTinymistInitialize(result: TinymistInitializeResult): void {
  if (result.serverInfo?.version !== "0.15.2") {
    throw new Error(`Tinymist 0.15.2 required, received ${result.serverInfo?.version ?? "unknown"}`);
  }
  const capabilities = result.capabilities;
  if (!capabilities?.completionProvider || !capabilities.hoverProvider || !capabilities.signatureHelpProvider) {
    throw new Error("Tinymist completion, hover, and signature help capabilities are required");
  }
}
export function serverRequestResponse(message: JsonRpcMessage): JsonRpcMessage {
  const id = message.id ?? null;
  if (message.method === "workspace/configuration") {
    const items = isRecord(message.params) && Array.isArray(message.params.items)
      ? message.params.items
      : [];
    return { jsonrpc: "2.0", id, result: items.map(() => null) };
  }
  if (message.method === "window/workDoneProgress/create" || message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
    return { jsonrpc: "2.0", id, result: null };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported Tinymist server request: ${message.method ?? "unknown"}` } };
}

export const DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS = 30_000;

export class TinymistWorkerClient implements TinymistHostBackend {
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly openFiles = new Map<string, number>();
  private readonly projectFiles = new Map<string, Set<string>>();
  private readonly appliedProjectFiles = new Map<string, Set<string>>();
  private readonly retainedProjectFiles = new Map<string, Set<string>[]>();
  private readonly projectsByEntry = new Map<string, TypstProjectUpdate>();
  private readonly latestProjectionBySource = new Map<string, { session: string; revision: number }>();
  private readonly retiredSessionsBySource = new Map<string, Set<string>>();
  private readonly appliedProjectionBySource = new Map<string, { session: string; revision: number }>();
  private readonly scheduledFileCloses = new ProjectFileCloseRegistry();
  private readonly scheduledCloseFallbacks = new Map<
    string,
    { revision: number; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly projectPrimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly projectPrimeQueue = new Map<string, string>();
  private readonly projectPrimeInFlight = new Map<string, symbol>();
  private worker: Worker | undefined;
  private ready = false;
  private stopped = false;
  private restarting: Promise<void> | undefined;

  private constructor(
    private readonly workerUri: string,
    private readonly moduleUri: string,
    private readonly wasmUri: string,
    private readonly workerFactory: (uri: string) => Worker,
    private readonly closeGraceMs: number
  ) {}

  static async start(
    workerUri: string,
    moduleUri: string,
    wasmUri: string,
    workerFactory: (uri: string) => Worker = (uri) => new Worker(uri),
    closeGraceMs = DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS
  ): Promise<TinymistWorkerClient> {
    const client = new TinymistWorkerClient(workerUri, moduleUri, wasmUri, workerFactory, closeGraceMs);
    try {
      await client.bootWorker();
      client.ready = true;
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  private async bootWorker(): Promise<void> {
    if (this.stopped) throw new Error("Tinymist Worker client stopped");
    const worker = this.workerFactory(this.workerUri);
    this.worker = worker;
    worker.addEventListener("message", (event: MessageEvent<JsonRpcMessage>) => {
      if (worker === this.worker) this.handleMessage(worker, event.data);
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Tinymist Worker startup timed out")), 60_000);
      const onWorkerError = (event: ErrorEvent) => {
        clearTimeout(timeout);
        this.failPending(new Error(event.message || "Tinymist Worker failed to load"));
        worker.terminate();
        reject(new Error(event.message || "Tinymist Worker failed to load"));
      };
      const onMessage = (event: MessageEvent<JsonRpcMessage>) => {
        if (event.data.method === "tinymist/workerReady") {
          const params = event.data.params;
          const protocolVersion = isRecord(params) ? params.protocolVersion : undefined;
          const backendVersion = isRecord(params) ? params.backendVersion : undefined;
          if (protocolVersion !== 1 || backendVersion !== "0.15.2") finish(new Error("Incompatible Tinymist Worker backend"));
          else finish();
        } else if (event.data.method === "tinymist/workerFailed") {
          const params = event.data.params;
          const message = isRecord(params) && typeof params.message === "string" ? params.message : "Tinymist Worker failed";
          finish(new Error(message));
        }
      };
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onWorkerError);
        if (error) {
          worker.terminate();
          reject(error);
        } else {
          resolve();
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onWorkerError);
      worker.postMessage({
        method: "tinymist/boot",
        params: { moduleUri: this.moduleUri, wasmUri: this.wasmUri }
      });
    });
    const initialize = await this.rawRequest<TinymistInitializeResult>("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {
        workspace: { configuration: true },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          publishDiagnostics: { versionSupport: true, relatedInformation: true }
        }
      },
      clientInfo: { name: "momoscript-vscode", version: "0.1.0" }
    });
    validateTinymistInitialize(initialize);
    this.rawNotify("initialized", {});
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.handleRuntimeFailure(worker, new Error(event.message || "Tinymist Worker failed"));
    });
    worker.addEventListener("messageerror", () => {
      this.handleRuntimeFailure(worker, new Error("Tinymist Worker message could not be deserialized"));
    });
  }

  on(method: string, handler: (params: unknown) => void): void {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    await this.ensureReady();
    return this.rawRequest<T>(method, params, signal);
  }

  private rawRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Tinymist Worker is unavailable"));
    if (signal?.aborted) return Promise.reject(new DOMException("Tinymist request cancelled", "AbortError"));
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        this.rawNotify("$/cancelRequest", { id });
        reject(new DOMException("Tinymist request cancelled", "AbortError"));
      };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(new Error(`Tinymist Worker request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", cancel); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", cancel); reject(error); },
        timeout
      });
      signal?.addEventListener("abort", cancel, { once: true });
    });
    worker.postMessage({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method: string, params: unknown): void {
    if (this.ready && this.worker) {
      this.rawNotify(method, params);
      return;
    }
    void this.ensureReady()
      .then(() => this.rawNotify(method, params))
      .catch((error: unknown) => this.dispatch("tinymist/clientFailed", { message: String(error) }));
  }

  private rawNotify(method: string, params: unknown): void {
    this.worker?.postMessage({ jsonrpc: "2.0", method, params });
  }

  syncProject(update: TypstProjectUpdate): void {
    const session = projectionSessionKey(update.entryUri);
    const latestProjection = this.latestProjectionBySource.get(update.sourceUri);
    const retiredSessions = this.retiredSessionsBySource.get(update.sourceUri);
    if (retiredSessions?.has(session)) return;
    if ((!latestProjection || latestProjection.session !== session) && !update.full) return;
    if (latestProjection && latestProjection.session !== session) {
      const nextRetiredSessions = retiredSessions ?? new Set<string>();
      nextRetiredSessions.add(latestProjection.session);
      this.retiredSessionsBySource.set(update.sourceUri, nextRetiredSessions);
    }
    if (latestProjection?.session === session && update.revision <= latestProjection.revision) return;

    const previous = latestProjection?.session === session
      ? [...this.projectsByEntry.values()].find((project) => project.sourceUri === update.sourceUri)
      : undefined;
    const previousFiles = previous && canonicalTypstUri(previous.entryUri) !== canonicalTypstUri(update.entryUri)
      ? previous.files.filter((file) => canonicalTypstUri(file.uri) !== canonicalTypstUri(previous.entryUri))
      : previous?.files;
    const mergedFiles = update.full || !previousFiles
      ? update.files
      : mergeProjectFiles(previousFiles, update.files);
    const merged = { ...update, full: true, files: mergedFiles };
    const currentFiles = new Set(mergedFiles.filter(isTypstTextFile).map((file) => canonicalTypstUri(file.uri)));
    for (const [entryUri, project] of this.projectsByEntry) {
      if (project.sourceUri === update.sourceUri) this.projectsByEntry.delete(entryUri);
    }
    this.latestProjectionBySource.set(update.sourceUri, { session, revision: update.revision });
    this.projectFiles.set(update.sourceUri, currentFiles);
    this.projectsByEntry.set(canonicalTypstUri(update.entryUri), merged);
    if (this.ready) {
      this.applyProject(update);
    } else {
      void this.ensureReady()
        .then(() => {
          if (this.projectsByEntry.get(canonicalTypstUri(update.entryUri)) === merged) this.applyProject(merged);
        })
        .catch((error: unknown) => this.dispatch("tinymist/clientFailed", { message: String(error) }));
    }
  }

  private applyProject(update: TypstProjectUpdate): void {
    const session = projectionSessionKey(update.entryUri);
    const appliedProjection = this.appliedProjectionBySource.get(update.sourceUri);
    if (appliedProjection?.session === session && update.revision <= appliedProjection.revision) return;
    const currentFiles = this.projectFiles.get(update.sourceUri) ?? new Set<string>();
    for (const file of update.files.filter(isTypstTextFile)) {
      const uri = canonicalTypstUri(file.uri);
      this.cancelScheduledFileClose(uri);
      const previousVersion = this.openFiles.get(uri);
      if (previousVersion === undefined) {
        this.rawNotify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: "typst",
            version: update.revision,
            text: file.text
          }
        });
      } else {
        this.rawNotify("textDocument/didChange", {
          textDocument: { uri, version: update.revision },
          contentChanges: [{ text: file.text }]
        });
      }
      this.openFiles.set(uri, update.revision);
    }
    const rotation = rotateProjectFileGenerations(
      currentFiles,
      this.appliedProjectFiles.get(update.sourceUri),
      this.retainedProjectFiles.get(update.sourceUri) ?? []
    );
    this.retainedProjectFiles.set(update.sourceUri, rotation.retained);
    this.appliedProjectFiles.set(update.sourceUri, currentFiles);
    this.appliedProjectionBySource.set(update.sourceUri, { session, revision: update.revision });
    for (const uri of rotation.close) this.scheduleFileClose(update.sourceUri, uri);
    this.primeProject(update.sourceUri, update.entryUri);
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
    this.cancelProjectPrime(sourceUri);
    if (this.ready) {
      for (const uri of files) this.scheduleFileClose(sourceUri, uri);
    }
    return true;
  }


  private scheduleFileClose(sourceUri: string, uri: string): void {
    uri = canonicalTypstUri(uri);
    this.scheduledFileCloses.add(sourceUri, uri);
    this.scheduleCloseFallback(uri);
  }

  private cancelScheduledFileClose(uri: string): void {
    uri = canonicalTypstUri(uri);
    this.scheduledFileCloses.deleteUri(uri);
    this.cancelCloseFallback(uri);
  }



  private primeProject(sourceUri: string, entryUri: string): void {
    this.projectPrimeQueue.set(sourceUri, canonicalTypstUri(entryUri));
    if (!this.projectPrimeInFlight.has(sourceUri)) this.scheduleProjectPrime(sourceUri);
  }

  private scheduleProjectPrime(sourceUri: string): void {
    const previous = this.projectPrimeTimers.get(sourceUri);
    if (previous) clearTimeout(previous);
    const timeout = setTimeout(() => this.runProjectPrime(sourceUri), 250);
    this.projectPrimeTimers.set(sourceUri, timeout);
  }

  private runProjectPrime(sourceUri: string): void {
    this.projectPrimeTimers.delete(sourceUri);
    if (this.projectPrimeInFlight.has(sourceUri)) return;
    const entryUri = this.projectPrimeQueue.get(sourceUri);
    if (!entryUri) return;
    this.projectPrimeQueue.delete(sourceUri);
    const token = Symbol(sourceUri);
    this.projectPrimeInFlight.set(sourceUri, token);
    void this.rawRequest(
      "textDocument/foldingRange",
      { textDocument: { uri: entryUri } }
    ).then(() => {
      this.dispatch("tinymist/projectPrimed", { sourceUri, entryUri });
    }, (error: unknown) => {
      if (!this.stopped) console.error("Tinymist projection prime failed", error);
      this.dispatch("tinymist/projectPrimeFailed", { sourceUri, entryUri, error: String(error) });
    }).finally(() => {
      if (this.projectPrimeInFlight.get(sourceUri) !== token) return;
      this.projectPrimeInFlight.delete(sourceUri);
      if (this.projectPrimeQueue.has(sourceUri)) this.scheduleProjectPrime(sourceUri);
    });
  }

  private cancelProjectPrime(sourceUri: string): void {
    const timeout = this.projectPrimeTimers.get(sourceUri);
    if (timeout) clearTimeout(timeout);
    this.projectPrimeTimers.delete(sourceUri);
    this.projectPrimeQueue.delete(sourceUri);
  }

  private clearProjectPrimes(): void {
    for (const timeout of this.projectPrimeTimers.values()) clearTimeout(timeout);
    this.projectPrimeTimers.clear();
    this.projectPrimeQueue.clear();
    this.projectPrimeInFlight.clear();
  }

  private scheduleCloseFallback(uri: string): void {
    if (this.scheduledCloseFallbacks.has(uri)) return;
    const revision = this.openFiles.get(uri);
    if (revision === undefined) return;
    const timeout = setTimeout(() => {
      this.scheduledCloseFallbacks.delete(uri);
      releasePendingProjectFileAfterGrace(
        this.scheduledFileCloses,
        uri,
        revision,
        (candidate) => this.openFiles.get(candidate),
        this.projectFiles,
        this.appliedProjectFiles,
        this.retainedProjectFiles,
        (candidate) => this.closeFile(candidate)
      );
    }, this.closeGraceMs);
    this.scheduledCloseFallbacks.set(uri, { revision, timeout });
  }

  private cancelCloseFallback(uri: string): void {
    const fallback = this.scheduledCloseFallbacks.get(uri);
    if (fallback) clearTimeout(fallback.timeout);
    this.scheduledCloseFallbacks.delete(uri);
  }

  private clearCloseFallbacks(): void {
    for (const fallback of this.scheduledCloseFallbacks.values()) clearTimeout(fallback.timeout);
    this.scheduledCloseFallbacks.clear();
  }

  private closeFile(uri: string): void {
    uri = canonicalTypstUri(uri);
    this.cancelCloseFallback(uri);
    this.scheduledFileCloses.deleteUri(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
    this.openFiles.delete(uri);
    this.dispatch("tinymist/virtualFileClosed", { uri });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      if (this.ready && this.worker) {
        await this.rawRequest("shutdown", null);
        this.rawNotify("exit", null);
      }
    } finally {
      this.ready = false;
      this.worker?.terminate();
      this.worker = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Tinymist Worker stopped"));
      }
      this.pending.clear();
      this.scheduledFileCloses.clear();
      this.clearCloseFallbacks();
      this.clearProjectPrimes();
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async restart(): Promise<void> {
    if (this.stopped) throw new Error("Tinymist Worker client stopped");
    this.handleRuntimeFailure(this.worker, new Error("Tinymist Worker restart requested"));
    await this.ensureReady();
  }

  private ensureReady(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Tinymist Worker client stopped"));
    if (this.ready) return Promise.resolve();
    this.startRecovery();
    return this.restarting ?? Promise.reject(new Error("Tinymist Worker recovery did not start"));
  }

  private handleRuntimeFailure(worker: Worker | undefined, error: Error): void {
    if (this.stopped || !worker || worker !== this.worker) return;
    this.ready = false;
    this.failPending(error);
    worker.terminate();
    this.worker = undefined;
    this.openFiles.clear();
    this.appliedProjectFiles.clear();
    this.retainedProjectFiles.clear();
    this.appliedProjectionBySource.clear();
    this.scheduledFileCloses.clear();
    this.clearCloseFallbacks();
    this.clearProjectPrimes();
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery();
  }

  private startRecovery(): void {
    if (this.stopped || this.ready || this.restarting) return;
    const recovery = (async () => {
      await this.bootWorker();
      if (this.stopped) throw new Error("Tinymist Worker client stopped");
      for (const update of this.projectsByEntry.values()) this.applyProject(update);
      this.ready = true;
      this.dispatch("tinymist/clientRestarted", undefined);
    })();
    this.restarting = recovery;
    void recovery
      .catch((error: unknown) => {
        this.ready = false;
        this.worker?.terminate();
        this.worker = undefined;
        this.dispatch("tinymist/clientFailed", {
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.restarting === recovery) this.restarting = undefined;
      });
  }

  private handleMessage(worker: Worker, message: JsonRpcMessage): void {
    if (message.method && message.id !== undefined) {
      worker.postMessage(serverRequestResponse(message));
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.dispatch(message.method, message.params);
  }

  private dispatch(method: string, params: unknown): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params);
  }
}
