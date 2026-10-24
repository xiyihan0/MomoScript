import { expect, invokeMmtE2E, test, type Page, waitForComposerFrame, waitForPreviewFrame } from "./fixtures";
import {
  attachOutputManifest,
  captureAcceptedOutput,
  expectPdfPages,
  inspectOutputRaster,
  inspectOutputSvg,
  saveOutputDownload,
} from "./output-artifacts";

const mmtSource = [
  "@typ",
  "#set page(width: 260pt, height: 140pt)",
  "= MMT browser export",
  "",
  "Current preview PDF",
  "@end",
  "",
].join("\n");

const guiSurface = (page: Page) => page.getByRole("region", { name: "MomoScript GUI 创作" });

test("native advanced export preserves real Typst SVG and accepted MMT PDF snapshots", { tag: "@runtime-export" }, async ({ page }, testInfo) => {
  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  // Fresh product entry is chat, not the native introduction document.
  await invokeMmtE2E(page, "workspace", "showDocument", "intro.typ");
  await page.getByRole("button", { name: "Typst 预览" }).click();

  let preview = await waitForPreviewFrame(page, "mmtfs://workspace/intro.typ");
  const controls = preview.getByLabel("Current preview export");
  await expect(controls).toHaveAttribute("data-mode", "current-preview");
  await expect(controls).toHaveAttribute("data-availability", "ready");
  await expect(preview.getByLabel("Export format")).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Export current preview" })).toBeEnabled();
  const rendererState = await invokeMmtE2E(page, "preview", "interactionFixture", { action: "state" });
  expect(rendererState).toMatchObject({ visualKind: "renderer", rendererFrameKind: "new" });
  await expect(preview.locator(".page")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const renderedPageCount = await preview.locator(".page > svg > .typst-page").count();
  expect(renderedPageCount).toBeGreaterThan(0);
  const backgrounds = preview.locator(".page > svg > .typst-page > rect[data-preview-page-background='true']");
  await expect(backgrounds).toHaveCount(renderedPageCount);
  expect(await backgrounds.evaluateAll((elements) => elements.map((element) => element.getAttribute("fill"))))
    .toEqual(Array(renderedPageCount).fill("white"));
  const introOutput = await captureAcceptedOutput(preview);
  await preview.getByLabel("Export format").selectOption("svg");
  await preview.getByLabel("Export page", { exact: true }).selectOption("0");
  const svgEvent = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Export current preview" }).click();
  const svgDownload = await svgEvent;
  expect(svgDownload.suggestedFilename()).toBe("intro-page-1.svg");
  const svg = await saveOutputDownload(svgDownload, testInfo, "native-current-preview");
  expect(svg.toString("utf8")).toContain('data-preview-page-background="true"');
  await inspectOutputSvg(page, svg, introOutput.pages[0]!, testInfo, "native-current-preview");

  await invokeMmtE2E(page, "workspace", "openDocument", "browser-export.mmt", mmtSource);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  preview = await waitForPreviewFrame(page, "mmtfs://workspace/browser-export.mmt");
  await expect(preview.locator("body")).toHaveAttribute("data-presentation", "layout");
  await expect(preview.getByLabel("Current preview export")).toHaveAttribute("data-availability", "ready");
  await expect(preview.getByRole("button", { name: "Export current preview", exact: true })).toBeHidden();
  await preview.getByText("高级：导出已接受排版快照", { exact: true }).click();
  const output = await captureAcceptedOutput(preview);
  await preview.getByLabel("Export format").selectOption("pdf");
  const pdfEvent = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Export current preview" }).click();
  const pdfDownload = await pdfEvent;
  expect(pdfDownload.suggestedFilename()).toBe("browser-export.pdf");
  expectPdfPages(await saveOutputDownload(pdfDownload, testInfo, "native-current-preview"), output.pages);
  expect(await invokeMmtE2E(page, "workspace", "canonicalText", "browser-export.mmt")).toBe(mmtSource);
  await testInfo.attach("native-accepted-output-export", { body: await page.screenshot(), contentType: "image/png" });
});

test("product export selects an actual output page for SVG, PNG and JPG while PDF contains every page", {
  tag: ["@runtime-export", "@editor-runtime", "@gui-composer"],
}, async ({ page }, testInfo) => {
  const name = "two-output-pages.mmt";
  const source = [
    // Without this existing document setting, the template header precedes
    // #set page and becomes a separate, short page of its own.
    "@document", "title: Two output pages", "show-header: false", "@end",
    "@typ", "#set page(width: 320pt, height: 240pt, margin: 12pt)",
    '#rect(width: 48pt, height: 28pt, fill: rgb("#1b7d9c"), stroke: none)', "@end",
    "- FIRST OUTPUT PAGE",
    "@typ", "#pagebreak()",
    '#rect(width: 48pt, height: 28pt, fill: rgb("#d94887"), stroke: none)', "@end",
    "- SECOND OUTPUT PAGE", "",
  ].join("\n");
  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await invokeMmtE2E(page, "composer", "openGui", name);
  let frame = await waitForComposerFrame(page, name);
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "chat");
  await expect(frame.locator(".preview-toolbar")).toBeHidden();
  await guiSurface(page).getByRole("button", { name: "导出作品", exact: true }).click();
  const panel = guiSurface(page).getByRole("dialog", { name: "导出作品", exact: true });
  await expect(panel).toBeVisible();
  frame = await waitForComposerFrame(page, name);
  await expect(frame.locator("body")).toHaveAttribute("data-presentation", "layout");
  // The modal intentionally unmounts the interactive canvas. Inspect the
  // visible layout, then reopen the already-ready export Sheet.
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  const output = await captureAcceptedOutput(frame);
  expect(output.pages).toHaveLength(2);
  expect(output.pages.map((outputPage) => outputPage.content.map((entry) => entry.text))).toEqual([
    ["FIRST OUTPUT PAGE"], ["SECOND OUTPUT PAGE"],
  ]);
  await guiSurface(page).getByRole("button", { name: "导出作品", exact: true }).click();
  await expect(panel).toBeVisible();
  const evidence = "product-selected-output-page";
  await attachOutputManifest(testInfo, evidence, { ...output, source });
  const format = panel.getByRole("combobox", { name: "导出格式", exact: true });
  await expect(format).toHaveValue("pdf");
  await expect(panel.getByRole("combobox", { name: "输出页", exact: true })).toBeHidden();
  const pdfEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载 PDF", exact: true }).click();
  const pdf = await pdfEvent;
  expect(pdf.suggestedFilename()).toBe("two-output-pages.pdf");
  expectPdfPages(await saveOutputDownload(pdf, testInfo, evidence), output.pages);

  await format.selectOption("svg");
  const outputPage = panel.getByRole("combobox", { name: "输出页", exact: true });
  expect(await outputPage.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(["0", "1"]);
  await outputPage.selectOption("1");
  const svgEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载 SVG", exact: true }).click();
  const svgDownload = await svgEvent;
  expect(svgDownload.suggestedFilename()).toBe("two-output-pages-page-2.svg");
  const reference = await inspectOutputSvg(page, await saveOutputDownload(svgDownload, testInfo, evidence), output.pages[1]!, testInfo, evidence);
  await expect(outputPage).toHaveValue("1");
  for (const imageFormat of ["png", "jpg"] as const) {
    await format.selectOption(imageFormat);
    await expect(outputPage).toHaveValue("1");
    await expect(panel).toContainText(`图片尺寸：${reference.width} × ${reference.height} px（2×）`);
    const imageEvent = page.waitForEvent("download");
    await panel.getByRole("button", { name: `下载 ${imageFormat.toUpperCase()}`, exact: true }).click();
    const imageDownload = await imageEvent;
    expect(imageDownload.suggestedFilename()).toBe(`two-output-pages-page-2.${imageFormat}`);
    await inspectOutputRaster(page, await saveOutputDownload(imageDownload, testInfo, evidence), imageFormat, reference, testInfo, evidence);
  }
  await expect.poll(() => invokeMmtE2E(page, "exactExport", "fixture", { action: "state" })).toMatchObject({
    phase: "complete", completedRenderKey: output.renderKey, completedPageIndex: 1, completedPageCount: 2,
  });
  expect(await invokeMmtE2E(page, "workspace", "canonicalText", name)).toBe(source);
  await testInfo.attach("product-selected-second-output-page", { body: await page.screenshot(), contentType: "image/png" });
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await guiSurface(page).getByRole("button", { name: "排版设置", exact: true }).click();
  const settings = guiSurface(page).getByRole("dialog", { name: "排版设置", exact: true });
  const pageSizes = settings.getByRole("list", { name: "输出页面尺寸", exact: true }).getByRole("listitem");
  await expect(pageSizes).toHaveCount(output.pages.length);
  for (const outputPage of output.pages) {
    await expect(pageSizes.nth(outputPage.index)).toContainText(`${outputPage.width} × ${outputPage.height}`);
  }
  await expect(settings.getByRole("heading", { name: "已加载字体资源", exact: true })).toBeVisible();
  await testInfo.attach("real-output-geometry-and-font-resource-settings", { body: await page.screenshot(), contentType: "image/png" });
  await settings.getByRole("button", { name: "高级排版（源码）", exact: true }).click();
  await expect(page.locator(".workbench-editor .monaco-editor").first()).toBeVisible();
  await page.keyboard.press("Control+Shift+p");
  const command = page.locator(".quick-input-widget input").first();
  await expect(command).toBeVisible();
  await command.fill(">下载源文件");
  const sourceEvent = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const sourceDownload = await sourceEvent;
  expect(sourceDownload.suggestedFilename()).toBe(name);
  expect((await saveOutputDownload(sourceDownload, testInfo, evidence)).toString("utf8")).toBe(source);
  await page.keyboard.press("Control+Shift+p");
  await expect(command).toBeVisible();
  await command.fill(">导出作品");
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(format).toHaveValue("pdf");
  frame = await waitForComposerFrame(page, name);
  await testInfo.attach("native-source-command-opens-shared-export-panel", { body: await page.screenshot(), contentType: "image/png" });
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  const reopenedOutput = await captureAcceptedOutput(frame);
  const pageIdentity = (outputPage: typeof output.pages[number]) => ({
    width: outputPage.width, height: outputPage.height, imageCount: outputPage.imageCount,
    content: outputPage.content.map(({ label, glyphs, images }) => ({ label, glyphs, images })),
  });
  expect(reopenedOutput.pages.map(pageIdentity)).toEqual(output.pages.map(pageIdentity));
  expect(await invokeMmtE2E(page, "workspace", "canonicalText", name)).toBe(source);
});

test("an actual failed latest Typst compile cannot silently download its older accepted output and can be corrected in Source", {
  tag: "@runtime-export",
}, async ({ page }, testInfo) => {
  const name = "failed-latest-output.typ";
  const valid = "#set page(width: 240pt, height: 180pt, margin: 12pt)\nAccepted before failure";
  const invalid = `${valid}\n#this_export_failure_is_undefined()`;
  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  await invokeMmtE2E(page, "workspace", "openDocument", name, valid);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const preview = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await invokeMmtE2E(page, "workspace", "showDocument", name);
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(invalid);
  await expect.poll(() => invokeMmtE2E(page, "workspace", "canonicalText", name)).toBe(invalid);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect(preview.getByLabel("Current preview export")).toHaveAttribute("data-availability", "failed");
  await expect(preview.getByLabel("Export format")).toBeDisabled();
  await expect(preview.getByRole("button", { name: "Export current preview", exact: true })).toBeHidden();
  await expect(preview.getByRole("button", { name: "Export displayed revision", exact: true })).toBeHidden();
  expect(downloads).toEqual([]);
  await testInfo.attach("real-compile-failure-no-download", { body: await page.screenshot(), contentType: "image/png" });

  await invokeMmtE2E(page, "workspace", "showDocument", name);
  await editor.click();
  await page.keyboard.press("Control+a");
  const corrected = valid.replace("Accepted before failure", "Corrected final output");
  await page.keyboard.insertText(corrected);
  await expect.poll(() => invokeMmtE2E(page, "workspace", "canonicalText", name)).toBe(corrected);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  const recovered = await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  await expect(recovered.getByLabel("Current preview export")).toHaveAttribute("data-availability", "ready");
  const output = await captureAcceptedOutput(recovered);
  await recovered.getByLabel("Export format").selectOption("pdf");
  const downloadEvent = page.waitForEvent("download");
  await recovered.getByRole("button", { name: "Export current preview", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("failed-latest-output.pdf");
  expectPdfPages(await saveOutputDownload(download, testInfo, "real-compile-failure-recovered"), output.pages);
  expect(downloads).toEqual(["failed-latest-output.pdf"]);
  await testInfo.attach("real-compile-failure-corrected-source", { body: await page.screenshot(), contentType: "image/png" });
});
