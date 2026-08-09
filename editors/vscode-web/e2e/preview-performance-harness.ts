import type { PreviewTraceSample } from "../src/previewPerformance.ts";
import { expect, invokeMmtE2E, previewReadiness, waitForPreviewFrame, type Frame, type Page } from "./fixtures";
import {
  PREVIEW_BENCHMARK_DOCUMENT_NAME,
  PREVIEW_BENCHMARK_POSITIONS,
  type GeneratedRealReportFixture,
  type PreviewBenchmarkPosition,
} from "./preview-performance-fixtures";
import {
  browserPerformanceDelta,
  browserPerformanceMetrics,
  resetTimings,
  retainedState,
  summarize,
  summarizeCpu,
  timings,
  waitForPublishedTrace,
  type PreviewRetainedState,
} from "./preview-performance-metrics";
import {
  captureVisualParity,
  prepareVisualParityCapture,
  type VisualParitySnapshot,
} from "./preview-visual-parity";

export type BenchmarkMode = "full-oracle" | "incremental-renderer";

export interface BenchmarkRendererState {
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

export interface BenchmarkRenderedShape {
  readonly svgNodes: number;
  readonly selectableSpans: number;
  readonly textTokens: number;
  readonly hiddenWindowGroups: number;
  readonly imageNodes: number;
  readonly pageShells: number;
}

export interface WarmBenchmarkSample {
  readonly position: PreviewBenchmarkPosition;
  readonly sample: PreviewTraceSample;
  readonly cpuMs: Readonly<Record<string, number>>;
  readonly rendererState: BenchmarkRendererState;
  readonly visualSnapshot?: VisualParitySnapshot;
}

export interface WarmBenchmarkModeResult {
  readonly mode: BenchmarkMode;
  readonly coldSample: PreviewTraceSample;
  readonly coldRenderer: BenchmarkRendererState;
  readonly renderedShape: BenchmarkRenderedShape;
  readonly warmSamples: readonly WarmBenchmarkSample[];
  readonly rendererChain: readonly BenchmarkRendererState[];
  readonly report: Record<string, unknown>;
}

export interface RendererStressPreconditioningSample {
  readonly position: PreviewBenchmarkPosition;
  readonly sample: PreviewTraceSample;
  readonly rendererState: BenchmarkRendererState;
}

export interface RendererStressResult {
  readonly coldSample: PreviewTraceSample;
  readonly coldRenderer: BenchmarkRendererState;
  readonly preconditioning: readonly RendererStressPreconditioningSample[];
  readonly burst: {
    readonly finalVersion: number;
    readonly traces: readonly PreviewTraceSample[];
    readonly publishedTrace: PreviewTraceSample;
    readonly displayedRendererState: BenchmarkRendererState;
  };
  readonly soak: {
    readonly finalVersion: number;
    readonly traces: readonly PreviewTraceSample[];
    readonly publishedTrace: PreviewTraceSample;
    readonly displayedRendererState: BenchmarkRendererState;
    readonly retainedState: PreviewRetainedState;
    readonly heapBytes: number;
  };
}
export interface BenchmarkPreviewDocument {
  readonly documentName: string;
  readonly source: string;
  readonly rendererEnabled?: boolean;
}

export interface BenchmarkPreviewDocumentResult {
  readonly sourceUri: string;
  readonly preview: Frame;
}


export function assertRendererFrameTelemetry(
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

export async function rendererState(page: Page): Promise<BenchmarkRendererState> {
  return await invokeMmtE2E(page, "preview", "interactionFixture", { action: "state" }) as BenchmarkRendererState;
}

export async function editBenchmarkDocument(
  page: Page,
  offset: number,
  replacement: string,
  name = PREVIEW_BENCHMARK_DOCUMENT_NAME,
): Promise<{ readonly version: number }> {
  return invokeMmtE2E(page, "workspace", "editDocument", name, offset, 1, replacement);
}

async function executePreviewCommand(page: Page, sourceUri: string): Promise<void> {
  await invokeMmtE2E(page, "preview", "open", sourceUri);
}

async function previewRequestStarted(page: Page, sourceUri: string): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  do {
    const { stage } = await previewReadiness(page, sourceUri);
    if (stage !== "idle" && stage !== "project-idle") return true;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return false;
}
async function ensurePreviewRequestStarted(page: Page, sourceUri: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await previewRequestStarted(page, sourceUri)) return;
    await executePreviewCommand(page, sourceUri);
  }
  if (await previewRequestStarted(page, sourceUri)) return;
  throw new Error(`preview command stayed idle after startup retries: ${JSON.stringify(await previewReadiness(page, sourceUri))}`);
}


