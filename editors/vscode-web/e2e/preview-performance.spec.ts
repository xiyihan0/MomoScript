import type { CDPSession, Frame } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PreviewTraceSample, PreviewTraceStage } from "../src/previewPerformance.ts";
import { expect, syntheticPreviewDocument, test, waitForPreviewFrame, type Page } from "./fixtures";

const REPORT_DIRECTORY = path.resolve(process.env.MMT_PREVIEW_REPORT_DIR ?? "test-results");
const REPORT_PATH = path.join(REPORT_DIRECTORY, "preview-performance-large.json");
const DOCUMENT_NAME = "synthetic-preview-performance.mmt";
const WARM_POSITIONS = ["START", "MIDDLE", "END"] as const;
const REAL_REPORT_LINE_COUNT = 973;
const LARGE_WARM_EDIT_COUNT = Number(process.env.MMT_PREVIEW_WARM_EDITS ?? 21);
if (!Number.isSafeInteger(LARGE_WARM_EDIT_COUNT) || LARGE_WARM_EDIT_COUNT < 1) {
  throw new Error("MMT_PREVIEW_WARM_EDITS must be a positive integer");
}
const LARGE_BENCHMARK_MODE = process.env.MMT_PREVIEW_BENCHMARK_MODE ?? "qualification";
if (!new Set(["qualification", "oracle-only", "renderer-only"]).has(LARGE_BENCHMARK_MODE)) {
  throw new Error("MMT_PREVIEW_BENCHMARK_MODE must be 'qualification', 'oracle-only', or 'renderer-only'");
}
const LARGE_STRESS_SETTING = process.env.MMT_PREVIEW_STRESS ?? "1";
if (!new Set(["0", "1"]).has(LARGE_STRESS_SETTING)) {
  throw new Error("MMT_PREVIEW_STRESS must be '0' or '1'");
}
const LARGE_STRESS_ENABLED = LARGE_STRESS_SETTING === "1";

interface GeneratedRealReportFixture {
  readonly source: string;
  readonly shape: {
    readonly lines: number;
    readonly lexicalTokens: number;
    readonly selectableRows: number;
    readonly warmEdits: number;
    readonly repeatedImages: number;
  };
}

function generatedRealReportFixture(): GeneratedRealReportFixture {
  const lines = [
    "@typ",
    "// Inherit the template's auto-height page.",
    "#set text(size: 8pt)",
    "PERF-START-A deterministic report marker. #linebreak()",
    'Synthetic selectable preview line #image("intro-assets/basic.png", width: 12pt) #linebreak()',
  ];
  let repeatedImages = 1;
  const selectableRows = REAL_REPORT_LINE_COUNT - 6;
  for (let index = 0; index < selectableRows - 1; index += 1) {
    const marker = index === Math.floor((selectableRows - 1) / 2) ? " PERF-MIDDLE-A" : "";
    const image = index % 96 === 0 ? ' #image("intro-assets/basic.png", width: 12pt)' : "";
    if (image) repeatedImages += 1;
    lines.push(`Row ${String(index).padStart(4, "0")} selectable token ${String(index).padStart(4, "0")}${marker}${image} #linebreak()`);
  }
  lines.push("PERF-END-A deterministic report marker. #linebreak()", "@end");
  const source = lines.join("\n");
  const bytes = Buffer.byteLength(source, "utf8");
  if (lines.length !== REAL_REPORT_LINE_COUNT || bytes < 40 * 1024 || bytes > 50 * 1024) {
    throw new Error(`generated report fixture must be ${REAL_REPORT_LINE_COUNT} lines and 40-50 KiB, received ${lines.length} lines / ${bytes} bytes`);
  }
  return {
    source,
    shape: {
      lines: lines.length,
      warmEdits: LARGE_WARM_EDIT_COUNT,
      lexicalTokens: source.match(/[A-Za-z0-9_-]+/g)?.length ?? 0,
      selectableRows,
      repeatedImages,
    },
  };
}
const TRACE_STAGES: readonly PreviewTraceStage[] = [
  "rustParse",
  "rustSemantic",
  "rustResolve",
  "rustEmit",
  "rustTypstCheck",
  "rustIndexDigest",
  "projectDelivery",
  "workspaceMirror",
  "materialization",
  "shadowUpdate",
  "typstCompile",
  "svgParseSanitize",
  "domUpdate",
  "locationMeasure",
  "viewportRender",
  "visualReady",
];

