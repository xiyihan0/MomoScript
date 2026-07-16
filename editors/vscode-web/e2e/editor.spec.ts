import { readFile } from "node:fs/promises";
import { expect, test, type Frame, type Page, type Response } from "@playwright/test";

const PACK_ROOT = "https://mms-pack.xiyihan.cn/ba_kivo/";
const MANIFEST_URL = `${PACK_ROOT}manifest.json`;
const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454/tinymist_bg.wasm";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.7.0-rc2/acac51459fa84907843d7a1927ae7b6fc5c743d5de4f61473c866829c9c46e2d/typst_ts_web_compiler_bg.wasm";
const manifest = await readFile(new URL("./fixtures/manifest.json", import.meta.url));
const avatar = await readFile(new URL("./fixtures/佳代子.png", import.meta.url));
const authored = [
  "@actor kayoko",
  "preset: ba::佳代子",
  "@end",
  "> kayoko: E2E persisted avatar message",
  ""
].join("\n");
const editedIntro = "#set page(width: 420pt, height: 260pt)\n= Welcome to MomoScript\n\nIntro persisted.\n";

test("production editor materializes an avatar and restores the authored story after reload", async ({ page }, testInfo) => {
  const local = testInfo.project.name !== "remote";
  let manifestRequests = 0;
  let avatarRequests = 0;
  if (local) {
    await page.route("https://**/*", async (route) => {
      const url = route.request().url();
      if (url === MANIFEST_URL) {
        manifestRequests += 1;
        await route.fulfill({
          status: 200,
          body: manifest,
          headers: corsHeaders("application/json", '"e2e-manifest"')
        });
        return;
      }
      if (decodeURIComponent(new URL(url).pathname) === "/ba_kivo/assets/avatar/佳代子.png") {
        avatarRequests += 1;
        await route.fulfill({
          status: 200,
          body: avatar,
          headers: corsHeaders("image/png")
        });
        return;
      }
      if (url === TINYMIST_WASM_URL || url === TYPST_COMPILER_WASM_URL) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
  }

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  const outputPanel = page.locator(".workbench-panel");
  const outputToggle = page.getByRole("status").getByRole("button", { name: /MomoScript/ });
  const problemsToggle = page.locator("#status\\.problems").getByRole("button");
  if (await outputPanel.isVisible()) {
    await outputToggle.click();
    await outputToggle.click();
  }
  await expect(outputPanel).toBeHidden();
  await outputToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^输出/ })).toHaveAttribute("aria-selected", "true");
  await expect(outputPanel).toContainText("MomoScript editor ready");
  await problemsToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^问题/ })).toHaveAttribute("aria-selected", "true");
  await problemsToggle.click();
  await expect(outputPanel).toBeHidden();
  await outputToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^输出/ })).toHaveAttribute("aria-selected", "true");
  let editor = page.locator(".workbench-editor .monaco-editor").first();
  const preview = page.locator(".workbench-preview");
  await expect(editor).toBeVisible();
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "intro.typ", languageId: "typst" });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect(page.getByRole("tab", { name: /^intro\.typ（预览）/ })).toBeVisible();
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  const previewWebview = await previewWebviewFrame(page);
  await expect(previewWebview.locator("#workbench")).toHaveCount(0);
  await expect(previewWebview.locator(".viewport .page svg")).toBeAttached({ timeout: 60_000 });
  const exportTrigger = previewWebview.getByRole("button", { name: "导出" });
  const exportMenu = previewWebview.getByRole("menu", { name: "导出格式" });
  await expect(exportTrigger).toBeVisible();
  await expect(exportTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(exportMenu).toBeHidden();
  await exportTrigger.click();
  await expect(exportTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(exportMenu).toBeVisible();
  await expect(exportMenu.getByRole("menuitem")).toHaveText([
    "PDF 文档.pdf",
    "PNG 图片.png",
    "JPEG 图片.jpg",
    "SVG 矢量图.svg"
  ]);
  await previewWebview.locator("body").press("Escape");
  await expect(exportMenu).toBeHidden();
  await page.evaluate(() => (Reflect.get(globalThis, "__mmtShowWorkspaceDocument") as Function)("intro.typ"));
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "intro.typ", languageId: "typst" });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect(page.getByRole("tab", { name: /^intro\.typ（预览）/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(({ name, text }) => (Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function)(name, text), {
    name: "intro.typ",
    text: editedIntro
  });
  await expect.poll(() => readWorkspaceDocument(page, "intro.typ")).toBe(editedIntro);
  const defaultStory = await readWorkspaceDocument(page, "story.mmt");
  expect(defaultStory).toContain("> 佳代子:");
  expect(defaultStory).toContain(">_:");
  expect(defaultStory).toContain("< 老师好！");
  expect(defaultStory).toContain("[:#1:]");
  await page.evaluate(() => (Reflect.get(globalThis, "__mmtShowWorkspaceDocument") as Function)("story.mmt"));
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => displayedPreviewSource(page)).toMatch(/story\.mmt$/);
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expect(preview.locator("svg image").first()).toBeAttached();
  await page.evaluate(({ name, text }) => (Reflect.get(globalThis, "__mmtOpenWorkspaceDocument") as Function)(name, text), {
    name: "story.mmt",
    text: "@reply\n- 选项 A\n- 选项 B\n@end\n"
  });
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "story.mmt", languageId: "mmt" });
  editor = page.locator('[role="code"][data-uri="mmtfs://workspace/story.mmt"]');
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => displayedPreviewSource(page)).toMatch(/story\.mmt$/);
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  const imageBaselineRevision = await preview.getAttribute("data-preview-revision");
  const workspaceImage = avatar.toString("base64");
  await page.evaluate(({ name, data }) => (Reflect.get(globalThis, "__mmtWriteWorkspaceFile") as Function)(name, data), { name: "workspace-image.png", data: workspaceImage });
  await page.evaluate(() => (Reflect.get(globalThis, "__mmtShowWorkspaceDocument") as Function)("story.mmt"));
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "story.mmt", languageId: "mmt" });
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("@typ\nWORKSPACE_IMAGE_READY\n#image(\"./workspace-image.png\")\n@end");
  await expect(preview.locator(".tsel").filter({ hasText: "WORKSPACE_IMAGE_READY" }).first()).toBeAttached();
  await expect.poll(() => preview.getAttribute("data-preview-revision"), { timeout: 30000 }).not.toBe(imageBaselineRevision);
  await expect(preview.locator("svg image").first()).toBeAttached();
  await expect.poll(() => renderedWebviewHasVisibleIntrinsicPage(page), { timeout: 30_000 }).toBe(true);
  const sanitizerResult = await page.evaluate(() => {
    const sanitizeSvg = Reflect.get(globalThis, "__mmtSanitizeSvg");
    if (typeof sanitizeSvg !== "function") throw new Error("missing E2E SVG sanitizer hook");
    const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h5="http://www.w3.org/1999/xhtml">'
      + '<foreignObject x="0" y="0" width="100" height="20"><h5:div class="tsel" style="font-size: 16px">中文 <h5:span>styled</h5:span></h5:div></foreignObject>'
      + '<foreignObject x="0" y="0" width="999" height="999"><h5:div class="tsel" style="font-size: 16px"><h5:span><h5:img src="https://evil.invalid/x" /></h5:span></h5:div></foreignObject>'
      + '<a href="https://example.com"><rect class="pseudo-link" width="40" height="12"></rect></a>'
      + '<script>alert(1)</script></svg>';
    const root = new DOMParser().parseFromString(source, "text/html").querySelector("svg");
    if (!root) throw new Error("missing sanitizer fixture root");
    sanitizeSvg(root);
    return {
      foreignObjects: root.querySelectorAll("foreignObject").length,
      activeNodes: root.querySelectorAll("script, img, iframe, object, embed").length,
      text: root.querySelector(".tsel")?.textContent,
      tag: root.querySelector(".tsel")?.localName,
      pseudoLinkFill: root.querySelector("rect.pseudo-link")?.getAttribute("fill")
    };
  });
  expect(sanitizerResult).toEqual({
    foreignObjects: 1,
    activeNodes: 0,
    text: "中文 styled",
    tag: "div",
    pseudoLinkFill: "transparent"
  });
  const explorerActivity = page.getByRole("tab", { name: /^资源管理器/ });
  const mmsActivity = page.getByRole("tab", { name: "MomoScript", exact: true });
  await expect(explorerActivity).toBeVisible();
  await expect(explorerActivity).toHaveAttribute("aria-selected", "true");
  await explorerActivity.click();
  await expect(page.locator("#workbench")).toHaveClass(/sidebar-collapsed/);
  await explorerActivity.click();
  await expect(page.locator("#workbench")).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole("tree", { name: "文件资源管理器" })).toBeVisible();
  await explorerActivity.click();
  await expect(page.locator("#workbench")).toHaveClass(/sidebar-collapsed/);
  await mmsActivity.click();
  await expect(page.locator("#workbench")).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole("textbox", { name: "资源包清单地址" })).toBeVisible();
  await expect(mmsActivity).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "资源包清单地址" })).toHaveValue(MANIFEST_URL);
  await explorerActivity.click();
  await expect(page.getByRole("tree", { name: "文件资源管理器" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "资源包清单地址" })).toBeHidden();
  await expect(explorerActivity).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => workspaceEntryExists(page, "/workspace")).toBe(false);
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("- [:asset, lo");
  await expect.poll(() => page.evaluate(async (character) => {
    const completionLabels = Reflect.get(globalThis, "__mmtCompletionLabels");
    if (typeof completionLabels !== "function") throw new Error("missing E2E completion hook");
    return completionLabels(0, character);
  }, "- [:asset, lo".length)).toContain("logo");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("[");
  await page.keyboard.type(":");
  await expect.poll(() => page.evaluate(() => {
    const storyText = Reflect.get(globalThis, "__mmtStoryText");
    if (typeof storyText !== "function") throw new Error("missing E2E story text hook");
    return storyText();
  })).toBe("[::]");
  await page.keyboard.type("x");
  await expect.poll(() => page.evaluate(() => {
    const storyText = Reflect.get(globalThis, "__mmtStoryText");
    if (typeof storyText !== "function") throw new Error("missing E2E story text hook");
    return storyText();
  })).toBe("[:x:]");
  await editor.click();
  await page.keyboard.press("Control+A");
  const resourcePrefix = "> 晴_露营: [:晴_露营,#";
  await page.keyboard.insertText(resourcePrefix);
  await expect.poll(() => page.evaluate(async ({ character }) => {
    const completionLabels = Reflect.get(globalThis, "__mmtCompletionLabels");
    if (typeof completionLabels !== "function") throw new Error("missing E2E completion hook");
    return completionLabels(0, character);
  }, { character: resourcePrefix.length })).toContain("#1");
  await editor.click();
  await page.keyboard.press("Control+A");
  const resourceMarker = "> 晴_露营: [:晴_露营,#1:]";
  await page.keyboard.insertText(resourceMarker);
  const ordinalCharacter = resourceMarker.indexOf("#1") + 1;
  await expect.poll(() => page.evaluate(async ({ character }) => {
    const hoverText = Reflect.get(globalThis, "__mmtHoverText");
    if (typeof hoverText !== "function") throw new Error("missing E2E hover hook");
    return hoverText(0, character);
  }, { character: ordinalCharacter })).toContainEqual(expect.stringContaining("default\\_001"));
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("- #123");
  const colorDecorators = await page.evaluate(() => {
    const readColorDecorators = Reflect.get(globalThis, "__mmtColorDecorators");
    if (typeof readColorDecorators !== "function") throw new Error("missing E2E color configuration hook");
    return readColorDecorators();
  });
  expect(colorDecorators).toBe("never");
  await page.waitForTimeout(750);
  await expect(editor.locator(".colorpicker-color-decoration")).toHaveCount(0);
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("@typ\nPage one\n#pagebreak()\nPage two\n@end");
  await expect(preview.locator(".typst-page")).toHaveCount(2);
  const selectableText = preview.locator(".tsel").filter({ hasText: "Page one" }).first();
  await expect(selectableText).toBeAttached();
  const baselineRevision = await preview.getAttribute("data-preview-revision");
  const baselineShadowCount = Number(await preview.getAttribute("data-preview-shadow-count"));
  expect(Number.isSafeInteger(baselineShadowCount)).toBe(true);
  const baselineProjectionRevision = await page.evaluate(() => {
    const revision = Reflect.get(globalThis, "__mmtLatestProjectionRevision");
    if (typeof revision !== "function") throw new Error("missing E2E projection revision hook");
    return revision() as number;
  });
  await mmsActivity.click();
  const previewOnChange = page.getByRole("checkbox", { name: "文档变化时自动预览" });
  await expect(previewOnChange).toBeChecked();
  await previewOnChange.uncheck();
  await expect(page.getByText("实时预览已暂停", { exact: true })).toBeVisible();
  await explorerActivity.click();
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("- preview paused");
  await expect.poll(() => page.evaluate(() => {
    const revision = Reflect.get(globalThis, "__mmtLatestProjectionRevision");
    if (typeof revision !== "function") throw new Error("missing E2E projection revision hook");
    return revision() as number;
  })).toBeGreaterThan(baselineProjectionRevision);
  await expect(preview).toHaveAttribute("data-preview-revision", baselineRevision ?? "");
  await mmsActivity.click();
  await expect(previewOnChange).not.toBeChecked();
  await previewOnChange.check();
  await expect(page.getByText("实时预览已启用", { exact: true })).toBeVisible();
  await expect(preview).not.toHaveAttribute("data-preview-revision", baselineRevision ?? "");
  await explorerActivity.click();

  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(authored);
  await expect(editor.locator(".view-lines")).toContainText("E2E persisted avatar message");
  await expect(preview).not.toHaveAttribute("data-preview-revision", baselineRevision ?? "");
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expect(preview.locator('svg[aria-label="Rendered MomoScript preview"]')).toBeAttached();
  await expect.poll(() => renderedWebviewHasVisibleIntrinsicPage(page), { timeout: 30_000 }).toBe(true);
  const authoredShadowCount = Number(await preview.getAttribute("data-preview-shadow-count"));
  expect(authoredShadowCount).toBeGreaterThan(0);
  await expect(preview.locator("svg image").first()).toBeAttached();
  if (local) expect(avatarRequests).toBe(1);
  await expect.poll(() => persistedStory(page)).toBe(authored);
  const chapterInitial = "@typ\nCHAPTER_TWO\n@end\n";
  const chapterEdited = "@typ\nCHAPTER_TWO_EDITED\n@end\n";
  await page.evaluate(({ name, text }) => (Reflect.get(globalThis, "__mmtOpenWorkspaceDocument") as Function)(name, text), {
    name: "chapter-two.mmt.txt",
    text: chapterInitial
  });
  await expect(page.getByRole("tab", { name: /^chapter-two\.mmt\.txt，预览, 编辑器组\d+$/ })).toBeVisible();
  const chapterEditor = page.getByRole("textbox", { name: /^chapter-two\.mmt\.txt，预览, 编辑器组\d+$/ });
  await chapterEditor.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(chapterEdited);
  await expect.poll(() => readWorkspaceDocument(page, "chapter-two.mmt.txt")).toBe(chapterEdited);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => displayedPreviewSource(page)).toMatch(/chapter-two\.mmt\.txt$/);
  await expect.poll(() => visiblePreviewText(page), { timeout: 30_000 }).toContain("CHAPTER_TWO_EDITED");
  await page.getByRole("tab", { name: /^story\.mmt, 编辑器组\d+$/ }).click();
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => displayedPreviewSource(page)).toMatch(/story\.mmt$/);
  await expect.poll(() => visiblePreviewText(page), { timeout: 30_000 }).toContain("E2E persisted avatar message");
  await seedLegacyWorkspace(page, false);
  await expect.poll(() => workspaceEntryExists(page, "/workspace")).toBe(true);

  const secondAsset = page.waitForResponse((response) => isPackAsset(response));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "intro.typ", languageId: "typst", text: editedIntro });
  await page.evaluate(() => (Reflect.get(globalThis, "__mmtShowWorkspaceDocument") as Function)("story.mmt"));
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "story.mmt", languageId: "mmt" });
  await expect(editor.locator(".view-lines")).toContainText("E2E persisted avatar message");
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const secondAssetResponse = await secondAsset;
  expect(secondAssetResponse.ok(), `reloaded pack asset returned HTTP ${secondAssetResponse.status()}`).toBe(true);
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expect(preview.locator('svg[aria-label="Rendered MomoScript preview"]')).toBeAttached();
  await expect.poll(() => renderedWebviewHasVisibleIntrinsicPage(page), { timeout: 30_000 }).toBe(true);
  await expect(preview).toHaveAttribute("data-preview-shadow-count", /[1-9]\d*/);
  await expect(preview.locator("svg image").first()).toBeAttached();
  await expect.poll(() => workspaceEntryExists(page, "/workspace")).toBe(false);
  await expect.poll(() => persistedStory(page)).toBe(authored);

  if (local) {
    expect(manifestRequests).toBe(2);
    expect(avatarRequests).toBe(2);
  }

  await seedLegacyWorkspace(page, true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect.poll(() => workspaceEntryExists(page, "/workspace")).toBe(true);
  await expect.poll(() => workspaceEntryExists(page, "/workspace/keep.txt")).toBe(true);
  await expect.poll(() => persistedStory(page)).toBe(authored);
});
async function activeDocument(page: Page): Promise<{ name: string; languageId: string; text: string } | null> {
  return page.evaluate(() => (Reflect.get(globalThis, "__mmtActiveDocument") as Function)());
}

