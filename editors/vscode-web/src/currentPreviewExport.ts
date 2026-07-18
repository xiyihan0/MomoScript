import {
  ArtifactUnavailableError,
  PreviewNotExportableError,
  type ExactExportAvailability,
  type ExactExportRequest,
  type ExactExportResult,
  type ExactExportService,
} from "./exactExport.ts";
import type { PreviewArtifactStore } from "./previewArtifact.ts";
import type { TypstPreviewController } from "./preview.ts";

export type CurrentPreviewExportClient = Pick<ExactExportService, "availability" | "export">;

export interface CurrentPreviewExportDependencies {
  readonly artifacts: Pick<PreviewArtifactStore, "document" | "get">;
  readonly preview: () => Pick<TypstPreviewController, "displayedRenderKey" | "createExport">;
}

/**
 * Browser-host export backed by the already-rendered Typst preview.
 *
 * Unlike ExactExportService PDF export, this intentionally uses typst.ts' live
 * compiler. The before/after RenderKey checks reject an export if the visible
 * preview advances while typst.ts is producing bytes.
 */
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
          ? "PartialPreview"
          : "ArtifactUnavailable",
      });
    }
    const retained = dependencies.artifacts.get(displayed.renderKey);
    if (!retained) return Object.freeze({ kind: "unavailable", reason: "ArtifactUnavailable" });
    const previewRenderKey = dependencies.preview().displayedRenderKey;
    const stale = document.status !== "ready"
      || displayed.stale
      || previewRenderKey !== displayed.renderKey
      || (document.requestedRenderKey !== undefined && document.requestedRenderKey !== displayed.renderKey);
    if (stale) return Object.freeze({ kind: "unavailable", reason: "PartialPreview" });
    return Object.freeze({ kind: "ready", displayedRenderKey: displayed.renderKey });
  };

  const exportPreview = async (request: ExactExportRequest): Promise<ExactExportResult> => {
    if (request.staleChoice) throw new Error("Current preview export does not accept stale export choices");
    request.signal?.throwIfAborted();
    const before = availability(request.sourceUri);
    if (before.kind === "unavailable") {
      if (before.reason === "ArtifactUnavailable") throw new ArtifactUnavailableError();
      throw new PreviewNotExportableError(before.reason);
    }
    if (before.kind !== "ready") throw new ArtifactUnavailableError();

    const artifact = dependencies.artifacts.get(before.displayedRenderKey);
    if (!artifact || artifact.sourceUri !== request.sourceUri) {
      throw new ArtifactUnavailableError(before.displayedRenderKey);
    }
    const pageIndex = request.pageIndex ?? 0;
    const page = artifact.pages[pageIndex];
    if (!page) throw new ArtifactUnavailableError(before.displayedRenderKey);

    const exported = await dependencies.preview().createExport(request.format, request.signal);
    request.signal?.throwIfAborted();
    const after = availability(request.sourceUri);
    if (after.kind !== "ready" || after.displayedRenderKey !== before.displayedRenderKey) {
      throw new ArtifactUnavailableError(before.displayedRenderKey);
    }

    const bytes = new Uint8Array(await exported.blob.arrayBuffer());
    request.signal?.throwIfAborted();
    if (bytes.byteLength === 0) throw new Error(`Current preview ${request.format} exporter produced no bytes`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const contentKey = `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}` as const;
    return Object.freeze({
      blob: exported.blob,
      extension: exported.extension,
      metadata: Object.freeze({
        renderKey: before.displayedRenderKey,
        format: request.format,
        sourceUri: request.sourceUri,
        staleDisplayedRevision: false,
        contentKey,
        ...(request.format === "pdf" ? {} : { pageIndex, pageGeometry: page.geometry }),
      }),
    });
  };

  return Object.freeze({ availability, export: exportPreview });
}
