import { expect, invokeMmtE2E, test, waitForPreviewFrame } from "./fixtures";

test("installed production editor cold-starts offline with language workers and preview", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  await expect(page.locator(".workbench-editor .monaco-editor").first()).toBeVisible();

  await page.getByRole("button", { name: "Typst 预览" }).click();
  await waitForPreviewFrame(page);
  const notoRequests = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((url) => url.includes("NotoSansCJK")));
  expect(notoRequests).toEqual([]);

  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  });
  if (!controlled) {
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  }
  const cacheEvidence = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) throw new Error("installed service worker does not control the production page");
    const source = await (await fetch(registration.active?.scriptURL ?? "/sw.js")).text();
    const localMatch = source.match(/const PRECACHE_URLS = (\[.*?\]);\n/);
    if (!localMatch) throw new Error("generated service-worker manifest is missing");
    const local = JSON.parse(localMatch[1]) as string[];
    const requiredLocal = local.filter((url) => /(?:mmt_lsp_bg|tinymistWorker|browserWorker)/.test(url));
    const runtime = local.filter((url) => url.endsWith(".brotli.bin"));
    const required = [...requiredLocal, ...runtime];
    const cached = await Promise.all(required.map(async (url) => ({ url, cached: Boolean(await caches.match(url)) })));
    return {
      controller: Boolean(navigator.serviceWorker.controller),
      localCount: local.length,
      runtimeCount: runtime.length,
      notoLocalCount: local.filter((url) => url.includes("NotoSansCJK")).length,
      mainFontBrotliCount: runtime.filter((url) => /MainFont(?:_Bold)?[.]otf[.]brotli[.]bin$/.test(url)).length,
      wasmBrotliCount: runtime.filter((url) => /[.]wasm[.]brotli[.]bin$/.test(url)).length,
      required: cached,
    };
  });
  expect(cacheEvidence.controller).toBe(true);
  expect(cacheEvidence.localCount).toBeGreaterThan(100);
  expect(cacheEvidence.runtimeCount).toBe(4);
  expect(cacheEvidence.notoLocalCount).toBe(0);
  expect(cacheEvidence.mainFontBrotliCount).toBe(2);
  expect(cacheEvidence.wasmBrotliCount).toBe(2);
  expect(cacheEvidence.required.length).toBeGreaterThanOrEqual(6);
  expect(cacheEvidence.required.filter((entry) => !entry.cached)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 700 });
  await invokeMmtE2E(page, "workspace", "openDocument", "offline-gui.mmt", "- offline GUI card\n");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", "offline-gui.mmt")).toMatchObject({
    guiVisible: true,
    sourceVisible: false,
    textDocumentCount: 1,
    modelCount: 1,
  });
  await invokeMmtE2E(page, "composer", "keepEditor", "offline-gui.mmt");
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    uri: "mmtfs://workspace/offline-gui.mmt",
    nodeKinds: ["narration"],
    pending: false,
  });

  await page.goto("about:blank");
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: 300_000 });
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", "offline-gui.mmt")).toMatchObject({
    guiVisible: true,
    sourceVisible: false,
    textDocumentCount: 1,
    modelCount: 1,
  });
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    uri: "mmtfs://workspace/offline-gui.mmt",
    nodeKinds: ["narration"],
    pending: false,
  });
  const gui = page.getByRole("region", { name: "MomoScript GUI 创作" });
  await expect(gui.locator(".mmt-composer-card")).toContainText("offline GUI card");
  await gui.getByRole("button", { name: "高级源码" }).click();
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(editor).toBeVisible();

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// offline edit");
  await expect(editor.locator(".view-lines")).toContainText("offline edit");

  await page.getByRole("button", { name: "Typst 预览" }).click();
  await waitForPreviewFrame(page);
  await expect(page.getByRole("status").getByRole("button", { name: /MomoScript: ready/ })).toBeVisible();

  await page.getByRole("status").getByRole("button", { name: /显示或隐藏 MomoScript 日志/ }).click();
  const output = page.locator(".workbench-panel");
  await expect(output).toContainText("[preview:identity]");
});
