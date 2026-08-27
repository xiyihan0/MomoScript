import { expect, test } from "@playwright/test";

const READY_TIMEOUT = 300_000;

test("cold startup exposes real Tinymist bytes and removes the startup surface", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let resolveRelease: () => void = () => {};
    const release = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    Reflect.set(globalThis, "__mmtReleaseTinymist", resolveRelease);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await nativeFetch(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("tinymist_bg.wasm.brotli.bin") || !response.ok) return response;
      await release;

      const artifact = new Uint8Array(await response.arrayBuffer());
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      const chunkSize = Math.ceil(artifact.byteLength / 12);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (): void => {
            const end = Math.min(artifact.byteLength, offset + chunkSize);
            controller.enqueue(artifact.slice(offset, end));
            offset = end;
            if (offset === artifact.byteLength) {
              controller.close();
              return;
            }
            window.setTimeout(push, 500);
          };
          push();
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const startup = page.locator("#mmt-startup");
  await expect(startup).toBeAttached();
  await expect(startup.locator("#mmt-startup-title")).toHaveText("MomoScript");
  await expect(startup.locator("[data-mmt-startup-stage]")).toHaveCount(4);
  await page.evaluate(() => {
    const release = Reflect.get(globalThis, "__mmtReleaseTinymist");
    if (typeof release !== "function") throw new Error("Tinymist startup gate was not installed");
    release();
  });

  const tinymist = startup.locator('[data-mmt-startup-stage="tinymist"]');
  const progress = tinymist.locator("[data-mmt-startup-resource-progress]");
  await expect.poll(async () => Number(await progress.getAttribute("value"))).toBeGreaterThan(0);
  expect(Number(await progress.getAttribute("value"))).toBeLessThan(100);
  await expect(tinymist.locator("[data-mmt-startup-bytes]")).toContainText("MiB");

  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: READY_TIMEOUT });
  await expect(startup).toHaveCount(0);
});

test("reduced motion removes a warm startup surface without an exit transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const startup = page.locator("#mmt-startup");
  await expect(startup).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: READY_TIMEOUT });
  await expect(startup).toHaveCount(0);
});

test("Tinymist download failure remains visible and never reports completion", async ({ page }) => {
  await page.route("**/tinymist_bg.wasm.brotli.bin", async (route) => {
    await route.fulfill({ status: 503, contentType: "text/plain", body: "runtime unavailable" });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const startup = page.locator("#mmt-startup");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready", { timeout: READY_TIMEOUT });
  await expect(startup).toBeVisible();
  await expect(startup).toHaveAttribute("data-state", "failed");
  const tinymist = startup.locator('[data-mmt-startup-stage="tinymist"]');
  await expect(tinymist).toHaveAttribute("data-state", "failed");
  await expect(tinymist.locator("[data-mmt-startup-detail]")).toContainText("HTTP 503");
  const value = await tinymist.locator("[data-mmt-startup-resource-progress]").getAttribute("value");
  expect(value === null || Number(value) < 100).toBe(true);
  await expect(page.getByText(/内置 Typst 语言服务不可用：.*HTTP 503/)).toHaveCount(1);
});
