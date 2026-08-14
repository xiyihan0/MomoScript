import { expect, invokeMmtE2E, test, type Page, waitForPreviewFrame } from "./fixtures";
import type { PreviewInteractionFixtureRequest } from "../src/e2eRuntimeBridge.ts";

interface InteractionState {
  readonly renderKey: string | null;
  readonly viewport: { page: number; x: number; y: number; zoom: number; fitMode: "manual" | "width" | "page" };
  readonly status: string | null;
  readonly statusText: string;
  readonly indicatorCount: number;
  readonly cursorCount: number;
  readonly pageCount: number;
  readonly visualKind: "svg" | "renderer" | null;
  readonly rendererGeneration: number | null;
  readonly rendererFrameKind: "new" | "diff-v1" | null;
  readonly cursor: { pageIndex: number; x: number; y: number } | null;
}

test("Web and Desktop preview interactions stay artifact-bound", { tag: "@runtime-export" }, async ({ page }) => {
  await page.goto("/");
  await expect.poll(async () => {
    const startup = await page.evaluate(() => ({
      stage: document.documentElement.dataset.mmtStage,
      error: Reflect.get(globalThis, "__mmtStartupError"),
    }));
    if (startup.stage === "failed") throw new Error(String(startup.error ?? "Editor startup failed"));
    return startup.stage;
  }, { timeout: 300_000 }).toBe("mmt-ready");
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => invokeMmtE2E(page, "preview", "displayedSourceUri")).not.toBeUndefined();

  await callFixture(page, { action: "install-immutable" });
  let desktopPreview = await waitForPreviewFrame(page);
  await expect(desktopPreview.locator(".status")).toBeHidden();
  await expect(desktopPreview.locator(".viewport")).toBeVisible();
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

  await invokeMmtE2E(
    page,
    "workspace",
    "openDocument",
    "interaction-b.typ",
    "#set page(width: 280pt, height: 180pt)\n= Interaction B\n",
  );
  await callFixture(page, { action: "install-immutable" });
  desktopPreview = await waitForPreviewFrame(page);
  await expect.poll(async () => (await interactionState(page)).viewport.fitMode).toBe("width");
  await invokeMmtE2E(page, "workspace", "showDocument", "intro.typ");
  await callFixture(page, { action: "install-immutable" });
  desktopPreview = await waitForPreviewFrame(page);
  const restoredIntro = (await interactionState(page)).viewport;
  expect(restoredIntro.fitMode).toBe(introViewport.fitMode);
  expect(restoredIntro.zoom).toBe(introViewport.zoom);

  await callFixture(page, { action: "install-provider" });
  desktopPreview = await waitForPreviewFrame(page);
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
  desktopPreview = await waitForPreviewFrame(page);
  await expect(desktopPreview.locator(".page svg")).toBeVisible();
  await desktopPreview.getByRole("button", { name: "Fit width" }).click();
  await expect.poll(async () => (await interactionState(page)).viewport.fitMode).toBe("width");
});

