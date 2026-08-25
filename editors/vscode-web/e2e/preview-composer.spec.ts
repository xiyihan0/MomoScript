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
const smileAvatar = await readFile(new URL("./fixtures/佳代子-smile.png", import.meta.url));
const koyukiAvatar = await readFile(new URL("./fixtures/小雪.png", import.meta.url));
const alphaSequence = await readFile(new URL("./fixtures/alpha-sequence.avifs", import.meta.url));
const AVATAR_FIXTURES = new Map([
  [new URL("assets/avatar/佳代子.png", PACK_BASE_URL).href, avatar],
  [new URL("assets/avatar/佳代子-smile.png", PACK_BASE_URL).href, smileAvatar],
  [new URL("assets/avatar/小雪.png", PACK_BASE_URL).href, koyukiAvatar],
]);
const ALPHA_SEQUENCE_URL = new URL("blobs/stickers/alpha/default.avifs", PACK_BASE_URL).href;

const ROOT_CONTINUED = "编辑连续消息状态…";
const ROOT_DISPLAY_NAME = "从本条起修改人物显示名…";
const ROOT_AVATAR = "从本条起更换人物头像…";
const APPLY_FAILED_MESSAGE = "无法应用预览编辑。";
const STALE_MESSAGE = "源码已更改，未应用编辑。";
const AVATAR_UNAVAILABLE_MESSAGE = "所选头像已不可用，未应用编辑。";

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

test("MomoScript update notification uses the native restart action button", { tag: "@preview-composer" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await invokeMmtE2E(page, "notifications", "showUpdatePrompt");

  const update = page.getByRole("dialog", { name: /MomoScript 新构建 e2e-build/ });
  await expect(update).toBeVisible();
  await expect(update).toHaveAttribute("aria-label", /源: MomoScript/);
  await expect(update.getByRole("button", { name: /展开通知|Expand Notification/i })).toHaveCount(0);
  const restart = update.getByRole("button", { name: "安全更新并重启", exact: true });
  await expect(restart).toBeVisible();
  await restart.click();
  await expect(update).toBeHidden();
});

test("full SVG preview preserves semantic chat regions for Composer authorization", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-semantic-full-svg.mmt";
  const source = "> 佳代子: FULL_SVG_TARGET 可是，把不可能变成可能的那一瞬间才最有意思；正常完成检查也很重要。\n";
  await installPackRoutes(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  expect(await invokeMmtE2E(page, "preview", "setRendererEnabled", false)).toBe(false);
  const sourceUri = await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const frame = await waitForPreviewFrame(page, sourceUri);
  await expect(frame.locator(".page")).not.toHaveClass(/renderer-active/);
  await expectChatSemanticRegions(frame, "FULL_SVG_TARGET");
  await expectSemanticChatContext(page, frame, "FULL_SVG_TARGET", "bubble");
  await expectSemanticChatContext(page, frame, "FULL_SVG_TARGET", "avatar");
  await resetComposer(page);
  await dispatchInactiveDomSemanticContextMenu(frame);
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual(emptyComposerState());
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);
});

test("diff-v1 preview rejects orphan, shadowing, or inactive semantic targets", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-semantic-diff.mmt";
  const original = "> 佳代子: DIFF_FIRST\n> _0: DIFF_TARGET 可是，把不可能变成可能的那一瞬间才最有意思；正常完成检查也很重要。\n";
  const edited = "> 佳代子: DIFF_FIRST\n>(continued: true) _0: DIFF_TARGET 可是，把不可能变成可能的那一瞬间才最有意思；正常完成检查也很重要。\n";
  const opened = await openProviderPreview(page, name, original);
  const frame = await applyContinued(
    page,
    opened.frame,
    opened.sourceUri,
    name,
    "DIFF_TARGET",
    "强制连续",
    edited,
    "bubble",
  );
  await expect(frame.locator(".page")).toHaveClass(/renderer-active/);
  await expectChatSemanticRegions(frame, "DIFF_FIRST");
  await expectSemanticChatContext(page, frame, "DIFF_FIRST", "avatar");
  await expectSemanticChatContext(page, frame, "DIFF_FIRST", "display-name");
  await resetComposer(page);
  await dispatchOrphanSemanticContextMenu(frame);
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual(emptyComposerState());
  await resetComposer(page);
  await dispatchInactiveDomSemanticContextMenu(frame);
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual(emptyComposerState());
  await resetComposer(page);
  await dispatchShadowingTypstLabelContextMenu(frame);
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual(emptyComposerState());
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(edited);
});



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
  await expectChatSemanticRegions(frame, "first");
  const historyBaseline = await historyEditCountForPath(page, `/${name}`);
  let expectedHistory = historyBaseline;

  frame = await applyContinued(page, frame, opened.sourceUri, name, "second", "强制连续", forcedSecond, "bubble");
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await expect(frame.locator(".page")).toHaveClass(/renderer-active/);
  await expectChatSemanticRegions(frame, "first");
  await waitForHistoryGroupBoundary(page);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "second", "强制新消息", newSecond);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 2);
  await waitForHistoryGroupBoundary(page);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "second", "自动", original);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await waitForHistoryGroupBoundary(page);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "multi", "强制连续", forcedMulti);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);
  await waitForHistoryGroupBoundary(page);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "multi", "强制新消息", newMulti);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 2);
  await waitForHistoryGroupBoundary(page);

  frame = await applyContinued(page, frame, opened.sourceUri, name, "multi", "自动", original);
  expectedHistory += 1;
  await expectHistoryCount(page, name, expectedHistory);
  await expectRenderedTextCount(frame, "佳代子", 1);

  expect(await composerState(page)).toEqual(successfulComposerState());
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(original);
});

