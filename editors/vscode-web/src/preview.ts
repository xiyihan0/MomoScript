import { $typst, MemoryAccessModel } from "@myriaddreamin/typst.ts";
import { loadFonts } from "@myriaddreamin/typst.ts/dist/esm/options.init.mjs";
import { TypstSnippet } from "@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs";
import rendererWasmUrl from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url";
import notoRegularUrl from "../../vscode/vendor/fonts/NotoSansCJK-Regular.ttc?url";
import notoBoldUrl from "../../vscode/vendor/fonts/NotoSansCJK-Bold.ttc?url";
import monoUrl from "../../vscode/vendor/fonts/DejaVuSansMono.ttf?url";
import jetBrainsMonoUrl from "../../vscode/vendor/fonts/JetBrainsMono-Regular.ttf?url";
import mathUrl from "../../vscode/vendor/fonts/NewCMMath-Regular.otf?url";

import type { TypstProjectUpdate } from "../../vscode/src/tinymistClient";
import { isCurrentPreviewUpdate, type PreviewRevision } from "./previewDiagnostics";
import {
  createPreviewArtifact,
  normalizePreviewPage,
  type LocationProviderKey,
  type PreviewArtifact,
  type PreviewImmutableLocationMap,
  type PreviewPage,
  type PreviewPagePoint,
  type PreviewSourceTarget,
  type PreviewViewport,
} from "./previewArtifact.ts";
import {
  BrowserPreviewViewportPersistence,
  PreviewInteractionController,
  PreviewUpdateCoordinator,
  safePreviewOutline,
  type PreviewEditorSelection,
  type PreviewInteractionDependencies,
  type PreviewLocationResolver,
  type PreviewOutlineSymbol,
  type PreviewPageBatch,
  type PreviewBatchResult,
  type PreviewProtocolCapabilities,
  type PreviewSourceIdentity,
} from "./previewInteraction.ts";
import type { RenderKey } from "../../vscode/src/runtimeIdentity";
import { TYPST_COMPILER_WASM_URL } from "./runtimeArtifacts";


const mainRegularUrl = "https://mms-pack.xiyihan.cn/fonts/MainFont.otf";
const mainBoldUrl = "https://mms-pack.xiyihan.cn/fonts/MainFont_Bold.otf";
const bundledFontsLoader = loadFonts([
  mathUrl,
  notoRegularUrl,
  notoBoldUrl,
  monoUrl,
  jetBrainsMonoUrl,
], { assets: false });
const remoteMainFontsLoader = loadFonts([mainRegularUrl, mainBoldUrl], { assets: false });
const optionalMainFontsLoader = async (
  ...args: Parameters<typeof remoteMainFontsLoader>
): Promise<void> => {
  try {
    await remoteMainFontsLoader(...args);
  } catch (error) {
    console.warn("MomoScript preview is using the bundled Noto fallback because MainFont could not be loaded.", error);
  }
};

const encoder = new TextEncoder();
let initialized = false;
let compilerModule: WebAssembly.Module | undefined;

export interface TypstPreviewEvents {
  status(message: string, error: boolean, revision?: PreviewRevision): void;
  rendered(svg: string, revision: PreviewRevision, shadowCount: number, pageSize: { width: number; height: number }): void;
}

export interface TypstPreviewBinding {
  readonly renderKey: RenderKey;
  readonly requestId?: number;
  readonly locationProviderKey: LocationProviderKey;
  readonly locationMap?: PreviewImmutableLocationMap;
  readonly identity: PreviewSourceIdentity;
  readonly resolver?: PreviewLocationResolver;
}

interface PendingPreviewRender {
  readonly project: TypstProjectUpdate;
  readonly binding?: TypstPreviewBinding;
}
export type TypstExportFormat = "pdf" | "png" | "jpg" | "svg";

export interface TypstExport {
  blob: Blob;
  extension: TypstExportFormat;
}

export class TypstPreviewController {
  private readonly container: HTMLElement;
  private readonly events: TypstPreviewEvents | undefined;
  private pending: PendingPreviewRender | undefined;
  private rendering = false;
  private mappedPaths = new Set<string>();
  private generation = 0;
  private closeRequested = false;
  private readonly viewport = document.createElement("div");
  private readonly canvas = document.createElement("div");
  private readonly zoomLabel = document.createElement("span");
  private readonly interactionStatus = document.createElement("span");
  private readonly outline = document.createElement("nav");
  private readonly pageElements = new Map<number, HTMLElement>();
  private readonly interaction: PreviewInteractionController;
  private readonly resizeObserver: ResizeObserver | undefined;
  private updates = new PreviewUpdateCoordinator({ protocolVersion: "mmt-preview-v1" });
  private zoom = 1;
  private fitMode: PreviewViewport["fitMode"] = "width";
  private pageSize: { width: number; height: number } | undefined;
  private latestEntryPath: string | undefined;
  private latestSvg: string | undefined;
  private scrollFrame: number | undefined;

