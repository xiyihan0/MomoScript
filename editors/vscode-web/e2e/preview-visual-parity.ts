import type { Frame } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, waitForPreviewFrame, type Page } from "./fixtures";
import type { BenchmarkRendererState } from "./preview-performance-harness";

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
  const positioned = await page.evaluate(async ({ position }) => {
    const fixture = Reflect.get(globalThis, "__mmtPreviewInteractionFixture");
    if (typeof fixture !== "function") throw new Error("preview interaction fixture is unavailable");
    return fixture({
      action: "position-live",
      range: {
        start: position,
        end: { line: position.line, character: position.character + 1 },
      },
    }) as Promise<boolean>;
  }, { position });
  if (!positioned) {
    throw new Error(`preview marker positioning failed: ${JSON.stringify({ position, marker, interaction: await readRendererState() })}`);
  }
  const state = await readRendererState();
  expect(state.cursor).not.toBeNull();
  const cursor = preview.locator(".preview-cursor");
  await expect(cursor).toHaveCount(1);
  await cursor.scrollIntoViewIfNeeded();
  const editedText = preview.locator(".tsel").filter({ hasText: marker }).first();
  await expect(editedText).toBeAttached({ timeout: 30_000 });
  await expect(editedText).toBeVisible({ timeout: 30_000 });
  await editedText.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
  await preview.locator(".viewport").evaluate((element) => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    void element;
  }));
  await waitForViewportSettled(preview);
}

async function revealPreviewFrame(page: Page, sourceUri: string): Promise<Frame> {
  const revealed = await page.evaluate(async () => {
    const fixture = Reflect.get(globalThis, "__mmtPreviewInteractionFixture");
    if (typeof fixture !== "function") throw new Error("preview interaction fixture is unavailable");
    return fixture({ action: "reveal" }) as Promise<boolean>;
  });
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
  await preview.locator(".viewport").evaluate((element) => {
    const viewport = element as HTMLElement;
    viewport.style.width = "400px";
    viewport.style.minWidth = "400px";
    viewport.style.maxWidth = "400px";
    viewport.style.flex = "0 0 auto";
    viewport.style.alignSelf = "flex-start";
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "restoreViewport",
        viewport: { pageIndex: 0, x: 0, y: 0, zoom: 1, fitMode: "manual" },
      },
    }));
  });
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
  return page.evaluate(async () => {
    const fixture = Reflect.get(globalThis, "__mmtPreviewInteractionFixture");
    if (typeof fixture !== "function") throw new Error("preview interaction fixture is unavailable");
    return fixture({ action: "editor-selection" });
  });
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
    const screenshot = await preview.locator(".viewport").screenshot({ animations: "disabled" });
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
  const navigated = await page.evaluate(async (point) => {
    const fixture = Reflect.get(globalThis, "__mmtPreviewInteractionFixture");
    if (typeof fixture !== "function") throw new Error("preview interaction fixture is unavailable");
    return fixture({ action: "navigate", point }) as Promise<boolean>;
  }, navigationPoint);
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
