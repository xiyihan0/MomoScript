import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Frame, type Page } from "@playwright/test";

const tinymistPackage = process.env.TINYMIST_WEB_PKG;
const tinymistWasm = tinymistPackage
  ? await readFile(path.join(tinymistPackage, "tinymist_bg.wasm"))
  : undefined;
const typstCompilerPackage = process.env.TYPST_COMPILER_WEB_PKG;
const typstCompilerWasm = typstCompilerPackage
  ? await readFile(path.join(typstCompilerPackage, "typst_ts_web_compiler_bg.wasm"))
  : undefined;

export const test = base.extend({
  page: async ({ page }, use) => {
    if (tinymistWasm) {
      await page.route("https://mms-pack.xiyihan.cn/wasm/tinymist/**", async (route) => {
        await route.fulfill({
          status: 200,
          body: tinymistWasm,
          contentType: "application/wasm",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      });
    }
    if (typstCompilerWasm) {
      await page.route("https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/**", async (route) => {
        await route.fulfill({
          status: 200,
          body: typstCompilerWasm,
          contentType: "application/wasm",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      });
    }
    await use(page);
  },
});

export interface PreviewReadiness {
  readonly stage: string;
  readonly sourceUri: string | null;
  readonly displayedSourceUri: string | null;
  readonly runtimeRecoveryState: string;
  readonly runtimeLastFailure: string | null;
  readonly buildStatus: string;
  readonly buildRevision: number | null;
  readonly fixtureActive: boolean;
  readonly containerReady: boolean;
  readonly containerRevision: string | null;
  readonly containerRenderKey: string | null;
  readonly displayedRenderKey: string | null;
  readonly panelOpen: boolean;
  readonly diagnostics: readonly {
    readonly phase: string;
    readonly severity: string;
    readonly message: string;
  }[];
}

export async function previewReadiness(page: Page, sourceUri?: string): Promise<PreviewReadiness> {
  return page.evaluate((requestedSourceUri) => {
    const readiness = Reflect.get(globalThis, "__mmtPreviewReadiness");
    if (typeof readiness !== "function") {
      return {
        stage: "readiness-unavailable",
        sourceUri: requestedSourceUri ?? null,
        displayedSourceUri: null,
        runtimeRecoveryState: "unknown",
        buildStatus: "unknown",
        runtimeLastFailure: null,
        buildRevision: null,
        fixtureActive: false,
        containerReady: false,
        containerRevision: null,
        containerRenderKey: null,
        displayedRenderKey: null,
        panelOpen: false,
        diagnostics: [],
      };
    }
    return readiness(requestedSourceUri) as PreviewReadiness;
  }, sourceUri);
}

export async function waitForPreviewFrame(page: Page, sourceUri?: string): Promise<Frame> {
  const deadline = Date.now() + 90_000;
  const intervals = [100, 250, 500, 1_000];
  let attempt = 0;
  while (true) {
    const state = await previewReadiness(page, sourceUri);
    if (state.stage === "ready") break;
    if (state.stage === "failed" || state.stage === "runtime-failed") {
      throw new Error(`Preview failed before readiness: ${JSON.stringify(state)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Preview readiness timed out: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(intervals[Math.min(attempt, intervals.length - 1)]!);
    attempt += 1;
  }
  const frameDeadline = Date.now() + 15_000;
  while (true) {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator(".viewport .page svg").count() > 0) return frame;
      } catch {
        // VS Code replaces the pending Webview iframe after setting its HTML.
      }
    }
    if (Date.now() >= frameDeadline) {
      const state = await previewReadiness(page, sourceUri);
      throw new Error(`Preview reached ${state.stage} without a rendered Webview frame: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(100);
  }
}

export { expect };
export type { Download, Frame, Locator, Page, Response } from "@playwright/test";
