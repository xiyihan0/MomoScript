import type { Diagnostic } from "vscode-languageserver-protocol";

import {
  decodePreviewRendererDiagnostic,
  type PreviewRendererDiagnosticRecord,
} from "./previewRendererProtocol.ts";
import type {
  ProjectionKey,
  RenderKey,
  SourceContentKey,
  TypstProjectSnapshotKey,
} from "./runtimeIdentity.ts";
import {
  LineIndex,
  convertBackendWireRange,
  validatePositionBearingPayload,
  type PositionEncoding,
} from "./typstPosition.ts";
 

export interface PreviewRendererDiagnosticIdentity {
  readonly sourceUri: string;
  readonly sourceVersion: number;
  readonly revision: number;
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
  readonly entryUri: string;
  readonly snapshotToken: RenderKey;
  readonly backendGeneration: number;
  readonly backendEncoding: PositionEncoding;
}

export interface RoutedPreviewRendererDiagnostic {
  readonly uri: string;
  readonly diagnostic: Diagnostic;
}

export interface PreviewRendererDiagnosticClient {
  sendRequest<R>(method: string, params: unknown): Promise<R>;
}

/**
 * Routes authored entry diagnostics directly and maps generated MMT entries
 * through the current projection. Dependency records retain their actual URI.
 * Any stale or malformed batch is rejected as one unit.
 */
export async function mapPreviewRendererDiagnostics(
  client: PreviewRendererDiagnosticClient | undefined,
  identity: PreviewRendererDiagnosticIdentity,
  sourceText: string,
  records: readonly PreviewRendererDiagnosticRecord[],
  isCurrent: (identity: PreviewRendererDiagnosticIdentity) => boolean,
): Promise<readonly RoutedPreviewRendererDiagnostic[] | undefined> {
  if (!isCurrent(identity)) return undefined;
  const entry = records.filter((record) => record.uri === identity.entryUri);
  const routed: RoutedPreviewRendererDiagnostic[] = records
    .filter((record) => record.uri !== identity.entryUri)
    .map((record) => Object.freeze({
      uri: record.uri,
      diagnostic: record.diagnostic as Diagnostic,
    }));
  const authoredEntry = identity.entryUri === identity.sourceUri;
  if (entry.length !== 0) {
    if (!authoredEntry && !client) return undefined;
    const response = authoredEntry
      ? entry.map((record) => record.diagnostic)
      : await client!.sendRequest<unknown>("mmt/mapTypstDiagnostics", {
        sourceUri: identity.sourceUri,
        revision: identity.revision,
        entryUri: identity.entryUri,
        backendEncoding: identity.backendEncoding,
        sourceContent: identity.sourceContent,
        projectDigest: identity.projectDigest,
        projectionKey: identity.projectionKey,
        diagnostics: entry.map((record) => record.diagnostic),
      });
    if (response === null || !isCurrent(identity)) return undefined;
    if (!Array.isArray(response) || response.length !== entry.length) {
      throw new TypeError("mmt/mapTypstDiagnostics must preserve input length");
    }
    const sourceIndex = new LineIndex(sourceText);
    const mapped = response.flatMap((value): Diagnostic[] => {
      if (value === null) return [];
      let diagnostic = decodePreviewRendererDiagnostic(value) as Diagnostic;
      if (authoredEntry && identity.backendEncoding !== "utf-16") {
        diagnostic = {
          ...diagnostic,
          range: convertBackendWireRange(diagnostic.range, sourceIndex, identity.backendEncoding),
          ...(diagnostic.relatedInformation === undefined ? {} : {
            relatedInformation: diagnostic.relatedInformation.map((related) =>
              related.location.uri !== identity.sourceUri ? related : {
                ...related,
                location: {
                  ...related.location,
                  range: convertBackendWireRange(related.location.range, sourceIndex, identity.backendEncoding),
                },
              }),
          }),
        };
      }
      const localRelated = diagnostic.relatedInformation?.filter(
        (related) => related.location.uri === identity.sourceUri
      );
      validatePositionBearingPayload(
        "diagnostics",
        [{ ...diagnostic, relatedInformation: localRelated }],
        sourceIndex,
        "utf-16",
      );
      return [diagnostic];
    });
    routed.push(...mapped.map((diagnostic) => Object.freeze({
      uri: identity.sourceUri,
      diagnostic,
    })));
  }
  return isCurrent(identity) ? Object.freeze(routed) : undefined;
}
