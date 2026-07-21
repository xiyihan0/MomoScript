import { readFile } from "node:fs/promises";
import { expect, test, type Frame, type Locator, type Page, type Response } from "@playwright/test";

const PACK_ROOT = "https://mms-pack.xiyihan.cn/ba_kivo/";
const MANIFEST_URL = `${PACK_ROOT}manifest.json`;
const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454/tinymist_bg.wasm.br?delivery=br-v1";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.8.0-rc3/85a071522388ca99f0cf7f749a287b5578b4c3256ac16014d2894e73e862979a/typst_ts_web_compiler_bg.wasm.br?delivery=br-v1";
const TINYMIST_WASM_FALLBACK_URL = TINYMIST_WASM_URL.replace(".br?delivery=br-v1", "");
const TYPST_COMPILER_WASM_FALLBACK_URL = TYPST_COMPILER_WASM_URL.replace(".br?delivery=br-v1", "");
const manifest = await readFile(new URL("./fixtures/manifest.json", import.meta.url));
const avatar = await readFile(new URL("./fixtures/佳代子.png", import.meta.url));
const authored = [
  "@actor kayoko",
  "preset: ba::佳代子",
  "@end",
  "> kayoko: E2E persisted avatar message",
  ""
].join("\n");
const editedIntro = "#set page(width: 420pt, height: 260pt)\n= Welcome to MomoScript\n\nIntro persisted.\n#pagebreak()\nSecond page.\n";

