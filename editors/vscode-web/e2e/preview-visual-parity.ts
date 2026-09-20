import type { Frame } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, invokeMmtE2E, waitForPreviewFrame, type Page } from "./fixtures";
import type { BenchmarkRendererState } from "./preview-performance-harness";

const PARITY_VIEWPORT_WIDTH = 400;
const PARITY_VIEWPORT_HEIGHT = 620;
const PARITY_GEOMETRY_EPSILON = 0.5;

export interface VisualParitySnapshot {
  readonly pageCount: number;
  readonly pageGeometries: readonly (readonly number[])[];
  readonly rootViewBox: readonly number[];
  readonly viewportPixelDigest: string;
  readonly viewportPngBase64: string;
  readonly selectableTextDigest: string;
  readonly selectableTextLength: number;
  readonly imageDigests: readonly string[];
  readonly imageNodes: number;
  readonly navigation: { readonly uri: string; readonly line: number };
}

export interface ViewportPixelComparison {
  readonly width: number;
  readonly height: number;
  readonly differingPixels: number;
  readonly pixelBudget: number;
  readonly maxChannelDelta: number;
  readonly meanAbsoluteChannelDelta: number;
  readonly exactDigestMatch: boolean;
}

export type ReadBenchmarkRendererState = () => Promise<BenchmarkRendererState>;