test("display-name Composer inserts the screenshot actor revision without a stale warning", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-display-name-screenshot.mmt";
  const prefix = "> 小雪: 前文\n";
  const original = `${prefix}> 小雪: 抓到啦——！\n`;
  const expected = `${prefix}@actor 小雪\ndisplay-name: 白兔\n@end\n> 小雪: 抓到啦——！\n`;
  const opened = await openProviderPreview(page, name, original);
  await applyDisplayName(
    page,
    opened.frame,
    opened.sourceUri,
    name,
    "抓到啦",
    "小雪",
    "白兔",
    expected,
  );
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
  await waitForHistoryGroupBoundary(page);
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

test("avatar Composer updates the current actor interval, cross-character identity, and automatic grouping once", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-avatar.mmt";
  const original = [
    "> 佳代子: AVATAR_BEFORE",
    "> _0: AVATAR_TARGET",
    "> _0: AVATAR_AFTER",
    ">(continued: true) _0: AVATAR_FORCED",
    "",
  ].join("\n");
  const smileEdited = [
    "> 佳代子: AVATAR_BEFORE",
    "@actor 佳代子",
    "avatar: ba::佳代子/ba::avatar/smile",
    "@end",
    "> _0: AVATAR_TARGET",
    "> _0: AVATAR_AFTER",
    ">(continued: true) _0: AVATAR_FORCED",
    "",
  ].join("\n");
  const crossEdited = [
    "> 佳代子: AVATAR_BEFORE",
    "@actor 佳代子",
    "avatar: ba::佳代子/ba::avatar/smile",
    "@end",
    "> _0: AVATAR_TARGET",
    "@actor 佳代子",
    "avatar: ba::小雪/ba::avatar/default",
    "@end",
    "> _0: AVATAR_AFTER",
    ">(continued: true) _0: AVATAR_FORCED",
    "",
  ].join("\n");

  const opened = await openProviderPreview(page, name, original);
  let frame = opened.frame;
  const initialBeforeAvatar = await avatarImageSourceForMarker(frame, "AVATAR_BEFORE");
  const historyBaseline = await historyEditCountForPath(page, `/${name}`);

  frame = await applyAvatar(
    page,
    frame,
    opened.sourceUri,
    name,
    "AVATAR_TARGET",
    { entityId: "ba::佳代子", contributor: "ba", variant: "smile" },
    smileEdited,
  );
  await expectHistoryCount(page, name, historyBaseline + 1);
  expect(await avatarImageSourceForMarker(frame, "AVATAR_BEFORE")).toBe(initialBeforeAvatar);
  const smileSource = await avatarImageSourceForMarker(frame, "AVATAR_TARGET");
  expect(smileSource).not.toBe(initialBeforeAvatar);
  await expectRenderedTextCount(frame, "佳代子", 2);
  expect(smileEdited).toContain(">(continued: true) _0: AVATAR_FORCED");
  await waitForHistoryGroupBoundary(page);

  frame = await applyAvatar(
    page,
    frame,
    opened.sourceUri,
    name,
    "AVATAR_AFTER",
    { entityId: "ba::小雪", contributor: "ba", variant: "default" },
    crossEdited,
    "佳代子将从本条起使用「小雪 / default」头像",
  );
  await expectHistoryCount(page, name, historyBaseline + 2);
  expect(await avatarImageSourceForMarker(frame, "AVATAR_BEFORE")).toBe(initialBeforeAvatar);
  expect(await avatarImageSourceForMarker(frame, "AVATAR_TARGET")).toBe(smileSource);
  const crossSource = await avatarImageSourceForMarker(frame, "AVATAR_AFTER");
  expect(crossSource).not.toBe(smileSource);
  await expectRenderedTextCount(frame, "佳代子", 3);
  await expectRenderedTextCount(frame, "小雪", 0);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(crossEdited);
});
test("avatar picker reports custom, unset, and unsupported current sources without mutating", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-avatar-status.mmt";
  const source = [
    "@asset portrait",
    "src: portrait.png",
    "@end",
    "@actor custom",
    "preset: ba::佳代子",
    "avatar: asset::portrait",
    "@end",
    "@actor unsupported",
    "preset: ba::佳代子",
    "avatar: ba::佳代子/ba::avatar/sequence",
    "@end",
    "> custom: CUSTOM_AVATAR_CURRENT",
    "> 晴_露营: NULL_AVATAR_CURRENT",
    "> unsupported: UNSUPPORTED_AVATAR_CURRENT",
    "",
  ].join("\n");
  await installPackRoutes(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  await invokeMmtE2E(page, "workspace", "writeFile", "portrait.png", avatar.toString("base64"));
  const sourceUri = await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const frame = await waitForPreviewFrame(page, sourceUri);

  await expectAvatarPickerStatus(page, frame, "CUSTOM_AVATAR_CURRENT", "custom", "当前：自定义资源 portrait");
  await expectAvatarPickerStatus(page, frame, "NULL_AVATAR_CURRENT", "none", "当前：无头像");
  await expectAvatarPickerStatus(page, frame, "UNSUPPORTED_AVATAR_CURRENT", "unavailable", "当前头像暂不支持预览");
  expect(await composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);
});

