import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PACK_BASE_URL, PACK_MANIFEST_URL } from "../src/runtimeArtifacts.ts";
import {
  clickComposerBoundary,
  composerGlyphBoundary,
  composerText,
  expect,
  invokeMmtE2E,
  test,
  type Download,
  type Frame,
  type Locator,
  type Page,
  waitForComposerFrame,
  waitForPreviewFrame,
} from "./fixtures";
import type { PreviewViewport } from "../src/previewWebviewProtocol.ts";
import {
  attachOutputManifest,
  captureAcceptedOutput,
  expectPdfPages,
  inspectOutputRaster,
  inspectOutputSvg,
  saveOutputDownload,
} from "./output-artifacts";

const tags = ["@editor-runtime", "@gui-composer"];
const guiSurface = (page: Page) => page.getByRole("region", { name: "MomoScript GUI 创作" });
const inputBridge = (frame: Frame) => frame.locator("textarea.composer-input-bridge");
const textState = (page: Page) => invokeMmtE2E(page, "gui", "textState");
const authored = (page: Page, name: string) => invokeMmtE2E(page, "workspace", "readDocument", name);
const canonicalText = (page: Page, name: string) => invokeMmtE2E(page, "workspace", "canonicalText", name);
const auxiliaryPanel = (page: Page) => guiSurface(page).locator(".mmt-composer-sheet-panel");
const selectedActions = (page: Page) => guiSurface(page).getByLabel("选中内容操作", { exact: true });
const packFixtureTag = "@gui-authoring-pack-fixture";
const missingCatalogTag = "@gui-authoring-without-catalog";
const packManifestValue = JSON.parse(await readFile(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));
// Give the existing explicit alternate-skin fixture an avatar too, so the
// real person → form → expression UI is exercised rather than a singleton.
packManifestValue.entities["晴_露营"].slots.avatar = {
  default: "default",
  items: { default: { storage: "avatars", path: "小雪.png" } },
};
const packManifest = Buffer.from(JSON.stringify(packManifestValue));
const entityCatalogValue = JSON.parse(await readFile(new URL("./fixtures/entity-catalog.json", import.meta.url), "utf8"));
entityCatalogValue.pack.manifest_sha256 = createHash("sha256").update(packManifest).digest("hex");
const entityCatalog = Buffer.from(JSON.stringify(entityCatalogValue));
const avatarFixtures = new Map(await Promise.all(["佳代子.png", "佳代子-smile.png", "小雪.png"].map(async (name) => [
  new URL(`assets/avatar/${name}`, PACK_BASE_URL).href,
  await readFile(new URL(`./fixtures/${name}`, import.meta.url)),
] as const)));
const alphaSequence = await readFile(new URL("./fixtures/alpha-sequence.avifs", import.meta.url));

async function installAuthoringPackFixture(page: Page, withoutCatalog: boolean): Promise<void> {
  const headers = (contentType: string) => ({
    "access-control-allow-origin": "*", "cache-control": "no-store", "content-type": contentType,
  });
  await page.route(PACK_MANIFEST_URL, (route) => route.fulfill({ status: 200, body: packManifest, headers: headers("application/json") }));
  await page.route(new URL("entity-catalog.json", PACK_MANIFEST_URL).href, (route) => route.fulfill(withoutCatalog
    ? { status: 404, headers: headers("application/json") }
    : { status: 200, body: entityCatalog, headers: headers("application/json") }));
  for (const [url, body] of avatarFixtures) {
    await page.route(url, (route) => route.fulfill({ status: 200, body, headers: headers("image/png") }));
  }
  await page.route(new URL("blobs/stickers/alpha/default.avifs", PACK_BASE_URL).href, (route) => route.fulfill({
    status: 200, body: alphaSequence, headers: headers("image/avif"),
  }));
}

async function createWorkThroughUi(page: Page, title: string): Promise<string> {
  await documentAction(page, "新建作品");
  const prompt = page.locator(".quick-input-widget");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("输入作品名");
  await prompt.locator("input").first().fill(title);
  await prompt.locator("input").first().press("Enter");
  await expect(prompt).toBeHidden();
  const name = `${title}.mmt`;
  await expect(guiSurface(page).getByRole("button", { name: `${title} · 作品菜单`, exact: true })).toBeVisible();
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    guiVisible: true, sourceVisible: false, modelCount: 1, textDocumentCount: 1,
  });
  await expect.poll(() => canonicalText(page, name)).toBe("");
  await expect(guiSurface(page).getByRole("heading", { name: "开始第一段对话", exact: true })).toBeVisible();
  return name;
}

async function expectIdentityPreview(row: Locator): Promise<void> {
  const preview = row.locator(".mmt-composer-identity-preview");
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((element) => {
    const visible = (child: Element) => {
      const style = getComputedStyle(child);
      return child.getClientRects().length > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0;
    };
    return [...element.querySelectorAll("img")].some((image) => image.complete && image.naturalWidth > 0 && visible(image))
      || [...element.querySelectorAll(".mmt-composer-avatar-initials")].some((initials) => !!initials.textContent?.trim() && visible(initials));
  })).toBe(true);
}

async function chooseAvatarThroughUi(
  page: Page,
  choice: { readonly search: string; readonly person: string; readonly entityId: string; readonly variantId?: string; readonly multipleForms?: boolean },
): Promise<void> {
  await guiSurface(page).getByRole("button", { name: "角色库", exact: true }).click();
  const panel = auxiliaryPanel(page);
  await expect(panel).toBeVisible();
  const search = panel.getByRole("textbox", { name: "搜索姓名、别名、学校或组织", exact: true });
  await search.fill(choice.search);
  const person = panel.locator("button[data-person]").filter({ hasText: choice.person });
  await expect(person).toBeVisible();
  await expectIdentityPreview(person);
  await search.fill("");
  await person.click();
  const form = panel.locator(`button[data-entity="${choice.entityId}"]:not([data-variant])`);
  if (choice.multipleForms || await form.count() > 0) await form.click();
  // A sole expression is selected immediately; entities with alternatives expose real cards.
  if (choice.variantId && await panel.isVisible()) {
    await panel.locator(`button[data-entity="${choice.entityId}"][data-variant="${choice.variantId}"]`).click();
  }
  await expect(panel).toBeHidden();
  await expect(guiSurface(page).locator(`.mmt-composer-role-chip[data-speaker="${choice.entityId}"]`)).toHaveAttribute("aria-pressed", "true");
}

async function expectSvgBodies(frame: Frame, bodies: readonly string[]): Promise<void> {
  // The selectable text is emitted by the same real SVG renderer used by pointer editing.
  await expect.poll(() => frame.locator('[data-typst-label^="mmt:bubble:"], [data-typst-label^="mmt:narration:"]')
    .evaluateAll((elements) => elements.map((element) => [...element.querySelectorAll(".tsel")].map((run) => run.textContent ?? "").join(""))))
    .toEqual(bodies);
}

async function svgAvatarSource(frame: Frame, body: string): Promise<string> {
  return composerText(frame, body).evaluate((element) => {
    const bubble = element.closest('[data-typst-label^="mmt:bubble:"]');
    const token = bubble?.getAttribute("data-typst-label")?.replace("mmt:bubble:", "");
    const image = bubble?.closest("svg")?.querySelector(`[data-typst-label="mmt:avatar:${token}"] image`);
    const href = image?.getAttribute("href") ?? image?.getAttribute("xlink:href");
    if (!href) throw new Error("The rendered message avatar is unavailable");
    return href;
  });
}

async function selectInsertPosition(page: Page, position: "before" | "after"): Promise<void> {
  await selectedActions(page).getByRole("button", { name: "插入", exact: true }).click();
  await auxiliaryPanel(page).getByRole("button", { name: new RegExp(`^在这条${position === "before" ? "前" : "后"}面插入`, "u") }).click();
  await expect(auxiliaryPanel(page)).toBeHidden();
  await expect(guiSurface(page).locator(".mmt-composer-send")).toHaveAccessibleName("插入");
}

async function openAddChoice(page: Page, label: string): Promise<Locator> {
  await guiSurface(page).getByRole("button", { name: "+ 添加", exact: true }).click();
  const panel = auxiliaryPanel(page);
  await panel.locator("button.mmt-composer-choice-row").filter({ has: page.locator("strong", { hasText: new RegExp(`^${label}$`, "u") }) }).click();
  return panel;
}

async function importedImageFile(page: Page, mimeType: "image/png" | "image/jpeg") {
  const dataUrl = await page.evaluate((type) => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image fixture encoder is unavailable");
    context.fillStyle = "#4a8ac6";
    context.fillRect(0, 0, 96, 64);
    context.fillStyle = "#f6b2c1";
    context.fillRect(12, 12, 32, 40);
    return canvas.toDataURL(type, 0.92);
  }, mimeType);
  return { name: mimeType === "image/png" ? "local-photo.png" : "local-photo.jpeg", mimeType, buffer: Buffer.from(dataUrl.split(",")[1]!, "base64") };
}

async function persistedImageFiles(page: Page): Promise<readonly { readonly path: string; readonly bytes: readonly number[] }[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const records = await new Promise<Array<{ path: string; data: Uint8Array }>>((resolve, reject) => {
        const request = database.transaction("files", "readonly").objectStore("files").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return records.filter((record) => /\/assets\/[^/]+\.(?:png|jpg)$/u.test(record.path))
        .map((record) => ({ path: record.path, bytes: [...record.data] })).sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      database.close();
    }
  });
}

async function openComposer(page: Page, name: string, source: string, mode: "chat" | "layout" = "chat"): Promise<Frame> {
  await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForComposerFrame(page, name);
  if (mode === "layout") await switchAuthoringMode(page, "layout");
  return await waitForComposerFrame(page, name);
}

async function expectBodies(page: Page, texts: readonly (string | null)[]): Promise<void> {
  await expect.poll(async () => (await textState(page)).bodies.map((body) => body.text)).toEqual(texts);
}

async function expectSelection(
  page: Page,
  anchor: readonly [bodyIndex: number, offsetUtf16: number],
  focus = anchor,
): Promise<void> {
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: anchor[0], offsetUtf16: anchor[1] },
    focus: { bodyIndex: focus[0], offsetUtf16: focus[1] },
  });
}

async function framePoint(frame: Frame, point: { x: number; y: number }) {
  const iframe = await frame.frameElement();
  const bounds = await iframe.boundingBox();
  if (!bounds) throw new Error("The Composer overlay is not visible");
  return { x: bounds.x + point.x, y: bounds.y + point.y };
}

async function dragBodies(
  page: Page,
  frame: Frame,
  anchor: readonly [fragment: string | RegExp, glyphBoundary: number, occurrence?: number],
  focus: readonly [fragment: string | RegExp, glyphBoundary: number, occurrence?: number],
): Promise<void> {
  const start = await framePoint(frame, await composerGlyphBoundary(frame, ...anchor));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Scroll the real viewport while retaining the real pointer capture, including across pages.
  const end = await framePoint(frame, await composerGlyphBoundary(frame, ...focus));
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function copySelection(page: Page, expected: string): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText("MMT copy has not completed"));
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
}

async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("Control+v");
}

async function resolveRecovery(page: Page, action: "copy" | "discard", expectedText: string): Promise<void> {
  const recovery = guiSurface(page).getByLabel("未提交文字恢复", { exact: true });
  await recovery.getByRole("button", { name: "查看 / 复制", exact: true }).click();
  const dialog = guiSurface(page).getByRole("dialog", { name: "未提交文字", exact: true });
  await expect(dialog).toBeVisible();
  const retainedText = (await textState(page)).recoveryText;
  await expect(dialog.getByRole("textbox")).toHaveValue(expectedText);
  await expect(dialog.getByRole("textbox")).toHaveJSProperty("readOnly", true);
  await dialog.getByRole("button", { name: action === "copy" ? "复制这段文字" : "放弃这段文字", exact: true }).click();
  if (action === "copy") {
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedText);
    await expect.poll(async () => (await textState(page)).recoveryText).toBe(retainedText);
    await dialog.getByRole("button", { name: "返回画布选择目标", exact: true }).click();
    await expect(recovery).toBeVisible();
  } else {
    await expect.poll(async () => (await textState(page)).recoveryText).toBe("");
    await expect(recovery).toBeHidden();
  }
  await expect(dialog).toBeHidden();
}

async function replaceWholeBody(page: Page, frame: Frame, fragment: string, replacement: string): Promise<void> {
  await clickComposerBoundary(page, frame, fragment, 0);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText(replacement);
}

async function composition(frame: Frame, phase: "start" | "update" | "end", text: string): Promise<void> {
  await inputBridge(frame).evaluate((element, event) => {
    const input = element as HTMLTextAreaElement;
    if (event.phase !== "start") input.value = event.text;
    input.dispatchEvent(new CompositionEvent(`composition${event.phase}`, { bubbles: true, data: event.text }));
    if (event.phase === "update") {
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertCompositionText", data: event.text, isComposing: true,
      }));
    }
  }, { phase, text });
}

async function expectCaretAtGlyph(frame: Frame, fragment: string, boundary: number | "end", occurrence = 0): Promise<void> {
  const point = await composerGlyphBoundary(frame, fragment, boundary, occurrence);
  await expect.poll(async () => {
    const caret = frame.locator(".composer-caret");
    if (await caret.count() !== 1) return Number.POSITIVE_INFINITY;
    return await caret.evaluate((element, expected) => {
      const rect = element.getBoundingClientRect();
      if (Number((element as HTMLElement).dataset.pageIndex) !== expected.pageIndex
        || rect.bottom <= expected.top || rect.top >= expected.bottom) return Number.POSITIVE_INFINITY;
      return Math.max(Math.abs(rect.left - expected.x), Math.abs(rect.top - expected.lineTop));
    }, point);
  }, { message: "caret must follow both SVG glyph advance and line origin within one CSS pixel" }).toBeLessThanOrEqual(1);
}

async function waitForViewportSettled(frame: Frame): Promise<void> {
  await frame.evaluate(async () => {
    const settle = Reflect.get(globalThis, "__mmtWaitForPreviewViewportSettled");
    if (typeof settle !== "function") throw new Error("preview viewport settle acknowledgement is unavailable");
    await settle();
  });
}

async function previewViewport(page: Page): Promise<PreviewViewport> {
  const state = await invokeMmtE2E(page, "preview", "interactionFixture", { action: "state" });
  if (!state || typeof state !== "object" || !("viewport" in state)) throw new Error("preview viewport state is unavailable");
  return state.viewport;
}

async function viewportReading(frame: Frame) {
  return frame.locator(".viewport").evaluate((element) => {
    const visible = element.getBoundingClientRect();
    const rendered = element.querySelector(".page")?.getBoundingClientRect();
    if (!rendered || rendered.width <= 0 || rendered.height <= 0) throw new Error("the rendered page is unavailable");
    return {
      x: (visible.left + visible.width / 2 - rendered.left) / rendered.width,
      y: (visible.top + visible.height / 2 - rendered.top) / rendered.height,
      width: rendered.width,
      height: rendered.height,
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
      scrollTop: element.scrollTop,
    };
  });
}

async function expectReadingPoint(frame: Frame, point: { readonly x: number; readonly y: number }): Promise<void> {
  await expect.poll(async () => {
    const current = await viewportReading(frame);
    return Math.max(Math.abs(current.x - point.x) * current.width, Math.abs(current.y - point.y) * current.height);
  }, { message: "the same document point must remain at the viewport center within one CSS pixel" }).toBeLessThanOrEqual(1);
}

async function scrollPreviewToFraction(page: Page, frame: Frame, fraction: number): Promise<void> {
  const viewport = frame.locator(".viewport");
  const bounds = await viewport.boundingBox();
  if (!bounds) throw new Error("the preview viewport is unavailable");
  const target = await viewport.evaluate((element, position) => (element.scrollHeight - element.clientHeight) * position, fraction);
  const current = await viewport.evaluate((element) => element.scrollTop);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, target - current);
  await expect.poll(async () => Math.abs(await viewport.evaluate((element) => element.scrollTop) - target)).toBeLessThanOrEqual(1);
  await waitForViewportSettled(frame);
}



async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function nativeMenuItem(page: Page, label: string) {
  return page.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]').filter({ hasText: label }).last();
}

async function openProperties(page: Page): Promise<Locator> {
  await selectedActions(page).getByRole("button", { name: "更多", exact: true }).click();
  const panel = auxiliaryPanel(page);
  await expect(panel.getByRole("heading", { name: "内容属性", exact: true })).toBeVisible();
  return panel;
}

async function openLocalSource(page: Page): Promise<void> {
  const panel = await openProperties(page);
  await panel.getByRole("button", { name: "高级 / 局部源码", exact: true }).click();
  await panel.getByRole("button", { name: "编辑局部源码", exact: true }).click();
}

async function documentAction(page: Page, label: string): Promise<void> {
  await guiSurface(page).getByRole("button", { name: / · 作品菜单$/u }).click();
  const menu = guiSurface(page).getByRole("dialog", { name: "作品菜单", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: label, exact: true }).click();
  if (label === "保存") await expect(guiSurface(page).locator(".mmt-composer-save-state")).toHaveText("已保存");
}

async function switchAuthoringMode(page: Page, mode: "chat" | "layout" | "source"): Promise<void> {
  const labels = { chat: "聊天创作", layout: "排版预览", source: "源码" } as const;
  await guiSurface(page).getByRole("button", { name: /^切换模式 · /u }).click();
  const dialog = guiSurface(page).getByRole("dialog", { name: "切换模式", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: new RegExp(`^${labels[mode]}(?:\\s|$)`, "u") }).click();
}

