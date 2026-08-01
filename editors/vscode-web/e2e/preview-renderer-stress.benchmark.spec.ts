import path from "node:path";
import { expect, test } from "./fixtures";
import { generatedRealReportFixture } from "./preview-performance-fixtures";
import { runRendererStress, type RendererStressResult } from "./preview-performance-harness";
import { writeBenchmarkReport } from "./preview-performance-metrics";

const REPORT_DIRECTORY = path.resolve(process.env.MMT_PREVIEW_REPORT_DIR ?? "test-results");
const PRECONDITIONING_EDIT_COUNT = 20;

test("renderer remains current and bounded through burst and soak", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const fixture = generatedRealReportFixture();
  let result: RendererStressResult | undefined;
  let failure: string | undefined;
  try {
    result = await runRendererStress(page, fixture);
    expect(result.preconditioning).toHaveLength(PRECONDITIONING_EDIT_COUNT);
    expect(result.burst.traces.filter(({ outcome }) => outcome === "published")).toHaveLength(1);
    expect(result.burst.publishedTrace.sourceVersion).toBe(result.burst.finalVersion);
    expect(result.burst.displayedRendererState.renderKey).toBe(result.burst.publishedTrace.renderKey);
    expect(result.soak.traces.length).toBeLessThanOrEqual(512);
    expect(result.soak.traces.filter(({ outcome }) => outcome === "published")).toHaveLength(1);
    expect(result.soak.publishedTrace.sourceVersion).toBe(result.soak.finalVersion);
    expect(result.soak.displayedRendererState.renderKey).toBe(result.soak.publishedTrace.renderKey);
    expect(result.soak.retainedState.timingSamples).toBeLessThanOrEqual(512);
    expect(result.soak.retainedState.previewProjects).toBeLessThanOrEqual(1);
    expect(result.soak.retainedState.latestProjects).toBeLessThanOrEqual(1);
    expect(result.soak.retainedState.artifacts).toBeLessThanOrEqual(64);
    expect(result.soak.retainedState.artifactBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(result.soak.retainedState.pendingMaterializations).toBe(0);
    expect(result.soak.retainedState.activeMaterializations).toBeLessThanOrEqual(1);
    expect(result.soak.publishedTrace.counters.pageBuffers).toBeLessThanOrEqual(8);
    expect(result.soak.publishedTrace.counters.queueDepth).toBeLessThanOrEqual(1);
    expect(result.soak.publishedTrace.stagesMs.visualReady).toBeLessThanOrEqual(1_500);
    expect(result.soak.heapBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await writeBenchmarkReport(REPORT_DIRECTORY, "preview-renderer-stress.json", {
      schema: "mmt-preview-performance-v1",
      generatedAt: new Date().toISOString(),
      purpose: "renderer-stress",
      qualification: false,
      fixture: {
        size: "real-report-shape",
        bytes: Buffer.byteLength(fixture.source, "utf8"),
        ...fixture.shape,
        warmEdits: PRECONDITIONING_EDIT_COUNT,
        burstEdits: 20,
        soakEdits: 500,
        oneLongPage: true,
      },
      ...(result ? {
        cold: {
          sample: result.coldSample,
          rendererState: result.coldRenderer,
        },
        warm: result.preconditioning,
        burst: result.burst,
        soak: result.soak,
      } : {}),
      ...(failure ? { failure } : {}),
    });
  }
});
