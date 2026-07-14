import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";

import {
  canonicalTypstUri,
  DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
  releasePendingProjectFileAfterGrace,
  serverRequestResponse,
  validateTinymistInitialize,
  isTypstTextFile,
  mergeProjectFiles,
  projectionSessionKey,
  ProjectFileCloseRegistry,
  rotateProjectFileGenerations,
  type TinymistHostBackend,
  type TinymistInitializeResult,
  type TypstProjectUpdate
} from "./tinymistClient";

type JsonRpcId = number | string;
interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}
export type TinymistProcessFactory = (command: string) => ChildProcessWithoutNullStreams;
interface ProjectPrimeJob {
  sourceUri: string;
  entryUri: string;
  session: string;
  revision: number;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function spawnTinymistProcess(command: string): ChildProcessWithoutNullStreams {
  return spawn(command, ["--log-filter", process.env.TINYMIST_LOG ?? "error", "lsp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TINYMIST_LOG: process.env.TINYMIST_LOG ?? "error" }
  });
}

export class TinymistProcessClient implements TinymistHostBackend {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
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
  private readonly projectPrimeQueue = new Map<string, ProjectPrimeJob>();
  private readonly projectPrimeInFlight = new Map<string, { token: symbol; job: ProjectPrimeJob }>();
  private readonly projectPrimeByEntry = new Map<string, ProjectPrimeJob>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready = false;
  private stopped = false;
  private restarting: Promise<void> | undefined;

  private constructor(
    private readonly command: string,
    private readonly closeGraceMs: number,
    private readonly processFactory: TinymistProcessFactory
  ) {}

