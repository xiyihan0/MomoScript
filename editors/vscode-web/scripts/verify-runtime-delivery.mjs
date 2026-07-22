import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/runtimeArtifacts.ts", import.meta.url), "utf8");
const digest = /TINYMIST_WASM_SHA256 = "([0-9a-f]{64})"/.exec(source)?.[1];
const version = /TINYMIST_VERSION = "([^"]+)"/.exec(source)?.[1];
assert(digest, "runtimeArtifacts.ts must pin TINYMIST_WASM_SHA256");
assert(version, "runtimeArtifacts.ts must pin TINYMIST_VERSION");

const baseUrl = `https://mms-pack.xiyihan.cn/wasm/tinymist/${version}/${digest}/tinymist_bg.wasm`;
const candidates = [
  { url: baseUrl, encoding: null },
  { url: `${baseUrl}.br?delivery=br-v1`, encoding: "br" },
];

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, { cache: "no-store" });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

for (const candidate of candidates) {
  const response = await fetchWithRetry(candidate.url);
  assert.equal(response.status, 200, `${candidate.url} must be published`);
  assert.equal(response.headers.get("access-control-allow-origin"), "*", `${candidate.url} must allow browser fetches`);
  assert.equal(response.headers.get("content-type"), "application/wasm", `${candidate.url} must use the WASM MIME type`);
  if (candidate.encoding) {
    assert.equal(response.headers.get("content-encoding"), candidate.encoding, `${candidate.url} must declare Brotli delivery`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actualDigest, digest, `${candidate.url} must decode to the pinned bytes`);
  assert(WebAssembly.validate(bytes), `${candidate.url} must decode to valid WebAssembly`);
  console.log(JSON.stringify({ url: candidate.url, bytes: bytes.byteLength, sha256: actualDigest }));
}
