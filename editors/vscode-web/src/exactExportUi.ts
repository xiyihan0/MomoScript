import {
  ArtifactUnavailableError,
  ExportChoiceRequiredError,
  PreviewNotExportableError,
  type ExactExportAvailability,
  type ExactExportFormat,
  type ExactExportResult,
  type ExactExportService,
  type LatestPreviewPort,
  type StaleExportChoice,
} from "./exactExport.ts";
import type { RenderKey } from "../../vscode/src/runtimeIdentity.ts";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";

export type ExactExportUiAvailability =
  | "no-document"
  | "capability-unavailable"
  | "ready"
  | "stale"
  | "partial"
  | "failed"
  | "evicted";

export type ExactExportUiPhase = "idle" | "exporting" | "waiting" | "complete" | "cancelled" | "error";

export interface ExactExportUiState {
  readonly sourceUri?: string;
  readonly availability: ExactExportUiAvailability;
  readonly phase: ExactExportUiPhase;
  readonly message: string;
  readonly displayedRenderKey?: RenderKey;
  readonly requestedRenderKey?: RenderKey;
  readonly completedRenderKey?: RenderKey;
  readonly completedFormat?: ExactExportFormat;
  readonly canSelectFormat: boolean;
  readonly canExportDisplayed: boolean;
  readonly canWaitForLatest: boolean;
  readonly canCancel: boolean;
}

export interface ExactExportUiEvents {
  stateChanged?(state: ExactExportUiState): void;
  failed?(error: unknown): void;
}

type ExactExportClient = Pick<ExactExportService, "availability" | "export">;

/** Host-facing exact-export interaction state. It never selects a stale policy implicitly. */
export class ExactExportUiController implements RuntimeOwnedResource {
  readonly #client: ExactExportClient | undefined;
  readonly #events: ExactExportUiEvents;
  #sourceUri: string | undefined;
  #operation: AbortController | undefined;
  #state: ExactExportUiState;
  #disposed = false;

  constructor(client: ExactExportClient | undefined, events: ExactExportUiEvents = {}) {
    this.#client = client;
    this.#events = events;
    this.#state = stateFor(undefined, client ? undefined : "capability-unavailable");
  }