  static async start(
    command: string,
    closeGraceMs = DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
    processFactory: TinymistProcessFactory = spawnTinymistProcess
  ): Promise<TinymistProcessClient> {
    const client = new TinymistProcessClient(command, closeGraceMs, processFactory);
    try {
      await client.bootProcess();
      client.ready = true;
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  on(method: string, handler: (params: unknown) => void): void {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    await this.ensureReady();
    await this.waitForProjectPrime(params, signal);
    return this.rawRequest<T>(method, params, signal);
  }

  notify(method: string, params: unknown): void {
    if (this.ready) this.rawNotify(method, params);
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
    for (const [entryUri, project] of this.projectsByEntry) {
      if (project.sourceUri === update.sourceUri) this.projectsByEntry.delete(entryUri);
    }
    this.latestProjectionBySource.set(update.sourceUri, { session, revision: update.revision });
    this.projectFiles.set(
      update.sourceUri,
      new Set(mergedFiles.filter(isTypstTextFile).map((file) => canonicalTypstUri(file.uri)))
    );
    this.projectsByEntry.set(canonicalTypstUri(update.entryUri), merged);
    if (this.ready) this.applyProject(update.full ? merged : update);
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

  async restart(): Promise<void> {
    if (this.stopped) throw new Error("Tinymist process client stopped");
    this.handleRuntimeFailure(this.child, new Error("Tinymist process restart requested"));
    await this.ensureReady();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    try {
      if (this.ready && child?.exitCode === null) {
        await this.rawRequest("shutdown", null);
        this.rawNotify("exit", null);
      }
    } finally {
      this.ready = false;
      if (child?.exitCode === null) child.kill();
      this.child = undefined;
      this.scheduledFileCloses.clear();
      this.clearCloseFallbacks();
      this.clearProjectPrimes();
      this.failPending(new Error("Tinymist process stopped"));
    }
  }

  private async bootProcess(): Promise<void> {
    if (this.stopped) throw new Error("Tinymist process client stopped");
    const child = this.processFactory(this.command);
    this.child = child;
    this.buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (child !== this.child) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        this.drainMessages(child);
      } catch (error) {
        this.handleRuntimeFailure(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (/\b(?:ERROR|WARN)\b/.test(text)) console.error(`[tinymist] ${text}`);
    });
    child.once("error", (error) => this.handleRuntimeFailure(child, error));
    child.once("exit", (code, signal) => {
      if (!this.stopped) this.handleRuntimeFailure(child, new Error(`Tinymist exited with ${code ?? signal}`));
    });
    try {
      const initialize = await this.rawRequest<TinymistInitializeResult>("initialize", {
        processId: process.pid,
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
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.discardProcess(child, failure);
      throw failure;
    }
  }

  private ensureReady(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Tinymist process client stopped"));
    if (this.ready) return Promise.resolve();
    this.startRecovery();
    return this.restarting ?? Promise.reject(new Error("Tinymist process recovery did not start"));
  }

  private startRecovery(): void {
    if (this.stopped || this.ready || this.restarting) return;
    const recovery = (async () => {
      await this.bootProcess();
      for (const update of this.projectsByEntry.values()) this.applyProject(update);
      this.ready = true;
      this.dispatch("tinymist/clientRestarted", undefined);
    })();
    this.restarting = recovery;
    void recovery.catch((error: unknown) => {
      if (this.stopped) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.discardProcess(this.child, failure);
      this.dispatch("tinymist/clientFailed", { message: failure.message });
    }).finally(() => {
      if (this.restarting === recovery) this.restarting = undefined;
    });
  }

  private handleRuntimeFailure(child: ChildProcessWithoutNullStreams | undefined, error: Error): void {
    if (!this.discardProcess(child, error)) return;
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery();
  }

  private discardProcess(child: ChildProcessWithoutNullStreams | undefined, error: Error): boolean {
    if (this.stopped || !child || child !== this.child) return false;
    this.ready = false;
    this.failPending(error);
    this.child = undefined;
    if (child.exitCode === null) child.kill();
    this.buffer = Buffer.alloc(0);
    this.openFiles.clear();
    this.appliedProjectFiles.clear();
    this.retainedProjectFiles.clear();
    this.appliedProjectionBySource.clear();
    this.scheduledFileCloses.clear();
    this.clearCloseFallbacks();
    this.clearProjectPrimes();
    return true;
  }

  private rawRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.child) return Promise.reject(new Error("Tinymist process unavailable"));
    if (signal?.aborted) return Promise.reject(new Error("Tinymist request cancelled"));
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        this.rawNotify("$/cancelRequest", { id });
        reject(new Error("Tinymist request cancelled"));
      };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(new Error(`Tinymist request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", cancel); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", cancel); reject(error); },
        timeout
      });
      signal?.addEventListener("abort", cancel, { once: true });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  private rawNotify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private applyProject(update: TypstProjectUpdate): void {
    const session = projectionSessionKey(update.entryUri);
    const appliedProjection = this.appliedProjectionBySource.get(update.sourceUri);
    if (appliedProjection?.session === session && update.revision <= appliedProjection.revision) return;
    const currentFiles = this.projectFiles.get(update.sourceUri) ?? new Set<string>();
    for (const file of update.files.filter(isTypstTextFile)) {
      const uri = canonicalTypstUri(file.uri);
      this.cancelScheduledFileClose(uri);
      if (this.openFiles.has(uri)) {
        this.rawNotify("textDocument/didChange", {
          textDocument: { uri, version: update.revision },
          contentChanges: [{ text: file.text }]
        });
      } else {
        this.rawNotify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typst", version: update.revision, text: file.text }
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
    entryUri = canonicalTypstUri(entryUri);
    const projection = this.appliedProjectionBySource.get(sourceUri);
    if (!projection) return;
    const previous = this.projectPrimeQueue.get(sourceUri);
    if (previous) this.failProjectPrime(previous, new Error("Tinymist projection prime superseded"));
    const { promise, resolve, reject } = deferred();
    void promise.catch(() => {});
    const job: ProjectPrimeJob = {
      sourceUri,
      entryUri,
      session: projection.session,
      revision: projection.revision,
      promise,
      resolve,
      reject
    };
    this.projectPrimeQueue.set(sourceUri, job);
    this.projectPrimeByEntry.set(entryUri, job);
    if (!this.projectPrimeInFlight.has(sourceUri)) this.scheduleProjectPrime(sourceUri);
  }

  private scheduleProjectPrime(sourceUri: string): void {
    clearTimeout(this.projectPrimeTimers.get(sourceUri));
    const delay = 250;
    const timeout = setTimeout(() => this.runProjectPrime(sourceUri), delay);
    this.projectPrimeTimers.set(sourceUri, timeout);
  }

  private runProjectPrime(sourceUri: string): void {
    this.projectPrimeTimers.delete(sourceUri);
    if (this.projectPrimeInFlight.has(sourceUri)) return;
    const job = this.projectPrimeQueue.get(sourceUri);
    if (!job) return;
    this.projectPrimeQueue.delete(sourceUri);
    const token = Symbol(sourceUri);
    this.projectPrimeInFlight.set(sourceUri, { token, job });
    void this.rawRequest(
      "textDocument/foldingRange",
      { textDocument: { uri: job.entryUri } }
    ).then(() => {
      this.dispatch("tinymist/projectPrimed", {
        sourceUri,
        entryUri: job.entryUri,
        session: job.session,
        revision: job.revision
      });
      this.finishProjectPrime(job);
    }, (error: unknown) => {
      if (!this.stopped) console.error("Tinymist projection prime failed", error);
      this.dispatch("tinymist/projectPrimeFailed", {
        sourceUri,
        entryUri: job.entryUri,
        session: job.session,
        revision: job.revision,
        error: String(error)
      });
      this.failProjectPrime(job, error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      const active = this.projectPrimeInFlight.get(sourceUri);
      if (active?.token !== token) return;
      this.projectPrimeInFlight.delete(sourceUri);
      if (this.projectPrimeQueue.has(sourceUri)) this.scheduleProjectPrime(sourceUri);
    });
  }

  private async waitForProjectPrime(params: unknown, signal?: AbortSignal): Promise<void> {
    const entryUri = requestTextDocumentUri(params);
    if (!entryUri) return;
    while (true) {
      const job = this.projectPrimeByEntry.get(entryUri);
      if (!job) return;
      await waitForPrimeOrAbort(job.promise, signal);
      if (this.projectPrimeByEntry.get(entryUri) === job) return;
    }
  }

  private finishProjectPrime(job: ProjectPrimeJob): void {
    if (this.projectPrimeByEntry.get(job.entryUri) === job) this.projectPrimeByEntry.delete(job.entryUri);
    job.resolve();
  }

  private failProjectPrime(job: ProjectPrimeJob, error: Error): void {
    if (this.projectPrimeByEntry.get(job.entryUri) === job) this.projectPrimeByEntry.delete(job.entryUri);
    job.reject(error);
  }

  private cancelProjectPrime(sourceUri: string): void {
    clearTimeout(this.projectPrimeTimers.get(sourceUri));
    this.projectPrimeTimers.delete(sourceUri);
    const cancellation = new Error("Tinymist projection prime cancelled");
    const queued = this.projectPrimeQueue.get(sourceUri);
    if (queued) this.failProjectPrime(queued, cancellation);
    this.projectPrimeQueue.delete(sourceUri);
    const active = this.projectPrimeInFlight.get(sourceUri);
    if (active) this.failProjectPrime(active.job, cancellation);
    this.projectPrimeInFlight.delete(sourceUri);
  }

  private clearProjectPrimes(): void {
    for (const timeout of this.projectPrimeTimers.values()) clearTimeout(timeout);
    this.projectPrimeTimers.clear();
    const cancellation = new Error("Tinymist projection prime cancelled");
    for (const job of this.projectPrimeQueue.values()) this.failProjectPrime(job, cancellation);
    for (const { job } of this.projectPrimeInFlight.values()) this.failProjectPrime(job, cancellation);
    this.projectPrimeQueue.clear();
    this.projectPrimeInFlight.clear();
    this.projectPrimeByEntry.clear();
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
    this.rawNotify("textDocument/didClose", { textDocument: { uri } });
    this.openFiles.delete(uri);
    this.dispatch("tinymist/virtualFileClosed", { uri });
  }

  private send(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child) throw new Error("Tinymist process unavailable");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  private drainMessages(child: ChildProcessWithoutNullStreams): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!length) throw new Error("Tinymist response omitted Content-Length");
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(length);
      if (this.buffer.length < bodyEnd) return;
      const message: JsonRpcMessage = JSON.parse(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleMessage(child, message);
    }
  }

  private handleMessage(child: ChildProcessWithoutNullStreams, message: JsonRpcMessage): void {
    if (message.method && message.id !== undefined) {
      this.send(serverRequestResponse(message));
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
    if (message.method && child === this.child) this.dispatch(message.method, message.params);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private dispatch(method: string, params: unknown): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params);
  }
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  const events = new EventEmitter();
  const promise = once(events, "resolve").then(() => undefined);
  let settled = false;
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      events.emit("resolve");
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      events.emit("error", error);
    }
  };
}

function requestTextDocumentUri(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const textDocument = Reflect.get(params, "textDocument");
  if (!textDocument || typeof textDocument !== "object") return undefined;
  const uri = Reflect.get(textDocument, "uri");
  return typeof uri === "string" ? canonicalTypstUri(uri) : undefined;
}

function waitForPrimeOrAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Tinymist request cancelled"));
  const { promise: abortable, resolve, reject } = deferred();
  const abort = () => reject(signal.reason ?? new Error("Tinymist request cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  return abortable;
}
