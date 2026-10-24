import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Download, TestInfo } from "@playwright/test";
import { expect, type Frame, type Page } from "./fixtures";

interface OutputContentBox {
  readonly label: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly glyphs: number;
  readonly images: number;
}

export interface AcceptedOutputPage {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly imageCount: number;
  readonly content: readonly OutputContentBox[];
}

export async function captureAcceptedOutput(frame: Frame): Promise<{
  readonly renderKey: string;
  readonly pages: readonly AcceptedOutputPage[];
}> {
  return frame.locator(".page").first().evaluate(async (container) => {
    const renderKey = container.getAttribute("data-render-key");
    const viewport = container.closest(".viewport");
    const settle = Reflect.get(globalThis, "__mmtWaitForPreviewViewportSettled");
    if (!renderKey || !(viewport instanceof HTMLElement) || typeof settle !== "function") {
      throw new Error("Accepted renderer output or its viewport acknowledgement is unavailable");
    }
    const currentPages = () => {
      if (container.getAttribute("data-render-key") !== renderKey || document.body.dataset.presentation === "chat") {
        throw new Error("Accepted output changed during page capture");
      }
      const root = container.querySelector("svg.typst-renderer-root");
      if (!(root instanceof SVGSVGElement)) throw new Error("Accepted renderer output is unavailable");
      return [...root.children]
        .filter((node): node is SVGGElement => node instanceof SVGGElement && node.classList.contains("typst-page"))
        .sort((left, right) => left.transform.baseVal.getItem(0).matrix.f - right.transform.baseVal.getItem(0).matrix.f);
    };
    const flushViewport = async () => {
      // Let the actual scroll event enqueue native viewport work, then use the
      // existing acknowledgement rather than guessing how long rendering takes.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await settle();
      currentPages();
    };
    const pages = currentPages().map((group, index) => {
      const width = Number(group.getAttribute("data-page-width"));
      const height = Number(group.getAttribute("data-page-height"));
      if (!(width > 0 && height > 0)) throw new Error("Accepted output page geometry is unavailable");
      return { index, width, height, content: new Map<string, OutputContentBox>(), images: new Set<string>() };
    });
    if (pages.length === 0) throw new Error("Accepted output has no pages");
    const originalScroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
    try {
      for (const outputPage of pages) {
        const firstGroup = currentPages()[outputPage.index]!;
        const firstTransform = firstGroup.getScreenCTM();
        if (!firstTransform) throw new Error("Accepted output page transform is unavailable");
        const scaleX = Math.hypot(firstTransform.a, firstTransform.b);
        const scaleY = Math.hypot(firstTransform.c, firstTransform.d);
        const stepX = viewport.clientWidth * 0.75 / scaleX;
        const stepY = viewport.clientHeight * 0.75 / scaleY;
        if (!(stepX > 0 && stepY > 0)) throw new Error("Accepted output viewport has no visible area");
        // Both native SVG page buffers and their selectable text are virtualized.
        // Visit every viewport-sized part and retain only what the real renderer
        // materializes; changing scroll never changes source or export ownership.
        for (let y = 0; y < outputPage.height; y += stepY) {
          for (let x = 0; x < outputPage.width; x += stepX) {
            let group = currentPages()[outputPage.index]!;
            const pageBounds = group.getBoundingClientRect();
            const viewportBounds = viewport.getBoundingClientRect();
            viewport.scrollLeft += pageBounds.left - viewportBounds.left + x * scaleX;
            viewport.scrollTop += pageBounds.top - viewportBounds.top + y * scaleY;
            await flushViewport();
            group = currentPages()[outputPage.index]!;
            const transform = group.getScreenCTM();
            if (!transform) throw new Error("Accepted output page geometry is unavailable");
            const inverse = transform.inverse();
            for (const element of group.querySelectorAll<SVGGraphicsElement>('[data-typst-label^="mmt:bubble:"], [data-typst-label^="mmt:narration:"]')) {
              // Ignore the invisible .tsel advance boxes, which are intentionally
              // absent from finished SVGs, and empty offscreen native placeholders.
              const points = [...element.querySelectorAll<SVGGraphicsElement>("path, rect, circle, ellipse, line, polygon, polyline, image, use, text")]
                .filter((paint) => !paint.closest("defs, foreignObject"))
                .flatMap((paint) => {
                  const bounds = paint.getBBox();
                  const matrix = paint.getScreenCTM();
                  if (!matrix) throw new Error("Accepted output painted geometry is unavailable");
                  return [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) =>
                    new DOMPoint(x, y).matrixTransform(matrix).matrixTransform(inverse));
                });
              if (points.length === 0) continue;
              const x = Math.min(...points.map((point) => point.x));
              const y = Math.min(...points.map((point) => point.y));
              const content = {
                label: element.getAttribute("data-typst-label")!,
                text: [...element.querySelectorAll(".tsel")].map((run) => run.textContent ?? "").join(""),
                x, y, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y,
                glyphs: element.querySelectorAll(".typst-text use").length,
                images: element.querySelectorAll("image").length,
              };
              const previous = outputPage.content.get(content.label);
              if (!previous || content.glyphs > previous.glyphs || content.glyphs === previous.glyphs && content.text.length >= previous.text.length) {
                outputPage.content.set(content.label, content);
              }
            }
            for (const image of group.querySelectorAll<SVGImageElement>("image")) {
              const bounds = image.getBBox();
              const matrix = image.getScreenCTM();
              if (!matrix) throw new Error("Accepted output image geometry is unavailable");
              const origin = new DOMPoint(bounds.x, bounds.y).matrixTransform(matrix).matrixTransform(inverse);
              const end = new DOMPoint(bounds.x + bounds.width, bounds.y + bounds.height).matrixTransform(matrix).matrixTransform(inverse);
              outputPage.images.add([
                image.closest("[data-tid]")?.getAttribute("data-tid") ?? "",
                ...[origin.x, origin.y, end.x, end.y].map((value) => value.toFixed(3)),
              ].join(":"));
            }
          }
        }
      }
    } finally {
      if (container.isConnected && container.getAttribute("data-render-key") === renderKey) {
        viewport.scrollLeft = originalScroll.left;
        viewport.scrollTop = originalScroll.top;
        await flushViewport();
      }
    }
    return {
      renderKey,
      pages: pages.map(({ index, width, height, content, images }) => ({
        index, width, height, imageCount: images.size,
        content: [...content.values()].sort((left, right) => left.y - right.y || left.x - right.x),
      })),
    };
  });
}

