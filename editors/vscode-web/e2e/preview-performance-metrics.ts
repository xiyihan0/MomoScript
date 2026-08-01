import type { CDPSession } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PreviewTraceSample, PreviewTraceStage } from "../src/previewPerformance.ts";
import { expect, type Page } from "./fixtures";

export const TRACE_STAGES: readonly PreviewTraceStage[] = [
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

export interface PreviewRetainedState {
  readonly timingSamples: number;
  readonly previewProjects: number;
  readonly latestProjects: number;
  readonly artifacts: number;
  readonly artifactBytes: number;
  readonly mappedShadows: number;
  readonly pendingMaterializations: number;
  readonly activeMaterializations: number;
}

export async function browserPerformanceMetrics(cdp: CDPSession): Promise<Readonly<Record<string, number>>> {
  const response = await cdp.send("Performance.getMetrics");
  return Object.freeze(Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value])));
}

export function browserPerformanceDelta(
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

export function summarizeCpu(samples: readonly Readonly<Record<string, number>>[]): Record<string, unknown> {
  const metrics = new Set(samples.flatMap((sample) => Object.keys(sample)));
  return Object.fromEntries([...metrics].map((metric) => [
    metric,
    percentileSummary(samples.map((sample) => sample[metric] ?? 0)),
  ]));
}

export async function resetTimings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const reset = Reflect.get(globalThis, "__mmtResetPreviewTimings");
    if (typeof reset !== "function") throw new Error("preview timing reset hook is unavailable");
    reset();
  });
}

export async function timings(page: Page): Promise<readonly PreviewTraceSample[]> {
  return page.evaluate(() => {
    const read = Reflect.get(globalThis, "__mmtPreviewTimings");
    if (typeof read !== "function") throw new Error("preview timing hook is unavailable");
    return read() as readonly PreviewTraceSample[];
  });
}

export async function waitForPublishedTrace(page: Page, sourceUri: string, sourceVersion?: number): Promise<PreviewTraceSample> {
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

export async function retainedState(page: Page): Promise<PreviewRetainedState> {
  return page.evaluate(() => {
    const read = Reflect.get(globalThis, "__mmtPreviewRetainedState");
    if (typeof read !== "function") throw new Error("preview retained-state hook is unavailable");
    return read();
  });
}

export function summarize(samples: readonly PreviewTraceSample[]): Record<string, unknown> {
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

export function percentileSummary(values: readonly number[]): { readonly count: number; readonly p50?: number; readonly p95?: number } {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

export async function writeBenchmarkReport(reportDirectory: string, fileName: string, report: unknown): Promise<void> {
  const directory = path.resolve(reportDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