export async function assertVisualParity(
  page: Page,
  oracleSamples: readonly VisualParitySnapshot[],
  rendererSamples: readonly VisualParitySnapshot[],
): Promise<readonly ViewportPixelComparison[]> {
  expect(rendererSamples).toHaveLength(oracleSamples.length);
  const identity = (sample: VisualParitySnapshot) => {
    const { viewportPixelDigest, viewportPngBase64, ...semanticIdentity } = sample;
    void viewportPixelDigest;
    void viewportPngBase64;
    return semanticIdentity;
  };
  expect(rendererSamples.map(identity)).toEqual(oracleSamples.map(identity));
  const comparisons: ViewportPixelComparison[] = [];
  for (let index = 0; index < oracleSamples.length; index += 1) {
    const oracle = oracleSamples[index]!;
    const renderer = rendererSamples[index]!;
    const difference = await page.evaluate(async ({ oraclePng, rendererPng }) => {
      const decode = async (encoded: string) => {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("viewport pixel comparison canvas is unavailable");
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const expected = await decode(oraclePng);
      const actual = await decode(rendererPng);
      if (actual.width !== expected.width || actual.height !== expected.height) {
        throw new Error(`viewport dimensions differ: ${actual.width}x${actual.height} != ${expected.width}x${expected.height}`);
      }
      let differingPixels = 0;
      let maxChannelDelta = 0;
      let totalChannelDelta = 0;
      for (let offset = 0; offset < expected.data.length; offset += 4) {
        let pixelDiffers = false;
        for (let channel = 0; channel < 3; channel += 1) {
          const delta = Math.abs(expected.data[offset + channel]! - actual.data[offset + channel]!);
          pixelDiffers ||= delta !== 0;
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          totalChannelDelta += delta;
        }
        if (pixelDiffers) differingPixels += 1;
      }
      return {
        width: expected.width,
        height: expected.height,
        differingPixels,
        maxChannelDelta,
        meanAbsoluteChannelDelta: totalChannelDelta / (expected.width * expected.height * 3),
      };
    }, { oraclePng: oracle.viewportPngBase64, rendererPng: renderer.viewportPngBase64 });
    if (difference.width !== PARITY_VIEWPORT_WIDTH || difference.height !== PARITY_VIEWPORT_HEIGHT) {
      throw new Error(
        `non-canonical parity image: ${difference.width}x${difference.height}; `
        + `expected ${PARITY_VIEWPORT_WIDTH}x${PARITY_VIEWPORT_HEIGHT}`,
      );
    }
    const pixelBudget = Math.max(16, Math.ceil(difference.width * difference.height * 0.0005));
    expect(difference.differingPixels).toBeLessThanOrEqual(pixelBudget);
    expect(difference.maxChannelDelta).toBeLessThanOrEqual(64);
    expect(difference.meanAbsoluteChannelDelta).toBeLessThanOrEqual(0.01);
    comparisons.push({
      ...difference,
      pixelBudget,
      exactDigestMatch: oracle.viewportPixelDigest === renderer.viewportPixelDigest,
    });
  }
  return comparisons;
}

async function capturePreviewImageIdentity(preview: Frame): Promise<{
  readonly digests: readonly string[];
  readonly nodes: number;
}> {
  const identity = await preview.locator("body").evaluate(async (body) => {
    const hrefs = [...body.querySelectorAll<SVGImageElement>(".page svg image")].map((image) => (
      image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? ""
    ));
    if (hrefs.some((href) => !href)) throw new Error("preview image has no source");
    const digestByHref = new Map<string, string>();
    for (const href of new Set(hrefs)) {
      const response = await fetch(href);
      if (!response.ok) throw new Error(`preview image fetch failed: HTTP ${response.status}`);
      const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
      digestByHref.set(href, [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""));
    }
    return {
      digests: hrefs.map((href) => digestByHref.get(href)!).sort(),
      nodes: hrefs.length,
    };
  });
  expect(identity.nodes).toBeGreaterThan(0);
  return identity;
}

async function positionPreviewAtMarker(
  page: Page,
  preview: Frame,
  position: { readonly line: number; readonly character: number },
  marker: string,
  readRendererState: ReadBenchmarkRendererState,
): Promise<void> {
  const positioned = await invokeMmtE2E(page, "preview", "interactionFixture", {
    action: "position-live",
    range: {
      start: position,
      end: { line: position.line, character: position.character + 1 },
    },
  });
  if (!positioned) {
    throw new Error(`preview marker positioning failed: ${JSON.stringify({ position, marker, interaction: await readRendererState() })}`);
  }
  const state = await readRendererState();
  expect(state.cursor).not.toBeNull();
  const cursor = preview.locator(".preview-cursor");
  await expect(cursor).toHaveCount(1);
  const editedText = preview.locator(".tsel").filter({ hasText: marker }).first();
  const scrollWithinViewport = (element: Element): void => {
    const viewport = element.closest<HTMLElement>(".viewport");
    if (!viewport) throw new Error("preview marker is not inside the preview viewport");
    const viewportRect = viewport.getBoundingClientRect();
    const cursorRect = element.getBoundingClientRect();
    const left = viewport.scrollLeft + cursorRect.left - viewportRect.left
      - (viewport.clientWidth - cursorRect.width) / 2;
    const top = viewport.scrollTop + cursorRect.top - viewportRect.top
      - (viewport.clientHeight - cursorRect.height) / 2;
    viewport.scrollLeft = Math.max(0, Math.min(left, viewport.scrollWidth - viewport.clientWidth));
    viewport.scrollTop = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
  };
  await cursor.evaluate(scrollWithinViewport);
  await preview.locator(".viewport").evaluate((element) => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    void element;
  }));
  await waitForViewportSettled(preview);
  await expect(editedText).toBeAttached({ timeout: 30_000 });
  await expect(editedText).toBeVisible({ timeout: 30_000 });
  // Provider cursor anchors may cover different parts of the same source range.
  // Finish on the shared marker text, without scrolling any enclosing frame.
  await editedText.evaluate(scrollWithinViewport);
  await preview.locator(".viewport").evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await waitForViewportSettled(preview);
  const cursorGeometry = await cursor.evaluate((element) => {
    const viewport = element.closest<HTMLElement>(".viewport");
    if (!viewport) throw new Error("preview cursor is not inside the preview viewport");
    const viewportRect = viewport.getBoundingClientRect();
    const cursorRect = element.getBoundingClientRect();
    const x = cursorRect.left + cursorRect.width / 2;
    const y = cursorRect.top + cursorRect.height / 2;
    return {
      contained: x >= viewportRect.left && x <= viewportRect.right
        && y >= viewportRect.top && y <= viewportRect.bottom,
      cursor: {
        left: cursorRect.left,
        top: cursorRect.top,
        right: cursorRect.right,
        bottom: cursorRect.bottom,
      },
      viewport: {
        left: viewportRect.left,
        top: viewportRect.top,
        right: viewportRect.right,
        bottom: viewportRect.bottom,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      },
    };
  });
  if (!cursorGeometry.contained) {
    throw new Error(`preview marker '${marker}' was not positioned inside .viewport: ${JSON.stringify(cursorGeometry)}`);
  }
}

