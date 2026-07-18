import { expect, test, type Download, type Frame, type Page } from "@playwright/test";

const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454/tinymist_bg.wasm?delivery=zstd-v1";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.7.0-rc2/acac51459fa84907843d7a1927ae7b6fc5c743d5de4f61473c866829c9c46e2d/typst_ts_web_compiler_bg.wasm?delivery=zstd-v1";

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
  await expect(preview.locator(".page")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const background = preview.locator(".page > svg > rect[data-preview-page-background='true']");
  await expect(background).toHaveCount(1);
  await expect(background).toHaveAttribute("fill", "white");

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