async function returnToChatFromSource(page: Page, name: string): Promise<Frame> {
  await page.keyboard.press("Control+Shift+p");
  const command = page.locator(".quick-input-widget input").first();
  await expect(command).toBeVisible();
  await command.fill(">打开 GUI 创作");
  await page.keyboard.press("Enter");
  return await waitForComposerFrame(page, name);
}

async function expectReachableControl(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect.poll(() => control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const viewport = visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    return bounds.width >= 44 && bounds.height >= 44 && bounds.left >= left && bounds.top >= top
      && bounds.right <= left + (viewport?.width ?? innerWidth) + 1
      && bounds.bottom <= top + (viewport?.height ?? innerHeight) + 1;
  })).toBe(true);
}

async function expectHeaderActionsInViewport(page: Page): Promise<void> {
  const header = guiSurface(page).locator("header");
  await expectReachableControl(header.getByRole("button", { name: / · 作品菜单$/u }));
  await expectReachableControl(header.getByRole("button", { name: /^切换模式 · /u }));
  await expectReachableControl(header.getByRole("button", { name: "导出作品", exact: true }));
}

async function expectChatReadingScale(frame: Frame): Promise<void> {
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "chat");
  await expect(frame.locator(".preview-toolbar")).toBeHidden();
  await expect.poll(() => frame.locator("svg.typst-renderer-root").first().evaluate((element) => {
    const transform = (element as SVGSVGElement).getScreenCTM();
    if (!transform) throw new Error("the displayed SVG transform is unavailable");
    return Math.max(Math.abs(Math.hypot(transform.a, transform.b) - 1), Math.abs(Math.hypot(transform.c, transform.d) - 1));
  }), { message: "chat must display one native SVG logical unit as one CSS pixel" }).toBeLessThanOrEqual(0.01);
}

