import type { RenderKey } from "../../vscode/src/runtimeIdentity";
import {
  PREVIEW_RENDERER_METHOD,
  PREVIEW_RENDERER_PROTOCOL_VERSION,
  previewRendererResponseStatus,
  validatePreviewRendererCompileFailed,
  validatePreviewRendererReady,
  type PreviewProjectMount,
  type PreviewRendererPoint,
  type PreviewRendererCompileFailed,
  type PreviewRendererDiagnosticRecord,
  type PreviewRendererPosition,
  type PreviewRendererReady,
  type PreviewRendererResponse,
  type PreviewRendererSourceLocation,
  type SynchronizedPreviewProject,
} from "../../vscode/src/previewRendererProtocol.ts";
import type { TinymistHostBackend, TypstProjectUpdate } from "../../vscode/src/tinymistClient";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";

export interface PreviewRendererCandidate {
  readonly sourceUri: string;
  readonly sourceUris: ReadonlyMap<string, string>;
  readonly originalUris: ReadonlyMap<string, string>;
  readonly sessionId: string;
  readonly backendGeneration: number;
  readonly synchronized: SynchronizedPreviewProject;
  readonly ready: PreviewRendererReady;
  readonly bytes: Uint8Array;
}

interface RendererSessionState {
  readonly sourceUri: string;
  readonly sessionId: string;
  backendGeneration: number;
  committed: PreviewRendererReady | undefined;
  staged: PreviewRendererCandidate | undefined;
}

export interface PreviewRendererSessionOwnerOptions {
  readonly backend: TinymistHostBackend;
  readonly createSessionId?: () => string;
}
export class PreviewRendererCompilationError extends Error {
  readonly sourceUri: string;
  readonly sessionId: string;
  readonly backendGeneration: number;
  readonly synchronized: SynchronizedPreviewProject;
  readonly diagnostics: readonly PreviewRendererDiagnosticRecord[];

  constructor(options: {
    readonly sourceUri: string;
    readonly sessionId: string;
    readonly backendGeneration: number;
    readonly synchronized: SynchronizedPreviewProject;
    readonly diagnostics: readonly PreviewRendererDiagnosticRecord[];
  }) {
    super("Preview renderer could not compile the immutable project");
    this.name = "PreviewRendererCompilationError";
    this.sourceUri = options.sourceUri;
    this.sessionId = options.sessionId;
    this.backendGeneration = options.backendGeneration;
    this.synchronized = options.synchronized;
    this.diagnostics = options.diagnostics;
  }
}


/** Owns the producer's one-committed/one-staged generation protocol. */
export class PreviewRendererSessionOwner implements RuntimeOwnedResource {
  readonly #backend: TinymistHostBackend;
  readonly #sessions = new Map<string, RendererSessionState>();
  readonly #createSessionId: () => string;
  #disposed = false;

  constructor(options: PreviewRendererSessionOwnerOptions) {
    this.#backend = options.backend;
    this.#createSessionId = options.createSessionId ?? (() => crypto.randomUUID());
  }

