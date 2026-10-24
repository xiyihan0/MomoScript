import {
  clickComposerBoundary,
  composerText,
  composerGlyphBoundary,
  expect,
  invokeMmtE2E,
  test,
  type Frame,
  type Page,
  waitForComposerFrame,
  waitForPreviewFrame,
} from "./fixtures";
import {
  attachOutputManifest,
  captureAcceptedOutput,
  expectPdfPages,
  inspectOutputSvg,
  saveOutputDownload,
} from "./output-artifacts";

const tags = ["@editor-runtime", "@gui-composer"];
const inputBridge = (frame: Frame) => frame.locator("textarea.composer-input-bridge");
const textState = (page: Page) => invokeMmtE2E(page, "gui", "textState");
const authored = (page: Page, name: string) => invokeMmtE2E(page, "workspace", "readDocument", name);
const canonicalText = (page: Page, name: string) => invokeMmtE2E(page, "workspace", "canonicalText", name);
const guiSurface = (page: Page) => page.getByRole("region", { name: "MomoScript GUI 创作" });

async function switchAuthoringMode(page: Page, mode: "chat" | "layout" | "source"): Promise<void> {
  const labels = { chat: "聊天创作", layout: "排版预览", source: "源码" } as const;
  await guiSurface(page).getByRole("button", { name: /^切换模式 · /u }).click();
  const dialog = guiSurface(page).getByRole("dialog", { name: "切换模式", exact: true });
  await dialog.getByRole("button", { name: new RegExp(`^${labels[mode]}(?:\\s|$)`, "u") }).click();
}

async function documentAction(page: Page, label: string): Promise<void> {
  await guiSurface(page).getByRole("button", { name: / · 作品菜单$/u }).click();
  await guiSurface(page).getByRole("dialog", { name: "作品菜单", exact: true })
    .getByRole("button", { name: label, exact: true }).click();
}

async function openComposer(page: Page, name: string, source: string): Promise<Frame> {
  await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  return await waitForComposerFrame(page, name);
}

async function returnToChatThroughCommand(page: Page, name: string): Promise<Frame> {
  await page.keyboard.press("Control+Shift+p");
  const command = page.locator(".quick-input-widget input").first();
  await expect(command).toBeVisible();
  await command.fill(">打开 GUI 创作");
  await page.keyboard.press("Enter");
  return waitForComposerFrame(page, name);
}

async function framePoint(frame: Frame, point: { readonly x: number; readonly y: number }) {
  const iframe = await frame.frameElement();
  const bounds = await iframe.boundingBox();
  if (!bounds) throw new Error("The Composer overlay is not visible");
  return { x: bounds.x + point.x, y: bounds.y + point.y };
}

async function selectBody(page: Page, frame: Frame, fragment: string, length: number): Promise<{ x: number; y: number }> {
  const point = await framePoint(frame, await composerGlyphBoundary(frame, fragment, 2));
  await page.mouse.click(point.x, point.y, { clickCount: 3, delay: 70 });
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 0, offsetUtf16: 0 },
    focus: { bodyIndex: 0, offsetUtf16: length },
  });
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "ready");
  return point;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
});