async function revealPreviewFrame(page: Page, sourceUri: string): Promise<Frame> {
  const revealed = await invokeMmtE2E(page, "preview", "interactionFixture", { action: "reveal" });
  if (!revealed) throw new Error("preview Webview could not be revealed for parity capture");
  return waitForPreviewFrame(page, sourceUri);
}

async function waitForViewportSettled(preview: Frame): Promise<void> {
  await preview.evaluate(async () => {
    const settle = Reflect.get(globalThis, "__mmtWaitForPreviewViewportSettled");
    if (typeof settle !== "function") throw new Error("preview viewport settle acknowledgement is unavailable");
    await settle();
  });
}

async function canonicalizeParityViewport(preview: Frame): Promise<void> {
  await preview.locator(".viewport").evaluate((element, size) => {
    const viewport = element as HTMLElement;
    viewport.style.boxSizing = "border-box";
    viewport.style.width = `${size.width}px`;
    viewport.style.minWidth = `${size.width}px`;
    viewport.style.maxWidth = `${size.width}px`;
    viewport.style.height = `${size.height}px`;
    viewport.style.minHeight = `${size.height}px`;
    viewport.style.maxHeight = `${size.height}px`;
    viewport.style.flex = "0 0 auto";
    viewport.style.alignSelf = "center";
    viewport.style.overflow = "auto";
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "restoreViewport",
        viewport: { page: 0, x: 0, y: 0, zoom: 1, fitMode: "manual" },
      },
    }));
  }, { width: PARITY_VIEWPORT_WIDTH, height: PARITY_VIEWPORT_HEIGHT });
  await expect(preview.locator(".zoom-label")).toHaveText("100%");
  await expect(preview.locator(".page")).toHaveCSS("width", "300px");
  await preview.locator(".viewport").evaluate((element) => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      element.scrollTo(0, 0);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  }));
  await waitForViewportSettled(preview);
}