for (const size of ["small", "medium"] as const) {
  test(`${size} warm preview edits report every measured plane`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const name = `synthetic-preview-performance-${size}.mmt`;
    const source = syntheticPreviewDocument(size);
    const report: Record<string, unknown> = {
      schema: "mmt-preview-performance-v1",
      generatedAt: new Date().toISOString(),
      fixture: {
        size,
        bytes: Buffer.byteLength(source, "utf8"),
        lines: source.split("\n").length,
      },
    };
    try {
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
      await resetTimings(page);
      const sourceUri = await page.evaluate(({ documentName, text }) => {
        const open = Reflect.get(globalThis, "__mmtOpenWorkspaceDocument");
        if (typeof open !== "function") throw new Error("workspace document fixture is unavailable");
        return open(documentName, text) as Promise<string>;
      }, { documentName: name, text: source });
      await page.getByRole("button", { name: "Typst 预览" }).click();
      await expect.poll(() => page.evaluate((documentName) => {
        const projection = Reflect.get(globalThis, "__mmtLanguageProjectionEntry");
        if (typeof projection !== "function") throw new Error("language projection fixture is unavailable");
        return projection(documentName)?.sourceVersion ?? null;
      }, name), { timeout: 300_000, intervals: [100, 250, 500, 1_000] }).toBeGreaterThan(0);
      const preview = await waitForPreviewFrame(page, sourceUri);
      await expect(preview.locator(".tsel").filter({ hasText: "Synthetic selectable preview line" }).first()).toBeAttached();
      report.cold = await waitForPublishedTrace(page, sourceUri);

      let currentSource = source;
      await resetTimings(page);
      const warmSamples: Array<{ position: typeof WARM_POSITIONS[number]; sample: PreviewTraceSample }> = [];
      for (let iteration = 0; iteration < 21; iteration += 1) {
        const position = WARM_POSITIONS[iteration % WARM_POSITIONS.length]!;
        const prefix = `PERF-${position}-`;
        const offset = currentSource.indexOf(prefix) + prefix.length;
        expect(offset).toBeGreaterThan(prefix.length - 1);
        const replacement = currentSource[offset] === "A" ? "B" : "A";
        const result = await editDocument(page, offset, replacement, name);
        currentSource = `${currentSource.slice(0, offset)}${replacement}${currentSource.slice(offset + 1)}`;
        warmSamples.push({ position, sample: await waitForPublishedTrace(page, sourceUri, result.version) });
      }
      report.warm = {
        samples: warmSamples,
        summary: summarize(warmSamples.map(({ sample }) => sample)),
      };
    } catch (error) {
      report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
      throw error;
    } finally {
      await mkdir(path.dirname(REPORT_PATH), { recursive: true });
      await writeFile(
        path.join(REPORT_DIRECTORY, `preview-performance-${size}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
    }
  });
}

test("large warm preview edits match the full oracle and remain bounded", async ({ page }) => {
  test.setTimeout(40 * 60_000);
  const { source, shape } = generatedRealReportFixture();
  const report: Record<string, unknown> = {
    schema: "mmt-preview-performance-v1",
    generatedAt: new Date().toISOString(),
    fixture: {
      size: "real-report-shape",
      bytes: Buffer.byteLength(source, "utf8"),
      ...shape,
      oneLongPage: true,
    },
    budgets: {
      warmVisualReadyP50Ms: 1_200,
      warmVisualReadyP95Ms: 2_500,
      visualReadyP50Reduction: 0.35,
      visualReadyP95Reduction: 0.25,
      sustainedVisualReadyMs: 1_500,
      queueDepth: 1,
      jsHeapBytes: 256 * 1024 * 1024,
      presentationCpuReduction: 0.7,
      rendererNodeReuse: 0.8,
    },
  };

  try {
    if (LARGE_BENCHMARK_MODE === "renderer-only") {
      const renderer = await runLargeBenchmarkMode(page, "incremental-renderer", source, shape.repeatedImages, LARGE_STRESS_ENABLED);
      report.modes = { incrementalRenderer: renderer.report };
      return;
    }
    const oracle = await runLargeBenchmarkMode(page, "full-oracle", source, shape.repeatedImages, false);
    report.modes = { fullOracle: oracle.report };
    if (LARGE_BENCHMARK_MODE === "oracle-only") return;
    const renderer = await runLargeBenchmarkMode(page, "incremental-renderer", source, shape.repeatedImages, LARGE_STRESS_ENABLED);
    report.modes = { fullOracle: oracle.report, incrementalRenderer: renderer.report };
    const pixelComparisons = await assertVisualParity(page, oracle.paritySamples, renderer.paritySamples);

    const visualReadySummary = (result: LargeBenchmarkModeResult) => percentileSummary(
      result.warmSamples.map(({ sample }) => sample.stagesMs.visualReady ?? Number.POSITIVE_INFINITY),
    );
    const oracleVisualReady = visualReadySummary(oracle);
    const rendererVisualReady = visualReadySummary(renderer);
    const visualReadyP50Reduction = 1 - (rendererVisualReady.p50 ?? Number.POSITIVE_INFINITY)
      / (oracleVisualReady.p50 ?? 0);
    const visualReadyP95Reduction = 1 - (rendererVisualReady.p95 ?? Number.POSITIVE_INFINITY)
      / (oracleVisualReady.p95 ?? 0);
    const taskDuration = (result: LargeBenchmarkModeResult) => percentileSummary(
      result.warmSamples.map(({ cpuMs }) => cpuMs.TaskDuration ?? Number.POSITIVE_INFINITY),
    );
    const oraclePresentation = taskDuration(oracle);
    const rendererPresentation = taskDuration(renderer);
    const presentationReduction = 1 - (rendererPresentation.p50 ?? Number.POSITIVE_INFINITY)
      / (oraclePresentation.p50 ?? 0);
    const reuseRatios = renderer.warmSamples.map(({ sample }) => {
      const total = sample.counters.reusedNodes + sample.counters.patchedNodes;
      return total === 0 ? 1 : sample.counters.reusedNodes / total;
    });
    const reuseSummary = percentileSummary(reuseRatios);
    expect(presentationReduction).toBeGreaterThanOrEqual(0.7);
    expect(visualReadyP50Reduction).toBeGreaterThanOrEqual(0.35);
    expect(visualReadyP95Reduction).toBeGreaterThanOrEqual(0.25);
    expect(Math.min(...reuseRatios)).toBeGreaterThanOrEqual(0.8);
    expect(rendererVisualReady.p50).toBeLessThanOrEqual(1_200);
    expect(renderer.warmSamples.every(({ sample }) => sample.counters.sourceQueries === 0)).toBe(true);
    expect(renderer.warmSamples.every(({ sample }) => sample.counters.fullOracleFallbacks === 0)).toBe(true);
    expect(Math.max(...renderer.warmSamples.map(({ sample }) => sample.counters.pageBuffers))).toBeLessThanOrEqual(8);
    expect(rendererVisualReady.p95).toBeLessThanOrEqual(2_500);
    expect(Math.max(...renderer.warmSamples.map(({ sample }) => sample.counters.queueDepth))).toBeLessThanOrEqual(1);
    if (LARGE_STRESS_ENABLED) {
      expect(renderer.stress?.soakSample.stagesMs.visualReady).toBeLessThanOrEqual(1_500);
      expect(renderer.stress?.heapBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
    }

    report.parity = {
      samples: renderer.paritySamples.length,
      artifactIdentity: "mode-local-render-key-matches-published-trace",
      pageGeometry: "rounded-1e-3",
      textIdentity: "sha256-edited-marker-selectable-text",
      viewportIdentity: "canonical-400x620-actual-composited-webview-pixels-with-bounded-antialias-delta",
      pixelComparisons,
      imageIdentity: "sha256-decoded-image-bytes",
      navigationIdentity: "authored-source-uri-and-line",
      matched: true,
    };
    report.acceptance = {
      visualReady: {
        fullOracle: oracleVisualReady,
        incrementalRenderer: rendererVisualReady,
        p50Reduction: visualReadyP50Reduction,
        p95Reduction: visualReadyP95Reduction,
      },
      ...(LARGE_STRESS_ENABLED ? {
        sustainedVisualReadyMs: renderer.stress?.soakSample.stagesMs.visualReady,
        heapBytes: renderer.stress?.heapBytes,
      } : {}),
      queueDepth: Math.max(...renderer.warmSamples.map(({ sample }) => sample.counters.queueDepth)),
      presentation: {
        metric: "CDP Performance.TaskDuration edit-to-visual-ready",
        fullOracle: oraclePresentation,
        incrementalRenderer: rendererPresentation,
        reduction: presentationReduction,
      },
      rendererNodeReuse: reuseSummary,
    };
  } catch (error) {
    report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
});

type BenchmarkMode = "full-oracle" | "incremental-renderer";

interface BenchmarkRendererState {
  readonly renderKey: string | null;
  readonly visualKind: "svg" | "renderer" | null;
  readonly rendererGeneration: number | null;
  readonly rendererFrameKind: "new" | "diff-v1" | null;
  readonly backendGeneration: number | null;
  readonly rendererSessionId: string | null;
  readonly rendererArtifactDigest: string | null;
  readonly rendererSourceDigest: string | null;
  readonly rendererByteLength: number | null;
  readonly pageCount: number;
  readonly pageGeometries: readonly {
    readonly viewBox: readonly [number, number, number, number];
    readonly cssWidth: number;
    readonly cssHeight: number;
  }[];
  readonly cursor: { readonly pageIndex: number; readonly x: number; readonly y: number } | null;
}

interface VisualParitySnapshot {
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

interface LargeBenchmarkModeResult {
  readonly report: Record<string, unknown>;
  readonly warmSamples: readonly {
    readonly position: typeof WARM_POSITIONS[number];
    readonly sample: PreviewTraceSample;
    readonly cpuMs: Readonly<Record<string, number>>;
  }[];
  readonly paritySamples: readonly VisualParitySnapshot[];
  readonly stress?: { readonly soakSample: PreviewTraceSample; readonly heapBytes: number };
}
interface ViewportPixelComparison {
  readonly width: number;
  readonly height: number;
  readonly differingPixels: number;
  readonly pixelBudget: number;
  readonly maxChannelDelta: number;
  readonly meanAbsoluteChannelDelta: number;
  readonly exactDigestMatch: boolean;
}

function assertRendererFrameTelemetry(
  sample: PreviewTraceSample,
  expected: {
    readonly frameKind: "new" | "diff-v1";
    readonly generation: number;
    readonly baseGeneration: number;
  },
): void {
  expect(sample.counters.rendererFrameNew + sample.counters.rendererFrameDiffV1).toBe(1);
  expect(sample.counters.rendererFrameNew).toBe(expected.frameKind === "new" ? 1 : 0);
  expect(sample.counters.rendererFrameDiffV1).toBe(expected.frameKind === "diff-v1" ? 1 : 0);
  expect(sample.counters.rendererGeneration).toBe(expected.generation);
  expect(sample.counters.rendererBaseGeneration).toBe(expected.baseGeneration);
  if (expected.frameKind === "new") {
    expect(expected.baseGeneration).toBe(0);
  } else {
    expect(expected.baseGeneration).toBeGreaterThan(0);
    expect(expected.generation).toBeGreaterThan(expected.baseGeneration);
  }
}

async function assertVisualParity(
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


async function runLargeBenchmarkMode(
  page: Page,
  mode: BenchmarkMode,
  source: string,
  expectedImageNodes: number,
  stressEnabled: boolean,
): Promise<LargeBenchmarkModeResult> {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  const rendererEnabled = await page.evaluate((enabled) => {
    const configure = Reflect.get(globalThis, "__mmtSetPreviewRendererEnabled");
    if (typeof configure !== "function") throw new Error("preview renderer benchmark control is unavailable");
    return configure(enabled) as boolean;
  }, mode === "incremental-renderer");
  expect(rendererEnabled).toBe(mode === "incremental-renderer");

  await resetTimings(page);
  const sourceUri = await page.evaluate(({ name, text }) => {
    const open = Reflect.get(globalThis, "__mmtOpenWorkspaceDocument");
    if (typeof open !== "function") throw new Error("workspace document fixture is unavailable");
    return open(name, text) as Promise<string>;
  }, { name: DOCUMENT_NAME, text: source });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => page.evaluate((name) => {
    const projection = Reflect.get(globalThis, "__mmtLanguageProjectionEntry");
    if (typeof projection !== "function") throw new Error("language projection fixture is unavailable");
    return projection(name)?.sourceVersion ?? null;
  }, DOCUMENT_NAME), { timeout: 300_000, intervals: [100, 250, 500, 1_000] }).toBeGreaterThan(0);
  let preview = await waitForPreviewFrame(page, sourceUri);
  await expect(preview.locator(".tsel").first()).toBeAttached();
  await expect(preview.locator("svg image").first()).toBeAttached();
  const renderedShape = await preview.locator("body").evaluate((body) => ({
    svgNodes: body.querySelectorAll("svg *").length,
    selectableSpans: body.querySelectorAll(".tsel").length,
    textTokens: body.querySelectorAll(".tsel-token").length,
    hiddenWindowGroups: body.querySelectorAll("[data-mmt-window-hidden]").length,
    imageNodes: body.querySelectorAll("svg image").length,
    pageShells: body.querySelectorAll("[data-page-index], .typst-page").length,
  }));
  expect(renderedShape.imageNodes).toBe(expectedImageNodes);
  const cold = await waitForPublishedTrace(page, sourceUri);
  const coldRenderer = await rendererState(page);
  if (mode === "incremental-renderer") {
    expect(coldRenderer.visualKind).toBe("renderer");
    expect(renderedShape.hiddenWindowGroups).toBeGreaterThan(0);
    expect(renderedShape.svgNodes).toBeLessThan(source.length / 4);
    expect(renderedShape.textTokens).toBeGreaterThan(0);
    expect(coldRenderer.rendererFrameKind).toBe("new");
    expect(coldRenderer.rendererGeneration).toBe(1);
    assertRendererFrameTelemetry(cold, { frameKind: "new", generation: 1, baseGeneration: 0 });
  } else {
    expect(coldRenderer.visualKind).toBe("svg");
    expect(coldRenderer.rendererGeneration).toBeNull();
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  let currentSource = source;
  const warmSamples: Array<{
    position: typeof WARM_POSITIONS[number];
    sample: PreviewTraceSample;
    cpuMs: Readonly<Record<string, number>>;
  }> = [];
  const paritySamples: VisualParitySnapshot[] = [];
  const rendererChain: BenchmarkRendererState[] = [];
  let stress: LargeBenchmarkModeResult["stress"];
  let stressReport: Record<string, unknown> | undefined;

  try {
    await resetTimings(page);
    for (let iteration = 0; iteration < LARGE_WARM_EDIT_COUNT; iteration += 1) {
      const position = WARM_POSITIONS[iteration % WARM_POSITIONS.length]!;
      const prefix = `PERF-${position}-`;
      const offset = currentSource.indexOf(prefix) + prefix.length;
      expect(offset).toBeGreaterThan(prefix.length - 1);
      const replacement = currentSource[offset] === "A" ? "B" : "A";
      const editPosition = {
        line: currentSource.slice(0, offset).split("\n").length - 1,
        character: offset - (currentSource.lastIndexOf("\n", offset - 1) + 1),
      };
      preview = await revealPreviewFrame(page, sourceUri);
      await positionPreviewAtMarker(page, preview, editPosition, `${prefix}${currentSource[offset]}`);
      const cpuBefore = await browserPerformanceMetrics(cdp);
      const result = await editDocument(page, offset, replacement);
      currentSource = `${currentSource.slice(0, offset)}${replacement}${currentSource.slice(offset + 1)}`;
      const sample = await waitForPublishedTrace(page, sourceUri, result.version);
      const cpuAfter = await browserPerformanceMetrics(cdp);
      const state = await rendererState(page);
      expect(state.renderKey).toBe(sample.renderKey);
      if (mode === "incremental-renderer") {
        expect(state.visualKind).toBe("renderer");
        expect(state.rendererFrameKind).toBe("diff-v1");
        expect(state.rendererGeneration).toBe(iteration + 2);
        expect(state.rendererSessionId).toBe(coldRenderer.rendererSessionId);
        expect(state.backendGeneration).toBe(coldRenderer.backendGeneration);
        expect(state.rendererByteLength).toBe(sample.counters.rendererResponseBytes);
        assertRendererFrameTelemetry(sample, {
          frameKind: "diff-v1",
          generation: iteration + 2,
          baseGeneration: iteration + 1,
        });
        rendererChain.push(state);
      } else {
        expect(state.visualKind).toBe("svg");
        expect(state.rendererGeneration).toBeNull();
        expect(sample.counters.rendererResponseBytes).toBe(0);
      }
      preview = await waitForPreviewFrame(page, sourceUri);
      paritySamples.push(await captureVisualParity(
        page,
        preview,
        sourceUri,
        editPosition,
        `${prefix}${replacement}`,
        expectedImageNodes,
      ));
      warmSamples.push({ position, sample, cpuMs: browserPerformanceDelta(cpuBefore, cpuAfter) });
    }

    if (stressEnabled) {
      await resetTimings(page);
      const burstOffset = currentSource.indexOf("PERF-MIDDLE-") + "PERF-MIDDLE-".length;
      let burstVersion = -1;
      for (let index = 0; index < 20; index += 1) {
        ({ version: burstVersion } = await editDocument(page, burstOffset, index % 2 === 0 ? "A" : "B"));
        await page.waitForTimeout(50);
      }
      currentSource = `${currentSource.slice(0, burstOffset)}B${currentSource.slice(burstOffset + 1)}`;
      await waitForPublishedTrace(page, sourceUri, burstVersion);
      await page.waitForTimeout(1_000);
      const burstSamples = await timings(page);
      const burstPublished = burstSamples.filter((sample) => sample.outcome === "published");
      expect(burstPublished).toHaveLength(1);
      expect(burstPublished[0]!.sourceVersion).toBe(burstVersion);
      for (const sample of burstSamples) {
        const frameCount = sample.counters.rendererFrameNew + sample.counters.rendererFrameDiffV1;
        if (sample === burstPublished[0] || frameCount > 0) {
          assertRendererFrameTelemetry(sample, {
            frameKind: "diff-v1",
            generation: LARGE_WARM_EDIT_COUNT + 2,
            baseGeneration: LARGE_WARM_EDIT_COUNT + 1,
          });
        }
      }

      await resetTimings(page);
      const soakOffset = currentSource.indexOf("PERF-END-") + "PERF-END-".length;
      const soak = await page.evaluate(async ({ name, offset }) => {
        const edit = Reflect.get(globalThis, "__mmtEditWorkspaceDocument");
        if (typeof edit !== "function") throw new Error("workspace incremental edit fixture is unavailable");
        let version = -1;
        for (let index = 0; index < 500; index += 1) {
          ({ version } = await edit(name, offset, 1, index % 2 === 0 ? "A" : "B"));
        }
        return { version, replacement: "B" };
      }, { name: DOCUMENT_NAME, offset: soakOffset });
      currentSource = `${currentSource.slice(0, soakOffset)}${soak.replacement}${currentSource.slice(soakOffset + 1)}`;
      const soakSample = await waitForPublishedTrace(page, sourceUri, soak.version);
      assertRendererFrameTelemetry(soakSample, {
        frameKind: "diff-v1",
        generation: LARGE_WARM_EDIT_COUNT + 3,
        baseGeneration: LARGE_WARM_EDIT_COUNT + 2,
      });
      const soakSamples = await timings(page);
      const retained = await retainedState(page);
      expect(soakSamples.length).toBeLessThanOrEqual(512);
      expect(soakSamples.filter((sample) => sample.outcome === "published").every((sample) => sample.sourceVersion === soak.version)).toBe(true);
      expect(retained.timingSamples).toBeLessThanOrEqual(512);
      expect(retained.previewProjects).toBeLessThanOrEqual(1);
      expect(retained.latestProjects).toBeLessThanOrEqual(1);
      expect(retained.artifacts).toBeLessThanOrEqual(64);
      expect(retained.artifactBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(retained.pendingMaterializations).toBe(0);
      expect(retained.activeMaterializations).toBeLessThanOrEqual(1);
      const finalMetrics = await browserPerformanceMetrics(cdp);
      stress = { soakSample, heapBytes: finalMetrics.JSHeapUsedSize ?? Number.POSITIVE_INFINITY };
      rendererChain.push(await rendererState(page));
      stressReport = {
        burst: { finalVersion: burstVersion, samples: burstSamples },
        soak: { finalVersion: soak.version, retained, samples: soakSamples },
      };
    }
  } finally {
    await cdp.detach();
  }

  return {
    report: {
      mode,
      cold,
      coldRenderer,
      renderedShape,
      warm: {
        samples: warmSamples,
        summary: summarize(warmSamples.map(({ sample }) => sample)),
        cpu: summarizeCpu(warmSamples.map(({ cpuMs }) => cpuMs)),
      },
      rendererChain,
      stress: stressReport,
    },
    warmSamples,
    paritySamples,
    ...(stress ? { stress } : {}),
  };
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
    throw new Error(`preview marker positioning failed: ${JSON.stringify({ position, marker, interaction: await rendererState(page) })}`);
  }
  const state = await rendererState(page);
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
  await preview.evaluate(async () => {
    const settle = Reflect.get(globalThis, "__mmtWaitForPreviewViewportSettled");
    if (typeof settle !== "function") throw new Error("preview viewport settle acknowledgement is unavailable");
    await settle();
  });
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
}

async function captureVisualParity(
  page: Page,
  preview: Frame,
  sourceUri: string,
  position: { readonly line: number; readonly character: number },
  editedMarker: string,
  expectedImageNodes: number,
): Promise<VisualParitySnapshot> {
  preview = await revealPreviewFrame(page, sourceUri);
  await canonicalizeParityViewport(preview);
  await positionPreviewAtMarker(page, preview, position, editedMarker);
  const state = await rendererState(page);
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
    await mkdir(REPORT_DIRECTORY, { recursive: true });
    await writeFile(path.join(REPORT_DIRECTORY, `viewport-${state.visualKind ?? "unknown"}-${editedMarker}.png`), screenshot);
    viewportPixelDigest = createHash("sha256").update(screenshot).digest("hex");
    viewportPngBase64 = screenshot.toString("base64");
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
      interaction: await rendererState(page),
      navigationPoint,
    })}`);
  }
  expect(selection?.uri).toBe(sourceUri);
  if (!state.renderKey || !selection) throw new Error("preview parity snapshot is incomplete");
  const round = (value: number) => Math.round(value * 1_000) / 1_000;
  return {
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

async function browserPerformanceMetrics(cdp: CDPSession): Promise<Readonly<Record<string, number>>> {
  const response = await cdp.send("Performance.getMetrics");
  return Object.freeze(Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value])));
}

function browserPerformanceDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries([
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
  ].map((metric) => [metric, Math.max(0, ((after[metric] ?? 0) - (before[metric] ?? 0)) * 1_000)])));
}

