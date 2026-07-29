import type { RenderKey } from "../../vscode/src/runtimeIdentity.ts";
import type { LanguageProjectionToken } from "./languageProjection.ts";
import type { PreviewSourceIdentity } from "./previewInteraction.ts";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";

export type PreviewWorkKind = "typing" | "manual-render";

export interface PreviewWorkRequest {
  readonly sourceUri: string;
  readonly sequence: number;
  readonly token: LanguageProjectionToken;
  readonly kind: PreviewWorkKind;
  readonly traceId: string;
}

export interface ExportWorkRequest {
  readonly sourceUri: string;
  readonly sequence: number;
  readonly renderKey: RenderKey;
  readonly traceId: string;
}

type Completion = ReturnType<typeof Promise.withResolvers<void>>;

interface PreviewJob {
  readonly request: PreviewWorkRequest;
  readonly run: (accepted: PreviewWorkRequest, signal: AbortSignal) => Promise<void>;
  readonly controller: AbortController;
  readonly completion: Completion;
  ready: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface PreviewLane {
  nextSequence: number;
  currentSequence: number;
  active?: PreviewJob;
  manual?: PreviewJob;
  typing?: PreviewJob;
}

interface ExportJob {
  readonly request: ExportWorkRequest;
  readonly run: (accepted: ExportWorkRequest, signal: AbortSignal) => Promise<void>;
  readonly controller: AbortController;
  readonly completion: Completion;
}

interface ExportLane {
  nextSequence: number;
  currentSequence: number;
  active?: ExportJob;
  queued?: ExportJob;
}

export class LatestPreviewRenderQueue implements RuntimeOwnedResource {
  readonly #preview = new Map<string, PreviewLane>();
  readonly #exports = new Map<string, ExportLane>();
  readonly #pending = new Set<Promise<void>>();
  #debounceMs: number;
  #disposed = false;

  constructor(debounceMs = 50) {
    if (!Number.isFinite(debounceMs)) throw new Error("Preview debounce must be finite");
    this.#debounceMs = Math.min(75, Math.max(32, Math.round(debounceMs)));
  }
  setDebounceMs(debounceMs: number): void {
    if (!Number.isFinite(debounceMs)) throw new Error("Preview debounce must be finite");
    this.#debounceMs = Math.min(75, Math.max(32, Math.round(debounceMs)));
  }

  enqueuePreview(
    request: Omit<PreviewWorkRequest, "sequence">,
    run: (accepted: PreviewWorkRequest, signal: AbortSignal) => Promise<void>,
  ): number {
    this.#assertOpen();
    const lane = this.#preview.get(request.sourceUri) ?? {
      nextSequence: 0,
      currentSequence: 0,
    };
    this.#preview.set(request.sourceUri, lane);
    const sequence = ++lane.nextSequence;
    const accepted = Object.freeze({ ...request, sequence });
    const job: PreviewJob = {
      request: accepted,
      run,
      controller: new AbortController(),
      completion: Promise.withResolvers<void>(),
      ready: request.kind === "manual-render",
    };
    this.#track(job.completion.promise);

    if (request.kind === "manual-render") {
      this.#cancelQueuedPreview(lane.manual);
      this.#cancelQueuedPreview(lane.typing);
      lane.manual = job;
      lane.typing = undefined;
      lane.currentSequence = sequence;
      lane.active?.controller.abort(new DOMException("Superseded by manual render", "AbortError"));
    } else {
      this.#cancelQueuedPreview(lane.typing);
      lane.typing = job;
      if (lane.active?.request.kind !== "manual-render") {
        lane.currentSequence = sequence;
        lane.active?.controller.abort(new DOMException("Superseded by newer typing", "AbortError"));
      }
      job.timer = setTimeout(() => {
        job.timer = undefined;
        job.ready = true;
        this.#pumpPreview(request.sourceUri, lane);
      }, this.#debounceMs);
    }
    this.#pumpPreview(request.sourceUri, lane);
    return sequence;
  }

  enqueueExport(
    request: Omit<ExportWorkRequest, "sequence">,
    run: (accepted: ExportWorkRequest, signal: AbortSignal) => Promise<void>,
  ): number {
    this.#assertOpen();
    const lane = this.#exports.get(request.sourceUri) ?? {
      nextSequence: 0,
      currentSequence: 0,
    };
    this.#exports.set(request.sourceUri, lane);
    const sequence = ++lane.nextSequence;
    const accepted = Object.freeze({ ...request, sequence });
    const job: ExportJob = {
      request: accepted,
      run,
      controller: new AbortController(),
      completion: Promise.withResolvers<void>(),
    };
    this.#track(job.completion.promise);
    this.#cancelQueuedExport(lane.queued);
    lane.queued = job;
    lane.currentSequence = sequence;
    lane.active?.controller.abort(new DOMException("Superseded by newer export", "AbortError"));
    this.#pumpExport(request.sourceUri, lane);
    return sequence;
  }