test("requesting a mode switch retains the live IME candidate until its single native commit", { tag: tags }, async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: "IME limitation",
    description: "Synthetic composition events exercise the transaction boundary, not an OS input method or candidate window.",
  });
  const name = "gui-ime-mode-transaction.mmt";
  const source = "- IME anchor\n- other body\n";
  const frame = await openComposer(page, name, source);
  const draft = guiSurface(page).getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.fill("unsubmitted next message");
  await clickComposerBoundary(page, frame, "IME anchor", "end");
  await inputBridge(frame).evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.value = "中";
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中" }));
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertCompositionText", data: "中", isComposing: true,
    }));
  });
  await expect(frame.locator(".composer-composition")).toHaveText("中");
  await guiSurface(page).getByRole("button", { name: /^切换模式 · /u }).click();
  await expect(inputBridge(frame)).toBeFocused();
  const modes = guiSurface(page).getByRole("dialog", { name: "切换模式", exact: true });
  await expect(modes).toBeHidden();
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "chat");
  await expect(frame.locator(".composer-composition")).toHaveText("中");
  expect(await authored(page, name)).toBe(source);
  await expect(draft).toHaveValue("unsubmitted next message");
  await inputBridge(frame).evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.value = "中文";
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中文" }));
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertCompositionText", data: "中文", isComposing: true,
    }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: "中文", isComposing: false,
    }));
  });
  const committed = "- IME anchor中文\n- other body\n";
  await expect.poll(() => authored(page, name)).toBe(committed);
  await expect(modes).toBeVisible();
  await modes.getByRole("button", { name: /^排版预览(?:\s|$)/u }).click();
  await waitForComposerFrame(page, name);
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "layout");
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 0, offsetUtf16: "IME anchor中文".length },
    focus: { bodyIndex: 0, offsetUtf16: "IME anchor中文".length },
  });
  await clickComposerBoundary(page, frame, "中文", "end");
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(source);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe(committed);
  await waitForComposerFrame(page, name);
  await testInfo.attach("ime-commit-editable-layout", { body: await page.screenshot(), contentType: "image/png" });
  await switchAuthoringMode(page, "chat");
  await waitForComposerFrame(page, name);
  await expect(draft).toHaveValue("unsubmitted next message");
  await draft.fill("");
});

test("one product export request waits for the live IME commit, drains accepted text and exports output rather than chat", {
  tag: [...tags, "@runtime-export"],
}, async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: "IME limitation",
    description: "Synthetic composition events exercise export transaction ordering, not an OS input method.",
  });
  const name = "gui-export-ime-transaction.mmt";
  const original = "- Export anchor\n- Untouched output tail\n";
  const frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  const unsent = "This draft is not automatically sent or saved by export";
  await draft.fill(unsent);
  await clickComposerBoundary(page, frame, "Export anchor", "end");
  await inputBridge(frame).evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.value = "中";
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中" }));
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertCompositionText", data: "中", isComposing: true,
    }));
  });
  await expect(frame.locator(".composer-composition")).toHaveText("中");
  await surface.getByRole("button", { name: "导出作品", exact: true }).click();
  const panel = surface.getByRole("dialog", { name: "导出作品", exact: true });
  await expect(panel).toBeHidden();
  await expect(inputBridge(frame)).toBeFocused();
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "chat");
  expect(await canonicalText(page, name)).toBe(original);
  await inputBridge(frame).evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.value = "中文";
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中文" }));
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertCompositionText", data: "中文", isComposing: true,
    }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: "中文", isComposing: false,
    }));
  });
  const committed = "- Export anchor中文\n- Untouched output tail\n";
  await expect.poll(() => canonicalText(page, name)).toBe(committed);
  await expect(panel).toBeVisible();
  expect(await waitForComposerFrame(page, name)).toBe(frame);
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "layout");
  await expect(panel).toContainText("未发送的草稿不包含在本次导出中。");
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  const output = await captureAcceptedOutput(frame);
  expect(output.pages.flatMap((outputPage) => outputPage.content.map((entry) => entry.text))).toEqual(["Export anchor中文", "Untouched output tail"]);
  await surface.getByRole("button", { name: "导出作品", exact: true }).click();
  await expect(panel).toBeVisible();
  await attachOutputManifest(testInfo, "product-ime-accepted-output", { ...output, source: committed, excludedDraft: unsent });
  await expect(panel.getByRole("combobox", { name: "导出格式", exact: true })).toHaveValue("pdf");
  const pdfEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载 PDF", exact: true }).click();
  const pdf = await pdfEvent;
  expect(pdf.suggestedFilename()).toBe("gui-export-ime-transaction.pdf");
  expectPdfPages(await saveOutputDownload(pdf, testInfo, "product-ime-accepted-output"), output.pages);
  await panel.getByRole("combobox", { name: "导出格式", exact: true }).selectOption("svg");
  const svgEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载 SVG", exact: true }).click();
  const svg = await svgEvent;
  expect(svg.suggestedFilename()).toBe("gui-export-ime-transaction-page-1.svg");
  await inspectOutputSvg(page, await saveOutputDownload(svg, testInfo, "product-ime-accepted-output"), output.pages[0]!, testInfo, "product-ime-accepted-output");
  await expect.poll(() => invokeMmtE2E(page, "exactExport", "fixture", { action: "state" })).toMatchObject({
    phase: "complete", completedRenderKey: output.renderKey,
  });
  await testInfo.attach("single-export-request-after-ime-layout", { body: await page.screenshot(), contentType: "image/png" });
  expect(await canonicalText(page, name)).toBe(committed);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await switchAuthoringMode(page, "chat");
  await waitForComposerFrame(page, name);
  await expect(draft).toHaveValue(unsent);
  await draft.fill("");
});