function summarizeCpu(samples: readonly Readonly<Record<string, number>>[]): Record<string, unknown> {
  const metrics = new Set(samples.flatMap((sample) => Object.keys(sample)));
  return Object.fromEntries([...metrics].map((metric) => [
    metric,
    percentileSummary(samples.map((sample) => sample[metric] ?? 0)),
  ]));
}

async function editDocument(
  page: Page,
  offset: number,
  replacement: string,
  name = DOCUMENT_NAME,
): Promise<{ readonly version: number }> {
  return page.evaluate(async ({ name, offset: editOffset, replacement: editText }) => {
    const edit = Reflect.get(globalThis, "__mmtEditWorkspaceDocument");
    if (typeof edit !== "function") throw new Error("workspace incremental edit fixture is unavailable");
    return edit(name, editOffset, 1, editText) as Promise<{ version: number }>;
  }, { name, offset, replacement });
}

async function resetTimings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const reset = Reflect.get(globalThis, "__mmtResetPreviewTimings");
    if (typeof reset !== "function") throw new Error("preview timing reset hook is unavailable");
    reset();
  });
}

async function timings(page: Page): Promise<readonly PreviewTraceSample[]> {
  return page.evaluate(() => {
    const read = Reflect.get(globalThis, "__mmtPreviewTimings");
    if (typeof read !== "function") throw new Error("preview timing hook is unavailable");
    return read() as readonly PreviewTraceSample[];
  });
}

