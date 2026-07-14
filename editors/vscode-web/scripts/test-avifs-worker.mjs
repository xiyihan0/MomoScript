import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerAsset = (await readdir(join(root, "dist/assets"))).find((name) => /^avifSequenceWorker-.*\.js$/.test(name));
if (!workerAsset) throw new Error("built AVIFS Worker asset is missing");
const fixturePath = join(root, "../../mmt_rs/tests/fixtures/avifs/alpha-sequence.avifs");
const expectedSha256 = "a3d12e6399f79b05ddd33fb30a42190702f0954a61a19af93d0d329d909d2123";

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    } else if (request.url === "/worker.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(join(root, "dist/assets", workerAsset)));
    } else if (request.url === "/fixture.avifs") {
      response.writeHead(200, { "Content-Type": "image/avif" }).end(await readFile(fixturePath));
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind AVIFS test server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async ({ expectedSha256 }) => {
    const source = await (await fetch("/fixture.avifs")).arrayBuffer();
    const worker = new Worker("/worker.js", { type: "module" });
    const validProfile = {
      encoder: "avifenc",
      codec: "aom",
      qcolor: 80,
      qalpha: 80,
      yuv: "420",
      keyframe_interval: 30,
      fps: 1,
      speed: 8,
      jobs: "4"
    };
    const request = (id, sha256, frame = 0, profile = validProfile) => {
      const bytes = source.slice(0);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("AVIFS Worker timed out")), 15_000);
        const listener = (event) => {
          if (event.data.id !== id) return;
          clearTimeout(timeout);
          worker.removeEventListener("message", listener);
          resolve(event.data);
        };
        worker.addEventListener("message", listener);
        worker.postMessage({ id, bytes, frame, sha256, size: [1002, 896], profile }, [bytes]);
      });
    };
    const inspectPng = async (buffer) => {
      const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let alphaMin = 255;
      let alphaMax = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        alphaMin = Math.min(alphaMin, pixels[index]);
        alphaMax = Math.max(alphaMax, pixels[index]);
      }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return { alphaMin, alphaMax, digest };
    };
    const decoded = await request(1, expectedSha256, 0);
    if (decoded.error) throw new Error(decoded.error);
    const png = new Uint8Array(decoded.png);
    const signature = Array.from(png.slice(0, 8));
    const frame0 = await inspectPng(decoded.png);
    const decodedFrame1 = await request(2, expectedSha256, 1);
    if (decodedFrame1.error) throw new Error(decodedFrame1.error);
    const frame1 = await inspectPng(decodedFrame1.png);
    const rejected = await request(3, "0".repeat(64));
    const invalidProfile = await request(4, expectedSha256, 0, { ...validProfile, yuv: "411" });
    worker.terminate();
    return {
      signature,
      pngBytes: png.byteLength,
      frame0,
      frame1,
      mismatchError: rejected.error,
      profileError: invalidProfile.error
    };
  }, { expectedSha256 });
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (JSON.stringify(result.signature) !== JSON.stringify(pngSignature)) throw new Error("decoded frame is not PNG");
  if (result.pngBytes < 100) throw new Error("decoded PNG is unexpectedly empty");
  if (result.frame0.alphaMin >= 255 || result.frame0.alphaMax === 0) throw new Error("decoded AVIFS frame lost usable alpha");
  if (result.frame0.digest === result.frame1.digest) throw new Error("AVIFS frame selection returned the same image");
  if (!result.mismatchError?.includes("SHA-256 mismatch")) throw new Error("digest mismatch was not rejected");
  if (!result.profileError?.includes("420, 422, or 444")) throw new Error("unsupported AVIFS profile was not rejected");
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
