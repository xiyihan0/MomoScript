import type { SourceContentKey, SourceStaleToken } from "../../vscode/src/runtimeIdentity";
import type { TypstResourceRange } from "../../vscode/src/tinymistClient";

export type PreviewBuildPhase = "fetch" | "decode" | "package" | "compiler" | "layout" | "renderer";
export type PreviewBuildStatus = "idle" | "rendering" | "ready" | "failed" | "stale";

export interface PreviewRevision {
  sourceUri: string;
  sourceVersion: number;
  revision: number;
  requestId?: number;
}

export interface PreviewBuildIdentity extends PreviewRevision {
  sourceContent: SourceContentKey;
  sourceStaleToken: SourceStaleToken;
}

export interface PreviewBuildDiagnostic extends PreviewBuildIdentity {
  phase: PreviewBuildPhase;
  message: string;
  severity: "info" | "warning" | "error";
  range?: TypstResourceRange;
  dependency?: Readonly<{
    kind: string;
    id: number;
    packNamespace?: string;
  }>;
}

export function isCurrentPreviewUpdate(
  generation: number,
  currentGeneration: number,
  hasPendingUpdate: boolean
): boolean {
  return generation === currentGeneration && !hasPendingUpdate;
}

export interface PreviewProblemsPublisher {
  replace(identity: PreviewBuildIdentity, diagnostics: readonly PreviewBuildDiagnostic[]): void;
  clear(sourceUri: string): void;
}

export interface PreviewBuildSnapshot {
  readonly status: PreviewBuildStatus;
  readonly identity?: PreviewBuildIdentity;
  readonly diagnosticCount: number;
}

export class PreviewBuildState {
  readonly #currentBySource = new Map<string, PreviewBuildIdentity>();
  readonly #diagnosticsBySource = new Map<string, PreviewBuildDiagnostic[]>();
  readonly #statusBySource = new Map<string, Exclude<PreviewBuildStatus, "idle">>();
  readonly #listeners = new Set<(sourceUri: string, snapshot: PreviewBuildSnapshot) => void>();
  #publisher: PreviewProblemsPublisher | undefined;

  constructor(publisher?: PreviewProblemsPublisher) {
    this.#publisher = publisher;
  }

  bindPublisher(publisher: PreviewProblemsPublisher): void {
    this.#publisher = publisher;
    for (const [sourceUri, identity] of this.#currentBySource) {
      publisher.replace(identity, this.#diagnosticsBySource.get(sourceUri) ?? []);
    }
  }

  subscribe(
    listener: (sourceUri: string, snapshot: PreviewBuildSnapshot) => void
  ): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  activate(identity: PreviewBuildIdentity): void {
    if (identity.sourceStaleToken.hostUri !== identity.sourceUri
      || identity.sourceStaleToken.documentVersion !== identity.sourceVersion) {
      throw new Error("Preview diagnostic identity does not match its document stale token");
    }
    const retained = Object.freeze({
      ...identity,
      sourceStaleToken: Object.freeze({ ...identity.sourceStaleToken }),
    });
    this.#currentBySource.set(identity.sourceUri, retained);
    this.#diagnosticsBySource.set(identity.sourceUri, []);
    this.#statusBySource.set(identity.sourceUri, "rendering");
    this.#publisher?.replace(retained, []);
    this.#emit(identity.sourceUri);
  }

  clear(sourceUri: string): void {
    this.#currentBySource.delete(sourceUri);
    this.#diagnosticsBySource.delete(sourceUri);
    this.#statusBySource.delete(sourceUri);
    this.#publisher?.clear(sourceUri);
    this.#emit(sourceUri);
  }

  stale(sourceUri: string): boolean {
    const identity = this.#currentBySource.get(sourceUri);
    if (!identity) return false;
    this.#diagnosticsBySource.set(sourceUri, []);
    this.#statusBySource.set(sourceUri, "stale");
    this.#publisher?.clear(sourceUri);
    this.#emit(sourceUri);
    return true;
  }

  isCurrent(identity: PreviewBuildIdentity): boolean {
    if (this.#statusBySource.get(identity.sourceUri) === "stale") return false;
    const current = this.#currentBySource.get(identity.sourceUri);
    return current?.sourceVersion === identity.sourceVersion
      && current.revision === identity.revision
      && current.sourceContent === identity.sourceContent
      && current.sourceStaleToken.hostUri === identity.sourceStaleToken.hostUri
      && current.sourceStaleToken.documentIncarnation === identity.sourceStaleToken.documentIncarnation
      && current.sourceStaleToken.documentVersion === identity.sourceStaleToken.documentVersion;
  }

  fail(
    identity: PreviewBuildIdentity,
    phase: PreviewBuildPhase,
    message: string,
    attribution: Partial<Pick<PreviewBuildDiagnostic, "range" | "dependency" | "severity">> = {}
  ): boolean {
    if (!this.isCurrent(identity)) return false;
    const diagnostic = Object.freeze({
      ...identity,
      ...attribution,
      severity: attribution.severity ?? "error",
      phase,
      message,
    });
    const diagnostics = [...(this.#diagnosticsBySource.get(identity.sourceUri) ?? []), diagnostic];
    this.#diagnosticsBySource.set(identity.sourceUri, diagnostics);
    if (diagnostic.severity === "error") this.#statusBySource.set(identity.sourceUri, "failed");
    this.#publisher?.replace(identity, diagnostics);
    this.#emit(identity.sourceUri);
    return true;
  }

  complete(identity: PreviewBuildIdentity): boolean {
    if (!this.isCurrent(identity)) return false;
    const failed = (this.#diagnosticsBySource.get(identity.sourceUri) ?? [])
      .some((diagnostic) => diagnostic.severity === "error");
    this.#statusBySource.set(identity.sourceUri, failed ? "failed" : "ready");
    this.#emit(identity.sourceUri);
    return true;
  }

  snapshot(sourceUri: string): PreviewBuildSnapshot {
    const identity = this.#currentBySource.get(sourceUri);
    return Object.freeze({
      status: this.#statusBySource.get(sourceUri) ?? "idle",
      ...(identity ? { identity } : {}),
      diagnosticCount: this.#diagnosticsBySource.get(sourceUri)?.length ?? 0,
    });
  }

  diagnostics(sourceUri: string): readonly PreviewBuildDiagnostic[] {
    return this.#diagnosticsBySource.get(sourceUri) ?? [];
  }

  #emit(sourceUri: string): void {
    const snapshot = this.snapshot(sourceUri);
    for (const listener of this.#listeners) listener(sourceUri, snapshot);
  }
}
