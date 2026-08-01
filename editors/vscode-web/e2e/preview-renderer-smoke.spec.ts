import { expect, test } from "./fixtures";
import { generatedRealReportFixture } from "./preview-performance-fixtures";
import {
  assertRendererFrameTelemetry,
  runWarmBenchmarkMode,
  type BenchmarkRendererState,
} from "./preview-performance-harness";

test("persistent renderer publishes a bounded cold frame and three ordered diffs", { tag: "@preview-renderer-smoke" }, async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const fixture = generatedRealReportFixture();
  const result = await runWarmBenchmarkMode(page, {
    mode: "incremental-renderer",
    fixture,
    warmEditCount: 3,
    captureSnapshots: true,
  });

  assertRendererFrameTelemetry(result.coldSample, { frameKind: "new", generation: 1, baseGeneration: 0 });
  const samples = [result.coldSample, ...result.warmSamples.map(({ sample }) => sample)];
  const states: readonly BenchmarkRendererState[] = [
    result.coldRenderer,
    ...result.warmSamples.map(({ rendererState }) => rendererState),
  ];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const state = states[index]!;
    expect(sample.counters.rendererFrameNew + sample.counters.rendererFrameDiffV1).toBe(1);
    expect(state.renderKey).toBe(sample.renderKey);
    expect(Number.isFinite(sample.stagesMs.visualReady)).toBe(true);
    expect(sample.counters.sourceQueries).toBe(0);
    expect(sample.counters.fullOracleFallbacks).toBe(0);
    expect(sample.counters.queueDepth).toBeLessThanOrEqual(1);
    expect(sample.counters.pageBuffers).toBeLessThanOrEqual(8);
  }
  for (let index = 0; index < result.warmSamples.length; index += 1) {
    const sample = result.warmSamples[index]!;
    assertRendererFrameTelemetry(sample.sample, {
      frameKind: "diff-v1",
      generation: index + 2,
      baseGeneration: index + 1,
    });
    expect(sample.rendererState.rendererSessionId).toBe(result.coldRenderer.rendererSessionId);
    expect(sample.rendererState.backendGeneration).toBe(result.coldRenderer.backendGeneration);
  }

  expect(result.warmSamples.map(({ position }) => position)).toEqual(["START", "MIDDLE", "END"]);
  const snapshots = result.warmSamples.map(({ visualSnapshot }) => {
    expect(visualSnapshot).toBeDefined();
    return visualSnapshot!;
  });
  for (const snapshot of snapshots) {
    expect(snapshot.selectableTextLength).toBeGreaterThan(0);
    expect(snapshot.imageNodes).toBe(fixture.shape.repeatedImages);
    expect(snapshot.imageDigests).toHaveLength(fixture.shape.repeatedImages);
    expect(snapshot.pageCount).toBeGreaterThan(0);
    expect(snapshot.pageGeometries).toHaveLength(snapshot.pageCount);
    expect(snapshot.rootViewBox).toHaveLength(4);
    expect(snapshot.navigation.uri).toBe(snapshots[0]!.navigation.uri);
    expect(snapshot.navigation.line).toBeGreaterThanOrEqual(0);
  }
  expect(new Set(snapshots.map(({ navigation }) => navigation.line)).size).toBe(3);
});
