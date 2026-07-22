import { expect, test, type Download, type Frame, type Page } from "./fixtures";

const TINYMIST_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/2dbe1a96f28dee1c580801f760855fffa7644ff30f368d6fc56124177291265d/tinymist_bg.wasm.br?delivery=br-v1";
const TYPST_COMPILER_WASM_URL = "https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/0.8.0-rc3/fff6c8d9852edbfb0374722c139a95a2307de19a666206936232e5f21035836c/typst_ts_web_compiler_bg.wasm.br?delivery=br-v1";

interface ExactExportState {
  readonly availability: "no-document" | "capability-unavailable" | "ready" | "stale" | "partial" | "failed" | "evicted";
  readonly phase: "idle" | "exporting" | "waiting" | "complete" | "cancelled" | "error";
  readonly message: string;
}

test("stale exact export requires an explicit displayed or wait-latest choice", async ({ page }) => {
  await page.route("https://**/*", async (route) => {
    const url = route.request().url();
    if (url === TINYMIST_WASM_URL || url === TYPST_COMPILER_WASM_URL) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, "__mmtDisplayedPreviewSourceUri")?.())).not.toBeUndefined();

  await callFixture(page, { action: "install", marker: "partial-source" });
  let preview = await exactExportFrame(page);
  await expect(preview.getByLabel("Export format")).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Export exact revision" })).toBeEnabled();
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "ready");
  await preview.getByLabel("Export format").selectOption("svg");
  await expect(preview.getByLabel("Export format")).toHaveValue("svg");

  await callFixture(page, { action: "partial", marker: "partial-pending" });
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "partial");
  await expect(preview.getByLabel("Export format")).toBeDisabled();
  await expect(preview.getByRole("status")).toContainText("partial or rendering");

  await callFixture(page, { action: "install", marker: "failed-source" });
  preview = await exactExportFrame(page);
  await callFixture(page, { action: "failed", marker: "failed-pending" });
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "failed");
  await expect(preview.getByRole("status")).toContainText("preview render failed");
  await expect(preview.getByRole("button", { name: "Export exact revision" })).toBeHidden();

  await callFixture(page, { action: "install", marker: "evicted-source" });
  preview = await exactExportFrame(page);
  await callFixture(page, { action: "evicted", marker: "evicted" });
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "evicted");
  await expect(preview.getByRole("status")).toContainText("evicted");
  await expect(preview.getByLabel("Export format")).toBeDisabled();

  await callFixture(page, { action: "install", marker: "A" });
  preview = await exactExportFrame(page);
  await preview.getByLabel("Export format").selectOption("svg");
  await callFixture(page, { action: "advance", marker: "B" });
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "stale");
  await expect(preview.getByRole("button", { name: "Export displayed revision" })).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Wait for latest" })).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Export exact revision" })).toBeHidden();

  const displayedDownload = await clickForDownload(
    page,
    preview.getByRole("button", { name: "Export displayed revision" }).click(),
  );
  expect(displayedDownload.suggestedFilename()).toBe("intro.svg");
  expect(await downloadText(displayedDownload)).toContain("Exact export A");
  await expect(preview.getByRole("status")).toContainText("Exported displayed exact revision");
  expect((await fixtureState(page)).availability).toBe("stale");

  await preview.getByRole("button", { name: "Wait for latest" }).click();
  await expect(preview.getByRole("button", { name: "Cancel export" })).toBeEnabled();
  await expect(preview.getByRole("status")).toContainText("Waiting for latest exact artifact");
  await preview.getByRole("button", { name: "Cancel export" }).click();
  await expect(preview.getByRole("status")).toContainText("Exact export cancelled");
  await expect(preview.getByRole("button", { name: "Wait for latest" })).toBeEnabled();
  expect((await fixtureState(page)).phase).toBe("cancelled");

  const latestDownloadPromise = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Wait for latest" }).click();
  await expect(preview.getByRole("status")).toContainText("Waiting for latest exact artifact");
  await callFixture(page, { action: "publish-latest" });
  const latestDownload = await latestDownloadPromise;
  expect(await downloadText(latestDownload)).toContain("Exact export B");
  preview = await exactExportFrame(page);
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "ready");
  await expect(preview.getByRole("status")).toContainText("Exported latest exact revision");
  await expect(preview.getByRole("button", { name: "Export exact revision" })).toBeEnabled();
});

async function callFixture(page: Page, request: Record<string, unknown>): Promise<unknown> {
  return await page.evaluate(async (value) => {
    const fixture = Reflect.get(globalThis, "__mmtExactExportFixture");
    if (typeof fixture !== "function") throw new Error("exact export fixture is unavailable");
    return await fixture(value);
  }, request);
}

async function fixtureState(page: Page): Promise<ExactExportState> {
  return await callFixture(page, { action: "state" }) as ExactExportState;
}

async function exactExportFrame(page: Page): Promise<Frame> {
  let previewFrame: Frame | undefined;
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator(".exact-export").count() > 0) {
          previewFrame = frame;
          return true;
        }
      } catch {
        // VS Code replaces the Webview iframe whenever the displayed artifact changes.
      }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  if (!previewFrame) throw new Error("exact export Webview frame is missing");
  return previewFrame;
}

async function clickForDownload(page: Page, click: Promise<void>): Promise<Download> {
  const download = page.waitForEvent("download");
  await click;
  return await download;
}

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