  constructor(
    container: HTMLElement,
    events?: TypstPreviewEvents,
    interactionDependencies: PreviewInteractionDependencies = {},
  ) {
    this.container = container;
    this.events = events;
    this.container.classList.add("typst-preview");
    const toolbar = document.createElement("div");
    toolbar.className = "typst-preview-toolbar";
    this.interactionStatus.className = "typst-preview-interaction-status";
    this.interactionStatus.setAttribute("role", "status");
    toolbar.append(
      this.interactionStatus,
      this.control("−", "Zoom out", () => this.setZoom(this.zoom - 0.1, "manual")),
      this.zoomLabel,
      this.control("+", "Zoom in", () => this.setZoom(this.zoom + 0.1, "manual")),
      this.control("100%", "Actual size", () => this.setZoom(1, "manual")),
      this.control("Fit width", "Fit width", () => this.fitWidth()),
      this.control("Fit page", "Fit page", () => this.fitPage()),
    );
    this.zoomLabel.className = "typst-preview-zoom";
    this.viewport.className = "typst-preview-viewport";
    this.canvas.className = "typst-preview-canvas";
    this.outline.className = "typst-preview-outline";
    this.outline.setAttribute("aria-label", "Preview outline");
    this.outline.hidden = true;
    const persistence = interactionDependencies.persistence
      ?? (typeof localStorage === "undefined" ? undefined : new BrowserPreviewViewportPersistence(localStorage));
    const externalInteractionEvents = interactionDependencies.events;
    this.interaction = new PreviewInteractionController({
      ...interactionDependencies,
      persistence,
      events: {
        statusChanged: (status, message) => {
          this.interactionStatus.dataset.status = status;
          this.interactionStatus.textContent = message;
          externalInteractionEvents?.statusChanged?.(status, message);
        },
        indicatorChanged: (indicator) => {
          this.showIndicator(indicator?.point);
          externalInteractionEvents?.indicatorChanged?.(indicator);
        },
        cursorChanged: (cursor) => {
          this.showCursor(cursor?.point);
          externalInteractionEvents?.cursorChanged?.(cursor);
        },
        viewportChanged: (state) => {
          this.applyViewportState(state);
          externalInteractionEvents?.viewportChanged?.(state);
        },
        sourceOpened: (target) => externalInteractionEvents?.sourceOpened?.(target),
        fullRefreshRequested: (reason) => externalInteractionEvents?.fullRefreshRequested?.(reason),
      },
    });
    this.viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.setZoom(this.zoom + (event.deltaY > 0 ? -0.1 : 0.1), "manual");
    }, { passive: false });
    this.viewport.addEventListener("scroll", () => this.scheduleViewportReport(), { passive: true });
    this.container.replaceChildren(toolbar, this.outline, this.viewport);
    this.setZoom(1, "manual", false);
    this.showStatus("Preview is waiting for the first MomoScript projection…");
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
        if (this.fitMode === "width") this.fitWidth(false);
        else if (this.fitMode === "page") this.fitPage(false);
      });
    this.resizeObserver?.observe(this.viewport);
  }

  get viewportState(): PreviewViewport { return this.interaction.viewport; }
  get displayedRenderKey(): RenderKey | undefined { return this.interaction.artifact?.renderKey; }
  get displayedArtifact(): PreviewArtifact | undefined { return this.interaction.artifact; }

  updateViewportFromHost(viewport: PreviewViewport): void {
    this.interaction.updateViewport(viewport);
  }

  navigatePreviewPoint(point: PreviewPagePoint): Promise<PreviewSourceTarget | undefined> {
    return this.interaction.navigatePreviewPoint(point);
  }

  private control(label: string, title: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", action);
    return button;
  }

  private setZoom(value: number, fitMode: PreviewViewport["fitMode"], persist = true): void {
    this.zoom = Math.round(Math.min(5, Math.max(0.1, value)) * 100) / 100;
    this.fitMode = fitMode;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.applyPageLayout();
    if (persist && this.interaction.artifact) {
      this.interaction.updateViewport({ ...this.interaction.viewport, zoom: this.zoom, fitMode });
    }
  }

  private fitWidth(persist = true): void {
    const page = this.pageElements.get(this.interaction.viewport.page) ?? this.pageElements.values().next().value;
    const width = Number(page?.dataset.intrinsicWidth);
    if (!(width > 0)) return;
    this.setZoom((this.viewport.clientWidth - 32) / width, "width", persist);
  }

  private fitPage(persist = true): void {
    const page = this.pageElements.get(this.interaction.viewport.page) ?? this.pageElements.values().next().value;
    const width = Number(page?.dataset.intrinsicWidth);
    const height = Number(page?.dataset.intrinsicHeight);
    if (!(width > 0) || !(height > 0)) return;
    this.setZoom(Math.min((this.viewport.clientWidth - 32) / width, (this.viewport.clientHeight - 32) / height), "page", persist);
  }

  async createExport(format: TypstExportFormat): Promise<TypstExport> {
    const entryPath = this.latestEntryPath;
    const svg = this.latestSvg;
    const pageSize = this.pageSize;
    if (!entryPath || !svg || !pageSize) throw new Error("请等待当前预览渲染完成后再导出。");
    if (format === "pdf") {
      const pdf = await $typst.pdf({ mainFilePath: entryPath });
      if (!pdf) throw new Error("Typst 未生成 PDF 数据。");
      return { blob: new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), extension: format };
    }
    const exportSvg = svgWithoutSelectionLayer(svg);
    if (format === "svg") {
      return { blob: new Blob([exportSvg], { type: "image/svg+xml;charset=utf-8" }), extension: format };
    }
    const mime = format === "png" ? "image/png" : "image/jpeg";
    return { blob: await rasterizeSvg(exportSvg, pageSize, mime), extension: format };
  }

  invalidate(): void {
    this.generation += 1;
    this.pending = undefined;
    this.interaction.removeCursor();
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
    this.resizeObserver?.disconnect();
    if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame);
    this.interaction.dispose();
  }

  scheduleEditorSelection(selection: PreviewEditorSelection): void {
    this.interaction.scheduleEditorSelection(selection);
  }

  sourceIdentityAdvanced(identity: PreviewSourceIdentity): void {
    this.interaction.sourceIdentityAdvanced(identity);
  }

  providerRestarted(key: LocationProviderKey | undefined): void {
    this.interaction.providerRestarted(key);
  }

  setRendererCapabilities(capabilities: PreviewProtocolCapabilities): void {
    this.updates = new PreviewUpdateCoordinator(capabilities, {
      fullRefreshRequested: (reason) => {
        this.interactionStatus.dataset.status = "stale";
        this.interactionStatus.textContent = `Preview update ${reason}; waiting for a full refresh.`;
      },
    });
  }

  acceptPageBatch(batch: PreviewPageBatch, binding: TypstPreviewBinding): PreviewBatchResult {
    if (batch.renderKey !== binding.renderKey) return { status: "full-refresh", reason: "mixed-render-key" };
    const result = this.updates.accept(batch);
    if (result.status === "complete") {
      const artifact = createPreviewArtifact({
        renderKey: binding.renderKey,
        sourceUri: binding.identity.sourceUri,
        locationProviderKey: binding.locationProviderKey,
        locationMap: binding.locationMap,
        pages: result.pages,
      });
      this.displayArtifact(artifact, binding.identity, binding.resolver);
    }
    return result;
  }

  displayArtifact(artifact: PreviewArtifact, identity: PreviewSourceIdentity, resolver?: PreviewLocationResolver): void {
    this.mountPages(artifact.pages);
    this.interaction.bindArtifact(artifact, identity, resolver);
    this.container.dataset.previewRenderKey = artifact.renderKey;
    requestAnimationFrame(() => this.restoreViewport(this.interaction.viewport));
  }

  setOutline(symbols: readonly PreviewOutlineSymbol[]): void {
    const safeSymbols = safePreviewOutline(symbols);
    this.outline.replaceChildren();
    const append = (items: readonly PreviewOutlineSymbol[], depth: number) => {
      for (const symbol of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = symbol.label;
        button.style.paddingInlineStart = `${8 + depth * 14}px`;
        button.addEventListener("click", () => void this.interaction.openMappedTarget(symbol.target));
        this.outline.append(button);
        if (symbol.children) append(symbol.children, depth + 1);
      }
    };
    append(safeSymbols, 0);
    this.outline.hidden = safeSymbols.length === 0;
  }

  private async processPending(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.closeRequested || this.pending) {
        if (this.closeRequested) {
          this.closeRequested = false;
          await this.resetPreview();
          continue;
        }
        const next = this.pending;
        if (!next) continue;
        const generation = this.generation;
        this.pending = undefined;
        await this.render(next.project, generation, next.binding);
      }
    } finally {
      this.rendering = false;
    }
  }

  private async resetPreview(): Promise<void> {
    for (const path of this.mappedPaths) await $typst.unmapShadow(path);
    this.mappedPaths.clear();
    this.pageElements.clear();
    this.pageSize = undefined;
    this.latestEntryPath = undefined;
    this.latestSvg = undefined;
    this.canvas.replaceChildren();
    this.outline.replaceChildren();
    this.outline.hidden = true;
    this.interaction.dispose();
    delete this.container.dataset.previewRevision;
    delete this.container.dataset.previewShadowCount;
    delete this.container.dataset.previewRenderKey;
    this.container.dataset.previewReady = "false";
    this.showStatus("Preview is waiting for a valid MomoScript projection…");
  }

  private async render(project: TypstProjectUpdate, generation: number, binding?: TypstPreviewBinding): Promise<void> {
    const revision: PreviewRevision = {
      sourceUri: project.sourceUri,
      sourceVersion: project.sourceVersion,
      revision: project.revision,
      ...(binding?.requestId === undefined ? {} : { requestId: binding.requestId }),
    };
    const nextPaths = new Set(project.files.map((file) => virtualPath(file.uri)));
    const mappedThisAttempt = new Set<string>();
    this.showStatus("Rendering preview…", false, revision, generation);
    try {
      await initializeTypst((message) => this.showStatus(message, false, revision, generation));
      for (const file of project.files) {
        const path = virtualPath(file.uri);
        const data = file.text === undefined ? decodeBase64(file.dataBase64) : encoder.encode(file.text);
        await $typst.mapShadow(path, data);
        mappedThisAttempt.add(path);
      }
      const svg = await $typst.svg({ mainFilePath: virtualPath(project.entryUri) });
      if (!isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) {
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      const parsed = new DOMParser().parseFromString(svg, "text/html");
      const root = parsed.querySelector("svg");
      if (!(root instanceof SVGSVGElement) || root.namespaceURI !== "http://www.w3.org/2000/svg") {
        throw new Error("Typst renderer returned no valid SVG root");
      }
      const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
      const viewBoxWidth = viewBox?.length === 4 ? viewBox[2] : undefined;
      const viewBoxHeight = viewBox?.length === 4 ? viewBox[3] : undefined;
      const intrinsicWidth = svgCssPixels(root.getAttribute("width"));
      const intrinsicHeight = svgCssPixels(root.getAttribute("height"));
      const width = intrinsicWidth ?? viewBoxWidth ?? Number.NaN;
      const height = intrinsicHeight ?? (intrinsicWidth !== undefined && viewBoxWidth && viewBoxHeight
        ? intrinsicWidth * viewBoxHeight / viewBoxWidth
        : viewBoxHeight ?? Number.NaN);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("Typst renderer returned SVG without a positive page size");
      }
      sanitizeSvg(root);
      const inlineSvg = document.importNode(root, true);
      inlineSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      inlineSvg.setAttribute("role", "img");
      inlineSvg.setAttribute("aria-label", "Rendered MomoScript preview");
      inlineSvg.setAttribute("width", "100%");
      inlineSvg.setAttribute("height", "100%");
      const normalizedPage = normalizePreviewPage({
        pageIndex: 0,
        geometry: {
          viewBox: [viewBox?.[0] ?? 0, viewBox?.[1] ?? 0, viewBoxWidth ?? width, viewBoxHeight ?? height],
          cssWidth: width,
          cssHeight: height,
        },
        sanitizedSvg: inlineSvg.outerHTML,
      }, 0);
      if (!isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) {
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      for (const previous of this.mappedPaths) {
        if (!nextPaths.has(previous)) await $typst.unmapShadow(previous);
      }
      this.mappedPaths = nextPaths;
      this.pageSize = { width, height };
      this.latestEntryPath = virtualPath(project.entryUri);
      this.latestSvg = normalizedPage.sanitizedSvg;
      if (binding) {
        const artifact = createPreviewArtifact({
          renderKey: binding.renderKey,
          sourceUri: binding.identity.sourceUri,
          locationProviderKey: binding.locationProviderKey,
          locationMap: binding.locationMap,
          pages: [normalizedPage],
        });
        this.displayArtifact(artifact, binding.identity, binding.resolver);
      } else {
        this.mountPages([normalizedPage]);
      }
      this.container.dataset.previewRevision = String(project.revision);
      this.container.dataset.previewShadowCount = String(this.mappedPaths.size);
      this.container.dataset.previewReady = "true";
      this.events?.rendered(normalizedPage.sanitizedSvg, revision, this.mappedPaths.size, this.pageSize);
    } catch (error) {
      await this.unmapAbandonedPaths(mappedThisAttempt);
      if (!isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) return;
      this.container.dataset.previewReady = "false";
      this.showStatus(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, true, revision, generation);
    }
  }

  private mountPages(pages: readonly PreviewPage[]): void {
    this.pageElements.clear();
    this.canvas.replaceChildren();
    for (const page of pages) {
      const element = document.createElement("article");
      element.className = "typst-preview-page";
      element.dataset.pageIndex = String(page.pageIndex);
      element.dataset.intrinsicWidth = String(page.geometry.cssWidth);
      element.dataset.intrinsicHeight = String(page.geometry.cssHeight);
      const parsed = new DOMParser().parseFromString(page.sanitizedSvg, "text/html");
      const svg = parsed.querySelector("svg");
      if (!(svg instanceof SVGSVGElement) || svg.namespaceURI !== "http://www.w3.org/2000/svg") {
        throw new Error("Preview artifact page has no valid SVG root");
      }
      element.append(document.importNode(svg, true));
      element.addEventListener("click", (event) => {
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        void this.interaction.navigatePreviewPoint({
          pageIndex: page.pageIndex,
          x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
          y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
        });
      });
      this.pageElements.set(page.pageIndex, element);
      this.canvas.append(element);
    }
    this.viewport.replaceChildren(this.canvas);
    this.applyPageLayout();
  }

  private applyPageLayout(): void {
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    let maximumWidth = 0;
    for (const element of this.pageElements.values()) {
      const width = Number(element.dataset.intrinsicWidth) * this.zoom;
      const height = Number(element.dataset.intrinsicHeight) * this.zoom;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      maximumWidth = Math.max(maximumWidth, width);
    }
    this.canvas.style.width = `${maximumWidth}px`;
  }

  private applyViewportState(state: PreviewViewport): void {
    this.zoom = state.zoom;
    this.fitMode = state.fitMode;
    if (state.fitMode === "width") this.fitWidth(false);
    else if (state.fitMode === "page") this.fitPage(false);
    else this.applyPageLayout();
  }

  private restoreViewport(state: PreviewViewport): void {
    const page = this.pageElements.get(state.page);
    if (!page) return;
    this.viewport.scrollLeft = page.offsetLeft + state.x * page.offsetWidth - this.viewport.clientWidth / 2;
    this.viewport.scrollTop = page.offsetTop + state.y * page.offsetHeight - this.viewport.clientHeight / 2;
  }

  private scheduleViewportReport(): void {
    if (this.scrollFrame !== undefined || !this.interaction.artifact) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = undefined;
      const viewportBounds = this.viewport.getBoundingClientRect();
      const centerX = viewportBounds.left + viewportBounds.width / 2;
      const centerY = viewportBounds.top + viewportBounds.height / 2;
      let nearest: { page: number; x: number; y: number; distance: number } | undefined;
      for (const [pageIndex, element] of this.pageElements) {
        const bounds = element.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (centerX - bounds.left) / bounds.width));
        const y = Math.min(1, Math.max(0, (centerY - bounds.top) / bounds.height));
        const distance = Math.hypot(centerX - (bounds.left + bounds.width / 2), centerY - (bounds.top + bounds.height / 2));
        if (!nearest || distance < nearest.distance) nearest = { page: pageIndex, x, y, distance };
      }
      if (nearest) this.interaction.updateViewport({ page: nearest.page, x: nearest.x, y: nearest.y, zoom: this.zoom, fitMode: this.fitMode });
    });
  }

  private showIndicator(point: PreviewPagePoint | undefined): void {
    this.canvas.querySelectorAll(".typst-preview-indicator").forEach((element) => element.remove());
    if (!point) return;
    const page = this.pageElements.get(point.pageIndex);
    if (!page) return;
    const indicator = document.createElement("span");
    indicator.className = "typst-preview-indicator";
    indicator.style.left = `${point.x * 100}%`;
    indicator.style.top = `${point.y * 100}%`;
    page.append(indicator);
    indicator.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }

  private showCursor(point: PreviewPagePoint | undefined): void {
    this.canvas.querySelectorAll(".typst-preview-cursor").forEach((element) => element.remove());
    if (!point) return;
    const page = this.pageElements.get(point.pageIndex);
    if (!page) return;
    const cursor = document.createElement("span");
    cursor.className = "typst-preview-cursor";
    cursor.style.left = `${point.x * 100}%`;
    cursor.style.top = `${point.y * 100}%`;
    page.append(cursor);
  }

  private async unmapAbandonedPaths(paths: ReadonlySet<string>): Promise<void> {
    for (const path of paths) {
      if (!this.mappedPaths.has(path)) await $typst.unmapShadow(path);
    }
  }

  private showStatus(message: string, error = false, revision?: PreviewRevision, generation?: number): void {
    if (generation !== undefined && !isCurrentPreviewUpdate(generation, this.generation, Boolean(this.pending))) return;
    const status = document.createElement("div");
    status.className = error ? "typst-preview-status error" : "typst-preview-status";
    status.textContent = message;
    this.events?.status(message, error, revision);
    this.viewport.replaceChildren(status);
  }
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