  async render(
    project: TypstProjectUpdate,
    mount: PreviewProjectMount,
    snapshotToken: RenderKey,
    signal?: AbortSignal,
  ): Promise<PreviewRendererCandidate> {
    this.#assertActive();
    signal?.throwIfAborted();
    const backendGeneration = this.#backend.backendGeneration();
    if (!Number.isSafeInteger(backendGeneration) || backendGeneration <= 0) {
      throw new Error("Preview renderer backend is unavailable");
    }
    let state = this.#sessions.get(project.sourceUri);
    if (!state || state.backendGeneration !== backendGeneration) {
      state = {
        sourceUri: project.sourceUri,
        sessionId: this.#createSessionId(),
        backendGeneration,
        committed: undefined,
        staged: undefined,
      };
      this.#sessions.set(project.sourceUri, state);
    }
    if (state.staged) throw new Error("Preview renderer session already has a staged generation");

    let forceFull = state.committed === undefined;
    let retriedFull = forceFull;
    let preserveCommitted = false;
    try {
      while (true) {
        if (signal?.aborted) {
          preserveCommitted = true;
          signal.throwIfAborted();
        }
        const result = await this.#backend.previewRenderer(project, mount, {
          sessionId: state.sessionId,
          snapshotToken,
          ...(forceFull ? { forceFull: true } : { baseGeneration: state.committed?.generation }),
        }, signal);
        const response = result.response;
        const status = previewRendererResponseStatus(response);
        if (status === "resync") {
          if (retriedFull) throw new Error("Preview renderer rejected a forced full resynchronization");
          forceFull = true;
          retriedFull = true;
          continue;
        }
        const { sourceUris, originalUris } = previewRendererUriMaps(project, result.synchronized);
        if (status === "compileFailed") {
          const failed = validatePreviewRendererCompileFailed(response, {
            sessionId: state.sessionId,
            snapshotToken,
            sourceDigest: result.synchronized.sourceDigest,
          });
          preserveCommitted = true;
          throw new PreviewRendererCompilationError({
            sourceUri: project.sourceUri,
            sessionId: state.sessionId,
            backendGeneration,
            synchronized: result.synchronized,
            diagnostics: mapPreviewRendererDiagnosticUris(failed, originalUris),
          });
        }
        if (status !== "ready") {
          throw new Error(`Preview renderer returned unexpected '${status ?? "malformed"}' response to render`);
        }
        const ready = response as PreviewRendererReady;
        const bytes = await validatePreviewRendererReady(ready, {
          sessionId: state.sessionId,
          snapshotToken,
          sourceDigest: result.synchronized.sourceDigest,
        });
        const expectedBase = ready.frameKind === "new" ? 0 : state.committed?.generation;
        if (expectedBase === undefined || ready.baseGeneration !== expectedBase) {
          await this.#discardGeneration(state, ready);
          if (retriedFull) throw new Error("Preview renderer frame is not based on the committed generation");
          forceFull = true;
          retriedFull = true;
          continue;
        }
        const mappedReady = Object.freeze({
          ...ready,
          diagnostics: mapPreviewRendererDiagnosticUris(ready, originalUris),
        });
        const candidate = Object.freeze({
          sourceUri: project.sourceUri,
          sourceUris,
          originalUris,
          sessionId: state.sessionId,
          backendGeneration,
          synchronized: result.synchronized,
          ready: mappedReady,
          bytes,
        });
        state.staged = candidate;
        if (signal?.aborted) {
          await this.discard(candidate);
          preserveCommitted = true;
          signal.throwIfAborted();
        }
        return candidate;
      }
    } catch (error) {
      if (!preserveCommitted) await this.#closeState(state);
      throw error;
    }
  }

  async commit(candidate: PreviewRendererCandidate, signal?: AbortSignal): Promise<void> {
    const state = this.#requireStaged(candidate);
    const response = await this.#backend.transitionPreviewRenderer({
      action: "commit",
      sessionId: candidate.sessionId,
      snapshotToken: candidate.ready.snapshotToken,
      generation: candidate.ready.generation,
    }, signal);
    if (response.status !== "committed"
      || response.sessionId !== candidate.sessionId
      || response.snapshotToken !== candidate.ready.snapshotToken
      || response.generation !== candidate.ready.generation) {
      await this.#closeState(state);
      throw new Error("Preview renderer commit acknowledgement mismatch");
    }
    state.committed = candidate.ready;
    state.staged = undefined;
  }

  async discard(candidate: PreviewRendererCandidate, signal?: AbortSignal): Promise<void> {
    const state = this.#requireStaged(candidate);
    try {
      await this.#discardGeneration(state, candidate.ready, signal);
      state.staged = undefined;
    } catch (error) {
      await this.#closeState(state);
      throw error;
    }
  }

  async locatePoint(
    candidate: PreviewRendererCandidate,
    position: PreviewRendererPoint,
    signal?: AbortSignal,
  ): Promise<PreviewRendererSourceLocation | undefined> {
    this.#requireCommitted(candidate);
    const response = await this.#backend.request<PreviewRendererResponse>(PREVIEW_RENDERER_METHOD, {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "locatePoint",
      sessionId: candidate.sessionId,
      generation: candidate.ready.generation,
      position,
    }, signal);
    if (response.status === "unavailable") return undefined;
    if (response.status !== "locatedPoint"
      || response.sessionId !== candidate.sessionId
      || response.generation !== candidate.ready.generation) {
      throw new Error("Preview renderer point-location response identity mismatch");
    }
    if (!response.location) return undefined;
    const originalUri = candidate.originalUris.get(response.location.uri);
    if (!originalUri) {
      console.warn(
        `Preview renderer location URI is not in the synchronized mapping: ${response.location.uri}`,
        [...candidate.originalUris.keys()],
      );
    }
    return {
      uri: originalUri ?? response.location.uri,
      range: response.location.range,
    };
  }

  async locateSource(
    candidate: PreviewRendererCandidate,
    uri: string,
    position: PreviewRendererPosition,
    signal?: AbortSignal,
  ): Promise<readonly PreviewRendererPoint[]> {
    this.#requireCommitted(candidate);
    const response = await this.#backend.request<PreviewRendererResponse>(PREVIEW_RENDERER_METHOD, {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "locateSource",
      sessionId: candidate.sessionId,
      generation: candidate.ready.generation,
      uri: candidate.sourceUris.get(uri) ?? uri,
      position,
    }, signal);
    if (response.status === "unavailable") return [];
    if (response.status !== "locatedSource"
      || response.sessionId !== candidate.sessionId
      || response.generation !== candidate.ready.generation) {
      throw new Error("Preview renderer source-location response identity mismatch");
    }
    return response.locations;
  }

  async closeSource(sourceUri: string): Promise<void> {
    const state = this.#sessions.get(sourceUri);
    if (!state) return;
    await this.#closeState(state);
  }

  async closeAll(): Promise<void> {
    const states = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(states.map((state) => this.#backend.closePreviewRenderer(state.sessionId)));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.closeAll();
  }

  async #discardGeneration(
    state: RendererSessionState,
    ready: PreviewRendererReady,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#backend.transitionPreviewRenderer({
      action: "discard",
      sessionId: state.sessionId,
      snapshotToken: ready.snapshotToken,
      generation: ready.generation,
    }, signal);
    if (response.status !== "discarded"
      || response.sessionId !== state.sessionId
      || response.snapshotToken !== ready.snapshotToken
      || response.generation !== ready.generation) {
      throw new Error("Preview renderer discard acknowledgement mismatch");
    }
  }

  #requireStaged(candidate: PreviewRendererCandidate): RendererSessionState {
    this.#assertActive();
    const state = this.#sessions.get(candidate.sourceUri);
    if (!state || state.staged !== candidate || state.backendGeneration !== candidate.backendGeneration) {
      throw new Error("Preview renderer candidate is no longer staged");
    }
    return state;
  }

  #requireCommitted(candidate: PreviewRendererCandidate): RendererSessionState {
    this.#assertActive();
    const state = this.#sessions.get(candidate.sourceUri);
    if (!state
      || state.committed !== candidate.ready
      || state.backendGeneration !== candidate.backendGeneration) {
      throw new Error("Preview renderer candidate is not the committed generation");
    }
    return state;
  }

  async #closeState(state: RendererSessionState): Promise<void> {
    if (this.#sessions.get(state.sourceUri) === state) this.#sessions.delete(state.sourceUri);
    try {
      await this.#backend.closePreviewRenderer(state.sessionId);
    } catch {
      // A dead backend already discarded the session. The next request starts clean.
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Preview renderer session owner is disposed");
  }
}