test("production editor materializes an avatar and restores the authored story after reload", async ({ page }, testInfo) => {
  const local = testInfo.project.name !== "remote";
  let manifestRequests = 0;
  let avatarRequests = 0;
  let tinymistRolloutRequests = 0;
  let tinymistFallbackRequests = 0;
  let compilerRolloutRequests = 0;
  let compilerFallbackRequests = 0;
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
        if (url === TINYMIST_WASM_URL) tinymistRolloutRequests += 1;
        else compilerRolloutRequests += 1;
        await route.abort("connectionfailed");
        return;
      }
      if (url === TINYMIST_WASM_FALLBACK_URL || url === TYPST_COMPILER_WASM_FALLBACK_URL) {
        if (url === TINYMIST_WASM_FALLBACK_URL) tinymistFallbackRequests += 1;
        else compilerFallbackRequests += 1;
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
  }

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  if (local) {
    expect(tinymistRolloutRequests).toBe(1);
    expect(tinymistFallbackRequests).toBe(1);
  }
  const outputPanel = page.locator(".workbench-panel");
  const outputToggle = page.getByRole("status").getByRole("button", { name: /显示或隐藏 MomoScript 日志/ });
  const problemsToggle = page.locator("#status\\.problems").getByRole("button");
  const workbench = page.locator("#workbench");
  const editorHost = page.locator(".workbench-editor");
  if (await outputPanel.isVisible()) {
    await outputToggle.click();
    await outputToggle.click();
  }
  await expect(outputPanel).toBeHidden();
  await expect(workbench).toHaveClass(/panel-collapsed/);
  const collapsedEditorHeight = await editorHost.evaluate((element) => element.getBoundingClientRect().height);
  await outputToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^输出/ })).toHaveAttribute("aria-selected", "true");
  await expect(workbench).not.toHaveClass(/panel-collapsed/);
  const expandedEditorHeight = await editorHost.evaluate((element) => element.getBoundingClientRect().height);
  expect(collapsedEditorHeight - expandedEditorHeight).toBeGreaterThan(100);
  await expect(outputPanel).toContainText(
    /runtime:status.*"backendVersion":"0\.15\.2".*"recoveryState":"ready"/s
  );
  await expect(outputPanel).not.toContainText(/(?:Tinymist|Typst\s+编译器)\s+WASM\s+(?:100|[1-9]\d{2,})%/);
  await problemsToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^问题/ })).toHaveAttribute("aria-selected", "true");
  await problemsToggle.click();
  await expect(outputPanel).toBeHidden();
  await expect(workbench).toHaveClass(/panel-collapsed/);
  await expect.poll(async () => Math.round(await editorHost.evaluate((element) => element.getBoundingClientRect().height)))
    .toBe(Math.round(collapsedEditorHeight));
  await outputToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^输出/ })).toHaveAttribute("aria-selected", "true");
  let editor = page.locator(".workbench-editor .monaco-editor").first();
  const preview = page.locator(".workbench-preview");
  await expect(editor).toBeVisible();
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "intro.typ", languageId: "typst" });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect(page.getByRole("tab", { name: /^intro\.typ（预览）/ })).toBeVisible();
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  const buildStatus = page.getByRole("status").getByRole("button", { name: /MomoScript: ready/ });
  await expect(buildStatus).toBeVisible();
  await expect(buildStatus).toHaveAttribute("aria-label", /Tinymist 0\.15\.2 \([0-9a-f]{12}\).*position utf-16.*queued projects \d+/s);
  await expect.poll(() => page.evaluate(() => {
    const snapshot = (Reflect.get(globalThis, "__mmtRuntimeStatus") as Function)();
    return {
      backendVersion: snapshot.backendVersion,
      digestLength: snapshot.artifactDigestPrefix.length,
      positionEncoding: snapshot.positionEncoding,
      recoveryState: snapshot.recoveryState,
      queuedProjectCount: snapshot.queuedProjectCount,
    };
  })).toEqual({
    backendVersion: "0.15.2",
    digestLength: 12,
    positionEncoding: "utf-16",
    recoveryState: "ready",
    queuedProjectCount: 0,
  });
  await page.evaluate(() => (
    Reflect.get(globalThis, "__mmtRuntimeStatusFixture") as Function
  )("failed", "fixture global runtime failure"));
  const failedRuntimeStatus = page.getByRole("status").getByRole("button", { name: /MomoScript: failed/ });
  await expect(failedRuntimeStatus).toBeVisible();
  await expect(failedRuntimeStatus).toHaveAttribute("aria-label", /last runtime failure: fixture global runtime failure/);
  await failedRuntimeStatus.click();
  await page.evaluate(() => (
    Reflect.get(globalThis, "__mmtRuntimeStatusFixture") as Function
  )("ready"));
  await expect(buildStatus).toBeVisible();
  await expect(buildStatus).not.toHaveAttribute("aria-label", /fixture global runtime failure/);
  await expect(outputPanel.getByRole("tab", { name: /^问题/ })).toHaveAttribute("aria-selected", "true");
  await outputToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^输出/ })).toHaveAttribute("aria-selected", "true");
  await expect(outputPanel).toContainText(/runtime:status.*"event":"e2e-fixture".*"recoveryState":"failed".*"lastFailure":"fixture\s+global\s+runtime\s+failure"/s);
  await buildStatus.click();
  await expect(outputPanel.getByRole("tab", { name: /^问题/ })).toHaveAttribute("aria-selected", "true");
  await expect(buildStatus).toHaveAttribute("aria-label", /Click to focus Problems\./);
  await outputToggle.click();
  await expect(outputPanel.getByRole("tab", { name: /^输出/ })).toHaveAttribute("aria-selected", "true");
  const previewWebview = await previewWebviewFrame(page);
  await expect(previewWebview.locator("#workbench")).toHaveCount(0);
  if (local) {
    expect(compilerRolloutRequests).toBe(1);
    expect(compilerFallbackRequests).toBe(1);
  }
  await expect(previewWebview.locator(".viewport .page svg")).toBeAttached({ timeout: 60_000 });
  await expect(outputPanel).not.toContainText(
    /Typst\s+编译器\s+WASM.*(?:失败|failed)/i,
    { useInnerText: true }
  );
  await expect(outputPanel).not.toContainText(/(?:Tinymist|Typst\s+编译器)\s+WASM\s+(?:100|[1-9]\d{2,})%/);
  await expect(previewWebview.getByLabel("Export format")).toBeEnabled();
  await expect(previewWebview.getByRole("button", { name: "Export exact revision" })).toBeEnabled();
  await expect(previewWebview.locator(".exact-export")).toHaveAttribute("data-availability", "ready");
  const previewViewport = previewWebview.locator(".viewport");
  await previewWebview.evaluate(() => {
    Reflect.set(globalThis, "__mmtPreviewRestoreMessages", 0);
    window.addEventListener("message", (event) => {
      if (event.data?.type === "restoreViewport") {
        Reflect.set(globalThis, "__mmtPreviewRestoreMessages", Number(Reflect.get(globalThis, "__mmtPreviewRestoreMessages")) + 1);
      }
    });
  });
  await previewViewport.hover();
  await page.mouse.wheel(0, 320);
  await expect.poll(() => previewViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const wheelDownTop = await previewViewport.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(300);
  expect(Math.abs(await previewViewport.evaluate((element) => element.scrollTop) - wheelDownTop)).toBeLessThanOrEqual(1);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => previewViewport.evaluate((element) => element.scrollTop)).toBeLessThan(wheelDownTop);
  const wheelUpTop = await previewViewport.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(300);
  expect(Math.abs(await previewViewport.evaluate((element) => element.scrollTop) - wheelUpTop)).toBeLessThanOrEqual(1);
  const draggedTop = await previewViewport.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop / 2);
    return element.scrollTop;
  });
  await page.waitForTimeout(300);
  expect(Math.abs(await previewViewport.evaluate((element) => element.scrollTop) - draggedTop)).toBeLessThanOrEqual(1);
  expect(await previewWebview.evaluate(() => Number(Reflect.get(globalThis, "__mmtPreviewRestoreMessages")))).toBe(0);
  await page.evaluate(() => (Reflect.get(globalThis, "__mmtShowWorkspaceDocument") as Function)("intro.typ"));
  await expect.poll(() => activeDocument(page)).toMatchObject({ name: "intro.typ", languageId: "typst" });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect(page.getByRole("tab", { name: /^intro\.typ（预览）/ })).toHaveAttribute("aria-selected", "true");
  const initialTypstPreview = await previewWebviewFrame(page);
  await expect(initialTypstPreview.locator(".typst-page").first()).toBeAttached();
  await page.evaluate(({ name, text }) => (Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function)(name, text), {
    name: "intro.typ",
    text: editedIntro
  });
  await expect.poll(() => readWorkspaceDocument(page, "intro.typ")).toBe(editedIntro);
  await expect(buildStatus).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate((name) => (
    Reflect.get(globalThis, "__mmtTypstBackendProject") as Function
  )(name)?.text, "intro.typ")).toBe(editedIntro);
  const updatedTypstPreview = await previewWebviewFrame(page);
  await expect(updatedTypstPreview.getByText("Intro persisted.", { exact: true })).toBeAttached();
  await expect(updatedTypstPreview.locator(".typst-page > [data-preview-page-background]")).toHaveCount(2);
  await expect(updatedTypstPreview.locator(".page svg > [data-preview-page-background]")).toHaveCount(0);
  const previewPageGap = await updatedTypstPreview.locator(".page svg > .typst-page").evaluateAll((pages) => {
    if (pages.length !== 2) return Number.NaN;
    const top = (page: Element) => Number(/translate\(\s*[-+]?\d*\.?\d+\s*[, ]\s*([-+]?\d*\.?\d+)\s*\)/.exec(page.getAttribute("transform") ?? "")?.[1]);
    return top(pages[1]!) - top(pages[0]!) - Number((pages[0] as SVGElement).dataset.pageHeight);
  });
  expect(previewPageGap).toBeGreaterThan(0);
  const typBlockSource = "@typ\n#let accent = rgb(\"#24324a\")\n#let values = range(1, 3, inclusive: true)\n#if values.len() != 3 { panic(\"Typst 0.15 inclusive range is unavailable\") }\n#let a=1\n#a\n@end";
  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtOpenWorkspaceDocument") as Function
  )(name, text), {
    name: "projection-race.mmt",
    text: typBlockSource
  });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => displayedPreviewSource(page)).toMatch(/projection-race\.mmt$/);
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  const typBlockPreview = await previewWebviewFrame(page);
  await expect(typBlockPreview.locator("body")).not.toContainText(/无法为|未能及时同步/);
  await expect(typBlockPreview.locator(".viewport .page svg")).toBeAttached();
  const typBlockProjection = await page.evaluate(async (name) => {
    const getEntry = Reflect.get(globalThis, "__mmtLanguageProjectionEntry");
    if (typeof getEntry !== "function") throw new Error("missing E2E language projection hook");
    return getEntry(name) as Promise<{ sourceVersion: number; text?: string } | null>;
  }, "projection-race.mmt");
  expect(typBlockProjection?.sourceVersion).toBeGreaterThanOrEqual(1);
  expect(typBlockProjection?.text).toContain("#let accent = rgb(\"#24324a\")");
  expect(typBlockProjection?.text).toContain("#let a=1");
  expect(typBlockProjection?.text).toContain("#a");
  expect(typBlockProjection?.text).toContain("#let values = range(1, 3, inclusive: true)");
  expect(typBlockProjection?.text).toContain("Typst 0.15 inclusive range is unavailable");
  await page.evaluate(({ name, text }) => (
    Reflect.get(globalThis, "__mmtReplaceWorkspaceDocument") as Function
  )(name, text), {
    name: "projection-race.mmt",
    text: "@typ\n#sym.\n@end"
  });
  await expect.poll(() => activeDocument(page)).toMatchObject({
    name: "projection-race.mmt",
    text: "@typ\n#sym.\n@end"
  });
  await expect.poll(() => page.evaluate(async ({ name, line, character, triggerCharacter }) => {
    const completionLabels = Reflect.get(globalThis, "__mmtCompletionLabels");
    if (typeof completionLabels !== "function") throw new Error("missing E2E completion hook");
    return completionLabels(line, character, triggerCharacter, name);
  }, {
    name: "projection-race.mmt",
    line: 1,
    character: "#sym.".length,
    triggerCharacter: "."
  })).toEqual(expect.arrayContaining(["AA", "acute", "alpha"]));
  const projectionEditor = page.locator('[role="code"][data-uri="mmtfs://workspace/projection-race.mmt"]');
  await projectionEditor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("@typ\n#sym.\n@end");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+Space");
  const completionWidget = page.locator(".suggest-widget.visible");
  await expect(completionWidget).toBeVisible();
  await expect(completionWidget.getByRole("listitem", { name: /^alpha，/ })).toBeVisible();
  await page.keyboard.press("Escape");
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
  await page.getByRole("treeitem", { name: "workspace-image.png", exact: true }).click();
  await expect.poll(() => page.frames().length).toBeGreaterThan(2);
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      const dimensions = await frame.locator("img").evaluateAll((images) => images.map((image) => ({
        complete: (image as HTMLImageElement).complete,
        width: (image as HTMLImageElement).naturalWidth,
        height: (image as HTMLImageElement).naturalHeight,
      })));
      if (dimensions.some(({ complete, width, height }) => complete && width > 0 && height > 0)) return true;
    }
    return false;
  }).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(".quick-input-widget")).toBeVisible();
  await page.setViewportSize({ width: 1240, height: 943 });
  await expect.poll(() => page.locator(".workbench-primary").evaluate((element) => element.getBoundingClientRect().right)).toBe(1240);
  await expect.poll(() => page.locator(".workbench-editor").evaluate((element) => element.getBoundingClientRect().right)).toBe(1240);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: /^workspace-image\.png/ }).getByRole("button", { name: /^关闭/ }).click();
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
  const historyActivity = page.getByRole("tab", { name: "本地历史", exact: true });
  await expect(explorerActivity).toBeVisible();
  await expect(explorerActivity).toHaveAttribute("aria-selected", "true");
  await explorerActivity.click();
  await expect(page.locator("#workbench")).toHaveClass(/sidebar-collapsed/);
  await explorerActivity.click();
  await expect(page.locator("#workbench")).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole("tree", { name: "文件资源管理器" })).toBeVisible();
  await explorerActivity.click();
  await expect(page.locator("#workbench")).toHaveClass(/sidebar-collapsed/);
  await historyActivity.click();
  await expect(page.locator("#workbench")).not.toHaveClass(/sidebar-collapsed/);
  const localHistory = page.getByRole("tree", { name: "本地历史版本" });
  await expect(localHistory).toBeVisible();
  await expect(page.getByRole("combobox", { name: "本地历史范围" })).toBeVisible();
  await expect(page.getByRole("button", { name: /默认保留 30 天/ })).toBeVisible();
  await expect(historyActivity).toHaveAttribute("aria-selected", "true");
  await mmsActivity.click();
  await expect(page.getByRole("textbox", { name: "资源包清单地址" })).toBeVisible();
  await expect(mmsActivity).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "资源包清单地址" })).toHaveValue(MANIFEST_URL);
  await expect(page.getByText("入口文件", { exact: true })).toHaveCount(0);
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
  const defaultEol = await page.evaluate(() => (Reflect.get(globalThis, "__mmtDefaultEol") as Function)());
  expect(defaultEol).toBe("\n");
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
  const staleBuildStatus = page.getByRole("status").getByRole("button", { name: /MomoScript: stale/ });
  await expect(staleBuildStatus).toBeVisible();
  await expect(staleBuildStatus).toHaveAttribute("aria-label", /Preview stale/);
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
  const authoredRenderKey = await preview.getAttribute("data-preview-render-key");
  expect(authoredRenderKey).toBeTruthy();
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
  await expect(preview).toHaveAttribute("data-preview-render-key", authoredRenderKey!);
  await expect(preview.locator("svg image").first()).toBeAttached();
  await seedLegacyWorkspace(page, false);
  await expect.poll(() => workspaceEntryExists(page, "/workspace")).toBe(true);

  const secondAsset = page.waitForResponse((response) => isPackAsset(response));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
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

