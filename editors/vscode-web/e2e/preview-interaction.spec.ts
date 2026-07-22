import { expect, test, type Frame, type Page } from "@playwright/test";

const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454/tinymist_bg.wasm.br?delivery=br-v1";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.8.0-rc3/85a071522388ca99f0cf7f749a287b5578b4c3256ac16014d2894e73e862979a/typst_ts_web_compiler_bg.wasm.br?delivery=br-v1";

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
  await expect.poll(async () => {
    const viewport = (await interactionState(page)).viewport;
    return viewport.fitMode === "manual" && viewport.zoom > 0.1;
  }).toBe(true);
  const introViewport = (await interactionState(page)).viewport;

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
  await expect.poll(async () => (await interactionState(page)).viewport.fitMode).toBe("width");
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

test("MMT Typst blocks can load nested workspace images", async ({ page }) => {
  await page.route("https://**/*", async (route) => {
    const url = route.request().url();
    if (url === TINYMIST_WASM_URL || url === TYPST_COMPILER_WASM_URL) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 120_000 });
  const source = [
    "@typ",
    "12345",
    "#divider()",
    "abcde 123434",
    '#image("intro-assets/basic.png")',
    "@end",
    "",
  ].join("\n");
  const sourceUri = await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtOpenWorkspaceDocument") as Function
  )(name, text), { name: "nested-workspace-image.mmt", text: source });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const previewFrame = await previewWebviewFrame(page);
  await expect(previewFrame.locator("svg image").first()).toBeAttached({ timeout: 60_000 });
  await expect(previewFrame.locator(".tsel").filter({ hasText: "12345" }).first().evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const parentBounds = element.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      fillsForeignObjectWidth: Math.abs(bounds.left - parentBounds.left) <= 0.01
        && Math.abs(bounds.width - parentBounds.width) <= 0.01,
      verticallyCalibrated: style.transform !== "none",
      tokenCount: element.querySelectorAll(":scope > .tsel-token").length,
      fontFamily: style.fontFamily,
      position: style.position,
      width: style.width,
      height: style.height,
      textAlign: style.textAlign,
      textAlignLast: style.textAlignLast,
      userSelect: style.userSelect,
    };
  })).resolves.toEqual({
    fillsForeignObjectWidth: true,
    verticallyCalibrated: true,
    position: "fixed",
    width: "187.5px",
    height: "62.5px",
    textAlign: "left",
    textAlignLast: "left",
    tokenCount: 5,
    fontFamily: "monospace",
    userSelect: "text",
  });
  const selectableText = previewFrame.locator(".tsel").filter({ hasText: "abcde 123434" }).first();
  const selectionGeometry = await selectableText.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const glyphs = [...element.closest(".typst-text")!.querySelectorAll(":scope > use")].slice(0, 5);
    const first = glyphs[0]!.getBoundingClientRect();
    const last = glyphs[4]!.getBoundingClientRect();
    const finalToken = element.querySelectorAll(":scope > .tsel-token")[4]!.getBoundingClientRect();
    return {
      startX: first.left - bounds.left + 1,
      endX: last.right - bounds.left - 1,
      y: (first.top + first.bottom) / 2 - bounds.top,
      finalStartX: finalToken.left - bounds.left + 1,
      finalEndX: finalToken.right - bounds.left - 1,
      finalY: (last.top + last.bottom) / 2 - bounds.top,
    };
  });
  const selectableBounds = await selectableText.boundingBox();
  expect(selectableBounds).not.toBeNull();
  await page.mouse.move(
    selectableBounds!.x + selectionGeometry.startX,
    selectableBounds!.y + selectionGeometry.y,
  );
  await page.mouse.down();
  await page.mouse.move(
    selectableBounds!.x + selectionGeometry.endX,
    selectableBounds!.y + selectionGeometry.y,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect.poll(() => previewFrame.evaluate(() => getSelection()?.toString())).toBe("abcde");
  await previewFrame.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.move(
    selectableBounds!.x + selectionGeometry.finalStartX,
    selectableBounds!.y + selectionGeometry.finalY,
  );
  await page.mouse.down();
  await page.mouse.move(
    selectableBounds!.x + selectionGeometry.finalEndX,
    selectableBounds!.y + selectionGeometry.finalY,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(() => previewFrame.evaluate(() => getSelection()?.toString())).toBe("e");
  const finalCharacterAlignmentError = await selectableText.evaluate((element) => {
    const token = element.querySelectorAll(":scope > .tsel-token")[4]!;
    const glyphs = [...element.closest(".typst-text")!.querySelectorAll(":scope > use")];
    const foreignObject = element.parentElement as unknown as SVGForeignObjectElement;
    const foreignBounds = foreignObject.getBoundingClientRect();
    const intrinsicWidth = Number(foreignObject.getAttribute("width"));
    const firstAdvance = Number(glyphs[0]!.getAttribute("x")) / 16;
    const startAdvance = Number(glyphs[4]!.getAttribute("x")) / 16 - firstAdvance;
    const endAdvance = Number(glyphs[5]!.getAttribute("x")) / 16 - firstAdvance;
    const scale = foreignBounds.width / intrinsicWidth;
    const expectedLeft = foreignBounds.left + startAdvance * scale;
    const expectedRight = foreignBounds.left + endAdvance * scale;
    const range = document.createRange();
    range.selectNodeContents(token);
    const actual = range.getBoundingClientRect();
    return Math.max(Math.abs(actual.left - expectedLeft), Math.abs(actual.right - expectedRight));
  });
  expect(finalCharacterAlignmentError).toBeLessThanOrEqual(0.75);
  await expect.poll(() => page.evaluate((uri) => (
    Reflect.get(globalThis, "__mmtPreviewBuildDiagnostics") as Function
  )(uri), sourceUri)).toEqual([]);
});