test("native Source role, body and order changes rebind both SVG modes, preserve resources and drafts, and share split/reopen undo", {
  tag: tags,
}, async ({ page }, testInfo) => {
  const name = "gui-source-layout-roundtrip.mmt";
  const definitions = [
    "@asset kept-image", "src: intro-assets/basic.png", "@end",
    "@actor custom", "preset: ba::佳代子", "display-name: Custom source actor", "avatar: asset::kept-image", "@end", "",
  ].join("\n");
  const original = `${definitions}> custom: first source body\n> 阿洛娜: second source body\n- untouched source tail\n`;
  const changed = `${definitions}> custom: second source revised\n> 阿洛娜: first source body\n- untouched source tail\n`;
  const expectedBodies = ["second source revised", "first source body", "untouched source tail"];
  let frame = await openComposer(page, name, original);
  const draft = guiSurface(page).getByRole("textbox", { name: "新消息正文", exact: true });
  const unsent = "A separate unsent message survives Source and split preview";
  await draft.fill(unsent);
  await switchAuthoringMode(page, "source");
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.evaluate((text) => navigator.clipboard.writeText(text), changed);
  await page.keyboard.press("Control+v");
  await expect.poll(() => canonicalText(page, name)).toBe(changed);
  frame = await returnToChatThroughCommand(page, name);
  await expect.poll(async () => (await textState(page)).bodies.map((body) => body.text)).toEqual(expectedBodies);
  await expect(composerText(frame, "Custom source actor")).toBeVisible();
  await expect(composerText(frame, "阿洛娜")).toBeVisible();
  await expect(frame.locator('[data-typst-label^="mmt:avatar:"] image')).toHaveCount(2);
  await expect(draft).toHaveValue(unsent);
  await documentAction(page, "撤销");
  await expect.poll(() => canonicalText(page, name)).toBe(original);
  await documentAction(page, "重做");
  await expect.poll(() => canonicalText(page, name)).toBe(changed);
  await waitForComposerFrame(page, name);
  await testInfo.attach("source-role-body-order-rebound-chat", { body: await page.screenshot(), contentType: "image/png" });

  await switchAuthoringMode(page, "layout");
  expect(await waitForComposerFrame(page, name)).toBe(frame);
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "layout");
  await expect(composerText(frame, "Custom source actor")).toBeVisible();
  await expect(frame.locator('[data-typst-label^="mmt:avatar:"] image')).toHaveCount(2);
  await clickComposerBoundary(page, frame, "second source revised", "end");
  await page.keyboard.insertText(" in layout");
  const fromSvg = changed.replace("second source revised", "second source revised in layout");
  await expect.poll(() => canonicalText(page, name)).toBe(fromSvg);
  await switchAuthoringMode(page, "source");
  await expect(editor.locator(".view-lines")).toContainText("second source revised in layout");
  await editor.click();
  await page.keyboard.press("Control+z");
  await expect.poll(() => canonicalText(page, name)).toBe(changed);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => canonicalText(page, name)).toBe(fromSvg);

  // The native source and its existing preview split use the same retained SVG.
  await page.getByRole("tab", { name: "MomoScript", exact: true }).click();
  await page.getByRole("button", { name: "Typst 预览", exact: true }).click();
  const split = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  expect(split).toBe(frame);
  await expect(editor).toBeVisible();
  await expect(split.locator("body")).toHaveAttribute("data-presentation", "layout");
  await clickComposerBoundary(page, split, "second source revised in layout", "end");
  await page.keyboard.insertText(" split");
  await expect.poll(() => canonicalText(page, name)).toBe(fromSvg.replace(" in layout", " in layout split"));
  await page.keyboard.press("Control+z");
  await expect.poll(() => canonicalText(page, name)).toBe(fromSvg);
  const previewTab = page.getByRole("tab", { name: /^gui-source-layout-roundtrip\.mmt（预览）/u });
  await previewTab.getByRole("button", { name: /^关闭/u }).click();
  await expect(previewTab).toHaveCount(0);
  await editor.click();
  await page.getByRole("button", { name: "Typst 预览", exact: true }).click();
  const reopened = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  expect(reopened).toBe(frame);
  await expect(composerText(reopened, "second source revised in layout")).toBeVisible();
  await expect(editor).toBeVisible();
  const overlays = await Promise.all(page.frames().map(async (candidate) => {
    try { return await candidate.locator("textarea.composer-input-bridge").count(); } catch { return 0; }
  }));
  expect(overlays.reduce((sum, count) => sum + count, 0)).toBe(1);
  expect(await invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ modelCount: 1, textDocumentCount: 1 });
  await testInfo.attach("source-reopened-editable-output-split", { body: await page.screenshot(), contentType: "image/png" });
  frame = await returnToChatThroughCommand(page, name);
  await expect(composerText(frame, "second source revised in layout")).toBeVisible();
  await expect(draft).toHaveValue(unsent);
  expect(await canonicalText(page, name)).toBe(fromSvg);
  await draft.fill("");
});

