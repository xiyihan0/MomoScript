import { $typst, MemoryAccessModel } from "@myriaddreamin/typst.ts";
import { loadFonts } from "@myriaddreamin/typst.ts/dist/esm/options.init.mjs";
import { TypstSnippet } from "@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs";
import { kObject } from "@myriaddreamin/typst.ts/dist/esm/internal.types.mjs";
import monoUrl from "../../vscode/vendor/fonts/DejaVuSansMono.ttf?url";
import jetBrainsMonoUrl from "../../vscode/vendor/fonts/JetBrainsMono-Regular.ttf?url";
import mathUrl from "../../vscode/vendor/fonts/NewCMMath-Regular.otf?url";

import type { TypstProjectUpdate } from "../../vscode/src/tinymistClient";
import type { PreviewRendererFileRecord } from "../../vscode/src/previewRendererProtocol.ts";
import type { TypstPackageGeneration } from "../../vscode/src/typstPackageService";
import { TypstPreviewPackageRegistry } from "../../vscode/src/typstPreviewPackageRegistry";
import { isCurrentPreviewUpdate, type PreviewRevision } from "./previewDiagnostics";
import {
  createPreviewArtifact,
  inlinePreviewImageAssets,
  normalizePreviewPage,
  previewImageAssetHref,
  type LocationProviderKey,
  type PreviewArtifact,
  type PreviewImmutableLocationMap,
  type PreviewImageAsset,
} from "./previewArtifact.ts";
import type {
  PreviewMeasurementSpan,
  PreviewPagePoint,
  PreviewNavigationPoint,
  PreviewRenderArtifactLocation as RenderArtifactLocation,
} from "./previewWebviewProtocol.ts";
import {
  type PreviewLocationResolver,
  type PreviewProviderPointRequest,
  type PreviewProviderSelectionRequest,
  type PreviewSourceIdentity,
  type PreviewBackendLocation,
} from "./previewInteraction.ts";
import { normalizeTextSelectionNode } from "./previewSelectableText.ts";
import { canonicalBytesDigest, type RenderKey } from "../../vscode/src/runtimeIdentity";
import {
  MAIN_FONT_BOLD_ARTIFACT,
  MAIN_FONT_REGULAR_ARTIFACT,
  TYPST_COMPILER_WASM_ARTIFACT,
} from "./runtimeArtifacts";
import { fetchDecodedRuntimeArtifact } from "./runtimeArtifactDecoder";


const bundledFontsLoader = loadFonts([
  mathUrl,
  monoUrl,
  jetBrainsMonoUrl,
], { assets: false });
type MainFontBytes = readonly [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
let mainFontBytesPromise: Promise<MainFontBytes> | undefined;
let decodedMainFontsLoaderPromise: Promise<ReturnType<typeof loadFonts>> | undefined;
const decodedMainFontsLoader: ReturnType<typeof loadFonts> = async (...args) => {
  const loader = await (decodedMainFontsLoaderPromise ??= mainFontBytes().then((fonts) =>
    loadFonts([...fonts], { assets: false })
  ));
  await loader(...args);
};

function mainFontBytes(): Promise<MainFontBytes> {
  return mainFontBytesPromise ??= Promise.all([
    fetchDecodedRuntimeArtifact({
      artifact: MAIN_FONT_REGULAR_ARTIFACT,
      label: "MainFont Regular",
      timeoutMs: 30_000,
    }),
    fetchDecodedRuntimeArtifact({
      artifact: MAIN_FONT_BOLD_ARTIFACT,
      label: "MainFont Bold",
      timeoutMs: 30_000,
    }),
  ]);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const textCallPrefix = Uint8Array.of(0x23, 0x74, 0x65, 0x78, 0x74, 0x28, 0x22); // #text("
let rendererFontsPromise: Promise<readonly PreviewRendererFileRecord[]> | undefined;
let initialized = false;
let compilerModule: WebAssembly.Module | undefined;
const previewAccessModel = new MemoryAccessModel();
const previewPackageRegistry = new TypstPreviewPackageRegistry(previewAccessModel);
export const RENDER_ARTIFACT_LOCATION_METHOD = "mmt/renderArtifactLocations";
export const RENDER_ARTIFACT_COORDINATE_VERSION = "typst-svg-debug-spans-v1";

export function previewRendererFontFiles(): Promise<readonly PreviewRendererFileRecord[]> {
  rendererFontsPromise ??= loadPreviewRendererFontFiles();
  return rendererFontsPromise;
}

async function loadPreviewRendererFontFiles(): Promise<readonly PreviewRendererFileRecord[]> {
  const [[regular, bold], bundled] = await Promise.all([
    mainFontBytes(),
    Promise.all([
      fetchPreviewRendererFont(mathUrl),
      fetchPreviewRendererFont(monoUrl),
      fetchPreviewRendererFont(jetBrainsMonoUrl),
    ]),
  ]);
  return Object.freeze([
    ...bundled,
    await previewRendererFontRecord(regular),
    await previewRendererFontRecord(bold),
  ]);
}

async function fetchPreviewRendererFont(url: string): Promise<PreviewRendererFileRecord> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Preview renderer font download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Preview renderer font download was empty");
  return previewRendererFontRecord(bytes);
}

async function previewRendererFontRecord(bytes: Uint8Array): Promise<PreviewRendererFileRecord> {
  return Object.freeze({
    contentDigest: await canonicalBytesDigest("mmt-project-file-v1", [bytes]),
    dataBase64: encodeRendererBytes(bytes),
  });
}

function encodeRendererBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return btoa(binary);
}

interface ResolvedTypstDebugSpan {
  readonly span: string;
  readonly start: number;
  readonly end: number;
}



interface DebugTypstCompileWorld {
  resolve_main_spans(spanIdsJson: string): string;
  render_svg_with_debug_spans(): string;
}

