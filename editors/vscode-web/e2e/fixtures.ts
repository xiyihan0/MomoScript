import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Frame, type Page } from "@playwright/test";
import { TINYMIST_WASM_SHA256 } from "../src/runtimeArtifacts.ts";
import type { MmtE2EApi, MmtE2EPreviewReadiness } from "../src/e2eRuntimeBridge.ts";

const tinymistPackage = process.env.TINYMIST_WEB_PKG;
const tinymistWasm = tinymistPackage
  ? await readFile(path.join(tinymistPackage, "tinymist_bg.wasm"))
  : undefined;
if (tinymistWasm) {
  const actualSha256 = createHash("sha256").update(tinymistWasm).digest("hex");
  if (actualSha256 !== TINYMIST_WASM_SHA256) {
    throw new Error(
      `TINYMIST_WEB_PKG must contain the production-pinned Tinymist WASM: expected ${TINYMIST_WASM_SHA256}, received ${actualSha256}`,
    );
  }
}
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

type MmtE2ECallable = (...args: never[]) => unknown;
type MmtE2EDomain = keyof MmtE2EApi;
type MmtE2EMethod<Domain extends MmtE2EDomain> = {
  [Method in keyof MmtE2EApi[Domain]]: MmtE2EApi[Domain][Method] extends MmtE2ECallable ? Method : never;
}[keyof MmtE2EApi[Domain]];
type MmtE2EMethodValue<
  Domain extends MmtE2EDomain,
  Method extends MmtE2EMethod<Domain>,
> = Extract<MmtE2EApi[Domain][Method], MmtE2ECallable>;

export async function invokeMmtE2E<
  Domain extends MmtE2EDomain,
  Method extends MmtE2EMethod<Domain>,
>(
  page: Page,
  domain: Domain,
  method: Method,
  ...args: Parameters<MmtE2EMethodValue<Domain, Method>>
): Promise<Awaited<ReturnType<MmtE2EMethodValue<Domain, Method>>>> {
  return await page.evaluate(
    ({ selectedDomain, selectedMethod, methodArguments }) => {
      const api = globalThis.__mmtE2E;
      if (!api) throw new Error("MomoScript E2E bridge is unavailable");
      const apiDomain = Reflect.get(api, selectedDomain);
      if (!apiDomain || typeof apiDomain !== "object") throw new Error(`MomoScript E2E domain is unavailable: ${String(selectedDomain)}`);
      const candidate = Reflect.get(apiDomain, selectedMethod);
      if (typeof candidate !== "function") {
        throw new Error(`MomoScript E2E method is unavailable: ${String(selectedDomain)}.${String(selectedMethod)}`);
      }
      const invoke = candidate as (...values: unknown[]) => unknown;
      return invoke(...methodArguments);
    },
    { selectedDomain: domain, selectedMethod: method, methodArguments: args },
  ) as Awaited<ReturnType<MmtE2EMethodValue<Domain, Method>>>;
}

export type PreviewReadiness = MmtE2EPreviewReadiness;

/* The fallback preserves startup diagnostics before the bridge can be installed. */
const unavailablePreviewReadiness = (sourceUri?: string): PreviewReadiness => ({
  stage: "readiness-unavailable",
  sourceUri: sourceUri ?? null,
  displayedSourceUri: null,
  runtimeRecoveryState: "starting",
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
});

export async function previewReadiness(page: Page, sourceUri?: string): Promise<PreviewReadiness> {
  try {
    return await invokeMmtE2E(page, "preview", "readiness", sourceUri);
  } catch (error) {
    if (error instanceof Error && error.message.includes("E2E bridge is unavailable")) {
      return unavailablePreviewReadiness(sourceUri);
    }
    throw error;
  }
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
