import { createTypstRenderer, type RenderSession, type TypstRenderer } from "@myriaddreamin/typst.ts";
import { patchRoot } from "@myriaddreamin/typst.ts/dist/esm/render/svg/patch.mjs";
import { kObject } from "@myriaddreamin/typst.ts/dist/esm/internal.types.mjs";
import * as typstRendererWrapper from "@myriaddreamin/typst-ts-renderer";
import typstRendererWasmUrl from "@myriaddreamin/typst-ts-renderer/wasm?url";
import { normalizeTextSelectionNode } from "./previewSelectableText.ts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface PreviewPoint {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
}

interface PreviewViewport {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly fitMode: "manual" | "width" | "page";
}

interface ImageAssetMessage {
  readonly digest: string;
  readonly mimeType: string;
  readonly dataBase64: string;
}

interface MeasurementSpan {
  readonly span: string;
  readonly start: number;
  readonly end: number;
}

interface RenderMessage {
  readonly type: "render";
  readonly svg: string;
  readonly imageAssets: readonly ImageAssetMessage[];
  readonly pageSize: { readonly width: number; readonly height: number };
  readonly requestSequence: number;
  readonly traceId?: string;
  readonly renderKey: string;
  readonly spans: readonly MeasurementSpan[];
}

interface RendererFrameMessage {
  readonly type: "render-frame";
  readonly sessionId: string;
  readonly frameKind: "new" | "diff-v1";
  readonly dataBase64: string;
  readonly byteLength: number;
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly backendGeneration: number;
  readonly rendererGeneration: number;
  readonly baseGeneration: number;
  readonly requestSequence: number;
  readonly traceId?: string;
  readonly renderKey: string;
  readonly publishedAtEpochMs: number;
}

interface RendererPageGeometry {
  readonly pageIndex: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

interface ExactExportState {
  readonly mode: "exact" | "current-preview";
  readonly availability: string;
  readonly phase: string;
  readonly message: string;
  readonly canSelectFormat: boolean;
  readonly canExportDisplayed: boolean;
  readonly canWaitForLatest: boolean;
  readonly canCancel: boolean;
}

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

let rendererTextSources = new WeakMap<SVGForeignObjectElement, Element>();
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
  #requestedTextHydration = false;
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

