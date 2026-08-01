import path from "node:path";
import type { PreviewTraceSample } from "../src/previewPerformance.ts";
import { expect, syntheticPreviewDocument, test, waitForPreviewFrame } from "./fixtures";
import { PREVIEW_BENCHMARK_POSITIONS } from "./preview-performance-fixtures";
import { editBenchmarkDocument } from "./preview-performance-harness";
import {
  resetTimings,
  summarize,
  waitForPublishedTrace,
  writeBenchmarkReport,
} from "./preview-performance-metrics";

const REPORT_DIRECTORY = path.resolve(process.env.MMT_PREVIEW_REPORT_DIR ?? "test-results");
const WARM_EDIT_COUNT = 21;

for (const size of ["small", "medium"] as const) {
  test(`${size} warm preview edits report every measured plane`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const name = `synthetic-preview-performance-${size}.mmt`;
    const source = syntheticPreviewDocument(size);
    const report: Record<string, unknown> = {
      schema: "mmt-preview-performance-v1",
      generatedAt: new Date().toISOString(),
      purpose: "plane-trend-evidence",
      qualification: false,
      fixture: {
        size,
        bytes: Buffer.byteLength(source, "utf8"),
        lines: source.split("\n").length,
        warmEdits: WARM_EDIT_COUNT,
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
      const warmSamples: Array<{ position: typeof PREVIEW_BENCHMARK_POSITIONS[number]; sample: PreviewTraceSample }> = [];
      for (let iteration = 0; iteration < WARM_EDIT_COUNT; iteration += 1) {
        const position = PREVIEW_BENCHMARK_POSITIONS[iteration % PREVIEW_BENCHMARK_POSITIONS.length]!;
        const prefix = `PERF-${position}-`;
        const offset = currentSource.indexOf(prefix) + prefix.length;
        expect(offset).toBeGreaterThan(prefix.length - 1);
        const replacement = currentSource[offset] === "A" ? "B" : "A";
        const result = await editBenchmarkDocument(page, offset, replacement, name);
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
      await writeBenchmarkReport(REPORT_DIRECTORY, `preview-performance-${size}.json`, report);
    }
  });
}
