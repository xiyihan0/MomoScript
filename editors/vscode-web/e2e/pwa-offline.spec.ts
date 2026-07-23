import { expect, test } from "./fixtures";

test("installed production editor cold-starts offline with language workers and preview", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect(page.locator(".workbench-editor .monaco-editor").first()).toBeVisible();

  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect(page.locator(".workbench-preview")).toHaveAttribute("data-preview-ready", "true");
  const notoRequests = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((url) => url.includes("NotoSansCJK")));
  expect(notoRequests).toEqual([]);

  const cacheEvidence = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      });
    }
    const source = await (await fetch(registration.active?.scriptURL ?? "/sw.js")).text();
    const localMatch = source.match(/const PRECACHE_URLS = (\[.*?\]);\n/);
    const remoteMatch = source.match(/const IMMUTABLE_PRECACHE_URLS = (\[.*?\]);\n/);
    if (!localMatch || !remoteMatch) throw new Error("generated service-worker manifests are missing");
    const local = JSON.parse(localMatch[1]) as string[];
    const remote = JSON.parse(remoteMatch[1]) as string[];
    const requiredLocal = local.filter((url) => /(?:mmt_lsp_bg|tinymistWorker|browserWorker)/.test(url));
    const required = [...requiredLocal, ...remote];
    const cached = await Promise.all(required.map(async (url) => ({ url, cached: Boolean(await caches.match(url)) })));
    return {
      controller: Boolean(navigator.serviceWorker.controller),
      localCount: local.length,
      remoteCount: remote.length,
      notoLocalCount: local.filter((url) => url.includes("NotoSansCJK")).length,
      mainFontBrotliCount: remote.filter((url) => /MainFont(?:_Bold)?[.]otf[.]br[?]delivery=br-v1$/.test(url)).length,
      wasmBrotliCount: remote.filter((url) => /[.]wasm[.]br[?]delivery=br-v1$/.test(url)).length,
      required: cached,
    };
  });
  expect(cacheEvidence.controller).toBe(true);
  expect(cacheEvidence.localCount).toBeGreaterThan(100);
  expect(cacheEvidence.remoteCount).toBe(4);
  expect(cacheEvidence.notoLocalCount).toBe(0);
  expect(cacheEvidence.mainFontBrotliCount).toBe(2);
  expect(cacheEvidence.wasmBrotliCount).toBe(2);
  expect(cacheEvidence.required.length).toBeGreaterThanOrEqual(7);
  expect(cacheEvidence.required.filter((entry) => !entry.cached)).toEqual([]);

  await page.goto("about:blank");
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(editor).toBeVisible();

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// offline edit");
  await expect(editor.locator(".view-lines")).toContainText("offline edit");

  await page.getByRole("button", { name: "Typst 预览" }).click();
  await expect(page.locator(".workbench-preview")).toHaveAttribute("data-preview-ready", "true", { timeout: 300_000 });
  await expect(page.getByRole("status").getByRole("button", { name: /MomoScript: ready/ })).toBeVisible();

  await page.getByRole("status").getByRole("button", { name: /显示或隐藏 MomoScript 日志/ }).click();
  const output = page.locator(".workbench-panel");
  await expect(output).toContainText(/Typst\s+编译器\s+WASM\s+下载完成/);
  await expect(output).toContainText("[preview:identity]");
});
