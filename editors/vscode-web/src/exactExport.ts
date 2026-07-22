import type {
  MaterializationKey,
  RenderKey,
  RuntimeArtifactKey,
} from "../../vscode/src/runtimeIdentity.ts";
import type {
  PreviewArtifactStore,
  PreviewPage,
  PreviewPageGeometry,
} from "./previewArtifact.ts";
import type { RuntimeOwnedResource } from "./runtimeOwner.ts";

export type ExactExportFormat = "pdf" | "png" | "jpg" | "svg";
export type StaleExportChoice = "export-displayed" | "wait-for-latest";
export type RenderAdvanceCause = "source" | "dependency" | "materialization" | "render" | "backend" | "runtime";

export interface ExactExportRequest {
  readonly sourceUri: string;
  readonly format: ExactExportFormat;
  readonly staleChoice?: StaleExportChoice;
  readonly pageIndex?: number;
  readonly signal?: AbortSignal;
}

export interface ExactExportMetadata {
  readonly renderKey: RenderKey;
  readonly format: ExactExportFormat;
  readonly sourceUri: string;
  readonly staleDisplayedRevision: boolean;
  readonly contentKey: `sha256:${string}`;
  readonly pageIndex?: number;
  readonly pageGeometry?: PreviewPageGeometry;
  readonly materializationKey?: MaterializationKey;
  readonly runtimeArtifactKey?: RuntimeArtifactKey;
  readonly renderOptionsDigest?: string;
}

export interface ExactExportResult {
  readonly blob: Blob;
  readonly extension: ExactExportFormat;
  readonly metadata: ExactExportMetadata;
}

export interface ImmutableRenderFileInput {
  readonly path: string;
  readonly kind: "source" | "resource" | "package" | "template" | "generated";
  readonly contentDigest: string;
  readonly bytes: Uint8Array;
}

export interface ImmutableFontInput {
  readonly family: string;
  readonly contentDigest: string;
  readonly bytes: Uint8Array;
}

export interface ImmutablePackageRoot {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly root: string;
}

export interface ImmutableRuntimeInputs {
  readonly runtimeArtifactKey: RuntimeArtifactKey;
  readonly compilerVersion: string;
  readonly compilerWasmDigest: string;
  readonly compilerWasmBytes: Uint8Array;
  readonly templateBundleDigest: string;
  readonly fontSetDigest: string;
  readonly fonts: readonly ImmutableFontInput[];
}

export interface ImmutableRenderInputs {
  readonly renderKey: RenderKey;
  readonly materializationKey: MaterializationKey;
  readonly runtimeArtifactKey: RuntimeArtifactKey;
  readonly renderOptionsDigest: string;
  readonly entryPath: string;
  readonly files: readonly ImmutableRenderFileInput[];
  readonly packageRoots: readonly ImmutablePackageRoot[];
  readonly sysInputs?: Readonly<Record<string, string>>;
}

export interface RasterExportPort {
  encode(page: PreviewPage, format: "png" | "jpg", signal: AbortSignal): Promise<Uint8Array>;
}

/**
 * Production PDF implementations must create a fresh compiler/access model from
 * these bytes. A shared renderer or its current shadow filesystem is not a valid
 * implementation of this port.
 */
