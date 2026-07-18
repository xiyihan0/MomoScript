import type { TypstProjectUpdate, TypstRenderProjectUpdate } from "../../vscode/src/tinymistClient";
import type { MaterializationPackSource } from "../../vscode/src/resourceMaterializer";
import type { LanguageProjectionToken } from "./languageProjection";
import { RuntimeOwner, disposeWithFallback, type RuntimeOwnedResource } from "./runtimeOwner.ts";
import { OriginStorageCoordinator } from "./originStorage.ts";
import { TypstPackageCacheStorageOwner } from "./packageCacheStorage.ts";
import { PreviewArtifactStore } from "./previewArtifact.ts";
import { ExactExportService, type ExactExportPorts } from "./exactExport.ts";

export type EditorRuntimeState = "starting" | "ready" | "quiescing" | "disposing" | "disposed";

export interface PreviewProjectRevision {
  readonly session: string;
  readonly sourceVersion: number;
  readonly revision: number;
}

/** Typed production Web state whose lifetime is exactly one editor runtime. */
export class WebEditorRuntimeStores implements RuntimeOwnedResource {
  readonly previewArtifacts: PreviewArtifactStore;
  readonly exactExport: ExactExportService | undefined;
  readonly previewProjects = new Map<string, TypstRenderProjectUpdate>();
  readonly packSourcesByNamespace = new Map<string, MaterializationPackSource>();
  readonly latestProjectBySource = new Map<string, PreviewProjectRevision>();
  readonly retiredProjectSessions = new Map<string, Set<string>>();
  readonly materializationControllers = new Map<string, AbortController>();
  readonly pendingMaterializations = new Set<Promise<void>>();
  readonly latestLanguageProjectionBySource = new Map<string, LanguageProjectionToken>();
  readonly typstRevisions = new Map<string, number>();
  readonly typstProjects = new Map<string, TypstProjectUpdate>();
  readonly acceptedPreviewLanguageProjects: Map<string, TypstProjectUpdate> | undefined;
  readonly retiredLanguageProjectionSessions = new Map<string, Set<string>>();
  readonly requestedRenderTokens = new WeakSet<LanguageProjectionToken>();
  readonly renderRequestIdBySource = new Map<string, number>();
  readonly persistenceByUri = new Map<string, Promise<void>>();

  constructor(captureAcceptedPreviewProjects = false, exactExportPorts?: ExactExportPorts) {
    this.previewArtifacts = new PreviewArtifactStore(32 * 1024 * 1024);
    this.exactExport = exactExportPorts
      ? new ExactExportService({ ...exactExportPorts, artifacts: this.previewArtifacts })
      : undefined;
    this.acceptedPreviewLanguageProjects = captureAcceptedPreviewProjects
      ? new Map<string, TypstProjectUpdate>()
      : undefined;
  }

  abortMaterializations(): void {
    for (const controller of this.materializationControllers.values()) controller.abort();
  }

  pendingWork(): Promise<void>[] {
    return [...this.pendingMaterializations, ...this.persistenceByUri.values()];
  }

  closeSource(sourceUri: string): void {
    this.materializationControllers.get(sourceUri)?.abort();
    this.materializationControllers.delete(sourceUri);
    this.latestProjectBySource.delete(sourceUri);
    this.retiredProjectSessions.delete(sourceUri);
    this.previewProjects.delete(sourceUri);
    this.acceptedPreviewLanguageProjects?.delete(sourceUri);
    this.latestLanguageProjectionBySource.delete(sourceUri);
    this.retiredLanguageProjectionSessions.delete(sourceUri);
    this.renderRequestIdBySource.delete(sourceUri);
    this.previewArtifacts.closeSource(sourceUri);
  }

  dispose(): void {
    this.abortMaterializations();
    this.exactExport?.dispose();
    this.previewArtifacts.dispose();
    this.previewProjects.clear();
    this.packSourcesByNamespace.clear();
    this.latestProjectBySource.clear();
    this.retiredProjectSessions.clear();
    this.materializationControllers.clear();
    this.pendingMaterializations.clear();
    this.latestLanguageProjectionBySource.clear();
    this.typstRevisions.clear();
    this.typstProjects.clear();
    this.acceptedPreviewLanguageProjects?.clear();
    this.retiredLanguageProjectionSessions.clear();
    this.renderRequestIdBySource.clear();
    this.persistenceByUri.clear();
  }
}

export interface EditorRuntimeControllerOptions {
  readonly disposeDeadlineMs?: number;
  readonly captureAcceptedPreviewProjects?: boolean;
  readonly exactExport?: ExactExportPorts;
}

/**
 * The single lifecycle owner for an editor host. Startup, quiesce, and disposal
 * are serialized here; host adapters only provide resources and termination
 * callbacks.
 */
