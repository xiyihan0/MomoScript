import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  serverRequestResponse,
  validateTinymistInitialize,
  isTypstTextFile,
  mergeProjectFiles,
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

export class TinymistProcessClient implements TinymistHostBackend {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly openFiles = new Map<string, number>();
  private readonly projectFiles = new Map<string, Set<string>>();
  private readonly projectsByEntry = new Map<string, TypstProjectUpdate>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready = false;
  private stopped = false;
  private restarting: Promise<void> | undefined;

  private constructor(private readonly command: string) {}

  static async start(command: string): Promise<TinymistProcessClient> {
    const client = new TinymistProcessClient(command);
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
    return this.rawRequest<T>(method, params, signal);
  }

  notify(method: string, params: unknown): void {
    if (this.ready) this.rawNotify(method, params);
  }

  syncProject(update: TypstProjectUpdate): void {
    const previous = this.projectsByEntry.get(update.entryUri);
    const mergedFiles = update.full || !previous
      ? update.files
      : mergeProjectFiles(previous.files, update.files);
    const merged = { ...update, full: true, files: mergedFiles };
    this.projectFiles.set(update.sourceUri, new Set(mergedFiles.filter(isTypstTextFile).map((file) => file.uri)));
    this.projectsByEntry.set(update.entryUri, merged);
    if (this.ready) this.applyProject(update.full ? merged : update);
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
      for (const uri of this.projectFiles.get(sourceUri) ?? []) this.closeFile(uri);
    }
    this.projectFiles.delete(sourceUri);
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
      this.failPending(new Error("Tinymist process stopped"));
    }
  }

  private async bootProcess(): Promise<void> {
    if (this.stopped) throw new Error("Tinymist process client stopped");
    const child = spawn(this.command, ["--log-filter", process.env.TINYMIST_LOG ?? "error", "lsp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TINYMIST_LOG: process.env.TINYMIST_LOG ?? "error" }
    });
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
    const initialize = await this.rawRequest<TinymistInitializeResult>("initialize", {
      processId: process.pid,
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
      this.ready = false;
      this.dispatch("tinymist/clientFailed", { message: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (this.restarting === recovery) this.restarting = undefined;
    });
  }

  private handleRuntimeFailure(child: ChildProcessWithoutNullStreams | undefined, error: Error): void {
    if (this.stopped || !child || child !== this.child) return;
    this.ready = false;
    this.failPending(error);
    if (child.exitCode === null) child.kill();
    this.child = undefined;
    this.openFiles.clear();
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery();
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
    const currentFiles = this.projectFiles.get(update.sourceUri) ?? new Set<string>();
    for (const file of update.files.filter(isTypstTextFile)) {
      if (this.openFiles.has(file.uri)) {
        this.rawNotify("textDocument/didChange", {
          textDocument: { uri: file.uri, version: update.sourceVersion },
          contentChanges: [{ text: file.text }]
        });
      } else {
        this.rawNotify("textDocument/didOpen", {
          textDocument: { uri: file.uri, languageId: "typst", version: update.sourceVersion, text: file.text }
        });
      }
      this.openFiles.set(file.uri, update.sourceVersion);
    }
    for (const previous of this.projectFiles.get(update.sourceUri) ?? []) {
      if (!currentFiles.has(previous)) this.closeFile(previous);
    }
  }

  private closeFile(uri: string): void {
    this.rawNotify("textDocument/didClose", { textDocument: { uri } });
    this.openFiles.delete(uri);
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