async function assertParityCaptureGeometry(page: Page, preview: Frame): Promise<void> {
  const inner = await preview.locator(".viewport").evaluate((element) => {
    const viewport = element as HTMLElement;
    const rect = viewport.getBoundingClientRect();
    const documentElement = document.documentElement;
    const body = document.body;
    const style = getComputedStyle(viewport);
    return {
      viewport: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      frame: {
        width: window.innerWidth,
        height: window.innerHeight,
        documentWidth: Math.max(documentElement.scrollWidth, body?.scrollWidth ?? 0),
        documentHeight: Math.max(documentElement.scrollHeight, body?.scrollHeight ?? 0),
      },
      scroll: {
        clientWidth: viewport.clientWidth,
        clientHeight: viewport.clientHeight,
        scrollWidth: viewport.scrollWidth,
        scrollHeight: viewport.scrollHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      },
    };
  });
  const close = (actual: number, expected: number) => (
    Math.abs(actual - expected) <= PARITY_GEOMETRY_EPSILON
  );
  if (!close(inner.viewport.width, PARITY_VIEWPORT_WIDTH)
    || !close(inner.viewport.height, PARITY_VIEWPORT_HEIGHT)) {
    throw new Error(`parity .viewport is not canonical: ${JSON.stringify(inner)}`);
  }
  if (inner.viewport.left < -PARITY_GEOMETRY_EPSILON
    || inner.viewport.top < -PARITY_GEOMETRY_EPSILON
    || inner.viewport.right > inner.frame.width + PARITY_GEOMETRY_EPSILON
    || inner.viewport.bottom > inner.frame.height + PARITY_GEOMETRY_EPSILON) {
    throw new Error(`parity .viewport is clipped by the retained Webview frame: ${JSON.stringify(inner)}`);
  }
  if (!["auto", "scroll"].includes(inner.scroll.overflowY)
    || inner.scroll.scrollHeight <= inner.scroll.clientHeight) {
    throw new Error(`parity .viewport is not the bounded document scroll container: ${JSON.stringify(inner)}`);
  }
  if (inner.frame.documentWidth > inner.frame.width + PARITY_GEOMETRY_EPSILON
    || inner.frame.documentHeight > inner.frame.height + PARITY_GEOMETRY_EPSILON) {
    throw new Error(`parity Webview document overflows its native frame: ${JSON.stringify(inner)}`);
  }

  const contains = (
    bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
    target: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  ) => target.left >= bounds.left - PARITY_GEOMETRY_EPSILON
    && target.top >= bounds.top - PARITY_GEOMETRY_EPSILON
    && target.right <= bounds.right + PARITY_GEOMETRY_EPSILON
    && target.bottom <= bounds.bottom + PARITY_GEOMETRY_EPSILON;
  let currentFrame: Frame = preview;
  let childViewport = { width: inner.frame.width, height: inner.frame.height };
  let currentCapture = { ...inner.viewport };
  let topBrowser: { readonly width: number; readonly height: number } | undefined;
  const levels: unknown[] = [];
  while (currentFrame.parentFrame()) {
    const parentFrame = currentFrame.parentFrame()!;
    const frameElement = await currentFrame.frameElement();
    const outer = await frameElement.evaluate((element, geometry) => {
      type Rect = {
        readonly left: number;
        readonly top: number;
        readonly right: number;
        readonly bottom: number;
        readonly width: number;
        readonly height: number;
      };
      const rectOf = (rect: DOMRect): Rect => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
      const parseLength = (value: string, extent: number): number => {
        if (value.endsWith("px")) return Number(value.slice(0, -2));
        if (value.endsWith("%")) return Number(value.slice(0, -1)) * extent / 100;
        return Number(value);
      };
      const polygonBounds = (value: string, rect: Rect): Rect | null => {
        const match = /^polygon\((.*)\)$/u.exec(value);
        if (!match) return null;
        const body = match[1]!.replace(/^evenodd,\s*/u, "");
        const points = body.split(",").map((point) => point.trim().split(/\s+/u));
        if (points.length < 4 || points.some((point) => point.length !== 2)) return null;
        const xs = points.map((point) => parseLength(point[0]!, rect.width));
        const ys = points.map((point) => parseLength(point[1]!, rect.height));
        if ([...xs, ...ys].some((value) => !Number.isFinite(value))) return null;
        const left = rect.left + Math.min(...xs);
        const right = rect.left + Math.max(...xs);
        const top = rect.top + Math.min(...ys);
        const bottom = rect.top + Math.max(...ys);
        const rectangular = points.every((_point, index) => (
          (xs[index] === Math.min(...xs) || xs[index] === Math.max(...xs))
          && (ys[index] === Math.min(...ys) || ys[index] === Math.max(...ys))
        ));
        return rectangular
          ? { left, top, right, bottom, width: right - left, height: bottom - top }
          : null;
      };
      const frame = element as HTMLElement;
      const frameRect = rectOf(frame.getBoundingClientRect());
      const frameScaleX = frame.offsetWidth > 0 ? frameRect.width / frame.offsetWidth : Number.NaN;
      const frameScaleY = frame.offsetHeight > 0 ? frameRect.height / frame.offsetHeight : Number.NaN;
      const scaleX = frame.clientWidth / geometry.frame.width * frameScaleX;
      const scaleY = frame.clientHeight / geometry.frame.height * frameScaleY;
      const contentLeft = frameRect.left + frame.clientLeft * frameScaleX;
      const contentTop = frameRect.top + frame.clientTop * frameScaleY;
      const capture = {
        left: contentLeft + geometry.viewport.left * scaleX,
        top: contentTop + geometry.viewport.top * scaleY,
        right: contentLeft + geometry.viewport.right * scaleX,
        bottom: contentTop + geometry.viewport.bottom * scaleY,
        width: geometry.viewport.width * scaleX,
        height: geometry.viewport.height * scaleY,
      };
      const ancestors: Array<{
        readonly element: string;
        readonly rect: Rect;
        readonly overflowBounds: Rect;
        readonly clipsX: boolean;
        readonly clipsY: boolean;
        readonly clipPath: string;
        readonly clipPathBounds: Rect | null;
      }> = [];
      const visited = new Set<HTMLElement>();
      const clippingOverflow: Readonly<Record<string, true>> = {
        auto: true,
        clip: true,
        hidden: true,
        scroll: true,
      };
      let current: HTMLElement | null = frame;
      while (current && !visited.has(current)) {
        visited.add(current);
        const rect = rectOf(current.getBoundingClientRect());
        const style = getComputedStyle(current);
        const elementScaleX = current.offsetWidth > 0 ? rect.width / current.offsetWidth : 1;
        const elementScaleY = current.offsetHeight > 0 ? rect.height / current.offsetHeight : 1;
        const overflowLeft = rect.left + current.clientLeft * elementScaleX;
        const overflowTop = rect.top + current.clientTop * elementScaleY;
        const overflowRight = overflowLeft + current.clientWidth * elementScaleX;
        const overflowBottom = overflowTop + current.clientHeight * elementScaleY;
        const clipPath = style.clipPath;
        ancestors.push({
          element: `${current.localName}${current.id ? `#${current.id}` : ""}${
            current.classList.length ? `.${[...current.classList].join(".")}` : ""
          }`,
          rect,
          overflowBounds: {
            left: overflowLeft,
            top: overflowTop,
            right: overflowRight,
            bottom: overflowBottom,
            width: overflowRight - overflowLeft,
            height: overflowBottom - overflowTop,
          },
          clipsX: clippingOverflow[style.overflowX] === true,
          clipsY: clippingOverflow[style.overflowY] === true,
          clipPath,
          clipPathBounds: clipPath === "none" ? null : polygonBounds(clipPath, rect),
        });
        const root = current.getRootNode();
        current = current.parentElement
          ?? (root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null);
      }
      const occlusions: Array<{ readonly x: number; readonly y: number; readonly element: string | null }> = [];
      const sampleXs = [capture.left + 1, (capture.left + capture.right) / 2, capture.right - 1];
      const sampleYs = [capture.top + 1, (capture.top + capture.bottom) / 2, capture.bottom - 1];
      for (const x of sampleXs) {
        for (const y of sampleYs) {
          const hit = frame.ownerDocument.elementFromPoint(x, y);
          if (hit === frame || (hit && frame.contains(hit))) continue;
          occlusions.push({
            x,
            y,
            element: hit
              ? `${hit.localName}${hit.id ? `#${hit.id}` : ""}${
                hit.classList.length ? `.${[...hit.classList].join(".")}` : ""
              }`
              : null,
          });
        }
      }
      return {
        browser: { width: window.innerWidth, height: window.innerHeight },
        frame: {
          ...frameRect,
          clientWidth: frame.clientWidth,
          clientHeight: frame.clientHeight,
          scaleX,
          scaleY,
        },
        capture,
        ancestors,
        occlusions,
      };
    }, { frame: childViewport, viewport: currentCapture });
    levels.push(outer);
    if (Math.abs(outer.frame.scaleX - 1) > 0.001
      || Math.abs(outer.frame.scaleY - 1) > 0.001
      || !close(outer.capture.width, PARITY_VIEWPORT_WIDTH)
      || !close(outer.capture.height, PARITY_VIEWPORT_HEIGHT)) {
      throw new Error(`parity frame chain scales the canonical viewport: ${JSON.stringify({ levels })}`);
    }
    const browserBounds = {
      left: 0,
      top: 0,
      right: outer.browser.width,
      bottom: outer.browser.height,
    };
    if (!contains(browserBounds, outer.capture) || !contains(outer.frame, outer.capture)) {
      throw new Error(`parity capture does not fit inside its containing frame: ${JSON.stringify({ levels })}`);
    }
    if (outer.occlusions.length > 0) {
      throw new Error(`parity capture is occluded by Workbench chrome: ${JSON.stringify({ levels })}`);
    }
    for (const ancestor of outer.ancestors) {
      if (ancestor.clipsX && (outer.capture.left < ancestor.overflowBounds.left - PARITY_GEOMETRY_EPSILON
        || outer.capture.right > ancestor.overflowBounds.right + PARITY_GEOMETRY_EPSILON)) {
        throw new Error(`parity capture crosses an ancestor horizontal clip: ${JSON.stringify({ ancestor, levels })}`);
      }
      if (ancestor.clipsY && (outer.capture.top < ancestor.overflowBounds.top - PARITY_GEOMETRY_EPSILON
        || outer.capture.bottom > ancestor.overflowBounds.bottom + PARITY_GEOMETRY_EPSILON)) {
        throw new Error(`parity capture crosses an ancestor vertical clip: ${JSON.stringify({ ancestor, levels })}`);
      }
      if (ancestor.clipPath !== "none") {
        if (!ancestor.clipPathBounds || !contains(ancestor.clipPathBounds, outer.capture)) {
          throw new Error(`parity capture crosses or cannot verify a native Webview clip-path: ${
            JSON.stringify({ ancestor, levels })
          }`);
        }
      }
    }
    currentCapture = outer.capture;
    childViewport = outer.browser;
    topBrowser = outer.browser;
    currentFrame = parentFrame;
  }
  if (currentFrame !== page.mainFrame() || !topBrowser) {
    throw new Error(`parity capture did not resolve to the top browser frame: ${JSON.stringify({ levels })}`);
  }
  const browserViewport = page.viewportSize();
  if (!browserViewport
    || browserViewport.width !== topBrowser.width
    || browserViewport.height !== topBrowser.height) {
    throw new Error(`top parity browser viewport is unavailable or unstable: ${
      JSON.stringify({ browserViewport, topBrowser, levels })
    }`);
  }
}

export async function prepareVisualParityCapture(
  page: Page,
  sourceUri: string,
  position: { readonly line: number; readonly character: number },
  marker: string,
  readRendererState: ReadBenchmarkRendererState,
): Promise<void> {
  const preview = await revealPreviewFrame(page, sourceUri);
  await positionPreviewAtMarker(page, preview, position, marker, readRendererState);
}

async function currentEditorSelection(page: Page): Promise<{
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
} | null> {
  return await invokeMmtE2E(page, "preview", "interactionFixture", {
    action: "editor-selection",
  }) as {
    readonly uri: string;
    readonly range: {
      readonly start: { readonly line: number; readonly character: number };
      readonly end: { readonly line: number; readonly character: number };
    };
  } | null;
}

export async function captureVisualParity(
  page: Page,
  sourceUri: string,
  position: { readonly line: number; readonly character: number },
  editedMarker: string,
  expectedImageNodes: number,
  readRendererState: ReadBenchmarkRendererState,
  snapshotArtifactDirectory?: string,
): Promise<VisualParitySnapshot> {
  const preview = await revealPreviewFrame(page, sourceUri);
  await canonicalizeParityViewport(preview);
  await positionPreviewAtMarker(page, preview, position, editedMarker, readRendererState);
  const state = await readRendererState();
  if (!state.cursor) throw new Error(`preview marker '${editedMarker}' has no positioned cursor`);
  const imageIdentity = await capturePreviewImageIdentity(preview);
  expect(imageIdentity.nodes).toBe(expectedImageNodes);
  await assertParityCaptureGeometry(page, preview);
  const overlays = preview.locator(".preview-cursor, .preview-indicator");
  await overlays.evaluateAll((elements) => {
    for (const element of elements) (element as HTMLElement).style.visibility = "hidden";
  });
  await preview.locator("body").evaluate(() => {
    window.getSelection()?.removeAllRanges();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  let viewportPixelDigest: string;
  let viewportPngBase64: string;
  try {
    const screenshot = await preview.locator(".viewport").screenshot({
      animations: "disabled",
      scale: "css",
    });
    if (screenshot.length < 24 || screenshot.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("parity viewport screenshot is not a valid PNG");
    }
    const screenshotWidth = screenshot.readUInt32BE(16);
    const screenshotHeight = screenshot.readUInt32BE(20);
    if (screenshotWidth !== PARITY_VIEWPORT_WIDTH || screenshotHeight !== PARITY_VIEWPORT_HEIGHT) {
      throw new Error(
        `parity viewport screenshot is ${screenshotWidth}x${screenshotHeight}; `
        + `expected ${PARITY_VIEWPORT_WIDTH}x${PARITY_VIEWPORT_HEIGHT}`,
      );
    }
    viewportPixelDigest = createHash("sha256").update(screenshot).digest("hex");
    viewportPngBase64 = screenshot.toString("base64");
    if (snapshotArtifactDirectory) {
      await mkdir(snapshotArtifactDirectory, { recursive: true });
      await writeFile(path.join(snapshotArtifactDirectory, `viewport-${state.visualKind ?? "unknown"}-${editedMarker}.png`), screenshot);
    }
  } finally {
    await overlays.evaluateAll((elements) => {
      for (const element of elements) (element as HTMLElement).style.removeProperty("visibility");
    });
  }

  const dom = await preview.locator("body").evaluate(async (body, { editedMarker }) => {
    const pageNode = body.querySelector(".page");
    const root = pageNode ? [...pageNode.children].find((child): child is SVGSVGElement => child instanceof SVGSVGElement) : undefined;
    if (!root) throw new Error("preview visual root is unavailable");
    const selectableText = ([...root.querySelectorAll(".tsel")]
      .find((node) => node.textContent?.includes(editedMarker))
      ?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!selectableText) throw new Error(`preview edited marker '${editedMarker}' is unavailable`);
    const encoded = new TextEncoder().encode(selectableText);
    const source = encoded.buffer instanceof ArrayBuffer
      && encoded.byteOffset === 0
      && encoded.byteLength === encoded.buffer.byteLength
      ? encoded.buffer
      : encoded.slice().buffer;
    const digest = await crypto.subtle.digest("SHA-256", source);
    return {
      rootViewBox: (root.getAttribute("viewBox") ?? "").split(/[ ,]+/).filter(Boolean).map(Number),
      selectableTextDigest: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""),
      selectableTextLength: selectableText.length,
    };
  }, { editedMarker });

  const navigationPoint = state.cursor;
  const navigated = await invokeMmtE2E(page, "preview", "interactionFixture", {
    action: "navigate",
    point: navigationPoint,
  });
  if (!navigated) throw new Error(`preview marker has no reverse location: ${JSON.stringify({ position, navigationPoint })}`);
  await page.waitForTimeout(1_000);
  const selection = await currentEditorSelection(page);
  if (selection?.range.start.line !== position.line) {
    throw new Error(`preview marker navigation mismatch: ${JSON.stringify({
      expected: position,
      selection,
      interaction: await readRendererState(),
      navigationPoint,
    })}`);
  }
  expect(selection?.uri).toBe(sourceUri);
  if (!state.renderKey || !selection) throw new Error("preview parity snapshot is incomplete");
  const round = (value: number) => Math.round(value * 1_000) / 1_000;
  const snapshot: VisualParitySnapshot = {
    pageCount: state.pageCount,
    pageGeometries: state.pageGeometries.map((geometry) => geometry.viewBox.map(round)),
    rootViewBox: dom.rootViewBox.map(round),
    viewportPixelDigest,
    viewportPngBase64,
    selectableTextDigest: dom.selectableTextDigest,
    selectableTextLength: dom.selectableTextLength,
    imageDigests: imageIdentity.digests,
    imageNodes: imageIdentity.nodes,
    navigation: { uri: selection.uri, line: selection.range.start.line },
  };
  if (snapshotArtifactDirectory) {
    const { viewportPngBase64: _, ...layout } = snapshot;
    void _;
    await writeFile(
      path.join(snapshotArtifactDirectory, `layout-${state.visualKind ?? "unknown"}-${editedMarker}.json`),
      `${JSON.stringify(layout, null, 2)}\n`,
      "utf8",
    );
  }
  return snapshot;
}
