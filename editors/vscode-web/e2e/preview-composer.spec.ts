import { readFile } from "node:fs/promises";
import { PACK_BASE_URL, PACK_MANIFEST_URL } from "../src/runtimeArtifacts.ts";
import {
  expect,
  invokeMmtE2E,
  previewReadiness,
  test,
  type Frame,
  type Locator,
  type Page,
  waitForPreviewFrame,
} from "./fixtures";

const manifest = await readFile(new URL("./fixtures/manifest.json", import.meta.url));
const avatar = await readFile(new URL("./fixtures/佳代子.png", import.meta.url));
const AVATAR_URL = new URL("assets/avatar/佳代子.png", PACK_BASE_URL).href;

const ROOT_CONTINUED = "编辑连续消息状态…";
const ROOT_DISPLAY_NAME = "从本条起修改人物显示名…";
const APPLY_FAILED_MESSAGE = "无法应用预览编辑。";
const STALE_MESSAGE = "源码已更改，未应用编辑。";

interface ComposerState {
  readonly targetRequests: number;
  readonly editRequests: number;
  readonly applyAttempts: number;
  readonly successfulApplies: number;
}

interface OpenedPreview {
  readonly sourceUri: string;
  readonly frame: Frame;
}

interface ScrollTopology {
  readonly scrollContainers: readonly string[];
  readonly viewport: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
  };
  readonly viewportChildren: readonly string[];
  readonly bodyOverflow: string;
  readonly htmlOverflow: string;
}

test("preview Composer edits continued bytes exactly, rerenders grouping, and records every apply once", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-continued.mmt";
  const original = [
    "> 佳代子: first",
    "> _0: second",
    ">(fill: green,  inset: 5pt) _0: multi",
    "",
  ].join("\n");
  const forcedSecond = [
    "> 佳代子: first",
    ">(continued: true) _0: second",
    ">(fill: green,  inset: 5pt) _0: multi",
    "",
  ].join("\n");
  const newSecond = forcedSecond.replace("continued: true", "continued: false");
  const forcedMulti = [
    "> 佳代子: first",
    "> _0: second",
    ">(continued: true, fill: green,  inset: 5pt) _0: multi",
    "",
  ].join("\n");
  const newMulti = forcedMulti.replace("continued: true", "continued: false");

  const opened = await openProviderPreview(page, name, original);
  let frame = opened.frame;
  await expectRenderedTextCount(frame, "佳代子", 1);
  const historyBaseline = await historyEditCountForPath(page, `/${name}`);
  let expectedHistory = historyBaseline;

  frame = await applyContinued(page, frame, opened.sourceUri, name, "second", "强制连续", forcedSecond);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await page.waitForTimeout(5_100);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "second", "强制新消息", newSecond);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 2);
  await page.waitForTimeout(5_100);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "second", "自动", original);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await page.waitForTimeout(5_100);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "multi", "强制连续", forcedMulti);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await page.waitForTimeout(5_100);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "multi", "强制新消息", newMulti);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 2);
  await page.waitForTimeout(5_100);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "multi", "自动", original);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);

  expect(await composerState(page)).toEqual(successfulComposerState());
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(original);
});

