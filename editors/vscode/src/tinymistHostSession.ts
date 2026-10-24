import {
  TinymistCapabilityRegistry,
  TinymistServerRequestDispatcher,
  type TinymistCapabilityView
} from "./tinymistCapabilities";
import type { TypstProjectUpdate } from "./tinymistClient";
import {
  PREVIEW_RENDERER_METHOD,
  PREVIEW_RENDERER_PROTOCOL_VERSION,
  preparePreviewProject,
  type PreviewProjectMount,
  type PreviewRendererRenderOptions,
  type PreviewRendererRenderResult,
  type PreviewRendererResponse,
  type PreviewRendererTransition,
  type SynchronizedPreviewProject
} from "./previewRendererProtocol";
import { InMemoryTypstPackageCache, TypstPackageService } from "./typstPackageService";
import type { TinymistBackendSession, TinymistTransport } from "./tinymistTransport";
import {
  canonicalTypstUri,
  DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
  projectionSessionKey,
  TypstProjectInvariantError,
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
  private readonly previewCompilerBases = new Map<string, { sourceUri: string; renderEntryUri: string }>();
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly projectState: TypstProjectState;
  private readonly capabilityRegistry: TinymistCapabilityRegistry;
  private readonly packageService: TypstPackageService;
  private readonly removePackageStatusHandler: () => void;
  private readonly previewRendererFileDigests = new Set<string>();
  private previewRendererCacheGeneration = 0;
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
    else this.releasePreviewCompilerBase(update.sourceUri);
    if (this.options.recoverOnSync && !this.ready) {
      void this.ensureReady().catch((error: unknown) => {
        this.dispatch("tinymist/clientFailed", { message: String(error) });
      });
    }
  }

  async syncPreviewProject(
    update: TypstProjectUpdate,
    mount: PreviewProjectMount,
    signal?: AbortSignal
  ): Promise<SynchronizedPreviewProject> {
    return (await this.synchronizePreviewCompilerBase(update, mount, signal)).synchronized;
  }

  private async synchronizePreviewCompilerBase(
    update: TypstProjectUpdate,
    mount: PreviewProjectMount,
    signal?: AbortSignal
  ): Promise<{ synchronized: SynchronizedPreviewProject; baseEntryUri: string }> {
    signal?.throwIfAborted();
    await this.ensureReady();
    signal?.throwIfAborted();
    const synchronized = await preparePreviewProject(update, mount);
    signal?.throwIfAborted();
    const language = this.projectState.projectForSource(update.sourceUri);
    if (language) {
      if (!matchingAuthoredSnapshot(language, update)) {
        throw new TypstProjectInvariantError(
          "PreviewSnapshotMismatch",
          "Preview render snapshot does not match the accepted language project"
        );
      }
      // The immutable renderer owns the preset-specific bytes. Its compiler base
      // remains the exact accepted language snapshot, never a second projection
      // competing for the language revision or overwriting its virtual files.
      this.releasePreviewCompilerBase(update.sourceUri);
      return { synchronized, baseEntryUri: language.entryUri };
    }

    // Render-only clients have no language world. Own their compiler base in the
    // existing synthetic preview namespace so a later language sync is independent.
    const compiler: TypstProjectUpdate = {
      ...synchronized.project,
      entryUri: previewCompilerUri(synchronized.project.entryUri),
      files: synchronized.project.files.map((file) => ({ ...file, uri: previewCompilerUri(file.uri) }))
    };
    const existing = this.projectState.projectForSource(compiler.sourceUri);
    if (existing && matchingAuthoredSnapshot(existing, compiler)) {
      this.previewCompilerBases.set(update.sourceUri, {
        sourceUri: compiler.sourceUri,
        renderEntryUri: canonicalTypstUri(update.entryUri)
      });
      return { synchronized, baseEntryUri: existing.entryUri };
    }
    this.packageService.registerProject(update, this.projectState.backendGeneration());
    const transition = this.projectState.syncProject(compiler);
    if (!transition.accepted) {
      this.packageService.retireProject(update.projectDigest);
      throw transition.error ?? new Error("Preview compiler base project was rejected");
    }
    this.previewCompilerBases.set(update.sourceUri, {
      sourceUri: compiler.sourceUri,
      renderEntryUri: canonicalTypstUri(update.entryUri)
    });
    return { synchronized, baseEntryUri: compiler.entryUri };
  }

  async previewRenderer(
    update: TypstProjectUpdate,
    mount: PreviewProjectMount,
    options: PreviewRendererRenderOptions,
    signal?: AbortSignal
  ): Promise<PreviewRendererRenderResult> {
    const { synchronized, baseEntryUri } = await this.synchronizePreviewCompilerBase(update, mount, signal);
    // Renderer sessions are per source, but Tinymist's base compiler focus is shared.
    // A retained projection must be re-primed after another document takes that focus.
    await this.projectState.ensureProjectReady(baseEntryUri, signal);
    signal?.throwIfAborted();
    await this.registerPreviewRendererProject(synchronized, baseEntryUri, options.sessionId, signal);
    signal?.throwIfAborted();
    const response = await this.request<PreviewRendererResponse>(PREVIEW_RENDERER_METHOD, {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "render",
      sessionId: options.sessionId,
      snapshotToken: options.snapshotToken,
      sourceDigest: synchronized.sourceDigest,
      ...(options.baseGeneration === undefined ? {} : { baseGeneration: options.baseGeneration }),
      ...(options.forceFull === undefined ? {} : { forceFull: options.forceFull })
    }, signal);
    return Object.freeze({ synchronized, response });
  }

  private async registerPreviewRendererProject(
    synchronized: SynchronizedPreviewProject,
    baseEntryUri: string,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const generation = this.backendGeneration();
    if (this.previewRendererCacheGeneration !== generation) {
      this.previewRendererCacheGeneration = generation;
      this.previewRendererFileDigests.clear();
    }
    const files = new Map(synchronized.mounts.map((mount) => [mount.contentDigest, {
      contentDigest: mount.contentDigest,
      dataBase64: mount.dataBase64,
    }] as const));
    for (const font of synchronized.fonts) {
      const existing = files.get(font.contentDigest);
      if (existing && existing.dataBase64 !== font.dataBase64) {
        throw new Error(`Preview renderer digest '${font.contentDigest}' has conflicting immutable bytes`);
      }
      files.set(font.contentDigest, font);
    }
    const mounts = synchronized.mounts.map((mount) => ({
      path: mount.path,
      contentDigest: mount.contentDigest,
    }));
    const request = async (contentDigests: readonly string[]): Promise<PreviewRendererResponse> => {
      signal?.throwIfAborted();
      return this.request(PREVIEW_RENDERER_METHOD, {
        protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
        action: "register",
        sessionId,
        entryUri: baseEntryUri,
        renderEntryUri: synchronized.project.entryUri,
        sourceDigest: synchronized.sourceDigest,
        fontDigests: synchronized.fonts.map((font) => font.contentDigest),
        mounts,
        files: contentDigests.map((digest) => {
          const file = files.get(digest);
          if (!file) throw new Error(`Preview renderer requested unknown file digest '${digest}'`);
          return file;
        }),
      }, signal);
    };
    const initialDigests = [...files.keys()].filter((digest) => !this.previewRendererFileDigests.has(digest));
    let response = await request(initialDigests);
    if (response.status === "missingFiles") {
      if (response.sessionId !== sessionId || response.sourceDigest !== synchronized.sourceDigest) {
        throw new Error("Preview renderer missing-file response identity mismatch");
      }
      const missing = [...new Set(response.contentDigests)];
      if (missing.length !== response.contentDigests.length || missing.some((digest) => !files.has(digest))) {
        throw new Error("Preview renderer requested an invalid missing-file set");
      }
      for (const digest of missing) this.previewRendererFileDigests.delete(digest);
      response = await request(missing);
    }
    if (response.status !== "registered"
      || response.sessionId !== sessionId
      || response.sourceDigest !== synchronized.sourceDigest) {
      throw new Error(`Preview renderer did not register the immutable snapshot: ${JSON.stringify(response)}`);
    }
    for (const digest of files.keys()) this.previewRendererFileDigests.add(digest);
  }

  transitionPreviewRenderer(
    transition: PreviewRendererTransition,
    signal?: AbortSignal
  ): Promise<PreviewRendererResponse> {
    return this.request(PREVIEW_RENDERER_METHOD, {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      ...transition
    }, signal);
  }

  closePreviewRenderer(sessionId: string, signal?: AbortSignal): Promise<PreviewRendererResponse> {
    return this.request(PREVIEW_RENDERER_METHOD, {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "close",
      sessionId
    }, signal);
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    return this.projectState.projectForEntry(entryUri);
  }
  closeProject(sourceUri: string, entryUri: string): boolean {
    const project = this.projectState.projectForEntry(entryUri);
    const closed = this.projectState.closeProject(sourceUri, entryUri);
    if (closed && project) {
      this.packageService.retireProject(project.projectDigest);
      this.releasePreviewCompilerBase(sourceUri);
      return true;
    }
    const preview = this.previewCompilerBases.get(sourceUri);
    return preview?.renderEntryUri === canonicalTypstUri(entryUri)
      ? this.releasePreviewCompilerBase(sourceUri)
      : false;
  }

  private releasePreviewCompilerBase(sourceUri: string): boolean {
    const preview = this.previewCompilerBases.get(sourceUri);
    if (!preview) return false;
    this.previewCompilerBases.delete(sourceUri);
    const project = this.projectState.projectForSource(preview.sourceUri);
    if (!project || !this.projectState.closeProject(project.sourceUri, project.entryUri)) return false;
    if (this.projectState.projectForSource(sourceUri)?.projectDigest !== project.projectDigest) {
      this.packageService.retireProject(project.projectDigest);
    }
    return true;
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
    this.previewCompilerBases.clear();
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
    this.previewCompilerBases.clear();
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

function matchingAuthoredSnapshot(base: TypstProjectUpdate, render: TypstProjectUpdate): boolean {
  return base.sourceUri === render.sourceUri
    && base.sourceVersion === render.sourceVersion
    && base.revision === render.revision
    && base.sourceContent === render.sourceContent
    && projectionSessionKey(base.entryUri) === projectionSessionKey(render.entryUri);
}

function previewCompilerUri(uri: string): string {
  return `untitled:${uri.slice("mmt-preview:".length)}`;
}