test("avatar picker stays pointer-anchored and internally scrollable at 240–320px", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-avatar-responsive.mmt";
  const source = "> 佳代子: AVATAR_RESPONSIVE_TARGET\n";
  const opened = await openProviderPreview(page, name, source);
  for (const width of [320, 240]) {
    await page.setViewportSize({ width, height: 700 });
    await resetComposer(page);
    await dispatchRenderedGlyphContextMenu(opened.frame, "AVATAR_RESPONSIVE_TARGET");
    const pointer = await currentComposerAnchor(page);
    await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
    await chooseAvatarContextMenuItem(page);
    const picker = page.locator(".mmt-avatar-picker");
    await expect(picker).toBeVisible();
    await expectContextMenuAnchored(picker, pointer, width, 700);
    await expect(picker.locator(".mmt-avatar-picker__results")).toHaveCSS("overflow-y", "auto");
    await expect(picker.getByRole("textbox", { name: /搜索其他人物头像/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    expect(await composerState(page)).toEqual({
      targetRequests: 1,
      editRequests: 0,
      applyAttempts: 0,
      successfulApplies: 0,
    });
  }
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);
});

test("avatar picker never retries a failed apply and closes on the actual Pack catalog event", { tag: "@preview-composer" }, async ({ page }) => {
  const name = "composer-avatar-safety.mmt";
  const source = "> 佳代子: AVATAR_SAFETY_TARGET\n";
  const opened = await openProviderPreview(page, name, source);
  const frame = opened.frame;

  await resetComposer(page);
  await rightClickRenderedGlyph(frame, "AVATAR_SAFETY_TARGET");
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseAvatarContextMenuItem(page);
  let picker = page.locator(".mmt-avatar-picker");
  await expect(picker).toBeVisible();
  await invokeMmtE2E(page, "composer", "failNextApply");
  await picker.locator(
    '.mmt-avatar-picker__item[data-avatar-entity="ba::佳代子"]'
    + '[data-avatar-contributor="ba"][data-avatar-variant="smile"]',
  ).click();
  await expect(picker).toBeHidden();
  await expectMomoScriptNotificationSource(page, APPLY_FAILED_MESSAGE);
  await expect.poll(() => composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 1,
    applyAttempts: 1,
    successfulApplies: 0,
  });
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 1,
    applyAttempts: 1,
    successfulApplies: 0,
  });
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);

  await resetComposer(page);
  await rightClickRenderedGlyph(frame, "AVATAR_SAFETY_TARGET");
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseAvatarContextMenuItem(page);
  picker = page.locator(".mmt-avatar-picker");
  await expect(picker).toBeVisible();
  await invokeMmtE2E(page, "composer", "rejectNextAvatarEdit");
  await picker.locator(
    '.mmt-avatar-picker__item[data-avatar-entity="ba::佳代子"]'
    + '[data-avatar-contributor="ba"][data-avatar-variant="smile"]',
  ).click();
  await expect(picker).toBeHidden();
  await expectMomoScriptNotificationSource(page, AVATAR_UNAVAILABLE_MESSAGE);
  await expect.poll(() => composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 1,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 1,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);

  const mmsActivity = page.getByRole("tab", { name: "MomoScript", exact: true });
  await mmsActivity.click();
  const packUrls = page.getByRole("textbox", { name: "资源包清单地址" });
  await expect(packUrls).toBeVisible();
  await resetComposer(page);
  await rightClickRenderedGlyph(frame, "AVATAR_SAFETY_TARGET");
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseAvatarContextMenuItem(page);
  picker = page.locator(".mmt-avatar-picker");
  await expect(picker).toBeVisible();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="资源包清单地址"]');
    const section = input?.closest("section");
    const save = [...(section?.querySelectorAll("button") ?? [])]
      .find((button) => button.textContent === "保存项目设置");
    if (!input || !(save instanceof HTMLButtonElement)) throw new Error("Pack settings controls are unavailable");
    input.value = "";
    save.click();
  });
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect(picker).toBeHidden();
  await expect.poll(() => composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(source);
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
  await expect(contextMenuItem(page, ROOT_CONTINUED)).toBeHidden();
  await clearPreviewSelection(frame);
  for (const marker of ["NARRATION_TARGET", "REPLY_TARGET_A", "BOND_TARGET", "RAW_TYPST_TARGET", "GENERATED_HEADER_ONLY"]) {
    await resetComposer(page);
    if (marker === "NARRATION_TARGET") {
      await rightClickSingleSemanticContainer(frame, marker, "narration");
    } else if (marker === "REPLY_TARGET_A") {
      await rightClickSemanticContainer(frame, marker, "reply-item", "reply");
    } else if (marker === "BOND_TARGET") {
      await rightClickSemanticContainer(frame, marker, "bond-body", "bond");
    } else {
      await rightClickRenderedGlyph(frame, marker);
    }
    await expect.poll(() => composerState(page)).toMatchObject({ targetRequests: 1 });
    const navigate = await visibleContextMenuItem(page, "转到源码");
    await expect(contextMenuItem(page, ROOT_CONTINUED)).toBeHidden();
    await expect(contextMenuItem(page, ROOT_DISPLAY_NAME)).toBeHidden();
    expect(await composerState(page)).toEqual({
      targetRequests: 1,
      editRequests: 0,
      applyAttempts: 0,
      successfulApplies: 0,
    });
    if (marker === "NARRATION_TARGET") {
      await navigate.hover();
      await navigate.click();
      await expect(navigate).toBeHidden();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(stableSource);
  }

  await resetComposer(page);
  await rightClickRenderedGlyph(frame, "BUILTIN_TARGET");
  const builtinRoot = await visibleContextMenuItem(page, ROOT_CONTINUED);
  await expect(contextMenuItem(page, ROOT_DISPLAY_NAME)).toHaveCount(0);
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
  const staleRoot = await visibleContextMenuItem(page, ROOT_CONTINUED);
  const staleRevision = await currentContainerRevision(page, opened.sourceUri);
  const advancedSource = `${stableSource}\n`;
  await invokeMmtE2E(page, "workspace", "editDocument", name, stableSource.length, 0, "\n");
  await expect(staleRoot).toBeHidden();
  await expectMomoScriptNotificationSource(page, STALE_MESSAGE);
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
  await chooseContinuedContextMenuItem(page, "强制连续");
  await expect.poll(() => composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 1,
    applyAttempts: 1,
    successfulApplies: 0,
  });
  await expectMomoScriptNotificationSource(page, APPLY_FAILED_MESSAGE);
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
  const unresolvedNavigate = contextMenuItem(page, "转到源码");
  if (await unresolvedNavigate.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(unresolvedNavigate).toBeHidden();
  }
  await page.waitForTimeout(250);
  expect(await composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
  await expect(contextMenuItem(page, ROOT_CONTINUED)).toBeHidden();

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
    const root = await visibleContextMenuItem(page, ROOT_CONTINUED);

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

test("native Composer context menu stays pointer-anchored at 240–320px without changing preview scroll topology", { tag: "@preview-composer" }, async ({ page }) => {
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
    const pointer = await currentComposerAnchor(page);
    const rootItem = await visibleContextMenuItem(page, ROOT_CONTINUED);
    const rootMenu = contextMenuForItem(rootItem);
    await expectContextMenuAnchored(rootMenu, pointer, width, 700);
    await rootItem.hover();
    const automatic = await visibleContextMenuItem(page, "自动");
    const continuedMenu = contextMenuForItem(automatic);
    await expectElementWithinViewport(continuedMenu, width, 700);
    await expect(automatic).toHaveAttribute("aria-checked", "true");
    await visibleContextMenuItem(page, "强制连续");
    await visibleContextMenuItem(page, "强制新消息");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(rootItem).toBeHidden();
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
      headers: corsHeaders("application/json", '"preview-composer-avatar-manifest-v3"'),
    });
  });
  for (const [url, body] of AVATAR_FIXTURES) {
    await page.route(url, async (route) => {
      await route.fulfill({
        status: 200,
        body,
        headers: corsHeaders("image/png"),
      });
    });
  }
  await page.route(ALPHA_SEQUENCE_URL, async (route) => {
    await route.fulfill({
      status: 200,
      body: alphaSequence,
      headers: corsHeaders("image/avif"),
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
  hitTarget: "text" | "bubble" = "text",
): Promise<Frame> {
  await resetComposer(page);
  const previousRevision = await currentContainerRevision(page, sourceUri);
  if (hitTarget === "bubble") await rightClickRenderedBubbleGraphic(frame, marker);
  else await rightClickRenderedGlyph(frame, marker);
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseContinuedContextMenuItem(page, choice);
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
  const pointer = await currentComposerAnchor(page);
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseContextMenuItem(page, ROOT_DISPLAY_NAME);
  const inputWidget = await visibleContextInput(page, "从本条起修改人物显示名");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Workbench viewport is unavailable");
  await expectContextMenuAnchored(inputWidget, pointer, viewport.width, viewport.height);
  const input = inputWidget.locator("input").first();
  await expect(input).toHaveValue(currentValue);
  await input.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) throw new Error("display-name input is unavailable");
    element.value = value;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }));
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

