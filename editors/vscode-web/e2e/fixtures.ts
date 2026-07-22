import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base } from "@playwright/test";

const tinymistPackage = process.env.TINYMIST_WEB_PKG;
const tinymistWasm = tinymistPackage
  ? await readFile(path.join(tinymistPackage, "tinymist_bg.wasm"))
  : undefined;
const typstCompilerPackage = process.env.TYPST_COMPILER_WEB_PKG;
const typstCompilerWasm = typstCompilerPackage
  ? await readFile(path.join(typstCompilerPackage, "typst_ts_web_compiler_bg.wasm"))
  : undefined;

export const test = base.extend({
  page: async ({ page }, use) => {
    if (tinymistWasm) {
      await page.route("https://mms-pack.xiyihan.cn/wasm/tinymist/**", async (route) => {
        await route.fulfill({
          status: 200,
          body: tinymistWasm,
          contentType: "application/wasm",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      });
    }
    if (typstCompilerWasm) {
      await page.route("https://mms-pack.xiyihan.cn/wasm/typst-ts-web-compiler/**", async (route) => {
        await route.fulfill({
          status: 200,
          body: typstCompilerWasm,
          contentType: "application/wasm",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      });
    }
    await use(page);
  },
});

export { expect };
export type { Download, Frame, Locator, Page, Response } from "@playwright/test";