async function waitForChatCanvasResize(page: Page, frame: Frame): Promise<void> {
  const surface = guiSurface(page);
  const canvas = surface.getByRole("main", { name: "聊天创作画布", exact: true });
  const width = page.viewportSize()?.width;
  if (width === undefined) throw new Error("The browser viewport is unavailable");
  await expect.poll(async () => {
    const [root, visible] = await Promise.all([surface.boundingBox(), canvas.boundingBox()]);
    const pageWidth = Number(await frame.locator(".typst-page").first().getAttribute("data-page-width"));
    if (!root || !visible || visible.height <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(Math.abs(root.width - width), Math.abs(pageWidth - Math.max(240, Math.min(720, Math.round(visible.width)))));
  }, { message: "the visible chat frame must match the resized native canvas before pointer admission" }).toBeLessThanOrEqual(1);
  await expect(frame.locator("body")).toHaveAttribute("data-composer-status", "ready");
}

async function expectNoRootOverflow(page: Page, frame: Frame): Promise<void> {
  await expect.poll(() => page.evaluate(() => Math.max(
    document.documentElement.scrollWidth, document.body.scrollWidth,
  ) - innerWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => frame.locator(".viewport").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }, testInfo) => {
  const mobile = testInfo.tags.includes("@gui-novice-mobile");
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 820 });
  if (testInfo.tags.includes(packFixtureTag)) {
    await installAuthoringPackFixture(page, testInfo.tags.includes(missingCatalogTag));
  }
  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "mobile", width: 390, height: 844, touch: true },
] as const) {
  test.describe(`novice authoring on ${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch });
    test("fresh product entry creates a named work, chooses two people, writes three lines and edits, moves, undoes, redoes and exports the final work through visible controls", {
      tag: [...tags, packFixtureTag, ...(viewport.touch ? ["@gui-novice-mobile", "@gui-composer-mobile"] : [])],
    }, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const surface = guiSurface(page);
      // A fresh browser context enters the product without an API-created document,
      // command-palette shortcut or storage seed.
      await expect(surface).toBeVisible();
      await expect(surface.getByRole("button", { name: "story · 作品菜单", exact: true })).toBeVisible();
      await expect(surface.getByRole("button", { name: "切换模式 · 当前为聊天创作", exact: true })).toBeVisible();
      const name = await createWorkThroughUi(page, "放学后的约定");
      const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
      await expectHeaderActionsInViewport(page);
      await testInfo.attach(`${viewport.name}-novice-empty-work`, { body: await page.screenshot(), contentType: "image/png" });

      await surface.getByRole("button", { name: "选择角色", exact: true }).click();
      let panel = auxiliaryPanel(page);
      await panel.getByRole("textbox", { name: "搜索姓名、别名、学校或组织", exact: true }).fill("Kayoko");
      await expect(panel.locator("button[data-person]").filter({ hasText: "鬼方佳代子" })).toBeVisible();
      await panel.getByRole("textbox", { name: "搜索姓名、别名、学校或组织", exact: true }).fill("");
      const person = panel.locator("button[data-person]").filter({ hasText: "鬼方佳代子" });
      await expectIdentityPreview(person);
      await person.click();
      await expect(panel.locator('button[data-entity="ba::佳代子"]')).toContainText("形态未标注");
      await expect(panel.locator('button[data-entity="ba::晴_露营"]')).toContainText("露营");
      const form = panel.locator('button[data-entity="ba::佳代子"]');
      await expectIdentityPreview(form);
      await form.click();
      const smile = panel.locator('button[data-entity="ba::佳代子"][data-variant="smile"]');
      await expect(smile).toBeEnabled();
      await expect(smile.locator("img")).toBeVisible();
      await expect.poll(() => smile.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expectReachableControl(panel.getByRole("button", { name: "关闭", exact: true }));
      await testInfo.attach(`${viewport.name}-novice-form-expression`, { body: await page.screenshot(), contentType: "image/png" });
      await smile.click();
      await expect(panel).toBeHidden();
      await expect(surface.locator('.mmt-composer-role-chip[data-speaker="ba::佳代子"]')).toHaveAttribute("aria-pressed", "true");
      await expect(surface.getByRole("button", { name: "形态 / 表情 · smile", exact: true })).toBeVisible();

      const lines = ["First meeting", "Second promise", "Third reply"];
      const commits: string[] = [];
      for (const body of lines.slice(0, 2)) {
        await draft.fill(body);
        await draft.press("Enter");
        try {
          await expect(draft).toHaveValue("", { timeout: 15_000 });
        } catch (error) {
          await testInfo.attach("failed-message-transaction", {
            body: JSON.stringify({
              runtime: await invokeMmtE2E(page, "gui", "state"),
              text: await textState(page),
              source: await canonicalText(page, name),
            }, null, 2),
            contentType: "application/json",
          });
          throw error;
        }
        const frame = await waitForComposerFrame(page, name);
        await expectBodies(page, lines.slice(0, commits.length + 1));
        await expectSvgBodies(frame, lines.slice(0, commits.length + 1));
        await expect(surface.locator('.mmt-composer-role-chip[data-speaker="ba::佳代子"]')).toHaveAttribute("aria-pressed", "true");
        await expect(surface.getByRole("button", { name: "形态 / 表情 · smile", exact: true })).toBeVisible();
        commits.push(await canonicalText(page, name));
      }
      let frame = await waitForComposerFrame(page, name);
      const firstAvatar = await svgAvatarSource(frame, lines[0]!);
      expect(commits[1]).toContain("ba::佳代子");
      expect(commits[1]).toContain("smile");
      await clickComposerBoundary(page, frame, lines[1]!, 0);
      await selectedActions(page).getByRole("button", { name: "更多", exact: true }).click();
      panel = auxiliaryPanel(page);
      await expect(panel).toContainText("ba::佳代子 · smile");
      await panel.getByRole("button", { name: "关闭", exact: true }).click();

      // 小雪 has a single available form and expression, so the same real picker
      // forwards those levels instead of presenting redundant choices.
      await chooseAvatarThroughUi(page, { search: "Koyuki", person: "小雪", entityId: "ba::小雪" });
      await expect(surface.getByRole("button", { name: "形态 / 表情 · default", exact: true })).toBeVisible();
      await draft.fill(lines[2]!);
      await surface.getByRole("button", { name: "发送", exact: true }).click();
      await expect(draft).toHaveValue("");
      frame = await waitForComposerFrame(page, name);
      await expectBodies(page, lines);
      await expectSvgBodies(frame, lines);
      const written = await canonicalText(page, name);
      expect(written).toContain("ba::小雪");
      expect(await svgAvatarSource(frame, lines[2]!)).not.toBe(firstAvatar);
      const secondStatement = (await textState(page)).bodies[1]!.statementRange;
      expect(written.split(/\r?\n/u).slice(secondStatement.start.line, secondStatement.end.line + 1).join("\n")).toContain("Second promise");

      const unsent = "The next message stays a draft";
      await draft.fill(unsent);
      await replaceWholeBody(page, frame, lines[1]!, "Second promise revised");
      const edited = [lines[0]!, "Second promise revised", lines[2]!];
      await expectBodies(page, edited);
      await expect(draft).toHaveValue(unsent);
      frame = await waitForComposerFrame(page, name);
      await expectSvgBodies(frame, edited);
      await expect(selectedActions(page)).toContainText("正在修改第 2 条");
      await selectedActions(page).getByRole("button", { name: "完成编辑", exact: true }).click();
      const beforeMove = await canonicalText(page, name);
      expect(beforeMove).toBe(written.replace("Second promise", "Second promise revised"));
      await expect(draft).toHaveValue(unsent);
      await testInfo.attach(`${viewport.name}-novice-second-body-edited`, { body: await page.screenshot(), contentType: "image/png" });

      await selectedActions(page).getByRole("button", { name: "移动", exact: true }).click();
      panel = auxiliaryPanel(page);
      await expect(panel.getByRole("heading", { name: "移动内容", exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "上移", exact: true }).click();
      const reordered = [edited[1]!, edited[0]!, edited[2]!];
      await expectBodies(page, reordered);
      frame = await waitForComposerFrame(page, name);
      await expectSvgBodies(frame, reordered);
      const moved = await canonicalText(page, name);
      expect(moved.indexOf("Second promise revised")).toBeLessThan(moved.indexOf("First meeting"));
      expect(moved).toContain("smile");
      await documentAction(page, "撤销");
      await expect.poll(() => canonicalText(page, name)).toBe(beforeMove);
      frame = await waitForComposerFrame(page, name);
      await expectBodies(page, edited);
      await expectSvgBodies(frame, edited);
      await documentAction(page, "重做");
      await expect.poll(() => canonicalText(page, name)).toBe(moved);
      frame = await waitForComposerFrame(page, name);
      await expectBodies(page, reordered);
      await expectSvgBodies(frame, reordered);
      await expect(draft).toHaveValue(unsent);
      await expect(surface.locator('.mmt-composer-role-chip[data-speaker="ba::小雪"]')).toHaveAttribute("aria-pressed", "true");
      await expectNoRootOverflow(page, frame);
      await expectHeaderActionsInViewport(page);
      await testInfo.attach(`${viewport.name}-novice-reordered-redone`, { body: await page.screenshot(), contentType: "image/png" });
      await surface.getByRole("button", { name: "导出作品", exact: true }).click();
      const exportPanel = surface.getByRole("dialog", { name: "导出作品", exact: true });
      await expect(exportPanel).toBeVisible();
      frame = await waitForComposerFrame(page, name);
      await expect(frame.locator("body")).toHaveAttribute("data-presentation", "layout");
      await exportPanel.getByRole("button", { name: "关闭", exact: true }).click();
      await expectSvgBodies(frame, reordered);
      const output = await captureAcceptedOutput(frame);
      expect(output.pages.flatMap((outputPage) => outputPage.content.map((entry) => entry.text))).toEqual(reordered);
      expect(output.pages).toHaveLength(1);
      await surface.getByRole("button", { name: "导出作品", exact: true }).click();
      await expect(exportPanel).toBeVisible();
      await expect(exportPanel).toContainText("未发送的草稿不包含在本次导出中。");
      const format = exportPanel.getByRole("combobox", { name: "导出格式", exact: true });
      await expect(format).toHaveValue("pdf");
      await expect(exportPanel.getByRole("combobox", { name: "输出页", exact: true })).toBeHidden();
      await expectReachableControl(exportPanel.getByRole("button", { name: "下载 PDF", exact: true }));
      await expectReachableControl(exportPanel.getByRole("button", { name: "关闭", exact: true }));
      await testInfo.attach(`${viewport.name}-novice-output-panel`, { body: await page.screenshot(), contentType: "image/png" });
      const evidenceName = `${viewport.name}-novice-final-work`;
      await attachOutputManifest(testInfo, evidenceName, { ...output, source: moved, bodies: reordered, excludedDraft: unsent });

      const pdfEvent = page.waitForEvent("download");
      await exportPanel.getByRole("button", { name: "下载 PDF", exact: true }).click();
      const pdfDownload = await pdfEvent;
      expect(pdfDownload.suggestedFilename()).toBe("放学后的约定.pdf");
      expectPdfPages(await saveOutputDownload(pdfDownload, testInfo, evidenceName), output.pages);
      await expect(exportPanel).toContainText(pdfDownload.suggestedFilename());

      await format.selectOption("svg");
      await expect(exportPanel.getByRole("combobox", { name: "输出页", exact: true })).toHaveValue("0");
      const svgEvent = page.waitForEvent("download");
      await exportPanel.getByRole("button", { name: "下载 SVG", exact: true }).click();
      const svgDownload = await svgEvent;
      expect(svgDownload.suggestedFilename()).toBe("放学后的约定-page-1.svg");
      const svg = await saveOutputDownload(svgDownload, testInfo, evidenceName);
      const decodedSvg = await inspectOutputSvg(page, svg, output.pages[0]!, testInfo, evidenceName);
      for (const imageFormat of ["png", "jpg"] as const) {
        await format.selectOption(imageFormat);
        await expect(exportPanel).toContainText(`图片尺寸：${decodedSvg.width} × ${decodedSvg.height} px（2×）`);
        const imageEvent = page.waitForEvent("download");
        await exportPanel.getByRole("button", { name: `下载 ${imageFormat.toUpperCase()}`, exact: true }).click();
        const imageDownload = await imageEvent;
        expect(imageDownload.suggestedFilename()).toBe(`放学后的约定-page-1.${imageFormat}`);
        await inspectOutputRaster(page, await saveOutputDownload(imageDownload, testInfo, evidenceName), imageFormat, decodedSvg, testInfo, evidenceName);
      }
      await expect.poll(() => invokeMmtE2E(page, "exactExport", "fixture", { action: "state" })).toMatchObject({
        phase: "complete", completedRenderKey: output.renderKey,
      });
      expect(await canonicalText(page, name)).toBe(moved);
      await exportPanel.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(exportPanel).toBeHidden();
      await testInfo.attach(`${viewport.name}-novice-final-output-layout`, { body: await page.screenshot(), contentType: "image/png" });
      await switchAuthoringMode(page, "chat");
      frame = await waitForComposerFrame(page, name);
      await expect(draft).toHaveValue(unsent);
      await expectSvgBodies(frame, reordered);
      const sourceEvent = page.waitForEvent("download");
      await documentAction(page, "下载源文件");
      const sourceDownload = await sourceEvent;
      expect(sourceDownload.suggestedFilename()).toBe(name);
      expect((await saveOutputDownload(sourceDownload, testInfo, evidenceName)).toString("utf8")).toBe(moved);
      await expect(draft).toHaveValue(unsent);
      await draft.fill("");
    });
  });
}

test("local PNG and JPEG imports are atomic media blocks, reuse declared assets and preserve an explicit insertion target and pending text", {
  tag: [...tags, packFixtureTag],
}, async ({ page }, testInfo) => {
  const name = "gui-local-media-import.mmt";
  let frame = await openComposer(page, name, "> 佳代子: media before\n- media tail\n");
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await chooseAvatarThroughUi(page, { search: "Kayoko", person: "鬼方佳代子", entityId: "ba::佳代子", variantId: "smile", multipleForms: true });
  await draft.fill("do not consume this unsent text");
  await clickComposerBoundary(page, frame, "media tail", 0);
  await selectInsertPosition(page, "before");
  await expect(surface.locator(".mmt-composer-insert-status")).toContainText("media tail");

  for (const mimeType of ["image/png", "image/jpeg"] as const) {
    const before = await canonicalText(page, name);
    const filesBefore = await persistedImageFiles(page);
    const file = await importedImageFile(page, mimeType);
    const panel = await openAddChoice(page, "图片");
    const chooser = page.waitForEvent("filechooser");
    await panel.getByRole("button", { name: "导入本地 PNG / JPEG", exact: true }).click();
    await (await chooser).setFiles(file);
    await expect(panel).toBeHidden();
    frame = await waitForComposerFrame(page, name);
    await expect(draft).toHaveValue("do not consume this unsent text");
    await expect.poll(async () => (await persistedImageFiles(page)).length).toBe(filesBefore.length + 1);
    const imported = (await persistedImageFiles(page)).find((entry) => !filesBefore.some((old) => old.path === entry.path))!;
    expect(imported.path).toMatch(new RegExp(`/assets/[0-9a-f-]{36}\\.${mimeType === "image/png" ? "png" : "jpg"}$`, "u"));
    expect(Buffer.from(imported.bytes)).toEqual(file.buffer);
    const committed = await canonicalText(page, name);
    expect(committed).toContain(imported.path.replace(/^\//u, ""));
    const bodies = (await textState(page)).bodies;
    expect(bodies[0]?.text).toBe("media before");
    expect(bodies.at(-1)?.text).toBe("media tail");
    expect(bodies.filter((body) => body.text === null)).toHaveLength(filesBefore.length + 1);
    await documentAction(page, "撤销");
    await expect.poll(() => canonicalText(page, name)).toBe(before);
    await documentAction(page, "重做");
    await expect.poll(() => canonicalText(page, name)).toBe(committed);
    frame = await waitForComposerFrame(page, name);
    await expect(draft).toHaveValue("do not consume this unsent text");
    // Re-select the authored boundary after undo/redo; never guess a nearest target.
    await clickComposerBoundary(page, frame, "media tail", 0);
    await selectInsertPosition(page, "before");
    const insertionSummary = surface.locator(".mmt-composer-insert-status");
    await expect(insertionSummary).toContainText("非文本消息");
    await expect(insertionSummary).toContainText("media tail");
    await expect(insertionSummary).not.toContainText(/\[:asset\b|@asset\b|assets\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
  }

  const mediaImages = frame.locator('[data-typst-label^="mmt:bubble:"] image');
  await expect(mediaImages).toHaveCount(2);
  await mediaImages.first().click();
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  await expect(frame.locator(".composer-caret")).toBeHidden();
  await expect(selectedActions(page).getByRole("button", { name: "编辑", exact: true })).toBeHidden();
  await selectedActions(page).getByRole("button", { name: "更多", exact: true }).click();
  let panel = auxiliaryPanel(page);
  await panel.getByLabel("左右", { exact: true }).selectOption("right");
  await panel.getByRole("button", { name: "应用左右", exact: true }).click();
  frame = await waitForComposerFrame(page, name);
  await mediaImages.first().click();
  await selectedActions(page).getByRole("button", { name: "更多", exact: true }).click();
  panel = auxiliaryPanel(page);
  await expect(panel.getByLabel("左右", { exact: true })).toHaveValue("right");
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(draft).toHaveValue("do not consume this unsent text");
  await testInfo.attach("local-media-block-right-side", { body: await page.screenshot(), contentType: "image/png" });

  await surface.getByRole("button", { name: "返回末尾", exact: true }).click();
  const filesBeforeReuse = await persistedImageFiles(page);
  const beforeReuse = await canonicalText(page, name);
  panel = await openAddChoice(page, "图片");
  const existing = panel.locator("button.mmt-composer-choice-row").filter({ hasText: "已声明的图片资源" }).first();
  const assetName = await existing.locator("strong").innerText();
  await existing.click();
  frame = await waitForComposerFrame(page, name);
  expect(await canonicalText(page, name)).not.toBe(beforeReuse);
  expect(await canonicalText(page, name)).toContain(assetName);
  expect(await persistedImageFiles(page)).toEqual(filesBeforeReuse);
  expect((await textState(page)).bodies.at(-1)?.text).toBeNull();
  await expect(draft).toHaveValue("do not consume this unsent text");
  await draft.fill("");
});

test("a rejected local-image apply removes only the new import and retains the exact draft and insertion boundary", {
  tag: [...tags, packFixtureTag],
}, async ({ page }) => {
  const name = "gui-rejected-local-media.mmt";
  const original = "- import before\n- import tail\n";
  let frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  const pending = "keep this text after a failed photo";
  await draft.fill(pending);
  await clickComposerBoundary(page, frame, "import tail", 0);
  await selectInsertPosition(page, "before");
  const filesBefore = await persistedImageFiles(page);
  const file = await importedImageFile(page, "image/png");
  const panel = await openAddChoice(page, "图片");
  const chooser = page.waitForEvent("filechooser");
  await panel.getByRole("button", { name: "导入本地 PNG / JPEG", exact: true }).click();
  // The established native-apply failure seam rejects the edit after real
  // decoding/persistence, without substituting a media or renderer mock.
  await invokeMmtE2E(page, "composer", "failNextApply");
  await (await chooser).setFiles(file);
  await expect(panel.getByRole("alert")).toContainText("未能插入图片或差分");
  await expect.poll(() => canonicalText(page, name)).toBe(original);
  await expect.poll(() => persistedImageFiles(page)).toEqual(filesBefore);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(draft).toHaveValue(pending);
  await expect(surface.locator(".mmt-composer-insert-status")).toContainText("import tail");
  await expect(surface.locator(".mmt-composer-send")).toBeEnabled();
  await surface.locator(".mmt-composer-send").click();
  frame = await waitForComposerFrame(page, name);
  await expectBodies(page, ["import before", pending, "import tail"]);
  await expectSvgBodies(frame, ["import before", pending, "import tail"]);
  await expect(draft).toHaveValue("");
  expect(await persistedImageFiles(page)).toEqual(filesBefore);
});

test("the GUI sticker picker inserts the selected entity, set and ordinal as a non-caret media block", {
  tag: [...tags, packFixtureTag],
}, async ({ page }, testInfo) => {
  const name = "gui-sticker-media-choice.mmt";
  let frame = await openComposer(page, name, "- sticker before\n- sticker tail\n");
  await clickComposerBoundary(page, frame, "sticker tail", 0);
  await selectInsertPosition(page, "before");
  const before = await canonicalText(page, name);
  let panel = await openAddChoice(page, "角色差分");
  await panel.getByRole("textbox", { name: "搜索姓名、别名、学校或组织", exact: true }).fill("Kayoko");
  await panel.locator("button.mmt-composer-choice-row").filter({ has: page.locator("strong", { hasText: "鬼方佳代子" }) }).click();
  const form = panel.locator("button.mmt-composer-choice-row").filter({ has: page.locator("strong", { hasText: "形态未标注 · 鬼方佳代子" }) });
  if (await form.count() > 0) await form.click();
  await panel.locator("button.mmt-composer-choice-row").filter({ has: page.locator("strong", { hasText: /^default$/u }) }).click();
  const sticker = panel.locator('button[data-ordinal="2"]');
  await expect(sticker.locator("img")).toBeVisible();
  await expect(sticker).toBeEnabled();
  await testInfo.attach("gui-sticker-person-form-set-ordinal", { body: await page.screenshot(), contentType: "image/png" });
  await sticker.click();
  await expect(panel).toBeHidden();
  frame = await waitForComposerFrame(page, name);
  await expectBodies(page, ["sticker before", null, "sticker tail"]);
  const committed = await canonicalText(page, name);
  expect(committed).toContain("ba::佳代子");
  expect(committed).toContain("default");
  const image = frame.locator('[data-typst-label^="mmt:bubble:"] image');
  await expect(image).toHaveCount(1);
  await image.click();
  await expect(frame.locator(".composer-caret")).toBeHidden();
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  await selectedActions(page).getByRole("button", { name: "更多", exact: true }).click();
  panel = auxiliaryPanel(page);
  await expect(panel.getByLabel("左右", { exact: true })).toHaveValue("right");
  expect(await panel.getByLabel("左右", { exact: true }).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(["right"]);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await documentAction(page, "撤销");
  await expect.poll(() => canonicalText(page, name)).toBe(before);
  await documentAction(page, "重做");
  await expect.poll(() => canonicalText(page, name)).toBe(committed);
  frame = await waitForComposerFrame(page, name);
  await expect(frame.locator('[data-typst-label^="mmt:bubble:"] image')).toHaveCount(1);
});

test("a removed explicit insertion target keeps the pending draft disabled until the author chooses a fresh boundary", {
  tag: tags,
}, async ({ page }, testInfo) => {
  const name = "gui-invalid-insert-target.mmt";
  const original = "- before target\n- removed target\n- untouched tail\n";
  let frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await clickComposerBoundary(page, frame, "removed target", 0);
  await selectInsertPosition(page, "before");
  const unsent = "recover this exact draft 😀";
  await draft.fill(unsent);
  // External source replacement is an edge-case fixture, not a shortcut for UI authoring.
  const changed = "- before target\n- untouched tail\n";
  await invokeMmtE2E(page, "workspace", "replaceDocument", name, changed);
  frame = await waitForComposerFrame(page, name);
  await expect(surface.locator(".mmt-composer-insert-status")).toContainText("插入位置已失效");
  await expect(surface.locator(".mmt-composer-send")).toBeDisabled();
  await expect(draft).toHaveValue(unsent);
  await draft.press("Enter");
  expect(await canonicalText(page, name)).toBe(changed);
  await testInfo.attach("invalid-insert-target-retains-draft", { body: await page.screenshot(), contentType: "image/png" });
  await clickComposerBoundary(page, frame, "untouched tail", 0);
  await selectInsertPosition(page, "before");
  await surface.locator(".mmt-composer-send").click();
  frame = await waitForComposerFrame(page, name);
  await expectBodies(page, ["before target", unsent, "untouched tail"]);
  await expectSvgBodies(frame, ["before target", unsent, "untouched tail"]);
  await expect(draft).toHaveValue("");
  expect(await canonicalText(page, name)).toContain(unsent);
});

test("missing Catalog and a custom actor avatar preserve searchable available identities and source references", {
  tag: [...tags, packFixtureTag, missingCatalogTag],
}, async ({ page }) => {
  const name = "gui-legacy-custom-picker.mmt";
  const avatar = avatarFixtures.get(new URL("assets/avatar/佳代子.png", PACK_BASE_URL).href)!;
  await invokeMmtE2E(page, "workspace", "writeFile", "portrait.png", avatar.toString("base64"));
  // Reuse the established custom-avatar syntax fixture; the picker must not rewrite it.
  const original = [
    "@asset portrait", "src: portrait.png", "@end",
    "@actor custom", "preset: ba::佳代子", "avatar: asset::portrait", "@end",
    "> custom: custom current", "> 小雪: missing metadata current", "",
  ].join("\n");
  const frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  await surface.getByRole("button", { name: "角色库", exact: true }).click();
  let panel = auxiliaryPanel(page);
  const search = panel.getByRole("textbox", { name: "搜索姓名、别名、学校或组织", exact: true });
  await search.fill("custom");
  const custom = panel.locator('button[data-speaker="custom"]');
  await expect(custom).toContainText("自定义头像 · portrait");
  await custom.click();
  await expect(panel).toBeHidden();
  await expect(surface.locator('.mmt-composer-role-chip[data-speaker="custom"]')).toHaveAttribute("aria-pressed", "true");
  expect(await canonicalText(page, name)).toBe(original);
  await surface.getByRole("button", { name: "角色库", exact: true }).click();
  panel = auxiliaryPanel(page);
  await panel.getByRole("textbox", { name: "搜索姓名、别名、学校或组织", exact: true }).fill("Koyuki");
  await panel.locator("button[data-person]").filter({ hasText: "小雪" }).click();
  await expect(panel).toBeHidden();
  await expect(surface.locator('.mmt-composer-role-chip[data-speaker="ba::小雪"]')).toHaveAttribute("aria-pressed", "true");
  expect(await canonicalText(page, name)).toBe(original);
  await clickComposerBoundary(page, frame, "custom current", 0);
  await selectedActions(page).getByRole("button", { name: "更多", exact: true }).click();
  panel = auxiliaryPanel(page);
  await expect(panel).toContainText("自定义头像：portrait");
  await expect(panel).toContainText("从本条起");
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await surface.getByRole("button", { name: "角色库", exact: true }).click();
  await auxiliaryPanel(page).getByRole("button", { name: "自定义角色与资源", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "编辑局部源码", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await canonicalText(page, name)).toBe(original);
});

test("name-only creation opens an empty chat work and never overwrites a duplicate name", { tag: tags }, async ({ page }, testInfo) => {
  await openComposer(page, "creation-entry.mmt", "- existing work\n");
  const create = async (workName: string, fileName: string) => {
    await documentAction(page, "新建作品");
    const prompt = page.locator(".quick-input-widget");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("输入作品名");
    const input = prompt.locator("input").first();
    await input.fill(workName);
    await input.press("Enter");
    await expect(prompt).toBeHidden();
    await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", fileName)).toMatchObject({
      guiVisible: true, sourceVisible: false, modelCount: 1, textDocumentCount: 1,
    });
    await expect(guiSurface(page).getByRole("button", { name: "切换模式 · 当前为聊天创作", exact: true })).toBeVisible();
    await expect(guiSurface(page).getByRole("heading", { name: "开始第一段对话", exact: true })).toBeVisible();
    await expect.poll(() => authored(page, fileName)).toBe("");
  };
  const title = "放学后的对话";
  await create(`  ${title}  `, `${title}.mmt`);
  await expect(guiSurface(page).getByRole("button", { name: `${title} · 作品菜单`, exact: true })).toBeVisible();
  await testInfo.attach("new-work-empty-chat", { body: await page.screenshot(), contentType: "image/png" });
  const draft = guiSurface(page).getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.fill("The first work must survive a duplicate name.");
  await guiSurface(page).getByRole("button", { name: "发送", exact: true }).click();
  await expectBodies(page, ["The first work must survive a duplicate name."]);
  const firstSource = await authored(page, `${title}.mmt`);
  await documentAction(page, "保存");
  await create(`${title}.mmt`, `${title} (2).mmt`);
  await expect(guiSurface(page).getByRole("button", { name: `${title} (2) · 作品菜单`, exact: true })).toBeVisible();
  await draft.fill("This is the second work, not a replacement.");
  await guiSurface(page).getByRole("button", { name: "发送", exact: true }).click();
  await expectBodies(page, ["This is the second work, not a replacement."]);
  const secondSource = await authored(page, `${title} (2).mmt`);
  expect(secondSource).toContain("This is the second work, not a replacement.");
  await create(title, `${title} (3).mmt`);
  await expect(guiSurface(page).getByRole("button", { name: `${title} (3) · 作品菜单`, exact: true })).toBeVisible();
  expect(await authored(page, `${title}.mmt`)).toBe(firstSource);
  expect(await authored(page, `${title} (2).mmt`)).toBe(secondSource);
  await testInfo.attach("duplicate-work-retains-original", { body: await page.screenshot(), contentType: "image/png" });
});

test("chat keeps native SVG reading scale and reachable controls from desktop to a 320px viewport", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-chat-reading-scale.mmt";
  const source = "- Chat reading scale\n- 中文正文保持可读\n";
  await openComposer(page, name, source);
  for (const viewport of [
    { width: 1440, height: 900 }, { width: 900, height: 720 },
    { width: 390, height: 844 }, { width: 320, height: 740 },
  ]) {
    await page.setViewportSize(viewport);
    const frame = await waitForComposerFrame(page, name);
    await expectChatReadingScale(frame);
    await expectNoRootOverflow(page, frame);
    await expectHeaderActionsInViewport(page);
    await expectReachableControl(guiSurface(page).getByRole("textbox", { name: "新消息正文", exact: true }));
    await expectReachableControl(guiSurface(page).getByRole("button", { name: "发送", exact: true }));
    await expect.poll(() => frame.locator(".page").first().evaluate((element) => {
      const viewport = element.closest(".viewport");
      if (!viewport) throw new Error("the chat viewport is unavailable");
      const width = element.getBoundingClientRect().width;
      return width >= 240 && width <= 720 && width <= viewport.clientWidth;
    })).toBe(true);
    expect(await authored(page, name)).toBe(source);
    await testInfo.attach(`chat-reading-${viewport.width}px`, { body: await page.screenshot(), contentType: "image/png" });
  }
});

test("chat removes only the synthetic paper background and preserves an authored color shape across modes", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-chat-authored-color.mmt";
  const source = '- Authored colors stay visible\n@typ\n#rect(width: 48pt, height: 24pt, fill: rgb("#1b7d9c"), stroke: none)\n@end\n';
  const frame = await openComposer(page, name, source);
  const authoredColorVisible = async () => {
    await expect.poll(() => frame.locator("svg.typst-renderer-root path, svg.typst-renderer-root rect").evaluateAll((shapes) =>
      shapes.some((shape) => {
        if (shape.closest("defs")) return false;
        const style = getComputedStyle(shape);
        if (style.fill !== "rgb(27, 125, 156)" || style.display === "none" || style.visibility === "hidden") return false;
        const bounds = shape.getBoundingClientRect();
        const viewport = shape.closest(".viewport")?.getBoundingClientRect();
        return !!viewport && bounds.width > 20 && bounds.height > 10 && bounds.right > viewport.left
          && bounds.left < viewport.right && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      }))).toBe(true);
  };
  const paperBackgroundVisible = () => frame.locator(".page").first().evaluate((page) => {
    const bounds = page.getBoundingClientRect();
    if (getComputedStyle(page).backgroundColor === "rgb(255, 255, 255)") return true;
    return [...page.querySelectorAll("svg rect, svg path")].some((shape) => {
      if (shape.closest("defs")) return false;
      const style = getComputedStyle(shape);
      if (style.fill !== "rgb(255, 255, 255)" || style.display === "none" || style.visibility === "hidden") return false;
      const paint = shape.getBoundingClientRect();
      return paint.left <= bounds.left + 1 && paint.right >= bounds.right - 1
        && paint.top <= bounds.top + 1 && paint.bottom >= bounds.bottom - 1;
    });
  });
  await expectChatReadingScale(frame);
  await expect.poll(paperBackgroundVisible).toBe(false);
  await authoredColorVisible();
  await testInfo.attach("chat-authored-color-without-paper", { body: await page.screenshot(), contentType: "image/png" });
  await switchAuthoringMode(page, "layout");
  await waitForComposerFrame(page, name);
  await authoredColorVisible();
  await expect.poll(paperBackgroundVisible).toBe(true);
  await switchAuthoringMode(page, "chat");
  await waitForComposerFrame(page, name);
  await expectChatReadingScale(frame);
  await authoredColorVisible();
  await expect.poll(paperBackgroundVisible).toBe(false);
  expect(await authored(page, name)).toBe(source);
});

test("chat, editable layout and native source share one document, selected body, draft and undo history", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-three-mode-work.mmt";
  const original = "- first body\n- selected body\n- untouched tail\n";
  let frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  const unsent = "下一条尚未发送\n保留草稿与老师身份";
  await draft.fill(unsent);
  await clickComposerBoundary(page, frame, "selected body", "end");
  await page.keyboard.insertText(" chat");
  await expectBodies(page, ["first body", "selected body chat", "untouched tail"]);
  await waitForComposerFrame(page, name);
  await expectSelection(page, [1, "selected body chat".length]);
  const afterChat = await authored(page, name);
  await testInfo.attach("three-modes-chat-selected", { body: await page.screenshot(), contentType: "image/png" });

  await switchAuthoringMode(page, "layout");
  frame = await waitForComposerFrame(page, name);
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "layout");
  await expect(frame.getByRole("button", { name: "Fit width", exact: true })).toBeVisible();
  await expect(draft).toBeHidden();
  await expectSelection(page, [1, "selected body chat".length]);
  await expectCaretAtGlyph(frame, "selected body chat", "end");
  await clickComposerBoundary(page, frame, "selected body chat", "end");
  await page.keyboard.insertText(" layout");
  await expectBodies(page, ["first body", "selected body chat layout", "untouched tail"]);
  const afterLayout = await authored(page, name);
  await waitForComposerFrame(page, name);
  await testInfo.attach("three-modes-layout-direct-edit", { body: await page.screenshot(), contentType: "image/png" });

  await switchAuthoringMode(page, "source");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    guiVisible: false, sourceVisible: true, modelCount: 1, textDocumentCount: 1,
  });
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(editor).toBeVisible();
  await expect(editor.locator(".view-lines")).toContainText("selected body chat layout");
  await editor.click();
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(afterChat);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe(afterLayout);
  await testInfo.attach("three-modes-native-source-history", { body: await page.screenshot(), contentType: "image/png" });

  frame = await returnToChatFromSource(page, name);
  await expectChatReadingScale(frame);
  await expectBodies(page, ["first body", "selected body chat layout", "untouched tail"]);
  await expect(draft).toHaveValue(unsent);
  await expect(surface.getByRole("button", { name: "老师", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectSelection(page, [1, "selected body chat layout".length]);
  await documentAction(page, "撤销");
  await expect.poll(() => authored(page, name)).toBe(afterChat);
  await documentAction(page, "撤销");
  await expect.poll(() => authored(page, name)).toBe(original);
  await documentAction(page, "重做");
  await expect.poll(() => authored(page, name)).toBe(afterChat);
  await expect(draft).toHaveValue(unsent);
  const overlays = await Promise.all(page.frames().map(async (candidate) => {
    try { return await candidate.locator("textarea.composer-input-bridge").count(); } catch { return 0; }
  }));
  expect(overlays.reduce((sum, count) => sum + count, 0)).toBe(1);
  expect(await invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ modelCount: 1, textDocumentCount: 1 });
  const sourceDownload = page.waitForEvent("download");
  await documentAction(page, "下载源文件");
  const download = await sourceDownload;
  expect(download.suggestedFilename()).toBe(name);
  expect((await downloadBytes(download)).toString("utf8")).toBe(afterChat);
  await expect(draft).toHaveValue(unsent);
  await draft.fill("");
});

test("SVG glyph edges edit Unicode graphemes without splitting emoji or combining clusters", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-graphemes.mmt";
  const original = "- A😀é中\n- 第二条\n";
  const frame = await openComposer(page, name, original);
  await clickComposerBoundary(page, frame, /^A/u, 0);
  await expectSelection(page, [0, 0]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expectSelection(page, [0, 3]);
  await page.keyboard.insertText("X");
  await expect.poll(() => authored(page, name)).toBe("- A😀Xé中\n- 第二条\n");
  await page.keyboard.press("Backspace");
  await expect.poll(() => authored(page, name)).toBe(original);
  await page.keyboard.press("Backspace");
  await expect.poll(() => authored(page, name)).toBe("- Aé中\n- 第二条\n");
  await page.keyboard.press("ArrowRight");
  await expectSelection(page, [0, 3]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => authored(page, name)).toBe("- A中\n- 第二条\n");

  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /^A/u, 0);
  await page.keyboard.press("Backspace");
  await expectSelection(page, [0, 0]);
  expect(await authored(page, name)).toBe("- A中\n- 第二条\n");
  await page.keyboard.insertText("start");
  await expectBodies(page, ["startA中", "第二条"]);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /中$/u, "end");
  await expectSelection(page, [0, 7]);
  await page.keyboard.press("Delete");
  await expectSelection(page, [0, 7]);
  expect(await authored(page, name)).toBe("- startA中\n- 第二条\n");
  await page.keyboard.insertText("end");
  await expect.poll(() => authored(page, name)).toBe("- startA中end\n- 第二条\n");
  await expectBodies(page, ["startA中end", "第二条"]);
  await expect(inputBridge(frame)).toHaveValue("");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    guiVisible: true, sourceVisible: false, modelCount: 1, textDocumentCount: 1,
  });
  await waitForComposerFrame(page, name);
  await testInfo.attach("unicode-svg-caret", { body: await page.screenshot(), contentType: "image/png" });
});

test("multiline, quote fences and empty bodies preserve semantic LF and authored EOL bytes", { tag: tags }, async ({ page }) => {
  const name = "gui-fenced-body.mmt";
  let frame = await openComposer(page, name, "- seed");
  await replaceWholeBody(page, frame, "seed", "first");
  await expectBodies(page, ["first"]);
  await page.keyboard.press("Enter");
  await page.keyboard.insertText('> @不是语法 """');
  await expectBodies(page, ['first\n> @不是语法 """']);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);
  await page.keyboard.press("Shift+Enter");
  await expectBodies(page, ['first\n> @不是语法 """\n']);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);

  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+End");
  await page.keyboard.press("Backspace");
  await expectBodies(page, [""]);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);
  await waitForComposerFrame(page, name);
  await expect(frame.locator(".composer-caret")).toHaveCount(1);
  const emptyCaret = await frame.locator(".composer-caret").boundingBox();
  if (!emptyCaret) throw new Error("The native empty-body caret is unavailable");
  await page.mouse.click(emptyCaret.x, emptyCaret.y + emptyCaret.height / 2);
  await expectSelection(page, [0, 0]);
  await page.keyboard.insertText("restored");
  await expectBodies(page, ["restored"]);
  expect(await authored(page, name)).not.toMatch(/[\u200b\ufeff]/u);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);

  const crlfName = "gui-crlf-body.mmt";
  const original = '- rt"""\r\n\r\nstart\r\n"""\r\n\r\n@reply: A | B\r\n@bond: bond';
  frame = await openComposer(page, crlfName, original);
  await clickComposerBoundary(page, frame, "start", 0);
  await expectSelection(page, [0, 1]);
  await page.keyboard.press("Shift+End");
  await pasteText(page, "中\r\nnew\rline");
  await expectBodies(page, ["\n中\nnew\nline\n"]);
  await expect.poll(async () => (await textState(page)).bodies[0]?.resolvedMode).toBe("textRaw");
  const afterPaste = await authored(page, crlfName);
  expect(afterPaste.replace(/\r\n/gu, "")).not.toMatch(/[\r\n]/u);
  expect(afterPaste.endsWith("\r\n\r\n@reply: A | B\r\n@bond: bond")).toBe(true);
  await waitForComposerFrame(page, crlfName);
  await clickComposerBoundary(page, frame, "中", 0);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+End");
  await copySelection(page, "\n中\nnew\nline\n");
  await inputBridge(frame).press("Control+z");
  await expect.poll(() => authored(page, crlfName)).toBe(original);
});

test("GUI text edits preserve pending Monaco auto-indent outside the authorized edit", { tag: tags }, async ({ page }) => {
  const name = "gui-native-auto-indent.mmt";
  const source = "@typ\n  #let untouched = 1\n@end\n- editable body\n";
  const frame = await openComposer(page, name, source);
  await switchAuthoringMode(page, "source");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    sourceVisible: true, guiVisible: false, modelCount: 1,
  });
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const pendingAutoIndent = "@typ\n  #let untouched = 1\n  \n@end\n- editable body\n";
  await expect.poll(() => authored(page, name)).toBe(pendingAutoIndent);

  await invokeMmtE2E(page, "composer", "openGui", name);
  const guiFrame = await waitForComposerFrame(page, name);
  expect(guiFrame).toBe(frame);
  await clickComposerBoundary(page, guiFrame, "editable body", 8);
  await page.keyboard.insertText("X");
  await expect.poll(() => authored(page, name)).toBe(
    "@typ\n  #let untouched = 1\n  \n@end\n- editableX body\n",
  );
});


test("directional cross-message selection copies semantic text and merges atomically on the native undo stack", { tag: tags }, async ({ page, context }) => {
  const name = "gui-cross-messages.mmt";
  const original = "- abc\n- def\n";
  let frame = await openComposer(page, name, original);
  await dragBodies(page, frame, ["abc", 1], ["def", 2]);
  await expectSelection(page, [0, 1], [1, 2]);
  await copySelection(page, "bc\nde");
  const before = await textState(page);
  await page.keyboard.insertText("X");
  await expect.poll(() => authored(page, name)).toBe("- aXf\n");
  await expectBodies(page, ["aXf"]);
  await expectSelection(page, [0, 2]);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);
  await expectSelection(page, [0, 1], [1, 2]);
  expect((await textState(page)).alternativeVersionId).toBe(before.alternativeVersionId);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe("- aXf\n");
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);
  await waitForComposerFrame(page, name);
  await dragBodies(page, frame, ["def", 2], ["abc", 1]);
  await expectSelection(page, [1, 2], [0, 1]);
  await copySelection(page, "bc\nde");
  const clipboard = await context.newCDPSession(page);
  const target = await clipboard.send("Target.getTargetInfo");
  const permission = {
    permission: { name: "clipboard-write" },
    origin: new URL(page.url()).origin,
    browserContextId: target.targetInfo.browserContextId,
  };
  try {
    await clipboard.send("Browser.setPermission", { ...permission, setting: "denied" });
    await expect.poll(() => page.evaluate(async () => (
      await navigator.permissions.query({ name: "clipboard-write" as PermissionName })
    ).state)).toBe("denied");
    const selectedPoint = await framePoint(frame, await composerGlyphBoundary(frame, "abc", 1));
    await page.mouse.click(selectedPoint.x, selectedPoint.y, { button: "right" });
    await nativeMenuItem(page, "剪切").click();
    await expect.poll(async () => (await invokeMmtE2E(page, "gui", "state")).lastNotification).not.toBeNull();
    expect(await authored(page, name)).toBe(original);
  } finally {
    await clipboard.detach();
    // Detaching this CDP session resets its browser permission overrides.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await waitForComposerFrame(page, name);
  await dragBodies(page, frame, ["def", 2], ["abc", 1]);
  await expectSelection(page, [1, 2], [0, 1]);
  await page.keyboard.press("Control+x");
  await expect.poll(() => authored(page, name)).toBe("- af\n");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("bc\nde");
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);

  const envelopesName = "gui-cross-envelopes.mmt";
  const envelopes = ">(fill: green, continued: true) 佳代子: abc\r\n \t\r\n\r\n< 阿洛娜: def\r\n> 佳代子: tail";
  frame = await openComposer(page, envelopesName, envelopes);
  await dragBodies(page, frame, ["def", 2], ["abc", 1]);
  await expectSelection(page, [1, 2], [0, 1]);
  await copySelection(page, "bc\nde");
  await pasteText(page, "X");
  await expect.poll(() => authored(page, envelopesName)).toBe(
    ">(fill: green, continued: true) 佳代子: aXf\r\n \t\r\n\r\n> 佳代子: tail",
  );
  await expectBodies(page, ["aXf", "tail"]);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, envelopesName)).toBe(envelopes);
});

test("opaque, Typst and mode barriers reject the whole range, and failed candidates retain recoverable input", { tag: tags }, async ({ page }) => {
  const name = "gui-text-barriers.mmt";
  const source = '- abc\n@mode: text\n- def\n- T"""#strong[Typst barrier]"""\n- ghi\n- rt"""raw body"""\n';
  let frame = await openComposer(page, name, source);
  await page.evaluate(() => navigator.clipboard.writeText("unchanged clipboard"));
  await dragBodies(page, frame, ["abc", 1], ["def", 2]);
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  expect(await authored(page, name)).toBe(source);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("unchanged clipboard");

  await clickComposerBoundary(page, frame, "def", 0);
  await dragBodies(page, frame, ["def", 1], ["ghi", 2]);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  expect(await authored(page, name)).toBe(source);
  await clickComposerBoundary(page, frame, "ghi", 0);
  await dragBodies(page, frame, ["ghi", 1], ["raw body", 2]);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  expect(await authored(page, name)).toBe(source);

  const inheritedName = "gui-candidate-inheritance.mmt";
  const inherited = "> 佳代子: abc\n> 阿洛娜: def\n> _0: tail\n";
  frame = await openComposer(page, inheritedName, inherited);
  await dragBodies(page, frame, ["abc", 1], ["def", 2]);
  await expectSelection(page, [0, 1], [1, 2]);
  await page.keyboard.insertText("INHERITANCE-REJECTED");
  await expect.poll(async () => (await textState(page)).recoveryText).toContain("INHERITANCE-REJECTED");
  expect(await authored(page, inheritedName)).toBe(inherited);
  await resolveRecovery(page, "copy", "INHERITANCE-REJECTED");
  expect(await authored(page, inheritedName)).toBe(inherited);

  // A recoverable parse error has no fresh render authorization: an old visible SVG is not editable.
  const errored = `// error-looking\n${inherited}`;
  await invokeMmtE2E(page, "workspace", "replaceDocument", inheritedName, errored);
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    nodeKinds: ["opaque", "message", "message", "message"],
  });
  await expect.poll(async () => (await textState(page)).status).not.toBe("ready");
  await expect.poll(() => authored(page, inheritedName)).toBe(errored);
  await switchAuthoringMode(page, "source");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", inheritedName)).toMatchObject({
    sourceVisible: true, guiVisible: false, modelCount: 1,
  });
});