async function renderedWebviewHasVisibleIntrinsicPage(page: Page): Promise<boolean> {
  const frames = page.frames().filter((candidate) => candidate.url().includes("/fake-") && candidate.url().includes(".html"));
  for (const frame of frames.toReversed()) {
    const visible = await frame.evaluate(() => {
      const pageElement = document.querySelector<HTMLElement>(".page[data-intrinsic-width][data-intrinsic-height]");
      const svg = pageElement?.querySelector<SVGElement>("svg[aria-label='Rendered MomoScript preview']");
      if (!pageElement || !svg) return false;
      const pageRect = pageElement.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      const intrinsicWidth = Number(pageElement.dataset.intrinsicWidth);
      const intrinsicHeight = Number(pageElement.dataset.intrinsicHeight);
      return pageRect.width > 0
        && pageRect.height > 0
        && Math.abs(pageRect.width - intrinsicWidth) < 1
        && Math.abs(pageRect.height - intrinsicHeight) < 1
        && Math.abs(svgRect.width - intrinsicWidth) < 1
        && Math.abs(svgRect.height - intrinsicHeight) < 1;
    });
    if (visible) return true;
  }
  return false;
}

async function visiblePreviewText(page: Page): Promise<string> {
  const frames = page.frames().filter((candidate) => candidate.url().includes("/fake-") && candidate.url().includes(".html"));
  for (const frame of frames.toReversed()) {
    const result = await frame.evaluate(() => {
      const pageElement = document.querySelector<HTMLElement>(".page[data-intrinsic-width]");
      return pageElement && pageElement.getBoundingClientRect().width > 0 ? pageElement.textContent ?? "" : "";
    });
    if (result) return result;
  }
  return "";
}