test("MMT Typst preview supports selectable text, workspace images, and bidirectional navigation", { tag: "@preview-navigation" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  const source = [
    "@typ",
    "12345",
    "#divider()",
    "abcde 123434",
    '#image("intro-assets/basic.png")',
    "@end",
    "",
  ].join("\n");
  const sourceUri = await invokeMmtE2E(page, "workspace", "openDocument", "nested-workspace-image.mmt", source);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const previewFrame = await waitForPreviewFrame(page, sourceUri);
  expect(await interactionState(page)).toMatchObject({
    visualKind: "renderer",
    rendererGeneration: 1,
    rendererFrameKind: "new",
  });
  await expect(previewFrame.locator("svg image").first()).toBeAttached({ timeout: 60_000 });
  await expect(page.locator(".typst-preview-page")).toHaveCount(0);
  await expect(previewFrame.locator("svg")).toHaveCount(1);
  await expect(previewFrame.locator("svg image").first().evaluate(async (element) => {
    const href = element.getAttribute("href") ?? "";
    if (!href.startsWith("blob:")) return { external: false, loaded: false };
    const probe = document.createElement("img");
    const loaded = await new Promise<boolean>((resolve) => {
      probe.addEventListener("load", () => resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0), { once: true });
      probe.addEventListener("error", () => resolve(false), { once: true });
      probe.src = href;
    });
    return { external: true, loaded };
  })).resolves.toEqual({ external: true, loaded: true });

  const digitText = previewFrame.locator(".tsel").filter({ hasText: "12345" }).first();
  await expect(digitText.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const parentBounds = element.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      fillsForeignObject: Math.abs(bounds.left - parentBounds.left) <= 0.01
        && Math.abs(bounds.top - parentBounds.top) <= 0.01
        && Math.abs(bounds.width - parentBounds.width) <= 0.01
        && Math.abs(bounds.height - parentBounds.height) <= 0.01,
      childElementCount: element.childElementCount,
      fontFamily: style.fontFamily,
      overflow: style.overflow,
      position: style.position,
      width: style.width,
      height: style.height,
      textAlign: style.textAlign,
      textAlignLast: style.textAlignLast,
      transform: style.transform,
      userSelect: style.userSelect,
    };
  })).resolves.toEqual({
    fillsForeignObject: true,
    childElementCount: 0,
    fontFamily: "\"Times New Roman\"",
    overflow: "visible",
    position: "fixed",
    width: "187.5px",
    height: "62.5px",
    textAlign: "justify",
    textAlignLast: "justify",
    transform: "none",
    userSelect: "text",
  });
  const selectableText = previewFrame.locator(".tsel").filter({ hasText: "abcde 123434" }).first();
  expect(await selectableText.evaluate((element) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) return null;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    return range.toString();
  })).toBe("abcde");
  expect(await selectableText.evaluate((element) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) return null;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 5);
    return range.toString();
  })).toBe("e");

  const renderedGlyphColor = async () => await selectableText.evaluate((element) => {
    const glyph = element.closest(".typst-text")?.querySelector(":scope > use");
    if (!(glyph instanceof SVGElement)) {
      return null;
    }
    const style = getComputedStyle(glyph);
    return { fill: style.fill, stroke: style.stroke };
  });
  await previewFrame.locator(".preview-toolbar").hover();
  await expect.poll(renderedGlyphColor).not.toEqual({
    fill: "rgb(247, 92, 47)",
    stroke: "rgb(247, 92, 47)",
  });
  await selectableText.hover();
  await expect.poll(renderedGlyphColor).toEqual({
    fill: "rgb(247, 92, 47)",
    stroke: "rgb(247, 92, 47)",
  });
  await previewFrame.locator(".preview-toolbar").hover();
  await expect.poll(renderedGlyphColor).not.toEqual({
    fill: "rgb(247, 92, 47)",
    stroke: "rgb(247, 92, 47)",
  });

  const thirdCharacterGeometry = await digitText.evaluate((element) => {
    const text = element.textContent ?? "";
    const bounds = element.getBoundingClientRect();
    const characterWidth = bounds.width / text.length;
    const style = getComputedStyle(element);
    return {
      point: {
        x: bounds.left + characterWidth * 2.5,
        y: bounds.top + bounds.height / 2,
      },
      characterWidth,
      height: bounds.height,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
    };
  });
  expect(thirdCharacterGeometry.characterWidth > 0 && thirdCharacterGeometry.height > 0, JSON.stringify(thirdCharacterGeometry)).toBe(true);
  await digitText.evaluate((element) => {
    const text = element.textContent ?? "";
    const bounds = element.getBoundingClientRect();
    const characterWidth = bounds.width / text.length;
    const clientX = bounds.left + characterWidth * 2.5;
    const clientY = bounds.top + bounds.height / 2;
    document.getSelection()?.removeAllRanges();
    element.closest(".page")!.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      clientX,
      clientY,
    }));
    element.closest(".page")!.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      clientX,
      clientY,
    }));
    element.closest(".page")!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX,
      clientY,
    }));
  });
  await expect.poll(async () => await callFixture(page, { action: "editor-selection" })).toMatchObject({
    uri: sourceUri,
    range: { start: { line: 1 }, end: { line: 1 } },
  });

  expect(await selectableText.evaluate((element) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Selectable text node is unavailable");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selectionState = { collapsed: selection.isCollapsed, rangeCount: selection.rangeCount };
    const bounds = element.getBoundingClientRect();
    element.closest(".page")!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    return selectionState;
  })).toEqual({ collapsed: false, rangeCount: 1 });
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
  await expect.poll(() => invokeMmtE2E(page, "preview", "buildDiagnostics", sourceUri)).toEqual([]);
});

