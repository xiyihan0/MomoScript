import type { RenderKey } from "../../vscode/src/runtimeIdentity";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";

export type PreviewTraceOutcome = "published" | "coalesced" | "aborted" | "stale-discarded" | "failed";

export type PreviewTraceStage =
  | "rustParse"
  | "rustSemantic"
  | "rustResolve"
  | "rustEmit"
  | "rustTypstCheck"
  | "rustIndexDigest"
  | "projectDelivery"
  | "workspaceMirror"
  | "materialization"
  | "shadowUpdate"
  | "typstCompile"
  | "svgParseSanitize"
  | "domUpdate"
  | "locationMeasure"
  | "viewportRender"
  | "iframeTransfer"
  | "rendererDecode"
  | "rendererApply"
  | "visualReady";

export type PreviewTraceCounter =
  | "nodesReused"
  | "nodesRebuilt"
  | "chunksReused"
  | "chunksRebuilt"
  | "resourcesReused"
  | "resourcesRebuilt"
  | "projectBytes"
  | "fileUpserts"
  | "fileDeletes"
  | "shadowMapped"
  | "shadowUnmapped"
  | "shadowSkipped"
  | "staleDiscards"
  | "queueDepth"
  | "rendererRequestBytes"
  | "rendererResponseBytes"
  | "rendererFrameNew"
  | "rendererFrameDiffV1"
  | "rendererConsumerResyncs"
  | "rendererGeneration"
  | "rendererBaseGeneration"
  | "patchedNodes"
  | "reusedNodes"
  | "removedNodes"
  | "pageBuffers"
  | "sourceQueries"
  | "fullOracleFallbacks";

export interface PreviewTraceSample {
  readonly traceId: string;
  readonly sourceUri: string;
  readonly sourceVersion: number;
  readonly revision: number;
  readonly requestSequence: number;
  readonly renderKey?: RenderKey;
  readonly stagesMs: Readonly<Partial<Record<PreviewTraceStage, number>>>;
  readonly counters: Readonly<Record<PreviewTraceCounter, number>>;
  readonly outcome: PreviewTraceOutcome;
}

export const PREVIEW_TRACE_CAPACITY = 512;
const EMPTY_COUNTERS = Object.freeze({
  nodesReused: 0,
  nodesRebuilt: 0,
  chunksReused: 0,
  chunksRebuilt: 0,
  resourcesReused: 0,
  resourcesRebuilt: 0,
  projectBytes: 0,
  fileUpserts: 0,
  fileDeletes: 0,
  shadowMapped: 0,
  shadowUnmapped: 0,
  shadowSkipped: 0,
  staleDiscards: 0,
  queueDepth: 0,
  rendererRequestBytes: 0,
  rendererResponseBytes: 0,
  rendererFrameNew: 0,
  rendererFrameDiffV1: 0,
  rendererConsumerResyncs: 0,
  rendererGeneration: 0,
  rendererBaseGeneration: 0,
  patchedNodes: 0,
  reusedNodes: 0,
  removedNodes: 0,
  pageBuffers: 0,
  sourceQueries: 0,
  fullOracleFallbacks: 0,
}) satisfies Readonly<Record<PreviewTraceCounter, number>>;

export type PreviewTraceSeed = Pick<
  PreviewTraceSample,
  "traceId" | "sourceUri" | "sourceVersion" | "revision" | "requestSequence"
>;

export class PreviewTraceSession {
  readonly #store: PreviewPerformanceTraceStore;
  readonly #seed: PreviewTraceSeed;
  readonly #stagesMs: Partial<Record<PreviewTraceStage, number>> = {};
  readonly #counters: Record<PreviewTraceCounter, number> = { ...EMPTY_COUNTERS };
  readonly #startedAt = performance.now();
  #renderKey: RenderKey | undefined;
  #finished = false;

  constructor(store: PreviewPerformanceTraceStore, seed: PreviewTraceSeed) {
    this.#store = store;
    this.#seed = seed;
  }

  get traceId(): string { return this.#seed.traceId; }
  get finished(): boolean { return this.#finished; }
  get elapsedMs(): number { return performance.now() - this.#startedAt; }

  stage(stage: PreviewTraceStage, durationMs: number): void {
    if (this.#finished || !Number.isFinite(durationMs) || durationMs < 0) return;
    this.#stagesMs[stage] = durationMs;
  }

  increment(counter: PreviewTraceCounter, amount = 1): void {
    if (this.#finished || !Number.isFinite(amount)) return;
    this.#counters[counter] += amount;
  }

  setCounter(counter: PreviewTraceCounter, value: number): void {
    if (this.#finished || !Number.isFinite(value) || value < 0) return;
    this.#counters[counter] = value;
  }

  renderKey(renderKey: RenderKey): void {
    if (!this.#finished) this.#renderKey = renderKey;
  }

  finish(outcome: PreviewTraceOutcome): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#store.record(Object.freeze({
      ...this.#seed,
      ...(this.#renderKey === undefined ? {} : { renderKey: this.#renderKey }),
      stagesMs: Object.freeze({ ...this.#stagesMs }),
      counters: Object.freeze({ ...this.#counters }),
      outcome,
    }));
  }
}


/** Runtime-owned bounded evidence store. Samples never participate in preview identity. */
export class PreviewPerformanceTraceStore implements RuntimeOwnedResource {
  readonly #samples: Array<PreviewTraceSample | undefined>;
  #enabled: boolean;
  #length = 0;
  #next = 0;

  constructor(enabled = false, capacity = PREVIEW_TRACE_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("Preview trace capacity must be a positive safe integer");
    }
    this.#enabled = enabled;
    this.#samples = new Array<PreviewTraceSample | undefined>(capacity);
  }

  get enabled(): boolean { return this.#enabled; }
  get size(): number { return this.#length; }
  get capacity(): number { return this.#samples.length; }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  record(sample: PreviewTraceSample): void {
    if (!this.#enabled) return;
    this.#samples[this.#next] = sample;
    this.#next = (this.#next + 1) % this.#samples.length;
    this.#length = Math.min(this.#length + 1, this.#samples.length);
  }

  begin(seed: PreviewTraceSeed): PreviewTraceSession {
    return new PreviewTraceSession(this, seed);
  }

  snapshot(): readonly PreviewTraceSample[] {
    const result = new Array<PreviewTraceSample>(this.#length);
    const start = (this.#next - this.#length + this.#samples.length) % this.#samples.length;
    for (let index = 0; index < this.#length; index += 1) {
      result[index] = this.#samples[(start + index) % this.#samples.length]!;
    }
    return result;
  }

  reset(): void {
    this.#samples.fill(undefined);
    this.#length = 0;
    this.#next = 0;
  }

  dispose(): void {
    this.#enabled = false;
    this.reset();
  }
}