  waitForPreview(sourceUri: string, sequence: number): Promise<void> {
    const lane = this.#preview.get(sourceUri);
    const job = lane?.active?.request.sequence === sequence
      ? lane.active
      : lane?.manual?.request.sequence === sequence
        ? lane.manual
        : lane?.typing?.request.sequence === sequence
          ? lane.typing
          : undefined;
    return job?.completion.promise ?? Promise.resolve();
  }

  isCurrentPreview(sourceUri: string, sequence: number, identity: PreviewSourceIdentity): boolean {
    const lane = this.#preview.get(sourceUri);
    if (!lane || lane.currentSequence !== sequence || identity.sourceUri !== sourceUri) return false;
    const job = lane.active?.request.sequence === sequence
      ? lane.active
      : lane.manual?.request.sequence === sequence
        ? lane.manual
        : lane.typing?.request.sequence === sequence
          ? lane.typing
          : undefined;
    return Boolean(
      job
      && !job.controller.signal.aborted
      && job.request.token.entryUri === identity.entryUri
      && job.request.token.revision === identity.revision
      && job.request.token.sourceVersion === identity.sourceStaleToken.documentVersion
    );
  }


  waitForExport(sourceUri: string, sequence: number): Promise<void> {
    const lane = this.#exports.get(sourceUri);
    const job = lane?.active?.request.sequence === sequence ? lane.active : lane?.queued;
    return job?.request.sequence === sequence ? job.completion.promise : Promise.resolve();
  }

  isCurrentExport(sourceUri: string, sequence: number, renderKey: RenderKey): boolean {
    const lane = this.#exports.get(sourceUri);
    if (!lane || lane.currentSequence !== sequence) return false;
    const job = lane.active?.request.sequence === sequence ? lane.active : lane.queued;
    return Boolean(job && !job.controller.signal.aborted && job.request.renderKey === renderKey);
  }

  pending(): readonly Promise<void>[] {
    return [...this.#pending];
  }

  closeSource(sourceUri: string): void {
    const preview = this.#preview.get(sourceUri);
    if (preview) {
      preview.active?.controller.abort(new DOMException("Preview source closed", "AbortError"));
      this.#cancelQueuedPreview(preview.manual);
      this.#cancelQueuedPreview(preview.typing);
      this.#preview.delete(sourceUri);
    }
    const exports = this.#exports.get(sourceUri);
    if (exports) {
      exports.active?.controller.abort(new DOMException("Export source closed", "AbortError"));
      this.#cancelQueuedExport(exports.queued);
      this.#exports.delete(sourceUri);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const sourceUri of new Set([...this.#preview.keys(), ...this.#exports.keys()])) {
      this.closeSource(sourceUri);
    }
  }

  #pumpPreview(sourceUri: string, lane: PreviewLane): void {
    if (this.#disposed || lane.active) return;
    const job = lane.manual ?? (lane.typing?.ready ? lane.typing : undefined);
    if (!job) return;
    if (lane.manual === job) lane.manual = undefined;
    if (lane.typing === job) lane.typing = undefined;
    lane.active = job;
    lane.currentSequence = job.request.sequence;
    void job.run(job.request, job.controller.signal).then(
      () => job.completion.resolve(),
      (error: unknown) => job.completion.reject(error),
    ).finally(() => {
      if (lane.active === job) lane.active = undefined;
      if (!lane.active && !lane.manual && !lane.typing) this.#preview.delete(sourceUri);
      else this.#pumpPreview(sourceUri, lane);
    });
  }

  #pumpExport(sourceUri: string, lane: ExportLane): void {
    if (this.#disposed || lane.active || !lane.queued) return;
    const job = lane.queued;
    lane.queued = undefined;
    lane.active = job;
    void job.run(job.request, job.controller.signal).then(
      () => job.completion.resolve(),
      (error: unknown) => job.completion.reject(error),
    ).finally(() => {
      if (lane.active === job) lane.active = undefined;
      if (!lane.active && !lane.queued) this.#exports.delete(sourceUri);
      else this.#pumpExport(sourceUri, lane);
    });
  }

  #cancelQueuedPreview(job: PreviewJob | undefined): void {
    if (!job) return;
    clearTimeout(job.timer);
    job.controller.abort(new DOMException("Preview work superseded", "AbortError"));
    job.completion.resolve();
  }

  #cancelQueuedExport(job: ExportJob | undefined): void {
    if (!job) return;
    job.controller.abort(new DOMException("Export work superseded", "AbortError"));
    job.completion.resolve();
  }

  #track(promise: Promise<void>): void {
    this.#pending.add(promise);
    void promise.catch(() => undefined).finally(() => this.#pending.delete(promise));
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Preview render queue is disposed");
  }
}
