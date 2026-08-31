import { expect, invokeMmtE2E, test, type Locator, type Page, waitForPreviewFrame } from "./fixtures";

async function waitForGui(page: Page, name: string) {
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    guiVisible: true,
    textDocumentCount: 1,
    modelCount: 1,
  });
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    uri: `mmtfs://workspace/${name}`,
    pending: false,
  });
  await expect.poll(async () => (await invokeMmtE2E(page, "gui", "state")).sourceDigest)
    .toMatch(/^[0-9a-f]{64}$/u);
}

async function setFieldValue(field: Locator, value: string): Promise<void> {
  await field.evaluate((element, nextValue) => {
    (element as HTMLInputElement | HTMLTextAreaElement).value = nextValue;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: nextValue,
    }));
  }, value);
}

async function waitForGuiVersion(page: Page, version: number): Promise<void> {
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    version,
    pending: false,
    lastNotification: null,
  });
}

test("desktop GUI edits the single TextDocument and fails closed across stale and opaque snapshots", {
  tag: ["@editor-runtime", "@gui-composer"],
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  const name = "gui-desktop.mmt";
  await invokeMmtE2E(page, "workspace", "openDocument", name, "- first\n- second\n");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    sourceVisible: true,
    guiVisible: false,
    textDocumentCount: 1,
    modelCount: 1,
  });

  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForGui(page, name);
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    nodeKinds: ["narration", "narration"],
  });

  const surface = page.getByRole("region", { name: "MomoScript GUI 创作" });
  const cards = surface.locator(".mmt-composer-card");
  await cards.first().click();
  await surface.getByRole("button", { name: "编辑正文" }).click();
  const dialog = surface.getByRole("dialog", { name: "编辑正文" });
  const bodyField = dialog.getByRole("textbox", { name: "正文" });
  await bodyField.evaluate((element, value) => {
    (element as HTMLTextAreaElement).value = value;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
  }, "changed 😀");
  await expect(bodyField).toHaveValue("changed 😀");
  const beforeEdit = await invokeMmtE2E(page, "gui", "state");
  await dialog.getByRole("button", { name: "应用" }).click();
  await expect.poll(() => invokeMmtE2E(page, "gui", "state"), { timeout: 30_000 }).toMatchObject({
    editRequests: beforeEdit.editRequests + 1,
    applyAttempts: beforeEdit.applyAttempts + 1,
    pending: false,
    lastNotification: null,
  });
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name), { timeout: 30_000 })
    .toContain("- changed 😀");

  await surface.getByRole("button", { name: "在开头添加" }).click();
  const insert = surface.getByRole("dialog", { name: "添加内容" });
  await insert.getByLabel("类型").selectOption("narration");
  const insertBody = insert.getByRole("textbox", { name: "正文" });
  await insertBody.evaluate((element, value) => {
    (element as HTMLTextAreaElement).value = value;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
  }, "intro");
  await insert.getByRole("button", { name: "添加" }).click();
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name))
    .toMatch(/^- intro\n- changed 😀/u);

  await cards.first().click();
  await surface.getByRole("button", { name: "编辑正文" }).click();
  const staleBefore = await invokeMmtE2E(page, "gui", "state");
  await invokeMmtE2E(page, "workspace", "replaceDocument", name, "- external\n@mode: text\n- preserved\n");
  await expect(surface.getByRole("dialog", { name: "编辑正文" })).toBeHidden();
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    editRequests: staleBefore.editRequests,
    nodeKinds: ["narration", "opaque", "narration"],
    pending: false,
  });

  await invokeMmtE2E(page, "workspace", "replaceDocument", name, "// error-looking\n- narration\n");
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    nodeKinds: ["opaque", "narration"],
  });
  const errorCard = surface.locator('.mmt-composer-card[data-severity="error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard.getByRole("button", { name: /删除|上移|下移/u })).toHaveCount(0);
  await expect(surface.getByRole("button", { name: /在此添加|在开头添加/u })).toHaveCount(0);

});

test("GUI property edits preserve CRLF, final-EOL, blank, and opaque bytes", {
  tag: ["@editor-runtime", "@gui-composer"],
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  const name = "gui-lossless.mmt";
  const source = "> 佳代子: original 😀\r\n\r\n@reply: A | B\r\n@bond: bond";
  await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForGui(page, name);
  const surface = page.getByRole("region", { name: "MomoScript GUI 创作" });
  await surface.locator(".mmt-composer-card-message").click();
  const editBody = surface.getByRole("button", { name: "编辑正文" });
  await expect(editBody).toBeVisible();
  await expect(editBody).toBeEnabled();
  await editBody.evaluate((element) => (element as HTMLButtonElement).click());
  const dialog = surface.getByRole("dialog", { name: "编辑正文" });
  await setFieldValue(dialog.getByRole("textbox", { name: "正文" }), "targeted 😀");
  await dialog.getByRole("button", { name: "应用" }).click();
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(
    "> 佳代子: targeted 😀\r\n\r\n@reply: A | B\r\n@bond: bond",
  );
  await expect(surface.locator('.mmt-composer-card[data-category="blank"]')).toHaveCount(1);
  await expect(surface.locator(".mmt-composer-card[data-category]", { hasText: "高级源码" })).toHaveCount(2);
});