test("typing drains without compile, stale pointers cannot redirect it, and synthetic IME is a single native transaction", { tag: tags }, async ({ page }) => {
  test.info().annotations.push({
    type: "IME limitation",
    description: "Synthetic composition events only; this does not exercise an OS input method or candidate window. Real Chrome Chinese IME remains a manual acceptance item.",
  });
  const name = "gui-input-queue.mmt";
  const frame = await openComposer(page, name, "- base\n- other\n");
  await clickComposerBoundary(page, frame, "base", "end");
  const bridge = await inputBridge(frame).elementHandle();
  if (!bridge) throw new Error("The native input bridge is unavailable");
  const initial = await textState(page);
  await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 100, compileMs: 10_000 });
  try {
    await page.keyboard.type("0123456789", { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("快速😀");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("last");
    await expect.poll(async () => (await textState(page)).pendingIntentCount).toBeGreaterThan(0);
    // The old geometry is still visible. Its second message cannot steal the accepted typing selection.
    const stale = await framePoint(frame, await composerGlyphBoundary(frame, "other", 0));
    await page.mouse.click(stale.x, stale.y);
    await page.keyboard.insertText("!");
    await expectBodies(page, ["base0123456789\n快速😀\nlast!", "other"]);
    expect((await textState(page)).renderKey).toBe(initial.renderKey);
    expect((await textState(page)).rendererGeneration).toBe(initial.rendererGeneration);
    await expect.poll(async () => (await textState(page)).pendingIntentCount).toBe(0);
    await expect(inputBridge(frame)).toBeFocused();
  } finally {
    await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 0 });
  }
  await waitForComposerFrame(page, name);
  expect(await bridge.evaluate((element) => element === document.querySelector("textarea.composer-input-bridge"))).toBe(true);
  const beforeIme = '- """\nbase0123456789\n快速😀\nlast!"""\n- other\n';
  await expect.poll(() => authored(page, name)).toBe(beforeIme);
  await composition(frame, "start", "");
  await composition(frame, "update", "中");
  await expect(frame.locator(".composer-composition")).toHaveText("中");
  expect(await authored(page, name)).toBe(beforeIme);
  await invokeMmtE2E(page, "preview", "interactionFixture", { action: "resync-renderer" });
  await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  await expect(frame.locator(".composer-composition")).toHaveText("中");
  expect(await bridge.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
  await composition(frame, "update", "中文");
  await composition(frame, "end", "中文");
  await inputBridge(frame).evaluate((element) => element.dispatchEvent(new InputEvent("input", {
    bubbles: true, inputType: "insertText", data: "中文", isComposing: false,
  })));
  await expectBodies(page, ["base0123456789\n快速😀\nlast!中文", "other"]);
  const committed = '- """\nbase0123456789\n快速😀\nlast!中文"""\n- other\n';
  await expect.poll(() => authored(page, name)).toBe(committed);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(beforeIme);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe(committed);
  await expectBodies(page, ["base0123456789\n快速😀\nlast!中文", "other"]);
  await composition(frame, "start", "");
  await composition(frame, "update", "取消内容");
  await page.keyboard.press("Escape");
  await composition(frame, "end", "");
  await expect(frame.locator(".composer-composition")).toBeHidden();
  expect(await authored(page, name)).toBe(committed);

  await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 2_000, compileMs: 10_000 });
  try {
    await page.keyboard.insertText("accepted");
    await expect.poll(() => authored(page, name)).toContain("accepted");
    await page.keyboard.insertText("recover this text");
    await expect.poll(async () => (await textState(page)).pendingIntentCount).toBeGreaterThan(0);
    await invokeMmtE2E(page, "workspace", "replaceDocument", name, "- external\n- other\n");
    await expect.poll(async () => (await textState(page)).recoveryText).toContain("recover this text");
    await expect.poll(() => authored(page, name)).toBe("- external\n- other\n");
    expect((await textState(page)).selection).toBeNull();
    // Viewing retained text must remain available before the replacement source has a fresh snapshot.
    await resolveRecovery(page, "copy", (await textState(page)).recoveryText);
  } finally {
    await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 0 });
  }
  expect(await authored(page, name)).toBe("- external\n- other\n");
});