export function renderArtifactLocationProviderKey(renderKey: RenderKey, revision: number): LocationProviderKey {
  return Object.freeze({
    kind: "provider",
    backendOrTraceArtifactDigest: renderKey,
    backendGeneration: revision,
    method: RENDER_ARTIFACT_LOCATION_METHOD,
    coordinateVersion: RENDER_ARTIFACT_COORDINATE_VERSION,
  });
}

export function installPreviewPackageGenerations(generations: readonly TypstPackageGeneration[]): void {
  for (const generation of generations) previewPackageRegistry.install(generation);
}

export function evictPreviewPackageGeneration(packageGeneration: string): void {
  previewPackageRegistry.evict(packageGeneration);
}

export interface TypstPreviewTiming {
  readonly traceId: string;
  readonly shadowUpdateMs: number;
  readonly typstCompileMs: number;
  readonly svgParseSanitizeMs: number;
  readonly domUpdateMs: number;
  readonly locationMeasureMs: number;
  readonly shadowMapped: number;
  readonly shadowUnmapped: number;
  readonly shadowSkipped: number;
}

export interface TypstPreviewEvents {
  status(message: string, error: boolean, revision?: PreviewRevision): void;
  rendered(
    publication: TypstPreviewPublication,
    revision: PreviewRevision,
    shadowCount: number,
  ): void | PreviewPublicationTiming | Promise<void | PreviewPublicationTiming>;
  timing?(timing: TypstPreviewTiming, revision: PreviewRevision): void;
}

export interface TypstPreviewBinding {
  readonly renderKey: RenderKey;
  readonly requestId?: number;
  readonly traceId?: string;
  readonly locationProviderKey: LocationProviderKey;
  readonly locationMap?: PreviewImmutableLocationMap;
  readonly identity: PreviewSourceIdentity;
  readonly resolver?: PreviewLocationResolver;
  readonly signal?: AbortSignal;
}

interface PendingPreviewRender {
  readonly project: TypstProjectUpdate;
  readonly binding?: TypstPreviewBinding;
}
export type TypstExportFormat = "pdf" | "png" | "jpg" | "svg";
export interface ImmutableTypstExportSnapshot {
  readonly project: TypstProjectUpdate;
  readonly packageGenerations: readonly TypstPackageGeneration[];
}


export interface TypstExport {
  blob: Blob;
  extension: TypstExportFormat;
}
interface DebugSvgRender {
  readonly svg: string;
  readonly spans: readonly ResolvedTypstDebugSpan[];
}


export interface TypstPreviewPublication {
  readonly artifact: PreviewArtifact;
  readonly identity: PreviewSourceIdentity;
  readonly compactSvg: string;
  readonly imageAssets: readonly PreviewImageAsset[];
  readonly pageSize: { readonly width: number; readonly height: number };
  readonly entryUri: string;
  readonly entryText: string;
  readonly spans: readonly PreviewMeasurementSpan[];
  readonly requestSequence?: number;
  readonly traceId?: string;
  readonly signal?: AbortSignal;
}

export interface PreviewPublicationTiming {
  readonly domUpdateMs: number;
  readonly locationMeasureMs: number;
}

async function renderSvgWithDebugSpans(mainFilePath: string): Promise<DebugSvgRender> {
  const compiler = await $typst.getCompiler();
  return compiler.runWithWorld({ mainFilePath }, async (world) => {
    const rawWorld = (world as unknown as { [kObject]: DebugTypstCompileWorld })[kObject];
    const svg = rawWorld.render_svg_with_debug_spans();
    const parsedSvg = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (parsedSvg.querySelector("parsererror")) {
      throw new Error("Typst debug SVG is malformed");
    }
    const spanIds = [...new Set(
      [...parsedSvg.querySelectorAll<SVGElement>("[data-span]")]
        .map((element) => element.getAttribute("data-span"))
        .filter((span): span is string => Boolean(span)),
    )];
    const parsed = JSON.parse(rawWorld.resolve_main_spans(JSON.stringify(spanIds))) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Typst debug-span resolver returned a malformed result");
    const spans = Object.freeze(parsed.flatMap((candidate): ResolvedTypstDebugSpan[] => {
      if (
        !candidate
        || typeof candidate !== "object"
        || typeof candidate.span !== "string"
        || !Number.isSafeInteger(candidate.start)
        || !Number.isSafeInteger(candidate.end)
        || candidate.start < 0
        || candidate.end < candidate.start
      ) return [];
      return [Object.freeze({
        span: candidate.span,
        start: candidate.start,
        end: candidate.end,
      })];
    }));
    return Object.freeze({ svg, spans });
  });
}


export interface TypstPreviewControllerOptions {
  readonly reuseCompilerState?: boolean;
}

export class TypstPreviewController {
  private readonly events: TypstPreviewEvents | undefined;
  private pending: PendingPreviewRender | undefined;
  private rendering = false;
  private typstOperationTail: Promise<void> = Promise.resolve();
  private mappedPaths = new Set<string>();
  private mappedFiles = new Map<string, string>();
  private readonly reuseCompilerState: boolean;
  private generation = 0;
  private closeRequested = false;
  private latestEntryPath: string | undefined;
  private latestCompilerRenderKey: RenderKey | undefined;
  private latestSvg: string | undefined;
  private latestImageAssets: readonly PreviewImageAsset[] = [];
  private pageSize: { width: number; height: number } | undefined;
  private artifact: PreviewArtifact | undefined;

  constructor(
    events?: TypstPreviewEvents,
    options: TypstPreviewControllerOptions = {},
  ) {
    this.events = events;
    this.reuseCompilerState = options.reuseCompilerState ?? true;
  }

  get displayedRenderKey(): RenderKey | undefined { return this.artifact?.renderKey; }
  get displayedArtifact(): PreviewArtifact | undefined { return this.artifact; }
  get mappedShadowCount(): number { return this.mappedPaths.size; }

