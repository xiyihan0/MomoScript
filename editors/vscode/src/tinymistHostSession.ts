import {
  TinymistCapabilityRegistry,
  TinymistServerRequestDispatcher,
  type TinymistCapabilityView
} from "./tinymistCapabilities";
import type { TypstProjectUpdate } from "./tinymistClient";
import { InMemoryTypstPackageCache, TypstPackageService } from "./typstPackageService";
import type { TinymistBackendSession, TinymistTransport } from "./tinymistTransport";
import {
  DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
  TypstProjectState
} from "./typstProjectState";

export interface TinymistHostSessionOptions {
  label: string;
  transport: TinymistTransport;
  boot(): Promise<TinymistBackendSession>;
  closeGraceMs?: number;
  recoverOnSync?: boolean;
  queueNotificationsWhileRecovering?: boolean;
  packageService?: TypstPackageService;
}

/**
 * Owns the host-neutral lifecycle layered above a JSON-RPC transport.
 * Worker and process clients only supply connection-specific bootstrapping.
 */
export class TinymistHostSession {
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly projectState: TypstProjectState;
  private readonly capabilityRegistry: TinymistCapabilityRegistry;
  private readonly packageService: TypstPackageService;
  private readonly removePackageStatusHandler: () => void;
  private ready = false;
  private stopped = false;
  private restarting: Promise<void> | undefined;

  constructor(private readonly options: TinymistHostSessionOptions) {
    this.capabilityRegistry = new TinymistCapabilityRegistry((view) => {
      this.dispatch("tinymist/capabilitiesChanged", Object.freeze({
        generation: view.generation,
        capabilities: view.list()
      }));
    });
    this.packageService = options.packageService ?? new TypstPackageService({
      cache: new InMemoryTypstPackageCache()
    });
    this.removePackageStatusHandler = this.packageService.onStatus((status) => {
      this.dispatch("tinymist/packageStatus", status);
    });
    const serverRequests = new TinymistServerRequestDispatcher(
      this.capabilityRegistry,
      (params, _generation, signal) => this.packageService.resolve(params, signal)
    );
    options.transport.onServerRequest((message, generation, signal) => serverRequests.dispatch(message, generation, signal));
    options.transport.onNotification((method, params) => this.dispatch(method, params));
    options.transport.onFailure((error, generation) => this.handleRuntimeFailure(error, generation));
    this.projectState = new TypstProjectState({
      request: <T>(method: string, params: unknown, signal?: AbortSignal) =>
        options.transport.request<T>(method, params, signal),
      notify: (method, params) => options.transport.notify(method, params),
      emit: (method, params) => this.dispatch(method, params)
    }, { closeGraceMs: options.closeGraceMs ?? DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS });
  }

  async start(): Promise<void> {
    this.startRecovery(false);
    await this.ensureReady();
  }

  backendGeneration(): number {
    return this.options.transport.generation;
  }
  queuedProjectCount(): number {
    return this.projectState.queuedProjectCount();
  }


  capabilities(): TinymistCapabilityView {
    return this.capabilityRegistry;
  }

  on(method: string, handler: (params: unknown) => void): { dispose(): void } {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        const current = this.handlers.get(method);
        current?.delete(handler);
        if (current?.size === 0) this.handlers.delete(method);
      }
    };
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    await this.ensureReady();
    return this.projectState.request<T>(method, params, signal);
  }

  notify(method: string, params: unknown): void {
    if (this.ready && this.options.transport.started) {
      this.options.transport.notify(method, params);
      return;
    }
    if (!this.options.queueNotificationsWhileRecovering) return;
    void this.ensureReady()
      .then(() => this.options.transport.notify(method, params))
      .catch((error: unknown) => this.dispatch("tinymist/clientFailed", { message: String(error) }));
  }

  syncProject(update: TypstProjectUpdate): void {
    this.packageService.registerProject(update, this.projectState.backendGeneration());
    const transition = this.projectState.syncProject(update);
    if (!transition.accepted) this.packageService.retireProject(update.projectDigest);
    if (this.options.recoverOnSync && !this.ready) {
      void this.ensureReady().catch((error: unknown) => {
        this.dispatch("tinymist/clientFailed", { message: String(error) });
      });
    }
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    return this.projectState.projectForEntry(entryUri);
  }
  closeProject(sourceUri: string, entryUri: string): boolean {
    const project = this.projectState.projectForEntry(entryUri);
    const closed = this.projectState.closeProject(sourceUri, entryUri);
    if (closed && project) this.packageService.retireProject(project.projectDigest);
    return closed;
  }

  async restart(): Promise<void> {
    if (this.stopped) throw new Error(`${this.options.label} client stopped`);
    const generation = this.options.transport.generation;
    const error = new Error(`${this.options.label} restart requested`);
    this.ready = false;
    this.projectState.deactivateBackend(generation, error);
    this.packageService.setBackendGeneration(0);
    this.capabilityRegistry.clear(generation);
    this.options.transport.terminateNow(error);
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery(true);
    await this.ensureReady();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.capabilityRegistry.clear();
    this.packageService.setBackendGeneration(0);
    this.removePackageStatusHandler();
    this.projectState.dispose(new Error(`${this.options.label} stopped`));
    await this.options.transport.stop();
  }

  terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    const error = new Error(`${this.options.label} terminated`);
    this.capabilityRegistry.clear();
    this.packageService.setBackendGeneration(0);
    this.removePackageStatusHandler();
    this.projectState.dispose(error);
    this.options.transport.terminateNow(error);
  }

  private ensureReady(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error(`${this.options.label} client stopped`));
    if (this.ready) return Promise.resolve();
    this.startRecovery(true);
    return this.restarting ?? Promise.reject(new Error(`${this.options.label} recovery did not start`));
  }

  private handleRuntimeFailure(error: Error, generation: number): void {
    if (this.stopped || generation !== this.options.transport.generation) return;
    this.ready = false;
    this.capabilityRegistry.clear(generation);
    this.projectState.deactivateBackend(generation, error);
    this.packageService.setBackendGeneration(0);
    this.dispatch("tinymist/clientRestarting", { message: error.message });
    this.startRecovery(true);
  }

  private startRecovery(announceLifecycle: boolean): void {
    if (this.stopped || this.ready || this.restarting) return;
    const recovery = this.options.boot().then(async (session) => {
      this.capabilityRegistry.install(session.generation, session.initializeResult);
      this.packageService.setBackendGeneration(session.generation);
      await this.projectState.activateBackend(session.generation);
      if (this.stopped) {
        this.options.transport.terminateNow(new Error(`${this.options.label} stopped during recovery`));
        throw new Error(`${this.options.label} client stopped`);
      }
      this.ready = true;
      if (announceLifecycle) this.dispatch("tinymist/clientRestarted", undefined);
    });
    this.restarting = recovery;
    void recovery.catch((error: unknown) => {
      if (this.stopped) return;
      this.ready = false;
      this.capabilityRegistry.clear(this.options.transport.generation);
      this.options.transport.terminateNow(error instanceof Error ? error : new Error(String(error)));
      if (announceLifecycle) {
        this.dispatch("tinymist/clientFailed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }).finally(() => {
      if (this.restarting === recovery) this.restarting = undefined;
    });
  }

  private dispatch(method: string, params: unknown): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params);
  }
}