export class EditorRuntimeController {
  readonly stores: WebEditorRuntimeStores;
  readonly #owner = new RuntimeOwner();
  readonly #disposeDeadlineMs: number;
  readonly #terminators: Array<() => void> = [];
  #originStorage: OriginStorageCoordinator | undefined;
  #packageCacheStorage: TypstPackageCacheStorageOwner | undefined;
  #originStoragePromise: Promise<TypstPackageCacheStorageOwner> | undefined;
  #state: EditorRuntimeState = "starting";
  #acceptingWork = true;
  #startPromise: Promise<void> | undefined;
  #quiescePromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #terminated = false;

  constructor(options: EditorRuntimeControllerOptions = {}) {
    this.#disposeDeadlineMs = checkedDeadline(options.disposeDeadlineMs ?? 750);
    this.stores = this.#owner.add(new WebEditorRuntimeStores(
      options.captureAcceptedPreviewProjects,
      options.exactExport,
    ));
  }

  get state(): EditorRuntimeState { return this.#state; }
  get acceptingWork(): boolean { return this.#acceptingWork && this.#state !== "disposing" && this.#state !== "disposed"; }
  get originStorage(): OriginStorageCoordinator | undefined { return this.#originStorage; }
  get packageCacheStorage(): TypstPackageCacheStorageOwner | undefined { return this.#packageCacheStorage; }

  start(initialize: (controller: EditorRuntimeController) => void | Promise<void>): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "starting") return Promise.reject(new Error(`Cannot start editor runtime while ${this.#state}`));
    const startup = (async () => {
      try {
        await initialize(this);
        if (this.#state !== "starting") throw new Error(`Startup completed while runtime was ${this.#state}`);
        this.#owner.ready();
        this.#state = "ready";
      } catch (error) {
        await this.dispose();
        throw error;
      }
    })();
    this.#startPromise = startup;
    return startup;
  }

  own<T extends RuntimeOwnedResource>(resource: T): T {
    if (this.#state !== "starting" && this.#state !== "ready") {
      throw new Error(`Cannot acquire runtime resource while ${this.#state}`);
    }
    return this.#owner.add(resource);
  }

  subscribe<T extends RuntimeOwnedResource>(subscription: T): T {
    return this.own(subscription);
  }

  initializeOriginStorage(
    open: () => Promise<OriginStorageCoordinator> = () => OriginStorageCoordinator.open(),
  ): Promise<TypstPackageCacheStorageOwner> {
    if (this.#originStoragePromise) return this.#originStoragePromise;
    const initialization = (async () => {
      const coordinator = await open();
      try {
        this.#originStorage = this.own(coordinator);
        this.#packageCacheStorage = this.own(new TypstPackageCacheStorageOwner(coordinator));
        return this.#packageCacheStorage;
      } catch (error) {
        coordinator.close();
        throw error;
      }
    })();
    this.#originStoragePromise = initialization;
    return initialization;
  }

  registerTermination(terminate: () => void): void {
    if (this.#state !== "starting") throw new Error(`Cannot register termination while ${this.#state}`);
    this.#terminators.push(terminate);
  }

  pauseNewWork(): () => void {
    if (!this.acceptingWork) return () => {};
    this.#acceptingWork = false;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (this.#state === "ready") this.#acceptingWork = true;
    };
  }

  async prepareForQuiesce(): Promise<void> {
    this.#acceptingWork = false;
    this.stores.abortMaterializations();
    await Promise.all(this.stores.pendingWork());
  }

  quiesce(): Promise<void> {
    if (this.#quiescePromise) return this.#quiescePromise;
    if (this.#state === "disposed" || this.#state === "disposing" || this.#state === "quiescing") {
      return Promise.resolve();
    }
    if (this.#state !== "ready") return Promise.reject(new Error("Cannot quiesce a runtime that has not started"));
    const quiescing = (async () => {
      try {
        await this.prepareForQuiesce();
        await this.#owner.quiesce();
        if (this.#state !== "disposing" && this.#state !== "disposed") this.#state = "quiescing";
      } catch (error) {
        if (this.#state === "ready") this.#acceptingWork = true;
        this.#quiescePromise = undefined;
        throw error;
      }
    })();
    this.#quiescePromise = quiescing;
    return quiescing;
  }

  dispose(deadlineMs = this.#disposeDeadlineMs, onFallback?: () => void): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const deadline = checkedDeadline(deadlineMs);
    this.#acceptingWork = false;
    this.#state = "disposing";
    const disposal = (async () => {
      const outcome = await disposeWithFallback(
        async () => {
          this.stores.abortMaterializations();
          await Promise.all(this.stores.pendingWork());
          await this.#owner.dispose(Number.POSITIVE_INFINITY);
        },
        () => this.terminate(),
        deadline,
      );
      if (outcome === "terminated") onFallback?.();
      this.#state = "disposed";
    })();
    this.#disposePromise = disposal;
    return disposal;
  }

  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.stores.dispose();
    for (const terminate of this.#terminators) {
      try { terminate(); } catch { /* terminate every owned Worker/process */ }
    }
  }

  terminateAndDispose(): void {
    this.terminate();
    void this.dispose().catch(() => {});
  }
}

function checkedDeadline(deadlineMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new RangeError("Editor runtime deadline must be a non-negative finite number");
  }
  return deadlineMs;
}