async function readWorkspaceDocument(page: Page, name: string): Promise<string> {
  return page.evaluate(async (fileName) => {
    const readDocument = Reflect.get(globalThis, "__mmtReadWorkspaceDocument");
    if (typeof readDocument !== "function") throw new Error("missing E2E workspace document reader");
    return readDocument(fileName) as Promise<string>;
  }, name);
}


async function displayedPreviewSource(page: Page): Promise<string> {
  return page.evaluate(() => {
    const source = Reflect.get(globalThis, "__mmtDisplayedPreviewSourceUri");
    if (typeof source !== "function") throw new Error("missing E2E displayed preview source hook");
    return source() as string;
  });
}

function corsHeaders(contentType: string, etag?: string): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": contentType,
    ...(etag ? { etag } : {})
  };
}

function isPackAsset(response: Response): boolean {
  const url = response.url();
  return url.startsWith(PACK_ROOT)
    && url !== MANIFEST_URL
    && /\.(?:avifs?|png|jpe?g|svg|webp)(?:$|\?)/i.test(url);
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
        // VS Code replaces its pending webview iframe after setting HTML.
      }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  if (!previewFrame) throw new Error("rendered preview webview frame is missing");
  return previewFrame;
}

async function seedLegacyWorkspace(page: Page, withChild: boolean): Promise<void> {
  await page.evaluate(async (includeChild) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("files", "readwrite");
        const store = transaction.objectStore("files");
        const now = Date.now();
        store.put({ path: "/workspace", type: 2, ctime: now, mtime: now, data: new Uint8Array() });
        if (includeChild) {
          store.put({
            path: "/workspace/keep.txt",
            type: 1,
            ctime: now,
            mtime: now,
            data: new TextEncoder().encode("keep"),
          });
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, withChild);
}

async function workspaceEntryExists(page: Page, path: string): Promise<boolean> {
  return page.evaluate(async (entryPath) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = database.transaction("files").objectStore("files").getKey(entryPath);
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, path);
}

async function persistedStory(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("momoscript-workspace-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const entry = await new Promise<{ data?: Uint8Array } | undefined>((resolve, reject) => {
        const request = database.transaction("files").objectStore("files").get("/story.mmt");
        request.onsuccess = () => resolve(request.result as { data?: Uint8Array } | undefined);
        request.onerror = () => reject(request.error);
      });
      return entry?.data ? new TextDecoder().decode(entry.data) : undefined;
    } finally {
      database.close();
    }
  });
}