function normalizeTextSelectionNode(node: SVGForeignObjectElement): void {
  const source = node.children[0] as HTMLElement;
  const normalized = node.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  normalized.setAttribute("class", "tsel");
  normalized.setAttribute("style", source.getAttribute("style")!);
  normalized.append(...[...source.childNodes].map((child) => cloneSafeSelectionChild(node, child)));
  node.replaceChildren(normalized);
}

function cloneSafeSelectionChild(node: SVGForeignObjectElement, child: ChildNode): ChildNode {
  if (child.nodeType === Node.TEXT_NODE) {
    return node.ownerDocument.createTextNode(child.textContent ?? "");
  }
  const source = child as HTMLElement;
  const span = node.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "span");
  span.append(...[...source.childNodes].map((nested) => cloneSafeSelectionChild(node, nested)));
  return span;
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
    try {
      compilerModule = await downloadWasmModule(TYPST_COMPILER_WASM_URL, "Typst 编译器 WASM", report);
    } catch {
      report("Typst 编译器 WASM 压缩传输失败，回退未压缩版本…");
      compilerModule = await downloadWasmModule(withoutDeliveryQuery(TYPST_COMPILER_WASM_URL), "Typst 编译器 WASM", report);
    }
  }
  $typst.setCompilerInitOptions({
    beforeBuild: [bundledFontsLoader, optionalMainFontsLoader],
    getModule: () => compilerModule!,
  });
  $typst.setRendererInitOptions({ getModule: () => rendererWasmUrl });
  $typst.use(TypstSnippet.withAccessModel(new MemoryAccessModel()));
  initialized = true;
}