export async function saveOutputDownload(download: Download, testInfo: TestInfo, evidenceName: string): Promise<Buffer> {
  expect(await download.failure()).toBeNull();
  const directory = path.resolve(".tmp/chat-authoring-evidence/output", testInfo.project.name, evidenceName);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, path.basename(download.suggestedFilename()));
  await download.saveAs(file);
  const contentType = ({ pdf: "application/pdf", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", mmt: "text/plain" } as const)[path.extname(file).slice(1) as "pdf" | "svg" | "png" | "jpg" | "mmt"] ?? "application/octet-stream";
  await testInfo.attach(`${evidenceName}-${download.suggestedFilename()}`, { path: file, contentType });
  return readFile(file);
}

export async function attachOutputManifest(testInfo: TestInfo, evidenceName: string, manifest: unknown): Promise<void> {
  const directory = path.resolve(".tmp/chat-authoring-evidence/output", testInfo.project.name, evidenceName);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "accepted-output.json");
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await testInfo.attach(`${evidenceName}-accepted-output`, { path: file, contentType: "application/json" });
}

/** Opens the delivered SVG in a new document, without the application, renderer, or its resource cache. */
export async function inspectOutputSvg(
  application: Page,
  bytes: Buffer,
  expected: AcceptedOutputPage,
  testInfo: TestInfo,
  evidenceName: string,
): Promise<{ readonly png2x: string; readonly width: number; readonly height: number }> {
  const viewer = await application.context().newPage();
  try {
    await viewer.route("**/*", (route) => route.abort());
    await viewer.setViewportSize({ width: Math.max(1, Math.ceil(expected.width)), height: Math.max(1, Math.ceil(expected.height)) });
    await viewer.setContent('<!doctype html><html><body style="margin:0;background:white"></body></html>');
    const actual = await viewer.evaluate(async ({ svg, expectedWidth, expectedHeight }) => {
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = parsed.documentElement;
      if (parsed.querySelector("parsererror") || !(root instanceof SVGSVGElement)) throw new Error("Delivered SVG is malformed");
      const viewBox = [root.viewBox.baseVal.x, root.viewBox.baseVal.y, root.viewBox.baseVal.width, root.viewBox.baseVal.height];
      const selectionNodes = root.querySelectorAll("foreignObject, .tsel, .composer-overlays, .composer-caret, .composer-selection, .composer-composition, .preview-cursor, .preview-indicator").length;
      const imageSources = [...root.querySelectorAll("image")].map((image) => image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "");
      if (imageSources.some((source) => !source.startsWith("data:image/"))) throw new Error("Delivered SVG requires an external image resource");
      if (root.querySelector("script, iframe")) throw new Error("Delivered SVG contains executable content");
      document.body.append(document.importNode(root, true));
      const displayed = document.body.querySelector("svg")!;
      const pageTransform = displayed.getScreenCTM();
      if (!pageTransform) throw new Error("Standalone SVG geometry is unavailable");
      const inverse = pageTransform.inverse();
      const content = [...displayed.querySelectorAll<SVGGraphicsElement>('[data-typst-label^="mmt:bubble:"], [data-typst-label^="mmt:narration:"]')].map((element) => {
        const points = [...element.querySelectorAll<SVGGraphicsElement>("path, rect, circle, ellipse, line, polygon, polyline, image, use, text")]
          .filter((paint) => !paint.closest("defs, foreignObject"))
          .flatMap((paint) => {
            const bounds = paint.getBBox();
            const matrix = paint.getScreenCTM();
            if (!matrix) throw new Error("Standalone SVG painted geometry is unavailable");
            return [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) =>
              new DOMPoint(x, y).matrixTransform(matrix).matrixTransform(inverse));
          });
        if (points.length === 0) throw new Error("Standalone SVG semantic content has no painted geometry");
        const x = Math.min(...points.map((point) => point.x));
        const y = Math.min(...points.map((point) => point.y));
        return { label: element.getAttribute("data-typst-label")!, x, y,
          width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y,
          glyphs: element.querySelectorAll(".typst-text use").length, images: element.querySelectorAll("image").length };
      });
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(expectedWidth * 2);
        canvas.height = Math.ceil(expectedHeight * 2);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Standalone SVG decoder is unavailable");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let inkPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (Math.min(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) < 240) inkPixels += 1;
        }
        return { viewBox, selectionNodes, imageCount: imageSources.length, content, inkPixels,
          pageCount: displayed.querySelectorAll(":scope > .typst-page").length,
          width: canvas.width, height: canvas.height, png2x: canvas.toDataURL("image/png").split(",")[1]! };
      } finally { URL.revokeObjectURL(url); }
    }, { svg: bytes.toString("utf8"), expectedWidth: expected.width, expectedHeight: expected.height });
    expect(actual.selectionNodes).toBe(0);
    expect(actual.pageCount).toBe(1);
    expect(actual.imageCount).toBe(expected.imageCount);
    expect(Math.abs(actual.viewBox[2]! - expected.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(actual.viewBox[3]! - expected.height)).toBeLessThanOrEqual(1);
    expect(actual.inkPixels).toBeGreaterThan(100);
    expect(actual.content.map((entry) => entry.label)).toEqual(expected.content.map((entry) => entry.label));
    for (let index = 0; index < expected.content.length; index += 1) {
      const reference = expected.content[index]!;
      const delivered = actual.content[index]!;
      expect(delivered.glyphs).toBe(reference.glyphs);
      expect(delivered.images).toBe(reference.images);
      for (const coordinate of ["x", "y", "width", "height"] as const) {
        expect(Math.abs(delivered[coordinate] - reference[coordinate]), `${reference.text}: ${coordinate}`).toBeLessThanOrEqual(1);
      }
    }
    await testInfo.attach(`${evidenceName}-standalone-svg`, { body: await viewer.screenshot({ fullPage: true }), contentType: "image/png" });
    await testInfo.attach(`${evidenceName}-svg-geometry`, { body: JSON.stringify({ expected, actual: { ...actual, png2x: undefined } }, null, 2), contentType: "application/json" });
    return { png2x: actual.png2x, width: actual.width, height: actual.height };
  } finally { await viewer.close(); }
}