async function expectAvatarPickerStatus(
  page: Page,
  frame: Frame,
  marker: string,
  status: "custom" | "none" | "unavailable",
  label: string,
): Promise<void> {
  await resetComposer(page);
  await rightClickRenderedGlyph(frame, marker);
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseAvatarContextMenuItem(page);
  const picker = page.locator(".mmt-avatar-picker");
  await expect(picker).toBeVisible();
  const currentStatus = picker.locator(".mmt-avatar-picker__current-status");
  await expect(currentStatus).toHaveAttribute("data-current-status", status);
  await expect(currentStatus).toHaveText(label);
  const search = picker.getByRole("textbox", { name: /搜索其他人物头像/ });
  await search.fill("Koyuki");
  await expect(picker.locator('.mmt-avatar-picker__item[data-avatar-entity="ba::小雪"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect.poll(() => composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
}

async function applyAvatar(
  page: Page,
  frame: Frame,
  sourceUri: string,
  name: string,
  marker: string,
  choice: { readonly entityId: string; readonly contributor: string; readonly variant: string },
  expectedSource: string,
  expectedCopy?: string,
): Promise<Frame> {
  await resetComposer(page);
  const previousRevision = await currentContainerRevision(page, sourceUri);
  await rightClickRenderedGlyph(frame, marker);
  const pointer = await currentComposerAnchor(page);
  await expect.poll(async () => (await composerState(page)).targetRequests, { timeout: 10_000 }).toBe(1);
  await chooseAvatarContextMenuItem(page);
  const picker = page.locator(".mmt-avatar-picker");
  await expect(picker).toBeVisible();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Workbench viewport is unavailable");
  await expectContextMenuAnchored(picker, pointer, viewport.width, viewport.height);
  const pickerBounds = await picker.boundingBox();
  expect(pickerBounds).not.toBeNull();
  expect(pickerBounds!.width).toBeLessThanOrEqual(560.5);
  expect(pickerBounds!.height).toBeLessThanOrEqual(520.5);
  await expect(picker.locator(".mmt-avatar-picker__results")).toHaveCSS("overflow-y", "auto");
  await expect(picker.locator(".mmt-avatar-picker__item.is-current")).toBeDisabled();
  for (const unavailable of ["sequence", "unsafe"]) {
    const item = picker.locator(`.mmt-avatar-picker__item[data-avatar-variant="${unavailable}"]`);
    await expect(item).toBeDisabled();
    await expect(item.locator("img")).not.toHaveAttribute("src", /.+/);
  }
  const selected = picker.locator(
    `.mmt-avatar-picker__item[data-avatar-entity="${choice.entityId}"]`
    + `[data-avatar-contributor="${choice.contributor}"]`
    + `[data-avatar-variant="${choice.variant}"]`,
  );
  await expect(selected).toBeEnabled();
  if (expectedCopy) await expect(selected).toContainText(expectedCopy);
  await selected.click();
  await expect(picker).toBeHidden();
  await expect.poll(() => composerState(page)).toEqual(successfulComposerState());
  await expect(page.getByRole("dialog", { name: STALE_MESSAGE })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: APPLY_FAILED_MESSAGE })).toHaveCount(0);
  await expect.poll(() => persistedWorkspaceText(page, `/${name}`)).toBe(expectedSource);
  await expect.poll(() => currentContainerRevision(page, sourceUri)).not.toBe(previousRevision);
  const next = await waitForPreviewFrame(page, sourceUri);
  await expect(next.locator(".tsel").filter({ hasText: marker }).first()).toBeVisible();
  return next;
}

