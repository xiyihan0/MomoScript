export type PreviewBuildPhase = "fetch" | "decode" | "render-layout";

export interface PreviewRevision {
  sourceUri: string;
  sourceVersion: number;
  revision: number;
}

export interface PreviewBuildDiagnostic extends PreviewRevision {
  phase: PreviewBuildPhase;
  message: string;
}
export function isCurrentPreviewUpdate(generation: number, currentGeneration: number, hasPendingUpdate: boolean): boolean {
  return generation === currentGeneration && !hasPendingUpdate;
}


export class PreviewBuildState {
  readonly #currentBySource = new Map<string, PreviewRevision>();
  readonly #diagnosticsBySource = new Map<string, PreviewBuildDiagnostic[]>();

  activate(revision: PreviewRevision): void {
    this.#currentBySource.set(revision.sourceUri, { ...revision });
    this.#diagnosticsBySource.set(revision.sourceUri, []);
  }

  clear(sourceUri: string): void {
    this.#currentBySource.delete(sourceUri);
    this.#diagnosticsBySource.delete(sourceUri);
  }

  isCurrent(revision: PreviewRevision): boolean {
    const current = this.#currentBySource.get(revision.sourceUri);
    return current?.sourceVersion === revision.sourceVersion && current.revision === revision.revision;
  }

  fail(revision: PreviewRevision, phase: PreviewBuildPhase, message: string): boolean {
    if (!this.isCurrent(revision)) return false;
    const diagnostic = { ...revision, phase, message };
    const diagnostics = this.#diagnosticsBySource.get(revision.sourceUri) ?? [];
    this.#diagnosticsBySource.set(revision.sourceUri, [...diagnostics, diagnostic]);
    return true;
  }

  diagnostics(sourceUri: string): readonly PreviewBuildDiagnostic[] {
    return this.#diagnosticsBySource.get(sourceUri) ?? [];
  }
}
