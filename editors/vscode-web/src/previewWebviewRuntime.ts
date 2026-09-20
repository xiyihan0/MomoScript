import { createTypstRenderer, type RenderSession, type TypstRenderer } from "@myriaddreamin/typst.ts";
import { patchRoot } from "@myriaddreamin/typst.ts/dist/esm/render/svg/patch.mjs";
import { kObject } from "@myriaddreamin/typst.ts/dist/esm/internal.types.mjs";
import * as typstRendererWrapper from "@myriaddreamin/typst-ts-renderer";
import typstRendererWasmUrl from "@myriaddreamin/typst-ts-renderer/wasm?url";
import type { ExactExportFormat } from "./exactExport.ts";
import {
  parsePreviewSemanticLabel,
  type PreviewSemanticRole,
} from "./previewSemanticTarget.ts";
import {
  base64ToBytes,
  isPreviewHostToWebviewMessage,
  isComposerIntentMessage,
  type ComposerIntent,
  type ComposerStateMessage,
  type ComposerSelectionBox,
  type PreviewExactExportState as ExactExportState,
  type PreviewImageAssetMessage as ImageAssetMessage,
  type PreviewMeasurementSpan as MeasurementSpan,
  type PreviewPagePoint as PreviewPoint,
  type PreviewNavigationPoint,
  type PreviewRenderMessage as RenderMessage,
  type PreviewRenderArtifactLocation,
  type PreviewRendererFrameMessage as RendererFrameMessage,
  type PreviewRendererPageGeometry as RendererPageGeometry,
  type PreviewViewport,
  type PreviewWebviewToHostMessage,
  float32CoordinatePrecision,
} from "./previewWebviewProtocol.ts";