async function avatarImageSourceForMarker(frame: Frame, marker: string): Promise<string> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  return text.evaluate((element, expectedMarker) => {
    const bubble = element
      .closest(".typst-text")
      ?.closest("[data-typst-label^='mmt:bubble:']");
    const bubbleLabel = bubble?.getAttribute("data-typst-label") ?? "";
    const token = /^mmt:bubble:(t[0-9a-f]{8})$/.exec(bubbleLabel)?.[1];
    if (!token) throw new Error(`bubble token is unavailable for ${expectedMarker}`);
    const root = bubble?.closest("svg");
    const avatarRegion = root?.querySelector(`[data-typst-label="mmt:avatar:${token}"]`);
    const image = avatarRegion?.querySelector("image");
    const source = image?.getAttribute("href") ?? image?.getAttribute("xlink:href");
    if (!source) throw new Error(`avatar image source is unavailable for ${expectedMarker}`);
    return source;
  }, marker);
}

async function rightClickRenderedGlyph(
  frame: Frame,
  marker: string,
): Promise<{ readonly x: number; readonly y: number }> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  const bounds = await text.boundingBox();
  if (!bounds) throw new Error(`preview glyph bounds are unavailable for ${marker}`);
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
  return { x: bounds.x + position.x, y: bounds.y + position.y };
}
async function dispatchRenderedGlyphContextMenu(frame: Frame, marker: string): Promise<void> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  await text.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
    }));
  });
}
async function rightClickRenderedBubbleGraphic(frame: Frame, marker: string): Promise<void> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  await text.evaluate((element, expectedMarker) => {
    const bubble = element
      .closest(".typst-text")
      ?.closest("[data-typst-label^='mmt:bubble:']");
    if (!bubble) throw new Error(`semantic bubble target is unavailable for ${expectedMarker}`);
    const bounds = bubble.getBoundingClientRect();
    const point = { x: bounds.right - 2, y: bounds.bottom - 2 };
    const target = document.elementFromPoint(point.x, point.y);
    if (!target) throw new Error(`lower-corner hit target is unavailable for ${expectedMarker}`);
    const closestLabel = target.closest("[data-typst-label]")?.getAttribute("data-typst-label");
    if (closestLabel !== bubble.getAttribute("data-typst-label")) {
      const ancestry: Array<{
        readonly tag: string;
        readonly class: string | null;
        readonly label: string | null;
      }> = [];
      let current: Element | null = target;
      while (current && ancestry.length < 8) {
        ancestry.push({
          tag: current.tagName,
          class: current.getAttribute("class"),
          label: current.getAttribute("data-typst-label"),
        });
        current = current.parentElement;
      }
      throw new Error(`lower-corner hit escaped semantic bubble: ${JSON.stringify(ancestry)}`);
    }
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
    }));
  }, marker);
}

