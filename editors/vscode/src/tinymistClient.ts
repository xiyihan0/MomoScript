import type { ProjectionKey, SourceContentKey, TypstProjectSnapshotKey } from "./runtimeIdentity";
import {
  JsonRpcTinymistTransport,
  TinymistWorkerConnection,
  type JsonRpcMessage,
  type TinymistWorkerFactory
} from "./tinymistTransport";
import {
  DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
  TypstProjectState
} from "./typstProjectState";
export {
  canonicalTypstUri,
  mergeProjectFiles,
  projectionSessionKey,
  ProjectFileCloseRegistry,
  projectFileIsOwned,
  releasePendingProjectFile,
  releasePendingProjectFileAfterGrace,
  rotateProjectFileGenerations,
  type ProjectFileRotation
} from "./typstProjectState";


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
      kind: "workspace-file";
      id: number;
      uri: string;
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
  sourceContent: SourceContentKey;
  projectDigest: TypstProjectSnapshotKey;
  projectionKey: ProjectionKey;
  mappingDigest: string;
}

export interface TypstRenderDiagnosticLabel {
  range: TypstResourceRange;
  message?: string;
}

export interface TypstRenderDiagnostic {
  severity: "info" | "warning" | "error";
  phase: "syntax" | "semantic" | "resolve" | "materialize" | "typst";
  message: string;
  range?: TypstResourceRange;
  labels: TypstRenderDiagnosticLabel[];
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
  diagnostics: TypstRenderDiagnostic[];
  projectDigest: TypstProjectSnapshotKey;
  mappingDigest: string;
  sourceContent: SourceContentKey;
  projectionKey: ProjectionKey;
  packRegistryDigest: string;
  resourcePlanDigest: string;
  resourceBytesDigest: string;
}

export function isTypstTextFile(file: TypstVirtualFile): file is Extract<TypstVirtualFile, { text: string }> {
  return typeof file.text === "string";
}



export interface TinymistHostBackend {
  backendGeneration(): number;
  on(method: string, handler: (params: unknown) => void): void;
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  syncProject(update: TypstProjectUpdate): void;
  semanticTokensLegend?(): { tokenTypes: string[]; tokenModifiers: string[] } | undefined;
  closeProject(sourceUri: string, entryUri: string): boolean;
  projectForEntry(entryUri: string): TypstProjectUpdate | undefined;
  stop(): Promise<void>;
  terminate(): void;
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

export function projectionRevisionIsCurrent(
  backend: { projectForEntry(entryUri: string): { revision: number } | undefined },
  entryUri: string,
  expectedRevision: number
): boolean {
  return backend.projectForEntry(entryUri)?.revision === expectedRevision;
}

export interface TinymistInitializeResult {
  capabilities?: {
    completionProvider?: unknown;
    hoverProvider?: unknown;
    signatureHelpProvider?: unknown;
    semanticTokensProvider?: { legend?: { tokenTypes?: string[]; tokenModifiers?: string[] }; full?: unknown };
  };
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
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly transport: JsonRpcTinymistTransport;
  private readonly projectState: TypstProjectState;
  private semanticLegend: { tokenTypes: string[]; tokenModifiers: string[] } | undefined;
  private ready = false;
  private stopped = false;
  private restarting: Promise<void> | undefined;

  private constructor(
    workerUri: string,
    moduleUri: string,
    wasmUri: string,
    workerFactory: TinymistWorkerFactory,
    closeGraceMs: number
  ) {
    this.transport = new JsonRpcTinymistTransport(
      () => TinymistWorkerConnection.create({ workerUri, moduleUri, wasmUri, workerFactory }),
      { serverRequest: serverRequestResponse }
    );
    this.transport.onNotification((method, params) => this.dispatch(method, params));
    this.transport.onFailure((error, generation) => this.handleRuntimeFailure(error, generation));
    this.projectState = new TypstProjectState({
      request: <T>(method: string, params: unknown, signal?: AbortSignal) =>
        this.transport.request<T>(method, params, signal),
      notify: (method, params) => this.transport.notify(method, params),
      emit: (method, params) => this.dispatch(method, params)
    }, { closeGraceMs });
  }

