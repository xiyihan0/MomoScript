import { expect, test, type Download, type Frame, type Page } from "./fixtures";

const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/2dbe1a96f28dee1c580801f760855fffa7644ff30f368d6fc56124177291265d/tinymist_bg.wasm.br?delivery=br-v1";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.8.0-rc3/fff6c8d9852edbfb0374722c139a95a2307de19a666206936232e5f21035836c/typst_ts_web_compiler_bg.wasm.br?delivery=br-v1";

const mmtSource = [
  "@typ",
  "#set page(width: 260pt, height: 140pt)",
  "= MMT browser export",
  "",
  "Current preview PDF",
  "@end",
  "",
].join("\n");

test("standalone Monaco exports solid Typst SVG and MMT PDF without the exact-export fixture", async ({ page }) => {
  await page.route("https://**/*", async (route) => {
    const url = route.request().url();
    if (url === TINYMIST_WASM_URL || url === TYPST_COMPILER_WASM_URL) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });

  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "Typst 预览" }).click();

  let preview = await currentPreviewExportFrame(page);
  const controls = preview.getByLabel("Current preview export");
  await expect(controls).toHaveAttribute("data-mode", "current-preview");
  await expect(controls).toHaveAttribute("data-availability", "ready");
  await expect(preview.getByLabel("Export format")).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Export current preview" })).toBeEnabled();
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

  await page.evaluate(({ name, text }) => {
    const open = Reflect.get(globalThis, "__mmtOpenWorkspaceDocument");
    if (typeof open !== "function") throw new Error("workspace document fixture is unavailable");
    return open(name, text);
  }, { name: "browser-export.mmt", text: mmtSource });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, "__mmtDisplayedPreviewSourceUri")?.()))
    .toMatch(/browser-export\.mmt$/);

  preview = await currentPreviewExportFrame(page);
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

async function currentPreviewExportFrame(page: Page): Promise<Frame> {
  let previewFrame: Frame | undefined;
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator('.exact-export[data-mode="current-preview"]').count() > 0) {
          previewFrame = frame;
          return true;
        }
      } catch {
        // The Monaco Webview iframe is replaced whenever a new artifact is displayed.
      }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  if (!previewFrame) throw new Error("current preview export Webview frame is missing");
  return previewFrame;
}

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