async function rightClickSemanticRegion(
  frame: Frame,
  marker: string,
  role: "bubble" | "avatar" | "display-name",
): Promise<void> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  await text.evaluate((element, expected) => {
    const renderedText = element.closest(".typst-text");
    const bubble = renderedText?.closest("[data-typst-label^='mmt:bubble:']");
    const bubbleLabel = bubble?.getAttribute("data-typst-label") ?? "";
    const match = /^mmt:bubble:(t[0-9a-f]{8})$/.exec(bubbleLabel);
    if (!match) throw new Error(`semantic bubble target is unavailable for ${expected.marker}`);
    const root = bubble?.closest("svg");
    const target = [...(root?.querySelectorAll("[data-typst-label]") ?? [])]
      .find((candidate) => (
        candidate.getAttribute("data-typst-label") === `mmt:${expected.role}:${match[1]}`
      ));
    if (!target) throw new Error(`semantic ${expected.role} target is unavailable for ${expected.marker}`);
    const bounds = target.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
      throw new Error(`semantic ${expected.role} target has no rendered bounds`);
    }
    const textRegions = [...target.querySelectorAll(".typst-text")]
      .map((candidate) => candidate.getBoundingClientRect())
      .filter((region) => region.width > 0 && region.height > 0);
    const inset = Math.min(2, bounds.width / 4, bounds.height / 4);
    const points = [
      { x: bounds.left + inset, y: bounds.top + inset },
      { x: bounds.right - inset, y: bounds.top + inset },
      { x: bounds.left + inset, y: bounds.bottom - inset },
      { x: bounds.right - inset, y: bounds.bottom - inset },
      { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 },
    ];
    const point = points.find(({ x, y }) => !textRegions.some((region) => (
      x >= region.left && x <= region.right && y >= region.top && y <= region.bottom
    ))) ?? points.at(-1)!;
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
    }));
  }, { marker, role });
}

async function rightClickSingleSemanticContainer(
  frame: Frame,
  marker: string,
  role: "narration",
): Promise<void> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  await text.evaluate((element, expected) => {
    const container = element
      .closest(".typst-text")
      ?.closest(`[data-typst-label^='mmt:${expected.role}:']`);
    const label = container?.getAttribute("data-typst-label") ?? "";
    if (!new RegExp(`^mmt:${expected.role}:t[0-9a-f]{8}$`).test(label)) {
      throw new Error(`semantic ${expected.role} target is unavailable for ${expected.marker}`);
    }
    const bounds = container!.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
      throw new Error(`semantic ${expected.role} target has no rendered bounds`);
    }
    const point = {
      x: bounds.left + Math.min(2, bounds.width / 2),
      y: bounds.top + Math.min(2, bounds.height / 2),
    };
    container!.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
    }));
  }, { marker, role });
}


async function rightClickSemanticContainer(
  frame: Frame,
  marker: string,
  bodyRole: "reply-item" | "bond-body",
  containerRole: "reply" | "bond",
): Promise<void> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  await text.evaluate((element, expected) => {
    const renderedText = element.closest(".typst-text");
    const body = renderedText?.closest(`[data-typst-label^='mmt:${expected.bodyRole}:']`);
    const label = body?.getAttribute("data-typst-label") ?? "";
    const match = new RegExp(`^mmt:${expected.bodyRole}:(t[0-9a-f]{8})$`).exec(label);
    if (!match) throw new Error(`semantic ${expected.bodyRole} target is unavailable for ${expected.marker}`);
    const root = body?.closest("svg");
    const container = [...(root?.querySelectorAll("[data-typst-label]") ?? [])]
      .find((candidate) => (
        candidate.getAttribute("data-typst-label") === `mmt:${expected.containerRole}:${match[1]}`
      ));
    if (!container) {
      throw new Error(`semantic ${expected.containerRole} target is unavailable for ${expected.marker}`);
    }
    const bounds = container.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
      throw new Error(`semantic ${expected.containerRole} target has no rendered bounds`);
    }
    const point = {
      x: bounds.left + Math.min(2, bounds.width / 2),
      y: bounds.top + Math.min(2, bounds.height / 2),
    };
    container.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
    }));
  }, { marker, bodyRole, containerRole });
}