export async function openBenchmarkPreview(
  page: Page,
  options: BenchmarkPreviewDocument,
): Promise<BenchmarkPreviewDocumentResult> {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  if (options.rendererEnabled !== undefined) {
    const configured = await invokeMmtE2E(page, "preview", "setRendererEnabled", options.rendererEnabled);
    expect(configured).toBe(options.rendererEnabled);
  }

  await resetTimings(page);
  const sourceUri = await invokeMmtE2E(page, "workspace", "openDocument", options.documentName, options.source);
  await executePreviewCommand(page, sourceUri);
  await expect.poll(async () => (
    (await invokeMmtE2E(page, "language", "projectionEntry", options.documentName))?.sourceVersion ?? null
  ), { timeout: 300_000, intervals: [100, 250, 500, 1_000] }).toBeGreaterThan(0);
  await ensurePreviewRequestStarted(page, sourceUri);
  return { sourceUri, preview: await waitForPreviewFrame(page, sourceUri) };
}

async function openBenchmarkDocument(
  page: Page,
  fixture: GeneratedRealReportFixture,
  rendererEnabled: boolean,
): Promise<{ readonly sourceUri: string; readonly renderedShape: BenchmarkRenderedShape }> {
  const { sourceUri, preview } = await openBenchmarkPreview(page, {
    documentName: PREVIEW_BENCHMARK_DOCUMENT_NAME,
    source: fixture.source,
    rendererEnabled,
  });
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
  expect(renderedShape.imageNodes).toBe(fixture.shape.repeatedImages);
  return { sourceUri, renderedShape };
}