  get state(): ExactExportUiState { return this.#state; }

  bind(sourceUri: string | undefined): ExactExportUiState {
    this.#assertActive();
    if (sourceUri !== this.#sourceUri && this.#operation) {
      const operation = this.#operation;
      this.#operation = undefined;
      operation.abort(new DOMException("Exact export source changed", "AbortError"));
    }
    this.#sourceUri = sourceUri;
    return this.refresh();
  }

  refresh(): ExactExportUiState {
    this.#assertActive();
    if (this.#operation) return this.#state;
    const availability = this.#availability();
    return this.#publish(stateFor(this.#sourceUri, availability));
  }

  async export(format: ExactExportFormat, staleChoice?: StaleExportChoice): Promise<ExactExportResult | undefined> {
    this.#assertActive();
    if (this.#operation) return undefined;
    const sourceUri = this.#sourceUri;
    const availability = this.#availability();
    const base = stateFor(sourceUri, availability);
    if (!sourceUri || !this.#client || base.availability === "no-document" || base.availability === "capability-unavailable") {
      this.#publish(base);
      return undefined;
    }
    if (base.availability === "partial" || base.availability === "failed" || base.availability === "evicted") {
      this.#publish(base);
      return undefined;
    }
    if (base.availability === "stale" && !staleChoice) {
      this.#publish({ ...base, phase: "error", message: "Choose Export displayed revision or Wait for latest." });
      return undefined;
    }
    if (base.availability === "ready" && staleChoice) {
      this.#publish({ ...base, phase: "error", message: "The displayed revision is current; no stale export choice is required." });
      return undefined;
    }

    const operation = new AbortController();
    this.#operation = operation;
    const waiting = staleChoice === "wait-for-latest";
    this.#publish({
      ...base,
      phase: waiting ? "waiting" : "exporting",
      message: waiting ? "Waiting for latest exact artifact…" : "Exporting displayed exact revision…",
      canSelectFormat: false,
      canExportDisplayed: false,
      canWaitForLatest: false,
      canCancel: true,
    });
    try {
      const result = await this.#client.export({ sourceUri, format, staleChoice, signal: operation.signal });
      operation.signal.throwIfAborted();
      if (this.#operation !== operation || this.#sourceUri !== sourceUri) return undefined;
      const settled = stateFor(sourceUri, this.#client.availability(sourceUri));
      return this.#complete(settled, result, waiting);
    } catch (error) {
      if (this.#operation !== operation || this.#sourceUri !== sourceUri) return undefined;
      if (operation.signal.aborted || isAbortError(error)) {
        this.#publish({ ...stateFor(sourceUri, this.#availability()), phase: "cancelled", message: "Exact export cancelled." });
        return undefined;
      }
      this.#events.failed?.(error);
      this.#publish(errorState(sourceUri, this.#availability(), error));
      return undefined;
    } finally {
      if (this.#operation === operation) this.#operation = undefined;
    }
  }

  cancel(): boolean {
    if (!this.#operation) return false;
    const operation = this.#operation;
    operation.abort(new DOMException("Exact export cancelled", "AbortError"));
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
  }

  #availability(): ExactExportAvailability | "capability-unavailable" | undefined {
    if (!this.#sourceUri) return undefined;
    if (!this.#client) return "capability-unavailable";
    try {
      return this.#client.availability(this.#sourceUri);
    } catch (error) {
      this.#events.failed?.(error);
      return "capability-unavailable";
    }
  }

  #complete(base: ExactExportUiState, result: ExactExportResult, waited: boolean): ExactExportResult {
    this.#publish({
      ...base,
      phase: "complete",
      message: waited
        ? `Exported latest exact revision ${result.metadata.renderKey}.`
        : `Exported displayed exact revision ${result.metadata.renderKey}.`,
      completedRenderKey: result.metadata.renderKey,
      completedFormat: result.metadata.format,
    });
    return result;
  }

  #publish(state: ExactExportUiState): ExactExportUiState {
    this.#state = Object.freeze(state);
    this.#events.stateChanged?.(this.#state);
    return this.#state;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Exact export UI controller is disposed");
  }
}

interface LatestWaiter {
  readonly afterRenderKey: RenderKey;
  readonly resolve: (renderKey: RenderKey) => void;
  readonly reject: (reason: unknown) => void;
  readonly abort: () => void;
}

/** Resolves wait-latest requests only after the host publishes a different complete artifact. */
export class LatestExactArtifactWaiter implements LatestPreviewPort, RuntimeOwnedResource {
  readonly #latest = new Map<string, RenderKey>();
  readonly #waiters = new Map<string, Set<LatestWaiter>>();
  #disposed = false;

  waitForLatest(sourceUri: string, afterRenderKey: RenderKey, signal: AbortSignal): Promise<RenderKey> {
    if (this.#disposed) return Promise.reject(new Error("Latest artifact waiter is disposed"));
    signal.throwIfAborted();
    const current = this.#latest.get(sourceUri);
    if (current && current !== afterRenderKey) return Promise.resolve(current);
    return new Promise<RenderKey>((resolve, reject) => {
      const waiters = this.#waiters.get(sourceUri) ?? new Set<LatestWaiter>();
      const waiter: LatestWaiter = {
        afterRenderKey,
        resolve: (renderKey) => { cleanup(); resolve(renderKey); },
        reject: (reason) => { cleanup(); reject(reason); },
        abort: () => waiter.reject(signal.reason),
      };
      const cleanup = () => {
        signal.removeEventListener("abort", waiter.abort);
        waiters.delete(waiter);
        if (waiters.size === 0) this.#waiters.delete(sourceUri);
      };
      waiters.add(waiter);
      this.#waiters.set(sourceUri, waiters);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  publish(sourceUri: string, renderKey: RenderKey): void {
    if (this.#disposed) throw new Error("Latest artifact waiter is disposed");
    this.#latest.set(sourceUri, renderKey);
    for (const waiter of [...(this.#waiters.get(sourceUri) ?? [])]) {
      if (waiter.afterRenderKey !== renderKey) waiter.resolve(renderKey);
    }
  }

  closeSource(sourceUri: string): void {
    this.#latest.delete(sourceUri);
    const error = new DOMException("Preview source closed", "AbortError");
    for (const waiter of [...(this.#waiters.get(sourceUri) ?? [])]) waiter.reject(error);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new DOMException("Latest artifact waiter disposed", "AbortError");
    for (const waiters of this.#waiters.values()) {
      for (const waiter of [...waiters]) waiter.reject(error);
    }
    this.#waiters.clear();
    this.#latest.clear();
  }
}

function stateFor(
  sourceUri: string | undefined,
  availability: ExactExportAvailability | "capability-unavailable" | undefined,
): ExactExportUiState {
  if (!sourceUri) return baseState(undefined, "no-document", "Open a preview to export an exact artifact.");
  if (availability === "capability-unavailable") {
    return baseState(sourceUri, "capability-unavailable", "Exact export is unavailable on this host.");
  }
  if (!availability) return baseState(sourceUri, "evicted", "The displayed exact artifact is unavailable or was evicted.");
  if (availability.kind === "ready") {
    return actionState(sourceUri, "ready", "Exact displayed revision is ready to export.", availability.displayedRenderKey, undefined, true, false);
  }
  if (availability.kind === "stale-choice") {
    return actionState(
      sourceUri,
      "stale",
      "Displayed preview is stale. Export the displayed revision or wait for the latest exact artifact.",
      availability.displayedRenderKey,
      availability.requestedRenderKey,
      true,
      true,
    );
  }
  if (availability.reason === "PartialPreview") {
    return baseState(sourceUri, "partial", "Exact export is disabled while the preview is partial or rendering.");
  }
  if (availability.reason === "FailedPreview") {
    return baseState(sourceUri, "failed", "Exact export is disabled because the preview render failed.");
  }
  return baseState(sourceUri, "evicted", "The displayed exact artifact is unavailable or was evicted.");
}

function actionState(
  sourceUri: string,
  availability: "ready" | "stale",
  message: string,
  displayedRenderKey: RenderKey,
  requestedRenderKey: RenderKey | undefined,
  canExportDisplayed: boolean,
  canWaitForLatest: boolean,
): ExactExportUiState {
  return Object.freeze({
    sourceUri,
    availability,
    phase: "idle",
    message,
    displayedRenderKey,
    requestedRenderKey,
    canSelectFormat: true,
    canExportDisplayed,
    canWaitForLatest,
    canCancel: false,
  });
}

function baseState(
  sourceUri: string | undefined,
  availability: Exclude<ExactExportUiAvailability, "ready" | "stale">,
  message: string,
): ExactExportUiState {
  return Object.freeze({
    sourceUri,
    availability,
    phase: "idle",
    message,
    canSelectFormat: false,
    canExportDisplayed: false,
    canWaitForLatest: false,
    canCancel: false,
  });
}

function errorState(
  sourceUri: string,
  availability: ExactExportAvailability | "capability-unavailable" | undefined,
  error: unknown,
): ExactExportUiState {
  if (error instanceof ArtifactUnavailableError) {
    return { ...baseState(sourceUri, "evicted", "The displayed exact artifact is unavailable or was evicted."), phase: "error" };
  }
  if (error instanceof PreviewNotExportableError) {
    const kind = error.code === "PartialPreview" ? "partial" : "failed";
    return { ...baseState(sourceUri, kind, error.message), phase: "error" };
  }
  if (error instanceof ExportChoiceRequiredError) {
    const base = stateFor(sourceUri, availability);
    return { ...base, phase: "error", message: "Choose Export displayed revision or Wait for latest." };
  }
  const base = stateFor(sourceUri, availability);
  return { ...base, phase: "error", message: `Exact export failed: ${error instanceof Error ? error.message : String(error)}` };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}