async function waitForPublishedTrace(page: Page, sourceUri: string, sourceVersion?: number): Promise<PreviewTraceSample> {
  await expect.poll(async () => {
    const samples = await timings(page);
    return samples.some((sample) => sample.sourceUri === sourceUri
      && sample.outcome === "published"
      && (sourceVersion === undefined || sample.sourceVersion === sourceVersion));
  }, { timeout: 300_000, intervals: [100, 250, 500, 1_000] }).toBe(true);
  const samples = await timings(page);
  const sample = [...samples].reverse().find((candidate) => candidate.sourceUri === sourceUri
    && candidate.outcome === "published"
    && (sourceVersion === undefined || candidate.sourceVersion === sourceVersion));
  if (!sample) throw new Error(`published preview trace ${sourceVersion ?? "cold"} disappeared`);
  return sample;
}

async function rendererState(page: Page): Promise<BenchmarkRendererState> {
  return page.evaluate(async () => {
    const fixture = Reflect.get(globalThis, "__mmtPreviewInteractionFixture");
    if (typeof fixture !== "function") throw new Error("preview interaction fixture is unavailable");
    return fixture({ action: "state" });
  });
}

async function retainedState(page: Page): Promise<{
  readonly timingSamples: number;
  readonly previewProjects: number;
  readonly latestProjects: number;
  readonly artifacts: number;
  readonly artifactBytes: number;
  readonly mappedShadows: number;
  readonly pendingMaterializations: number;
  readonly activeMaterializations: number;
}> {
  return page.evaluate(() => {
    const read = Reflect.get(globalThis, "__mmtPreviewRetainedState");
    if (typeof read !== "function") throw new Error("preview retained-state hook is unavailable");
    return read();
  });
}

function summarize(samples: readonly PreviewTraceSample[]): Record<string, unknown> {
  const stages = Object.fromEntries(TRACE_STAGES.map((stage) => {
    const values = samples.flatMap((sample) => sample.stagesMs[stage] === undefined ? [] : [sample.stagesMs[stage]]);
    return [stage, percentileSummary(values)];
  }));
  const counters = Object.fromEntries(Object.keys(samples[0]?.counters ?? {}).map((counter) => [
    counter,
    samples.map((sample) => sample.counters[counter as keyof PreviewTraceSample["counters"]]),
  ]));
  return { sampleCount: samples.length, stages, counters };
}

function percentileSummary(values: readonly number[]): { readonly count: number; readonly p50?: number; readonly p95?: number } {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

