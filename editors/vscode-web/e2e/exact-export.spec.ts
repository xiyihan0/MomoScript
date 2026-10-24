import { expect, invokeMmtE2E, test, type Download, type Page, waitForPreviewFrame } from "./fixtures";
import type { ExactExportFixtureRequest } from "../src/e2eRuntimeBridge.ts";

interface ExactExportState {
  readonly availability: "no-document" | "capability-unavailable" | "ready" | "stale" | "partial" | "failed" | "evicted";
  readonly phase: "idle" | "exporting" | "waiting" | "complete" | "cancelled" | "error";
  readonly message: string;
}

test("advanced exact export blocks incomplete outputs and requires an explicit stale, wait or cancel choice", { tag: "@runtime-export" }, async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  // Fresh product entry is chat; this is explicitly the native advanced workflow.
  await invokeMmtE2E(page, "workspace", "showDocument", "intro.typ");
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect.poll(() => invokeMmtE2E(page, "preview", "displayedSourceUri")).not.toBeUndefined();

  await callFixture(page, { action: "install", marker: "partial-source" });
  let preview = await waitForPreviewFrame(page);
  await expect(preview.getByLabel("Export format")).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Export exact revision" })).toBeEnabled();
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "ready");
  await preview.getByLabel("Export format").selectOption("svg");
  await expect(preview.getByLabel("Export format")).toHaveValue("svg");
  await expect(preview.getByLabel("Export page", { exact: true })).toHaveValue("0");

  await callFixture(page, { action: "partial", marker: "partial-pending" });
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "partial");
  await expect(preview.getByLabel("Export format")).toBeDisabled();

  await callFixture(page, { action: "install", marker: "failed-source" });
  preview = await waitForPreviewFrame(page);
  await callFixture(page, { action: "failed", marker: "failed-pending" });
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "failed");
  await expect(preview.getByRole("button", { name: "Export exact revision" })).toBeHidden();

  await callFixture(page, { action: "install", marker: "evicted-source" });
  preview = await waitForPreviewFrame(page);
  await callFixture(page, { action: "evicted", marker: "evicted" });
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "evicted");
  await expect(preview.getByLabel("Export format")).toBeDisabled();
  expect(downloads).toEqual([]);

  await callFixture(page, { action: "install", marker: "A" });
  preview = await waitForPreviewFrame(page);
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
  expect(displayedDownload.suggestedFilename()).toBe("intro-snapshot-page-1.svg");
  expect(await downloadText(displayedDownload)).toContain("Exact export A");
  expect((await fixtureState(page)).availability).toBe("stale");
  await expect(preview.locator(".exact-export")).toContainText("intro-snapshot-page-1.svg");

  await preview.getByRole("button", { name: "Wait for latest" }).click();
  await expect(preview.getByRole("button", { name: "Cancel export" })).toBeEnabled();
  await preview.getByRole("button", { name: "Cancel export" }).click();
  await expect(preview.getByRole("button", { name: "Wait for latest" })).toBeEnabled();
  await expect.poll(async () => (await fixtureState(page)).phase).toBe("cancelled");
  expect(downloads).toEqual(["intro-snapshot-page-1.svg"]);
  await testInfo.attach("advanced-stale-export-cancelled", { body: await page.screenshot(), contentType: "image/png" });

  const latestDownloadPromise = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Wait for latest" }).click();
  await callFixture(page, { action: "publish-latest" });
  const latestDownload = await latestDownloadPromise;
  expect(latestDownload.suggestedFilename()).toBe("intro-page-1.svg");
  expect(await downloadText(latestDownload)).toContain("Exact export B");
  preview = await waitForPreviewFrame(page);
  await expect(preview.locator(".exact-export")).toHaveAttribute("data-availability", "ready");
  await expect(preview.getByRole("button", { name: "Export exact revision" })).toBeEnabled();
  await expect.poll(async () => (await fixtureState(page)).phase).toBe("complete");
  expect(downloads).toEqual(["intro-snapshot-page-1.svg", "intro-page-1.svg"]);
  await testInfo.attach("advanced-wait-continued-without-second-export-click", { body: await page.screenshot(), contentType: "image/png" });
});

async function callFixture(page: Page, request: ExactExportFixtureRequest): Promise<unknown> {
  return await invokeMmtE2E(page, "exactExport", "fixture", request);
}

async function fixtureState(page: Page): Promise<ExactExportState> {
  return await callFixture(page, { action: "state" }) as ExactExportState;
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