test("Typst preview keeps its scroll position across source-only rerenders", { tag: "@preview-navigation" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  const source = [
    "#set page(width: 420pt, height: 260pt)",
    ...Array.from({ length: 10 }, (_, index) => `= Stable page ${index + 1}\n#pagebreak()`),
    "",
  ].join("\n");
  const sourceUri = await invokeMmtE2E(page, "workspace", "openDocument", "scroll-stability.typ", source);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const previewFrame = await waitForPreviewFrame(page, sourceUri);
  const viewport = previewFrame.locator(".viewport");
  await expect(viewport.locator(".page svg")).toBeVisible();
  await previewFrame.evaluate(() => {
    const root = document.querySelector(".typst-renderer-root");
    if (!root) throw new Error("renderer root is unavailable");
    Reflect.set(globalThis, "__mmtRendererRootIdentity", root);
  });
  const before = await viewport.evaluate((element) => {
    element.scrollTop = Math.min(900, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(before).toBeGreaterThan(100);
  await page.waitForTimeout(250);
  const rendererGeneration = (await interactionState(page)).rendererGeneration;
  await invokeMmtE2E(page, "workspace", "replaceDocument", "scroll-stability.typ", `${source}// source-only edit\n`);
  await expect.poll(async () => (await interactionState(page)).rendererGeneration, { timeout: 60_000 })
    .not.toBe(rendererGeneration);
  expect(await previewFrame.evaluate(() => (
    Reflect.get(globalThis, "__mmtRendererRootIdentity") === document.querySelector(".typst-renderer-root")
  ))).toBe(true);
  const after = await viewport.evaluate((element) => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  await callFixture(page, { action: "overlay", point: { pageIndex: 0, x: 0.5, y: 0.5 } });
  await expect(viewport.locator(".preview-indicator")).toBeVisible();
  await page.waitForTimeout(250);
  const afterIndicator = await viewport.evaluate((element) => element.scrollTop);
  expect(Math.abs(afterIndicator - after)).toBeLessThanOrEqual(2);
  expect(await previewFrame.evaluate(() => (
    Reflect.get(globalThis, "__mmtRendererRootIdentity") === document.querySelector(".typst-renderer-root")
  ))).toBe(true);
  const retainedShape = async () => previewFrame.evaluate(() => {
    const root = document.querySelector<SVGSVGElement>(".typst-renderer-root");
    if (!root) throw new Error("renderer root is unavailable");
    return {
      nodes: root.querySelectorAll("*").length,
      defsChildren: [...root.querySelectorAll(":scope > defs")]
        .reduce((count, element) => count + element.childElementCount, 0),
      styleRules: [...root.querySelectorAll<HTMLStyleElement>(":scope > style")]
        .reduce((count, element) => count + (element.sheet?.cssRules.length ?? 0), 0),
    };
  });
  const beforeRepeatedScroll = await retainedShape();
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await viewport.evaluate((element, top) => { element.scrollTop = top; }, iteration % 2 === 0 ? 0 : after);
    await page.waitForTimeout(50);
  }
  await viewport.evaluate((element, top) => { element.scrollTop = top; }, after);
  await page.waitForTimeout(250);
  expect(await retainedShape()).toEqual(beforeRepeatedScroll);
  const beforeResync = await interactionState(page);
  expect(await callFixture(page, { action: "resync-renderer" })).toBe(true);
  await invokeMmtE2E(
    page,
    "workspace",
    "replaceDocument",
    "scroll-stability.typ",
    `${source}// source-only edit\n// forced resync\n`,
  );
  await expect.poll(async () => {
    const state = await interactionState(page);
    return state.renderKey !== beforeResync.renderKey && state.rendererFrameKind === "new";
  }, { timeout: 60_000 }).toBe(true);
  expect(await previewFrame.evaluate(() => (
    Reflect.get(globalThis, "__mmtRendererRootIdentity") === document.querySelector(".typst-renderer-root")
  ))).toBe(true);
  expect(Math.abs(await viewport.evaluate((element) => element.scrollTop) - after)).toBeLessThanOrEqual(2);
  await previewFrame.evaluate(() => {
    const scrollViewport = document.querySelector<HTMLElement>(".viewport");
    if (!scrollViewport) throw new Error("preview viewport is unavailable");
    Reflect.set(globalThis, "__mmtNativeScrollTops", []);
    Reflect.set(globalThis, "__mmtRestoreViewportMessages", 0);
    scrollViewport.addEventListener("scroll", () => {
      (Reflect.get(globalThis, "__mmtNativeScrollTops") as number[]).push(scrollViewport.scrollTop);
    }, { passive: true });
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "restoreViewport") return;
      Reflect.set(
        globalThis,
        "__mmtRestoreViewportMessages",
        Number(Reflect.get(globalThis, "__mmtRestoreViewportMessages")) + 1,
      );
    });
  });
  await page.waitForTimeout(250);
  await previewFrame.evaluate(() => {
    Reflect.set(globalThis, "__mmtNativeScrollTops", []);
    Reflect.set(globalThis, "__mmtRestoreViewportMessages", 0);
  });
  const previewFrameElement = await previewFrame.frameElement();
  const previewFrameBounds = await previewFrameElement.boundingBox();
  if (!previewFrameBounds) throw new Error("preview frame is not visible");
  await page.mouse.move(
    previewFrameBounds.x + previewFrameBounds.width / 2,
    previewFrameBounds.y + previewFrameBounds.height / 2,
  );
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, 180);
    await page.waitForTimeout(45);
  }
  await page.waitForTimeout(500);
  const nativeScroll = await previewFrame.evaluate(() => ({
    tops: Reflect.get(globalThis, "__mmtNativeScrollTops") as number[],
    restoreMessages: Number(Reflect.get(globalThis, "__mmtRestoreViewportMessages")),
  }));
  expect(nativeScroll.restoreMessages).toBe(0);
  expect(nativeScroll.tops.length).toBeGreaterThan(1);
  for (let index = 1; index < nativeScroll.tops.length; index += 1) {
    expect(nativeScroll.tops[index]).toBeGreaterThanOrEqual(nativeScroll.tops[index - 1]!);
  }
  const adaptiveLayout = await previewFrame.evaluate(async () => {
    const toolbar = document.querySelector<HTMLElement>(".preview-toolbar");
    const scrollViewport = document.querySelector<HTMLElement>(".viewport");
    if (!toolbar || !scrollViewport) throw new Error("preview layout is unavailable");
    toolbar.style.height = "80px";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    scrollViewport.scrollTop = Math.min(1_200, scrollViewport.scrollHeight - scrollViewport.clientHeight);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const toolbarBounds = toolbar.getBoundingClientRect();
    const viewportBounds = scrollViewport.getBoundingClientRect();
    const result = {
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      toolbarTop: toolbarBounds.top,
      toolbarBottom: toolbarBounds.bottom,
      viewportTop: viewportBounds.top,
      viewportBottom: viewportBounds.bottom,
      viewportScrollTop: scrollViewport.scrollTop,
      viewportScrollable: scrollViewport.scrollHeight > scrollViewport.clientHeight,
    };
    toolbar.style.removeProperty("height");
    return result;
  });
  expect(adaptiveLayout.documentScrollHeight).toBe(adaptiveLayout.documentClientHeight);
  expect(adaptiveLayout.bodyScrollHeight).toBe(adaptiveLayout.bodyClientHeight);
  expect(adaptiveLayout.toolbarTop).toBe(0);
  expect(Math.abs(adaptiveLayout.viewportTop - adaptiveLayout.toolbarBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(adaptiveLayout.viewportBottom - adaptiveLayout.documentClientHeight)).toBeLessThanOrEqual(1);
  expect(adaptiveLayout.viewportScrollable).toBe(true);
  expect(adaptiveLayout.viewportScrollTop).toBeGreaterThan(0);
});

async function callFixture(page: Page, request: PreviewInteractionFixtureRequest): Promise<unknown> {
  return invokeMmtE2E(page, "preview", "interactionFixture", request);
}

async function interactionState(page: Page): Promise<InteractionState> {
  return await callFixture(page, { action: "state" }) as InteractionState;
}