  setDisplayedArtifact(artifact: PreviewArtifact, retainCompilerEntry = false): void {
    this.artifact = artifact;
    const firstPage = artifact.visualSnapshot.kind === "svg" ? artifact.visualSnapshot.pages[0] : undefined;
    this.latestSvg = firstPage?.sanitizedSvg;
    this.latestImageAssets = artifact.visualSnapshot.kind === "svg" ? artifact.visualSnapshot.imageAssets : [];
    this.pageSize = firstPage
      ? { width: firstPage.geometry.cssWidth, height: firstPage.geometry.cssHeight }
      : undefined;
    if (retainCompilerEntry) {
      this.latestCompilerRenderKey = artifact.renderKey;
    } else if (this.latestCompilerRenderKey !== artifact.renderKey) {
      this.latestEntryPath = undefined;
      this.latestCompilerRenderKey = undefined;
    }
  }

  async createExport(format: TypstExportFormat, signal?: AbortSignal): Promise<TypstExport> {
    const entryPath = this.latestEntryPath;
    const svg = this.latestSvg;
    const pageSize = this.pageSize;
    if (!svg || !pageSize) throw new Error("请等待当前预览渲染完成后再导出。");
    signal?.throwIfAborted();
    if (format === "pdf") {
      if (!entryPath) throw new Error("当前预览没有可用于 PDF 导出的编译器快照。");
      const pdf = await this.withTypstOperation(() => {
        signal?.throwIfAborted();
        return $typst.pdf({ mainFilePath: entryPath });
      });
      signal?.throwIfAborted();
      if (!pdf) throw new Error("Typst 未生成 PDF 数据。");
      return { blob: new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), extension: format };
    }
    const exportSvg = svgWithoutSelectionLayer(await inlinePreviewImageAssets(svg, this.latestImageAssets));
    if (format === "svg") {
      return { blob: new Blob([exportSvg], { type: "image/svg+xml;charset=utf-8" }), extension: format };
    }
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const blob = await rasterizeSvg(exportSvg, pageSize, mime);
    signal?.throwIfAborted();
    return { blob, extension: format };
  }

  async createImmutableExport(
    snapshot: ImmutableTypstExportSnapshot,
    renderKey: RenderKey,
    format: TypstExportFormat,
    pageIndex = 0,
    signal?: AbortSignal,
  ): Promise<TypstExport> {
    return this.withTypstOperation(async () => {
      signal?.throwIfAborted();
      await initializeTypst(() => {});
      for (const generation of snapshot.packageGenerations) previewPackageRegistry.install(generation);
      const exactPaths = new Set<string>();
      try {
        for (const file of snapshot.project.files) {
          const bytes = file.text === undefined ? decodeBase64(file.dataBase64) : encoder.encode(file.text);
          const exactPath = exactExportPath(renderKey, file.uri);
          await $typst.mapShadow(exactPath, bytes);
          exactPaths.add(exactPath);
          const absolutePath = virtualPath(file.uri);
          if (absolutePath !== exactPath) {
            await $typst.mapShadow(absolutePath, bytes);
            exactPaths.add(absolutePath);
          }
        }
        const entryPath = exactExportPath(renderKey, snapshot.project.entryUri);
        signal?.throwIfAborted();
        if (format === "pdf") {
          const pdf = await $typst.pdf({ mainFilePath: entryPath });
          signal?.throwIfAborted();
          if (!pdf) throw new Error("Typst did not produce immutable PDF export bytes");
          return { blob: new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), extension: format };
        }
        const { svg } = await renderSvgWithDebugSpans(entryPath);
        signal?.throwIfAborted();
        const parsed = new DOMParser().parseFromString(svg, "text/html");
        const root = parsed.querySelector("svg");
        if (!(root instanceof SVGSVGElement) || root.namespaceURI !== "http://www.w3.org/2000/svg") {
          throw new Error("Typst did not produce immutable SVG export output");
        }
        const geometry = selectSvgExportPage(root, pageIndex);
        ensureSvgPageBackground(root);
        sanitizeSvg(root);
        const imageAssets = await externalizeSvgImages(root);
        const exportSvg = svgWithoutSelectionLayer(
          await inlinePreviewImageAssets(root.outerHTML, imageAssets),
        );
        if (format === "svg") {
          return { blob: new Blob([exportSvg], { type: "image/svg+xml;charset=utf-8" }), extension: format };
        }
        const mime = format === "png" ? "image/png" : "image/jpeg";
        const blob = await rasterizeSvg(exportSvg, geometry, mime);
        signal?.throwIfAborted();
        return { blob, extension: format };
      } finally {
        for (const path of exactPaths) await $typst.unmapShadow(path);
      }
    });
  }

  invalidate(): void {
    this.generation += 1;
    this.pending = undefined;
  }

  async update(project: TypstProjectUpdate, binding?: TypstPreviewBinding): Promise<void> {
    this.generation += 1;
    this.closeRequested = false;
    this.pending = { project, binding };
    await this.processPending();
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.pending = undefined;
    this.closeRequested = true;
    await this.processPending();
  }

  dispose(): void {
    this.generation += 1;
    this.pending = undefined;
  }

  private async processPending(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.closeRequested || this.pending) {
        if (this.closeRequested) {
          this.closeRequested = false;
          await this.withTypstOperation(() => this.resetPreview());
          continue;
        }
        const next = this.pending;
        if (!next) continue;
        const generation = this.generation;
        this.pending = undefined;
        await this.withTypstOperation(() => this.render(next.project, generation, next.binding));
      }
    } finally {
      this.rendering = false;
    }
  }

  private async withTypstOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.typstOperationTail;
    let release!: () => void;
    this.typstOperationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async resetPreview(): Promise<void> {
    for (const path of this.mappedPaths) await $typst.unmapShadow(path);
    this.mappedPaths.clear();
    this.mappedFiles.clear();
    this.pageSize = undefined;
    this.latestEntryPath = undefined;
    this.latestCompilerRenderKey = undefined;
    this.latestSvg = undefined;
    this.latestImageAssets = [];
    this.artifact = undefined;
    this.events?.status("Preview is waiting for a valid MomoScript projection…", false);
  }

  private async render(project: TypstProjectUpdate, generation: number, binding?: TypstPreviewBinding): Promise<void> {
    const revision: PreviewRevision = {
      sourceUri: project.sourceUri,
      sourceVersion: project.sourceVersion,
      revision: project.revision,
      ...(binding?.requestId === undefined ? {} : { requestId: binding.requestId }),
      ...(binding?.traceId === undefined ? {} : { traceId: binding.traceId }),
    };
    const pathFor = (uri: string) => this.reuseCompilerState
      ? previewExecutionPath(project, uri)
      : virtualPath(uri);
    const nextFiles = new Map(project.files.map((file) => [pathFor(file.uri), file]));
    const nextPaths = new Set(nextFiles.keys());
    const mappedThisAttempt = new Set<string>();
    const nextDigests = new Map<string, string>();
    let shadowUpdateMs = 0;
    let typstCompileMs = 0;
    let svgParseSanitizeMs = 0;
    let domUpdateMs = 0;
    let locationMeasureMs = 0;
    let shadowMapped = 0;
    let shadowUnmapped = 0;
    let shadowSkipped = 0;
    this.events?.status("Rendering preview…", false, revision);
    try {
      binding?.signal?.throwIfAborted();
      await initializeTypst((message) => this.events?.status(message, false, revision));
      const mapStarted = performance.now();
      for (const [path, file] of nextFiles) {
        const digest = file.digest;
        if (!digest) throw new Error(`Typst virtual file '${file.uri}' is missing its canonical content digest`);
        nextDigests.set(path, digest);
        if (this.reuseCompilerState && this.mappedFiles.get(path) === digest) {
          shadowSkipped += 1;
          continue;
        }
        const data = file.text === undefined ? decodeBase64(file.dataBase64) : encoder.encode(file.text);
        await $typst.mapShadow(path, data);
        mappedThisAttempt.add(path);
        shadowMapped += 1;
      }
      binding?.signal?.throwIfAborted();
      shadowUpdateMs += performance.now() - mapStarted;
      const entryPath = pathFor(project.entryUri);
      const entryFile = nextFiles.get(entryPath);
      const compileStarted = performance.now();
      const { svg, spans } = await renderSvgWithDebugSpans(entryPath);
      typstCompileMs = performance.now() - compileStarted;
      binding?.signal?.throwIfAborted();
      if (!isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) {
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      const parseStarted = performance.now();
      const parsed = new DOMParser().parseFromString(svg, "text/html");
      const root = parsed.querySelector("svg");
      if (!(root instanceof SVGSVGElement) || root.namespaceURI !== "http://www.w3.org/2000/svg") {
        throw new Error("Typst renderer returned no valid SVG root");
      }
      const pageGap = addSvgPageGaps(root);
      const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
      const viewBoxWidth = viewBox?.length === 4 ? viewBox[2] : undefined;
      const viewBoxHeight = viewBox?.length === 4 ? viewBox[3] : undefined;
      const intrinsicWidth = svgCssPixels(root.getAttribute("width"));
      const intrinsicHeight = svgCssPixels(root.getAttribute("height"));
      const width = intrinsicWidth ?? viewBoxWidth ?? Number.NaN;
      const height = pageGap > 0 && viewBoxWidth !== undefined && viewBoxWidth > 0 && viewBoxHeight !== undefined
        ? width * viewBoxHeight / viewBoxWidth
        : intrinsicHeight ?? (intrinsicWidth !== undefined && viewBoxWidth && viewBoxHeight
          ? intrinsicWidth * viewBoxHeight / viewBoxWidth
          : viewBoxHeight ?? Number.NaN);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("Typst renderer returned SVG without a positive page size");
      }
      if (pageGap === 0) ensureSvgPageBackground(root);
      sanitizeSvg(root);
      const imageAssets = await externalizeSvgImages(root);
      const compactSvg = document.importNode(root, true);
      compactSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      compactSvg.setAttribute("role", "img");
      compactSvg.setAttribute("aria-label", "Rendered MomoScript preview");
      compactSvg.setAttribute("width", "100%");
      compactSvg.setAttribute("height", "100%");
      const normalizedPage = normalizePreviewPage({
        pageIndex: 0,
        geometry: {
          viewBox: [viewBox?.[0] ?? 0, viewBox?.[1] ?? 0, viewBoxWidth ?? width, viewBoxHeight ?? height],
          cssWidth: width,
          cssHeight: height,
        },
        sanitizedSvg: compactSvg.outerHTML,
      }, 0, imageAssets);
      svgParseSanitizeMs = performance.now() - parseStarted;
      binding?.signal?.throwIfAborted();
      if (!isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) {
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      const unmapStarted = performance.now();
      for (const previous of this.mappedPaths) {
        if (!nextPaths.has(previous)) {
          await $typst.unmapShadow(previous);
          shadowUnmapped += 1;
        }
      }
      shadowUpdateMs += performance.now() - unmapStarted;
      binding?.signal?.throwIfAborted();
      this.mappedPaths = nextPaths;
      this.mappedFiles = nextDigests;
      if (!binding) throw new Error("Preview publication requires an immutable render binding");
      if (entryFile?.text === undefined) {
        throw new Error("Rendered Typst entry source is unavailable for exact preview navigation");
      }
      const artifact = createPreviewArtifact({
        renderKey: binding.renderKey,
        sourceUri: binding.identity.sourceUri,
        locationProviderKey: binding.locationProviderKey,
        locationMap: binding.locationMap,
        visualSnapshot: {
          kind: "svg",
          pages: [normalizedPage],
          imageAssets,
        },
      });
      const publicationTiming = await this.events?.rendered({
        artifact,
        identity: binding.identity,
        compactSvg: normalizedPage.sanitizedSvg,
        imageAssets,
        pageSize: { width, height },
        entryUri: project.entryUri,
        entryText: entryFile.text,
        spans,
        signal: binding.signal,
        ...(binding.requestId === undefined ? {} : { requestSequence: binding.requestId }),
        ...(binding.traceId === undefined ? {} : { traceId: binding.traceId }),
      }, revision, this.mappedPaths.size);
      domUpdateMs = publicationTiming?.domUpdateMs ?? 0;
      locationMeasureMs = publicationTiming?.locationMeasureMs ?? 0;
      binding.signal?.throwIfAborted();
      if (!isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) return;
      this.latestEntryPath = entryPath;
      this.setDisplayedArtifact(artifact, true);
      if (binding.traceId) {
        this.events?.timing?.({
          traceId: binding.traceId,
          shadowUpdateMs,
          typstCompileMs,
          svgParseSanitizeMs,
          domUpdateMs,
          locationMeasureMs,
          shadowMapped,
          shadowUnmapped,
          shadowSkipped,
        }, revision);
      }
    } catch (error) {
      await this.unmapAbandonedPaths(mappedThisAttempt);
      if (binding?.signal?.aborted) return;
      if (!isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) return;
      this.events?.status(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, true, revision);
    }
  }

  private async unmapAbandonedPaths(paths: ReadonlySet<string>): Promise<void> {
    for (const path of paths) {
      if (!this.mappedPaths.has(path)) await $typst.unmapShadow(path);
    }
  }
}

