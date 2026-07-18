export type RuntimeRecoveryState = "starting" | "ready" | "recovering" | "failed" | "stopped";

export interface RuntimeStatusSnapshot {
  readonly backendVersion: string;
  readonly artifactDigestPrefix: string;
  readonly positionEncoding: "utf-16";
  readonly recoveryState: RuntimeRecoveryState;
  readonly generation: number;
  readonly queuedProjectCount: number;
  readonly lastFailure?: string;
}

export interface RuntimeStatusIdentity {
  readonly backendVersion: string;
  readonly artifactDigest: string;
  readonly positionEncoding: "utf-16";
}

export class EditorRuntimeStatus {
  private current: RuntimeStatusSnapshot;
  private readonly listeners = new Set<(snapshot: RuntimeStatusSnapshot) => void>();

  constructor(identity: RuntimeStatusIdentity) {
    this.current = Object.freeze({
      backendVersion: identity.backendVersion,
      artifactDigestPrefix: identity.artifactDigest.slice(0, 12),
      positionEncoding: identity.positionEncoding,
      recoveryState: "starting",
      generation: 0,
      queuedProjectCount: 0,
    });
  }

  snapshot(): RuntimeStatusSnapshot {
    return this.current;
  }

  update(patch: Partial<Pick<RuntimeStatusSnapshot,
    "recoveryState" | "generation" | "queuedProjectCount" | "lastFailure"
  >>): RuntimeStatusSnapshot {
    const queuedProjectCount = patch.queuedProjectCount ?? this.current.queuedProjectCount;
    if (!Number.isSafeInteger(queuedProjectCount) || queuedProjectCount < 0) {
      throw new Error("Runtime queued-project count must be a non-negative safe integer");
    }
    const generation = patch.generation ?? this.current.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("Runtime generation must be a non-negative safe integer");
    }
    this.current = Object.freeze({
      ...this.current,
      ...patch,
      generation,
      queuedProjectCount,
      ...(patch.recoveryState === "ready" ? { lastFailure: undefined } : {}),
    });
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  onDidChange(listener: (snapshot: RuntimeStatusSnapshot) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  tooltip(buildLabel: string, previewRevision: number | undefined, diagnosticCount: number): string {
    const state = this.current;
    return [
      buildLabel,
      `Tinymist ${state.backendVersion} (${state.artifactDigestPrefix})`,
      `position ${state.positionEncoding}`,
      `recovery ${state.recoveryState}; generation ${state.generation}; queued projects ${state.queuedProjectCount}`,
      `preview revision ${previewRevision ?? "none"}; diagnostics ${diagnosticCount}`,
      ...(state.lastFailure ? [`last runtime failure: ${state.lastFailure}`] : []),
      "Click to focus Problems.",
    ].join("\n");
  }
}