  static async start(
    workerUri: string,
    moduleUri: string,
    wasmUri: string,
    workerFactory: TinymistWorkerFactory = (uri) => new Worker(uri),
    closeGraceMs = DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS
  ): Promise<TinymistWorkerClient> {
    const client = new TinymistWorkerClient(workerUri, moduleUri, wasmUri, workerFactory, closeGraceMs);
    try {
      await client.bootWorker();
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  backendGeneration(): number {
    return this.transport.generation;
  }

  semanticTokensLegend(): { tokenTypes: string[]; tokenModifiers: string[] } | undefined {
    return this.semanticLegend;
  }

  on(method: string, handler: (params: unknown) => void): void {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    await this.ensureReady();
    return this.projectState.request<T>(method, params, signal);
  }

  notify(method: string, params: unknown): void {
    if (this.ready && this.transport.started) {
      this.transport.notify(method, params);
      return;
    }
    void this.ensureReady()
      .then(() => this.transport.notify(method, params))
      .catch((error: unknown) => this.dispatch("tinymist/clientFailed", { message: String(error) }));
  }

  syncProject(update: TypstProjectUpdate): void {
    this.projectState.syncProject(update);
    if (!this.ready) void this.ensureReady().catch((error: unknown) => {
      this.dispatch("tinymist/clientFailed", { message: String(error) });
    });
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    return this.projectState.projectForEntry(entryUri);
  }

  closeProject(sourceUri: string, entryUri: string): boolean {
    return this.projectState.closeProject(sourceUri, entryUri);
  }

  async restart(): Promise<void> {
    if (this.stopped) throw new Error("Tinymist Worker client stopped");
    const generation = this.transport.generation;
    const error = new Error("Tinymist Worker restart requested");
    this.ready = false;
    this.projectState.deactivateBackend(generation, error);
    this.transport.terminateNow(error);
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery();
    await this.ensureReady();
  }

  terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.projectState.dispose(new Error("Tinymist Worker terminated"));
    this.transport.terminateNow(new Error("Tinymist Worker terminated"));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.projectState.dispose(new Error("Tinymist Worker stopped"));
    await this.transport.stop();
  }

  private async bootWorker(): Promise<void> {
    const session = await this.transport.start({
      processId: null,
      rootUri: null,
      capabilities: {
        workspace: { configuration: true },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          publishDiagnostics: { versionSupport: true, relatedInformation: true },
          semanticTokens: {
            requests: { full: true, range: false },
            tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
            tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
            formats: ["relative"]
          }
        }
      },
      clientInfo: { name: "momoscript-vscode", version: "0.1.0" }
    });
    const initialize = session.initializeResult as TinymistInitializeResult;
    validateTinymistInitialize(initialize);
    const legend = initialize.capabilities?.semanticTokensProvider?.legend;
    if (!legend?.tokenTypes || !legend.tokenModifiers) {
      throw new Error("Tinymist semantic tokens capability with legend is required");
    }
    this.semanticLegend = {
      tokenTypes: [...legend.tokenTypes],
      tokenModifiers: [...legend.tokenModifiers]
    };
    await this.projectState.activateBackend(session.generation);
    this.ready = true;
  }

  private ensureReady(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Tinymist Worker client stopped"));
    if (this.ready) return Promise.resolve();
    this.startRecovery();
    return this.restarting ?? Promise.reject(new Error("Tinymist Worker recovery did not start"));
  }

  private handleRuntimeFailure(error: Error, generation: number): void {
    if (this.stopped || generation !== this.transport.generation) return;
    this.ready = false;
    this.projectState.deactivateBackend(generation, error);
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery();
  }

  private startRecovery(): void {
    if (this.stopped || this.ready || this.restarting) return;
    const recovery = this.bootWorker().then(() => {
      this.dispatch("tinymist/clientRestarted", undefined);
    });
    this.restarting = recovery;
    void recovery.catch((error: unknown) => {
      this.ready = false;
      this.transport.terminateNow(error instanceof Error ? error : new Error(String(error)));
      this.dispatch("tinymist/clientFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => {
      if (this.restarting === recovery) this.restarting = undefined;
    });
  }

  private dispatch(method: string, params: unknown): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params);
  }
}