export function createRenderArtifactLocationResolver(
  key: LocationProviderKey,
  entryUri: string,
  sourceText: string,
  backendEncoding: PreviewSourceIdentity["backendEncoding"],
  locations: readonly RenderArtifactLocation[],
): PreviewLocationResolver {
  if (key.kind !== "provider" || key.method !== RENDER_ARTIFACT_LOCATION_METHOD) {
    throw new Error("Exact render-artifact locations require the matching provider key");
  }
  return Object.freeze({
    key,
    async locateSelection(request: PreviewProviderSelectionRequest, signal: AbortSignal) {
      if (signal.aborted || request.sourceUri !== entryUri) return Object.freeze([]);
      const start = wirePositionToByteOffset(sourceText, request.range.start, request.positionEncoding);
      const end = wirePositionToByteOffset(sourceText, request.range.end, request.positionEncoding);
      if (start === undefined || end === undefined) return Object.freeze([]);
      const selectedStart = Math.min(start, end);
      const selectedEnd = Math.max(start, end);
      const matching = locations.filter((location) => selectedStart === selectedEnd
        ? location.start <= selectedStart && selectedStart <= location.end
        : location.start < selectedEnd && selectedStart < location.end);
      const candidates = matching.length > 0 ? matching : locations.filter(
        (location) => Math.min(
          Math.abs(location.start - selectedStart),
          Math.abs(location.end - selectedStart),
        ) <= 2,
      );
      return Object.freeze(uniquePagePoints(candidates));
    },
    async locatePoint(request: PreviewProviderPointRequest, signal: AbortSignal) {
      if (signal.aborted || request.pageIndex < 0) return undefined;
      const onPoint = locations.filter((location) =>
        location.pageIndex === request.pageIndex
        && request.x >= location.left
        && request.x <= location.right
        && request.y >= location.top
        && request.y <= location.bottom);
      const pool = onPoint.length > 0
        ? onPoint
        : locations.filter((location) => location.pageIndex === request.pageIndex);
      const nearest = pool
        .map((location) => ({
          location,
          distance: Math.hypot(request.x - location.x, request.y - location.y),
          area: (location.right - location.left) * (location.bottom - location.top),
        }))
        .sort((left, right) => onPoint.length > 0
          ? left.area - right.area || left.distance - right.distance
          : left.distance - right.distance)[0];
      if (!nearest || (onPoint.length === 0 && nearest.distance > 0.04)) return undefined;
      const textOffset = renderTextByteOffset(sourceText, nearest.location, request);
      return Object.freeze({
        uri: entryUri,
        range: byteRangeToWireRange(
          sourceText,
          textOffset ?? nearest.location.start,
          textOffset ?? nearest.location.end,
          backendEncoding,
        ),
      });
    },
  });
}

