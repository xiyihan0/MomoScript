import type { RenderKey } from "../../vscode/src/runtimeIdentity";
import {
  PREVIEW_RENDERER_METHOD,
  PREVIEW_RENDERER_PROTOCOL_VERSION,
  validatePreviewRendererReady,
  type PreviewProjectMount,
  type PreviewRendererPoint,
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
        if (response.status === "resync") {
          if (retriedFull) throw new Error("Preview renderer rejected a forced full resynchronization");
          forceFull = true;
          retriedFull = true;
          continue;
        }
        if (response.status !== "ready") {
          throw new Error(`Preview renderer returned unexpected '${response.status}' response to render`);
        }
        const bytes = await validatePreviewRendererReady(response, {
          sessionId: state.sessionId,
          snapshotToken,
          sourceDigest: result.synchronized.sourceDigest,
        });
        const expectedBase = response.frameKind === "new" ? 0 : state.committed?.generation;
        if (expectedBase === undefined || response.baseGeneration !== expectedBase) {
          await this.#discardGeneration(state, response);
          if (retriedFull) throw new Error("Preview renderer frame is not based on the committed generation");
          forceFull = true;
          retriedFull = true;
          continue;
        }
        const sourceUris = new Map<string, string>();
        const originalUris = new Map<string, string>();
        project.files.forEach((file, index) => {
          const synthetic = result.synchronized.project.files[index]?.uri;
          if (!synthetic) throw new Error("Preview renderer synthetic project file mapping is incomplete");
          sourceUris.set(file.uri, synthetic);
          originalUris.set(synthetic, file.uri);
        });
        const candidate = Object.freeze({
          sourceUri: project.sourceUri,
          sourceUris,
          originalUris,
          sessionId: state.sessionId,
          backendGeneration,
          synchronized: result.synchronized,
          ready: response,
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
    return {
      uri: candidate.originalUris.get(response.location.uri) ?? response.location.uri,
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