test("VS Code native sashes resize the explorer and panel in both directions", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");

  const dragSash = async (sash: Locator, deltaX: number, deltaY: number) => {
    const box = await sash.boundingBox();
    expect(box, "VS Code layout sash is missing").not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + deltaX, y + deltaY, { steps: 8 });
    await page.mouse.up();
  };

  const sidebar = page.locator(".workbench-sidebar");
  const sidebarSash = page.locator(
    ".workbench-primary > .monaco-split-view2.horizontal > .sash-container > .monaco-sash"
  ).first();
  const initialSidebarWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
  await dragSash(sidebarSash, 80, 0);
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(initialSidebarWidth + 60);
  const expandedSidebarWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
  await dragSash(sidebarSash, -80, 0);
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThan(expandedSidebarWidth - 60);

  const panel = page.locator(".workbench-panel");
  const outputToggle = page.getByRole("status").getByRole("button", { name: /显示或隐藏 MomoScript 日志/ });
  if (!(await panel.isVisible())) await outputToggle.click();
  await expect(panel).toBeVisible();
  const panelSash = page.locator(
    ".workbench-main > .monaco-split-view2.vertical > .sash-container > .monaco-sash"
  ).first();
  const initialPanelHeight = await panel.evaluate((element) => element.getBoundingClientRect().height);
  await dragSash(panelSash, 0, -60);
  await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(initialPanelHeight + 40);
  const expandedPanelHeight = await panel.evaluate((element) => element.getBoundingClientRect().height);
  await dragSash(panelSash, 0, 60);
  await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(expandedPanelHeight - 40);
});
async function activeDocument(page: Page): Promise<{ name: string; languageId: string; text: string } | null> {
  return page.evaluate(() => (Reflect.get(globalThis, "__mmtActiveDocument") as Function)());
}