function renderTextByteOffset(
  source: string,
  location: RenderArtifactLocation,
  request: PreviewProviderPointRequest,
): number | undefined {
  const expectedText = request.text !== undefined && request.textOffset !== undefined
    ? request.text
    : undefined;
  const call = findProjectedTextCall(source, location.start, location.end, expectedText);
  if (!call) return undefined;
  if (request.text !== undefined && request.textOffset !== undefined) {
    return projectedTextCharacterByteOffset(call, request.textOffset);
  }
  const characterOffsets: number[] = [];
  let offset = 0;
  for (const character of call.text) {
    characterOffsets.push(offset);
    offset += character.length;
  }
  if (characterOffsets.length === 0) return undefined;
  const width = location.right - location.left;
  const ratio = width > 0
    ? Math.min(1, Math.max(0, (request.x - location.left) / width))
    : 0;
  return projectedTextCharacterByteOffset(call, characterOffsets[Math.min(
    characterOffsets.length - 1,
    Math.floor(ratio * characterOffsets.length),
  )]!);
}

export function refineRenderTextLocation(
  source: string,
  location: PreviewBackendLocation,
  backendEncoding: PreviewSourceIdentity["backendEncoding"],
  point: PreviewNavigationPoint,
): PreviewBackendLocation {
  if (point.text === undefined || point.textOffset === undefined) return location;
  const start = wirePositionToByteOffset(source, location.range.start, backendEncoding);
  const end = wirePositionToByteOffset(source, location.range.end, backendEncoding);
  if (start === undefined || end === undefined) return location;
  const call = findProjectedTextCall(source, Math.min(start, end), Math.max(start, end), point.text);
  if (!call) return location;
  const textOffset = projectedTextCharacterByteOffset(call, point.textOffset);
  if (textOffset === undefined) return location;
  return Object.freeze({
    uri: location.uri,
    range: byteRangeToWireRange(source, textOffset, textOffset, backendEncoding),
  });
}