test("Typst preview keeps its scroll position across source-only rerenders", async ({ page }) => {
  await page.route("https://**/*", async (route) => {
    const url = route.request().url();
    if (url === TINYMIST_WASM_URL || url === TYPST_COMPILER_WASM_URL) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 120_000 });
  const source = [
    "#set page(width: 420pt, height: 260pt)",
    ...Array.from({ length: 10 }, (_, index) => `= Stable page ${index + 1}\n#pagebreak()`),
    "",
  ].join("\n");
  await page.evaluate(({ name, text }) => {
    const openDocument = Reflect.get(globalThis, "__mmtOpenWorkspaceDocument");
    if (typeof openDocument !== "function") throw new Error("workspace document fixture is unavailable");
    return openDocument(name, text);
  }, { name: "scroll-stability.typ", text: source });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const previewFrame = await previewWebviewFrame(page);
  const viewport = previewFrame.locator(".viewport");
  await expect(viewport.locator(".page svg")).toBeVisible();
  const before = await viewport.evaluate((element) => {
    element.scrollTop = Math.min(900, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(before).toBeGreaterThan(100);
  await page.waitForTimeout(250);
  const revision = await page.locator(".workbench-preview").getAttribute("data-preview-revision");
  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function
  )(name, text), { name: "scroll-stability.typ", text: `${source}// source-only edit\n` });
  await expect.poll(() => page.locator(".workbench-preview").getAttribute("data-preview-revision"), { timeout: 60_000 })
    .not.toBe(revision);
  const after = await viewport.evaluate((element) => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  await callFixture(page, { action: "overlay", point: { pageIndex: 0, x: 0.5, y: 0.5 } });
  await expect(viewport.locator(".preview-indicator")).toBeVisible();
  await page.waitForTimeout(250);
  const afterIndicator = await viewport.evaluate((element) => element.scrollTop);
  expect(Math.abs(afterIndicator - after)).toBeLessThanOrEqual(2);
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