test("desktop GUI completes message properties, ordering, persistence, preview, history, and exact export", {
  tag: ["@editor-runtime", "@gui-composer"],
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  const name = "gui-complete-loop.mmt";
  let expectedSource = "> 佳代子: first\n> 阿洛娜: second\n- tail\n";
  await invokeMmtE2E(page, "workspace", "openDocument", name, expectedSource);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForGui(page, name);

  const surface = page.getByRole("region", { name: "MomoScript GUI 创作" });
  const messages = surface.locator(".mmt-composer-card-message");
  const selectFirstMessage = async () => {
    await messages.first().click();
    await expect(surface.getByRole("button", { name: "编辑正文" })).toBeVisible();
  };

  await selectFirstMessage();
  await surface.getByRole("button", { name: "编辑正文" }).click();
  let dialog = surface.getByRole("dialog", { name: "编辑正文" });
  await setFieldValue(dialog.getByRole("textbox", { name: "正文" }), "loop body 😀");
  const beforeBody = await invokeMmtE2E(page, "gui", "state");
  await dialog.getByLabel("文本模式").selectOption("textRaw");
  await dialog.getByRole("button", { name: "应用" }).click();
  await waitForGuiVersion(page, beforeBody.version! + 1);
  expectedSource = "> 佳代子: rt\"\"\"loop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expectedSource);

  await selectFirstMessage();
  await surface.getByRole("button", { name: "连续消息" }).click();
  dialog = surface.getByRole("dialog", { name: "连续消息" });
  await dialog.getByLabel("状态").selectOption("true");
  const beforeContinued = await invokeMmtE2E(page, "gui", "state");
  await dialog.getByRole("button", { name: "应用" }).click();
  expectedSource = ">(continued: true) 佳代子: rt\"\"\"loop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  await waitForGuiVersion(page, beforeContinued.version! + 1);
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expectedSource);

  await selectFirstMessage();
  await surface.getByRole("button", { name: "显示名" }).click();
  dialog = surface.getByRole("dialog", { name: "显示名" });
  await setFieldValue(dialog.getByRole("textbox", { name: "显示名" }), "夜行佳代子");
  const beforeDisplayName = await invokeMmtE2E(page, "gui", "state");
  await dialog.getByRole("button", { name: "应用" }).click();
  await waitForGuiVersion(page, beforeDisplayName.version! + 1);
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\n@end\n>(continued: true) 佳代子: rt\"\"\"loop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expectedSource);
  const avatarInsertion = expectedSource.indexOf("@end");
  const avatarFixture = await invokeMmtE2E(
    page,
    "workspace",
    "editDocument",
    name,
    avatarInsertion,
    0,
    "avatar: ba::阿洛娜/ba::avatar/default\n",
  );
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\navatar: ba::阿洛娜/ba::avatar/default\n@end\n>(continued: true) 佳代子: rt\"\"\"loop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  expect(avatarFixture.text).toBe(expectedSource);
  await waitForGuiVersion(page, avatarFixture.version);

  await selectFirstMessage();
  await surface.getByRole("button", { name: "头像" }).click();
  dialog = surface.getByRole("dialog", { name: "头像" });
  const avatarSelect = dialog.getByLabel("头像");
  await avatarSelect.selectOption({ label: "佳代子 · default" });
  await expect(avatarSelect.locator("option:checked")).toHaveText("佳代子 · default");
  const beforeAvatar = await invokeMmtE2E(page, "gui", "state");
  await dialog.getByRole("button", { name: "应用" }).click();
  await waitForGuiVersion(page, beforeAvatar.version! + 1);
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\navatar: ba::佳代子/ba::avatar/default\n@end\n>(continued: true) 佳代子: rt\"\"\"loop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expectedSource);

  await selectFirstMessage();
  await surface.getByRole("button", { name: "更换说话人" }).click();
  dialog = surface.getByRole("dialog", { name: "更换说话人" });
  await dialog.getByLabel("说话人").selectOption("阿洛娜");
  const beforeSpeaker = await invokeMmtE2E(page, "gui", "state");
  await dialog.getByRole("button", { name: "应用" }).click();
  await waitForGuiVersion(page, beforeSpeaker.version! + 1);
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\navatar: ba::佳代子/ba::avatar/default\n@end\n>(continued: true) ba::阿洛娜: rt\"\"\"loop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expectedSource);
  await expect(messages.first()).toContainText("阿洛娜");

  const beforeMove = await invokeMmtE2E(page, "gui", "state");
  await messages.first().getByRole("button", { name: "下移" }).click();
  await waitForGuiVersion(page, beforeMove.version! + 1);
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\navatar: ba::佳代子/ba::avatar/default\n@end\n> 阿洛娜: second\n>(continued: true) ba::阿洛娜: rt\"\"\"loop body 😀\"\"\"\n- tail\n";
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expectedSource);
  const narrations = surface.locator(".mmt-composer-card-narration");
  const beforeDelete = await invokeMmtE2E(page, "gui", "state");
  await narrations.first().getByRole("button", { name: "删除" }).click();
  await waitForGuiVersion(page, beforeDelete.version! + 1);
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\navatar: ba::佳代子/ba::avatar/default\n@end\n> 阿洛娜: second\n>(continued: true) ba::阿洛娜: rt\"\"\"loop body 😀\"\"\"\n";
  await expect.poll(() => invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expectedSource);

  await surface.getByRole("button", { name: "保存" }).click();
  await surface.getByRole("button", { name: "预览" }).click();
  const preview = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  await expect(preview.locator(".viewport")).toBeVisible();
  expect(await preview.locator("body").evaluate((element) => getComputedStyle(element).overflow)).toBe("hidden");
  expect(await preview.locator(".viewport").evaluate((element) => getComputedStyle(element).overflow)).toMatch(/auto|scroll/u);
  await invokeMmtE2E(page, "exactExport", "fixture", { action: "install", marker: "gui-complete-loop" });

  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForGui(page, name);
  await expect.poll(() => invokeMmtE2E(page, "exactExport", "fixture", { action: "state" }))
    .toMatchObject({ availability: "ready", phase: "idle" });
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await surface.getByRole("button", { name: "导出" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("gui-complete-loop.pdf");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForGui(page, name);

  await surface.getByRole("button", { name: "历史" }).click();
  await expect(page.getByRole("tab", { name: "本地历史", exact: true })).toHaveAttribute("aria-selected", "true");
  await invokeMmtE2E(page, "history", "createCheckpoint", "GUI complete loop");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForGui(page, name);

  const expected = await invokeMmtE2E(page, "workspace", "readDocument", name);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForGui(page, name);
  expect(await invokeMmtE2E(page, "workspace", "readDocument", name)).toBe(expected);
});