interface ProjectedTextCall {
  readonly text: string;
  readonly contentStart: number;
}

function findProjectedTextCall(
  source: string,
  locationStart: number,
  locationEnd: number,
  expectedText?: string,
): ProjectedTextCall | undefined {
  const bytes = encoder.encode(source);
  const expectedBytes = expectedText === undefined ? 0 : encoder.encode(expectedText).byteLength;
  const searchStart = Math.max(0, locationStart - textCallPrefix.byteLength - expectedBytes - 2);
  const searchEnd = Math.min(bytes.byteLength - textCallPrefix.byteLength, locationEnd + textCallPrefix.byteLength);
  for (let markerStart = searchStart; markerStart <= searchEnd; markerStart += 1) {
    if (!textCallPrefix.every((byte, index) => bytes[markerStart + index] === byte)) continue;
    const identifierEnd = markerStart + 5;
    const contentStart = markerStart + textCallPrefix.byteLength;
    let contentEnd = contentStart;
    while (contentEnd < bytes.byteLength && bytes[contentEnd] !== 0x22) {
      // Escaped projection segments are intentionally not reverse-mappable.
      if (bytes[contentEnd] === 0x5c) return undefined;
      contentEnd += 1;
    }
    if (contentEnd >= bytes.byteLength || contentEnd === contentStart) return undefined;
    const overlapsIdentifier = locationEnd >= markerStart && locationStart <= identifierEnd;
    const liesInsideContent = contentStart <= locationStart && locationEnd <= contentEnd;
    if (!overlapsIdentifier && !liesInsideContent) continue;
    try {
      const text = decoder.decode(bytes.subarray(contentStart, contentEnd));
      if (expectedText !== undefined && text !== expectedText) continue;
      return Object.freeze({ text, contentStart });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function projectedTextCharacterByteOffset(call: ProjectedTextCall, textOffset: number): number | undefined {
  if (!Number.isSafeInteger(textOffset) || textOffset < 0 || textOffset >= call.text.length) return undefined;
  let validBoundary = false;
  let offset = 0;
  for (const character of call.text) {
    if (offset === textOffset) {
      validBoundary = true;
      break;
    }
    offset += character.length;
  }
  if (!validBoundary) return undefined;
  return call.contentStart + encoder.encode(call.text.slice(0, textOffset)).byteLength;
}

function uniquePagePoints(locations: readonly RenderArtifactLocation[]): readonly PreviewPagePoint[] {
  const seen = new Set<string>();
  const points: PreviewPagePoint[] = [];
  for (const location of locations) {
    const identity = `${location.pageIndex}:${location.x.toFixed(5)}:${location.y.toFixed(5)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    points.push(Object.freeze({
      pageIndex: location.pageIndex,
      x: location.x,
      y: location.y,
    }));
  }
  return points;
}

function wirePositionToByteOffset(
  source: string,
  position: { readonly line: number; readonly character: number },
  encoding: "utf-8" | "utf-16" | "utf-32",
): number | undefined {
  if (position.line < 0 || position.character < 0) return undefined;
  let lineStart = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) return undefined;
    lineStart = newline + 1;
  }
  const newline = source.indexOf("\n", lineStart);
  const lineText = source.slice(lineStart, newline < 0 ? source.length : newline);
  let codeUnitOffset: number | undefined;
  if (encoding === "utf-16") {
    codeUnitOffset = position.character <= lineText.length ? position.character : undefined;
  } else if (encoding === "utf-32") {
    const codePoints = [...lineText];
    codeUnitOffset = position.character <= codePoints.length
      ? codePoints.slice(0, position.character).join("").length
      : undefined;
  } else {
    codeUnitOffset = utf8CharacterToCodeUnitOffset(lineText, position.character);
  }
  return codeUnitOffset === undefined
    ? undefined
    : encoder.encode(source.slice(0, lineStart + codeUnitOffset)).byteLength;
}

function utf8CharacterToCodeUnitOffset(text: string, byteOffset: number): number | undefined {
  if (byteOffset < 0) return undefined;
  let bytes = 0;
  let codeUnits = 0;
  for (const character of text) {
    if (bytes === byteOffset) return codeUnits;
    const encoded = encoder.encode(character).byteLength;
    if (bytes + encoded > byteOffset) return undefined;
    bytes += encoded;
    codeUnits += character.length;
  }
  return bytes === byteOffset ? codeUnits : undefined;
}

function byteRangeToWireRange(
  source: string,
  start: number,
  end: number,
  encoding: "utf-8" | "utf-16" | "utf-32",
) {
  return Object.freeze({
    start: byteOffsetToWirePosition(source, start, encoding),
    end: byteOffsetToWirePosition(source, end, encoding),
  });
}

function byteOffsetToWirePosition(
  source: string,
  byteOffset: number,
  encoding: "utf-8" | "utf-16" | "utf-32",
) {
  const bytes = encoder.encode(source);
  const prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, byteOffset));
  const line = prefix.split("\n").length - 1;
  const lineText = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const character = encoding === "utf-8"
    ? encoder.encode(lineText).byteLength
    : encoding === "utf-32" ? [...lineText].length : lineText.length;
  return Object.freeze({ line, character });
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}


function svgCssPixels(value: string | null): number | undefined {
  if (value === null) return undefined;
  const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(px|pt|in|cm|mm)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "px").toLowerCase();
  const factor = unit === "pt" ? 96 / 72
    : unit === "in" ? 96
      : unit === "cm" ? 96 / 2.54
        : unit === "mm" ? 96 / 25.4
          : 1;
  return amount * factor;
}

function addSvgPageGaps(root: SVGElement): number {
  const pages = [...root.children].filter(
    (child): child is SVGGElement => child instanceof SVGGElement && child.classList.contains("typst-page")
  );
  if (pages.length === 0) return 0;
  const transforms = pages.map((page) => {
    const transform = page.getAttribute("transform") ?? "";
    return /^translate\(\s*([-+]?\d*\.?\d+)\s*[, ]\s*([-+]?\d*\.?\d+)\s*\)$/.exec(transform);
  });
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  if (
    transforms.some((transform) => transform === null)
    || viewBox?.length !== 4
    || viewBox.some((value) => !Number.isFinite(value))
  ) return 0;

  const pageTops = transforms.map((transform) => Number(transform![2]));
  const documentBottom = viewBox[1] + viewBox[3];
  for (const [index, page] of pages.entries()) {
    const pageBottom = pageTops[index + 1] ?? documentBottom;
    const background = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("x", "0");
    background.setAttribute("y", "0");
    background.setAttribute("width", String(viewBox[2]));
    background.setAttribute("height", String(pageBottom - pageTops[index]!));
    background.setAttribute("fill", "white");
    background.setAttribute("data-preview-page-background", "true");
    page.prepend(background);
  }

  const gap = 12;
  for (const [index, page] of pages.entries()) {
    const transform = transforms[index]!;
    page.setAttribute("transform", `translate(${transform![1]}, ${pageTops[index]! + gap * index})`);
  }
  const added = gap * (pages.length - 1);
  viewBox[3] += added;
  root.setAttribute("viewBox", viewBox.join(" "));
  return added;
}

export function ensureSvgPageBackground(root: SVGSVGElement): void {
  if (root.querySelector(":scope > [data-preview-page-background]")) return;
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  const validViewBox = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;
  const background = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", validViewBox ? String(viewBox[0]) : "0");
  background.setAttribute("y", validViewBox ? String(viewBox[1]) : "0");
  background.setAttribute("width", validViewBox ? String(viewBox[2]) : "100%");
  background.setAttribute("height", validViewBox ? String(viewBox[3]) : "100%");
  background.setAttribute("fill", "white");
  background.setAttribute("data-preview-page-background", "true");
  root.prepend(background);
}

export function sanitizeSvg(root: SVGElement): void {
  root.querySelectorAll("script, style, iframe, object, embed").forEach((node) => node.remove());
  root.querySelectorAll("foreignObject").forEach((node) => {
    if (!isSafeTextSelectionNode(node)) {
      node.remove();
      return;
    }
    normalizeTextSelectionNode(node);
  });
  root.querySelectorAll("rect.pseudo-link").forEach((node) => {
    node.setAttribute("fill", "transparent");
  });
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (!value.startsWith("#") && !value.startsWith("data:image/")) {
          element.removeAttribute(attribute.name);
        }
        continue;
      }
      if (/url\s*\(/i.test(value) && !/^url\(\s*#[^)]+\s*\)$/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

async function externalizeSvgImages(root: SVGElement): Promise<readonly PreviewImageAsset[]> {
  const references = [...root.querySelectorAll("image")].flatMap((image) => {
    const attribute = image.hasAttribute("href") ? "href" : (image.hasAttribute("xlink:href") ? "xlink:href" : undefined);
    const href = attribute ? image.getAttribute(attribute)?.trim() : undefined;
    return attribute && href?.startsWith("data:image/") ? [{ image, attribute, href }] : [];
  });
  const uniqueDataUrls = [...new Set(references.map((reference) => reference.href))];
  const resolved = await Promise.all(uniqueDataUrls.map(async (dataUrl) => {
    const { mimeType, bytes } = decodeImageDataUrl(dataUrl);
    const mimeBytes = encoder.encode(`${mimeType}\0`);
    const digestInput = new Uint8Array(mimeBytes.byteLength + bytes.byteLength);
    digestInput.set(mimeBytes);
    digestInput.set(bytes, mimeBytes.byteLength);
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
    const digest = `sha256:${[...digestBytes].map((value) => value.toString(16).padStart(2, "0")).join("")}` as const;
    const blobBytes = Uint8Array.from(bytes).buffer;
    return [dataUrl, Object.freeze({
      digest,
      mimeType,
      blob: new Blob([blobBytes], { type: mimeType }),
    })] as const;
  }));
  const byDataUrl = new Map(resolved);
  const byDigest = new Map<PreviewImageAsset["digest"], PreviewImageAsset>();
  for (const reference of references) {
    const asset = byDataUrl.get(reference.href);
    if (!asset) throw new Error("Preview image asset extraction failed");
    byDigest.set(asset.digest, asset);
    reference.image.setAttribute(reference.attribute, previewImageAssetHref(asset.digest));
  }
  return Object.freeze([...byDigest.values()]);
}

function decodeImageDataUrl(dataUrl: string): { readonly mimeType: string; readonly bytes: Uint8Array } {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Preview image has a malformed data URL");
  const metadata = dataUrl.slice("data:".length, comma).split(";");
  const mimeType = (metadata.shift() ?? "").toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(mimeType)) throw new Error("Preview image has an unsupported MIME type");
  const payload = dataUrl.slice(comma + 1);
  const bytes = metadata.some((item) => item.toLowerCase() === "base64")
    ? decodeBase64(payload)
    : encoder.encode(decodeURIComponent(payload));
  if (bytes.byteLength === 0) throw new Error("Preview image data URL is empty");
  return { mimeType, bytes };
}

function isSafeTextSelectionNode(node: SVGForeignObjectElement): boolean {
  const allowedForeignAttributes = new Set(["x", "y", "width", "height", "transform"]);
  if ([...node.attributes].some((attribute) => !allowedForeignAttributes.has(attribute.name))) {
    return false;
  }
  const children = [...node.children];
  if (children.length !== 1) return false;
  const text = children[0] as HTMLElement;
  if (
    text.namespaceURI !== "http://www.w3.org/1999/xhtml"
    || !["div", "h5:div"].includes(text.localName)
    || text.className !== "tsel"
  ) return false;
  if ([...text.attributes].some((attribute) => !["class", "style"].includes(attribute.name))) {
    return false;
  }
  if (!/^font-size:\s*[+]?(?:\d+(?:\.\d*)?|\.\d+)px;?$/i.test(text.getAttribute("style") ?? "")) {
    return false;
  }
  return [...text.childNodes].every(isSafeSelectionTextChild);
}

function isSafeSelectionTextChild(child: ChildNode): boolean {
  if (child.nodeType === Node.TEXT_NODE) return true;
  if (
    !(child instanceof HTMLElement)
    || child.namespaceURI !== "http://www.w3.org/1999/xhtml"
    || !["span", "h5:span"].includes(child.localName)
  ) return false;
  if ([...child.attributes].some((attribute) => attribute.name !== "class" || attribute.value !== "")) {
    return false;
  }
  return [...child.childNodes].every(isSafeSelectionTextChild);
}



function svgWithoutSelectionLayer(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror")) {
    throw new Error("无法为导出解析当前 SVG。");
  }
  root.querySelectorAll("foreignObject").forEach((node) => {
    if (node.querySelector(":scope > .tsel")) node.remove();
  });
  return new XMLSerializer().serializeToString(root);
}

async function rasterizeSvg(
  svg: string,
  pageSize: { width: number; height: number },
  mime: "image/png" | "image/jpeg"
): Promise<Blob> {
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(pageSize.width * scale);
  canvas.height = Math.ceil(pageSize.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建图片导出画布。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, mime === "image/jpeg" ? 0.92 : undefined));
    if (!blob) throw new Error("浏览器未生成图片数据。");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function initializeTypst(report: (message: string) => void): Promise<void> {
  if (initialized) return;
  if (!compilerModule) {
    const bytes = await fetchDecodedRuntimeArtifact({
      artifact: TYPST_COMPILER_WASM_ARTIFACT,
      label: "Typst 编译器 WASM",
      timeoutMs: 30_000,
      report,
    });
    if (!WebAssembly.validate(bytes)) throw new Error("Typst 编译器 WASM 不是有效的 WebAssembly 模块");
    compilerModule = await WebAssembly.compile(bytes);
  }
  $typst.setCompilerInitOptions({
    beforeBuild: [bundledFontsLoader, decodedMainFontsLoader],
    getModule: () => compilerModule!,
  });
  $typst.use(
    TypstSnippet.withAccessModel(previewAccessModel),
    TypstSnippet.withPackageRegistry(previewPackageRegistry)
  );
  initialized = true;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function exactExportPath(renderKey: RenderKey, uri: string): string {
  const relative = virtualPath(uri).replace(/^\/+/, "");
  return `/__mmt_exact/${renderKey}/${relative}`;
}

function selectSvgExportPage(
  root: SVGSVGElement,
  pageIndex: number,
): { readonly width: number; readonly height: number } {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error("Invalid immutable export page index");
  const pages = [...root.children].filter(
    (child): child is SVGGElement => child instanceof SVGGElement && child.classList.contains("typst-page"),
  );
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  if (pages.length === 0) {
    if (pageIndex !== 0 || viewBox?.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
      throw new Error("Immutable SVG export page geometry is unavailable");
    }
    const width = svgCssPixels(root.getAttribute("width")) ?? viewBox[2]!;
    const height = svgCssPixels(root.getAttribute("height")) ?? viewBox[3]!;
    return { width, height };
  }
  const page = pages[pageIndex];
  if (!page || viewBox?.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
    throw new Error("Immutable SVG export page is unavailable");
  }
  const transforms = pages.map((candidate) =>
    /^translate\(\s*([-+]?\d*\.?\d+)\s*[, ]\s*([-+]?\d*\.?\d+)\s*\)$/.exec(
      candidate.getAttribute("transform") ?? "",
    ));
  if (transforms.some((transform) => transform === null)) {
    throw new Error("Immutable SVG export page transform is unavailable");
  }
  const top = Number(transforms[pageIndex]![2]);
  const bottom = pageIndex + 1 < pages.length
    ? Number(transforms[pageIndex + 1]![2])
    : viewBox[1]! + viewBox[3]!;
  const height = bottom - top;
  const width = viewBox[2]!;
  if (!(width > 0 && height > 0)) throw new Error("Immutable SVG export page has invalid dimensions");
  for (const candidate of pages) {
    if (candidate !== page) candidate.remove();
  }
  page.setAttribute("transform", `translate(${transforms[pageIndex]![1]}, 0)`);
  root.setAttribute("viewBox", `${viewBox[0]} 0 ${width} ${height}`);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  return { width: svgCssPixels(root.getAttribute("width")) ?? width, height: svgCssPixels(root.getAttribute("height")) ?? height };
}

function previewExecutionPath(project: TypstProjectUpdate, uri: string): string {
  const path = virtualPath(uri);
  if (uri !== project.entryUri) return path;
  const separator = path.lastIndexOf("/");
  return `${path.slice(0, separator + 1)}main-preview.typ`;
}

function virtualPath(uri: string): string {
  const parsed = new URL(uri);
  return decodeURIComponent(parsed.pathname);
}