export async function inspectOutputRaster(
  application: Page,
  bytes: Buffer,
  format: "png" | "jpg",
  reference: { readonly png2x: string; readonly width: number; readonly height: number },
  testInfo: TestInfo,
  evidenceName: string,
): Promise<void> {
  const comparison = await application.evaluate(async ({ base64, mime, expectedPng }) => {
    const decode = async (encoded: string, type: string) => {
      const binary = atob(encoded);
      const image = await createImageBitmap(new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type }));
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Downloaded raster decoder is unavailable");
      context.drawImage(image, 0, 0); image.close();
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const actual = await decode(base64, mime);
    const expected = await decode(expectedPng, "image/png");
    if (actual.width !== expected.width || actual.height !== expected.height) return { width: actual.width, height: actual.height, meanDelta: Infinity, maxDelta: 255, inkPixels: 0 };
    let delta = 0; let maxDelta = 0; let inkPixels = 0;
    for (let offset = 0; offset < actual.pixels.length; offset += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(actual.pixels[offset + channel]! - expected.pixels[offset + channel]!);
        delta += difference; maxDelta = Math.max(maxDelta, difference);
      }
      if (Math.min(actual.pixels[offset]!, actual.pixels[offset + 1]!, actual.pixels[offset + 2]!) < 240) inkPixels += 1;
    }
    return { width: actual.width, height: actual.height, meanDelta: delta / (actual.width * actual.height * 3), maxDelta, inkPixels };
  }, { base64: bytes.toString("base64"), mime: format === "png" ? "image/png" : "image/jpeg", expectedPng: reference.png2x });
  expect(comparison.width).toBe(reference.width);
  expect(comparison.height).toBe(reference.height);
  expect(comparison.inkPixels).toBeGreaterThan(100);
  expect(comparison.meanDelta).toBeLessThanOrEqual(format === "png" ? 0.01 : 2);
  if (format === "png") expect(comparison.maxDelta).toBeLessThanOrEqual(1);
  await testInfo.attach(`${evidenceName}-${format}-decoded-pixels`, { body: JSON.stringify(comparison, null, 2), contentType: "application/json" });
}

export function expectPdfPages(bytes: Buffer, pages: readonly AcceptedOutputPage[]): void {
  expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  const document = bytes.toString("latin1");
  expect(document.match(/\/Type\s*\/Page\b/gu)).toHaveLength(pages.length);
  const mediaBoxes = [...document.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/gu)];
  expect(mediaBoxes.length).toBeGreaterThan(0);
  for (const box of mediaBoxes) {
    expect(pages.some((page) => Math.abs(page.width - Number(box[1])) <= 1 && Math.abs(page.height - Number(box[2])) <= 1)).toBe(true);
  }
}
