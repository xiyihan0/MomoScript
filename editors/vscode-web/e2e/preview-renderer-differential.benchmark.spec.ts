import path from "node:path";
import { test } from "./fixtures";
import { generatedRealReportFixture } from "./preview-performance-fixtures";
import { runWarmBenchmarkMode, type WarmBenchmarkModeResult } from "./preview-performance-harness";
import { writeBenchmarkReport } from "./preview-performance-metrics";
import { assertVisualParity, type ViewportPixelComparison } from "./preview-visual-parity";

const REPORT_DIRECTORY = path.resolve(process.env.MMT_PREVIEW_REPORT_DIR ?? "test-results");
const WARM_EDIT_COUNT = 3;

test("renderer matches the full oracle at START MIDDLE and END", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const fixture = generatedRealReportFixture();
  let oracle: WarmBenchmarkModeResult | undefined;
  let renderer: WarmBenchmarkModeResult | undefined;
  let pixelComparisons: readonly ViewportPixelComparison[] | undefined;
  let failure: string | undefined;
  try {
    oracle = await runWarmBenchmarkMode(page, {
      mode: "full-oracle",
      fixture,
      warmEditCount: WARM_EDIT_COUNT,
      captureSnapshots: true,
      snapshotArtifactDirectory: REPORT_DIRECTORY,
    });
    renderer = await runWarmBenchmarkMode(page, {
      mode: "incremental-renderer",
      fixture,
      warmEditCount: WARM_EDIT_COUNT,
      captureSnapshots: true,
      snapshotArtifactDirectory: REPORT_DIRECTORY,
    });
    pixelComparisons = await assertVisualParity(
      page,
      oracle.warmSamples.map(({ visualSnapshot }) => visualSnapshot!),
      renderer.warmSamples.map(({ visualSnapshot }) => visualSnapshot!),
    );
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await writeBenchmarkReport(REPORT_DIRECTORY, "preview-renderer-differential.json", {
      schema: "mmt-preview-performance-v1",
      generatedAt: new Date().toISOString(),
      purpose: "differential-correctness",
      qualification: false,
      fixture: {
        size: "real-report-shape",
        bytes: Buffer.byteLength(fixture.source, "utf8"),
        ...fixture.shape,
        warmEdits: WARM_EDIT_COUNT,
        oneLongPage: true,
      },
      modes: {
        ...(oracle ? { fullOracle: oracle.report } : {}),
        ...(renderer ? { incrementalRenderer: renderer.report } : {}),
      },
      ...(pixelComparisons ? {
        parity: {
          samples: pixelComparisons.length,
          artifactIdentity: "mode-local-render-key-matches-published-trace",
          pageGeometry: "rounded-1e-3",
          textIdentity: "sha256-edited-marker-selectable-text",
          viewportIdentity: "canonical-400x620-actual-composited-webview-pixels-with-bounded-antialias-delta",
          pixelComparisons,
          imageIdentity: "sha256-decoded-image-bytes",
          navigationIdentity: "authored-source-uri-and-line",
          matched: true,
        },
      } : {}),
      ...(failure ? { failure } : {}),
    });
  }
});