test("real triple-click copies and cuts through trusted synchronous ClipboardEvents", { tag: tags }, async ({ page }) => {
  const name = "gui-text-triple-clipboard.mmt";
  const body = "Alpha beta gamma";
  const source = `- ${body}\n- untouched\n`;
  const frame = await openComposer(page, name, source);
  await inputBridge(frame).evaluate((element) => {
    for (const type of ["copy", "cut"]) element.addEventListener(type, (event) => {
      const clipboard = event as ClipboardEvent;
      // This listener follows the production listener in the same trusted event turn.
      const records = JSON.parse((element as HTMLElement).dataset.clipboardEvents ?? "[]");
      records.push({ type, trusted: event.isTrusted, prevented: event.defaultPrevented,
        text: clipboard.clipboardData?.getData("text/plain") });
      (element as HTMLElement).dataset.clipboardEvents = JSON.stringify(records);
    });
  });
  await selectBody(page, frame, body, body.length);
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(body);
  await expect.poll(() => inputBridge(frame).getAttribute("data-clipboard-events")).toBe(JSON.stringify([
    { type: "copy", trusted: true, prevented: true, text: body },
  ]));
  expect(await authored(page, name)).toBe(source);
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "ready");
  await page.keyboard.press("Control+x");
  await expect.poll(async () => (await textState(page)).bodies.map((entry) => entry.text)).toEqual(["", "untouched"]);
  await expect.poll(() => inputBridge(frame).getAttribute("data-clipboard-events")).toBe(JSON.stringify([
    { type: "copy", trusted: true, prevented: true, text: body },
    { type: "cut", trusted: true, prevented: true, text: body },
  ]));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(source);
});