test("display-name Composer edits preserve the actor interval and minimally update an adjacent block", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-display-name.mmt";
  const original = [
    "> 佳代子: DISPLAY_BEFORE",
    ">(continued: false) _0: DISPLAY_TARGET",
    ">(continued: false) _0: DISPLAY_AFTER",
    "@actor 佳代子",
    "display-name: 旧称",
    "@end",
    ">(continued: false) 佳代子: ADJACENT_TARGET",
    "",
  ].join("\n");
  const intervalEdited = [
    "> 佳代子: DISPLAY_BEFORE",
    "@actor 佳代子",
    "display-name: 老师",
    "@end",
    ">(continued: false) _0: DISPLAY_TARGET",
    ">(continued: false) _0: DISPLAY_AFTER",
    "@actor 佳代子",
    "display-name: 旧称",
    "@end",
    ">(continued: false) 佳代子: ADJACENT_TARGET",
    "",
  ].join("\n");
  const adjacentEdited = intervalEdited.replace("display-name: 旧称", "display-name: 相邻老师");

  const opened = await openProviderPreview(page, name, original);
  let frame = opened.frame;
  await expectRenderedTextCount(frame, "佳代子", 3);
  await expectRenderedTextCount(frame, "旧称", 1);
  const historyBaseline = await historyEditCountForPath(page, `/${name}`);

  frame = await applyDisplayName(
    page,
    frame,
    opened.sourceUri,
    name,
    "DISPLAY_TARGET",
    "佳代子",
    "老师",
    intervalEdited,
  );
  await expectHistoryCount(page, name, historyBaseline + 1);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await expectRenderedTextCount(frame, "老师", 2);
  await page.waitForTimeout(5_100);
  await expectRenderedTextCount(frame, "旧称", 1);
  await expect(frame.locator(".tsel").filter({ hasText: "DISPLAY_BEFORE" }).first()).toBeVisible();
  await expect(frame.locator(".tsel").filter({ hasText: "DISPLAY_TARGET" }).first()).toBeVisible();
  await expect(frame.locator(".tsel").filter({ hasText: "DISPLAY_AFTER" }).first()).toBeVisible();

  frame = await applyDisplayName(
    page,
    frame,
    opened.sourceUri,
    name,
    "ADJACENT_TARGET",
    "旧称",
    "相邻老师",
    adjacentEdited,
  );
  await expectHistoryCount(page, name, historyBaseline + 2);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await expectRenderedTextCount(frame, "老师", 2);
  await expectRenderedTextCount(frame, "旧称", 0);
  await expectRenderedTextCount(frame, "相邻老师", 1);
  expect(adjacentEdited.match(/@actor 佳代子/g)).toHaveLength(2);
  expect(adjacentEdited).toContain("@actor 佳代子\ndisplay-name: 相邻老师\n@end\n>(continued: false) 佳代子: ADJACENT_TARGET");
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(adjacentEdited);
});

test("a Composer edit persists through reload and Local History restores the exact original source", { tag: ["@preview-composer", "@local-history"] }, async ({ page }) => {
  const name = "composer-persistence.mmt";
  const checkpointName = "Composer 原始源码";
  const original = "> 佳代子: HISTORY_FIRST\n> _0: HISTORY_TARGET\n";
  const edited = "> 佳代子: HISTORY_FIRST\n>(continued: true) _0: HISTORY_TARGET\n";

  const opened = await openProviderPreview(page, name, original);
  await invokeMmtE2E(page, "history", "createCheckpoint", checkpointName);
  const historyBaseline = await historyEditCountForPath(page, `/${name}`);
  await applyContinued(page, opened.frame, opened.sourceUri, name, "HISTORY_TARGET", "强制连续", edited);
  await expectHistoryCount(page, name, historyBaseline + 1);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(edited);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(edited);
  await invokeMmtE2E(page, "workspace", "showDocument", name);
  await expect.poll(async () => (await invokeMmtE2E(page, "workspace", "activeDocument"))?.text).toBe(edited);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  let frame = await waitForPreviewFrame(page, opened.sourceUri);
  await expect(frame.locator(".tsel").filter({ hasText: "HISTORY_TARGET" }).first()).toBeVisible();

  await page.getByRole("tab", { name: "本地历史", exact: true }).click();
  const checkpoint = page.locator(".mms-history-revision", { hasText: checkpointName }).first();
  await expect(checkpoint).toBeVisible();
  let restorePrompt = "";
  page.once("dialog", (dialog) => {
    restorePrompt = dialog.message();
    void dialog.accept();
  });
  await checkpoint.getByRole("button", { name: "恢复整个工作区到此版本" }).click();
  expect(restorePrompt).toContain(`恢复整个工作区到“${checkpointName}”？`);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(original);

  await invokeMmtE2E(page, "workspace", "showDocument", name);
  await expect.poll(async () => (await invokeMmtE2E(page, "workspace", "activeDocument"))?.text).toBe(original);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  frame = await waitForPreviewFrame(page, opened.sourceUri);
  await expect(frame.locator(".tsel").filter({ hasText: "HISTORY_TARGET" }).first()).toBeVisible();
  await expectRenderedTextCount(frame, "佳代子", 1);
});