  viewportChanged(hydrateSelectableText = true): void {
    if (!this.#session || !this.#root) return;
    this.#enqueueViewportRender(1, hydrateSelectableText);
  }

  viewportSettled(): void {
    if (!this.#session || !this.#root) return;
    this.#enqueueViewportRender(5);
  }

  hydrateSelectableText(): void {
    if (!this.#session || !this.#root || this.#disposed) return;
    synchronizeRendererTextSelectionLayers(this.#root, this.#boundedWindow(0), true);
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
    this.#requestedTextHydration = false;
    this.#viewportRenderQueued = false;
    this.#replaceRootResources = false;
    this.#root?.remove();
    clearImageUrls();
    this.#root = undefined;
    rendererTextSources = new WeakMap();
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
    this.#requestedTextHydration = false;
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
    const bytes = decodeBase64(message.dataBase64);
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
      const geometry = Object.freeze({ pageIndex, offsetY, width: info.width, height: info.height });
      offsetY += info.height;
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
    const metrics = await this.#renderVisibleWindow(1, true, false);
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
    let offsetY = 0;
    const canonical = renderedPages.map((renderedPage, pageIndex) => {
      const width = Number(renderedPage.getAttribute("data-page-width"));
      const height = Number(renderedPage.getAttribute("data-page-height"));
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return undefined;
      const geometry = Object.freeze({ pageIndex, offsetY, width, height });
      offsetY += height;
      return geometry;
    });
    if (canonical.some((geometry) => !geometry)) return;
    this.#pageGeometries = Object.freeze(canonical as RendererPageGeometry[]);
    intrinsicWidth = Math.max(...this.#pageGeometries.map((geometry) => geometry.width));
    intrinsicHeight = offsetY;
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

  #enqueueViewportRender(paddingScreens: number, hydrateSelectableText = true): void {
    this.#requestedPaddingScreens = Math.max(this.#requestedPaddingScreens, paddingScreens);
    this.#requestedTextHydration ||= hydrateSelectableText;
    if (this.#viewportRenderQueued) return;
    this.#viewportRenderQueued = true;
    const operation = this.#tail.then(async () => {
      this.#viewportRenderQueued = false;
      const requested = this.#requestedPaddingScreens;
      this.#requestedPaddingScreens = 0;
      const hydrateText = this.#requestedTextHydration;
      this.#requestedTextHydration = false;
      if (!this.#session || !this.#root || this.#disposed) return;
      const requiredWindow = this.#boundedWindow(requested >= 5 ? requested : 0);
      if (this.#renderedWindow && rendererWindowContains(this.#renderedWindow, requiredWindow)) {
        synchronizeRendererTextSelectionLayers(this.#root, this.#boundedWindow(0), hydrateText);
        return;
      }
      await this.#renderVisibleWindow(requested, false, hydrateText);
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
    hydrateSelectableText = true,
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
    synchronizeRendererTextSelectionLayers(this.#root, textWindow, hydrateSelectableText);
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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
  if (layoutChanged && page.querySelector(".typst-renderer-root")) persistentRenderer.viewportChanged();
  if (notify) reportViewport();
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

async function restoreViewport(state: PreviewViewport | undefined): Promise<void> {
  if (!state) {
    await persistentRenderer.flush();
    return;
  }
  if (state.fitMode === "width") fitWidth(false);
  else if (state.fitMode === "page") fitPage(false);
  else applyZoom(state.zoom, "manual", false);
  await new Promise<void>((resolve) => requestAnimationFrame(() => {
    const target = documentCoordinatesForPoint({ pageIndex: state.page, x: state.x, y: state.y });
    if (target) {
      const viewportBounds = viewport.getBoundingClientRect();
      const pageBounds = page.getBoundingClientRect();
      viewport.scrollLeft += pageBounds.left + target.x * zoom - (viewportBounds.left + viewportBounds.width / 2);
      viewport.scrollTop += pageBounds.top + target.y * zoom - (viewportBounds.top + viewportBounds.height / 2);
      persistentRenderer.viewportChanged(false);
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
    const bytes = decodeBase64(asset.dataBase64);
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
  hydrateVisibleText = true,
): void {
  for (const [group, hidden] of [...rendererHiddenGroups]) {
    if (!group.isConnected) {
      rendererHiddenGroups.delete(group);
      continue;
    }
    if (rendererBoundsIntersect(hidden.bounds, windowRect)) restoreRendererHiddenGroup(group);
  }
  const layers: Array<{
    readonly node: SVGForeignObjectElement;
    readonly source: Element;
    readonly visible: boolean;
  }> = [];
  const groupBounds = new Map<SVGElement, RendererBounds>();
  for (const node of root.querySelectorAll("foreignObject")) {
    if (!(node instanceof SVGForeignObjectElement)) continue;
    const current = node.children[0];
    if (!(current instanceof HTMLElement) || !current.classList.contains("tsel")) continue;
    let source = rendererTextSources.get(node);
    if (!source || (current !== source && !current.querySelector(":scope > .tsel-token"))) {
      source = current;
      rendererTextSources.set(node, source);
    }
    const bounds = rendererDocumentBounds(node, root);
    const visible = !bounds || rendererBoundsIntersect(bounds, windowRect);
    layers.push({ node, source, visible });
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
  for (const { node, source, visible } of layers) {
    if (visible) {
      if (hydrateVisibleText && node.children[0] === source) normalizeTextSelectionNode(node);
    } else if (node.children[0] !== source) {
      node.replaceChildren(source);
    }
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
      bytes = decodeBase64(match[2]);
      digest = `sha256:${await sha256Hex(bytes)}`;
      digestBySource.set(source, digest);
    }
    let url = imageUrls.get(digest);
    if (!url) {
      bytes ??= decodeBase64(match[2]);
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

function measureLocations(spans: readonly MeasurementSpan[]): readonly Record<string, unknown>[] {
  const started = performance.now();
  const pageBounds = page.getBoundingClientRect();
  const resolved = new Map(spans.map((span) => [span.span, span]));

  const locations: Record<string, unknown>[] = [];
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
  status.hidden = true;
  viewport.hidden = false;
  page.classList.add("renderer-active");
  applyZoom(zoom, fitMode, false);
  showOverlay("preview-indicator", indicatorPoint);
  showOverlay("preview-cursor", cursorPoint);
  await restoreViewport(savedViewport);
  await waitForVisualPaint();
  if (generation !== renderGeneration) return;
  page.dataset.renderKey = message.renderKey;
  page.dataset.requestSequence = String(message.requestSequence);
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
  window.setTimeout(() => {
    if (generation === renderGeneration) persistentRenderer.hydrateSelectableText();
  }, 0);
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
    commitImageUrls(stagedImageUrls);
    status.hidden = true;
    viewport.hidden = false;
    showOverlay("preview-indicator", indicatorPoint);
    showOverlay("preview-cursor", cursorPoint);
    await restoreViewport(savedViewport);
    const domUpdateMs = performance.now() - domStarted;
    await waitForVisualPaint();
    if (generation !== renderGeneration) return;
    const locationStarted = performance.now();
    const locations = measureLocations(message.spans);
    const locationMeasureMs = performance.now() - locationStarted;
    page.dataset.renderKey = message.renderKey;
    page.dataset.requestSequence = String(message.requestSequence);
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

document.querySelector('[data-zoom="out"]')?.addEventListener("click", () => applyZoom(zoom - 0.1, "manual"));
document.querySelector('[data-zoom="in"]')?.addEventListener("click", () => applyZoom(zoom + 0.1, "manual"));
document.querySelector('[data-fit="width"]')?.addEventListener("click", () => fitWidth());
document.querySelector('[data-fit="page"]')?.addEventListener("click", () => fitPage());
viewport.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const bounds = page.getBoundingClientRect();
  if (!(bounds.width > 0) || !(bounds.height > 0)) return;
  const anchorX = (event.clientX - bounds.left) / bounds.width;
  const anchorY = (event.clientY - bounds.top) / bounds.height;
  applyZoom(zoom * Math.exp(-event.deltaY * 0.002), "manual", false);
  const resized = page.getBoundingClientRect();
  viewport.scrollLeft += resized.left + anchorX * resized.width - event.clientX;
  viewport.scrollTop += resized.top + anchorY * resized.height - event.clientY;
  reportViewport();
}, { passive: false });
viewport.addEventListener("scroll", () => {
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
});
page.addEventListener("pointermove", (event) => {
  if (pointerOrigin && Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) > 3) pointerDragged = true;
});
page.addEventListener("pointerup", () => { pointerOrigin = undefined; });
page.addEventListener("click", (event) => {
  const bounds = page.getBoundingClientRect();
  if (!(bounds.width > 0) || !(bounds.height > 0)) return;
  const point = previewPointAtDocumentCoordinates(
    (event.clientX - bounds.left) / zoom,
    (event.clientY - bounds.top) / zoom,
  );
  if (!point) return;
  setTimeout(() => {
    const selection = document.getSelection();
    const dragged = pointerDragged;
    pointerDragged = false;
    if (!dragged && (!selection || selection.isCollapsed)) vscode.postMessage({ type: "navigate", point });
  }, 0);
});
exportReady.addEventListener("click", () => vscode.postMessage({ type: "exact-export", format: exportFormat.value }));
exportDisplayed.addEventListener("click", () => vscode.postMessage({ type: "exact-export", format: exportFormat.value, staleChoice: "export-displayed" }));
exportLatest.addEventListener("click", () => vscode.postMessage({ type: "exact-export", format: exportFormat.value, staleChoice: "wait-for-latest" }));
exportCancel.addEventListener("click", () => vscode.postMessage({ type: "exact-export-cancel" }));
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as Record<string, unknown> | null;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "render") void render(message as unknown as RenderMessage).catch((error) => {
    vscode.postMessage({ type: "render-rejected", requestSequence: message.requestSequence, renderKey: message.renderKey, error: error instanceof Error ? error.message : String(error) });
  });
  else if (message.type === "render-frame") void renderFrame(message as unknown as RendererFrameMessage).catch((error) => {
    vscode.postMessage({ type: "render-rejected", requestSequence: message.requestSequence, renderKey: message.renderKey, error: error instanceof Error ? error.message : String(error) });
  });
  else if (message.type === "renderer-reset") {
    renderGeneration += 1;
    void persistentRenderer.reset();
    page.classList.remove("renderer-active");
    page.replaceChildren();
  }
  else if (message.type === "status") showStatus(String(message.message ?? ""), message.error === true);
  else if (message.type === "restoreViewport") void restoreViewport(message.viewport as PreviewViewport | undefined);
  else if (message.type === "indicator") showOverlay("preview-indicator", message.point as PreviewPoint | undefined);
  else if (message.type === "cursor") showOverlay("preview-cursor", message.point as PreviewPoint | undefined);
  else if (message.type === "exactExportState") applyExactExportState(message.state as ExactExportState | undefined);
});

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
window.addEventListener("beforeunload", () => {
  persistentRenderer.dispose();
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
});
vscode.postMessage({ type: "ready" });
