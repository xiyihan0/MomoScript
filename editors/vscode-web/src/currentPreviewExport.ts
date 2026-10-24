import {
  ArtifactUnavailableError,
  ExportChoiceRequiredError,
  PreviewNotExportableError,
  exactExportFileName,
  validateExactExportOptions,
  validateExactExportPage,
  type ExactExportAvailability,
  type ExactExportRequest,
  type ExactExportResult,
  type ExactExportService,
  type LatestPreviewPort,
} from "./exactExport.ts";
import type { PreviewArtifactStore } from "./previewArtifact.ts";
import type { TypstPreviewController } from "./preview.ts";
import type { RenderKey } from "../../vscode/src/runtimeIdentity";

export type CurrentPreviewExportClient = Pick<ExactExportService, "availability" | "export">;

export interface CurrentPreviewExportDependencies {
  readonly artifacts: Pick<PreviewArtifactStore, "document" | "get" | "pin">;
  readonly preview: () => Pick<TypstPreviewController, "displayedRenderKey" | "createExport">;
  readonly latest: LatestPreviewPort;
  readonly immutable?: {
    has(renderKey: RenderKey): boolean;
    export(
      renderKey: RenderKey,
      format: ExactExportRequest["format"],
      pageIndex: number,
      signal?: AbortSignal,
    ): Promise<{ readonly blob: Blob; readonly extension: ExactExportRequest["format"] }>;
  };
}

/** Exports only accepted output artifacts, never the transient chat presentation. */
export function createCurrentPreviewExportClient(
  dependencies: CurrentPreviewExportDependencies,
): CurrentPreviewExportClient {
  const availability = (sourceUri: string): ExactExportAvailability => {
    const document = dependencies.artifacts.document(sourceUri);
    if (document.status === "failed") {
      return Object.freeze({ kind: "unavailable", reason: "FailedPreview" });
    }
    const displayed = document.displayedArtifact;
    if (!displayed) {
      return Object.freeze({
        kind: "unavailable",
        reason: ["queued", "materializing", "rendering", "stale"].includes(document.status)
          ? "PartialPreview" : "ArtifactUnavailable",
      });
    }
    const retained = dependencies.artifacts.get(displayed.renderKey);
    if (!retained) return Object.freeze({ kind: "unavailable", reason: "ArtifactUnavailable" });
    if (retained.renderPreset.kind !== "output") {
      return Object.freeze({ kind: "unavailable", reason: "PartialPreview" });
    }
    if (retained.visualSnapshot.kind === "renderer" && !dependencies.immutable?.has(retained.renderKey)) {
      return Object.freeze({ kind: "unavailable", reason: "ArtifactUnavailable" });
    }
    const stale = document.status !== "ready"
      || displayed.stale
      || dependencies.preview().displayedRenderKey !== displayed.renderKey
      || (document.requestedRenderKey !== undefined && document.requestedRenderKey !== displayed.renderKey);
    return stale
      ? Object.freeze({
          kind: "stale-choice",
          displayedRenderKey: displayed.renderKey,
          requestedRenderKey: document.requestedRenderKey,
          choices: Object.freeze(["export-displayed", "wait-for-latest"] as const),
        })
      : Object.freeze({ kind: "ready", displayedRenderKey: displayed.renderKey });
  };

  const exportDisplayed = async (
    request: ExactExportRequest,
    renderKey: RenderKey,
    staleDisplayedRevision: boolean,
  ): Promise<ExactExportResult> => {
    let releaseArtifact: () => void;
    try {
      releaseArtifact = dependencies.artifacts.pin(renderKey);
    } catch {
      throw new ArtifactUnavailableError(renderKey);
    }
    try {
      const artifact = dependencies.artifacts.get(renderKey);
      if (!artifact || artifact.sourceUri !== request.sourceUri || artifact.renderPreset.kind !== "output") {
        throw new ArtifactUnavailableError(renderKey);
      }
      validateExactExportPage(request.format, request.pageIndex, artifact.pages.length);
      const pageIndex = request.pageIndex ?? 0;
      const page = artifact.pages[pageIndex]!;
      const immutable = dependencies.immutable?.has(renderKey) === true;
      if (artifact.visualSnapshot.kind === "renderer" && !immutable) throw new ArtifactUnavailableError(renderKey);
      if (!immutable && dependencies.preview().displayedRenderKey !== renderKey) {
        throw new ArtifactUnavailableError(renderKey);
      }
      const exported = immutable
        ? await dependencies.immutable?.export(renderKey, request.format, pageIndex, request.signal)
        : await dependencies.preview().createExport(request.format, pageIndex, request.signal);
      if (!exported) throw new ArtifactUnavailableError(renderKey);
      request.signal?.throwIfAborted();
      // Only unretained legacy compiler worlds are mutable; pinned immutable
      // exports remain valid when a newer preview is accepted during generation.
      if (!immutable && dependencies.preview().displayedRenderKey !== renderKey) {
        throw new ArtifactUnavailableError(renderKey);
      }
      const bytes = new Uint8Array(await exported.blob.arrayBuffer());
      request.signal?.throwIfAborted();
      if (bytes.byteLength === 0) throw new Error(`Current preview ${request.format} exporter produced no bytes`);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      request.signal?.throwIfAborted();
      const contentKey = `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}` as const;
      const selectedPage = request.format === "pdf" ? undefined : pageIndex;
      return Object.freeze({
        blob: exported.blob,
        extension: exported.extension,
        metadata: Object.freeze({
          renderKey,
          format: request.format,
          sourceUri: request.sourceUri,
          staleDisplayedRevision,
          fileName: exactExportFileName(request.sourceUri, request.format, selectedPage, staleDisplayedRevision),
          pageCount: artifact.pages.length,
          contentKey,
          ...(selectedPage === undefined ? {} : { pageIndex: selectedPage, pageGeometry: page.geometry }),
        }),
      });
    } finally {
      releaseArtifact();
    }
  };

  const exportPreview = async (request: ExactExportRequest): Promise<ExactExportResult> => {
    request.signal?.throwIfAborted();
    validateExactExportOptions(request.format, request);
    const before = availability(request.sourceUri);
    if (before.kind === "unavailable") {
      if (before.reason === "ArtifactUnavailable") throw new ArtifactUnavailableError();
      throw new PreviewNotExportableError(before.reason);
    }
    if (before.kind === "stale-choice") {
      if (!request.staleChoice) {
        throw new ExportChoiceRequiredError(before.displayedRenderKey, before.requestedRenderKey);
      }
      if (request.staleChoice === "wait-for-latest") {
        const signal = request.signal ?? new AbortController().signal;
        const latest = await dependencies.latest.waitForLatest(request.sourceUri, before.displayedRenderKey, signal);
        signal.throwIfAborted();
        const settled = availability(request.sourceUri);
        if (settled.kind !== "ready" || settled.displayedRenderKey !== latest) {
          throw new ArtifactUnavailableError(latest);
        }
        return await exportDisplayed(request, latest, false);
      }
      return await exportDisplayed(request, before.displayedRenderKey, true);
    }
    return await exportDisplayed(request, before.displayedRenderKey, false);
  };

  return Object.freeze({ availability, export: exportPreview });
}