test("oversized synthetic IME blur keeps the full local draft copyable without changing source", { tag: tags }, async ({ page }) => {
  test.info().annotations.push({
    type: "IME limitation",
    description: "Synthetic composition and blur events only; this proves local draft retention, not an OS candidate window.",
  });
  const name = "gui-oversized-ime-blur.mmt";
  const source = "- draft target\n";
  const frame = await openComposer(page, name, source);
  await clickComposerBoundary(page, frame, "draft target", 2);
  await page.keyboard.press("End");
  await expectSelection(page, [0, 12]);

  const oversizedDraft = "大".repeat(131_073);
  await composition(frame, "start", "");
  await composition(frame, "update", oversizedDraft);
  expect(await authored(page, name)).toBe(source);
  await inputBridge(frame).evaluate((element) => (element as HTMLTextAreaElement).blur());
  await expect(inputBridge(frame)).toHaveJSProperty("readOnly", true);
  expect(await inputBridge(frame).evaluate(
    (element, expected) => (element as HTMLTextAreaElement).value === expected,
    oversizedDraft,
  )).toBe(true);
  await inputBridge(frame).evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.focus();
    input.select();
  });
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(async (expected) => await navigator.clipboard.readText() === expected, oversizedDraft)).toBe(true);
  expect(await authored(page, name)).toBe(source);
});

test("native glyph advances, line boxes and chosen occurrences survive zoom, reflow, pages and full resync", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-geometric-selection.mmt";
  const firstLine = "WiWi iiii mmmm";
  const secondLine = "second visual line";
  const wrappedBody = Array.from({ length: 32 }, (_, index) => `wrap${String(index).padStart(2, "0")}`).join(" ");
  const source = [
    "@typ", "#set page(width: 420.25pt, height: 260.1pt, margin: 18pt)", "@end",
    '- """', firstLine, secondLine, 'third visual line"""',
    "- repeated body", "- repeated body",
    ...Array.from({ length: 18 }, (_, index) => `- page row ${String(index).padStart(2, "0")} boundary`),
    `- ${wrappedBody}`,
    "@typ", "#set page(width: 280.5pt, height: 120.25pt, margin: 18pt)", "Geometry tail page", "@end",
    "",
  ].join("\n");
  const frame = await openComposer(page, name, source, "layout");
  await clickComposerBoundary(page, frame, firstLine, 2);
  await expectSelection(page, [0, 2]);
  await expectCaretAtGlyph(frame, firstLine, 2);
  await page.keyboard.press("Shift+ArrowRight");
  await expectSelection(page, [0, 2], [0, 3]);
  const start = await composerGlyphBoundary(frame, firstLine, 2);
  const end = await composerGlyphBoundary(frame, firstLine, 3);
  const neighbor = await composerText(frame, secondLine).boundingBox();
  if (!neighbor) throw new Error("The neighboring rendered line is unavailable");
  const iframe = await (await frame.frameElement()).boundingBox();
  if (!iframe) throw new Error("The preview iframe is unavailable");
  const neighboringY = neighbor.y - iframe.y + neighbor.height / 2;
  await expect.poll(async () => await frame.locator(".composer-selection-box").evaluateAll((elements, expected) => {
    const boxes = elements.map((element) => element.getBoundingClientRect());
    return {
      leftError: Math.min(...boxes.map((box) => Math.abs(box.left - expected.startX))),
      rightError: Math.min(...boxes.map((box) => Math.abs(box.right - expected.endX))),
      coversNeighbor: boxes.some((box) => box.top <= expected.neighborY && box.bottom >= expected.neighborY),
    };
  }, { startX: start.x, endX: end.x, neighborY: neighboringY })).toMatchObject({ coversNeighbor: false });
  const boxes = await frame.locator(".composer-selection-box").evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right };
  }));
  expect(Math.min(...boxes.map((box) => Math.abs(box.left - start.x)))).toBeLessThanOrEqual(1);
  expect(Math.min(...boxes.map((box) => Math.abs(box.right - end.x)))).toBeLessThanOrEqual(1);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await textState(page)).selection?.focus.offsetUtf16).toBeGreaterThan(firstLine.length);
  await page.keyboard.press("ArrowUp");
  await expectSelection(page, [0, 2]);
  await expectCaretAtGlyph(frame, firstLine, 2);
  await page.keyboard.press("Home");
  await expectSelection(page, [0, 0]);
  await page.keyboard.press("End");
  await expectSelection(page, [0, firstLine.length]);
  // Stay inside the word: its leading edge shares an affinity boundary with the preceding space.
  const word = await framePoint(frame, await composerGlyphBoundary(frame, firstLine, 7));
  await page.mouse.dblclick(word.x, word.y);
  await copySelection(page, "iiii");
  await dragBodies(page, frame, [firstLine, 5], [secondLine, 6]);
  await expectSelection(page, [0, 5], [0, firstLine.length + 1 + 6]);
  await copySelection(page, "iiii mmmm\nsecond");
  const thirdLine = await composerText(frame, "third visual line").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top + bounds.height / 2;
  });
  expect(await frame.locator(".composer-selection-box").evaluateAll((elements, unselectedY) =>
    elements.some((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top <= unselectedY && bounds.bottom >= unselectedY;
    }), thirdLine)).toBe(false);

  await clickComposerBoundary(page, frame, "repeated body", 3, 1);
  await expectSelection(page, [2, 3]);
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  const selection = (await textState(page)).selection;
  await frame.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  expect((await textState(page)).selection).toEqual(selection);
  await page.setViewportSize({ width: 900, height: 700 });
  await frame.getByRole("button", { name: "Fit width", exact: true }).click();
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  expect((await textState(page)).selection).toEqual(selection);
  await invokeMmtE2E(page, "preview", "interactionFixture", { action: "resync-renderer" });
  await waitForComposerFrame(page, name);
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  expect((await textState(page)).selection).toEqual(selection);

  // A real edit rerenders the same selected occurrence; matching identical page text must not choose its neighbor.
  await inputBridge(frame).focus();
  await page.keyboard.insertText("X");
  await expectBodies(page, [
    `${firstLine}\n${secondLine}\nthird visual line`, "repeated body", "repXeated body",
    ...Array.from({ length: 18 }, (_, index) => `page row ${String(index).padStart(2, "0")} boundary`),
    wrappedBody,
  ]);
  await waitForComposerFrame(page, name);
  await expectCaretAtGlyph(frame, "repXeated body", 4);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textState(page)).bodies[2]?.text).toBe("repX\neated body");
  await waitForComposerFrame(page, name);
  await expectSelection(page, [2, 5]);
  await expectCaretAtGlyph(frame, "eated body", 0);

  const firstPage = await composerGlyphBoundary(frame, "page row 00 boundary", 1);
  const lastPage = await composerGlyphBoundary(frame, "page row 17 boundary", 2);
  expect(lastPage.pageIndex).toBeGreaterThan(firstPage.pageIndex);
  const dragStart = await framePoint(frame, await composerGlyphBoundary(frame, "page row 00 boundary", 1));
  const viewport = frame.locator(".viewport");
  const viewportBounds = await viewport.boundingBox();
  if (!viewportBounds) throw new Error("The SVG viewport is unavailable");
  const scrollBeforeDrag = await viewport.evaluate((element) => element.scrollTop);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x, viewportBounds.y + viewportBounds.height - 2, { steps: 8 });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBeforeDrag + 10);
  // Move the held pointer into the measured viewport interior to stop edge
  // autoscroll before acquiring the final glyph's current native position.
  const aimBounds = await viewport.boundingBox();
  if (!aimBounds) throw new Error("The SVG viewport is unavailable during the drag");
  await page.mouse.move(aimBounds.x + aimBounds.width / 2, aimBounds.y + aimBounds.height / 2);
  const dragEnd = await framePoint(frame, await composerGlyphBoundary(frame, "page row 17 boundary", 2));
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 });
  await page.mouse.up();
  await expectSelection(page, [3, 1], [20, 2]);
  const selectedText = [
    "age row 00 boundary",
    ...Array.from({ length: 16 }, (_, index) => `page row ${String(index + 1).padStart(2, "0")} boundary`),
    "pa",
  ].join("\n");
  await copySelection(page, selectedText);
  const selectedGeometry = await textState(page);
  const selectedPages = [...new Set(selectedGeometry.boxes.map((box) => box.pageIndex))].sort((left, right) => left - right);
  expect(selectedPages).toEqual(expect.arrayContaining([firstPage.pageIndex, lastPage.pageIndex]));
  const visibleSelectedPages = new Set<number>();
  // Page-local highlights follow native scrolling. Visit the selected native
  // pages and prove their glyphs remain highlighted without losing the full range.
  for (let index = 0; index < 18; index += 1) {
    const point = await composerGlyphBoundary(frame, `page row ${String(index).padStart(2, "0")} boundary`, 1);
    if (visibleSelectedPages.has(point.pageIndex)) continue;
    await expect.poll(() => frame.locator(`.composer-selection-box[data-page-index="${point.pageIndex}"]`).evaluateAll((elements, glyph) =>
      elements.some((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left <= glyph.x + 1 && bounds.right >= glyph.x - 1 && bounds.top <= glyph.y && bounds.bottom >= glyph.y;
      }), point)).toBe(true);
    const current = await textState(page);
    expect(current.selection).toEqual(selectedGeometry.selection);
    expect([...new Set(current.boxes.map((box) => box.pageIndex))].sort((left, right) => left - right)).toEqual(selectedPages);
    visibleSelectedPages.add(point.pageIndex);
  }
  expect([...visibleSelectedPages].sort((left, right) => left - right)).toEqual(selectedPages);
  await expectSelection(page, [3, 1], [20, 2]);
  await copySelection(page, selectedText);
  await testInfo.attach("multi-page-svg-selection", { body: await page.screenshot(), contentType: "image/png" });

  await composerGlyphBoundary(frame, /wrap31/u, 3);
  const lastFragment = await composerText(frame, /wrap31/u).textContent();
  if (!lastFragment) throw new Error("The last native wrapped text fragment is unavailable");
  const lastFragmentStart = wrappedBody.indexOf(lastFragment);
  expect(lastFragmentStart).toBeGreaterThan(0);
  expect(wrappedBody.lastIndexOf(lastFragment)).toBe(lastFragmentStart);
  await dragBodies(page, frame, [/^wrap00/u, 3], [lastFragment, 3]);
  await expectSelection(page, [21, 3], [21, lastFragmentStart + 3]);
  await copySelection(page, wrappedBody.slice(3, lastFragmentStart + 3));
  await expect.poll(async () => await frame.locator(".composer-selection-box").evaluateAll((elements) =>
    new Set(elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.round(bounds.top);
    })).size)).toBeGreaterThan(1);

  await page.keyboard.press("Control+Home");
  await expectSelection(page, [0, 0]);
  await expect(frame.locator(".composer-caret")).toBeInViewport();
  await clickComposerBoundary(page, frame, firstLine, 0);
  const beforeDeferredRenderKey = (await textState(page)).renderKey;
  await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 2_000 });
  try {
    await page.keyboard.insertText("Z");
    await expect.poll(async () => (await textState(page)).bodies[0]?.text).toBe(
      `Z${firstLine}\n${secondLine}\nthird visual line`,
    );
    const bounds = await viewport.boundingBox();
    if (!bounds) throw new Error("The SVG viewport is unavailable during deferred reveal");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 5_000);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    // mouse.wheel returns before native scrolling completes. Capture the user's
    // completed viewport, not an intermediate compositor-animation position.
    await waitForViewportSettled(frame);
    expect((await textState(page)).renderKey).toBe(beforeDeferredRenderKey);
    const userScroll = await viewport.evaluate((element) => element.scrollTop);
    await waitForComposerFrame(page, name);
    expect(Math.abs(await viewport.evaluate((element) => element.scrollTop) - userScroll)).toBeLessThanOrEqual(1);
    await expect(frame.locator(".composer-caret")).not.toBeInViewport();
  } finally {
    await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 0 });
  }
});

// launchOptions is worker-scoped: isolate this native-control journey without
// changing the browser launched for the other GUI regressions.
const nativeScrollbarTest = test.extend({
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

nativeScrollbarTest("selected block edges follow every frame of a real scrollbar drag and survive viewport tile replacement", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-native-scroll-outline.mmt";
  const marker = "outline option A";
  const source = Array.from({ length: 120 }, (_, index) => index === 60
    ? `@reply: ${marker} | outline option B\n`
    : `- outline row ${String(index).padStart(3, "0")}\n`).join("");
  const frame = await openComposer(page, name, source, "layout");
  // Style Chromium's real scrollbar with a persistent draggable gutter after
  // opting out of Playwright's headless --hide-scrollbars launch default.
  await frame.addStyleTag({ content: `
    .viewport { scrollbar-width:auto; scrollbar-color:auto; }
    .viewport::-webkit-scrollbar { width:16px; height:16px; }
    .viewport::-webkit-scrollbar-track { background:#e5e5e5; }
    .viewport::-webkit-scrollbar-thumb { background:#60788b; border-radius:8px; }
    .viewport::-webkit-scrollbar-button { display:none; }
  ` });
  await waitForViewportSettled(frame);
  const bridge = await inputBridge(frame).elementHandle();
  if (!bridge) throw new Error("the retained input bridge is unavailable");
  await composerGlyphBoundary(frame, marker, 2);
  await composerText(frame, marker).evaluate((element) => element.closest("foreignObject")?.scrollIntoView({ block: "center", behavior: "instant" }));
  await waitForViewportSettled(frame);
  const point = await framePoint(frame, await composerGlyphBoundary(frame, marker, 2, 0, false));
  const token = await composerText(frame, marker).evaluate((element) => {
    const label = element.closest("[data-typst-label]")?.getAttribute("data-typst-label");
    const token = label?.match(/^mmt:[a-z-]+:(t[0-9a-f]{8})$/u)?.[1];
    if (!token) throw new Error("the reply's semantic identity is unavailable");
    return token;
  });
  await page.mouse.click(point.x, point.y);
  const outline = frame.locator(".composer-block-selection");
  await expect(outline).toBeVisible();
  const viewport = frame.locator(".viewport");
  const bounds = await viewport.boundingBox();
  if (!bounds) throw new Error("the native scrollbar is unavailable");
  const thumb = await viewport.evaluate((element) => {
    const gutter = (element as HTMLElement).offsetWidth - element.clientWidth;
    if (gutter <= 0) throw new Error("this desktop journey requires the browser's native scrollbar");
    const height = element.clientHeight * element.clientHeight / element.scrollHeight;
    return {
      x: element.clientWidth + gutter / 2,
      y: (element.clientHeight - height) * element.scrollTop / (element.scrollHeight - element.clientHeight) + height / 2,
      fraction: element.scrollTop / (element.scrollHeight - element.clientHeight),
    };
  });
  await frame.evaluate((selectedToken) => {
    const viewport = document.querySelector<HTMLElement>(".viewport");
    if (!viewport) throw new Error("the scrolling viewport is unavailable");
    const samples: { top: number; delta: number; error: number; visible: boolean }[] = [];
    let previousTop = viewport.scrollTop;
    let running = true;
    const sample = () => {
      if (!running) return;
      const visible = viewport.getBoundingClientRect();
      const targets = [...document.querySelectorAll<SVGGraphicsElement>(`svg [data-typst-label$=":${selectedToken}"]`)]
        .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 || rect.height > 0);
      const outline = document.querySelector<HTMLElement>(".composer-block-selection");
      const left = Math.min(...targets.map((rect) => rect.left));
      const top = Math.min(...targets.map((rect) => rect.top));
      const right = Math.max(...targets.map((rect) => rect.right));
      const bottom = Math.max(...targets.map((rect) => rect.bottom));
      const box = outline?.getBoundingClientRect();
      const error = !outline || outline.hidden || !box ? Number.MAX_SAFE_INTEGER : Math.max(
        Math.abs(box.left - (left - 4)), Math.abs(box.top - (top - 4)),
        Math.abs(box.right - (right + 4)), Math.abs(box.bottom - (bottom + 4)),
      );
      samples.push({
        top: viewport.scrollTop, delta: viewport.scrollTop - previousTop, error,
        visible: targets.length > 0 && bottom > visible.top && top < visible.bottom,
      });
      previousTop = viewport.scrollTop;
      requestAnimationFrame(sample);
    };
    Reflect.set(globalThis, "__mmtOutlineScrollSamples", samples);
    Reflect.set(globalThis, "__mmtStopOutlineScrollSampling", () => { running = false; });
    requestAnimationFrame(sample);
  }, token);
  await page.mouse.move(bounds.x + thumb.x, bounds.y + thumb.y);
  await page.mouse.down();
  try {
    const offsets = [
      ...Array.from({ length: 8 }, (_, index) => index + 1),
      ...Array.from({ length: 16 }, (_, index) => 7 - index),
      ...Array.from({ length: 8 }, (_, index) => index - 7),
    ];
    for (const offset of offsets) {
      await page.mouse.move(bounds.x + thumb.x, bounds.y + thumb.y + offset);
      await page.waitForTimeout(20);
    }
  } finally {
    await page.mouse.up();
  }
  const samples = await frame.evaluate(() => {
    const stop = Reflect.get(globalThis, "__mmtStopOutlineScrollSampling");
    if (typeof stop === "function") stop();
    return Reflect.get(globalThis, "__mmtOutlineScrollSamples") as { top: number; delta: number; error: number; visible: boolean }[];
  });
  const moving = samples.filter((sample) => sample.visible && Math.abs(sample.delta) > 1);
  await testInfo.attach("native-scroll-outline-frames", { body: JSON.stringify(samples), contentType: "application/json" });
  expect(moving.length).toBeGreaterThanOrEqual(6);
  expect(moving.some((sample) => sample.delta > 1)).toBe(true);
  expect(moving.some((sample) => sample.delta < -1)).toBe(true);
  expect(Math.max(...moving.map((sample) => sample.error))).toBeLessThanOrEqual(1);

  await scrollPreviewToFraction(page, frame, 0.95);
  await scrollPreviewToFraction(page, frame, thumb.fraction);
  await expect(outline).toBeVisible();
  await expect.poll(() => outline.evaluate((element, selectedToken) => {
    const targets = [...document.querySelectorAll<SVGGraphicsElement>(`svg [data-typst-label$=":${selectedToken}"]`)]
      .map((target) => target.getBoundingClientRect()).filter((rect) => rect.width > 0 || rect.height > 0);
    if (!targets.length) return Number.MAX_SAFE_INTEGER;
    const box = element.getBoundingClientRect();
    return Math.max(
      Math.abs(box.left - Math.min(...targets.map((rect) => rect.left)) + 4),
      Math.abs(box.top - Math.min(...targets.map((rect) => rect.top)) + 4),
      Math.abs(box.right - Math.max(...targets.map((rect) => rect.right)) - 4),
      Math.abs(box.bottom - Math.max(...targets.map((rect) => rect.bottom)) - 4),
    );
  }, token)).toBeLessThanOrEqual(1);
  expect(await bridge.evaluate((element) => element.isConnected)).toBe(true);
  expect(await authored(page, name)).toBe(source);
  await clickComposerBoundary(page, frame, "outline row 061", 3);
  await page.keyboard.insertText("X");
  await expect.poll(() => authored(page, name)).toBe(source.replace("- outline row 061", "- outXline row 061"));
});