interface VsCodeApi {
  postMessage(message: PreviewWebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;


const vscode = acquireVsCodeApi();
const viewport = requiredElement<HTMLElement>(".viewport");
const page = requiredElement<HTMLElement>(".page");
const status = requiredElement<HTMLElement>(".status");
const zoomLabel = requiredElement<HTMLElement>(".zoom-label");
const exportControl = requiredElement<HTMLElement>(".exact-export");
const exportFormat = requiredElement<HTMLSelectElement>(".exact-export select");
const exportReady = requiredElement<HTMLButtonElement>('[data-export-action="ready"]');
const exportDisplayed = requiredElement<HTMLButtonElement>('[data-export-action="export-displayed"]');
const exportLatest = requiredElement<HTMLButtonElement>('[data-export-action="wait-for-latest"]');
const exportStale = requiredElement<HTMLElement>(".exact-export-stale");
const exportCancel = requiredElement<HTMLButtonElement>('[data-export-action="cancel"]');
const exportStatus = requiredElement<HTMLElement>(".exact-export-status");

let imageUrls = new Map<string, string>();
let zoom = 1;
let fitMode: PreviewViewport["fitMode"] = "width";
let intrinsicWidth = 0;
let intrinsicHeight = 0;
let indicatorPoint: PreviewPoint | undefined;
let cursorPoint: PreviewPoint | undefined;
let viewportFrame: number | undefined;
let viewportIdleTimer: number | undefined;
let pointerOrigin: { readonly x: number; readonly y: number } | undefined;
let pointerDragged = false;
let renderGeneration = 0;
const renderedDomGenerations = new WeakMap<SVGSVGElement, number>();

type PersistentTypstRenderer = TypstRenderer & {
  createModule(artifactContent?: Uint8Array): Promise<RenderSession>;
};

interface RuntimeRenderSession extends RenderSession {
  readonly [kObject]: { free(): void };
}

interface RendererVisualReady {
  readonly pageGeometries: readonly RendererPageGeometry[];
  readonly viewportRenderMs: number;
  readonly frameDecodeMs: number;
  readonly rendererApplyMs: number;
  readonly patchedNodes: number;
  readonly reusedNodes: number;
  readonly removedNodes: number;
  readonly pageBuffers: number;
}

interface RendererPatchMetrics {
  readonly patchedNodes: number;
  readonly reusedNodes: number;
  readonly removedNodes: number;
  readonly pageBuffers: number;
}
interface RendererWindow {
  readonly lo: { readonly x: number; readonly y: number };
  readonly hi: { readonly x: number; readonly y: number };
}

const MAX_RENDERER_PAGE_BUFFERS = 8;
const MAX_RENDERER_REPLAY_FRAMES = 64;
const MAX_RENDERER_REPLAY_BYTES = 128 * 1024 * 1024;
interface RendererImageSource {
  readonly href: string | null;
  readonly xlinkHref: string | null;
  readonly source: string;
  readonly digest: string;
}

let rendererImageSources = new WeakMap<SVGImageElement, RendererImageSource>();
let rendererHiddenGroups = new Map<SVGElement, RendererHiddenGroup>();

class PersistentPreviewRenderer {
  readonly #rendererReady: Promise<PersistentTypstRenderer>;
  #session: RenderSession | undefined;
  #root: SVGSVGElement | undefined;
  #sessionId: string | undefined;
  #pageGeometries: readonly RendererPageGeometry[] = [];
  #committedGeneration = 0;
  #backendGeneration = 0;
  #disposed = false;
  #tail = Promise.resolve();
  #viewportRenderQueued = false;
  #requestedPaddingScreens = 0;
  #framePayloads: Uint8Array[] = [];
  #framePayloadBytes = 0;
  #renderedWindow: RendererWindow | undefined;
  #replaceRootResources = false;
  constructor() {
    this.#rendererReady = this.#initialize();
  }

  get pageGeometries(): readonly RendererPageGeometry[] {
    return this.#pageGeometries;
  }

  get requiresResync(): boolean {
    return this.#framePayloads.length >= MAX_RENDERER_REPLAY_FRAMES
      || this.#framePayloadBytes >= MAX_RENDERER_REPLAY_BYTES;
  }

  apply(message: RendererFrameMessage): Promise<RendererVisualReady> {
    const operation = this.#tail.then(() => this.#apply(message));
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  flush(): Promise<void> {
    return this.#tail;
  }

  viewportChanged(): void {
    if (!this.#session || !this.#root) return;
    this.#enqueueViewportRender(1);
  }

  viewportSettled(): void {
    if (!this.#session || !this.#root) return;
    this.#enqueueViewportRender(5);
  }


  reset(): Promise<void> {
    const operation = this.#tail.then(() => this.#resetNow());
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #resetNow(): void {
    this.#framePayloads = [];
    this.#framePayloadBytes = 0;
    this.#renderedWindow = undefined;
    this.#requestedPaddingScreens = 0;
    this.#viewportRenderQueued = false;
    this.#replaceRootResources = false;
    this.#root?.remove();
    clearImageUrls();
    this.#root = undefined;
    rendererImageSources = new WeakMap();
    rendererHiddenGroups = new Map();
    const session = this.#session;
    this.#session = undefined;
    if (session) (session as RuntimeRenderSession)[kObject].free();
    this.#sessionId = undefined;
    this.#pageGeometries = [];
    this.#committedGeneration = 0;
    this.#backendGeneration = 0;
  }
  #resetSessionForFullFrame(): void {
    this.#framePayloads = [];
    this.#framePayloadBytes = 0;
    this.#renderedWindow = undefined;
    this.#requestedPaddingScreens = 0;
    this.#viewportRenderQueued = false;
    this.#replaceRootResources = Boolean(this.#root);
    const session = this.#session;
    this.#session = undefined;
    if (session) (session as RuntimeRenderSession)[kObject].free();
    this.#sessionId = undefined;
    this.#pageGeometries = [];
    this.#committedGeneration = 0;
    this.#backendGeneration = 0;
  }


  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resetNow();
  }

  async #initialize(): Promise<PersistentTypstRenderer> {
    const renderer = createTypstRenderer() as PersistentTypstRenderer;
    await renderer.init({
      getWrapper: async () => typstRendererWrapper,
      getModule: async () => {
        const response = await fetch(new URL(typstRendererWasmUrl, location.href));
        if (!response.ok) throw new Error(`Typst renderer WASM download failed: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
    if (this.#disposed) throw new Error("Preview renderer was disposed during initialization");
    return renderer;
  }

  async #apply(message: RendererFrameMessage): Promise<RendererVisualReady> {
    if (this.#disposed) throw new Error("Preview renderer is disposed");
    if (!Number.isSafeInteger(message.rendererGeneration) || message.rendererGeneration <= 0
      || !Number.isSafeInteger(message.baseGeneration) || message.baseGeneration < 0) {
      throw new Error("Preview renderer frame has invalid generation metadata");
    }
    if (typeof message.sessionId !== "string" || message.sessionId.length === 0
      || !Number.isSafeInteger(message.backendGeneration) || message.backendGeneration <= 0) {
      throw new Error("Preview renderer frame has invalid session identity");
    }
    if (message.frameKind === "diff-v1" && this.#sessionId !== message.sessionId) {
      throw new Error("Preview renderer session changed without a full frame");
    }
    const expectedBase = message.frameKind === "new" ? 0 : this.#committedGeneration;
    if (message.baseGeneration !== expectedBase) {
      throw new Error(`Preview renderer frame base ${message.baseGeneration} does not match ${expectedBase}`);
    }
    if (this.#backendGeneration !== 0 && this.#backendGeneration !== message.backendGeneration
      && message.frameKind !== "new") {
      throw new Error("Preview renderer backend changed without a full frame");
    }
    if (!Number.isSafeInteger(message.byteLength) || message.byteLength <= 0 || message.byteLength > 256 * 1024 * 1024) {
      throw new Error("Preview renderer frame byte length is invalid");
    }
    const decodeStarted = performance.now();
    const bytes = base64ToBytes(message.dataBase64);
    if (bytes.byteLength !== message.byteLength) throw new Error("Preview renderer frame byte length mismatch");
    if (await sha256Hex(bytes) !== message.artifactDigest) throw new Error("Preview renderer frame digest mismatch");
    const prefix = message.frameKind === "new" ? "new," : "diff-v1,";
    if (new TextDecoder().decode(bytes.subarray(0, prefix.length)) !== prefix) {
      throw new Error("Preview renderer frame prefix mismatch");
    }
    const payload = bytes.subarray(prefix.length);
    const frameDecodeMs = performance.now() - decodeStarted;
    if (message.frameKind === "new") this.#resetSessionForFullFrame();
    const renderer = await this.#rendererReady;
    const rendererApplyStarted = performance.now();
    if (!this.#session) {
      if (message.frameKind !== "new") throw new Error("Preview renderer incremental frame has no consumer base");
      this.#session = await renderer.createModule();
      this.#session.reset();
    }
    this.#session.manipulateData({ action: "merge", data: payload });
    const retainedPayload = payload.slice();
    this.#framePayloads.push(retainedPayload);
    this.#framePayloadBytes += retainedPayload.byteLength;
    let offsetY = 0;
    const pageGeometries = this.#session.retrievePagesInfo().map((info, pageIndex) => {
      // SVG page bounds use integral extents. A temporary fractional container can
      // clamp bottom scroll before the rendered page metadata is adopted.
      const width = Math.ceil(Math.fround(info.width));
      const height = Math.ceil(Math.fround(info.height));
      const geometry = Object.freeze({ pageIndex, offsetY, width, height });
      offsetY += height;
      return geometry;
    });
    if (pageGeometries.length === 0) throw new Error("Preview renderer produced no pages");
    if (pageGeometries.some((geometry) => !Number.isFinite(geometry.width) || geometry.width <= 0
      || !Number.isFinite(geometry.height) || geometry.height <= 0)) {
      throw new Error("Preview renderer produced invalid page geometry");
    }
    this.#pageGeometries = Object.freeze(pageGeometries);
    intrinsicWidth = Math.max(...pageGeometries.map((geometry) => geometry.width));
    intrinsicHeight = offsetY;
    if (fitMode === "width") {
      zoom = (Math.max(viewport.clientWidth, window.innerWidth) - 48) / intrinsicWidth;
    } else if (fitMode === "page") {
      zoom = Math.min(
        (Math.max(viewport.clientWidth, window.innerWidth) - 48) / intrinsicWidth,
        (Math.max(viewport.clientHeight, window.innerHeight - 43) - 48) / intrinsicHeight,
      );
    }
    zoom = Math.round(Math.min(5, Math.max(0.1, zoom)) * 100) / 100;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    page.style.width = `${intrinsicWidth * zoom}px`;
    page.style.height = `${intrinsicHeight * zoom}px`;
    page.dataset.intrinsicWidth = String(intrinsicWidth);
    page.dataset.intrinsicHeight = String(intrinsicHeight);
    const rendererApplyMs = performance.now() - rendererApplyStarted;
    const viewportStarted = performance.now();
    const metrics = await this.#renderVisibleWindow(1, true);
    this.#adoptRenderedPageGeometries();
    this.#sessionId = message.sessionId;
    this.#committedGeneration = message.rendererGeneration;
    this.#backendGeneration = message.backendGeneration;
    return Object.freeze({
      pageGeometries: this.#pageGeometries,
      frameDecodeMs,
      rendererApplyMs,
      viewportRenderMs: performance.now() - viewportStarted,
      ...metrics,
    });
  }
  #adoptRenderedPageGeometries(): void {
    if (!this.#root) return;
    const renderedPages = rendererPages(this.#root);
    if (renderedPages.length !== this.#pageGeometries.length) return;
    const canonical = renderedPages.map((renderedPage) => {
      if (!(renderedPage instanceof SVGGraphicsElement) || renderedPage.transform.baseVal.numberOfItems !== 1) return undefined;
      const { a, b, c, d, e, f } = renderedPage.transform.baseVal.getItem(0).matrix;
      if (a !== 1 || b !== 0 || c !== 0 || d !== 1 || e !== 0 || !Number.isFinite(f) || f < 0) return undefined;
      const width = Number(renderedPage.getAttribute("data-page-width"));
      const height = Number(renderedPage.getAttribute("data-page-height"));
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return undefined;
      return { pageIndex: 0, offsetY: f, width, height };
    });
    if (!canonical.length || !canonical.every((geometry) => geometry !== undefined)) return;
    // SVG reuse preserves node identity, not DOM order. Native text geometry
    // addresses physical pages, including differently sized offscreen pages.
    canonical.sort((left, right) => left.offsetY - right.offsetY);
    for (let pageIndex = 0; pageIndex < canonical.length; pageIndex += 1) {
      canonical[pageIndex].pageIndex = pageIndex;
      Object.freeze(canonical[pageIndex]);
    }
    this.#pageGeometries = Object.freeze(canonical);
    intrinsicWidth = Math.max(...this.#pageGeometries.map((geometry) => geometry.width));
    const lastPage = canonical[canonical.length - 1];
    intrinsicHeight = lastPage.offsetY + lastPage.height;
    page.style.width = `${intrinsicWidth * zoom}px`;
    page.style.height = `${intrinsicHeight * zoom}px`;
    page.dataset.intrinsicWidth = String(intrinsicWidth);
    page.dataset.intrinsicHeight = String(intrinsicHeight);
  }



  async #rebaseRendererSession(): Promise<void> {
    if (!this.#session) throw new Error("Preview renderer session is unavailable");
    const renderer = await this.#rendererReady;
    const replacement = await renderer.createModule();
    replacement.reset();
    try {
      for (const payload of this.#framePayloads) {
        replacement.manipulateData({ action: "merge", data: payload });
      }
    } catch (error) {
      (replacement as RuntimeRenderSession)[kObject].free();
      throw error;
    }
    const previous = this.#session;
    this.#session = replacement;
    this.#renderedWindow = undefined;
    (previous as RuntimeRenderSession)[kObject].free();
  }

  #enqueueViewportRender(paddingScreens: number): void {
    this.#requestedPaddingScreens = Math.max(this.#requestedPaddingScreens, paddingScreens);
    if (this.#viewportRenderQueued) return;
    this.#viewportRenderQueued = true;
    const operation = this.#tail.then(async () => {
      this.#viewportRenderQueued = false;
      const requested = this.#requestedPaddingScreens;
      this.#requestedPaddingScreens = 0;
      if (!this.#session || !this.#root || this.#disposed) return;
      const requiredWindow = this.#boundedWindow(requested >= 5 ? requested : 0);
      if (this.#renderedWindow && rendererWindowContains(this.#renderedWindow, requiredWindow)) {
        synchronizeRendererTextSelectionLayers(this.#root, this.#boundedWindow(0));
        return;
      }
      await this.#renderVisibleWindow(requested);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    void operation.catch((error: unknown) => showStatus(
      `Viewport render failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }

  async #renderVisibleWindow(
    paddingScreens: number,
    preserveCoveredWindow = false,
  ): Promise<RendererPatchMetrics> {
    if (!this.#session) throw new Error("Preview renderer session is unavailable");
    const requestedWindow = this.#boundedWindow(paddingScreens);
    const visibleWindow = this.#boundedWindow(0);
    const windowRect = preserveCoveredWindow && this.#renderedWindow
      && rendererWindowContains(this.#renderedWindow, visibleWindow)
      ? this.#renderedWindow
      : requestedWindow;
    const textWindow = this.#boundedWindow(0);
    const windowRebased = Boolean(this.#renderedWindow && !rendererWindowsEqual(this.#renderedWindow, windowRect));
    if (windowRebased) await this.#rebaseRendererSession();
    if (!this.#session) throw new Error("Preview renderer rebase lost its session");
    const patch = this.#session.renderSvgDiff({ window: windowRect });
    const parsed = document.createElement("template");
    parsed.innerHTML = patch;
    const next = parsed.content.firstElementChild;
    if (!(next instanceof SVGSVGElement)) throw new Error("Preview renderer did not return an SVG patch root");
    next.classList.add("typst-renderer-root");
    if (this.#root) restoreRendererPresentationMutations(this.#root);
    const replaceRootResources = this.#replaceRootResources || windowRebased;
    if (replaceRootResources && this.#root) {
      synchronizeRendererResourceHeaders(this.#root, next);
      markExactRendererReuse(this.#root, next);
    }
    const previousNodeIds = this.#root ? rendererNodeIds(this.#root) : new Set<string>();
    const nextNodes = rendererPatchNodes(next);
    let reusedNodes = 0;
    let patchedNodes = 0;
    for (const nextNode of nextNodes) {
      const reuseFrom = nextNode.getAttribute("data-reuse-from");
      if (reuseFrom && previousNodeIds.has(reuseFrom)) reusedNodes += 1;
      else patchedNodes += 1;
    }
    if (this.#root) patchRoot(this.#root, next);
    else {
      page.replaceChildren(next);
      this.#root = next;
    }
    ensureRendererPageBackgrounds(this.#root);
    synchronizeRendererTextSelectionLayers(this.#root, textWindow);
    await materializeRendererImageUrls(this.#root);
    const currentNodeIds = rendererNodeIds(this.#root);
    const removedNodes = [...previousNodeIds].filter((id) => !currentNodeIds.has(id)).length;
    const pageBuffers = rendererPages(this.#root)
      .filter((element) => !element.hasAttribute("data-dummy") && element.childElementCount > 0)
      .length;
    if (pageBuffers > MAX_RENDERER_PAGE_BUFFERS) {
      throw new Error(`Preview renderer retained ${pageBuffers} page buffers; limit is ${MAX_RENDERER_PAGE_BUFFERS}`);
    }
    this.#renderedWindow = windowRect;
    this.#replaceRootResources = false;
    return Object.freeze({ patchedNodes, reusedNodes, removedNodes, pageBuffers });
  }

  #boundedWindow(paddingScreens: number): RendererWindow {
    const viewportBounds = viewport.getBoundingClientRect();
    const pageBounds = page.getBoundingClientRect();
    const viewportWidth = Math.max(viewportBounds.width, viewport.clientWidth, window.innerWidth);
    const viewportHeight = Math.max(viewportBounds.height, viewport.clientHeight, window.innerHeight - 43);
    const visibleLeft = pageBounds.width > 0 ? (viewportBounds.left - pageBounds.left) / zoom : 0;
    const visibleTop = pageBounds.height > 0 ? (viewportBounds.top - pageBounds.top) / zoom : 0;
    const visibleWidth = viewportWidth / zoom;
    const visibleHeight = viewportHeight / zoom;
    let loX = Math.max(0, visibleLeft - visibleWidth * paddingScreens);
    let hiX = Math.min(intrinsicWidth, visibleLeft + visibleWidth * (paddingScreens + 1));
    let loY = Math.max(0, visibleTop - visibleHeight * paddingScreens);
    let hiY = Math.min(intrinsicHeight, visibleTop + visibleHeight * (paddingScreens + 1));
    if (!(hiX > loX)) [loX, hiX] = [0, intrinsicWidth];
    if (!(hiY > loY)) [loY, hiY] = [0, Math.min(intrinsicHeight, visibleHeight * 2)];
    const intersecting = this.#pageGeometries.filter((geometry) => (
      geometry.offsetY < hiY && geometry.offsetY + geometry.height > loY
    ));
    if (intersecting.length > MAX_RENDERER_PAGE_BUFFERS) {
      const visibleCenter = Math.min(intrinsicHeight, Math.max(0, visibleTop + visibleHeight / 2));
      const centerIndex = intersecting.findIndex((geometry) => (
        visibleCenter >= geometry.offsetY && visibleCenter < geometry.offsetY + geometry.height
      ));
      const pivot = centerIndex < 0 ? Math.floor(intersecting.length / 2) : centerIndex;
      const start = Math.min(
        intersecting.length - MAX_RENDERER_PAGE_BUFFERS,
        Math.max(0, pivot - Math.floor(MAX_RENDERER_PAGE_BUFFERS / 2)),
      );
      const selected = intersecting.slice(start, start + MAX_RENDERER_PAGE_BUFFERS);
      loY = Math.max(loY, selected[0].offsetY + 0.01);
      const last = selected[selected.length - 1];
      hiY = Math.min(hiY, last.offsetY + last.height - 0.01);
    }
    return { lo: { x: loX, y: loY }, hi: { x: hiX, y: hiY } };
  }
}

const persistentRenderer = new PersistentPreviewRenderer();

function rendererPages(root: SVGSVGElement): SVGElement[] {
  return [...root.children].filter((element): element is SVGElement => (
    element instanceof SVGElement && element.classList.contains("typst-page")
  ));
}

function ensureRendererPageBackgrounds(root: SVGSVGElement): void {
  for (const renderedPage of rendererPages(root)) {
    if (renderedPage.querySelector(":scope > rect[data-preview-page-background='true']")) continue;
    const width = Number(renderedPage.getAttribute("data-page-width"));
    const height = Number(renderedPage.getAttribute("data-page-height"));
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error("Preview renderer page background has invalid geometry");
    }
    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("width", String(width));
    background.setAttribute("height", String(height));
    background.setAttribute("fill", "white");
    background.setAttribute("data-preview-page-background", "true");
    renderedPage.prepend(background);
  }
}

function rendererWindowsEqual(left: RendererWindow, right: RendererWindow): boolean {
  return Math.abs(left.lo.x - right.lo.x) <= 0.01
    && Math.abs(left.lo.y - right.lo.y) <= 0.01
    && Math.abs(left.hi.x - right.hi.x) <= 0.01
    && Math.abs(left.hi.y - right.hi.y) <= 0.01;
}

function rendererWindowContains(outer: RendererWindow, inner: RendererWindow): boolean {
  return outer.lo.x <= inner.lo.x + 0.01
    && outer.lo.y <= inner.lo.y + 0.01
    && outer.hi.x + 0.01 >= inner.hi.x
    && outer.hi.y + 0.01 >= inner.hi.y;
}

function synchronizeRendererResourceHeaders(previous: SVGSVGElement, next: SVGSVGElement): void {
  const headerCount = Math.min(3, previous.children.length, next.children.length);
  for (let index = 0; index < headerCount; index += 1) {
    const previousHeader = previous.children[index];
    const nextHeader = next.children[index];
    previousHeader.replaceWith(nextHeader.cloneNode(true));
    if (nextHeader.localName === "defs") nextHeader.replaceChildren();
    else if (nextHeader.localName === "style") nextHeader.setAttribute("data-reuse", "1");
  }
}

function markExactRendererReuse(previous: SVGSVGElement, next: SVGSVGElement): void {
  const previousChildren = new Set([...previous.children]
    .filter((child): child is SVGElement => child instanceof SVGElement && child.localName === "g")
    .flatMap((child) => {
      const id = child.getAttribute("data-tid");
      return id ? [id] : [];
    }));
  for (const nextChild of [...next.children]) {
    if (!(nextChild instanceof SVGElement) || nextChild.localName !== "g") continue;
    const id = nextChild.getAttribute("data-tid");
    if (id && previousChildren.has(id)) nextChild.setAttribute("data-reuse-from", id);
  }
}


function rendererPatchNodes(root: SVGSVGElement): SVGElement[] {
  const descendants = [...root.querySelectorAll<SVGElement>("[data-tid]")];
  if (root.hasAttribute("data-tid")) descendants.unshift(root);
  return descendants.filter((element) => !element.hasAttribute("data-dummy"));
}

function rendererNodeIds(root: SVGSVGElement): Set<string> {
  return new Set(rendererPatchNodes(root)
    .map((element) => element.getAttribute("data-tid"))
    .filter((id): id is string => Boolean(id)));
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Preview Webview is missing '${selector}'`);
  return element;
}


async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer;
  const source = buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength
    ? buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function applyZoom(nextZoom: number, nextFitMode: PreviewViewport["fitMode"], notify = true): void {
  if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return;
  const boundedZoom = Math.round(Math.min(5, Math.max(0.1, nextZoom)) * 100) / 100;
  const width = `${intrinsicWidth * boundedZoom}px`;
  const height = `${intrinsicHeight * boundedZoom}px`;
  const layoutChanged = zoom !== boundedZoom || page.style.width !== width || page.style.height !== height;
  zoom = boundedZoom;
  fitMode = nextFitMode;
  page.style.width = width;
  page.style.height = height;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  showOverlay("preview-indicator", indicatorPoint);
  showOverlay("preview-cursor", cursorPoint);
  composerInput.layout();
  if (layoutChanged && page.querySelector(".typst-renderer-root")) persistentRenderer.viewportChanged();
  if (notify) reportViewport();
}

function applyZoomAroundPoint(
  nextZoom: number,
  nextFitMode: PreviewViewport["fitMode"],
  clientX: number,
  clientY: number,
  notify = true,
): void {
  const bounds = page.getBoundingClientRect();
  if (!(bounds.width > 0) || !(bounds.height > 0)) return;
  const anchorX = (clientX - bounds.left) / bounds.width;
  const anchorY = (clientY - bounds.top) / bounds.height;
  applyZoom(nextZoom, nextFitMode, false);
  const resized = page.getBoundingClientRect();
  viewport.scrollLeft += resized.left + anchorX * resized.width - clientX;
  viewport.scrollTop += resized.top + anchorY * resized.height - clientY;
  if (notify) reportViewport();
}

function applyZoomAtViewportCenter(nextZoom: number): void {
  const bounds = viewport.getBoundingClientRect();
  applyZoomAroundPoint(
    nextZoom,
    "manual",
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
}

function fitWidth(notify = true): void {
  if (!(intrinsicWidth > 0)) return;
  applyZoom((viewport.clientWidth - 48) / intrinsicWidth, "width", notify);
}

function fitPage(notify = true): void {
  if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return;
  applyZoom(Math.min((viewport.clientWidth - 48) / intrinsicWidth, (viewport.clientHeight - 48) / intrinsicHeight), "page", notify);
}

function currentPageGeometries(): readonly RendererPageGeometry[] {
  const rendererGeometries = persistentRenderer.pageGeometries;
  if (rendererGeometries.length > 0) return rendererGeometries;
  return intrinsicWidth > 0 && intrinsicHeight > 0
    ? [{ pageIndex: 0, offsetY: 0, width: intrinsicWidth, height: intrinsicHeight }]
    : [];
}

function snapIntoBounds(
  bounds: DOMRect,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number } | undefined {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return undefined;
  const insetX = Math.min(1, bounds.width / 2);
  const insetY = Math.min(1, bounds.height / 2);
  return {
    x: Math.min(Math.max(clientX, bounds.left + insetX), bounds.right - insetX),
    y: Math.min(Math.max(clientY, bounds.top + insetY), bounds.bottom - insetY),
  };
}

function renderedTextBounds(element: Element): DOMRect {
  return element.querySelector<HTMLElement>(".tsel")?.getBoundingClientRect()
    ?? element.getBoundingClientRect();
}

function snapIntoTextGlyphs(
  element: Element,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number } | undefined {
  const glyphs = element.querySelectorAll("use");
  if (glyphs.length === 0) {
    return snapIntoBounds(renderedTextBounds(element), clientX, clientY);
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const glyph of glyphs) {
    const rect = glyph.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left) || right - left < 2 || bottom - top < 2) {
    return snapIntoBounds(renderedTextBounds(element), clientX, clientY);
  }
  return {
    x: Math.min(Math.max(clientX, left + 1), right - 1),
    y: Math.min(Math.max(clientY, top + 1), bottom - 1),
  };
}
function renderedTextAnchor(
  element: Element,
): { readonly x: number; readonly y: number } | undefined {
  const bounds = renderedTextBounds(element);
  if (!(bounds.width > 0) || !(bounds.height > 0)) return undefined;
  return snapIntoTextGlyphs(
    element,
    (bounds.left + bounds.right) / 2,
    (bounds.top + bounds.bottom) / 2,
  );
}


function renderedTextNavigationHint(
  element: Element,
  clientX: number,
): Pick<PreviewNavigationPoint, "text" | "textOffset"> | undefined {
  const selectable = element.querySelector<HTMLElement>(".tsel");
  const text = selectable?.textContent ?? "";
  if (!text) return undefined;
  const offsets: number[] = [];
  let utf16Offset = 0;
  for (const character of text) {
    offsets.push(utf16Offset);
    utf16Offset += character.length;
  }
  const glyphs = [...element.querySelectorAll<SVGGraphicsElement>(":scope > use")]
    .map((glyph) => glyph.getBoundingClientRect())
    .filter((bounds) => bounds.width > 0 && bounds.height > 0);
  if (glyphs.length === offsets.length) {
    for (let index = 0; index < glyphs.length; index += 1) {
      const bounds = glyphs[index]!;
      if (clientX <= (bounds.left + bounds.right) / 2) {
        return { text, textOffset: offsets[index]! };
      }
    }
    return { text, textOffset: offsets.at(-1)! };
  }
  const bounds = element.getBoundingClientRect();
  if (!(bounds.width > 0)) return undefined;
  const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  const index = Math.min(offsets.length - 1, Math.round(ratio * offsets.length));
  return { text, textOffset: offsets[index]! };
}
const SEMANTIC_TEXT_ROLE_PRIORITY: Record<PreviewSemanticRole, readonly PreviewSemanticRole[]> = {
  bubble: ["bubble", "display-name"],
  avatar: ["bubble", "display-name"],
  "display-name": ["bubble", "display-name"],
  narration: ["narration"],
  reply: ["reply-item", "reply"],
  "reply-item": ["reply-item", "reply"],
  bond: ["bond-body", "bond"],
  "bond-body": ["bond-body", "bond"],
};


interface SemanticTextResolution {
  readonly recognized: boolean;
  readonly text: Element | null;
  readonly blocksDirectText: boolean;
}

function activateRenderedDomGeneration(root: SVGSVGElement, generation: number): void {
  renderedDomGenerations.set(root, generation);
}

function renderedDomIsActive(root: Element): root is SVGSVGElement {
  return root instanceof SVGSVGElement
    && root.isConnected
    && page.contains(root)
    && renderedDomGenerations.get(root) === renderGeneration;
}

function nearestRenderedTextForSemanticTarget(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): SemanticTextResolution {
  const element = target instanceof Element ? target : null;
  const labelled = element?.closest("[data-typst-label]") ?? null;
  if (!labelled) return { recognized: false, text: null, blocksDirectText: false };
  const semanticTarget = parsePreviewSemanticLabel(labelled.getAttribute("data-typst-label") ?? "");
  const root = labelled.closest("svg");
  if (!semanticTarget || !root) {
    return { recognized: true, text: null, blocksDirectText: false };
  }
  if (!renderedDomIsActive(root)) {
    return { recognized: true, text: null, blocksDirectText: true };
  }

  for (const preferredRole of SEMANTIC_TEXT_ROLE_PRIORITY[semanticTarget.role]) {
    const candidates = new Set<Element>();
    for (const group of root.querySelectorAll("[data-typst-label]")) {
      const candidateTarget = parsePreviewSemanticLabel(group.getAttribute("data-typst-label") ?? "");
      if (
        candidateTarget?.token !== semanticTarget.token
        || candidateTarget.role !== preferredRole
      ) {
        continue;
      }
      for (const text of group.querySelectorAll(".typst-text")) {
        const bounds = text.getBoundingClientRect();
        if (
          bounds.width > 0
          && bounds.height > 0
          && renderedTextAnchor(text)
        ) {
          candidates.add(text);
        }
      }
    }
    let nearest: Element | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = squaredDistanceToBounds(candidate.getBoundingClientRect(), clientX, clientY);
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    if (nearest) return { recognized: true, text: nearest, blocksDirectText: false };
  }
  return { recognized: true, text: null, blocksDirectText: false };
}

function nearestRenderedTextInOwningGroup(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): Element | null {
  const element = target instanceof Element ? target : null;
  const direct = element?.closest(".typst-text") ?? null;
  if (direct) return direct;

  let ancestor = element?.parentElement ?? null;
  while (ancestor && ancestor !== page) {
    if (ancestor.tagName.toLowerCase() === "svg") return null;
    if (ancestor.tagName.toLowerCase() === "g") {
      const candidates = [...ancestor.querySelectorAll(".typst-text")]
        .filter((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        });
      if (candidates.length > 0) {
        return candidates.reduce((nearest, candidate) => {
          const distance = squaredDistanceToBounds(candidate.getBoundingClientRect(), clientX, clientY);
          const nearestDistance = squaredDistanceToBounds(nearest.getBoundingClientRect(), clientX, clientY);
          return distance < nearestDistance ? candidate : nearest;
        });
      }
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function squaredDistanceToBounds(
  bounds: DOMRect,
  clientX: number,
  clientY: number,
): number {
  const dx = clientX < bounds.left
    ? bounds.left - clientX
    : clientX > bounds.right ? clientX - bounds.right : 0;
  const dy = clientY < bounds.top
    ? bounds.top - clientY
    : clientY > bounds.bottom ? clientY - bounds.bottom : 0;
  return dx * dx + dy * dy;
}


function previewNavigationPointAtClientCoordinates(
  clientX: number,
  clientY: number,
  target: EventTarget | null,
  requireRenderedPageHit: boolean,
  snapToOwningGroup: boolean,
): PreviewNavigationPoint | undefined {
  const bounds = page.getBoundingClientRect();
  if (!(bounds.width > 0) || !(bounds.height > 0)) return undefined;
  const directText = (target as Element | null)?.closest?.(".typst-text") ?? null;
  const semanticResolution = snapToOwningGroup
    ? nearestRenderedTextForSemanticTarget(target, clientX, clientY)
    : { recognized: false, text: null, blocksDirectText: false };
  if (
    semanticResolution.recognized
    && !semanticResolution.text
    && (!directText || semanticResolution.blocksDirectText)
  ) {
    return undefined;
  }
  const textElement = directText ?? (
    snapToOwningGroup
      ? semanticResolution.text
        ?? nearestRenderedTextInOwningGroup(target, clientX, clientY)
      : null
  );
  const snapped = textElement
    ? directText
      ? snapIntoTextGlyphs(textElement, clientX, clientY)
      : renderedTextAnchor(textElement)
    : undefined;
  if (snapped) {
    clientX = snapped.x;
    clientY = snapped.y;
  }
  const documentX = (clientX - bounds.left) / zoom;
  const documentY = (clientY - bounds.top) / zoom;
  if (requireRenderedPageHit) {
    if (!page.firstElementChild || !Number.isFinite(documentX) || !Number.isFinite(documentY)) return undefined;
    const insidePage = currentPageGeometries().some((geometry) => (
      documentX >= 0
      && documentX < geometry.width
      && documentY >= geometry.offsetY
      && documentY < geometry.offsetY + geometry.height
    ));
    if (!insidePage) return undefined;
  }
  const point = previewPointAtDocumentCoordinates(documentX, documentY);
  if (!point) return undefined;
  return {
    ...point,
    ...(textElement ? renderedTextNavigationHint(textElement, clientX) : undefined),
  };
}

function previewPointAtDocumentCoordinates(x: number, y: number): PreviewPoint | undefined {
  const geometries = currentPageGeometries();
  const geometry = geometries.find((candidate) => y >= candidate.offsetY && y < candidate.offsetY + candidate.height)
    ?? geometries.at(-1);
  if (!geometry) return undefined;
  return {
    pageIndex: geometry.pageIndex,
    x: Math.min(1, Math.max(0, x / geometry.width)),
    y: Math.min(1, Math.max(0, (y - geometry.offsetY) / geometry.height)),
  };
}
function documentCoordinatesForPoint(point: PreviewPoint): { readonly x: number; readonly y: number } | undefined {
  const geometry = currentPageGeometries()[point.pageIndex];
  if (!geometry) return undefined;
  return {
    x: Math.min(1, Math.max(0, point.x)) * geometry.width,
    y: geometry.offsetY + Math.min(1, Math.max(0, point.y)) * geometry.height,
  };
}

function reportViewport(): void {
  const viewportBounds = viewport.getBoundingClientRect();
  const pageBounds = page.getBoundingClientRect();
  if (!(pageBounds.width > 0) || !(pageBounds.height > 0)) return;
  const point = previewPointAtDocumentCoordinates(
    (viewportBounds.left + viewportBounds.width / 2 - pageBounds.left) / zoom,
    (viewportBounds.top + viewportBounds.height / 2 - pageBounds.top) / zoom,
  );
  if (point) vscode.postMessage({
    type: "viewport",
    viewport: { page: point.pageIndex, x: point.x, y: point.y, zoom, fitMode } satisfies PreviewViewport,
  });
}

async function restoreViewport(state: PreviewViewport | undefined, canRestore: () => boolean = () => true): Promise<void> {
  if (!state || !canRestore()) {
    await persistentRenderer.flush();
    return;
  }
  if (state.fitMode === "width") fitWidth(false);
  else if (state.fitMode === "page") fitPage(false);
  else applyZoom(state.zoom, "manual", false);
  await new Promise<void>((resolve) => requestAnimationFrame(() => {
    const target = documentCoordinatesForPoint({ pageIndex: state.page, x: state.x, y: state.y });
    if (target && canRestore()) {
      const viewportBounds = viewport.getBoundingClientRect();
      const pageBounds = page.getBoundingClientRect();
      composerInput.scrollPresentation(
        pageBounds.left + target.x * zoom - (viewportBounds.left + viewportBounds.width / 2),
        pageBounds.top + target.y * zoom - (viewportBounds.top + viewportBounds.height / 2),
      );
      persistentRenderer.viewportChanged();
    }
    resolve();
  }));
  await persistentRenderer.flush();
}

async function waitForVisualPaint(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function showOverlay(className: "preview-indicator" | "preview-cursor", point: PreviewPoint | undefined): void {
  if (className === "preview-indicator") indicatorPoint = point;
  else cursorPoint = point;
  page.querySelector(`.${className}`)?.remove();
  if (!point) return;
  const target = documentCoordinatesForPoint(point);
  if (!target) return;
  const overlay = document.createElement("span");
  overlay.className = className;
  overlay.style.left = `${target.x * zoom}px`;
  overlay.style.top = `${target.y * zoom}px`;
  page.append(overlay);
}

function materializeImageUrls(assets: readonly ImageAssetMessage[]): Map<string, string> {
  const staged = new Map<string, string>();
  for (const asset of assets) {
    if (staged.has(asset.digest)) continue;
    const committed = imageUrls.get(asset.digest);
    if (committed) {
      staged.set(asset.digest, committed);
      continue;
    }
    const bytes = base64ToBytes(asset.dataBase64);
    staged.set(asset.digest, URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: asset.mimeType })));
  }
  return staged;
}

const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

function restoreRendererPresentationMutations(root: ParentNode): void {
  restoreRendererHiddenGroups();
  for (const image of root.querySelectorAll<SVGImageElement>("image")) {
    const source = rendererImageSources.get(image);
    if (!source) continue;
    if (source.href === null) image.removeAttribute("href");
    else image.setAttribute("href", source.href);
    if (source.xlinkHref === null) image.removeAttributeNS(XLINK_NAMESPACE, "href");
    else image.setAttributeNS(XLINK_NAMESPACE, "xlink:href", source.xlinkHref);
  }
}

function synchronizeRendererTextSelectionLayers(
  root: SVGSVGElement,
  windowRect: RendererWindow,
): void {
  for (const [group, hidden] of [...rendererHiddenGroups]) {
    if (!group.isConnected) {
      rendererHiddenGroups.delete(group);
      continue;
    }
    if (rendererBoundsIntersect(hidden.bounds, windowRect)) restoreRendererHiddenGroup(group);
  }
  const groupBounds = new Map<SVGElement, RendererBounds>();
  for (const node of root.querySelectorAll("foreignObject")) {
    if (!(node instanceof SVGForeignObjectElement)) continue;
    const current = node.children[0];
    if (!(current instanceof HTMLElement) || !current.classList.contains("tsel")) continue;
    const bounds = rendererDocumentBounds(node, root);
    const group = rendererWindowGroup(node, root);
    if (group && bounds) groupBounds.set(group, rendererBoundsUnion(groupBounds.get(group), bounds));
  }
  for (const [group, bounds] of groupBounds) {
    if (rendererBoundsIntersect(bounds, windowRect)
      || rendererHiddenGroups.has(group)
      || group.querySelector("image")) continue;
    const fragment = document.createDocumentFragment();
    fragment.append(...[...group.childNodes]);
    group.setAttribute("data-mmt-window-hidden", "");
    rendererHiddenGroups.set(group, { fragment, bounds });
  }
}

interface RendererBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface RendererHiddenGroup {
  readonly fragment: DocumentFragment;
  readonly bounds: RendererBounds;
}

function rendererBoundsIntersect(bounds: RendererBounds, windowRect: RendererWindow): boolean {
  return bounds.right >= windowRect.lo.x
    && bounds.left <= windowRect.hi.x
    && bounds.bottom >= windowRect.lo.y
    && bounds.top <= windowRect.hi.y;
}

function rendererBoundsUnion(left: RendererBounds | undefined, right: RendererBounds): RendererBounds {
  if (!left) return right;
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  };
}

function rendererWindowGroup(node: SVGForeignObjectElement, root: SVGSVGElement): SVGElement | undefined {
  const pageGroup = node.closest(".typst-page");
  if (!(pageGroup instanceof SVGElement) || !root.contains(pageGroup)) return undefined;
  const contentRoot = [...pageGroup.children].find((child) => !child.hasAttribute("data-preview-page-background"));
  if (!(contentRoot instanceof SVGElement)) return undefined;
  let current: Element | null = node;
  while (current && current.parentNode !== contentRoot) current = current.parentElement;
  return current instanceof SVGElement ? current : undefined;
}

function restoreRendererHiddenGroup(group: SVGElement): void {
  const hidden = rendererHiddenGroups.get(group);
  if (!hidden) return;
  group.append(hidden.fragment);
  group.removeAttribute("data-mmt-window-hidden");
  rendererHiddenGroups.delete(group);
}

function restoreRendererHiddenGroups(): void {
  for (const group of [...rendererHiddenGroups.keys()]) restoreRendererHiddenGroup(group);
}

interface RendererAffineTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

function rendererDocumentBounds(
  node: SVGForeignObjectElement,
  root: SVGSVGElement,
): RendererBounds | undefined {
  const x = Number(node.getAttribute("x") ?? "0");
  const y = Number(node.getAttribute("y") ?? "0");
  const width = Number(node.getAttribute("width"));
  const height = Number(node.getAttribute("height"));
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return undefined;
  const chain: SVGGraphicsElement[] = [];
  let current: Element | null = node;
  while (current && current !== root) {
    if (current instanceof SVGGraphicsElement) chain.push(current);
    current = current.parentElement;
  }
  if (current !== root) return undefined;
  let matrix: RendererAffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const local = chain[index]!.transform.baseVal.consolidate()?.matrix;
    if (local) matrix = multiplyRendererTransforms(matrix, local);
  }
  const corners = [
    transformRendererPoint(matrix, x, y),
    transformRendererPoint(matrix, x + width, y),
    transformRendererPoint(matrix, x, y + height),
    transformRendererPoint(matrix, x + width, y + height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  if (![...xs, ...ys].every(Number.isFinite)) return undefined;
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function multiplyRendererTransforms(
  outer: RendererAffineTransform,
  inner: RendererAffineTransform,
): RendererAffineTransform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

function transformRendererPoint(
  matrix: RendererAffineTransform,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

async function materializeRendererImageUrls(root: ParentNode): Promise<void> {
  const digestBySource = new Map<string, string>();
  const usedDigests = new Set<string>();
  for (const image of root.querySelectorAll<SVGImageElement>("image")) {
    const href = image.getAttribute("href");
    const xlinkHref = image.getAttributeNS(XLINK_NAMESPACE, "href");
    const source = href ?? xlinkHref ?? "";
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(source);
    if (!match) throw new Error("Preview renderer image payload is not an embedded base64 image");
    const remembered = rendererImageSources.get(image);
    let digest = remembered?.source === source ? remembered.digest : digestBySource.get(source);
    let bytes: Uint8Array | undefined;
    if (!digest) {
      bytes = base64ToBytes(match[2]);
      digest = `sha256:${await sha256Hex(bytes)}`;
      digestBySource.set(source, digest);
    }
    let url = imageUrls.get(digest);
    if (!url) {
      bytes ??= base64ToBytes(match[2]);
      const buffer = bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
      url = URL.createObjectURL(new Blob([buffer], { type: match[1].toLowerCase() }));
      imageUrls.set(digest, url);
    }
    rendererImageSources.set(image, { href, xlinkHref, source, digest });
    usedDigests.add(digest);
    image.setAttribute("href", url);
    image.removeAttributeNS(XLINK_NAMESPACE, "href");
  }
  for (const [digest, url] of imageUrls) {
    if (usedDigests.has(digest)) continue;
    URL.revokeObjectURL(url);
    imageUrls.delete(digest);
  }
}

function clearImageUrls(): void {
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
}

function commitImageUrls(staged: Map<string, string>): void {
  for (const [digest, url] of imageUrls) {
    if (staged.get(digest) !== url) URL.revokeObjectURL(url);
  }
  imageUrls = staged;
}

function revokeUncommittedImageUrls(staged: ReadonlyMap<string, string>): void {
  for (const [digest, url] of staged) {
    if (imageUrls.get(digest) !== url) URL.revokeObjectURL(url);
  }
}

function measureLocations(spans: readonly MeasurementSpan[]): readonly PreviewRenderArtifactLocation[] {
  const started = performance.now();
  const pageBounds = page.getBoundingClientRect();
  const resolved = new Map(spans.map((span) => [span.span, span]));

  const locations: PreviewRenderArtifactLocation[] = [];
  for (const element of page.querySelectorAll<SVGGraphicsElement>("[data-span]")) {
    const span = resolved.get(element.getAttribute("data-span") ?? "");
    if (!span) continue;
    const rectangles = [...element.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (rectangles.length === 0) continue;
    const left = Math.min(...rectangles.map((rect) => rect.left));
    const top = Math.min(...rectangles.map((rect) => rect.top));
    const right = Math.max(...rectangles.map((rect) => rect.right));
    const bottom = Math.max(...rectangles.map((rect) => rect.bottom));
    const normalizeX = (value: number) => Math.min(1, Math.max(0, (value - pageBounds.left) / pageBounds.width));
    const normalizeY = (value: number) => Math.min(1, Math.max(0, (value - pageBounds.top) / pageBounds.height));
    locations.push({
      ...span,
      pageIndex: 0,
      x: normalizeX((left + right) / 2),
      y: normalizeY((top + bottom) / 2),
      left: normalizeX(left),
      top: normalizeY(top),
      right: normalizeX(right),
      bottom: normalizeY(bottom),
    });
  }
  Reflect.set(locations, "measurementMs", performance.now() - started);
  return locations;
}

async function renderFrame(message: RendererFrameMessage): Promise<void> {
  if (!Number.isFinite(message.publishedAtEpochMs) || message.publishedAtEpochMs <= 0) {
    throw new Error("Preview renderer frame has invalid publication time");
  }
  const iframeTransferMs = Math.max(0, Date.now() - message.publishedAtEpochMs);
  const generation = ++renderGeneration;
  const domStarted = performance.now();
  const scrollRevision = composerInput.scrollRevision;
  const viewportBounds = viewport.getBoundingClientRect();
  const oldPageBounds = page.getBoundingClientRect();
  const savedPoint = previewPointAtDocumentCoordinates(
    oldPageBounds.width > 0 ? (viewportBounds.left + viewportBounds.width / 2 - oldPageBounds.left) / zoom : 0,
    oldPageBounds.height > 0 ? (viewportBounds.top + viewportBounds.height / 2 - oldPageBounds.top) / zoom : 0,
  );
  const savedViewport: PreviewViewport = {
    page: savedPoint?.pageIndex ?? 0,
    x: savedPoint?.x ?? 0,
    y: savedPoint?.y ?? 0,
    zoom,
    fitMode,
  };
  const rendered = await persistentRenderer.apply(message);
  if (generation !== renderGeneration) return;
  const activeRoot = page.querySelector<SVGSVGElement>(":scope > svg.typst-renderer-root");
  if (!activeRoot) throw new Error("Preview renderer committed no active SVG root");
  activateRenderedDomGeneration(activeRoot, generation);
  status.hidden = true;
  viewport.hidden = false;
  page.classList.add("renderer-active");
  applyZoom(zoom, fitMode, false);
  showOverlay("preview-indicator", indicatorPoint);
  showOverlay("preview-cursor", cursorPoint);
  await restoreViewport(savedViewport, () => composerInput.scrollRevision === scrollRevision);
  await waitForVisualPaint();
  if (generation !== renderGeneration) return;
  page.dataset.renderKey = message.renderKey;
  page.dataset.requestSequence = String(message.requestSequence);
  composerInput.rendered();
  const domUpdateMs = performance.now() - domStarted;
  vscode.postMessage({
    type: "visual-ready",
    requestSequence: message.requestSequence,
    traceId: message.traceId,
    renderKey: message.renderKey,
    renderer: {
      sessionId: message.sessionId,
      artifactDigest: message.artifactDigest,
      sourceDigest: message.sourceDigest,
      backendGeneration: message.backendGeneration,
      generation: message.rendererGeneration,
      baseGeneration: message.baseGeneration,
      frameKind: message.frameKind,
      byteLength: message.byteLength,
      pageGeometries: rendered.pageGeometries,
      patchedNodes: rendered.patchedNodes,
      reusedNodes: rendered.reusedNodes,
      removedNodes: rendered.removedNodes,
      pageBuffers: rendered.pageBuffers,
      frameDecodeMs: rendered.frameDecodeMs,
      rendererApplyMs: rendered.rendererApplyMs,
    },
    locations: [],
    domUpdateMs,
    locationMeasureMs: 0,
    viewportRenderMs: rendered.viewportRenderMs,
    iframeTransferMs,
  });
  if (persistentRenderer.requiresResync) {
    vscode.postMessage({
      type: "renderer-resync-needed",
      sessionId: message.sessionId,
      generation: message.rendererGeneration,
    });
  }
}

async function render(message: RenderMessage): Promise<void> {
  const generation = ++renderGeneration;
  await persistentRenderer.reset();
  const domStarted = performance.now();
  const parsed = document.createElement("template");
  parsed.innerHTML = message.svg;
  const root = parsed.content.firstElementChild;
  if (!root || root.namespaceURI !== "http://www.w3.org/2000/svg" || root.localName !== "svg") {
    throw new Error("Preview publication contains no valid SVG root");
  }
  const stagedImageUrls = materializeImageUrls(message.imageAssets);
  try {
    for (const image of root.querySelectorAll("image")) {
      const href = image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "";
      if (!href.startsWith("mmt-preview-image:")) continue;
      const url = stagedImageUrls.get(href.slice("mmt-preview-image:".length));
      if (!url) throw new Error("Preview publication references a missing image asset");
      image.setAttribute("href", url);
      image.removeAttribute("xlink:href");
    }
    const nextIntrinsicWidth = Number(message.pageSize.width);
    const nextIntrinsicHeight = Number(message.pageSize.height);
    if (!(nextIntrinsicWidth > 0) || !(nextIntrinsicHeight > 0)) {
      throw new Error("Preview publication has invalid page geometry");
    }
    const viewportBounds = viewport.getBoundingClientRect();
    const scrollRevision = composerInput.scrollRevision;
    const oldPageBounds = page.getBoundingClientRect();
    const savedViewport: PreviewViewport = {
      page: 0,
      x: oldPageBounds.width > 0
        ? Math.min(1, Math.max(0, (viewportBounds.left + viewportBounds.width / 2 - oldPageBounds.left) / oldPageBounds.width))
        : 0,
      y: oldPageBounds.height > 0
        ? Math.min(1, Math.max(0, (viewportBounds.top + viewportBounds.height / 2 - oldPageBounds.top) / oldPageBounds.height))
        : 0,
      zoom,
      fitMode,
    };
    intrinsicWidth = nextIntrinsicWidth;
    intrinsicHeight = nextIntrinsicHeight;
    page.classList.remove("renderer-active");
    page.dataset.intrinsicWidth = String(intrinsicWidth);
    page.dataset.intrinsicHeight = String(intrinsicHeight);
    page.replaceChildren(root);
    activateRenderedDomGeneration(root as SVGSVGElement, generation);
    commitImageUrls(stagedImageUrls);
    status.hidden = true;
    viewport.hidden = false;
    showOverlay("preview-indicator", indicatorPoint);
    showOverlay("preview-cursor", cursorPoint);
    await restoreViewport(savedViewport, () => composerInput.scrollRevision === scrollRevision);
    const domUpdateMs = performance.now() - domStarted;
    await waitForVisualPaint();
    if (generation !== renderGeneration) return;
    const locationStarted = performance.now();
    const locations = measureLocations(message.spans);
    const locationMeasureMs = performance.now() - locationStarted;
    page.dataset.renderKey = message.renderKey;
    page.dataset.requestSequence = String(message.requestSequence);
    composerInput.rendered();
    vscode.postMessage({
      type: "visual-ready",
      requestSequence: message.requestSequence,
      traceId: message.traceId,
      renderKey: message.renderKey,
      locations,
      domUpdateMs,
      locationMeasureMs,
    });
  } catch (error) {
    revokeUncommittedImageUrls(stagedImageUrls);
    throw error;
  }
}

function applyExactExportState(state: ExactExportState | undefined): void {
  if (!state) return;
  exportControl.dataset.availability = state.availability;
  exportControl.dataset.mode = state.mode;
  exportControl.setAttribute("aria-label", state.mode === "exact" ? "Exact snapshot export" : "Current preview export");
  exportControl.dataset.phase = state.phase;
  exportStatus.textContent = state.message;
  exportFormat.disabled = !state.canSelectFormat;
  exportReady.textContent = state.mode === "exact" ? "Export exact revision" : "Export current preview";
  exportReady.hidden = state.availability !== "ready" || state.canCancel;
  exportReady.disabled = !state.canExportDisplayed;
  exportStale.hidden = state.availability !== "stale" || state.canCancel;
  exportDisplayed.disabled = !state.canExportDisplayed;
  exportLatest.disabled = !state.canWaitForLatest;
  exportCancel.hidden = !state.canCancel;
  exportCancel.disabled = !state.canCancel;
}

function showStatus(message: string, error: boolean): void {
  status.textContent = message;
  status.classList.toggle("error", error);
  status.hidden = false;
  if (!page.firstElementChild) viewport.hidden = true;
}

type ComposerPointerSample = Pick<Extract<ComposerIntent, { kind: "pointer" }>, "point" | "uncertainty">;

interface ComposerPointerGesture {
  readonly pointerId: number;
  readonly owner: HTMLElement;
  readonly originX: number;
  readonly originY: number;
  readonly extend: boolean;
  readonly clickCount: 1 | 2;
  clientX: number;
  clientY: number;
  dirty: boolean;
  moved: boolean;
  initialSample?: ComposerPointerSample;
  ended: boolean;
  deferredStart?: { readonly sample: ComposerPointerSample; readonly renderKey: string };
}

/** Retained input presentation, not a text model. All mutations are semantic host intents. */
class ComposerInputBridge {
  readonly #layer = document.createElement("div");
  readonly #visuals = document.createElement("div");
  readonly #input = document.createElement("textarea");
  readonly #composition = document.createElement("span");
  readonly #announcement = document.createElement("span");
  readonly #handles = [document.createElement("button"), document.createElement("button")];
  #state: ComposerStateMessage | undefined;
  #geometry: ComposerStateMessage | undefined;
  #sequence = 0;
  #pointerSequence = 0;
  #gesture: ComposerPointerGesture | undefined;
  #afterPointer: ComposerIntent[] = [];
  readonly #draftBlockedDrains = new Map<string, number>();
  #lastClick: { readonly x: number; readonly y: number; readonly time: number } | undefined;
  #suppressClick = false;
  #composing = false;
  #compositionText = "";
  #compositionCommit: string | undefined;
  #handledBeforeInput: { readonly inputType: string; readonly text: string | null } | undefined;
  #layoutFrame: number | undefined;
  #dragFrame: number | undefined;
  #revealFrame: number | undefined;
  /** Active keyboard/IME caret-follow request, carried across admission echoes at this scroll revision. */
  #revealRequestedAtScroll: number | undefined;
  #scrollRevision = 0;
  #expectedScroll: { readonly left: number; readonly top: number } | undefined;
  #focusWhenAuthorized = false;
  #touchSelection = false;
  #disposed = false;

  constructor() {
    const style = document.createElement("style");
    style.textContent = `
      .composer-overlays { position:fixed; inset:0; z-index:5; overflow:hidden; pointer-events:none; contain:strict; }
      .composer-visuals { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
      .composer-caret,.composer-selection-box { position:absolute; pointer-events:none; box-sizing:border-box; }
      .composer-caret { background:var(--vscode-editorCursor-foreground,#006bb3); min-width:1px; }
      .composer-selection-box { background:var(--vscode-editor-selectionBackground,#75baff66); }
      .composer-input-bridge { position:absolute; margin:0; padding:0; border:0; outline:0; resize:none; overflow:hidden; width:1px; min-width:1px; max-width:1px; background:transparent; color:transparent; caret-color:transparent; opacity:.01; font:16px/1 sans-serif; white-space:pre; pointer-events:none; }
      .composer-composition { position:absolute; box-sizing:border-box; max-width:100%; overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--vscode-editor-background,#fff); color:var(--vscode-editor-foreground,#222); border-bottom:2px solid var(--vscode-focusBorder,#007acc); font:16px/1.3 var(--vscode-editor-font-family,monospace); }
      .composer-touch-handle { position:absolute; width:44px; height:44px; margin:0; padding:0; border:0; background:transparent; pointer-events:auto; touch-action:none; cursor:grab; }
      .composer-touch-handle::after { content:""; position:absolute; width:14px; height:14px; left:15px; top:4px; border-radius:50%; background:var(--vscode-editorCursor-foreground,#006bb3); box-shadow:0 0 0 1px #fff; }
      .composer-overlays [hidden] { display:none; }
      .composer-announcement { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
      .composer-announcement.composer-input-rejected { clip-path:none; width:auto; height:auto; max-width:calc(100% - 24px); left:12px; top:8px; padding:8px; background:var(--vscode-editor-background,#fff); color:var(--vscode-errorForeground,#b02020); border:1px solid currentColor; pointer-events:auto; font:14px/1.4 sans-serif; }
      .composer-input-rejected button { min-height:44px; min-width:44px; margin-left:8px; }
      body:not([data-composer-status="blocked"]) .page .tsel { user-select:none; -webkit-user-select:none; }
      body:not([data-composer-status="blocked"]) .page { touch-action:pan-y; }
      body:not([data-composer-status="blocked"]) .page .typst-text,
      body:not([data-composer-status="blocked"]) .page [data-typst-label^="mmt:bubble:"],
      body:not([data-composer-status="blocked"]) .page [data-typst-label^="mmt:narration:"] { touch-action:none; }
    `;
    document.head.append(style);
    this.#layer.className = "composer-overlays";
    this.#visuals.className = "composer-visuals";
    this.#input.className = "composer-input-bridge";
    this.#input.setAttribute("aria-label", "编辑消息正文");
    this.#input.setAttribute("autocomplete", "off");
    this.#input.setAttribute("autocapitalize", "off");
    this.#input.spellcheck = false;
    this.#input.disabled = true;
    this.#input.tabIndex = -1;
    this.#composition.className = "composer-composition";
    this.#composition.hidden = true;
    this.#announcement.className = "composer-announcement";
    this.#announcement.setAttribute("role", "status");
    this.#announcement.setAttribute("aria-live", "polite");
    for (const [index, handle] of this.#handles.entries()) {
      handle.className = "composer-touch-handle";
      handle.type = "button";
      handle.dataset.endpoint = index === 0 ? "anchor" : "focus";
      handle.setAttribute("aria-label", index === 0 ? "移动选区起点" : "移动选区终点");
      handle.hidden = true;
      handle.addEventListener("pointerdown", (event) => this.#handlePointer(event, index));
      handle.addEventListener("pointermove", (event) => this.pointerMove(event));
      handle.addEventListener("pointerup", (event) => this.pointerUp(event));
      handle.addEventListener("pointercancel", (event) => this.pointerCancel(event));
      handle.addEventListener("lostpointercapture", (event) => this.pointerCancel(event));
    }
    this.#layer.append(this.#visuals, this.#composition, ...this.#handles, this.#input, this.#announcement);
    // Never put the input under .page: renderer full frames legitimately replace its children.
    document.body.append(this.#layer);
    document.body.dataset.composerStatus = "blocked";
    this.#input.addEventListener("keydown", (event) => this.#keyDown(event));
    this.#input.addEventListener("beforeinput", (event) => this.#beforeInput(event));
    this.#input.addEventListener("input", (event) => this.#onInput(event as InputEvent));
    this.#input.addEventListener("compositionstart", () => this.#startComposition());
    this.#input.addEventListener("compositionupdate", (event) => this.#updateComposition(event.data));
    this.#input.addEventListener("compositionend", (event) => this.#endComposition(event.data));
    this.#input.addEventListener("copy", (event) => {
      if (!this.#enabled()) return;
      event.preventDefault();
      this.#send({ kind: "copy" });
    });
    this.#input.addEventListener("cut", (event) => {
      if (!this.#enabled() || this.#composing) return;
      event.preventDefault();
      this.#send({ kind: "replace", origin: "cut", text: "" });
    });
    this.#input.addEventListener("paste", (event) => {
      if (!this.#enabled() || this.#composing) return;
      event.preventDefault();
      this.#compositionCommit = undefined;
      const text = event.clipboardData?.getData("text/plain");
      if (text !== undefined) this.#replace(text, "paste");
    });
    this.#input.addEventListener("blur", () => {
      if (this.#enabled()) {
        const draft = this.#compositionText;
        if (!this.#send({ kind: "composition", phase: "cancel", text: draft }) && draft) {
          this.#send({ kind: "composition", phase: "cancel", text: "" });
          this.#retainTransportDraft(draft);
        }
      }
      this.#clearComposition();
      this.#focusWhenAuthorized = false;
      this.#revealRequestedAtScroll = undefined;
    });
  }

  get active(): boolean {
    return this.#state !== undefined && this.#state.status !== "blocked";
  }

  get scrollRevision(): number {
    return this.#scrollRevision;
  }

  get hasTransportDraft(): boolean {
    return this.#input.readOnly;
  }

  get hasUnsubmittedInput(): boolean {
    return this.hasTransportDraft || this.#afterPointer.length > 0 || this.#composing;
  }

  focusFromHost(): void {
    if (this.#disposed || this.hasTransportDraft || this.#composing) return;
    this.#focusWhenAuthorized = true;
    if (this.#state?.status === "ready" && this.#state.carets.length > 0
      && this.#state.renderKey === page.dataset.renderKey) {
      this.#input.focus({ preventScroll: true });
      this.#focusWhenAuthorized = false;
    }
  }

  windowBlurred(): void {
    this.#focusWhenAuthorized = false;
    this.#revealRequestedAtScroll = undefined;
  }

  scrollPresentation(dx: number, dy: number): void {
    this.#scrollBy(dx, dy);
  }

  #enabled(): boolean {
    return !this.#disposed && this.active && !this.#input.readOnly;
  }

  #pointerReady(): boolean {
    return this.#enabled() && this.#state?.status === "ready"
      && this.#state.renderKey === page.dataset.renderKey
      && this.#pointerSequence <= this.#state.sequence;
  }

  acceptState(state: ComposerStateMessage): void {
    if (this.#disposed) return;
    const previous = this.#state;
    const changedSession = previous?.sessionId !== state.sessionId;
    if (previous && !changedSession && state.sequence < previous.sequence) return;
    if (changedSession) {
      if (previous && previous.status !== "blocked") return;
      this.#sequence = state.sequence;
      this.#pointerSequence = 0;
      this.#geometry = undefined;
      this.#clearComposition();
    }
    if (state.status === "blocked") this.#finishGesture();
    if (state.status === "blocked" && previous?.sessionId === state.sessionId && this.#composing) {
      const draft = this.#compositionText;
      if (!this.#send({ kind: "composition", phase: "cancel", text: draft }) && draft) this.#retainTransportDraft(draft);
      this.#clearComposition();
    }
    this.#state = state;
    this.#sequence = Math.max(this.#sequence, state.sequence);
    this.#input.disabled = state.status === "blocked" && !this.hasTransportDraft;
    this.#input.tabIndex = this.#input.disabled ? -1 : 0;
    if (state.status === "blocked") {
      this.#finishGesture();
      this.#clearComposition();
      this.#geometry = undefined;
      this.#visuals.replaceChildren();
      this.#handles.forEach((handle) => { handle.hidden = true; });
      if (!this.hasTransportDraft) this.#input.value = "";
      this.#input.blur();
      this.#revealRequestedAtScroll = undefined;
      // This outbound FIFO barrier follows every intent already posted for the retiring session.
      if (this.hasTransportDraft) {
        this.#draftBlockedDrains.set(state.sessionId, this.#sequence);
      } else {
        vscode.postMessage({ type: "composer-drained", sessionId: state.sessionId, sequence: this.#sequence });
      }
    } else if (state.status === "ready") {
      this.#geometry = state;
    }
    this.rendered();
    if (state.status === "ready" && state.carets.length > 0 && this.#focusWhenAuthorized && document.hasFocus()
      && (document.activeElement === document.body || document.activeElement === this.#input)) {
      this.#input.focus({ preventScroll: true });
      this.#focusWhenAuthorized = false;
    }
    this.#flushPointer();
  }

  rendered(): void {
    const state = this.#state;
    document.body.dataset.composerStatus = !state || state.status === "blocked" || this.hasTransportDraft ? "blocked"
      : state.status === "ready" && state.renderKey === page.dataset.renderKey
        && this.#pointerSequence <= state.sequence ? "ready" : "pending";
    this.layout();
    if (state?.status === "ready") this.#scheduleReveal();
  }

  layout(): void {
    if (this.#layoutFrame !== undefined || this.#disposed) return;
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = undefined;
      this.#layoutNow();
    });
  }

  #visibleBounds(): { left: number; top: number; right: number; bottom: number } {
    const bounds = viewport.getBoundingClientRect();
    const visual = window.visualViewport;
    return {
      left: Math.max(bounds.left, visual?.offsetLeft ?? 0),
      top: Math.max(bounds.top, visual?.offsetTop ?? 0),
      right: Math.min(bounds.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth)),
      bottom: Math.min(bounds.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight)),
    };
  }

  #screenTransform(): DOMMatrix | undefined {
    const root = page.firstElementChild;
    if (!(root instanceof SVGSVGElement) || !root.classList.contains("typst-renderer-root")) return undefined;
    const transform = root.getScreenCTM();
    if (!transform || transform.a * transform.d - transform.b * transform.c === 0) return undefined;
    return transform;
  }

  #boxRect(
    box: ComposerSelectionBox,
    transform = this.#screenTransform(),
    geometries = currentPageGeometries(),
  ): { x: number; y: number; width: number; height: number } | undefined {
    const geometry = geometries[box.pageIndex];
    if (!geometry || !transform) return undefined;
    const x = box.x * geometry.width;
    const y = geometry.offsetY + box.y * geometry.height;
    const width = box.width * geometry.width;
    const height = box.height * geometry.height;
    const widthX = transform.a * width;
    const heightX = transform.c * height;
    const widthY = transform.b * width;
    const heightY = transform.d * height;
    return {
      x: transform.a * x + transform.c * y + transform.e + Math.min(0, widthX) + Math.min(0, heightX),
      y: transform.b * x + transform.d * y + transform.f + Math.min(0, widthY) + Math.min(0, heightY),
      width: Math.abs(widthX) + Math.abs(heightX),
      height: Math.abs(widthY) + Math.abs(heightY),
    };
  }

  #layoutNow(): void {
    const visible = this.#visibleBounds();
    this.#layer.style.clipPath = `inset(${Math.max(0, visible.top)}px ${Math.max(0, window.innerWidth - visible.right)}px ${Math.max(0, window.innerHeight - visible.bottom)}px ${Math.max(0, visible.left)}px)`;
    this.#announcement.style.left = `${visible.left + 8}px`;
    this.#announcement.style.top = `${visible.top + 8}px`;
    this.#announcement.style.maxWidth = `${Math.max(44, visible.right - visible.left - 16)}px`;
    const geometry = this.#geometry;
    // Pending reflow may retain feedback, but old normalized points never get reinterpreted in a new frame.
    if (!geometry || geometry.renderKey !== page.dataset.renderKey) return;
    const fragments = document.createDocumentFragment();
    const screenTransform = this.#screenTransform();
    const pageGeometries = currentPageGeometries();
    const appendBox = (box: ComposerSelectionBox, className: string) => {
      const rect = this.#boxRect(box, screenTransform, pageGeometries);
      if (!rect || rect.x + Math.max(1, rect.width) < visible.left || rect.x > visible.right
        || rect.y + rect.height < visible.top || rect.y > visible.bottom) return;
      const element = document.createElement("span");
      element.className = className;
      element.dataset.pageIndex = String(box.pageIndex);
      element.dataset.x = String(box.x);
      element.dataset.y = String(box.y);
      element.dataset.width = String(box.width);
      element.dataset.height = String(box.height);
      if ("affinity" in box) element.dataset.affinity = String(box.affinity);
      Object.assign(element.style, {
        left: `${rect.x}px`, top: `${rect.y}px`, width: `${Math.max(className === "composer-caret" ? 1 : 0, rect.width)}px`, height: `${rect.height}px`,
      });
      fragments.append(element);
    };
    for (const box of geometry.boxes) appendBox(box, "composer-selection-box");
    for (const caret of geometry.carets) appendBox(caret, "composer-caret");
    this.#visuals.replaceChildren(fragments);
    const caret = geometry.carets.at(-1);
    const caretRect = caret && this.#boxRect(caret, screenTransform, pageGeometries);
    if (caretRect && !this.hasTransportDraft) {
      // Keep the OS candidate window near the real caret and inside the visual viewport.
      this.#input.style.left = `${Math.max(visible.left, Math.min(visible.right - 1, caretRect.x))}px`;
      this.#input.style.top = `${Math.max(visible.top, Math.min(visible.bottom - Math.max(16, caretRect.height), caretRect.y))}px`;
      this.#input.style.height = `${Math.max(16, caretRect.height)}px`;
      this.#composition.style.left = this.#input.style.left;
      this.#composition.style.top = this.#input.style.top;
      this.#composition.style.maxWidth = `${Math.max(1, visible.right - Math.max(visible.left, caretRect.x))}px`;
      this.#composition.style.maxHeight = `${Math.max(1, visible.bottom - Math.max(visible.top, caretRect.y))}px`;
    }
    for (const [index, handle] of this.#handles.entries()) {
      const endpoint = geometry.carets[index];
      const rect = endpoint && this.#boxRect(endpoint, screenTransform, pageGeometries);
      const captured = this.#gesture?.owner === handle;
      handle.hidden = !captured && (!this.#touchSelection || geometry.carets.length !== 2 || !rect || !this.active);
      if (!handle.hidden && !captured && rect) {
        handle.style.left = `${Math.max(visible.left, Math.min(visible.right - 44, rect.x - 22))}px`;
        handle.style.top = `${Math.max(visible.top, Math.min(visible.bottom - 44, rect.y + rect.height))}px`;
      }
    }
  }

  userScrolled(): void {
    const expected = this.#expectedScroll;
    this.#expectedScroll = undefined;
    const programmatic = Boolean(expected
      && Math.abs(expected.left - viewport.scrollLeft) <= 1
      && Math.abs(expected.top - viewport.scrollTop) <= 1);
    if (!programmatic) this.cancelReveal();
    this.layout();
    // A viewport restore or renderer rebase may follow a keyboard reveal. Re-check the
    // retained caret-follow request rather than letting that programmatic scroll win.
    if (programmatic) this.#scheduleReveal();
  }

  cancelReveal(): void {
    this.#scrollRevision += 1;
    this.#revealRequestedAtScroll = undefined;
  }

  visualViewportChanged(): void {
    this.layout();
    if (document.activeElement === this.#input && this.#state?.status === "ready") {
      this.#revealRequestedAtScroll = this.#scrollRevision;
      this.#scheduleReveal();
    }
  }

  #scheduleReveal(): void {
    if (this.#revealFrame !== undefined || this.#revealRequestedAtScroll === undefined) return;
    this.#revealFrame = requestAnimationFrame(() => {
      this.#revealFrame = undefined;
      const revision = this.#revealRequestedAtScroll;
      const geometry = this.#geometry;
      if (this.#disposed || revision === undefined || revision !== this.#scrollRevision || this.#state?.status !== "ready"
        || document.activeElement !== this.#input || !geometry || geometry.renderKey !== page.dataset.renderKey) return;
      const caret = geometry.carets.at(-1);
      const rect = caret && this.#boxRect(caret);
      if (!rect) return;
      const visible = this.#visibleBounds();
      const dx = rect.x < visible.left + 8 ? rect.x - visible.left - 8
        : rect.x + Math.max(1, rect.width) > visible.right - 8 ? rect.x + Math.max(1, rect.width) - visible.right + 8 : 0;
      const dy = rect.y < visible.top + 8 ? rect.y - visible.top - 8
        : rect.y + rect.height > visible.bottom - 8 ? rect.y + rect.height - visible.bottom + 8 : 0;
      if (dx || dy) this.#scrollBy(dx, dy);
      // Keep following ready geometry until an actual user scroll, pointer gesture, blur,
      // or blocked state cancels it. The first state for an admitted intent can echo the
      // previous geometry with the new sequence; sequence is not a geometry completion id.
    });
  }

  #scrollBy(dx: number, dy: number): void {
    const beforeLeft = viewport.scrollLeft;
    const beforeTop = viewport.scrollTop;
    viewport.scrollLeft += dx;
    viewport.scrollTop += dy;
    const left = viewport.scrollLeft;
    const top = viewport.scrollTop;
    if (left !== beforeLeft || top !== beforeTop) {
      this.#expectedScroll = { left, top };
      this.#scrollRevision += 1;
      if (this.#revealRequestedAtScroll !== undefined) this.#revealRequestedAtScroll = this.#scrollRevision;
    }
    this.layout();
  }

  #pointerSample(clientX: number, clientY: number, requireInside: boolean): ComposerPointerSample | undefined {
    const transform = this.#screenTransform();
    const state = this.#state;
    if (!transform || !state) return undefined;
    const inverse = transform.inverse();
    const { x, y } = new DOMPoint(clientX, clientY).matrixTransform(inverse);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    const geometries = currentPageGeometries();
    if (requireInside && !geometries.some((geometry) => x >= 0 && x <= geometry.width
      && y >= geometry.offsetY && y <= geometry.offsetY + geometry.height)) return undefined;
    const point = previewPointAtDocumentCoordinates(x, y);
    const geometry = point && geometries[point.pageIndex];
    if (!point || !geometry) return undefined;
    // Pointer coordinates cross Float32 screen and iframe boundaries. Transform their
    // measured precision through the actual SVG CTM, never a nominal zoom or pixel pad.
    const radius = state.screenCoordinatePrecision + float32CoordinatePrecision(
      Math.max(Math.abs(clientX), Math.abs(clientY), window.innerWidth, window.innerHeight),
    );
    const uncertainty = {
      x: (Math.abs(inverse.a) + Math.abs(inverse.c)) * radius / geometry.width,
      y: (Math.abs(inverse.b) + Math.abs(inverse.d)) * radius / geometry.height,
    };
    if (!Number.isFinite(uncertainty.x) || !Number.isFinite(uncertainty.y)
      || uncertainty.x < 0 || uncertainty.x > 1 || uncertainty.y < 0 || uncertainty.y > 1) return undefined;
    return { point, uncertainty };
  }

  bodyTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const root = target.closest("svg");
    if (!root || !renderedDomIsActive(root)) return false;
    const labelled = target.closest("[data-typst-label]");
    const semantic = labelled && parsePreviewSemanticLabel(labelled.getAttribute("data-typst-label") ?? "");
    if (semantic) return semantic.role === "bubble" || semantic.role === "narration";
    // Native empty-body metadata can have no glyph DOM. The host's exact hit test authorizes it.
    return true;
  }

  pointerDown(event: PointerEvent): boolean {
    if (!this.active || event.button !== 0 || !event.isPrimary || !this.bodyTarget(event.target)) return false;
    event.preventDefault();
    this.#suppressClick = true;
    const sample = this.#pointerSample(event.clientX, event.clientY, true);
    if (!sample) return true;
    const previous = this.#lastClick;
    const clickCount = event.detail >= 2 || (previous && performance.now() - previous.time < 500
      && Math.hypot(previous.x - event.clientX, previous.y - event.clientY) <= 6) ? 2 : 1;
    if (this.#composing) return true;
    if (!this.#pointerReady()) {
      // The second click is part of the already admitted gesture, not authorization against pending
      // render geometry. Re-check the identical frame after the first hit completes.
      if (clickCount === 2 && this.#state && this.#sequence === this.#pointerSequence
        && this.#pointerSequence > this.#state.sequence && this.#state.renderKey === page.dataset.renderKey) {
        this.#beginGesture(event, page, event.shiftKey, 2);
        this.#gesture!.deferredStart = { sample, renderKey: this.#state.renderKey };
        this.#lastClick = undefined;
      }
      return true;
    }
    this.#lastClick = clickCount === 2 ? undefined : { x: event.clientX, y: event.clientY, time: performance.now() };
    this.#beginGesture(event, page, event.shiftKey, clickCount);
    this.#gesture!.initialSample = sample;
    this.#sendPointer("start", sample, event.shiftKey, clickCount);
    return true;
  }

  #beginGesture(event: PointerEvent, owner: HTMLElement, extend: boolean, clickCount: 1 | 2): void {
    this.#finishGesture();
    this.#compositionCommit = undefined;
    this.#touchSelection = event.pointerType === "touch" || event.pointerType === "pen";
    this.#gesture = {
      pointerId: event.pointerId, owner, originX: event.clientX, originY: event.clientY,
      clientX: event.clientX, clientY: event.clientY, extend, clickCount, dirty: false, moved: false, ended: false,
    };
    owner.setPointerCapture(event.pointerId);
    document.getSelection()?.removeAllRanges();
    this.#input.focus({ preventScroll: true });
    this.#focusWhenAuthorized = false;
    this.cancelReveal();
  }

  #handlePointer(event: PointerEvent, index: number): void {
    if (!this.#pointerReady() || this.#composing || event.button !== 0 || !event.isPrimary) return;
    const carets = this.#geometry?.carets;
    const moving = carets?.[index];
    const fixed = carets?.[1];
    if (!moving || !fixed) return;
    event.preventDefault();
    event.stopPropagation();
    this.#beginGesture(event, this.#handles[index]!, true, 1);
    this.#touchSelection = true;
    const movingPoint = { pageIndex: moving.pageIndex, x: moving.x, y: moving.y + moving.height / 2 };
    this.#gesture!.initialSample = { point: movingPoint, uncertainty: { x: 0, y: 0 } };
    // Dragging the anchor starts at the opposite endpoint, retaining an explicit directional range.
    this.#sendPointer("start", {
      point: index === 0
        ? { pageIndex: fixed.pageIndex, x: fixed.x, y: fixed.y + fixed.height / 2 }
        : movingPoint,
      uncertainty: { x: 0, y: 0 },
    }, index !== 0, 1);
  }

  pointerMove(event: PointerEvent): boolean {
    const gesture = this.#gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    event.preventDefault();
    if (Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY) <= 3 && !gesture.moved) return true;
    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;
    gesture.dirty = true;
    gesture.moved = true;
    this.#flushPointer();
    this.#startAutoscroll();
    return true;
  }

  pointerUp(event: PointerEvent): boolean {
    const gesture = this.#gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    event.preventDefault();
    gesture.ended = true;
    if (gesture.moved) {
      gesture.clientX = event.clientX;
      gesture.clientY = event.clientY;
    }
    this.#flushPointer();
    return true;
  }

  pointerCancel(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.ended) return;
    const sample = this.#pointerSample(gesture.clientX, gesture.clientY, false);
    if (sample && this.#pointerReady()) this.#sendPointer("cancel", sample, gesture.extend, gesture.clickCount);
    this.#finishGesture();
  }

  #flushPointer(): void {
    const gesture = this.#gesture;
    if (gesture?.deferredStart && this.#pointerReady()) {
      const start = gesture.deferredStart;
      gesture.deferredStart = undefined;
      gesture.initialSample = start.sample;
      if (start.renderKey !== page.dataset.renderKey) {
        this.#finishGesture();
        return;
      }
      this.#sendPointer("start", start.sample, gesture.extend, gesture.clickCount);
      return;
    }
    if (!gesture || !this.#pointerReady() || (!gesture.dirty && !gesture.ended)) return;
    const sample = !gesture.moved && gesture.initialSample
      ? gesture.initialSample : this.#pointerSample(gesture.clientX, gesture.clientY, false);
    if (!sample) return;
    const phase = gesture.ended ? "end" : "move";
    this.#sendPointer(phase, sample, gesture.moved || gesture.extend, gesture.clickCount);
    gesture.dirty = false;
    if (gesture.ended) this.#finishGesture();
  }

  #finishGesture(): void {
    const gesture = this.#gesture;
    this.#gesture = undefined;
    if (gesture?.owner.hasPointerCapture(gesture.pointerId)) gesture.owner.releasePointerCapture(gesture.pointerId);
    if (this.#dragFrame !== undefined) cancelAnimationFrame(this.#dragFrame);
    this.#dragFrame = undefined;
    const queued = this.#afterPointer;
    this.#afterPointer = [];
    for (const intent of queued) this.#send(intent, true);
  }

  #startAutoscroll(): void {
    if (this.#dragFrame !== undefined) return;
    const tick = () => {
      this.#dragFrame = undefined;
      const gesture = this.#gesture;
      if (!gesture || gesture.ended) return;
      const bounds = this.#visibleBounds();
      const speed = (value: number, low: number, high: number) => value < low + 32 ? -Math.min(18, (low + 32 - value) / 3)
        : value > high - 32 ? Math.min(18, (value - high + 32) / 3) : 0;
      const dx = speed(gesture.clientX, bounds.left, bounds.right);
      const dy = speed(gesture.clientY, bounds.top, bounds.bottom);
      if (dx || dy) {
        this.#scrollBy(dx, dy);
        gesture.dirty = true;
        this.#flushPointer();
        this.#dragFrame = requestAnimationFrame(tick);
      }
    };
    this.#dragFrame = requestAnimationFrame(tick);
  }

  consumeClick(): boolean {
    const consumed = this.#suppressClick;
    this.#suppressClick = false;
    return consumed;
  }

  #sendPointer(phase: "start" | "move" | "end" | "cancel", { point, uncertainty }: ComposerPointerSample, extend: boolean, clickCount: 1 | 2): void {
    if (this.#send({ kind: "pointer", phase, point, uncertainty, extend, clickCount })) {
      this.#pointerSequence = this.#sequence;
      this.rendered();
    }
  }

  #send(intent: ComposerIntent, alreadyCaptured = false): boolean {
    const state = this.#state;
    if ((!alreadyCaptured && !this.#enabled()) || this.#disposed || !state || this.#sequence >= Number.MAX_SAFE_INTEGER) return false;
    const message = { type: "composer-intent" as const, sessionId: state.sessionId, renderKey: state.renderKey, sequence: this.#sequence + 1, intent };
    if (!isComposerIntentMessage(message)) return false;
    if (intent.kind !== "pointer" && this.#gesture) {
      // Preserve physical event order until the final pointer location has been authorized.
      this.#afterPointer.push(intent);
      return true;
    }
    this.#sequence = message.sequence;
    if (intent.kind === "replace" || intent.kind === "move" || intent.kind === "history"
      || (intent.kind === "composition" && intent.phase === "end")) {
      this.#revealRequestedAtScroll = this.#scrollRevision;
    }
    vscode.postMessage(message);
    return true;
  }

  #replace(text: string, origin: "typing" | "paste"): void {
    if (this.#send({ kind: "replace", text, origin })) {
      this.#input.value = "";
    } else if (text) {
      if (origin === "paste") {
        this.#showInputRejection("粘贴内容超过输入传输限制，未提交。原始剪贴板内容保持不变。");
      } else {
        this.#retainTransportDraft(text);
      }
    }
  }

  #showInputRejection(message: string): void {
    this.#announcement.classList.add("composer-input-rejected");
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = this.hasTransportDraft ? "丢弃临时输入" : "关闭";
    dismiss.addEventListener("click", () => {
      this.#input.value = "";
      this.#input.readOnly = false;
      for (const property of ["opacity", "color", "background", "min-width", "max-width", "pointer-events"]) {
        this.#input.style.removeProperty(property);
      }
      this.#input.disabled = !this.active;
      this.#announcement.classList.remove("composer-input-rejected");
      this.#announcement.replaceChildren();
      for (const [sessionId, sequence] of this.#draftBlockedDrains) {
        vscode.postMessage({ type: "composer-drained", sessionId, sequence });
      }
      this.#draftBlockedDrains.clear();
      this.rendered();
    }, { once: true });
    this.#announcement.replaceChildren(document.createTextNode(message), dismiss);
    this.layout();
  }

  #retainTransportDraft(text: string): void {
    this.#input.value = text;
    this.#input.readOnly = true;
    this.#input.disabled = false;
    this.#input.style.opacity = "1";
    this.#input.style.color = "var(--vscode-editor-foreground)";
    this.#input.style.background = "var(--vscode-editor-background)";
    this.#input.style.minWidth = "240px";
    this.#input.style.maxWidth = "min(320px, 90vw)";
    this.#input.style.pointerEvents = "auto";
    const visible = this.#visibleBounds();
    this.#input.style.left = `${visible.left + 8}px`;
    this.#input.style.top = `${visible.top + 88}px`;
    this.#input.style.height = `${Math.max(44, Math.min(120, visible.bottom - visible.top - 100))}px`;
    this.#input.select();
    this.#showInputRejection("输入未能提交。请复制此临时草稿后再丢弃；它不会写入文档。");
    this.rendered();
  }

  #keyDown(event: KeyboardEvent): void {
    if (!this.#enabled()) return;
    if (this.#composing || event.isComposing || event.keyCode === 229) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#send({ kind: "composition", phase: "cancel", text: "" });
        this.#clearComposition();
      }
      return;
    }
    this.#compositionCommit = undefined;
    this.#handledBeforeInput = undefined;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && !event.altKey && (key === "c" || key === "x")) {
      event.preventDefault();
      if (key === "c") this.#send({ kind: "copy" });
      else this.#send({ kind: "replace", origin: "cut", text: "" });
    } else if (modifier && !event.altKey && (key === "z" || key === "y")) {
      event.preventDefault();
      this.#send({ kind: "history", direction: key === "y" || event.shiftKey ? "redo" : "undo" });
    } else if (modifier && !event.altKey && key === "a") {
      event.preventDefault();
      this.#send({ kind: "move", direction: "left", granularity: "document", extend: false });
      this.#send({ kind: "move", direction: "right", granularity: "document", extend: true });
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      this.#send({ kind: "replace", origin: "delete", text: "", direction: event.key === "Backspace" ? "backward" : "forward", granularity: event.ctrlKey || event.altKey ? "word" : "grapheme" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.#replace("\n", "typing");
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      this.#send({ kind: "move", direction: event.key === "Home" ? "left" : "right", granularity: modifier ? "document" : "visualLine", extend: event.shiftKey });
    } else if (event.key.startsWith("Arrow")) {
      const directions = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const;
      const direction = directions[event.key as keyof typeof directions];
      if (!direction) return;
      event.preventDefault();
      const vertical = direction === "up" || direction === "down";
      const granularity = vertical ? modifier ? "document" : "visualLine"
        : event.metaKey ? "visualLine" : event.ctrlKey || event.altKey ? "word" : "grapheme";
      this.#send({ kind: "move", direction, granularity, extend: event.shiftKey });
    }
  }

  #beforeInput(event: InputEvent): void {
    if (!this.#enabled()) return;
    if (this.#composing || event.isComposing) return;
    if ((event.inputType === "insertFromComposition" || event.inputType === "insertCompositionText")
      && event.data === this.#compositionCommit) {
      event.preventDefault();
      this.#input.value = "";
      return;
    }
    // A real new beforeinput disambiguates even an identical next key from a trailing IME input.
    this.#compositionCommit = undefined;
    const handled = this.#inputIntent(event.inputType, event.data);
    if (!handled) return;
    event.preventDefault();
    this.#handledBeforeInput = { inputType: event.inputType, text: event.data };
  }

  #onInput(event: InputEvent): void {
    if (!this.#enabled()) return;
    if (this.#composing || event.isComposing) {
      if (this.#composing) this.#updateComposition(event.data ?? this.#input.value);
      return;
    }
    const handled = this.#handledBeforeInput;
    this.#handledBeforeInput = undefined;
    if ((handled && handled.inputType === event.inputType && handled.text === event.data)
      || (this.#compositionCommit !== undefined && event.data === this.#compositionCommit)) {
      this.#compositionCommit = undefined;
      this.#input.value = "";
      return;
    }
    this.#compositionCommit = undefined;
    if (!this.#inputIntent(event.inputType, event.data ?? this.#input.value) && this.#input.value) {
      this.#replace(this.#input.value, "typing");
    }
    if (!this.#input.readOnly) this.#input.value = "";
  }

  #inputIntent(inputType: string, text: string | null): boolean {
    if (inputType === "insertText" || inputType === "insertReplacementText" || inputType === "insertFromComposition") {
      if (text !== null) this.#replace(text, "typing");
      return text !== null;
    }
    if (inputType === "insertFromPaste") {
      if (text !== null) this.#replace(text, "paste");
      return text !== null;
    }
    if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
      this.#replace("\n", "typing");
      return true;
    }
    if (inputType === "deleteContentBackward" || inputType === "deleteContentForward"
      || inputType === "deleteWordBackward" || inputType === "deleteWordForward") {
      this.#send({ kind: "replace", origin: "delete", text: "", direction: inputType.endsWith("Backward") ? "backward" : "forward", granularity: inputType.startsWith("deleteWord") ? "word" : "grapheme" });
      return true;
    }
    if (inputType === "historyUndo" || inputType === "historyRedo") {
      this.#send({ kind: "history", direction: inputType === "historyUndo" ? "undo" : "redo" });
      return true;
    }
    return false;
  }

  #startComposition(): void {
    if (!this.#enabled() || this.#composing) return;
    this.#compositionCommit = undefined;
    this.#handledBeforeInput = undefined;
    this.#composing = true;
    this.#compositionText = "";
    this.#send({ kind: "composition", phase: "start", text: "" });
  }

  #updateComposition(text: string): void {
    if (!this.#composing || text === this.#compositionText) return;
    this.#compositionText = text;
    this.#composition.textContent = text;
    this.#composition.hidden = text.length === 0;
    this.#send({ kind: "composition", phase: "update", text });
    this.layout();
  }

  #endComposition(text: string): void {
    if (!this.#composing) return;
    if (!this.#send({ kind: "composition", phase: text ? "end" : "cancel", text }) && text) {
      this.#retainTransportDraft(text);
    }
    this.#clearComposition();
    this.#compositionCommit = text;
  }

  #clearComposition(): void {
    this.#composing = false;
    this.#compositionText = "";
    this.#composition.textContent = "";
    this.#composition.hidden = true;
    this.#compositionCommit = undefined;
    this.#handledBeforeInput = undefined;
    if (!this.#input.readOnly) this.#input.value = "";
  }

  dispose(): void {
    this.#disposed = true;
    this.#finishGesture();
    for (const frame of [this.#layoutFrame, this.#revealFrame]) if (frame !== undefined) cancelAnimationFrame(frame);
    this.#clearComposition();
    this.#layer.remove();
  }
}

const composerInput = new ComposerInputBridge();

document.querySelector('[data-zoom="out"]')?.addEventListener("click", () => applyZoomAtViewportCenter(zoom - 0.1));
document.querySelector('[data-zoom="in"]')?.addEventListener("click", () => applyZoomAtViewportCenter(zoom + 0.1));
document.querySelector('[data-fit="width"]')?.addEventListener("click", () => fitWidth());
document.querySelector('[data-fit="page"]')?.addEventListener("click", () => fitPage());
viewport.addEventListener("wheel", (event) => {
  composerInput.cancelReveal();
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  applyZoomAroundPoint(
    zoom * Math.exp(-event.deltaY * 0.002),
    "manual",
    event.clientX,
    event.clientY,
  );
}, { passive: false });
viewport.addEventListener("scroll", () => {
  composerInput.userScrolled();
  if (viewportIdleTimer !== undefined) clearTimeout(viewportIdleTimer);
  viewportIdleTimer = window.setTimeout(() => {
    viewportIdleTimer = undefined;
    persistentRenderer.viewportSettled();
  }, 120);
  if (viewportFrame !== undefined) return;
  persistentRenderer.viewportChanged();
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = undefined;
    reportViewport();
  });
}, { passive: true });
page.addEventListener("pointerdown", (event) => {
  pointerOrigin = { x: event.clientX, y: event.clientY };
  pointerDragged = false;
  composerInput.pointerDown(event);
});
page.addEventListener("pointermove", (event) => {
  if (pointerOrigin && Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) > 3) pointerDragged = true;
  composerInput.pointerMove(event);
});
page.addEventListener("pointerup", (event) => {
  composerInput.pointerUp(event);
  pointerOrigin = undefined;
});
page.addEventListener("pointercancel", (event) => composerInput.pointerCancel(event));
page.addEventListener("lostpointercapture", (event) => composerInput.pointerCancel(event));
page.addEventListener("click", (event) => {
  if (composerInput.consumeClick()) {
    event.preventDefault();
    return;
  }
  if (composerInput.active) {
    // Body input never also navigates source. Nonbody semantic labels retain the existing Picker/Sheet route.
    if (composerInput.bodyTarget(event.target) || pointerDragged) return;
    const contextPoint = previewNavigationPointAtClientCoordinates(event.clientX, event.clientY, event.target, true, true);
    if (contextPoint) {
      event.preventDefault();
      vscode.postMessage({ type: "context-point", point: contextPoint, anchor: { screenX: event.screenX, screenY: event.screenY } });
    }
    return;
  }
  const navigationPoint = previewNavigationPointAtClientCoordinates(
    event.clientX,
    event.clientY,
    event.target,
    false,
    false,
  );
  if (!navigationPoint) return;
  const selection = document.getSelection();
  const hasTextSelection = Boolean(selection && !selection.isCollapsed);
  setTimeout(() => {
    const dragged = pointerDragged;
    pointerDragged = false;
    if (!dragged && !hasTextSelection) {
      vscode.postMessage({ type: "navigate", point: navigationPoint });
    }
  }, 0);
});
page.addEventListener("contextmenu", (event) => {
  if (pointerDragged) return;
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) return;
  const contextPoint = previewNavigationPointAtClientCoordinates(
    event.clientX,
    event.clientY,
    event.target,
    true,
    true,
  );
  if (!contextPoint) return;
  event.preventDefault();
  vscode.postMessage({
    type: "context-point",
    point: contextPoint,
    anchor: { screenX: event.screenX, screenY: event.screenY },
  });
});
exportReady.addEventListener("click", () => vscode.postMessage({ type: "exact-export", format: exportFormat.value as ExactExportFormat }));
exportDisplayed.addEventListener("click", () => vscode.postMessage({ type: "exact-export", format: exportFormat.value as ExactExportFormat, staleChoice: "export-displayed" }));
exportLatest.addEventListener("click", () => vscode.postMessage({ type: "exact-export", format: exportFormat.value as ExactExportFormat, staleChoice: "wait-for-latest" }));
exportCancel.addEventListener("click", () => vscode.postMessage({ type: "exact-export-cancel" }));
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isPreviewHostToWebviewMessage(message)) return;
  if (message.type === "render") void render(message).catch((error) => {
    vscode.postMessage({ type: "render-rejected", requestSequence: message.requestSequence, renderKey: message.renderKey, error: error instanceof Error ? error.message : String(error) });
  });
  else if (message.type === "render-frame") void renderFrame(message).catch((error) => {
    vscode.postMessage({ type: "render-rejected", requestSequence: message.requestSequence, renderKey: message.renderKey, error: error instanceof Error ? error.message : String(error) });
  });
  else if (message.type === "renderer-reset") {
    renderGeneration += 1;
    void persistentRenderer.reset();
    page.classList.remove("renderer-active");
    page.replaceChildren();
    delete page.dataset.renderKey;
    composerInput.rendered();
  }
  else if (message.type === "status") showStatus(message.message, message.error);
  else if (message.type === "restoreViewport") void restoreViewport(message.viewport);
  else if (message.type === "indicator") showOverlay("preview-indicator", message.point);
  else if (message.type === "cursor") showOverlay("preview-cursor", message.point);
  else if (message.type === "exactExportState") applyExactExportState(message.state);
  else if (message.type === "composer-state") composerInput.acceptState(message);
});

const composerResizeObserver = new ResizeObserver(() => {
  if (fitMode === "width") fitWidth(false);
  else if (fitMode === "page") fitPage(false);
  composerInput.layout();
});
composerResizeObserver.observe(viewport);
window.addEventListener("resize", () => composerInput.layout());
window.addEventListener("focus", () => composerInput.focusFromHost());
window.addEventListener("blur", () => composerInput.windowBlurred());
window.visualViewport?.addEventListener("resize", () => composerInput.visualViewportChanged());
window.visualViewport?.addEventListener("scroll", () => composerInput.visualViewportChanged());

if (import.meta.env.VITE_MMT_E2E === "1") {
  Object.defineProperty(globalThis, "__mmtWaitForPreviewViewportSettled", {
    configurable: true,
    value: async (): Promise<void> => {
      while (viewportIdleTimer !== undefined) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
      }
      await persistentRenderer.flush();
      await waitForVisualPaint();
    },
  });
}
window.addEventListener("beforeunload", (event) => {
  if (composerInput.hasUnsubmittedInput) {
    event.preventDefault();
    event.returnValue = "";
    return;
  }
  composerResizeObserver.disconnect();
  composerInput.dispose();
  persistentRenderer.dispose();
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
});
vscode.postMessage({ type: "ready" });
