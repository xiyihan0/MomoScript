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

export interface TypstResourceRequest {
  id: number;
  uri: string;
  packNamespace: string;
  base: string;
  fileName: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface TypstProjectUpdate {
  sourceUri: string;
  sourceVersion: number;
  revision: number;
  entryUri: string;
  files: TypstVirtualFile[];
  full: boolean;
}

export interface TypstRenderProjectUpdate {
  sourceUri: string;
  sourceVersion: number;
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
  closeProject(sourceUri: string): void;
  projectForEntry(entryUri: string): TypstProjectUpdate | undefined;
  stop(): Promise<void>;
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
  private readonly projectsByEntry = new Map<string, TypstProjectUpdate>();
  private worker: Worker | undefined;
  private ready = false;
  private stopped = false;
  private restarting: Promise<void> | undefined;

  private constructor(
    private readonly workerUri: string,
    private readonly moduleUri: string,
    private readonly wasmUri: string,
    private readonly workerFactory: (uri: string) => Worker
  ) {}

  static async start(
    workerUri: string,
    moduleUri: string,
    wasmUri: string,
    workerFactory: (uri: string) => Worker = (uri) => new Worker(uri)
  ): Promise<TinymistWorkerClient> {
    const client = new TinymistWorkerClient(workerUri, moduleUri, wasmUri, workerFactory);
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
          signatureHelp: {}
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
    const previous = this.projectsByEntry.get(update.entryUri);
    const mergedFiles = update.full || !previous
      ? update.files
      : mergeProjectFiles(previous.files, update.files);
    const merged = { ...update, full: true, files: mergedFiles };
    const currentFiles = new Set(mergedFiles.filter(isTypstTextFile).map((file) => file.uri));
    this.projectFiles.set(update.sourceUri, currentFiles);
    this.projectsByEntry.set(update.entryUri, merged);
    if (this.ready) {
      this.applyProject(update);
    } else {
      void this.ensureReady()
        .then(() => {
          if (this.projectsByEntry.get(update.entryUri) === merged) this.applyProject(merged);
        })
        .catch((error: unknown) => this.dispatch("tinymist/clientFailed", { message: String(error) }));
    }
  }

  private applyProject(update: TypstProjectUpdate): void {
    const currentFiles = this.projectFiles.get(update.sourceUri) ?? new Set<string>();
    for (const file of update.files.filter(isTypstTextFile)) {
      const previousVersion = this.openFiles.get(file.uri);
      if (previousVersion === undefined) {
        this.rawNotify("textDocument/didOpen", {
          textDocument: {
            uri: file.uri,
            languageId: "typst",
            version: update.sourceVersion,
            text: file.text
          }
        });
      } else {
        this.rawNotify("textDocument/didChange", {
          textDocument: { uri: file.uri, version: update.sourceVersion },
          contentChanges: [{ text: file.text }]
        });
      }
      this.openFiles.set(file.uri, update.sourceVersion);
    }
    for (const previous of this.appliedProjectFiles.get(update.sourceUri) ?? []) {
      if (!currentFiles.has(previous)) this.closeFile(previous);
    }
    this.appliedProjectFiles.set(update.sourceUri, new Set(currentFiles));
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    const direct = this.projectsByEntry.get(entryUri);
    if (direct) return direct;
    const normalized = entryUri.replace(/^untitled:\/?/, "untitled:");
    return [...this.projectsByEntry.entries()].find(
      ([uri]) => uri.replace(/^untitled:\/?/, "untitled:") === normalized
    )?.[1];
  }

  closeProject(sourceUri: string): void {
    for (const [entryUri, project] of this.projectsByEntry) {
      if (project.sourceUri === sourceUri) this.projectsByEntry.delete(entryUri);
    }
    if (this.ready) {
      for (const uri of this.appliedProjectFiles.get(sourceUri) ?? []) this.closeFile(uri);
    }
    this.projectFiles.delete(sourceUri);
    this.appliedProjectFiles.delete(sourceUri);
  }

  private closeFile(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri } });
    this.openFiles.delete(uri);
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