test("synthetic Copy and Cut cannot acknowledge an OS clipboard write or delete an authorized selection", { tag: tags }, async ({ page }) => {
  const name = "gui-untrusted-clipboard.mmt";
  const body = "Only trusted clipboard events may cut";
  const source = `- ${body}\n- untouched\n`;
  const sentinel = "OS clipboard must remain unchanged";
  const frame = await openComposer(page, name, source);
  await selectBody(page, frame, body, body.length);
  const selected = (await textState(page)).selection;
  await page.evaluate((text) => navigator.clipboard.writeText(text), sentinel);
  const synthetic = await inputBridge(frame).evaluate((element) => ["copy", "cut"].map((type) => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return { type, trusted: event.isTrusted, prevented: event.defaultPrevented, text: clipboardData.getData("text/plain") };
  }));
  expect(synthetic).toEqual([
    { type: "copy", trusted: false, prevented: false, text: "" },
    { type: "cut", trusted: false, prevented: false, text: "" },
  ]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel);
  expect(await authored(page, name)).toBe(source);
  expect((await textState(page)).selection).toEqual(selected);

  await page.keyboard.press("Control+x");
  await expect.poll(async () => (await textState(page)).bodies.map((entry) => entry.text)).toEqual(["", "untouched"]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body);
  await inputBridge(frame).press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(source);
});

test("a drag can return from page whitespace without losing capture or the directional range", { tag: tags }, async ({ page }) => {
  const name = "gui-text-drag-return.mmt";
  const source = "- abcdefghijk\n- untouched\n";
  const frame = await openComposer(page, name, source);
  const origin = await composerGlyphBoundary(frame, "abcdefghijk", 1);
  const start = await framePoint(frame, origin);
  const middle = await framePoint(frame, await composerGlyphBoundary(frame, "abcdefghijk", 4));
  const end = await framePoint(frame, await composerGlyphBoundary(frame, "abcdefghijk", 7));
  const margin = await framePoint(frame, await frame.locator("svg.typst-renderer-root").evaluate((element, y) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.right - 1, y };
  }, origin.y));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(middle.x, middle.y, { steps: 6 });
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 0, offsetUtf16: 1 }, focus: { bodyIndex: 0, offsetUtf16: 4 },
  });
  const before = await textState(page);
  await page.mouse.move(margin.x, margin.y, { steps: 6 });
  await expect.poll(async () => (await textState(page)).pendingIntentCount).toBe(0);
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 0, offsetUtf16: 1 }, focus: { bodyIndex: 0, offsetUtf16: 7 },
  });
  expect((await textState(page)).sessionId).toBe(before.sessionId);
  expect(await authored(page, name)).toBe(source);
});

const mobilePointerTest = test.extend({ hasTouch: true });

mobilePointerTest("closing the role picker and finishing a mobile edit reauthorizes the next SVG body click without opening source", { tag: tags }, async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const name = "gui-mobile-fresh-pointer.mmt";
  const body = "mobile anchor";
  const source = `> 佳代子: ${body}\n> 阿洛娜: second body\n< _0: untouched tail\n`;
  const frame = await openComposer(page, name, source);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  const unsent = "Keep this unsent message separate from the canvas edit";
  await draft.fill(unsent);
  await clickComposerBoundary(page, frame, body, "end");
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 0, offsetUtf16: body.length },
    focus: { bodyIndex: 0, offsetUtf16: body.length },
  });

  const role = surface.getByRole("button", { name: /^切换角色 · /u });
  await role.click();
  const picker = surface.getByRole("dialog");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(role).toBeFocused();
  await page.setViewportSize({ width: 740, height: 320 });
  await waitForComposerFrame(page, name);
  await expect(frame.locator(".typst-page").first()).toHaveAttribute("data-page-width", "720");
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "chat");

  await surface.getByRole("button", { name: "完成编辑", exact: true }).click();
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(unsent);
  // A fresh hit must reacquire a current Rust-authorized caret, not replay the
  // retired selection or fall through to native source navigation.
  await clickComposerBoundary(page, frame, body, "end");
  await expect.poll(async () => {
    const state = await textState(page);
    return { selection: state.selection, pending: state.pendingIntentCount };
  }).toMatchObject({
    selection: {
      anchor: { bodyIndex: 0, offsetUtf16: body.length },
      focus: { bodyIndex: 0, offsetUtf16: body.length },
    },
    pending: 0,
  });
  await expect(inputBridge(frame)).toBeFocused();
  await expect(frame.locator(".composer-caret")).toBeVisible();
  await page.keyboard.insertText(" after finish");
  await expect.poll(() => canonicalText(page, name)).toBe(source.replace(body, `${body} after finish`));
  await expect(surface).toBeVisible();
  await expect(surface.getByRole("button", { name: "切换模式 · 当前为聊天创作", exact: true })).toBeVisible();
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "chat");
  await expect(draft).toHaveValue(unsent);
});

