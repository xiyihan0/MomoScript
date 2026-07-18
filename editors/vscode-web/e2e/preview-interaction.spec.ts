import { expect, test, type Frame, type Page } from "@playwright/test";

const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454/tinymist_bg.wasm?delivery=zstd-v1";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.7.0-rc2/acac51459fa84907843d7a1927ae7b6fc5c743d5de4f61473c866829c9c46e2d/typst_ts_web_compiler_bg.wasm?delivery=zstd-v1";

interface InteractionState {
  readonly renderKey: string | null;
  readonly viewport: { page: number; x: number; y: number; zoom: number; fitMode: "manual" | "width" | "page" };
  readonly status: string | null;
  readonly statusText: string;
  readonly indicatorCount: number;
  readonly cursorCount: number;
  readonly pageCount: number;
}

test("Web and Desktop preview interactions stay artifact-bound", async ({ page }) => {
  await page.route("https://**/*", async (route) => {
    const url = route.request().url();
    if (url === TINYMIST_WASM_URL || url === TYPST_COMPILER_WASM_URL) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect.poll(async () => {
    const startup = await page.evaluate(() => ({
      stage: document.documentElement.dataset.mmtStage,
      error: Reflect.get(globalThis, "__mmtStartupError"),
    }));
    if (startup.stage === "failed") throw new Error(String(startup.error ?? "Editor startup failed"));
    return startup.stage;
  }, { timeout: 120_000 }).toBe("mmt-ready");
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, "__mmtDisplayedPreviewSourceUri")?.())).not.toBeUndefined();

  await callFixture(page, { action: "install-immutable" });
  let desktopPreview = await previewWebviewFrame(page);
  await expect(desktopPreview.getByRole("button", { name: "Fit width" })).toBeVisible();
  await expect(desktopPreview.getByRole("button", { name: "Fit page" })).toBeVisible();
  await desktopPreview.getByRole("button", { name: "Fit page" }).click();
  await expect.poll(async () => (await interactionState(page)).viewport.fitMode).toBe("page");
  await desktopPreview.getByRole("button", { name: "Zoom in" }).click();
  const introViewport = (await interactionState(page)).viewport;
  expect(introViewport.fitMode).toBe("manual");
  expect(introViewport.zoom).toBeGreaterThan(0.1);

  await callFixture(page, { action: "position" });
  await expect.poll(async () => (await interactionState(page)).indicatorCount).toBe(1);
  await expect(desktopPreview.locator(".preview-indicator")).toBeVisible();
  await expect(desktopPreview.locator(".preview-cursor")).toBeVisible();
  const positioned = await interactionState(page);
  expect(positioned.cursorCount).toBe(1);

  expect(await callFixture(page, { action: "navigate", point: { pageIndex: 0, x: 0.2, y: 0.15 } })).toBe(true);
  await callFixture(page, { action: "restart-provider" });
  expect(await callFixture(page, { action: "navigate", point: { pageIndex: 0, x: 0.2, y: 0.15 } })).toBe(true);
  await callFixture(page, { action: "advance-source" });
  const advanced = await interactionState(page);
  expect(advanced.cursorCount).toBe(0);
  expect(advanced.indicatorCount).toBe(0);
  expect(advanced.status).toBe("stale");
  await expect(desktopPreview.locator(".preview-cursor")).toHaveCount(0);
  await expect(desktopPreview.locator(".preview-indicator")).toHaveCount(0);

  await page.evaluate(async () => {
    const openDocument = Reflect.get(globalThis, "__mmtOpenWorkspaceDocument");
    if (typeof openDocument !== "function") throw new Error("workspace document fixture is unavailable");
    await openDocument("interaction-b.typ", "#set page(width: 280pt, height: 180pt)\n= Interaction B\n");
  });
  await callFixture(page, { action: "install-immutable" });
  desktopPreview = await previewWebviewFrame(page);
  await desktopPreview.getByRole("button", { name: "Fit page" }).click();
  expect((await interactionState(page)).viewport.fitMode).toBe("page");
  await page.evaluate(async () => {
    const showDocument = Reflect.get(globalThis, "__mmtShowWorkspaceDocument");
    if (typeof showDocument !== "function") throw new Error("workspace show fixture is unavailable");
    await showDocument("intro.typ");
  });
  await callFixture(page, { action: "install-immutable" });
  desktopPreview = await previewWebviewFrame(page);
  const restoredIntro = (await interactionState(page)).viewport;
  expect(restoredIntro.fitMode).toBe(introViewport.fitMode);
  expect(restoredIntro.zoom).toBe(introViewport.zoom);

  await callFixture(page, { action: "install-provider" });
  desktopPreview = await previewWebviewFrame(page);
  await callFixture(page, { action: "position" });
  await expect(desktopPreview.locator(".preview-cursor")).toBeVisible();
  await callFixture(page, { action: "restart-provider" });
  const rejected = await interactionState(page);
  expect(rejected.status).toBe("stale");
  expect(rejected.cursorCount).toBe(0);
  expect(rejected.indicatorCount).toBe(0);
  expect(await callFixture(page, { action: "navigate", point: { pageIndex: 0, x: 0.2, y: 0.15 } })).toBe(false);
  await expect(desktopPreview.locator(".preview-cursor")).toHaveCount(0);
  await expect(desktopPreview.locator(".preview-indicator")).toHaveCount(0);

  await callFixture(page, { action: "install-immutable" });
  desktopPreview = await previewWebviewFrame(page);
  await expect(desktopPreview.locator(".page svg")).toBeVisible();
  await desktopPreview.getByRole("button", { name: "Fit width" }).click();
  await expect.poll(async () => (await interactionState(page)).viewport.fitMode).toBe("width");
});

async function callFixture(page: Page, request: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async (value) => {
    const fixture = Reflect.get(globalThis, "__mmtPreviewInteractionFixture");
    if (typeof fixture !== "function") throw new Error("preview interaction fixture is unavailable");
    return fixture(value);
  }, request);
}

async function interactionState(page: Page): Promise<InteractionState> {
  return await callFixture(page, { action: "state" }) as InteractionState;
}

async function previewWebviewFrame(page: Page): Promise<Frame> {
  let previewFrame: Frame | undefined;
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator(".viewport .page svg").count() > 0) {
          previewFrame = frame;
          return true;
        }
      } catch {
        // VS Code replaces the pending Webview iframe after setting its HTML.
      }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  if (!previewFrame) throw new Error("rendered preview Webview frame is missing");
  return previewFrame;
}