async function dispatchOrphanSemanticContextMenu(frame: Frame): Promise<void> {
  const svg = frame.locator("svg").first();
  await expect(svg).toBeVisible();
  await svg.evaluate((root) => {
    const namespace = "http://www.w3.org/2000/svg";
    const bubble = root.querySelector("[data-typst-label^='mmt:bubble:']");
    const owningGroup = bubble?.parentElement;
    if (!owningGroup || owningGroup.tagName.toLowerCase() !== "g") {
      throw new Error("chat ancestor is unavailable for orphan semantic target");
    }
    const group = document.createElementNS(namespace, "g");
    group.setAttribute("data-typst-label", "mmt:avatar:tffffffff");
    const rect = document.createElementNS(namespace, "rect");
    rect.setAttribute("x", "1");
    rect.setAttribute("y", "1");
    rect.setAttribute("width", "12");
    rect.setAttribute("height", "12");
    group.append(rect);
    owningGroup.append(group);
    const bounds = rect.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
      group.remove();
      throw new Error("orphan semantic target has no rendered bounds");
    }
    const point = {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
    };
    group.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
    }));
    group.remove();
  });
}
async function dispatchShadowingTypstLabelContextMenu(frame: Frame): Promise<void> {
  const svg = frame.locator("svg").first();
  await expect(svg).toBeVisible();
  await svg.evaluate((root) => {
    const namespace = "http://www.w3.org/2000/svg";
    const bubble = root.querySelector("[data-typst-label^='mmt:bubble:']");
    const owningGroup = bubble?.parentElement;
    if (!owningGroup || owningGroup.tagName.toLowerCase() !== "g") {
      throw new Error("chat ancestor is unavailable for shadowing Typst label");
    }
    const group = document.createElementNS(namespace, "g");
    group.setAttribute("data-typst-label", "ordinary-typst-label");
    const rect = document.createElementNS(namespace, "rect");
    rect.setAttribute("x", "1");
    rect.setAttribute("y", "1");
    rect.setAttribute("width", "12");
    rect.setAttribute("height", "12");
    group.append(rect);
    owningGroup.append(group);
    const bounds = rect.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
      group.remove();
      throw new Error("shadowing Typst label has no rendered bounds");
    }
    const point = {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
    };
    group.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
    }));
    group.remove();
  });
}

async function expectChatSemanticRegions(frame: Frame, marker: string): Promise<void> {
  const text = frame.locator(".tsel").filter({ hasText: marker }).first();
  await expect(text).toBeVisible();
  expect(await text.evaluate((element) => {
    const renderedText = element.closest(".typst-text");
    const bubble = renderedText?.closest("[data-typst-label^='mmt:bubble:']");
    const label = bubble?.getAttribute("data-typst-label") ?? "";
    const match = /^mmt:bubble:(t[0-9a-f]{8})$/.exec(label);
    if (!match) return [];
    const root = bubble?.closest("svg");
    return [...(root?.querySelectorAll("[data-typst-label]") ?? [])]
      .map((candidate) => candidate.getAttribute("data-typst-label"))
      .filter((candidate): candidate is string => candidate?.endsWith(`:${match[1]}`) ?? false)
      .sort();
  })).toEqual([
    expect.stringMatching(/^mmt:avatar:t[0-9a-f]{8}$/),
    expect.stringMatching(/^mmt:bubble:t[0-9a-f]{8}$/),
    expect.stringMatching(/^mmt:display-name:t[0-9a-f]{8}$/),
  ]);
}
async function dispatchInactiveDomSemanticContextMenu(frame: Frame): Promise<void> {
  const svg = frame.locator("svg").first();
  await expect(svg).toBeVisible();
  await svg.evaluate((activeRoot) => {
    const previewPage = activeRoot.closest(".page");
    if (!previewPage) throw new Error("active preview page is unavailable");
    const inactiveRoot = activeRoot.cloneNode(true) as SVGSVGElement;
    const target = inactiveRoot.querySelector("[data-typst-label^='mmt:avatar:']");
    if (!target) throw new Error("inactive semantic avatar target is unavailable");
    previewPage.append(inactiveRoot);
    const bounds = target.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
      inactiveRoot.remove();
      throw new Error("inactive semantic target has no rendered bounds");
    }
    const point = {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
    };
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
    }));
    inactiveRoot.remove();
  });
}