test("native selection menus preserve the range and dismiss when authored source changes", { tag: tags }, async ({ page }) => {
  const name = "gui-text-native-context.mmt";
  const body = "Native selected text";
  const source = `- ${body}\n- untouched\n`;
  const frame = await openComposer(page, name, source);
  const point = await selectBody(page, frame, body, body.length);
  const selected = (await textState(page)).selection;
  await page.mouse.click(point.x, point.y, { button: "right" });
  const copy = page.getByRole("menuitem", { name: /^复制(?:\s|$)/u });
  await expect(copy).toBeVisible();
  expect((await textState(page)).selection).toEqual(selected);
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(body);
  expect(await authored(page, name)).toBe(source);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const deletion = page.getByRole("menuitem", { name: "删除所选文字", exact: true });
  await expect(deletion).toBeVisible();
  await deletion.click();
  await expect.poll(async () => (await textState(page)).bodies.map((entry) => entry.text)).toEqual(["", "untouched"]);
  await documentAction(page, "撤销");
  await expect.poll(() => authored(page, name)).toBe(source);
  await waitForComposerFrame(page, name);
  const fresh = await selectBody(page, frame, body, body.length);
  await page.mouse.click(fresh.x, fresh.y, { button: "right" });
  await expect(copy).toBeVisible();
  const external = "- external replacement\n- untouched\n";
  await invokeMmtE2E(page, "workspace", "replaceDocument", name, external);
  await expect(copy).toBeHidden();
  await waitForComposerFrame(page, name);
  expect((await textState(page)).selection).toBeNull();
  expect(await authored(page, name)).toBe(external);
});

