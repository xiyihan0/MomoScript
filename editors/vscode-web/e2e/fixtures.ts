import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Frame, type Page } from "@playwright/test";
import { RUNTIME_ORIGIN, TINYMIST_WASM_SHA256 } from "../src/runtimeArtifacts.ts";
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
      await page.route(`${RUNTIME_ORIGIN}/wasm/tinymist/**`, async (route) => {
        await route.fulfill({
          status: 200,
          body: tinymistWasm,
          contentType: "application/wasm",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      });
    }
    if (typstCompilerWasm) {
      await page.route(`${RUNTIME_ORIGIN}/wasm/typst-ts-web-compiler/**`, async (route) => {
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

export async function waitForComposerFrame(page: Page, name: string): Promise<Frame> {
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    guiVisible: true,
    textDocumentCount: 1,
    modelCount: 1,
  });
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    uri: `mmtfs://workspace/${name}`,
    pending: false,
  });
  const frame = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "ready");
  await expect(frame.locator("textarea.composer-input-bridge")).toHaveCount(1);
  return frame;
}

/** A fixture identifies a known rendered fragment; production never locates source by text. */
export function composerText(frame: Frame, fragment: string | RegExp, occurrence = 0) {
  const pattern = typeof fragment === "string"
    ? new RegExp(`^${fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u")
    : fragment;
  return frame.locator(".tsel").filter({ hasText: pattern }).nth(occurrence);
}

/**
 * Read the native SVG glyph origin, not its ink edge or a browser-font/average-width estimate.
 * The renderer's foreignObject width is its exact full-run advance and supplies the final edge.
 */
export async function composerGlyphBoundary(
  frame: Frame,
  fragment: string | RegExp,
  boundary: number | "end",
  occurrence = 0,
  scroll = true,
): Promise<{ x: number; y: number; top: number; bottom: number; lineTop: number; pageIndex: number }> {
  const text = composerText(frame, fragment, occurrence);
  if (scroll) {
    // The renderer virtualizes .tsel runs. Exercise viewport scrolling until this fixture run is materialized.
    await expect.poll(async () => {
      if (await text.count() > 0) return true;
      await frame.locator(".viewport").evaluate((element) => {
        const end = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = element.scrollTop >= end - 1
          ? 0
          : Math.min(end, element.scrollTop + element.clientHeight * 0.8);
      });
      return false;
    }, { intervals: [100, 250, 500], timeout: 30_000 }).toBe(true);
    await text.scrollIntoViewIfNeeded();
  } else {
    await expect(text).toBeAttached();
  }
  return await text.evaluate((element, requested) => {
    const run = element.closest(".typst-text");
    const root = element.closest("svg.typst-renderer-root");
    const foreignObject = element.closest("foreignObject");
    if (!(foreignObject instanceof SVGForeignObjectElement) || !run || !root) {
      throw new Error("The expected native SVG text run is unavailable");
    }
    const glyphs = [...run.querySelectorAll<SVGUseElement>(":scope > use")];
    if (glyphs.length === 0) throw new Error("The expected native SVG glyphs are unavailable");
    const glyph = requested === "end" ? glyphs.at(-1)! : glyphs[requested];
    if (!glyph) throw new Error(`Native glyph boundary ${requested} is unavailable`);
    const transform = requested === "end" ? foreignObject.getScreenCTM() : glyph.getScreenCTM();
    if (!transform) throw new Error("The native SVG glyph transform is unavailable");
    const origin = requested === "end"
      ? new DOMPoint(foreignObject.x.baseVal.value + foreignObject.width.baseVal.value, foreignObject.y.baseVal.value)
      : new DOMPoint(glyph.x.baseVal.value, glyph.y.baseVal.value);
    const point = origin.matrixTransform(transform);
    const ink = glyph.getBoundingClientRect();
    // Reused SVG groups retain DOM identity, not physical page order.
    const pages = [...root.children]
      .filter((candidate): candidate is SVGGraphicsElement => (
        candidate instanceof SVGGraphicsElement && candidate.classList.contains("typst-page")
      ))
      .sort((left, right) => (
        left.transform.baseVal.getItem(0).matrix.f - right.transform.baseVal.getItem(0).matrix.f
      ));
    const pageIndex = pages.findIndex((candidate) => candidate.contains(element));
    if (pageIndex < 0) throw new Error("The native renderer page identity is unavailable");
    return {
      x: point.x,
      y: ink.top + ink.height / 2,
      top: ink.top,
      bottom: ink.bottom,
      lineTop: foreignObject.getBoundingClientRect().top,
      pageIndex,
    };
  }, boundary);
}

export async function clickComposerBoundary(
  page: Page,
  frame: Frame,
  fragment: string | RegExp,
  boundary: number | "end",
  occurrence = 0,
): Promise<void> {
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "ready");
  const point = await composerGlyphBoundary(frame, fragment, boundary, occurrence);
  const iframe = await frame.frameElement();
  const bounds = await iframe.boundingBox();
  if (!bounds) throw new Error("The Composer overlay is not visible");
  await page.mouse.click(bounds.x + point.x, bounds.y + point.y);
  await expect(frame.locator("textarea.composer-input-bridge")).toBeFocused();
}

export { expect };
export type { Download, Frame, Locator, Page, Response } from "@playwright/test";
