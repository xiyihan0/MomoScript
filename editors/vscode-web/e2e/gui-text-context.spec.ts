import {
  composerGlyphBoundary,
  expect,
  invokeMmtE2E,
  test,
  type Frame,
  type Page,
  waitForComposerFrame,
  waitForPreviewFrame,
} from "./fixtures";

const tags = ["@editor-runtime", "@gui-composer"];
const inputBridge = (frame: Frame) => frame.locator("textarea.composer-input-bridge");
const textState = (page: Page) => invokeMmtE2E(page, "gui", "textState");
const authored = (page: Page, name: string) => invokeMmtE2E(page, "workspace", "readDocument", name);

async function openComposer(page: Page, name: string, source: string): Promise<Frame> {
  await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  return await waitForComposerFrame(page, name);
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
  await page.getByRole("region", { name: "MomoScript GUI 创作" }).getByRole("button", { name: "撤销", exact: true }).click();
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

test("GUI toolbar stays compact while text is blocked and restores normal preview controls on reattachment", { tag: tags }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 });
  const name = "gui-toolbar-presentation.mmt";
  const body = "Compact toolbar body";
  const source = `- ${body}\n`;
  const frame = await openComposer(page, name, source);
  const compact = async () => {
    await expect(frame.locator(".exact-export")).toBeHidden();
    for (const name of ["Zoom out", "Zoom in", "Fit width", "Fit page"]) {
      await expect(frame.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect.poll(() => frame.locator(".preview-toolbar").evaluate((element) => {
      const toolbar = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll(".zoom-controls button")].map((button) => button.getBoundingClientRect());
      return {
        compactHeight: toolbar.height <= 56,
        targets: buttons.length === 4 && buttons.every((button) => button.width >= 44 && button.height >= 44),
        oneRow: Math.max(...buttons.map((button) => button.top)) - Math.min(...buttons.map((button) => button.top)) < 1,
        inside: buttons.every((button) => button.left >= toolbar.left && button.right <= toolbar.right),
      };
    })).toEqual({ compactHeight: true, targets: true, oneRow: true, inside: true });
  };
  await compact();
  const point = await framePoint(frame, await composerGlyphBoundary(frame, body, 2));
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByRole("menuitem", { name: "编辑正文…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑正文", exact: true });
  await expect(dialog).toBeVisible();
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "blocked");
  await compact();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "ready");
  await compact();
  expect(await authored(page, name)).toBe(source);

  await invokeMmtE2E(page, "composer", "openSource", name);
  await invokeMmtE2E(page, "preview", "open", `mmtfs://workspace/${name}`);
  const preview = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  await expect(preview.locator("body")).toHaveAttribute("data-composer-surface", "false");
  await expect(preview.locator(".exact-export")).toBeVisible();
  await expect(preview.getByRole("combobox", { name: "Export format", exact: true })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Fit width", exact: true })).toHaveText("Fit width");
  await expect(preview.getByRole("button", { name: "Fit page", exact: true })).toHaveText("Fit page");
  const download = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Export current preview", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("gui-toolbar-presentation.pdf");

  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  await compact();
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