test("selection, stale documents, rejected apply, and unsupported preview targets never retry or mutate", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-failure-safety.mmt";
  const stableSource = [
    "@document",
    "title: GENERATED_HEADER_ONLY",
    "show-header: true",
    "@end",
    "- NARRATION_TARGET",
    "@reply: REPLY_TARGET_A | REPLY_TARGET_B",
    "@bond: BOND_TARGET",
    "@typ",
    "RAW_TYPST_TARGET",
    "@end",
    "< _0: BUILTIN_TARGET",
    "> 佳代子: SAFE_TARGET",
    "",
  ].join("\n");
  const opened = await openProviderPreview(page, name, stableSource);
  let frame = opened.frame;

  await resetComposer(page);
  const selectionResult = await dispatchSelectedContextMenu(frame, "SAFE_TARGET");
  expect(selectionResult.collapsed).toBe(false);
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual(emptyComposerState());
  await expect(page.locator(".quick-input-widget")).toBeHidden();
  await clearPreviewSelection(frame);

  for (const marker of ["NARRATION_TARGET", "REPLY_TARGET_A", "BOND_TARGET", "RAW_TYPST_TARGET", "GENERATED_HEADER_ONLY"]) {
    await resetComposer(page);
    await rightClickRenderedGlyph(frame, marker);
    await expect.poll(() => composerState(page)).toMatchObject({ targetRequests: 1 });
    await expect(page.locator(".quick-input-widget")).toBeHidden();
    expect(await composerState(page)).toEqual({
      targetRequests: 1,
      editRequests: 0,
      applyAttempts: 0,
      successfulApplies: 0,
    });
    await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(stableSource);
  }

  await resetComposer(page);
  await rightClickRenderedGlyph(frame, "BUILTIN_TARGET");
  const builtinRoot = await visibleQuickInput(page, "编辑预览内容");
  await expect(builtinRoot.getByRole("option", { name: ROOT_CONTINUED, exact: true })).toBeVisible();
  await expect(builtinRoot.getByRole("option", { name: ROOT_DISPLAY_NAME, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(builtinRoot).toBeHidden();
  expect(await composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(stableSource);

  await resetComposer(page);
  await rightClickRenderedGlyph(frame, "SAFE_TARGET");
  const staleRoot = await visibleQuickInput(page, "编辑预览内容");
  const staleRevision = await currentContainerRevision(page, opened.sourceUri);
  const advancedSource = `${stableSource}\n`;
  await invokeMmtE2E(page, "workspace", "editDocument", name, stableSource.length, 0, "\n");
  await expect(staleRoot).toBeHidden();
  await expect(page.getByRole("dialog", { name: STALE_MESSAGE })).toBeVisible();
  await expect.poll(() => composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(advancedSource);
  await expect.poll(() => currentContainerRevision(page, opened.sourceUri)).not.toBe(staleRevision);
  frame = await waitForPreviewFrame(page, opened.sourceUri);

  await resetComposer(page);
  await invokeMmtE2E(page, "composer", "failNextApply");
  const failedRevision = await currentContainerRevision(page, opened.sourceUri);
  const failedHistoryBaseline = await historyEditCountForPath(page, `/${name}`);
  await rightClickRenderedGlyph(frame, "SAFE_TARGET");
  await chooseQuickInputItem(page, "编辑预览内容", ROOT_CONTINUED);
  await chooseQuickInputItem(page, "编辑连续消息状态", "强制连续");
  await expect.poll(() => composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 1,
    applyAttempts: 1,
    successfulApplies: 0,
  });
  await expect(page.getByRole("dialog", { name: APPLY_FAILED_MESSAGE })).toBeVisible();
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(advancedSource);
  expect(await currentContainerRevision(page, opened.sourceUri)).toBe(failedRevision);
  await expectHistoryCount(page, name, failedHistoryBaseline);

  const unresolvedSource = "> 不存在: SAFE_TARGET\n";
  const unresolvedRevision = await currentContainerRevision(page, opened.sourceUri);
  await invokeMmtE2E(page, "workspace", "replaceDocument", name, unresolvedSource);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(unresolvedSource);
  await expect.poll(() => currentContainerRevision(page, opened.sourceUri)).not.toBe(unresolvedRevision);
  const acceptedUnresolvedRevision = await currentContainerRevision(page, opened.sourceUri);
  frame = await waitForPreviewFrame(page, opened.sourceUri);
  await resetComposer(page);
  const unresolvedPage = frame.locator(".page");
  await expect(unresolvedPage).toBeVisible();
  await unresolvedPage.click({ button: "right", position: { x: 20, y: 20 } });
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await expect(page.locator(".quick-input-widget")).toBeHidden();

  await invokeMmtE2E(page, "workspace", "replaceDocument", name, advancedSource);
  await expect.poll(() => currentContainerRevision(page, opened.sourceUri)).not.toBe(acceptedUnresolvedRevision);
  frame = await waitForPreviewFrame(page, opened.sourceUri);

  const invalidSources = [
    "not syntax",
    "> 佳代子: first\n>(continued: true,, fill: green) _0: SAFE_TARGET\n",
    "> 佳代子: first\n>(continued: true, continued: false) _0: SAFE_TARGET\n",
  ] as const;

  for (const invalidSource of invalidSources) {
    await resetComposer(page);
    await rightClickRenderedGlyph(frame, "SAFE_TARGET");
    await expect.poll(() => composerState(page)).toMatchObject({ targetRequests: 1 });
    const root = await visibleQuickInput(page, "编辑预览内容");

    await invokeMmtE2E(page, "workspace", "replaceDocument", name, invalidSource);
    await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(invalidSource);
    await expect(root).toBeHidden();
    expect(await composerState(page)).toEqual({
      targetRequests: 1,
      editRequests: 0,
      applyAttempts: 0,
      successfulApplies: 0,
    });

    const retainedRevision = await currentContainerRevision(page, opened.sourceUri);
    await invokeMmtE2E(page, "workspace", "replaceDocument", name, advancedSource);
    await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(advancedSource);
    await expect.poll(() => currentContainerRevision(page, opened.sourceUri)).not.toBe(retainedRevision);
    frame = await waitForPreviewFrame(page, opened.sourceUri);
    await expect(frame.locator(".tsel").filter({ hasText: "SAFE_TARGET" }).first()).toBeVisible();
  }
});

test("native Composer Quick Input stays usable at 240–320px without changing preview scroll topology", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-responsive.mmt";
  const source = "> 佳代子: RESPONSIVE_FIRST\n> _0: RESPONSIVE_TARGET\n";
  await page.setViewportSize({ width: 320, height: 700 });
  const opened = await openProviderPreview(page, name, source);
  const frame = opened.frame;

  for (const width of [320, 240]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(frame.locator(".viewport")).toBeVisible();
    const baseline = await previewScrollTopology(frame);
    expect(baseline.scrollContainers).toEqual(["main.viewport"]);
    expect(baseline.viewportChildren).toEqual(["article.page.renderer-active"]);
    expect(baseline.bodyOverflow).toBe("hidden");
    expect(baseline.htmlOverflow).toBe("hidden");

    await resetComposer(page);
    await rightClickRenderedGlyph(frame, "RESPONSIVE_TARGET");
    const root = await visibleQuickInput(page, "编辑预览内容");
    await expectQuickInputWithinViewport(root, width, 700);
    await chooseQuickInputItem(page, "编辑预览内容", ROOT_CONTINUED);
    const continued = await visibleQuickInput(page, "编辑连续消息状态");
    await expectQuickInputWithinViewport(continued, width, 700);
    await expect(continued.getByRole("option", { name: /^自动/ })).toBeVisible();
    await expect(continued.getByRole("option", { name: "强制连续", exact: true })).toBeVisible();
    await expect(continued.getByRole("option", { name: "强制新消息", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(continued).toBeHidden();
    expect(await composerState(page)).toEqual({
      targetRequests: 1,
      editRequests: 0,
      applyAttempts: 0,
      successfulApplies: 0,
    });
    expect(await previewScrollTopology(frame)).toEqual(baseline);
    await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);
  }
});

async function installPackRoutes(page: Page): Promise<void> {
  await page.route(PACK_MANIFEST_URL, async (route) => {
    await route.fulfill({
      status: 200,
      body: manifest,
      headers: corsHeaders("application/json", '"preview-composer-manifest"'),
    });
  });
  await page.route(AVATAR_URL, async (route) => {
    await route.fulfill({
      status: 200,
      body: avatar,
      headers: corsHeaders("image/png"),
    });
  });
}

async function openProviderPreview(page: Page, name: string, source: string): Promise<OpenedPreview> {
  await installPackRoutes(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  const sourceUri = await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const frame = await waitForPreviewFrame(page, sourceUri);
  expect(await previewReadiness(page, sourceUri)).toMatchObject({
    stage: "ready",
    sourceUri,
    displayedSourceUri: sourceUri,
    fixtureActive: false,
    containerReady: true,
  });
  expect(await invokeMmtE2E(page, "preview", "buildDiagnostics", sourceUri)).toEqual([]);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);
  return { sourceUri, frame };
}

async function applyContinued(
  page: Page,
  frame: Frame,
  sourceUri: string,
  name: string,
  marker: string,
  choice: "自动" | "强制连续" | "强制新消息",
  expectedSource: string,
): Promise<Frame> {
  await resetComposer(page);
  const previousRevision = await currentContainerRevision(page, sourceUri);
  await rightClickRenderedGlyph(frame, marker);
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseQuickInputItem(page, "编辑预览内容", ROOT_CONTINUED);
  await chooseQuickInputItem(page, "编辑连续消息状态", choice);
  await expect.poll(() => composerState(page)).toEqual(successfulComposerState());
  await expect(page.getByRole("dialog", { name: STALE_MESSAGE })).toHaveCount(0);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(expectedSource);
  await expect.poll(() => currentContainerRevision(page, sourceUri)).not.toBe(previousRevision);
  const next = await waitForPreviewFrame(page, sourceUri);
  await expect(next.locator(".tsel").filter({ hasText: marker }).first()).toBeVisible();
  return next;
}

async function applyDisplayName(
  page: Page,
  frame: Frame,
  sourceUri: string,
  name: string,
  marker: string,
  currentValue: string,
  nextValue: string,
  expectedSource: string,
): Promise<Frame> {
  await resetComposer(page);
  const previousRevision = await currentContainerRevision(page, sourceUri);
  await rightClickRenderedGlyph(frame, marker);
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseQuickInputItem(page, "编辑预览内容", ROOT_DISPLAY_NAME);
  const inputWidget = await visibleQuickInput(page, "从本条起修改人物显示名");
  const input = inputWidget.locator("input").first();
  await expect(input).toHaveValue(currentValue);
  await input.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) throw new Error("display-name input is unavailable");
    element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  }, nextValue);
  await expect(input).toHaveValue(nextValue);
  await page.keyboard.press("Enter");
  await expect.poll(() => composerState(page)).toEqual(successfulComposerState());
  await expect(page.getByRole("dialog", { name: STALE_MESSAGE })).toHaveCount(0);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(expectedSource);
  await expect.poll(() => currentContainerRevision(page, sourceUri)).not.toBe(previousRevision);
  const next = await waitForPreviewFrame(page, sourceUri);
  await expect(next.locator(".tsel").filter({ hasText: marker }).first()).toBeVisible();
  return next;
}

async function rightClickRenderedGlyph(frame: Frame, marker: string): Promise<void> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  const position = await text.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const glyph = element.closest(".typst-text")?.querySelector<SVGGraphicsElement>(":scope > use");
    const glyphBounds = glyph?.getBoundingClientRect();
    const x = (glyphBounds ? (glyphBounds.left + glyphBounds.right) / 2 : bounds.left + bounds.width / 2) - bounds.left;
    const y = (glyphBounds ? (glyphBounds.top + glyphBounds.bottom) / 2 : bounds.top + bounds.height / 2) - bounds.top;
    return {
      x: Math.max(1, Math.min(Math.max(1, bounds.width - 1), x)),
      y: Math.max(1, Math.min(Math.max(1, bounds.height - 1), y)),
    };
  });
  await text.click({ button: "right", position });
}