test("Fit width/page and fitted resizing keep the reading point instead of old selection or scroll pixels", { tag: tags }, async ({ page }) => {
  const name = "gui-fitted-reading-point.mmt";
  const source = Array.from({ length: 240 }, (_, index) => `- reading row ${String(index).padStart(3, "0")} boundary\n`).join("");
  const frame = await openComposer(page, name, source, "layout");
  await waitForViewportSettled(frame);
  await expect.poll(() => previewViewport(page)).toMatchObject({ fitMode: "width" });
  const initial = await viewportReading(frame);
  expect(initial.width).toBeGreaterThan(initial.viewportWidth * 0.8);
  expect(initial.width).toBeLessThan(initial.viewportWidth);

  await clickComposerBoundary(page, frame, "reading row 000 boundary", 4);
  await page.keyboard.press("Shift+ArrowRight");
  await expectSelection(page, [0, 4], [0, 5]);
  const selection = (await textState(page)).selection;
  await scrollPreviewToFraction(page, frame, 0.55);
  const beforeManualZoom = await viewportReading(frame);
  for (let step = 0; step < 3; step += 1) {
    await frame.getByRole("button", { name: "Zoom out", exact: true }).click();
  }
  await waitForViewportSettled(frame);
  await expect.poll(() => previewViewport(page)).toMatchObject({ fitMode: "manual" });
  await expectReadingPoint(frame, beforeManualZoom);
  const beforeFit = await viewportReading(frame);
  expect(beforeFit.y).toBeGreaterThan(0.4);
  expect(beforeFit.width).toBeLessThan(initial.width - 50);

  await frame.getByRole("button", { name: "Fit width", exact: true }).click();
  await waitForViewportSettled(frame);
  await expect.poll(() => previewViewport(page)).toMatchObject({ fitMode: "width" });
  await expectReadingPoint(frame, beforeFit);
  const fitted = await viewportReading(frame);
  expect(Math.abs(fitted.scrollTop - beforeFit.scrollTop)).toBeGreaterThan(100);
  expect((await textState(page)).selection).toEqual(selection);
  await expect(frame.locator(".composer-caret").first()).not.toBeInViewport();

  const widthZoom = (await previewViewport(page)).zoom;
  await page.setViewportSize({ width: 1360, height: 820 });
  await waitForViewportSettled(frame);
  await expect.poll(async () => (await previewViewport(page)).zoom).toBeGreaterThan(widthZoom);
  await expectReadingPoint(frame, fitted);
  expect((await textState(page)).selection).toEqual(selection);

  const beforePageFit = await viewportReading(frame);
  await frame.getByRole("button", { name: "Fit page", exact: true }).click();
  await waitForViewportSettled(frame);
  await expect.poll(() => previewViewport(page)).toMatchObject({ fitMode: "page", zoom: 0.1 });
  await expectReadingPoint(frame, beforePageFit);
  expect((await textState(page)).selection).toEqual(selection);
  expect(await authored(page, name)).toBe(source);
});

test("saved fitted reading points win over the shared preview's previous document center", { tag: tags }, async ({ page }) => {
  const name = "gui-saved-fitted-viewport.mmt";
  const source = Array.from({ length: 240 }, (_, index) => `- saved row ${String(index).padStart(3, "0")}\n`).join("");
  let frame = await openComposer(page, name, source, "layout");
  await scrollPreviewToFraction(page, frame, 0.65);
  await frame.getByRole("button", { name: "Fit width", exact: true }).click();
  await waitForViewportSettled(frame);
  const savedPoint = await viewportReading(frame);
  const saved = await previewViewport(page);
  expect(saved.fitMode).toBe("width");
  expect(savedPoint.y).toBeGreaterThan(0.6);

  frame = await openComposer(page, "gui-other-fitted-viewport.mmt", Array.from({ length: 12 }, (_, index) => `- other row ${index}\n`).join(""), "layout");
  await frame.getByRole("button", { name: "Fit page", exact: true }).click();
  await waitForViewportSettled(frame);
  await expect.poll(() => previewViewport(page)).toMatchObject({ fitMode: "page" });
  const beforeResize = await viewportReading(frame);
  await page.setViewportSize({ width: 1280, height: 700 });
  await waitForViewportSettled(frame);
  await expect.poll(async () => (await viewportReading(frame)).height).toBeLessThan(beforeResize.height - 20);
  const afterResize = await viewportReading(frame);
  expect(afterResize.height).toBeLessThan(afterResize.viewportHeight);
  expect(afterResize.width).toBeLessThan(afterResize.viewportWidth);

  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  await switchAuthoringMode(page, "layout");
  frame = await waitForComposerFrame(page, name);
  await waitForViewportSettled(frame);
  await expect.poll(() => previewViewport(page)).toMatchObject({ fitMode: saved.fitMode, zoom: saved.zoom });
  await expectReadingPoint(frame, savedPoint);
  expect(await authored(page, name)).toBe(source);
});

test("dismissed recovery confirmation A cannot consume confirmation B, and only live B replaces its selected body", { tag: tags }, async ({ page }) => {
  const name = "gui-recovery-confirmation-identity.mmt";
  const original = "- target A\n- target B\n";
  const source = `${original}\n`;
  const recovered = "RECOVERED-TEXT";
  let frame = await openComposer(page, name, original);
  await clickComposerBoundary(page, frame, "target A", "end");
  await composition(frame, "start", "");
  await composition(frame, "update", recovered);
  await expect(frame.locator(".composer-composition")).toHaveText(recovered);
  await invokeMmtE2E(page, "workspace", "editDocument", name, original.length, 0, "\n");
  await expect.poll(async () => (await textState(page)).recoveryText).toBe(recovered);
  await expect.poll(() => authored(page, name)).toBe(source);
  frame = await waitForComposerFrame(page, name);
  const confirmation = guiSurface(page).getByRole("dialog", { name: "确认恢复目标", exact: true });
  const submit = () => confirmation.getByRole("button", { name: "确认此目标并重试", exact: true });
  const openConfirmation = async (body: string, bodyIndex: number) => {
    await clickComposerBoundary(page, frame, body, 0);
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expectSelection(page, [bodyIndex, 0], [bodyIndex, body.length]);
    await guiSurface(page).getByLabel("未提交文字恢复", { exact: true }).getByRole("button", { name: "确认目标后重试", exact: true }).click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(`第 ${bodyIndex + 1} 条：${body}`);
    await expect(confirmation.getByRole("textbox", { name: "保留的文字", exact: true })).toHaveValue(recovered);
  };

  await openConfirmation("target A", 0);
  const detachedA = await submit().elementHandle();
  if (!detachedA) throw new Error("Confirmation A has no submit control");
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await openConfirmation("target B", 1);
  const requestsBefore = (await invokeMmtE2E(page, "gui", "state")).editRequests;
  // The DOM click listener discards its async action. Capture that one promise so
  // assertions run after the stale handler settles, not in its pre-enqueue gap.
  await detachedA.evaluate(async (button) => {
    const resolve = Promise.resolve;
    let completion: Promise<unknown> | undefined;
    Reflect.set(Promise, "resolve", (value: unknown) => {
      completion = Reflect.apply(resolve, Promise, [value]) as Promise<unknown>;
      return completion;
    });
    try { (button as HTMLButtonElement).click(); }
    finally { Reflect.set(Promise, "resolve", resolve); }
    if (!completion) throw new Error("The detached action did not publish its completion promise");
    await completion;
  });
  await detachedA.dispose();
  expect((await invokeMmtE2E(page, "gui", "state")).editRequests).toBe(requestsBefore);
  expect(await authored(page, name)).toBe(source);
  expect((await textState(page)).recoveryText).toBe(recovered);
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("第 2 条：target B");

  await submit().click();
  await expect.poll(() => authored(page, name)).toBe(source.replace("target B", recovered));
  await expect.poll(async () => (await textState(page)).recoveryText).toBe("");
  await expect(confirmation).toBeHidden();
  await waitForComposerFrame(page, name);
  await expectBodies(page, ["target A", recovered]);
  expect((await invokeMmtE2E(page, "gui", "state")).editRequests).toBe(requestsBefore + 1);
});

test("desktop properties allocate a scrollable read-only SVG beside the panel, preserve drafts at 900px and apply to the original target", { tag: tags }, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  const name = "gui-desktop-properties-reading.mmt";
  const source = "> 佳代子: property target\n" + Array.from({ length: 40 }, (_, index) => `- reading row ${index} stays in the authored document\n`).join("");
  const frame = await openComposer(page, name, source);
  const bridge = await inputBridge(frame).elementHandle();
  if (!bridge) throw new Error("The retained SVG input bridge is unavailable");
  const surface = guiSurface(page);
  const canvas = surface.getByRole("main", { name: "聊天创作画布", exact: true });
  const originalBounds = await canvas.boundingBox();
  if (!originalBounds) throw new Error("The original SVG canvas is unavailable");
  await clickComposerBoundary(page, frame, "property target", 0);
  const panel = await openProperties(page);
  await expect(panel).toHaveAttribute("aria-modal", "false");
  await expect(canvas).toBeVisible();
  expect(await waitForPreviewFrame(page, `mmtfs://workspace/${name}`)).toBe(frame);
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(originalBounds.width);
  const frameOwner = await frame.frameElement();
  await expect.poll(async () => {
    const [visible, overlay, properties] = await Promise.all([canvas.boundingBox(), frameOwner.boundingBox(), panel.boundingBox()]);
    if (!visible || !overlay || !properties || visible.height <= 0 || overlay.width <= 0 || overlay.x + overlay.width > properties.x + 1) return Number.POSITIVE_INFINITY;
    return Math.max(Math.abs(visible.x - overlay.x), Math.abs(visible.y - overlay.y), Math.abs(visible.width - overlay.width), Math.abs(visible.height - overlay.height));
  }, { message: "the retained SVG overlay must match the allocated canvas and never lie under properties" }).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const visible = await canvas.boundingBox();
    const pageWidth = Number(await frame.locator(".typst-page").first().getAttribute("data-page-width"));
    return visible ? Math.abs(pageWidth - Math.round(visible.width)) : Number.POSITIVE_INFINITY;
  }, { message: "the real canvas ResizeObserver must publish the narrower chat preset" }).toBeLessThanOrEqual(1);
  await expectChatReadingScale(frame);
  await expectNoRootOverflow(page, frame);
  expect(await bridge.evaluate((element) => element.isConnected && element === document.querySelector("textarea.composer-input-bridge"))).toBe(true);
  await expect(inputBridge(frame)).toHaveCount(1);
  const viewport = frame.locator(".viewport");
  const scrollBefore = await viewport.evaluate((element) => element.scrollTop);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("The allocated SVG canvas is unavailable");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  await expect(panel).toBeVisible();
  expect(await authored(page, name)).toBe(source);
  // Nonmodal properties do not trap keyboard focus, while the canvas stays a
  // read-only reading surface until Apply or an explicit close ends the Sheet.
  await panel.getByRole("button", { name: "高级 / 局部源码", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement))).toBe(false);
  const displayName = panel.getByRole("textbox", { name: "显示名", exact: true });
  const pendingName = "Reading panel draft";
  await displayName.fill(pendingName);
  await page.setViewportSize({ width: 900, height: 820 });
  await expect(panel).toHaveAttribute("aria-modal", "true");
  await expect(canvas).toBeHidden();
  await expect(displayName).toHaveValue(pendingName);
  await page.setViewportSize({ width: 1024, height: 820 });
  await expect(panel).toHaveAttribute("aria-modal", "false");
  await expect(canvas).toBeVisible();
  await expect(displayName).toHaveValue(pendingName);
  await testInfo.attach("desktop-properties-allocated-reading", { body: await page.screenshot(), contentType: "image/png" });
  await panel.getByRole("button", { name: "从本条起应用显示名", exact: true }).click();
  const withProperty = `@actor 佳代子\npreset: ba::佳代子\ndisplay-name: ${pendingName}\n@end\n${source}`;
  await expect.poll(() => authored(page, name)).toBe(withProperty);
  await expect(panel).toBeHidden();
  await waitForComposerFrame(page, name);
  await waitForChatCanvasResize(page, frame);
  await clickComposerBoundary(page, frame, "property target", "end");
  await page.keyboard.insertText(" edited");
  await expect.poll(() => authored(page, name)).toBe(withProperty.replace("property target", "property target edited"));
});

