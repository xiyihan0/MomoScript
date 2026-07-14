import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Response } from "@playwright/test";

const PACK_ROOT = "https://mms-pack.xiyihan.cn/ba_kivo/";
const MANIFEST_URL = `${PACK_ROOT}manifest.json`;
const manifest = await readFile(new URL("./fixtures/manifest.json", import.meta.url));
const avatar = await readFile(new URL("./fixtures/佳代子.png", import.meta.url));
const authored = [
  "@actor kayoko",
  "preset: ba::佳代子",
  "@end",
  "> kayoko: E2E persisted avatar message",
  ""
].join("\n");

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
      await route.abort("blockedbyclient");
    });
  }

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  const preview = page.locator(".workbench-preview");
  await expect(editor).toBeVisible();
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  const imageBaselineRevision = await preview.getAttribute("data-preview-revision");
  const workspaceImage = avatar.toString("base64");
  await page.evaluate(({ name, data }) => (Reflect.get(globalThis, "__mmtWriteWorkspaceFile") as Function)(name, data), { name: "workspace-image.png", data: workspaceImage });
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("@typ\nWORKSPACE_IMAGE_READY\n#image(\"./workspace-image.png\")\n@end");
  await expect(preview.locator(".tsel").filter({ hasText: "WORKSPACE_IMAGE_READY" }).first()).toBeAttached();
  await expect.poll(() => preview.getAttribute("data-preview-revision"), { timeout: 30000 }).not.toBe(imageBaselineRevision);
  await expect(preview.locator("svg image").first()).toBeVisible();
  const sanitizerResult = await page.evaluate(() => {
    const sanitizeSvg = Reflect.get(globalThis, "__mmtSanitizeSvg");
    if (typeof sanitizeSvg !== "function") throw new Error("missing E2E SVG sanitizer hook");
    const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h5="http://www.w3.org/1999/xhtml">'
      + '<foreignObject x="0" y="0" width="100" height="20"><h5:div class="tsel" style="font-size: 16px">中文 <h5:span>styled</h5:span></h5:div></foreignObject>'
      + '<foreignObject x="0" y="0" width="999" height="999"><h5:div class="tsel" style="font-size: 16px"><h5:span><h5:img src="https://evil.invalid/x" /></h5:span></h5:div></foreignObject>'
      + '<script>alert(1)</script></svg>';
    const root = new DOMParser().parseFromString(source, "text/html").querySelector("svg");
    if (!root) throw new Error("missing sanitizer fixture root");
    sanitizeSvg(root);
    return {
      foreignObjects: root.querySelectorAll("foreignObject").length,
      activeNodes: root.querySelectorAll("script, img, iframe, object, embed").length,
      text: root.querySelector(".tsel")?.textContent,
      tag: root.querySelector(".tsel")?.localName
    };
  });
  expect(sanitizerResult).toEqual({
    foreignObjects: 1,
    activeNodes: 0,
    text: "中文 styled",
    tag: "div"
  });
  const splitter = page.getByRole("separator", { name: "Resize editor and preview" });
  await expect(splitter).toBeVisible();
  const initialEditorWidth = (await editor.boundingBox())!.width;
  const splitterBox = (await splitter.boundingBox())!;
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 80, splitterBox.y + 20);
  await page.mouse.up();
  await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(initialEditorWidth + 60);
  await splitter.dblclick();
  await expect.poll(async () => (await editor.boundingBox())!.width).toBeCloseTo(initialEditorWidth, 0);
  const explorerActivity = page.getByRole("tab", { name: /^Explorer/ });
  const mmsActivity = page.getByRole("tab", { name: "MomoScript", exact: true });
  const previewToggle = page.getByRole("button", { name: "Collapse preview" });
  await expect(explorerActivity).toBeVisible();
  await expect(explorerActivity).toHaveAttribute("aria-selected", "true");
  await expect(previewToggle).toBeVisible();
  const previewToggleBox = (await previewToggle.boundingBox())!;
  const fitButtonBox = (await page.getByRole("button", { name: "Fit width" }).boundingBox())!;
  expect(previewToggleBox.x).toBeGreaterThanOrEqual(fitButtonBox.x + fitButtonBox.width);
  await explorerActivity.click();
  await expect(page.locator("#workbench")).toHaveClass(/sidebar-collapsed/);
  await explorerActivity.click();
  await expect(page.locator("#workbench")).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole("tree", { name: "Files Explorer" })).toBeVisible();
  await explorerActivity.click();
  await expect(page.locator("#workbench")).toHaveClass(/sidebar-collapsed/);
  await mmsActivity.click();
  await expect(page.locator("#workbench")).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole("textbox", { name: "Resource pack manifest URLs" })).toBeVisible();
  await expect(mmsActivity).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "Resource pack manifest URLs" })).toHaveValue(MANIFEST_URL);
  await explorerActivity.click();
  await expect(page.getByRole("tree", { name: "Files Explorer" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Resource pack manifest URLs" })).toBeHidden();
  await expect(explorerActivity).toHaveAttribute("aria-selected", "true");
  await previewToggle.click();
  await expect(preview).toBeHidden();
  await expect(splitter).toBeHidden();
  await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(initialEditorWidth + 250);
  await page.getByRole("button", { name: "Expand preview" }).click();
  await expect(preview).toBeVisible();
  await expect(splitter).toBeVisible();
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
  if (testInfo.project.name === "chrome") {
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const textBox = await selectableText.boundingBox();
    expect(textBox).not.toBeNull();
    const hitTarget = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return { localName: target?.localName, className: target?.getAttribute("class") };
    }, { x: textBox!.x + 1, y: textBox!.y + textBox!.height / 2 });
    await page.mouse.move(textBox!.x + 1, textBox!.y + textBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(textBox!.x + textBox!.width - 1, textBox!.y + textBox!.height / 2, { steps: 10 });
    await page.mouse.up();
    const selectionAfterDrag = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect({ hitTarget, selectionAfterDrag }).toMatchObject({
      hitTarget: { className: "tsel" },
      selectionAfterDrag: expect.stringContaining("Page one")
    });
    await page.keyboard.press("Control+C");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Page one");
  }
  const pageGap = await preview.locator(".typst-page").evaluateAll((pages) => {
    const first = pages[0].getBoundingClientRect();
    const second = pages[1].getBoundingClientRect();
    return second.top - first.bottom;
  });
  expect(pageGap).toBeGreaterThan(5);
  const baselineRevision = await preview.getAttribute("data-preview-revision");
  const baselineShadowCount = Number(await preview.getAttribute("data-preview-shadow-count"));
  expect(Number.isSafeInteger(baselineShadowCount)).toBe(true);

  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(authored);
  await expect(page.locator(".workbench-editor .view-lines")).toContainText("E2E persisted avatar message");
  await expect(preview).not.toHaveAttribute("data-preview-revision", baselineRevision ?? "");
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expect(preview.locator('svg[aria-label="Rendered MomoScript preview"]')).toBeVisible();
  await preview.getByRole("button", { name: "Zoom in" }).click();
  await expect(preview.locator(".typst-preview-zoom")).toHaveText("110%");
  await preview.getByRole("button", { name: "Actual size" }).click();
  await expect(preview.locator(".typst-preview-zoom")).toHaveText("100%");
  const actualSize = await preview.evaluate((element) => {
    const canvas = element.querySelector<HTMLElement>(".typst-preview-canvas")!;
    return {
      canvasWidth: Number.parseFloat(canvas.style.width),
      intrinsicWidth: Number(canvas.dataset.intrinsicWidth),
    };
  });
  expect(actualSize.canvasWidth).toBeCloseTo(actualSize.intrinsicWidth, 5);
  const authoredShadowCount = Number(await preview.getAttribute("data-preview-shadow-count"));
  expect(authoredShadowCount).toBeGreaterThan(baselineShadowCount);
  await expect.poll(() => persistedStory(page)).toBe(authored);
  await seedLegacyWorkspace(page, false);
  await expect.poll(() => workspaceEntryExists(page, "/workspace")).toBe(true);

  const secondAsset = page.waitForResponse((response) => isPackAsset(response));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect(page.locator(".workbench-editor .view-lines")).toContainText("E2E persisted avatar message");
  const secondAssetResponse = await secondAsset;
  expect(secondAssetResponse.ok(), `reloaded pack asset returned HTTP ${secondAssetResponse.status()}`).toBe(true);
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expect(preview.locator('svg[aria-label="Rendered MomoScript preview"]')).toBeVisible();
  await expect(preview).toHaveAttribute("data-preview-shadow-count", String(authoredShadowCount));
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