async function renderedWebviewHasVisibleIntrinsicPage(page: Page): Promise<boolean> {
  const frames = page.frames().filter((candidate) => candidate.url().includes("/fake-") && candidate.url().includes(".html"));
  for (const frame of frames.toReversed()) {
    try {
      const visible = await frame.evaluate(() => {
        const pageElement = document.querySelector<HTMLElement>(".page[data-intrinsic-width][data-intrinsic-height]");
        const svg = pageElement?.querySelector<SVGElement>("svg[aria-label='Rendered MomoScript preview']");
        if (!pageElement || !svg) return false;
        const pageRect = pageElement.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();
        const intrinsicWidth = Number(pageElement.dataset.intrinsicWidth);
        const intrinsicHeight = Number(pageElement.dataset.intrinsicHeight);
        const widthScale = pageRect.width / intrinsicWidth;
        const heightScale = pageRect.height / intrinsicHeight;
        return pageRect.width > 0
          && pageRect.height > 0
          && Number.isFinite(widthScale)
          && Number.isFinite(heightScale)
          && Math.abs(widthScale - heightScale) < 0.01
          && Math.abs(svgRect.width - pageRect.width) < 1
          && Math.abs(svgRect.height - pageRect.height) < 1;
      });
      if (visible) return true;
    } catch {
      // Preview HTML replacement detaches the previous frame; inspect the next live frame.
    }
  }
  return false;
}

async function visiblePreviewText(page: Page): Promise<string> {
  const frames = page.frames().filter((candidate) => candidate.url().includes("/fake-") && candidate.url().includes(".html"));
  for (const frame of frames.toReversed()) {
    try {
      const result = await frame.evaluate(() => {
        const pageElement = document.querySelector<HTMLElement>(".page[data-intrinsic-width]");
        return pageElement && pageElement.getBoundingClientRect().width > 0 ? pageElement.textContent ?? "" : "";
      });
      if (result) return result;
    } catch {
      // Preview webviews are replaced atomically; ignore frames detached during the swap.
    }
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
      const request = indexedDB.open("momoscript-workspace-v1");
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
      const request = indexedDB.open("momoscript-workspace-v1");
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
      const request = indexedDB.open("momoscript-workspace-v1");
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