async function dispatchSelectedContextMenu(
  frame: Frame,
  marker: string,
): Promise<{ readonly collapsed: boolean }> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  return text.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!(node instanceof Text) || node.data.length < 2) throw new Error("selectable preview text is unavailable");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(2, node.data.length));
    const selection = document.getSelection();
    if (!selection) throw new Error("preview selection is unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    const bounds = range.getBoundingClientRect();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: bounds.left + Math.max(1, bounds.width / 2),
      clientY: bounds.top + Math.max(1, bounds.height / 2),
    });
    element.dispatchEvent(event);
    return { collapsed: selection.isCollapsed };
  });
}

async function clearPreviewSelection(frame: Frame): Promise<void> {
  await frame.locator("body").evaluate(() => document.getSelection()?.removeAllRanges());
}

async function visibleQuickInput(page: Page, title: string): Promise<Locator> {
  const widget = page.locator(".quick-input-widget");
  await expect(widget).toBeVisible();
  await expect(widget).toContainText(title);
  return widget;
}

async function chooseQuickInputItem(page: Page, title: string, label: string): Promise<void> {
  const widget = await visibleQuickInput(page, title);
  const item = widget.getByRole("option", { name: label, exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

async function expectRenderedTextCount(frame: Frame, value: string, expected: number): Promise<void> {
  await expect.poll(() => frame.locator(".tsel").evaluateAll((elements, text) => (
    elements.filter((element) => (element.textContent ?? "").trim() === text).length
  ), value)).toBe(expected);
}

async function currentContainerRevision(page: Page, sourceUri: string): Promise<string> {
  const revision = (await previewReadiness(page, sourceUri)).containerRevision;
  if (!revision) throw new Error(`preview container revision is unavailable for ${sourceUri}`);
  return revision;
}


async function resetComposer(page: Page): Promise<void> {
  await invokeMmtE2E(page, "composer", "reset");
  expect(await composerState(page)).toEqual(emptyComposerState());
}

async function composerState(page: Page): Promise<ComposerState> {
  return invokeMmtE2E(page, "composer", "state");
}

function emptyComposerState(): ComposerState {
  return { targetRequests: 0, editRequests: 0, applyAttempts: 0, successfulApplies: 0 };
}

function successfulComposerState(): ComposerState {
  return { targetRequests: 1, editRequests: 1, applyAttempts: 1, successfulApplies: 1 };
}

async function expectHistoryCount(page: Page, name: string, expected: number): Promise<void> {
  await expect.poll(() => historyEditCountForPath(page, `/${name}`)).toBe(expected);
}

async function persistedWorkspaceText(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (entryPath) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const entry = await new Promise<{ data?: Uint8Array } | undefined>((resolve, reject) => {
        const request = database.transaction("files").objectStore("files").get(entryPath);
        request.onsuccess = () => resolve(request.result as { data?: Uint8Array } | undefined);
        request.onerror = () => reject(request.error);
      });
      return entry?.data ? new TextDecoder().decode(entry.data) : undefined;
    } finally {
      database.close();
    }
  }, path);
}