export async function runWarmBenchmarkMode(
  page: Page,
  options: {
    readonly mode: BenchmarkMode;
    readonly fixture: GeneratedRealReportFixture;
    readonly warmEditCount: number;
    readonly captureSnapshots: boolean;
    readonly snapshotArtifactDirectory?: string;
  },
): Promise<WarmBenchmarkModeResult> {
  const { mode, fixture, warmEditCount, captureSnapshots, snapshotArtifactDirectory } = options;
  const { sourceUri, renderedShape } = await openBenchmarkDocument(page, fixture, mode === "incremental-renderer");
  const coldSample = await waitForPublishedTrace(page, sourceUri);
  const coldRenderer = await rendererState(page);
  if (mode === "incremental-renderer") {
    expect(coldRenderer.visualKind).toBe("renderer");
    expect(renderedShape.hiddenWindowGroups).toBeGreaterThan(0);
    expect(renderedShape.svgNodes).toBeLessThan(fixture.source.length / 4);
    expect(renderedShape.textTokens).toBeGreaterThan(0);
    expect(coldRenderer.rendererFrameKind).toBe("new");
    expect(coldRenderer.rendererGeneration).toBe(1);
    assertRendererFrameTelemetry(coldSample, { frameKind: "new", generation: 1, baseGeneration: 0 });
  } else {
    expect(coldRenderer.visualKind).toBe("svg");
    expect(coldRenderer.rendererGeneration).toBeNull();
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  let currentSource = fixture.source;
  const warmSamples: WarmBenchmarkSample[] = [];
  const rendererChain: BenchmarkRendererState[] = [];
  try {
    await resetTimings(page);
    for (let iteration = 0; iteration < warmEditCount; iteration += 1) {
      const position = PREVIEW_BENCHMARK_POSITIONS[iteration % PREVIEW_BENCHMARK_POSITIONS.length]!;
      const prefix = `PERF-${position}-`;
      const offset = currentSource.indexOf(prefix) + prefix.length;
      expect(offset).toBeGreaterThan(prefix.length - 1);
      const replacement = currentSource[offset] === "A" ? "B" : "A";
      const editPosition = {
        line: currentSource.slice(0, offset).split("\n").length - 1,
        character: offset - (currentSource.lastIndexOf("\n", offset - 1) + 1),
      };
      if (captureSnapshots) {
        await prepareVisualParityCapture(
          page,
          sourceUri,
          editPosition,
          `${prefix}${currentSource[offset]}`,
          () => rendererState(page),
        );
      }
      const cpuBefore = await browserPerformanceMetrics(cdp);
      const result = await editBenchmarkDocument(page, offset, replacement);
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
      const visualSnapshot = captureSnapshots
        ? await captureVisualParity(
          page,
          sourceUri,
          editPosition,
          `${prefix}${replacement}`,
          fixture.shape.repeatedImages,
          () => rendererState(page),
          snapshotArtifactDirectory,
        )
        : undefined;
      warmSamples.push({
        position,
        sample,
        cpuMs: browserPerformanceDelta(cpuBefore, cpuAfter),
        rendererState: state,
        ...(visualSnapshot ? { visualSnapshot } : {}),
      });
    }
  } finally {
    await cdp.detach();
  }

  const reportWarmSamples = warmSamples.map(({ visualSnapshot, ...sample }) => {
    void visualSnapshot;
    return sample;
  });
  return {
    mode,
    coldSample,
    coldRenderer,
    renderedShape,
    warmSamples,
    rendererChain,
    report: {
      mode,
      cold: coldSample,
      coldRenderer,
      renderedShape,
      warm: {
        samples: reportWarmSamples,
        summary: summarize(warmSamples.map(({ sample }) => sample)),
        cpu: summarizeCpu(warmSamples.map(({ cpuMs }) => cpuMs)),
      },
      rendererChain,
    },
  };
}

export async function runRendererStress(
  page: Page,
  fixture: GeneratedRealReportFixture,
): Promise<RendererStressResult> {
  const preconditioningCount = 20;
  const burstEditCount = 20;
  const soakEditCount = 500;
  const { sourceUri } = await openBenchmarkDocument(page, fixture, true);
  const coldSample = await waitForPublishedTrace(page, sourceUri);
  const coldRenderer = await rendererState(page);
  expect(coldRenderer.visualKind).toBe("renderer");
  expect(coldRenderer.rendererFrameKind).toBe("new");
  expect(coldRenderer.rendererGeneration).toBe(1);
  assertRendererFrameTelemetry(coldSample, { frameKind: "new", generation: 1, baseGeneration: 0 });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  let currentSource = fixture.source;
  const preconditioning: RendererStressPreconditioningSample[] = [];
  try {
    await resetTimings(page);
    for (let iteration = 0; iteration < preconditioningCount; iteration += 1) {
      const position = PREVIEW_BENCHMARK_POSITIONS[iteration % PREVIEW_BENCHMARK_POSITIONS.length]!;
      const prefix = `PERF-${position}-`;
      const offset = currentSource.indexOf(prefix) + prefix.length;
      expect(offset).toBeGreaterThan(prefix.length - 1);
      const replacement = currentSource[offset] === "A" ? "B" : "A";
      const result = await editBenchmarkDocument(page, offset, replacement);
      currentSource = `${currentSource.slice(0, offset)}${replacement}${currentSource.slice(offset + 1)}`;
      const sample = await waitForPublishedTrace(page, sourceUri, result.version);
      const state = await rendererState(page);
      expect(state.renderKey).toBe(sample.renderKey);
      expect(state.rendererSessionId).toBe(coldRenderer.rendererSessionId);
      expect(state.backendGeneration).toBe(coldRenderer.backendGeneration);
      assertRendererFrameTelemetry(sample, {
        frameKind: "diff-v1",
        generation: iteration + 2,
        baseGeneration: iteration + 1,
      });
      preconditioning.push({ position, sample, rendererState: state });
    }

    await resetTimings(page);
    const burstOffset = currentSource.indexOf("PERF-MIDDLE-") + "PERF-MIDDLE-".length;
    let burstVersion = -1;
    for (let index = 0; index < burstEditCount; index += 1) {
      ({ version: burstVersion } = await editBenchmarkDocument(page, burstOffset, index % 2 === 0 ? "A" : "B"));
      await page.waitForTimeout(50);
    }
    currentSource = `${currentSource.slice(0, burstOffset)}B${currentSource.slice(burstOffset + 1)}`;
    await waitForPublishedTrace(page, sourceUri, burstVersion);
    await page.waitForTimeout(1_000);
    const burstTraces = await timings(page);
    const burstPublished = burstTraces.filter((sample) => sample.outcome === "published");
    expect(burstPublished).toHaveLength(1);
    const burstPublishedTrace = burstPublished[0]!;
    expect(burstPublishedTrace.sourceVersion).toBe(burstVersion);
    for (const sample of burstTraces) {
      const frameCount = sample.counters.rendererFrameNew + sample.counters.rendererFrameDiffV1;
      if (sample === burstPublishedTrace || frameCount > 0) {
        assertRendererFrameTelemetry(sample, {
          frameKind: "diff-v1",
          generation: preconditioningCount + 2,
          baseGeneration: preconditioningCount + 1,
        });
      }
    }
    const burstRendererState = await rendererState(page);
    expect(burstRendererState.renderKey).toBe(burstPublishedTrace.renderKey);
    const burstPosition = {
      line: currentSource.slice(0, burstOffset).split("\n").length - 1,
      character: burstOffset - (currentSource.lastIndexOf("\n", burstOffset - 1) + 1),
    };
    await prepareVisualParityCapture(
      page,
      sourceUri,
      burstPosition,
      "PERF-MIDDLE-B",
      () => rendererState(page),
    );
    const burstPreview = await waitForPreviewFrame(page, sourceUri);
    await expect(burstPreview.locator(".tsel").filter({ hasText: "PERF-MIDDLE-B" }).first()).toContainText("PERF-MIDDLE-B", { timeout: 30_000 });

    await resetTimings(page);
    const soakOffset = currentSource.indexOf("PERF-END-") + "PERF-END-".length;
    let soakVersion = -1;
    for (let index = 0; index < soakEditCount; index += 1) {
      const edited = await invokeMmtE2E(
        page,
        "workspace",
        "editDocument",
        PREVIEW_BENCHMARK_DOCUMENT_NAME,
        soakOffset,
        1,
        index % 2 === 0 ? "A" : "B",
      );
      soakVersion = edited.version;
    }
    const soak = { version: soakVersion, replacement: "B" };
    currentSource = `${currentSource.slice(0, soakOffset)}${soak.replacement}${currentSource.slice(soakOffset + 1)}`;
    const soakPublishedTrace = await waitForPublishedTrace(page, sourceUri, soak.version);
    assertRendererFrameTelemetry(soakPublishedTrace, {
      frameKind: "diff-v1",
      generation: preconditioningCount + 3,
      baseGeneration: preconditioningCount + 2,
    });
    const soakTraces = await timings(page);
    const soakPublished = soakTraces.filter((sample) => sample.outcome === "published");
    expect(soakPublished).toHaveLength(1);
    expect(soakPublished[0]!.sourceVersion).toBe(soak.version);
    const retained = await retainedState(page);
    const finalMetrics = await browserPerformanceMetrics(cdp);
    const soakRendererState = await rendererState(page);
    expect(soakRendererState.renderKey).toBe(soakPublishedTrace.renderKey);
    return {
      coldSample,
      coldRenderer,
      preconditioning,
      burst: {
        finalVersion: burstVersion,
        traces: burstTraces,
        publishedTrace: burstPublishedTrace,
        displayedRendererState: burstRendererState,
      },
      soak: {
        finalVersion: soak.version,
        traces: soakTraces,
        publishedTrace: soakPublishedTrace,
        displayedRendererState: soakRendererState,
        retainedState: retained,
        heapBytes: finalMetrics.JSHeapUsedSize ?? Number.POSITIVE_INFINITY,
      },
    };
  } finally {
    await cdp.detach();
  }
}
