import type {
  ProjectionKey,
  SourceContentKey,
  SourceStaleToken,
  TypstProjectSnapshotKey
} from "./runtimeIdentity";

export interface CanonicalTypstProjectIdentity {
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
  readonly entryUri: string;
  readonly revision: number;
}

export interface TypstRequestIdentity extends CanonicalTypstProjectIdentity {
  readonly staleToken: SourceStaleToken;
  readonly backendGeneration: number;
}

export interface CurrentTypstRequestIdentity {
  readonly project: CanonicalTypstProjectIdentity | undefined;
  readonly staleToken: SourceStaleToken | undefined;
  readonly backendGeneration: number;
}

/** Owns host-local open-document incarnations. Closed incarnations are never restored. */
export class SourceStaleTokenRegistry {
  private readonly currentTokens = new Map<string, SourceStaleToken>();
  private nextIncarnation = 1;

  open(hostUri: string, documentVersion: number): SourceStaleToken {
    if (!Number.isInteger(documentVersion)) {
      throw new Error(`Invalid document version: ${documentVersion}`);
    }
    const token = Object.freeze({
      hostUri,
      documentIncarnation: `document-${this.nextIncarnation++}`,
      documentVersion
    });
    this.currentTokens.set(hostUri, token);
    return token;
  }

  advance(hostUri: string, documentVersion: number): SourceStaleToken | undefined {
    if (!Number.isInteger(documentVersion)) {
      throw new Error(`Invalid document version: ${documentVersion}`);
    }
    const current = this.currentTokens.get(hostUri);
    if (!current) return undefined;
    const token = Object.freeze({
      hostUri,
      documentIncarnation: current.documentIncarnation,
      documentVersion
    });
    this.currentTokens.set(hostUri, token);
    return token;
  }

  current(hostUri: string): SourceStaleToken | undefined {
    return this.currentTokens.get(hostUri);
  }

  close(hostUri: string): boolean {
    return this.currentTokens.delete(hostUri);
  }

  isCurrent(expected: SourceStaleToken): boolean {
    return staleTokensEqual(expected, this.currentTokens.get(expected.hostUri));
  }
}

export function captureTypstRequestIdentity(
  project: CanonicalTypstProjectIdentity,
  staleToken: SourceStaleToken,
  backendGeneration: number
): TypstRequestIdentity {
  if (!Number.isSafeInteger(project.revision) || project.revision < 0) {
    throw new Error(`Invalid projection revision: ${project.revision}`);
  }
  if (!Number.isSafeInteger(backendGeneration) || backendGeneration < 0) {
    throw new Error(`Invalid backend generation: ${backendGeneration}`);
  }
  return Object.freeze({
    sourceContent: project.sourceContent,
    projectDigest: project.projectDigest,
    projectionKey: project.projectionKey,
    entryUri: project.entryUri,
    revision: project.revision,
    staleToken,
    backendGeneration
  });
}

/**
 * Checks every publication guard as one snapshot. Call before conversion and
 * again immediately before publishing a response.
 */
export function typstRequestIdentityIsCurrent(
  expected: TypstRequestIdentity,
  current: CurrentTypstRequestIdentity
): boolean {
  const project = current.project;
  return current.backendGeneration === expected.backendGeneration
    && staleTokensEqual(expected.staleToken, current.staleToken)
    && project !== undefined
    && project.sourceContent === expected.sourceContent
    && project.projectDigest === expected.projectDigest
    && project.projectionKey === expected.projectionKey
    && project.entryUri === expected.entryUri
    && project.revision === expected.revision;
}

export function staleTokensEqual(
  expected: SourceStaleToken,
  actual: SourceStaleToken | undefined
): boolean {
  return actual !== undefined
    && actual.hostUri === expected.hostUri
    && actual.documentIncarnation === expected.documentIncarnation
    && actual.documentVersion === expected.documentVersion;
}

