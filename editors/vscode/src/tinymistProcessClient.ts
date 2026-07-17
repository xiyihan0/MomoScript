import {
  createTinymistProcessTransport,
  type TinymistProcessFactory
} from "./tinymistProcessTransport";
import type { TinymistTransport } from "./tinymistTransport";
import {
  DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
  TypstProjectState
} from "./typstProjectState";
import {
  serverRequestResponse,
  validateTinymistInitialize,
  type TinymistHostBackend,
  type TinymistInitializeResult,
  type TypstProjectUpdate
} from "./tinymistClient";

export type { TinymistProcessFactory } from "./tinymistProcessTransport";

export class TinymistProcessClient implements TinymistHostBackend {
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly projectState: TypstProjectState;
  private ready = false;
  private stopped = false;
  private restarting: Promise<void> | undefined;

  private constructor(private readonly transport: TinymistTransport, closeGraceMs: number) {
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
    command: string,
    closeGraceMs = DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
    processFactory?: TinymistProcessFactory
  ): Promise<TinymistProcessClient> {
    const transport = createTinymistProcessTransport(command, {
      processFactory,
      serverRequest: serverRequestResponse
    });
    const client = new TinymistProcessClient(transport, closeGraceMs);
    try {
      await client.bootProcess();
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  backendGeneration(): number {
    return this.transport.generation;
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
    if (this.ready && this.transport.started) this.transport.notify(method, params);
  }

  syncProject(update: TypstProjectUpdate): void {
    this.projectState.syncProject(update);
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    return this.projectState.projectForEntry(entryUri);
  }

  closeProject(sourceUri: string, entryUri: string): boolean {
    return this.projectState.closeProject(sourceUri, entryUri);
  }

  async restart(): Promise<void> {
    if (this.stopped) throw new Error("Tinymist process client stopped");
    const generation = this.transport.generation;
    const error = new Error("Tinymist process restart requested");
    this.ready = false;
    this.projectState.deactivateBackend(generation, error);
    this.transport.terminateNow(error);
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery();
    await this.ensureReady();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.projectState.dispose(new Error("Tinymist process stopped"));
    await this.transport.stop();
  }

  terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.projectState.dispose(new Error("Tinymist process terminated"));
    this.transport.terminateNow(new Error("Tinymist process terminated"));
  }

  private async bootProcess(): Promise<void> {
    const session = await this.transport.start({
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
    validateTinymistInitialize(session.initializeResult as TinymistInitializeResult);
    await this.projectState.activateBackend(session.generation);
    this.ready = true;
  }

  private ensureReady(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Tinymist process client stopped"));
    if (this.ready) return Promise.resolve();
    this.startRecovery();
    return this.restarting ?? Promise.reject(new Error("Tinymist process recovery did not start"));
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
    const recovery = this.bootProcess().then(() => {
      this.dispatch("tinymist/clientRestarted", undefined);
    });
    this.restarting = recovery;
    void recovery.catch((error: unknown) => {
      if (this.stopped) return;
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