test("rejected cross-message replacement stays copyable and retries only after a fresh SVG target and explicit confirmation", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-explicit-text-recovery.mmt";
  const source = "> 佳代子: abc\n> 阿洛娜: def\n> _0: tail\n";
  const frame = await openComposer(page, name, source);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  const nextMessage = "This next message is not the failed canvas edit";
  const recovered = "RECOVERED ONLY HERE";
  await draft.fill(nextMessage);
  const start = await framePoint(frame, await composerGlyphBoundary(frame, "abc", 1));
  const end = await framePoint(frame, await composerGlyphBoundary(frame, "def", 2));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 0, offsetUtf16: 1 }, focus: { bodyIndex: 1, offsetUtf16: 2 },
  });
  // This candidate would rebind the following inherited actor. Rust rejects
  // the whole edit; the GUI must not weaken that source-ownership decision.
  await page.keyboard.insertText(recovered);
  await expect.poll(async () => (await textState(page)).recoveryText).toContain(recovered);
  expect(await canonicalText(page, name)).toBe(source);
  await expect(draft).toHaveValue(nextMessage);
  const recovery = surface.getByLabel("未提交文字恢复", { exact: true });
  await expect(recovery).toContainText("未提交文字已保留");
  await expect(recovery.getByRole("button", { name: "确认目标后重试", exact: true })).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await recovery.getByRole("button", { name: "查看 / 复制", exact: true }).click();
  let panel = surface.locator(".mmt-composer-sheet-panel");
  await expect(panel.getByRole("textbox")).toHaveValue(recovered);
  await expect(panel.getByRole("textbox")).toHaveJSProperty("readOnly", true);
  await panel.getByRole("button", { name: "复制这段文字", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(recovered);
  await testInfo.attach("390px-rejected-edit-recoverable-text", { body: await page.screenshot(), contentType: "image/png" });
  await panel.getByRole("button", { name: "返回画布选择目标", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(recovery.getByRole("button", { name: "确认目标后重试", exact: true })).toBeDisabled();
  expect(await canonicalText(page, name)).toBe(source);

  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, "def", 0);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 1, offsetUtf16: 0 }, focus: { bodyIndex: 1, offsetUtf16: 3 },
  });
  const retry = recovery.getByRole("button", { name: "确认目标后重试", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  panel = surface.locator(".mmt-composer-sheet-panel");
  await expect(panel.getByRole("heading", { name: "确认恢复目标", exact: true })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "保留的文字", exact: true })).toHaveValue(recovered);
  expect(await canonicalText(page, name)).toBe(source);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await canonicalText(page, name)).toBe(source);
  await expect(draft).toHaveValue(nextMessage);

  // Dismissal does not replay anything. Confirmation pins the newly chosen
  // range and submits through the same native undo/Rust authorization route.
  await clickComposerBoundary(page, frame, "def", 0);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect(retry).toBeEnabled();
  await retry.click();
  await surface.locator(".mmt-composer-sheet-panel").getByRole("button", { name: "确认此目标并重试", exact: true }).click();
  await expect.poll(async () => (await textState(page)).bodies.map((body) => body.text)).toEqual(["abc", recovered, "tail"]);
  await expect.poll(() => canonicalText(page, name)).toBe(source.replace("def", recovered));
  await waitForComposerFrame(page, name);
  await expect(composerText(frame, recovered)).toBeVisible();
  await expect(recovery).toBeHidden();
  await expect(draft).toHaveValue(nextMessage);
  await documentAction(page, "撤销");
  await expect.poll(() => canonicalText(page, name)).toBe(source);
  await documentAction(page, "重做");
  await expect.poll(() => canonicalText(page, name)).toBe(source.replace("def", recovered));
  await draft.fill("");
});

