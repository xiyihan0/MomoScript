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

export type SyntheticPreviewSize = "small" | "medium" | "large";

const SYNTHETIC_TARGET_BYTES: Readonly<Record<SyntheticPreviewSize, number>> = Object.freeze({
  small: 2 * 1024,
  medium: 16 * 1024,
  large: 44 * 1024,
});

/** Deterministic generated MMT benchmark input; contains no copied authored source. */
export function syntheticPreviewDocument(size: SyntheticPreviewSize): string {
  const targetBytes = SYNTHETIC_TARGET_BYTES[size];
  const filler: string[] = [];
  let fillerBytes = 0;
  let index = 0;
  while (fillerBytes < targetBytes - 1_536) {
    const page = String(index).padStart(4, "0");
    const line = `// Synthetic parser and compiler benchmark filler ${page}; deterministic payload ${page}.`;
    filler.push(line);
    fillerBytes += Buffer.byteLength(`${line}\n`, "utf8");
    index += 1;
  }
  const chunks: string[][] = [];
  for (let offset = 0; offset < filler.length; offset += 32) {
    const batch = String(offset / 32).padStart(3, "0");
    chunks.push([
      "@typ",
      ...filler.slice(offset, offset + 32),
      "@end",
      `- Synthetic DSL semantic batch ${batch}.`,
    ]);
  }
  const midpoint = Math.floor(chunks.length / 2);
  const source = [
    "- PERF-START-A deterministic start marker.",
    "@typ",
    'Synthetic selectable preview line #image("intro-assets/basic.png", width: 36pt)',
    "#pagebreak()",
    "Synthetic second benchmark page.",
    "@end",
    ...chunks.slice(0, midpoint).flat(),
    "- PERF-MIDDLE-A deterministic midpoint marker.",
    ...chunks.slice(midpoint).flat(),
    "- PERF-END-A deterministic end marker.",
    "",
  ].join("\n");
  if (size === "large") {
    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes < 40 * 1024 || bytes > 50 * 1024) {
      throw new Error(`large synthetic preview fixture must be 40-50 KiB, received ${bytes} bytes`);
    }
  }
  return source;
}

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
  const findRenderedFrame = async (displayedRenderKey: string | null): Promise<Frame | null> => {
    for (const frame of page.frames()) {
      try {
        const owner = await frame.frameElement();
        if (!await owner.isVisible()) continue;
        const ownerBox = await owner.boundingBox();
        if (!ownerBox || ownerBox.width <= 0 || ownerBox.height <= 0) continue;
        const previewPage = frame.locator(".viewport .page").first();
        if (await previewPage.count() === 0) continue;
        if (!await previewPage.isVisible()) continue;
        if (displayedRenderKey && await previewPage.getAttribute("data-render-key") !== displayedRenderKey) continue;
        if (await previewPage.locator("svg").count() > 0) return frame;
      } catch {
        // VS Code replaces the pending Webview iframe after setting its HTML.
      }
    }
    return null;
  };

  const deadline = Date.now() + 90_000;
  const intervals = [100, 250, 500, 1_000];
  let attempt = 0;
  let displayedRenderKey: string | null = null;
  while (true) {
    const state = await previewReadiness(page, sourceUri);
    if (state.stage === "ready") {
      displayedRenderKey = state.displayedRenderKey;
      break;
    }
    if (state.stage === "failed" || state.stage === "runtime-failed") {
      throw new Error(`Preview failed before readiness: ${JSON.stringify(state)}`);
    }
    if (state.stage === "readiness-unavailable") {
      const frame = await findRenderedFrame(null);
      if (frame) return frame;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Preview readiness timed out: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(intervals[Math.min(attempt, intervals.length - 1)]!);
    attempt += 1;
  }
  const frameDeadline = Date.now() + 15_000;
  while (true) {
    const frame = await findRenderedFrame(displayedRenderKey);
    if (frame) return frame;
    if (Date.now() >= frameDeadline) {
      const state = await previewReadiness(page, sourceUri);
      throw new Error(`Preview reached ${state.stage} without a rendered Webview frame: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(100);
  }
}

export { expect };
export type { Download, Frame, Locator, Page, Response } from "@playwright/test";
