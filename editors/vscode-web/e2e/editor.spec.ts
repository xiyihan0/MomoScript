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
  const local = testInfo.project.name === "local";
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
  const baselineRevision = await preview.getAttribute("data-preview-revision");
  const baselineShadowCount = Number(await preview.getAttribute("data-preview-shadow-count"));
  expect(Number.isSafeInteger(baselineShadowCount)).toBe(true);

  const firstAsset = page.waitForResponse((response) => isPackAsset(response));
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(authored);
  await expect(page.locator(".workbench-editor .view-lines")).toContainText("E2E persisted avatar message");
  const firstAssetResponse = await firstAsset;
  expect(firstAssetResponse.ok(), `pack asset returned HTTP ${firstAssetResponse.status()}`).toBe(true);
  await expect(preview).not.toHaveAttribute("data-preview-revision", baselineRevision ?? "");
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expect(preview.locator('img[alt="Rendered MomoScript preview"]')).toBeVisible();
  const authoredShadowCount = Number(await preview.getAttribute("data-preview-shadow-count"));
  expect(authoredShadowCount).toBeGreaterThan(baselineShadowCount);
  await expect.poll(() => persistedStory(page)).toBe(authored);

  const secondAsset = page.waitForResponse((response) => isPackAsset(response));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect(page.locator(".workbench-editor .view-lines")).toContainText("E2E persisted avatar message");
  const secondAssetResponse = await secondAsset;
  expect(secondAssetResponse.ok(), `reloaded pack asset returned HTTP ${secondAssetResponse.status()}`).toBe(true);
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expect(preview.locator('img[alt="Rendered MomoScript preview"]')).toBeVisible();
  await expect(preview).toHaveAttribute("data-preview-shadow-count", String(authoredShadowCount));

  if (local) {
    expect(manifestRequests).toBe(2);
    expect(avatarRequests).toBe(2);
  }
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