test("chat hides preview chrome while blocked, layout stays editable and plain Typst preview stays read-only", { tag: tags }, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 820 });
  const name = "gui-toolbar-presentation.mmt";
  const body = "Compact toolbar body";
  const source = `- ${body}\n`;
  const frame = await openComposer(page, name, source);
  const chat = async () => {
    await expect(frame.locator("body")).toHaveAttribute("data-presentation", "chat");
    await expect(frame.locator(".preview-toolbar")).toBeHidden();
  };
  await chat();
  const point = await framePoint(frame, await composerGlyphBoundary(frame, body, 2));
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByRole("menuitem", { name: "编辑正文…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑正文", exact: true });
  await expect(dialog).toBeVisible();
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "blocked");
  await chat();
  await testInfo.attach("chat-local-source-blocked", { body: await page.screenshot(), contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "ready");
  await chat();
  expect(await authored(page, name)).toBe(source);

  await switchAuthoringMode(page, "layout");
  expect(await waitForComposerFrame(page, name)).toBe(frame);
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "layout");
  for (const label of ["Zoom out", "Zoom in", "Fit width", "Fit page"]) {
    const button = frame.getByRole("button", { name: label, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect.poll(() => button.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width >= 44 && bounds.height >= 44;
    })).toBe(true);
  }
  await frame.getByRole("button", { name: "Fit width", exact: true }).click();
  await clickComposerBoundary(page, frame, body, "end");
  await page.keyboard.insertText(" layout");
  await expect.poll(() => authored(page, name)).toBe(`- ${body} layout\n`);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(source);
  await waitForComposerFrame(page, name);
  await testInfo.attach("layout-editable-controls-320px", { body: await page.screenshot(), contentType: "image/png" });

  await switchAuthoringMode(page, "source");
  await invokeMmtE2E(page, "preview", "open", `mmtfs://workspace/${name}`);
  const mmtPreview = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  await expect(mmtPreview.locator("body")).toHaveAttribute("data-presentation", "layout");
  await expect(mmtPreview.locator("body")).toHaveAttribute("data-composer-status", "ready");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    guiVisible: true, sourceVisible: false, modelCount: 1, textDocumentCount: 1,
  });
  await clickComposerBoundary(page, mmtPreview, body, "end");
  await page.keyboard.insertText(" preview pane");
  await expect.poll(() => authored(page, name)).toBe(`- ${body} preview pane\n`);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(source);
  const typstName = "plain-typst-preview.typ";
  const typstSource = '#set page(width: 240pt, height: 180pt, margin: 12pt)\nRead-only Typst preview';
  await invokeMmtE2E(page, "workspace", "openDocument", typstName, typstSource);
  await invokeMmtE2E(page, "preview", "open", `mmtfs://workspace/${typstName}`);
  let preview = await waitForPreviewFrame(page, `mmtfs://workspace/${typstName}`);
  await expect(preview.locator("body")).toHaveAttribute("data-presentation", "preview");
  await expect(preview.locator(".exact-export")).toBeVisible();
  await expect(preview.getByRole("combobox", { name: "Export format", exact: true })).toBeVisible();
  await composerText(preview, "Read-only Typst preview").click();
  const nativeEditor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(nativeEditor).toBeVisible();
  expect(await authored(page, typstName)).toBe(typstSource);
  await expect(preview.locator(".composer-caret")).toBeHidden();
  // A read-only preview click legitimately navigates into editable authored Source.
  await nativeEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nLegitimate native source edit");
  const editedTypst = `${typstSource}\nLegitimate native source edit`;
  await expect.poll(() => canonicalText(page, typstName)).toBe(editedTypst);
  await invokeMmtE2E(page, "preview", "open", `mmtfs://workspace/${typstName}`);
  preview = await waitForPreviewFrame(page, `mmtfs://workspace/${typstName}`);
  await expect.poll(async () => (await preview.locator(".tsel").allTextContents()).join(" ").replace(/\s+/gu, " "))
    .toContain("Legitimate native source edit");
  const output = await captureAcceptedOutput(preview);
  const downloadEvent = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Export current preview", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("plain-typst-preview.pdf");
  expectPdfPages(await saveOutputDownload(download, testInfo, "raw-typst-source-navigation"), output.pages);

  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  await chat();
  expect(await authored(page, name)).toBe(source);
});

test("Copy and Cut immediately after document selection retain semantic LF and CRLF source boundaries", { tag: tags }, async ({ page }) => {
  const name = "gui-pending-selection-clipboard.mmt";
  const tail = "\r\n\r\n@reply: A | B\r\n@bond: bond";
  const source = `- rt"""\r\n\r\n中\r\nnew\r\nline\r\n"""${tail}`;
  const frame = await openComposer(page, name, source);
  const point = await framePoint(frame, await composerGlyphBoundary(frame, "中", 0));
  await page.mouse.click(point.x, point.y);
  await expect(inputBridge(frame)).toBeFocused();
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: 0, offsetUtf16: 1 }, focus: { bodyIndex: 0, offsetUtf16: 1 },
  });
  await page.evaluate(() => navigator.clipboard.writeText("clipboard has not completed"));
  // Deliberately do not wait for geometry between navigation and the trusted
  // clipboard action: this is the recorded failing authoring sequence.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+End");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("\n中\nnew\nline\n");
  expect(await authored(page, name)).toBe(source);

  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+End");
  await page.keyboard.press("Control+x");
  await expect.poll(async () => (await textState(page)).bodies.map((entry) => entry.text)).toEqual([""]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("\n中\nnew\nline\n");
  const cutSource = await authored(page, name);
  expect(cutSource.endsWith(tail)).toBe(true);
  expect(cutSource.replace(/\r\n/gu, "")).not.toMatch(/[\r\n]/u);
  await inputBridge(frame).press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(source);
});