function withoutDeliveryQuery(url: string): string {
  const fallback = new URL(url);
  fallback.searchParams.delete("delivery");
  return fallback.href;
}

async function downloadWasmModule(
  url: string,
  label: string,
  report: (message: string) => void,
): Promise<WebAssembly.Module> {
  report(`${label} 开始下载…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}下载失败：HTTP ${response.status}`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    report(`${label} 已下载 ${(bytes.byteLength / 1048576).toFixed(1)} MiB`);
    return WebAssembly.compile(bytes);
  }
  const encodedTransfer = new URL(url).searchParams.get("delivery") === "zstd-v1";
  let total = encodedTransfer ? 0 : Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let lastReported = -5;
  let lastReportedBytes = 0;
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0 && received > total) total = 0;
    const percent = total > 0 ? Math.min(99, Math.floor(received / total * 100)) : 0;
    const shouldReport = total > 0
      ? percent >= lastReported + 5
      : received - lastReportedBytes >= 1048576;
    if (shouldReport) {
      lastReported = total > 0 ? percent : lastReported;
      lastReportedBytes = received;
      report(total > 0
        ? `${label} ${percent}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB)`
        : `${label} 已下载 ${(received / 1048576).toFixed(1)} MiB`);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  report(`${label} 下载完成 ${(received / 1048576).toFixed(1)} MiB`);
  return WebAssembly.compile(bytes);
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function virtualPath(uri: string): string {
  const parsed = new URL(uri);
  return decodeURIComponent(parsed.pathname);
}