export interface ImmutablePdfCompilerPort {
  compile(
    render: ImmutableRenderInputs,
    runtime: ImmutableRuntimeInputs,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface LatestPreviewPort {
  waitForLatest(sourceUri: string, afterRenderKey: RenderKey, signal: AbortSignal): Promise<RenderKey>;
}

export interface ExactExportDependencies {
  readonly artifacts: Pick<PreviewArtifactStore, "document" | "get" | "pin">;
  readonly raster: RasterExportPort;
  readonly pdf: ImmutablePdfCompilerPort;
  readonly latest: LatestPreviewPort;
}

export type ExactExportPorts = Omit<ExactExportDependencies, "artifacts">;

export interface RenderAdvanceToken {
  readonly sourceUri: string;
  readonly sequence: number;
  readonly cause: RenderAdvanceCause;
  readonly afterRenderKey?: RenderKey;
}

export type ExactExportAvailability =
  | { readonly kind: "ready"; readonly displayedRenderKey: RenderKey }
  | {
      readonly kind: "stale-choice";
      readonly displayedRenderKey: RenderKey;
      readonly requestedRenderKey?: RenderKey;
      readonly choices: readonly ["export-displayed", "wait-for-latest"];
    }
  | { readonly kind: "unavailable"; readonly reason: "ArtifactUnavailable" | "PartialPreview" | "FailedPreview" };

interface RetainedRenderInputs {
  readonly render: ImmutableRenderInputs;
  readonly runtime: ImmutableRuntimeInputs;
}

export class ArtifactUnavailableError extends Error {
  readonly code = "ArtifactUnavailable" as const;

  constructor(renderKey?: RenderKey) {
    super(renderKey ? `ArtifactUnavailable: ${renderKey}` : "ArtifactUnavailable");
    this.name = "ArtifactUnavailableError";
  }
}

export class ExportChoiceRequiredError extends Error {
  readonly code = "ExportChoiceRequired" as const;
  readonly displayedRenderKey: RenderKey;
  readonly requestedRenderKey?: RenderKey;

  constructor(displayedRenderKey: RenderKey, requestedRenderKey?: RenderKey) {
    super("Displayed preview is stale; choose export-displayed or wait-for-latest");
    this.name = "ExportChoiceRequiredError";
    this.displayedRenderKey = displayedRenderKey;
    this.requestedRenderKey = requestedRenderKey;
  }
}

export class PreviewNotExportableError extends Error {
  readonly code: "PartialPreview" | "FailedPreview";

  constructor(code: "PartialPreview" | "FailedPreview") {
    super(code === "PartialPreview" ? "Cannot export a partial preview" : "Cannot export a failed preview");
    this.name = "PreviewNotExportableError";
    this.code = code;
  }
}

/** Runtime-owned exact-snapshot export state. */
export class ExactExportService implements RuntimeOwnedResource {
  readonly #dependencies: ExactExportDependencies;
  readonly #inputs = new Map<RenderKey, RetainedRenderInputs>();
  readonly #advanceBySource = new Map<string, RenderAdvanceToken>();
  readonly #lifecycle = new AbortController();
  #sequence = 0;
  #disposed = false;

  constructor(dependencies: ExactExportDependencies) {
    this.#dependencies = dependencies;
  }

  retainInputs(render: ImmutableRenderInputs, runtime: ImmutableRuntimeInputs): void {
    this.#assertActive();
    validateRenderInputs(render, runtime);
    const retained = cloneRetainedInputs(render, runtime);
    const existing = this.#inputs.get(render.renderKey);
    if (existing) {
      if (!retainedInputsEqual(existing, retained)) {
        throw new Error("RenderKey is already bound to different immutable renderer inputs");
      }
      return;
    }
    this.#inputs.set(render.renderKey, retained);
  }

  evictInputs(renderKey: RenderKey): boolean {
    this.#assertActive();
    return this.#inputs.delete(renderKey);
  }

  advance(sourceUri: string, cause: RenderAdvanceCause): RenderAdvanceToken {
    this.#assertActive();
    if (sourceUri.trim().length === 0) throw new Error("source URI must not be empty");
    const afterRenderKey = this.#dependencies.artifacts.document(sourceUri).displayedArtifact?.renderKey;
    const token = Object.freeze({ sourceUri, sequence: ++this.#sequence, cause, afterRenderKey });
    this.#advanceBySource.set(sourceUri, token);
    return token;
  }

  publishLatest(token: RenderAdvanceToken, renderKey: RenderKey): boolean {
    this.#assertActive();
    const current = this.#advanceBySource.get(token.sourceUri);
    if (!current || current.sequence !== token.sequence) return false;
    if (token.afterRenderKey === renderKey) return false;
    const document = this.#dependencies.artifacts.document(token.sourceUri);
    if (document.displayedArtifact?.renderKey !== renderKey || document.status !== "ready") return false;
    if (!this.#dependencies.artifacts.get(renderKey)) return false;
    this.#advanceBySource.delete(token.sourceUri);
    return true;
  }

  availability(sourceUri: string): ExactExportAvailability {
    this.#assertActive();
    const document = this.#dependencies.artifacts.document(sourceUri);
    if (document.status === "failed") return Object.freeze({ kind: "unavailable", reason: "FailedPreview" });
    const displayed = document.displayedArtifact;
    if (!displayed) {
      const reason = ["queued", "materializing", "rendering"].includes(document.status)
        ? "PartialPreview"
        : "ArtifactUnavailable";
      return Object.freeze({ kind: "unavailable", reason });
    }
    if (!this.#dependencies.artifacts.get(displayed.renderKey)) {
      return Object.freeze({ kind: "unavailable", reason: "ArtifactUnavailable" });
    }
    const stale = this.#advanceBySource.has(sourceUri)
      || displayed.stale
      || document.status === "stale"
      || (document.requestedRenderKey !== undefined && document.requestedRenderKey !== displayed.renderKey);
    if (stale) {
      return Object.freeze({
        kind: "stale-choice",
        displayedRenderKey: displayed.renderKey,
        requestedRenderKey: document.requestedRenderKey,
        choices: Object.freeze(["export-displayed", "wait-for-latest"] as const),
      });
    }
    if (["queued", "materializing", "rendering"].includes(document.status)) {
      return Object.freeze({ kind: "unavailable", reason: "PartialPreview" });
    }
    return Object.freeze({ kind: "ready", displayedRenderKey: displayed.renderKey });
  }

  async export(request: ExactExportRequest): Promise<ExactExportResult> {
    this.#assertActive();
    const signal = request.signal
      ? AbortSignal.any([request.signal, this.#lifecycle.signal])
      : this.#lifecycle.signal;
    signal.throwIfAborted();
    const availability = this.availability(request.sourceUri);
    if (availability.kind === "unavailable") {
      if (availability.reason === "ArtifactUnavailable") throw new ArtifactUnavailableError();
      throw new PreviewNotExportableError(availability.reason);
    }
    if (availability.kind === "stale-choice") {
      if (!request.staleChoice) {
        throw new ExportChoiceRequiredError(availability.displayedRenderKey, availability.requestedRenderKey);
      }
      if (request.staleChoice !== "export-displayed" && request.staleChoice !== "wait-for-latest") {
        throw new Error(`Unsupported stale export choice: ${String(request.staleChoice)}`);
      }
      if (request.staleChoice === "wait-for-latest") {
        const latest = await this.#dependencies.latest.waitForLatest(
          request.sourceUri,
          availability.displayedRenderKey,
          signal,
        );
        signal.throwIfAborted();
        const settled = this.availability(request.sourceUri);
        if (settled.kind !== "ready" || settled.displayedRenderKey !== latest) {
          throw new ArtifactUnavailableError(latest);
        }
        return await this.#exportDisplayed(request, settled.displayedRenderKey, false, signal);
      }
      return await this.#exportDisplayed(request, availability.displayedRenderKey, true, signal);
    }
    return await this.#exportDisplayed(request, availability.displayedRenderKey, false, signal);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle.abort(new DOMException("Exact export service disposed", "AbortError"));
    this.#inputs.clear();
    this.#advanceBySource.clear();
  }

  async #exportDisplayed(
    request: ExactExportRequest,
    renderKey: RenderKey,
    staleDisplayedRevision: boolean,
    signal: AbortSignal,
  ): Promise<ExactExportResult> {
    let releaseArtifact: (() => void) | undefined;
    try {
      try {
        releaseArtifact = this.#dependencies.artifacts.pin(renderKey);
      } catch {
        throw new ArtifactUnavailableError(renderKey);
      }
      const artifact = this.#dependencies.artifacts.get(renderKey);
      if (!artifact || artifact.renderKey !== renderKey || artifact.sourceUri !== request.sourceUri) {
        throw new ArtifactUnavailableError(renderKey);
      }
      signal.throwIfAborted();
      let bytes: Uint8Array;
      let page: PreviewPage | undefined;
      let retained: RetainedRenderInputs | undefined;
      if (request.format === "pdf") {
        const stored = this.#inputs.get(renderKey);
        if (!stored) throw new ArtifactUnavailableError(renderKey);
        retained = cloneRetainedInputs(stored.render, stored.runtime);
        bytes = await this.#dependencies.pdf.compile(retained.render, retained.runtime, signal);
      } else {
        const pageIndex = request.pageIndex ?? 0;
        page = artifact.pages[pageIndex];
        if (!page) throw new ArtifactUnavailableError(renderKey);
        bytes = request.format === "svg"
          ? new TextEncoder().encode(page.sanitizedSvg)
          : await this.#dependencies.raster.encode(page, request.format, signal);
      }
      signal.throwIfAborted();
      if (bytes.byteLength === 0) throw new Error(`Exact ${request.format} exporter produced no bytes`);
      const immutableBytes = bytes.slice();
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", immutableBytes));
      const contentKey = `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}` as const;
      const metadata = Object.freeze({
        renderKey,
        format: request.format,
        sourceUri: artifact.sourceUri,
        staleDisplayedRevision,
        contentKey,
        pageIndex: page?.pageIndex,
        pageGeometry: page?.geometry,
        materializationKey: retained?.render.materializationKey,
        runtimeArtifactKey: retained?.render.runtimeArtifactKey,
        renderOptionsDigest: retained?.render.renderOptionsDigest,
      });
      return Object.freeze({
        blob: new Blob([immutableBytes.buffer], { type: mimeType(request.format) }),
        extension: request.format,
        metadata,
      });
    } finally {
      releaseArtifact?.();
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Exact export service is disposed");
  }
}

function validateRenderInputs(render: ImmutableRenderInputs, runtime: ImmutableRuntimeInputs): void {
  const required = [
    render.renderKey,
    render.materializationKey,
    render.runtimeArtifactKey,
    render.renderOptionsDigest,
    render.entryPath,
    runtime.runtimeArtifactKey,
    runtime.compilerVersion,
    runtime.compilerWasmDigest,
    runtime.templateBundleDigest,
    runtime.fontSetDigest,
  ];
  if (required.some((value) => value.trim().length === 0)) throw new Error("Immutable renderer input identity must not be empty");
  if (render.runtimeArtifactKey !== runtime.runtimeArtifactKey) throw new Error("Render/runtime artifact keys do not match");
  if (runtime.compilerWasmBytes.byteLength === 0) throw new Error("Immutable compiler artifact bytes must not be empty");
  const filePaths = new Set<string>();
  for (const file of render.files) {
    validateVirtualPath(file.path);
    if (filePaths.has(file.path)) throw new Error(`Duplicate immutable render file: ${file.path}`);
    if (file.contentDigest.trim().length === 0) throw new Error(`Missing immutable file digest: ${file.path}`);
    filePaths.add(file.path);
  }
  validateVirtualPath(render.entryPath);
  if (!filePaths.has(render.entryPath)) throw new Error("Immutable render entry path is not retained");
  for (const font of runtime.fonts) {
    if (font.family.trim().length === 0 || font.contentDigest.trim().length === 0 || font.bytes.byteLength === 0) {
      throw new Error("Immutable font input is incomplete");
    }
  }
  for (const pkg of render.packageRoots) {
    if ([pkg.namespace, pkg.name, pkg.version].some((value) => value.trim().length === 0)) {
      throw new Error("Immutable package root identity is incomplete");
    }
    validateVirtualPath(pkg.root);
  }
}

function validateVirtualPath(path: string): void {
  if (!path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Non-canonical immutable renderer path: ${path}`);
  }
}

function cloneRetainedInputs(render: ImmutableRenderInputs, runtime: ImmutableRuntimeInputs): RetainedRenderInputs {
  const clonedRender = Object.freeze({
    ...render,
    files: Object.freeze(render.files.map((file) => Object.freeze({ ...file, bytes: file.bytes.slice() }))),
    packageRoots: Object.freeze(render.packageRoots.map((pkg) => Object.freeze({ ...pkg }))),
    sysInputs: render.sysInputs ? Object.freeze({ ...render.sysInputs }) : undefined,
  });
  const clonedRuntime = Object.freeze({
    ...runtime,
    compilerWasmBytes: runtime.compilerWasmBytes.slice(),
    fonts: Object.freeze(runtime.fonts.map((font) => Object.freeze({ ...font, bytes: font.bytes.slice() }))),
  });
  return Object.freeze({ render: clonedRender, runtime: clonedRuntime });
}

function retainedInputsEqual(left: RetainedRenderInputs, right: RetainedRenderInputs): boolean {
  if (
    left.render.materializationKey !== right.render.materializationKey
    || left.render.runtimeArtifactKey !== right.render.runtimeArtifactKey
    || left.render.renderOptionsDigest !== right.render.renderOptionsDigest
    || left.render.entryPath !== right.render.entryPath
    || JSON.stringify(left.render.packageRoots) !== JSON.stringify(right.render.packageRoots)
    || JSON.stringify(left.render.sysInputs) !== JSON.stringify(right.render.sysInputs)
    || left.runtime.compilerVersion !== right.runtime.compilerVersion
    || left.runtime.compilerWasmDigest !== right.runtime.compilerWasmDigest
    || left.runtime.templateBundleDigest !== right.runtime.templateBundleDigest
    || left.runtime.fontSetDigest !== right.runtime.fontSetDigest
    || left.render.files.length !== right.render.files.length
    || left.runtime.fonts.length !== right.runtime.fonts.length
    || !bytesEqual(left.runtime.compilerWasmBytes, right.runtime.compilerWasmBytes)
  ) return false;
  for (let index = 0; index < left.render.files.length; index += 1) {
    const a = left.render.files[index]!;
    const b = right.render.files[index]!;
    if (a.path !== b.path || a.kind !== b.kind || a.contentDigest !== b.contentDigest || !bytesEqual(a.bytes, b.bytes)) return false;
  }
  for (let index = 0; index < left.runtime.fonts.length; index += 1) {
    const a = left.runtime.fonts[index]!;
    const b = right.runtime.fonts[index]!;
    if (a.family !== b.family || a.contentDigest !== b.contentDigest || !bytesEqual(a.bytes, b.bytes)) return false;
  }
  return true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function mimeType(format: ExactExportFormat): string {
  const MIME_BY_FORMAT: Record<ExactExportFormat, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    svg: "image/svg+xml;charset=utf-8",
  };
  return MIME_BY_FORMAT[format];
}
