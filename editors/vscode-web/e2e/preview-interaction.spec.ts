import { expect, test, type Frame, type Page } from "./fixtures";

const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/2dbe1a96f28dee1c580801f760855fffa7644ff30f368d6fc56124177291265d/tinymist_bg.wasm.br?delivery=br-v1";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.8.0-rc3/fff6c8d9852edbfb0374722c139a95a2307de19a666206936232e5f21035836c/typst_ts_web_compiler_bg.wasm.br?delivery=br-v1";

interface InteractionState {
  readonly renderKey: string | null;
  readonly viewport: { page: number; x: number; y: number; zoom: number; fitMode: "manual" | "width" | "page" };
  readonly status: string | null;
  readonly statusText: string;
  readonly indicatorCount: number;
  readonly cursorCount: number;
  readonly pageCount: number;
  readonly cursor: { pageIndex: number; x: number; y: number } | null;
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

test("MMT Typst preview supports selectable text, workspace images, and bidirectional navigation", async ({ page }) => {
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
  await expect(previewFrame.locator(".tsel").filter({ hasText: "12345" }).first().evaluate((element) => (
    element.closest("[data-span]")?.getAttribute("data-span") ?? null
  ))).resolves.toMatch(/^[0-9a-f]+$/);

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
  expect(await selectableText.evaluate((element) => {
    const tokens = element.querySelectorAll(":scope > .tsel-token");
    const range = document.createRange();
    range.setStart(tokens[0]!.firstChild!, 0);
    range.setEnd(tokens[4]!.firstChild!, 1);
    return range.toString();
  })).toBe("abcde");
  expect(await selectableText.evaluate((element) => {
    const token = element.querySelectorAll(":scope > .tsel-token")[4]!;
    const range = document.createRange();
    range.selectNodeContents(token);
    return range.toString();
  })).toBe("e");

  const tokenGeometry = await previewFrame.locator(".tsel").filter({ hasText: "12345" }).first().locator(".tsel-token").nth(2).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const parentStyle = getComputedStyle(element.parentElement!);
    return { width: bounds.width, height: bounds.height, display: style.display, fontSize: style.fontSize, lineHeight: style.lineHeight, parentFontSize: parentStyle.fontSize, parentLineHeight: parentStyle.lineHeight };
  });
  expect(tokenGeometry.width > 0 && tokenGeometry.height > 0, JSON.stringify(tokenGeometry)).toBe(true);
  await previewFrame.locator(".tsel").filter({ hasText: "12345" }).first().locator(".tsel-token").nth(2).evaluate((element) => {
    document.getSelection()?.removeAllRanges();
    const bounds = element.getBoundingClientRect();
    element.closest(".page")!.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    element.closest(".page")!.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    element.closest(".page")!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
  });
  await expect.poll(async () => await callFixture(page, { action: "editor-selection" })).toMatchObject({
    uri: sourceUri,
    range: { start: { line: 1 }, end: { line: 1 } },
  });

  await selectableText.evaluate((element) => {
    const tokens = element.querySelectorAll(":scope > .tsel-token");
    const range = document.createRange();
    range.setStart(tokens[0]!.firstChild!, 0);
    range.setEnd(tokens[4]!.firstChild!, 1);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const bounds = tokens[2]!.getBoundingClientRect();
    element.closest(".page")!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
  });
  await page.waitForTimeout(250);
  await expect(callFixture(page, { action: "editor-selection" })).resolves.toMatchObject({
    uri: sourceUri,
    range: { start: { line: 1 }, end: { line: 1 } },
  });

  expect(await callFixture(page, {
    action: "position-live",
    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
  })).toBe(true);
  await expect(previewFrame.locator(".preview-cursor")).toHaveCount(1);
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