test("550px mobile default and 320px sheet stay reachable without source bounce", {
  tag: ["@editor-runtime", "@gui-composer", "@gui-composer-mobile"],
}, async ({ page }) => {
  await page.setViewportSize({ width: 551, height: 760 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await invokeMmtE2E(page, "workspace", "openDocument", "desktop-threshold.mmt", "- desktop\n");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", "desktop-threshold.mmt")).toMatchObject({
    sourceVisible: true,
    guiVisible: false,
  });

  await page.setViewportSize({ width: 550, height: 760 });
  await invokeMmtE2E(page, "workspace", "openDocument", "mobile-threshold.mmt", "- mobile\n");
  await waitForGui(page, "mobile-threshold.mmt");

  await page.setViewportSize({ width: 320, height: 640 });
  const surface = page.getByRole("region", { name: "MomoScript GUI 创作" });
  await expect(surface).toBeVisible();
  expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const targets = await surface.locator("button").evaluateAll((buttons) => buttons
    .filter((button) => getComputedStyle(button).display !== "none")
    .map((button) => button.getBoundingClientRect()));
  expect(targets.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);

  await surface.locator(".mmt-composer-card").first().click();
  await surface.getByRole("button", { name: "编辑正文" }).click();
  const dialog = surface.getByRole("dialog", { name: "编辑正文" });
  await expect(dialog).toBeVisible();
  expect(await surface.locator(".mmt-composer-cards").evaluate((element) => element instanceof HTMLElement && element.inert)).toBe(true);
  await page.setViewportSize({ width: 320, height: 480 });
  await expect(dialog.getByRole("textbox", { name: "正文" })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "应用" })).toBeInViewport();
  await dialog.getByRole("button", { name: "取消" }).click();

  await surface.getByRole("button", { name: "高级源码" }).click();
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", "mobile-threshold.mmt")).toMatchObject({
    sourceVisible: true,
    guiVisible: false,
  });
  await page.waitForTimeout(500);
  expect((await invokeMmtE2E(page, "composer", "editorState", "mobile-threshold.mmt")).sourceVisible).toBe(true);

  await invokeMmtE2E(page, "workspace", "openDocument", "mobile-second.mmt", "- second\n");
  await waitForGui(page, "mobile-second.mmt");
  await surface.getByRole("button", { name: "预览" }).click();
  const preview = await waitForPreviewFrame(page, "mmtfs://workspace/mobile-second.mmt");
  expect(await preview.locator("body").evaluate((element) => getComputedStyle(element).overflow)).toBe("hidden");
  expect(await preview.locator(".viewport").evaluate((element) => getComputedStyle(element).overflow)).toMatch(/auto|scroll/u);
  await invokeMmtE2E(page, "composer", "openGui", "mobile-second.mmt");
  await waitForGui(page, "mobile-second.mmt");
});
