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
const compilerWasmUrl = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.7.0-rc2/acac51459fa84907843d7a1927ae7b6fc5c743d5de4f61473c866829c9c46e2d/typst_ts_web_compiler_bg.wasm?delivery=zstd-v1";


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
  status(message: string, error: boolean): void;
  rendered(svg: string, revision: number, shadowCount: number, pageSize: { width: number; height: number }): void;
}
export type TypstExportFormat = "pdf" | "png" | "jpg" | "svg";

export interface TypstExport {
  blob: Blob;
  extension: TypstExportFormat;
}

export class TypstPreviewController {
  private pending: TypstProjectUpdate | undefined;
  private rendering = false;
  private mappedPaths = new Set<string>();
  private generation = 0;
  private closeRequested = false;
  private readonly viewport = document.createElement("div");
  private readonly canvas = document.createElement("div");
  private readonly content = document.createElement("div");
  private readonly zoomLabel = document.createElement("span");
  private zoom = 1;
  private pageSize: { width: number; height: number } | undefined;
  private latestEntryPath: string | undefined;
  private latestSvg: string | undefined;

  constructor(private readonly container: HTMLElement, private readonly events?: TypstPreviewEvents) {
    this.container.classList.add("typst-preview");
    const toolbar = document.createElement("div");
    toolbar.className = "typst-preview-toolbar";
    toolbar.append(
      this.control("−", "Zoom out", () => this.setZoom(this.zoom - 0.1)),
      this.zoomLabel,
      this.control("+", "Zoom in", () => this.setZoom(this.zoom + 0.1)),
      this.control("100%", "Actual size", () => this.setZoom(1)),
      this.control("Fit", "Fit width", () => this.fitWidth()),
    );
    this.zoomLabel.className = "typst-preview-zoom";
    this.viewport.className = "typst-preview-viewport";
    this.canvas.className = "typst-preview-canvas";
    this.content.className = "typst-preview-page";
    this.canvas.append(this.content);
    this.viewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.setZoom(this.zoom + (event.deltaY > 0 ? -0.1 : 0.1));
    }, { passive: false });
    this.container.replaceChildren(toolbar, this.viewport);
    this.setZoom(1);
    this.showStatus("Preview is waiting for the first MomoScript projection…");
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

  private setZoom(value: number): void {
    this.zoom = Math.round(Math.min(5, Math.max(0.1, value)) * 100) / 100;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    if (!this.pageSize) return;
    this.canvas.style.width = `${this.pageSize.width * this.zoom}px`;
    this.canvas.style.height = `${this.pageSize.height * this.zoom}px`;
    this.content.style.width = `${this.pageSize.width}px`;
    this.content.style.height = `${this.pageSize.height}px`;
    this.content.style.transform = `scale(${this.zoom})`;
  }

  private fitWidth(): void {
    if (!this.pageSize) return;
    this.setZoom((this.viewport.clientWidth - 32) / this.pageSize.width);
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

  async update(project: TypstProjectUpdate): Promise<void> {
    this.generation += 1;
    this.closeRequested = false;
    this.pending = project;
    await this.processPending();
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.pending = undefined;
    this.closeRequested = true;
    await this.processPending();
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
        await this.render(next, generation);
      }
    } finally {
      this.rendering = false;
    }
  }

  private async resetPreview(): Promise<void> {
    for (const path of this.mappedPaths) await $typst.unmapShadow(path);
    this.mappedPaths.clear();
    this.pageSize = undefined;
    this.latestEntryPath = undefined;
    this.latestSvg = undefined;
    this.content.replaceChildren();
    delete this.container.dataset.previewRevision;
    delete this.container.dataset.previewShadowCount;
    this.container.dataset.previewReady = "false";
    this.showStatus("Preview is waiting for a valid MomoScript projection…");
  }

  private async render(project: TypstProjectUpdate, generation: number): Promise<void> {
    const revision = project.revision;
    const nextPaths = new Set(project.files.map((file) => virtualPath(file.uri)));
    const mappedThisAttempt = new Set<string>();
    this.showStatus("Rendering preview…");
    try {
      await initializeTypst((message) => this.showStatus(message));
      for (const file of project.files) {
        const path = virtualPath(file.uri);
        const data = file.text === undefined ? decodeBase64(file.dataBase64) : encoder.encode(file.text);
        await $typst.mapShadow(path, data);
        mappedThisAttempt.add(path);
      }
      const svg = await $typst.svg({ mainFilePath: virtualPath(project.entryUri) });
      if (generation !== this.generation || this.pending) {
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      // typst.ts emits browser SVG with unescaped text-selection content, so XML
      // parsing rejects otherwise valid renderer output. Parse as HTML, then
      // strictly validate the imported SVG and XHTML selection nodes below.
      const parsed = new DOMParser().parseFromString(svg, "text/html");
      const root = parsed.querySelector("svg");
      if (!(root instanceof SVGSVGElement) || root.namespaceURI !== "http://www.w3.org/2000/svg") {
        throw new Error("Typst renderer returned no valid SVG root");
      }
      const addedPageGap = addSvgPageGaps(root);
      const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
      const viewBoxWidth = viewBox?.length === 4 ? viewBox[2] : undefined;
      const viewBoxHeight = viewBox?.length === 4 ? viewBox[3] : undefined;
      const intrinsicWidth = svgCssPixels(root.getAttribute("width"));
      const intrinsicHeight = svgCssPixels(root.getAttribute("height"));
      const width = intrinsicWidth ?? viewBoxWidth ?? Number.NaN;
      const addedCssGap = intrinsicWidth !== undefined && viewBoxWidth
        ? intrinsicWidth * addedPageGap / viewBoxWidth
        : addedPageGap;
      const height = intrinsicHeight !== undefined
        ? intrinsicHeight + addedCssGap
        : intrinsicWidth !== undefined && viewBoxWidth && viewBoxHeight
          ? intrinsicWidth * viewBoxHeight / viewBoxWidth
          : viewBoxHeight ?? Number.NaN;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("Typst renderer returned SVG without a positive page size");
      }
      this.canvas.dataset.intrinsicWidth = String(width);
      sanitizeSvg(root);
      const inlineSvg = document.importNode(root, true);
      inlineSvg.setAttribute("role", "img");
      inlineSvg.setAttribute("aria-label", "Rendered MomoScript preview");
      inlineSvg.setAttribute("width", "100%");
      inlineSvg.setAttribute("height", "100%");
      if (generation !== this.generation || this.pending) {
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      for (const previous of this.mappedPaths) {
        if (!nextPaths.has(previous)) await $typst.unmapShadow(previous);
      }
      this.mappedPaths = nextPaths;
      this.pageSize = { width, height };
      this.latestEntryPath = virtualPath(project.entryUri);
      this.latestSvg = inlineSvg.outerHTML;
      this.content.replaceChildren(inlineSvg);
      this.viewport.replaceChildren(this.canvas);
      this.setZoom(this.zoom);
      this.container.dataset.previewRevision = String(revision);
      this.container.dataset.previewShadowCount = String(this.mappedPaths.size);
      this.container.dataset.previewReady = "true";
      this.events?.rendered(inlineSvg.outerHTML, revision, this.mappedPaths.size, this.pageSize);
    } catch (error) {
      await this.unmapAbandonedPaths(mappedThisAttempt);
      if (generation !== this.generation || this.pending) return;
      this.container.dataset.previewReady = "false";
      this.showStatus(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private async unmapAbandonedPaths(paths: ReadonlySet<string>): Promise<void> {
    for (const path of paths) {
      if (!this.mappedPaths.has(path)) await $typst.unmapShadow(path);
    }
  }

  private showStatus(message: string, error = false): void {
    const status = document.createElement("div");
    status.className = error ? "typst-preview-status error" : "typst-preview-status";
    status.textContent = message;
    this.events?.status(message, error);
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
    compilerModule = await downloadWasmModule(compilerWasmUrl, "Typst 编译器 WASM", report);
  }
  $typst.setCompilerInitOptions({
    beforeBuild: [bundledFontsLoader, optionalMainFontsLoader],
    getModule: () => compilerModule!,
  });
  $typst.setRendererInitOptions({ getModule: () => rendererWasmUrl });
  $typst.use(TypstSnippet.withAccessModel(new MemoryAccessModel()));
  initialized = true;
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