function previewRendererUriMaps(
  project: TypstProjectUpdate,
  synchronized: SynchronizedPreviewProject,
): {
  readonly sourceUris: ReadonlyMap<string, string>;
  readonly originalUris: ReadonlyMap<string, string>;
} {
  const sourceUris = new Map<string, string>();
  const originalUris = new Map<string, string>();
  project.files.forEach((file, index) => {
    const synthetic = synchronized.project.files[index]?.uri;
    if (!synthetic) throw new Error("Preview renderer synthetic project file mapping is incomplete");
    sourceUris.set(file.uri, synthetic);
    originalUris.set(synthetic, file.uri);
    originalUris.set(rendererDiagnosticFileUri(synthetic), file.uri);
  });
  return { sourceUris, originalUris };
}

function rendererDiagnosticFileUri(syntheticUri: string): string {
  const parsed = new URL(syntheticUri);
  if (parsed.protocol !== "mmt-preview:" || parsed.search || parsed.hash) {
    throw new Error("Preview renderer synthetic file URI is invalid");
  }
  return new URL(`file://${parsed.pathname}`).toString();
}

function mapPreviewRendererDiagnosticUris(
  response: Pick<PreviewRendererCompileFailed | PreviewRendererReady, "diagnostics">,
  originalUris: ReadonlyMap<string, string>,
): readonly PreviewRendererDiagnosticRecord[] {
  return Object.freeze(response.diagnostics.map((record) => Object.freeze({
    uri: originalUris.get(record.uri) ?? record.uri,
    diagnostic: Object.freeze({
      ...record.diagnostic,
      ...(record.diagnostic.relatedInformation === undefined ? {} : {
        relatedInformation: Object.freeze(record.diagnostic.relatedInformation.map((related) => Object.freeze({
          ...related,
          location: Object.freeze({
            ...related.location,
            uri: originalUris.get(related.location.uri) ?? related.location.uri,
          }),
        }))),
      }),
    }),
  })));
}