test("SVG authoring retains content properties, source undo, one overlay, persistence, Local History and canonical PDF", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-complete-loop.mmt";
  const original = "> 佳代子: first\n> 阿洛娜: second\n- tail\n";
  const frame = await openComposer(page, name, original);
  const bridge = await inputBridge(frame).elementHandle();
  if (!bridge) throw new Error("The single overlay input bridge is unavailable");
  const surface = guiSurface(page);
  await expect(page.locator(".workbench-sidebar")).toBeHidden();
  await expect(page.getByRole("tab", { name: /^资源管理器/u })).toBeHidden();
  await replaceWholeBody(page, frame, "first", "loop body 😀");
  let expectedSource = "> 佳代子: loop body 😀\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await switchAuthoringMode(page, "source");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ sourceVisible: true, guiVisible: false });
  const explorer = page.getByRole("tab", { name: /^资源管理器/u });
  if (!await explorer.isVisible()) await page.keyboard.press("Control+Shift+e");
  await expect(explorer).toBeVisible();
  expect(await explorer.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
  }), "the retained SVG must not intercept restored native workspace controls").toBe(true);
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.insertText(" source");
  await expect.poll(() => authored(page, name)).toBe(expectedSource.replace("loop body 😀", "loop body 😀 source"));
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /^loop body/u, 0);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /^loop body/u, 0);
  let dialog = await openProperties(page);
  await dialog.getByRole("button", { name: "高级 / 局部源码", exact: true }).click();
  await dialog.getByLabel("文本模式", { exact: true }).selectOption("textRaw");
  await dialog.getByRole("button", { name: "应用文本模式", exact: true }).click();
  expectedSource = "> 佳代子: rt\"\"\"\nloop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => authored(page, name)).toBe(expectedSource);

  const selectMessage = async () => {
    await waitForComposerFrame(page, name);
    await clickComposerBoundary(page, frame, /^loop body/u, 0);
  };
  await selectMessage();
  dialog = await openProperties(page);
  await dialog.getByRole("button", { name: "高级 / 局部源码", exact: true }).click();
  await dialog.getByLabel("连续消息", { exact: true }).selectOption("true");
  await dialog.getByRole("button", { name: "应用连续状态", exact: true }).click();
  expectedSource = expectedSource.replace("> 佳代子:", ">(continued: true) 佳代子:");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await selectMessage();
  const beforeDisplayName = expectedSource;
  dialog = await openProperties(page);
  await dialog.getByRole("textbox", { name: "显示名", exact: true }).fill("夜行佳代子");
  await dialog.getByRole("button", { name: "从本条起应用显示名", exact: true }).click();
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\n@end\n" + expectedSource;
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await waitForComposerFrame(page, name);
  await documentAction(page, "撤销");
  await expect.poll(() => authored(page, name)).toBe(beforeDisplayName);
  await waitForComposerFrame(page, name);
  await documentAction(page, "重做");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  const avatarInsertion = expectedSource.indexOf("@end");
  await invokeMmtE2E(page, "workspace", "editDocument", name, avatarInsertion, 0, "avatar: ba::阿洛娜/ba::avatar/default\n");
  expectedSource = expectedSource.replace("@end", "avatar: ba::阿洛娜/ba::avatar/default\n@end");
  await selectMessage();
  dialog = await openProperties(page);
  await dialog.getByRole("button", { name: "从本条起更换头像", exact: true }).click();
  const avatarPanel = auxiliaryPanel(page);
  await avatarPanel.getByRole("textbox", { name: "搜索姓名、别名、学校或组织", exact: true }).fill("佳代子");
  await avatarPanel.getByRole("button", { name: /^佳代子 · ba::佳代子(?:\s|$)/u }).click();
  const avatarForm = avatarPanel.locator('button[data-entity="ba::佳代子"]:not([data-variant])');
  const defaultAvatar = avatarPanel.locator('button[data-entity="ba::佳代子"][data-variant="default"]');
  await expect.poll(async () => !await avatarPanel.isVisible() || await avatarForm.isVisible() || await defaultAvatar.isVisible()).toBe(true);
  if (await avatarForm.isVisible()) await avatarForm.click();
  // A single available expression applies immediately, without leaving an expression page open.
  await expect.poll(async () => !await avatarPanel.isVisible() || await defaultAvatar.isVisible()).toBe(true);
  if (await defaultAvatar.isVisible()) await defaultAvatar.click();
  await expect(avatarPanel).toBeHidden();
  expectedSource = expectedSource.replace("avatar: ba::阿洛娜/", "avatar: ba::佳代子/");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await selectMessage();
  dialog = await openProperties(page);
  await dialog.getByLabel("说话人", { exact: true }).selectOption("ba::阿洛娜");
  await dialog.getByRole("button", { name: "应用说话人", exact: true }).click();
  expectedSource = expectedSource.replace(">(continued: true) 佳代子:", ">(continued: true) ba::阿洛娜:");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await selectMessage();
  await selectedActions(page).getByRole("button", { name: "移动", exact: true }).click();
  await auxiliaryPanel(page).getByRole("button", { name: "下移", exact: true }).click();
  expectedSource = expectedSource.replace(">(continued: true) ba::阿洛娜: rt\"\"\"\nloop body 😀\"\"\"\n> 阿洛娜: second", "> 阿洛娜: second\n>(continued: true) ba::阿洛娜: rt\"\"\"\nloop body 😀\"\"\"");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, "tail", 0);
  await selectInsertPosition(page, "before");
  await openAddChoice(page, "旁白");
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill("inserted");
  const beforeInsertion = expectedSource;
  const insertionOffset = beforeInsertion.lastIndexOf("- tail\n");
  const untouchedPrefix = beforeInsertion.slice(0, insertionOffset);
  const untouchedSuffix = beforeInsertion.slice(insertionOffset);
  await surface.locator(".mmt-composer-send").click();
  await expectBodies(page, ["second", "loop body 😀", "inserted", "tail"]);
  await expect.poll(() => authored(page, name)).not.toBe(beforeInsertion);
  expectedSource = await authored(page, name);
  expect(expectedSource.startsWith(untouchedPrefix)).toBe(true);
  expect(expectedSource.endsWith(untouchedSuffix)).toBe(true);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, "tail", 0);
  await selectedActions(page).getByRole("button", { name: "删除", exact: true }).click();
  expectedSource = expectedSource.replace("- tail\n", "");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);

  const otherName = "gui-second-document.mmt";
  const otherFrame = await openComposer(page, otherName, "- another document\n");
  expect(otherFrame).toBe(frame);
  expect(await bridge.evaluate((element) => element.isConnected)).toBe(true);
  await clickComposerBoundary(page, frame, "another document", "end");
  await page.keyboard.insertText(" second");
  await expect.poll(() => authored(page, otherName)).toBe("- another document second\n");
  expect(await authored(page, name)).toBe(expectedSource);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  const overlayCounts = await Promise.all(page.frames().map(async (candidate) => {
    try { return await candidate.locator("textarea.composer-input-bridge").count(); } catch { return 0; }
  }));
  expect(overlayCounts.reduce((sum, count) => sum + count, 0)).toBe(1);
  for (const documentName of [name, otherName]) {
    expect(await invokeMmtE2E(page, "composer", "editorState", documentName)).toMatchObject({ modelCount: 1, textDocumentCount: 1 });
  }
  await switchAuthoringMode(page, "layout");
  expect(await waitForComposerFrame(page, name)).toBe(frame);
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ guiVisible: true });
  await documentAction(page, "保存");

  await frame.getByText("高级：导出已接受排版快照", { exact: true }).click();
  await frame.getByLabel("Export format", { exact: true }).selectOption("pdf");
  const canonicalOutput = await captureAcceptedOutput(frame);
  // No immutable fixture is installed: export consumes this real canonical render, never the IME overlay.
  await clickComposerBoundary(page, frame, "inserted", "end");
  await composition(frame, "start", "");
  await composition(frame, "update", "NOT IN THE PDF");
  await expect(frame.locator(".composer-composition")).toHaveText("NOT IN THE PDF");
  expect(await authored(page, name)).toBe(expectedSource);
  await expect(frame.getByLabel("Current preview export")).toHaveAttribute("data-availability", "ready");
  const canonical = await invokeMmtE2E(page, "exactExport", "fixture", { action: "state" });
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await frame.getByRole("button", { name: "Export current preview", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("gui-complete-loop.pdf");
  const pdf = await saveOutputDownload(download, testInfo, "advanced-live-ime-excluded");
  expectPdfPages(pdf, canonicalOutput.pages);
  await attachOutputManifest(testInfo, "advanced-live-ime-excluded", { ...canonicalOutput, source: expectedSource, excludedComposition: "NOT IN THE PDF" });
  if (!canonical || typeof canonical !== "object" || !("displayedRenderKey" in canonical)) {
    throw new Error("The real canonical export revision is unavailable");
  }
  await expect.poll(() => invokeMmtE2E(page, "exactExport", "fixture", { action: "state" })).toMatchObject({
    completedRenderKey: canonical.displayedRenderKey,
  });
  expect(await authored(page, name)).toBe(expectedSource);
  await frame.getByLabel("Export format", { exact: true }).selectOption("svg");
  const svgEvent = page.waitForEvent("download");
  await frame.getByRole("button", { name: "Export current preview", exact: true }).click();
  const svgDownload = await svgEvent;
  expect(svgDownload.suggestedFilename()).toBe("gui-complete-loop-page-1.svg");
  await inspectOutputSvg(page, await saveOutputDownload(svgDownload, testInfo, "advanced-live-ime-excluded"), canonicalOutput.pages[0]!, testInfo, "advanced-live-ime-excluded");
  expect(await authored(page, name)).toBe(expectedSource);
  await resolveRecovery(page, "discard", "NOT IN THE PDF");
  await documentAction(page, "本地历史");
  await expect(page.getByRole("tab", { name: "本地历史", exact: true })).toHaveAttribute("aria-selected", "true");
  await invokeMmtE2E(page, "history", "createCheckpoint", "SVG complete loop");
  await page.getByRole("combobox", { name: "本地历史范围", exact: true }).selectOption("workspace");
  await expect(page.getByRole("tree", { name: "本地历史版本", exact: true })).toContainText("SVG complete loop");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForComposerFrame(page, name);
  await testInfo.attach("desktop-svg-and-native-tools", { body: await page.screenshot(), contentType: "image/png" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  expect(await authored(page, name)).toBe(expectedSource);
  expect(await authored(page, otherName)).toBe("- another document second\n");
});

test("work sheets and native block menus retain keyboard focus, drafts and stale-action cancellation", { tag: tags }, async ({ page }) => {
  const name = "gui-native-action-menu.mmt";
  const original = "> 佳代子: menu body\n- tail\n";
  let frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const more = surface.getByRole("button", { name: / · 作品菜单$/u });
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.fill("keep the unsent draft");

  await documentAction(page, "整理内容");
  await expect(surface).toHaveAttribute("data-arranging", "true");
  await documentAction(page, "完成整理");
  await expect(surface).toHaveAttribute("data-arranging", "false");
  expect(await authored(page, name)).toBe(original);

  const workMenu = surface.getByRole("dialog", { name: "作品菜单", exact: true });
  await more.click();
  await expect(workMenu).toBeVisible();
  await expect.poll(() => workMenu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => workMenu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(workMenu).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await workMenu.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(more).toBeFocused();
  await draft.click();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("keep the unsent draft");

  await clickComposerBoundary(page, frame, "menu body", 0);
  const propertiesTrigger = selectedActions(page).getByRole("button", { name: "更多", exact: true });
  await propertiesTrigger.click();
  const properties = auxiliaryPanel(page);
  await expect(properties.getByRole("heading", { name: "内容属性", exact: true })).toBeVisible();
  await expect(surface.getByRole("dialog")).toHaveCount(1);
  await properties.getByRole("button", { name: "高级 / 局部源码", exact: true }).click();
  await expect(properties.getByLabel("连续消息", { exact: true })).toHaveValue("auto");
  await page.keyboard.press("Escape");
  await expect(propertiesTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(properties.getByRole("heading", { name: "内容属性", exact: true })).toBeVisible();
  await properties.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(propertiesTrigger).toBeFocused();
  const nativePoint = await framePoint(frame, await composerGlyphBoundary(frame, "menu body", 0));
  await page.mouse.click(nativePoint.x, nativePoint.y, { button: "right" });
  await expect(page.getByRole("menuitemcheckbox", { name: "连续消息 · 自动", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemcheckbox", { name: "连续消息 · 强制连续", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(nativeMenuItem(page, "重做")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  await propertiesTrigger.click();
  await properties.getByRole("textbox", { name: "显示名", exact: true }).fill("stale name must not be applied");
  const staleApply = await properties.getByRole("button", { name: "从本条起应用显示名", exact: true }).elementHandle();
  if (!staleApply) throw new Error("The node-bound property action is unavailable");
  const requestsBeforeStale = (await invokeMmtE2E(page, "gui", "state")).editRequests;
  await invokeMmtE2E(page, "workspace", "editDocument", name, original.length, 0, "\n");
  await expect(properties).toBeHidden();
  await expect.poll(() => authored(page, name)).toBe(`${original}\n`);
  frame = await waitForComposerFrame(page, name);
  // Even a delayed activation of the detached control must not write through its old node identity.
  await staleApply.evaluate((button) => (button as HTMLButtonElement).click());
  await staleApply.dispose();
  await clickComposerBoundary(page, frame, "menu body", 0);
  await propertiesTrigger.click();
  await properties.getByRole("button", { name: "高级 / 局部源码", exact: true }).click();
  await expect(properties.getByLabel("连续消息", { exact: true })).toHaveValue("auto");
  await page.keyboard.press("Escape");
  await expect(propertiesTrigger).toBeFocused();
  expect((await invokeMmtE2E(page, "gui", "state")).editRequests).toBe(requestsBeforeStale);
  expect(await authored(page, name)).toBe(`${original}\n`);
  await expect(draft).toHaveValue("keep the unsent draft");
  await page.setViewportSize({ width: 320, height: 550 });
  await waitForComposerFrame(page, name);
  await waitForChatCanvasResize(page, frame);
  await clickComposerBoundary(page, frame, "menu body", 0);
  const compactPoint = await framePoint(frame, await composerGlyphBoundary(frame, "menu body", 0));
  await page.mouse.click(compactPoint.x, compactPoint.y, { button: "right" });
  const menu = page.getByRole("menu").last();
  await expect(menu).toBeVisible();
  const bounds = await menu.evaluate((element) => {
    const popup = element.closest(".context-view");
    if (!popup) throw new Error("The shared native context view is unavailable");
    const rect = popup.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  await page.keyboard.press("End");
  const navigate = page.getByRole("menuitem", { name: "转到源码", exact: true });
  await expect(navigate).toBeFocused();
  await expect(navigate).toBeInViewport();
  await page.keyboard.press("Escape");
  await switchAuthoringMode(page, "source");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ sourceVisible: true, guiVisible: false });
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  await expect(draft).toHaveValue("keep the unsent draft");
  expect(await authored(page, name)).toBe(`${original}\n`);
  await draft.fill("");
});

test("bottom Composer sends continuously, retains roles and unsent drafts across canvas edits and native history", { tag: tags }, async ({ page }) => {
  const name = "gui-continuous-writing.mmt";
  let frame = await openComposer(page, name, "> 佳代子: old body\n");
  let surface = guiSurface(page);
  const draft = () => surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await expect(surface.getByRole("button", { name: "老师", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const body of ["Teacher one", "Teacher two"]) {
    await draft().fill(body);
    await draft().press("Enter");
    await expect(draft()).toHaveValue("");
    await expect(surface.getByRole("button", { name: "老师", exact: true })).toHaveAttribute("aria-pressed", "true");
    frame = await waitForComposerFrame(page, name);
  }
  await expectBodies(page, ["old body", "Teacher one", "Teacher two"]);
  expect(await authored(page, name)).toContain('< _0: rt"""\nTeacher one"""\n< _0: rt"""\nTeacher two"""\n');

  await chooseAvatarThroughUi(page, { search: "阿洛娜", person: "阿洛娜", entityId: "ba::阿洛娜", variantId: "default" });
  const selectedPortrait = surface.getByRole("button", { name: "阿洛娜", exact: true }).locator("img");
  await expect(selectedPortrait).toBeVisible();
  await expect.poll(() => selectedPortrait.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const currentRole = surface.getByRole("button", { name: "切换角色 · 阿洛娜", exact: true });
  const currentPortrait = currentRole.locator("img");
  await expect(currentRole).toHaveAttribute("title", /阿洛娜/u);
  await expect(currentPortrait).toBeVisible();
  await expect.poll(() => currentPortrait.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await currentPortrait.getAttribute("src")).toBe(await selectedPortrait.getAttribute("src"));
  for (const body of ["Actor one", "Actor two"]) {
    await draft().fill(body);
    await surface.getByRole("button", { name: "发送", exact: true }).click();
    await expect(draft()).toHaveValue("");
    await expect(surface.getByRole("button", { name: "阿洛娜", exact: true })).toHaveAttribute("aria-pressed", "true");
    frame = await waitForComposerFrame(page, name);
  }
  await expectBodies(page, ["old body", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await draft().fill("keep this unsent\nnext line");
  await clickComposerBoundary(page, frame, "old body", "end");
  await page.keyboard.insertText(" edited");
  await expectBodies(page, ["old body edited", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await documentAction(page, "撤销");
  await expectBodies(page, ["old body", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await documentAction(page, "重做");
  await expectBodies(page, ["old body edited", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await switchAuthoringMode(page, "source");
  await invokeMmtE2E(page, "composer", "openGui", name);
  frame = await waitForComposerFrame(page, name);
  surface = guiSurface(page);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await expect(surface.getByRole("button", { name: "阿洛娜", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The draft's real textarea handles IME sessions without interpreting Enter as Send.
  const beforeComposition = await authored(page, name);
  await draft().evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "字" }));
  });
  expect(await authored(page, name)).toBe(beforeComposition);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await draft().fill("");
});

test("saved pack-backed fenced EOF messages reopen with live text authority and retain continuous sending", { tag: tags }, async ({ page }) => {
  const name = "gui-reopen-fenced-eof.mmt";
  const original = [
    "- 放学后的讨论（修改）",
    "< 今天的安排准备好了吗？",
    "- 先写下一条，再回头修改。",
    '> ba::阿洛娜: rt"""',
    '老师，已经准备好了。"""',
  ].join("\n");
  await openComposer(page, name, original);
  await documentAction(page, "保存");
  await expect.poll(() => authored(page, name)).toBe(original);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForComposerFrame(page, name);
  expect(await authored(page, name)).toBe(original);
  const surface = guiSurface(page);
  const bodies = ["放学后的讨论（修改）", "今天的安排准备好了吗？", "先写下一条，再回头修改。", "老师，已经准备好了。"];
  await expectBodies(page, bodies);
  await expect(surface.getByRole("button", { name: "老师", exact: true })).toBeEnabled();
  await chooseAvatarThroughUi(page, { search: "阿洛娜", person: "阿洛娜", entityId: "ba::阿洛娜", variantId: "default" });
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  const committed: string[] = [];
  const requestsBefore = (await invokeMmtE2E(page, "gui", "state")).editRequests;
  let previousSource = original;
  for (const body of ["下一句留在这里，尚未发送", "再写一句，保持同一个角色"]) {
    await draft.fill(body);
    await expect(surface.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await surface.getByRole("button", { name: "发送", exact: true }).click();
    await expect(draft).toHaveValue("");
    bodies.push(body);
    await expectBodies(page, bodies);
    await expect.poll(() => authored(page, name)).not.toBe(previousSource);
    previousSource = await authored(page, name);
    expect(previousSource.startsWith(original)).toBe(true);
    committed.push(previousSource);
    await waitForComposerFrame(page, name);
    await expect(surface.getByRole("button", { name: "阿洛娜", exact: true, pressed: true })).toBeVisible();
  }
  expect((await invokeMmtE2E(page, "gui", "state")).editRequests - requestsBefore).toBe(2);
  await documentAction(page, "撤销");
  await expect.poll(() => authored(page, name)).toBe(committed[0]);
  await waitForComposerFrame(page, name);
  await documentAction(page, "重做");
  await expect.poll(() => authored(page, name)).toBe(committed[1]);
  await expect(draft).toHaveValue("");
});

test("bottom Shift+Enter and multiline clipboard paste each submit exactly one message", { tag: tags }, async ({ page }) => {
  const name = "gui-bottom-multiline-transactions.mmt";
  const original = "- seed\n";
  await openComposer(page, name, original);
  const draft = guiSurface(page).getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.click();
  await page.keyboard.insertText("typed first");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("typed second");
  await expect(draft).toHaveValue("typed first\ntyped second");
  expect(await authored(page, name)).toBe(original);
  await page.keyboard.press("Enter");
  await expect(draft).toHaveValue("");
  await expectBodies(page, ["seed", "typed first\ntyped second"]);
  await waitForComposerFrame(page, name);
  const firstCommit = await authored(page, name);
  await draft.focus();
  await pasteText(page, "pasted first\npasted second");
  await expect(draft).toHaveValue("pasted first\npasted second");
  expect(await authored(page, name)).toBe(firstCommit);
  await page.keyboard.press("Enter");
  await expect(draft).toHaveValue("");
  await expectBodies(page, ["seed", "typed first\ntyped second", "pasted first\npasted second"]);
  await expect.poll(async () => (await invokeMmtE2E(page, "gui", "state")).nodeKinds).toEqual(["narration", "message", "message"]);
});

test("bottom drafts are literal text even under Typst inheritance, and Teacher availability follows the Rust boundary", { tag: tags }, async ({ page }) => {
  const name = "gui-literal-draft.mmt";
  const original = "@mode: T\n- Seed\n";
  await openComposer(page, name, original);
  let surface = guiSurface(page);
  const literal = "#strong[not code]\n> @reply: still text";
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill(literal);
  await surface.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(async () => (await textState(page)).bodies.at(-1)).toMatchObject({ text: literal, resolvedMode: "textRaw" });
  expect((await authored(page, name)).startsWith(original)).toBe(true);
  const restrictedName = "gui-teacher-boundary.mmt";
  const restricted = "< 佳代子: named right\n";
  await openComposer(page, restrictedName, restricted);
  surface = guiSurface(page);
  const teacher = surface.getByRole("button", { name: "老师", exact: true });
  await expect(teacher).toBeDisabled();
  await expect(teacher).toHaveAttribute("title", /右侧说话人/u);
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill("retained, not silently reassigned");
  await expect(surface.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  expect(await authored(page, restrictedName)).toBe(restricted);
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill("");
});

test("native block menus and multiline local Source Lens stay on the SVG canvas and preserve untouched source", { tag: tags }, async ({ page }) => {
  const name = "gui-local-source.mmt";
  const original = "- seed\n@typ\n#text(fill: blue)[Source lens]\n@end\n- tail\n";
  let frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.fill("unsent while editing old content");
  await clickComposerBoundary(page, frame, "seed", 0);
  const point = await framePoint(frame, await composerGlyphBoundary(frame, "seed", 1));
  await page.mouse.click(point.x, point.y, { button: "right" });
  await nativeMenuItem(page, "编辑正文…").click();
  let local = page.getByRole("dialog", { name: "编辑正文", exact: true });
  await expect(local).toBeVisible();
  await expect(surface).toHaveAttribute("data-active", "true");
  await expect(surface.locator(".mmt-composer-inactive")).toBeHidden();
  await expect(frame.locator(".page")).toBeVisible();
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({ uri: `mmtfs://workspace/${name}` });
  await local.locator(".monaco-editor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("line one");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("line two");
  expect(await authored(page, name)).toBe(original);
  await page.keyboard.press("Control+Enter");
  await expectBodies(page, ["line one\nline two", "tail"]);
  const multiline = '- """\nline one\nline two"""\n@typ\n#text(fill: blue)[Source lens]\n@end\n- tail\n';
  await expect.poll(() => authored(page, name)).toBe(multiline);
  await expect(draft).toHaveValue("unsent while editing old content");
  frame = await waitForComposerFrame(page, name);

  await documentAction(page, "整理内容");
  await expect(surface).toHaveAttribute("data-arranging", "true");
  const retainedState = await textState(page);
  const retainedRenderer = {
    rendererSessionId: retainedState.rendererSessionId,
    rendererGeneration: retainedState.rendererGeneration,
  };
  // A scratch Monaco code model must not replace the selected native GUI
  // editor as the owner of the retained SVG, including while it has focus.
  await surface.getByLabel("整理内容", { exact: true }).selectOption({ index: 1 });
  await openLocalSource(page);
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await local.locator(".monaco-editor").click();
  await expect(surface).toHaveAttribute("data-active", "true");
  await expect(surface.locator(".mmt-composer-inactive")).toBeHidden();
  await expect(frame.locator(".page")).toBeVisible();
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({ uri: `mmtfs://workspace/${name}` });
  await expect.poll(() => textState(page)).toMatchObject(retainedRenderer);
  await expect(draft).toHaveValue("unsent while editing old content");
  expect(await authored(page, name)).toBe(multiline);
  await page.keyboard.press("Escape");
  await surface.getByLabel("整理内容", { exact: true }).selectOption({ index: 2 });
  await openLocalSource(page);
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await expect(local.locator(".view-lines")).toContainText("@typ");
  await local.locator(".monaco-editor").click();
  await expect(surface).toHaveAttribute("data-active", "true");
  await expect(surface.locator(".mmt-composer-inactive")).toBeHidden();
  await expect(frame.locator(".page")).toBeVisible();
  await expect.poll(() => textState(page)).toMatchObject(retainedRenderer);
  await page.keyboard.press("Control+a");
  const replacement = "@typ\n#text(fill: blue)[Source lens changed]\n@end\n";
  await page.keyboard.insertText(replacement);
  await page.keyboard.press("Escape");
  expect(await authored(page, name)).toBe(multiline);
  await openLocalSource(page);
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await local.locator(".monaco-editor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(replacement);
  await local.getByRole("button", { name: "应用", exact: true }).click();
  const changed = multiline.replace("@typ\n#text(fill: blue)[Source lens]\n@end\n", replacement);
  await expect.poll(() => authored(page, name)).toBe(changed);
  await expect(draft).toHaveValue("unsent while editing old content");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ guiVisible: true, sourceVisible: false, modelCount: 1, textDocumentCount: 1 });
  await waitForComposerFrame(page, name);
  await surface.getByLabel("整理内容", { exact: true }).selectOption({ index: 2 });
  await openLocalSource(page);
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await local.locator(".monaco-editor").click();
  await page.keyboard.press("Control+a");
  const retained = "@typ\n#text[unsubmitted local draft]\n@end\n";
  await page.keyboard.insertText(retained);
  await invokeMmtE2E(page, "workspace", "editDocument", name, changed.length, 0, "\n");
  await expect(local).toHaveCount(0);
  await expect.poll(() => authored(page, name)).toBe(`${changed}\n`);
  await expect(draft).toHaveValue("unsent while editing old content");
  await resolveRecovery(page, "copy", retained);
  await surface.getByRole("button", { name: "完成整理", exact: true }).click();
  await expect(surface).toHaveAttribute("data-arranging", "false");
  await draft.fill("");
});

test("canceling reload retains the bottom draft and leaves the live canvas runtime editable", { tag: tags }, async ({ page, context }) => {
  const name = "gui-cancel-draft-reload.mmt";
  const frame = await openComposer(page, name, "- live canvas\n");
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.click();
  await page.keyboard.insertText("do not lose this draft");
  const cdp = await context.newCDPSession(page);
  try {
    const dialogPromise = page.waitForEvent("dialog", { predicate: (dialog) => dialog.type() === "beforeunload" });
    const reloadRequested = cdp.send("Page.reload");
    const dialog = await dialogPromise;
    await dialog.dismiss();
    // A canceled reload has no navigation commit; wait only for the native request acknowledgement.
    await reloadRequested;
  } finally {
    await cdp.detach();
  }
  await expect(draft).toHaveValue("do not lose this draft");
  await expect(frame.locator(".page")).toBeVisible();
  await clickComposerBoundary(page, frame, "live canvas", "end");
  await page.keyboard.insertText(" still live");
  await expect.poll(() => authored(page, name)).toBe("- live canvas still live\n");
  await expect(draft).toHaveValue("do not lose this draft");
  await draft.fill("");
});

test.describe("mobile SVG composer", () => {
  test.use({ hasTouch: true });

  test("product modes temporarily hide native navigation and restore the same source workspace", {
    tag: [...tags, "@gui-composer-mobile"],
  }, async ({ page }) => {
    const name = "compact-native-navigation.mmt";
    await invokeMmtE2E(page, "workspace", "openDocument", name, "- reachable native GUI\n");
    const sidebar = page.locator(".workbench-sidebar");
    if (!await sidebar.isVisible()) await page.keyboard.press("Control+Shift+e");
    await expect(sidebar).toBeVisible();
    let frame = await returnToChatFromSource(page, name);
    await documentAction(page, "保存");
    await expect(sidebar).toBeHidden();
    await page.setViewportSize({ width: 550, height: 760 });
    await expect(sidebar).toBeHidden();
    await expectHeaderActionsInViewport(page);

    await switchAuthoringMode(page, "layout");
    frame = await waitForComposerFrame(page, name);
    await expect(sidebar).toBeHidden();
    await expectHeaderActionsInViewport(page);
    await switchAuthoringMode(page, "source");
    await expect(sidebar).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 820 });
    frame = await returnToChatFromSource(page, name);
    await expect(sidebar).toBeHidden();
    await expectNoRootOverflow(page, frame);
    // Persist the desktop layout, then restore it at 320px without a live desktop resize handler.
    await page.goto("about:blank");
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto("/?mmtExportMode=current-preview");
    await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
    await invokeMmtE2E(page, "composer", "openGui", name);
    await waitForComposerFrame(page, name);
    await expect(sidebar).toBeHidden();
    await expectHeaderActionsInViewport(page);
    expect(await authored(page, name)).toBe("- reachable native GUI\n");

    await switchAuthoringMode(page, "source");
    await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
      guiVisible: false, sourceVisible: true, modelCount: 1, textDocumentCount: 1,
    });
    await expect(sidebar).toBeVisible();
  });

  test("wide landscape and keyboard-short chat keep the active SVG caret, draft and core actions reachable", {
    tag: [...tags, "@gui-composer-mobile"],
  }, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const name = "landscape-active-canvas.mmt";
    let body = "landscape body";
    const frame = await openComposer(page, name, `- ${body}\n- untouched tail\n`);
    const surface = guiSurface(page);
    const canvas = surface.getByRole("main", { name: "聊天创作画布", exact: true });
    const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
    const unsent = "unsent landscape draft";
    await draft.fill(unsent);
    await clickComposerBoundary(page, frame, body, "end");
    await expect(inputBridge(frame)).toBeFocused();
    await expectSelection(page, [0, body.length]);
    await expect.poll(async () => (await textState(page)).pendingIntentCount).toBe(0);
    await expectCaretAtGlyph(frame, body, "end");

    for (const viewport of [{ width: 844, height: 390 }, { width: 740, height: 320 }]) {
      await page.setViewportSize(viewport);
      await waitForComposerFrame(page, name);
      await waitForChatCanvasResize(page, frame);
      await expectSelection(page, [0, body.length]);
      await expectCaretAtGlyph(frame, body, "end");
      await expect(inputBridge(frame)).toBeFocused();
      const suffix = ` ${viewport.width}`;
      await page.keyboard.insertText(suffix);
      body += suffix;
      await expectBodies(page, [body, "untouched tail"]);
      await expect.poll(() => authored(page, name)).toBe(`- ${body}\n- untouched tail\n`);
      await waitForComposerFrame(page, name);
      await expectSelection(page, [0, body.length]);
      await expectCaretAtGlyph(frame, body, "end");
      await expect(frame.locator(".composer-caret")).toBeInViewport({ ratio: 1 });
      await expect.poll(async () => {
        const [visible, caret] = await Promise.all([canvas.boundingBox(), frame.locator(".composer-caret").boundingBox()]);
        return !!visible && !!caret && visible.width > 0 && visible.height > 0 && caret.height > 0
          && caret.x >= visible.x - 1 && caret.y >= visible.y - 1
          && caret.x + caret.width <= visible.x + visible.width + 1
          && caret.y + caret.height <= visible.y + visible.height + 1;
      }, { message: "the active caret must fit inside the visible SVG canvas within one CSS pixel" }).toBe(true);
      await expectChatReadingScale(frame);
      await expectNoRootOverflow(page, frame);
      await expectHeaderActionsInViewport(page);
      await expect(draft).toHaveValue(unsent);
      await expectReachableControl(draft);
      await expectReachableControl(surface.getByRole("button", { name: "发送", exact: true }));
      await expectReachableControl(surface.getByRole("button", { name: /^切换角色 · /u }));
      await expectReachableControl(surface.getByRole("button", { name: "+ 添加", exact: true }));
      for (const action of ["完成编辑", "插入", "移动", "删除", "更多"]) {
        await expectReachableControl(selectedActions(page).getByRole("button", { name: action, exact: true }));
      }
      await expect(inputBridge(frame)).toBeFocused();
      await testInfo.attach(`${viewport.width}x${viewport.height}-active-landscape-canvas`, {
        body: await page.screenshot(), contentType: "image/png",
      });
    }
    await draft.fill("");
  });

  test("550px and 320px chat, touch selection and a keyboard-sized viewport keep controls and the Sheet reachable", {
    tag: [...tags, "@gui-composer-mobile"],
  }, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: 550, height: 760 });
    const name = "mobile-sheet-keyboard.mmt";
    await invokeMmtE2E(page, "workspace", "openDocument", name, "- mobile body\n");
    await invokeMmtE2E(page, "composer", "openGui", name);
    await invokeMmtE2E(page, "composer", "keepEditor", name);
    const frame = await waitForComposerFrame(page, name);
    const surface = guiSurface(page);
    const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
    const unsent = "尚未发送的下一句话需要完整显示";
    await draft.fill(unsent);
    await page.setViewportSize({ width: 320, height: 640 });
    await expectChatReadingScale(frame);
    await expect(draft).toHaveValue(unsent);
    await expect.poll(() => draft.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return input.scrollHeight <= input.clientHeight;
    })).toBe(true);
    await draft.fill("");
    await expectNoRootOverflow(page, frame);
    await expectHeaderActionsInViewport(page);
    await expectReachableControl(draft);
    await expectReachableControl(surface.getByRole("button", { name: "发送", exact: true }));
    await expectReachableControl(surface.getByRole("button", { name: /^切换角色 · /u }));
    const start = await framePoint(frame, await composerGlyphBoundary(frame, "mobile body", 0));
    await page.touchscreen.tap(start.x, start.y);
    await expect(inputBridge(frame)).toBeFocused();
    await page.keyboard.press("Shift+ArrowRight");
    await expectSelection(page, [0, 0], [0, 1]);
    const focusHandle = frame.locator('.composer-touch-handle[data-endpoint="focus"]');
    await expect(focusHandle).toBeVisible();
    const handle = await focusHandle.boundingBox();
    if (!handle) throw new Error("The native semantic touch selection handle is unavailable");
    expect(handle.width).toBeGreaterThanOrEqual(44);
    expect(handle.height).toBeGreaterThanOrEqual(44);
    const end = await framePoint(frame, await composerGlyphBoundary(frame, "mobile body", "end"));
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end.x, y: end.y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach();
    }
    await expectSelection(page, [0, 0], [0, 11]);
    await copySelection(page, "mobile body");
    await page.keyboard.insertText("mobile edited");
    await expectBodies(page, ["mobile edited"]);
    await waitForComposerFrame(page, name);
    // Browser viewport reduction is a soft-keyboard geometry equivalent, not an OS keyboard claim.
    await page.setViewportSize({ width: 320, height: 360 });
    await expectNoRootOverflow(page, frame);
    await expectHeaderActionsInViewport(page);
    await expectReachableControl(draft);
    await expectReachableControl(surface.getByRole("button", { name: "发送", exact: true }));
    await expect(frame.locator(".composer-caret")).toBeInViewport();
    await expect(inputBridge(frame)).toBeFocused();
    const dialog = await openProperties(page);
    await dialog.getByRole("button", { name: "高级 / 局部源码", exact: true }).click();
    await expectReachableControl(dialog.getByLabel("文本模式", { exact: true }));
    await expectReachableControl(dialog.getByRole("button", { name: "应用文本模式", exact: true }));
    await expectReachableControl(dialog.getByRole("button", { name: "关闭", exact: true }));
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await clickComposerBoundary(page, frame, "mobile edited", "end");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("next line");
    await expectBodies(page, ["mobile edited\nnext line"]);
    await waitForComposerFrame(page, name);
    await expect(frame.locator(".composer-caret")).toBeInViewport();
    await testInfo.attach("320px-svg-keyboard-viewport", { body: await page.screenshot(), contentType: "image/png" });
    await switchAuthoringMode(page, "source");
    await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ sourceVisible: true, guiVisible: false });
    expect(await openComposer(page, "mobile-second.mmt", "- second mobile document\n")).toBe(frame);
    await switchAuthoringMode(page, "layout");
    await waitForComposerFrame(page, "mobile-second.mmt");
    await expect(frame.getByRole("button", { name: "Fit width", exact: true })).toBeVisible();
    expect(await frame.locator("body").evaluate((element) => getComputedStyle(element).overflow)).toBe("hidden");
    expect(await frame.locator(".viewport").evaluate((element) => getComputedStyle(element).overflow)).toMatch(/auto|scroll/u);
  });
});
