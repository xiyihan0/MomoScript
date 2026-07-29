import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PreviewTraceSample, PreviewTraceStage } from "../src/previewPerformance.ts";
import { expect, syntheticPreviewDocument, test, waitForPreviewFrame, type Page } from "./fixtures";

const REPORT_DIRECTORY = path.resolve(process.env.MMT_PREVIEW_REPORT_DIR ?? "test-results");
const REPORT_PATH = path.join(REPORT_DIRECTORY, "preview-performance-large.json");
const DOCUMENT_NAME = "synthetic-preview-performance.mmt";
const WARM_POSITIONS = ["START", "MIDDLE", "END"] as const;
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

test("large warm preview edits remain correct, latest-wins, and bounded", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const source = syntheticPreviewDocument("large");
  const report: Record<string, unknown> = {
    schema: "mmt-preview-performance-v1",
    generatedAt: new Date().toISOString(),
    fixture: {
      size: "large",
      bytes: Buffer.byteLength(source, "utf8"),
      lines: source.split("\n").length,
    },
  };

  try {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
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
    await expect(preview.locator(".tsel").filter({ hasText: "Synthetic selectable preview line" }).first()).toBeAttached();
    await expect(preview.locator("svg image").first()).toBeAttached();
    const cold = await waitForPublishedTrace(page, sourceUri);
    report.cold = cold;

    let currentSource = source;
    await resetTimings(page);
    const viewport = preview.locator(".viewport");
    const initialScroll = await viewport.evaluate((element) => {
      element.scrollTop = Math.max(1, element.scrollHeight / 2);
      return element.scrollTop;
    });
    const warmSamples: Array<{ position: typeof WARM_POSITIONS[number]; sample: PreviewTraceSample }> = [];
    for (let iteration = 0; iteration < 21; iteration += 1) {
      const position = WARM_POSITIONS[iteration % WARM_POSITIONS.length]!;
      const prefix = `PERF-${position}-`;
      const offset = currentSource.indexOf(prefix) + prefix.length;
      expect(offset).toBeGreaterThan(prefix.length - 1);
      const replacement = currentSource[offset] === "A" ? "B" : "A";
      const result = await editDocument(page, offset, replacement);
      currentSource = `${currentSource.slice(0, offset)}${replacement}${currentSource.slice(offset + 1)}`;
      const sample = await waitForPublishedTrace(page, sourceUri, result.version);
      warmSamples.push({ position, sample });
      if (iteration === 0) {
        preview = await waitForPreviewFrame(page, sourceUri);
        const restoredScroll = await preview.locator(".viewport").evaluate((element) => element.scrollTop);
        expect(Math.abs(restoredScroll - initialScroll)).toBeLessThanOrEqual(2);
      }
    }
    report.warm = {
      samples: warmSamples,
      summary: summarize(warmSamples.map(({ sample }) => sample)),
    };

    const livePosition = currentSource.slice(0, currentSource.indexOf("Synthetic selectable preview line")).split("\n").length - 1;
    const navigated = await page.evaluate(async ({ line }) => {
      const fixture = Reflect.get(globalThis, "__mmtPreviewInteractionFixture");
      if (typeof fixture !== "function") throw new Error("preview interaction fixture is unavailable");
      return fixture({
        action: "position-live",
        range: { start: { line, character: 0 }, end: { line, character: 8 } },
      }) as Promise<boolean>;
    }, { line: livePosition });
    expect(navigated).toBe(true);
    await expect(preview.locator(".preview-cursor")).toHaveCount(1);


    await resetTimings(page);
    const burstOffset = currentSource.indexOf("PERF-MIDDLE-") + "PERF-MIDDLE-".length;
    let burstVersion = -1;
    for (let index = 0; index < 20; index += 1) {
      ({ version: burstVersion } = await editDocument(page, burstOffset, index % 2 === 0 ? "A" : "B"));
      await page.waitForTimeout(50);
    }
    const burst = { version: burstVersion, replacement: "B" };
    currentSource = `${currentSource.slice(0, burstOffset)}${burst.replacement}${currentSource.slice(burstOffset + 1)}`;
    await waitForPublishedTrace(page, sourceUri, burst.version);
    await page.waitForTimeout(1_000);
    const burstSamples = await timings(page);
    const burstPublished = burstSamples.filter((sample) => sample.outcome === "published");
    expect(burstPublished).toHaveLength(1);
    expect(burstPublished[0]!.sourceVersion).toBe(burst.version);
    report.burst = { finalVersion: burst.version, samples: burstSamples };

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
    await waitForPublishedTrace(page, sourceUri, soak.version);
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
    report.soak = { finalVersion: soak.version, retained, samples: soakSamples };
  } catch (error) {
    report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
});

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

