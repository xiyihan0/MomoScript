import { expect, invokeMmtE2E, test, type Download, type Page, waitForPreviewFrame } from "./fixtures";

const mmtSource = [
  "@typ",
  "#set page(width: 260pt, height: 140pt)",
  "= MMT browser export",
  "",
  "Current preview PDF",
  "@end",
  "",
].join("\n");

test("standalone Monaco exports solid Typst SVG and MMT PDF without the exact-export fixture", { tag: "@runtime-export" }, async ({ page }) => {

  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  await page.getByRole("button", { name: "Typst 预览" }).click();

  let preview = await waitForPreviewFrame(page);
  const controls = preview.getByLabel("Current preview export");
  await expect(controls).toHaveAttribute("data-mode", "current-preview");
  await expect(controls).toHaveAttribute("data-availability", "ready");
  await expect(preview.getByLabel("Export format")).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Export current preview" })).toBeEnabled();
  const rendererState = await invokeMmtE2E(page, "preview", "interactionFixture", { action: "state" });
  expect(rendererState).toMatchObject({ visualKind: "renderer", rendererFrameKind: "new" });
  await expect(preview.locator(".page")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const renderedPages = preview.locator(".page > svg > .typst-page");
  const renderedPageCount = await renderedPages.count();
  expect(renderedPageCount).toBeGreaterThan(0);
  const backgrounds = preview.locator(".page > svg > .typst-page > rect[data-preview-page-background='true']");
  await expect(backgrounds).toHaveCount(renderedPageCount);
  expect(await backgrounds.evaluateAll((elements) => elements.map((element) => element.getAttribute("fill"))))
    .toEqual(Array(renderedPageCount).fill("white"));

  await preview.getByLabel("Export format").selectOption("svg");
  const svgDownload = await clickForDownload(
    page,
    preview.getByRole("button", { name: "Export current preview" }).click(),
  );
  expect(svgDownload.suggestedFilename()).toBe("intro.svg");
  const svg = await downloadBytes(svgDownload);
  const svgText = svg.toString("utf8");
  expect(svgText).toContain('data-preview-page-background="true"');
  expect(svgText).not.toContain("foreignObject");
  await expect(preview.getByRole("status")).toContainText("Exported current preview");

  await invokeMmtE2E(page, "workspace", "openDocument", "browser-export.mmt", mmtSource);
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => invokeMmtE2E(page, "preview", "displayedSourceUri"))
    .toMatch(/browser-export\.mmt$/);

  preview = await waitForPreviewFrame(page);
  await expect(preview.getByLabel("Current preview export")).toHaveAttribute("data-availability", "ready");
  await preview.getByLabel("Export format").selectOption("pdf");
  const pdfDownload = await clickForDownload(
    page,
    preview.getByRole("button", { name: "Export current preview" }).click(),
  );
  expect(pdfDownload.suggestedFilename()).toBe("browser-export.pdf");
  const pdf = await downloadBytes(pdfDownload);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(pdf.byteLength).toBeGreaterThan(500);
  await expect(preview.getByRole("status")).toContainText("Exported current preview");
});


async function clickForDownload(page: Page, click: Promise<void>): Promise<Download> {
  const download = page.waitForEvent("download");
  await click;
  return await download;
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