async function historyEditCountForPath(page: Page, path: string): Promise<number> {
  return page.evaluate(async (entryPath) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(["revisions", "changes"]);
      const [revisions, changes] = await Promise.all([
        new Promise<Array<{ id: string; reason: string }>>((resolve, reject) => {
          const request = transaction.objectStore("revisions").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
        new Promise<Array<{ revision: string; path: string }>>((resolve, reject) => {
          const request = transaction.objectStore("changes").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
      ]);
      const editRevisions = new Set(revisions.filter((revision) => revision.reason === "edit").map((revision) => revision.id));
      return changes.filter((change) => change.path === entryPath && editRevisions.has(change.revision)).length;
    } finally {
      database.close();
    }
  }, path);
}

async function previewScrollTopology(frame: Frame): Promise<ScrollTopology> {
  return frame.locator("body").evaluate(() => {
    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const className = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
      return className ? `${tag}.${className}` : tag;
    };
    const viewport = document.querySelector<HTMLElement>(".viewport");
    if (!viewport) throw new Error("preview viewport is unavailable");
    const bounds = viewport.getBoundingClientRect();
    const round = (value: number) => Math.round(value * 100) / 100;
    const scrollContainers = [...document.querySelectorAll("*")].filter((element) => {
      const style = getComputedStyle(element);
      return [style.overflow, style.overflowX, style.overflowY].some((value) => value === "auto" || value === "scroll");
    }).map(describe);
    return {
      scrollContainers,
      viewport: {
        left: round(bounds.left),
        top: round(bounds.top),
        right: round(bounds.right),
        bottom: round(bounds.bottom),
        width: round(bounds.width),
        height: round(bounds.height),
      },
      viewportChildren: [...viewport.children].map(describe),
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
    };
  });
}

async function expectQuickInputWithinViewport(widget: Locator, width: number, height: number): Promise<void> {
  const bounds = await widget.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.height).toBeGreaterThan(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 0.5);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height + 0.5);
}

function corsHeaders(contentType: string, etag?: string): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": contentType,
    ...(etag ? { etag } : {}),
  };
}
