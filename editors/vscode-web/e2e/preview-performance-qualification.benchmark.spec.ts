import path from "node:path";
import { expect, test } from "./fixtures";
import { generatedRealReportFixture } from "./preview-performance-fixtures";
import { runWarmBenchmarkMode, type WarmBenchmarkModeResult } from "./preview-performance-harness";
import { percentileSummary, writeBenchmarkReport } from "./preview-performance-metrics";
import { assertVisualParity, type ViewportPixelComparison } from "./preview-visual-parity";

const REPORT_DIRECTORY = path.resolve(process.env.MMT_PREVIEW_REPORT_DIR ?? "test-results");
const WARM_EDIT_COUNT = 20;

test("large warm preview edits qualify the renderer against the full oracle", async ({ page }) => {
  test.setTimeout(40 * 60_000);
  const fixture = generatedRealReportFixture();
  const report: Record<string, unknown> = {
    schema: "mmt-preview-performance-v1",
    generatedAt: new Date().toISOString(),
    fixture: {
      size: "real-report-shape",
      bytes: Buffer.byteLength(fixture.source, "utf8"),
      ...fixture.shape,
      warmEdits: WARM_EDIT_COUNT,
      oneLongPage: true,
    },
    budgets: {
      warmVisualReadyP50Ms: 1_200,
      warmVisualReadyP95Ms: 2_500,
      visualReadyP50Reduction: 0.35,
      visualReadyP95Reduction: 0.25,
      queueDepth: 1,
      presentationCpuReduction: 0.7,
      rendererNodeReuse: 0.8,
    },
  };
  let oracle: WarmBenchmarkModeResult | undefined;
  let renderer: WarmBenchmarkModeResult | undefined;
  let pixelComparisons: readonly ViewportPixelComparison[] | undefined;
  try {
    oracle = await runWarmBenchmarkMode(page, {
      mode: "full-oracle",
      fixture,
      warmEditCount: WARM_EDIT_COUNT,
      captureSnapshots: true,
      snapshotArtifactDirectory: REPORT_DIRECTORY,
    });
    report.modes = { fullOracle: oracle.report };
    renderer = await runWarmBenchmarkMode(page, {
      mode: "incremental-renderer",
      fixture,
      warmEditCount: WARM_EDIT_COUNT,
      captureSnapshots: true,
      snapshotArtifactDirectory: REPORT_DIRECTORY,
    });
    report.modes = { fullOracle: oracle.report, incrementalRenderer: renderer.report };
    pixelComparisons = await assertVisualParity(
      page,
      oracle.warmSamples.map(({ visualSnapshot }) => visualSnapshot!),
      renderer.warmSamples.map(({ visualSnapshot }) => visualSnapshot!),
    );

    const oracleVisualReady = percentileSummary(
      oracle.warmSamples.map(({ sample }) => sample.stagesMs.visualReady ?? Number.POSITIVE_INFINITY),
    );
    const rendererVisualReady = percentileSummary(
      renderer.warmSamples.map(({ sample }) => sample.stagesMs.visualReady ?? Number.POSITIVE_INFINITY),
    );
    const visualReadyP50Reduction = 1 - (rendererVisualReady.p50 ?? Number.POSITIVE_INFINITY)
      / (oracleVisualReady.p50 ?? 0);
    const visualReadyP95Reduction = 1 - (rendererVisualReady.p95 ?? Number.POSITIVE_INFINITY)
      / (oracleVisualReady.p95 ?? 0);
    const oraclePresentation = percentileSummary(
      oracle.warmSamples.map(({ cpuMs }) => cpuMs.TaskDuration ?? Number.POSITIVE_INFINITY),
    );
    const rendererPresentation = percentileSummary(
      renderer.warmSamples.map(({ cpuMs }) => cpuMs.TaskDuration ?? Number.POSITIVE_INFINITY),
    );
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
    expect(rendererVisualReady.p95).toBeLessThanOrEqual(2_500);
    expect(renderer.warmSamples.every(({ sample }) => sample.counters.sourceQueries === 0)).toBe(true);
    expect(renderer.warmSamples.every(({ sample }) => sample.counters.fullOracleFallbacks === 0)).toBe(true);
    expect(Math.max(...renderer.warmSamples.map(({ sample }) => sample.counters.pageBuffers))).toBeLessThanOrEqual(8);
    expect(Math.max(...renderer.warmSamples.map(({ sample }) => sample.counters.queueDepth))).toBeLessThanOrEqual(1);

    report.parity = {
      samples: renderer.warmSamples.length,
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
    if (oracle || renderer) {
      report.modes = {
        ...(oracle ? { fullOracle: oracle.report } : {}),
        ...(renderer ? { incrementalRenderer: renderer.report } : {}),
      };
    }
    if (pixelComparisons && !report.parity) {
      report.parity = { pixelComparisons, matched: true };
    }
    await writeBenchmarkReport(REPORT_DIRECTORY, "preview-performance-large.json", report);
  }
});