async function expectSemanticChatContext(
  page: Page,
  frame: Frame,
  marker: string,
  role: "bubble" | "avatar" | "display-name",
): Promise<void> {
  await resetComposer(page);
  if (role === "bubble") await rightClickRenderedBubbleGraphic(frame, marker);
  else await rightClickSemanticRegion(frame, marker, role);
  await expect.poll(() => composerState(page)).toMatchObject({ targetRequests: 1 });
  const root = await visibleContextMenuItem(page, ROOT_CONTINUED);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.keyboard.press("Escape");
  }
  await expect.poll(() => page.locator(".monaco-menu-container").evaluateAll((elements) => (
    elements.filter((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }).length
  ))).toBe(0);
  await expect(root).toBeHidden();
  expect(await composerState(page)).toEqual({
    targetRequests: 1,
    editRequests: 0,
    applyAttempts: 0,
    successfulApplies: 0,
  });
}


async function chooseAvatarContextMenuItem(page: Page): Promise<void> {
  const menuItems = page.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]');
  await expect.poll(() => menuItems.allTextContents(), { timeout: 20_000 }).toContain(ROOT_AVATAR);
  const item = contextMenuItem(page, ROOT_AVATAR);
  await item.hover();
  await item.click();
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

async function visibleContextInput(page: Page, title: string): Promise<Locator> {
  const widget = page.locator(".mmt-preview-context-input");
  await expect(widget).toBeVisible();
  await expect(widget).toContainText(title);
  return widget;
}

function contextMenuItem(page: Page, label: string): Locator {
  return page.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]').filter({ hasText: label }).last();
}
async function expectMomoScriptNotificationSource(page: Page, message: string): Promise<void> {
  const notification = page.getByRole("dialog", { name: message }).last();
  await expect(notification).toBeVisible();
  await expect(notification).toHaveAttribute("aria-label", /源: MomoScript/);
}


async function visibleContextMenuItem(page: Page, label: string): Promise<Locator> {
  const item = contextMenuItem(page, label);
  await expect(item).toBeVisible();
  return item;
}

async function chooseContextMenuItem(page: Page, label: string): Promise<void> {
  const item = await visibleContextMenuItem(page, label);
  await item.hover();
  await item.click();
}

async function chooseContinuedContextMenuItem(page: Page, label: string): Promise<void> {
  await (await visibleContextMenuItem(page, ROOT_CONTINUED)).hover();
  const item = await visibleContextMenuItem(page, label);
  await item.hover();
  await item.click();
}

function contextMenuForItem(item: Locator): Locator {
  return item.locator("xpath=ancestor::div[contains(@class, 'context-view')][1]");
}

async function currentComposerAnchor(page: Page): Promise<{ readonly x: number; readonly y: number }> {
  await expect.poll(() => invokeMmtE2E(page, "composer", "lastAnchor")).not.toBeNull();
  const anchor = await invokeMmtE2E(page, "composer", "lastAnchor");
  if (!anchor) throw new Error("Composer screen anchor is unavailable");
  return page.evaluate((value) => {
    const sideInset = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const topInset = Math.max(sideInset, window.outerHeight - window.innerHeight - sideInset);
    return {
      x: Math.min(window.innerWidth, Math.max(0, value.screenX - window.screenX - sideInset)),
      y: Math.min(window.innerHeight, Math.max(0, value.screenY - window.screenY - topInset)),
    };
  }, anchor);
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
async function waitForHistoryGroupBoundary(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const revisions = await new Promise<Array<{ reason: string; updatedAt: number }>>((resolve, reject) => {
        const request = database.transaction("revisions").objectStore("revisions").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const latestEdit = Math.max(
        ...revisions.filter((revision) => revision.reason === "edit").map((revision) => revision.updatedAt),
      );
      return Number.isFinite(latestEdit) ? Date.now() - latestEdit : Number.POSITIVE_INFINITY;
    } finally {
      database.close();
    }
  }), { timeout: 12_000 }).toBeGreaterThanOrEqual(7_500);
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

async function expectElementWithinViewport(element: Locator, width: number, height: number): Promise<void> {
  const bounds = await element.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.height).toBeGreaterThan(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 0.5);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height + 0.5);
}

async function expectContextMenuAnchored(
  menu: Locator,
  pointer: { readonly x: number; readonly y: number },
  width: number,
  height: number,
): Promise<void> {
  await expectElementWithinViewport(menu, width, height);
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  const horizontalGap = pointer.x < bounds!.x
    ? bounds!.x - pointer.x
    : pointer.x > bounds!.x + bounds!.width ? pointer.x - bounds!.x - bounds!.width : 0;
  const verticalGap = pointer.y < bounds!.y
    ? bounds!.y - pointer.y
    : pointer.y > bounds!.y + bounds!.height ? pointer.y - bounds!.y - bounds!.height : 0;
  const details = JSON.stringify({ pointer, bounds, width, height });
  expect(horizontalGap, details).toBeLessThanOrEqual(48);
  expect(verticalGap, details).toBeLessThanOrEqual(48);
}

function corsHeaders(contentType: string, etag?: string): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": contentType,
    ...(etag ? { etag } : {}),
  };
}
