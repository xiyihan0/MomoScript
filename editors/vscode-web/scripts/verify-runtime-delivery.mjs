import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/runtimeArtifacts.ts", import.meta.url), "utf8");
const digest = /TINYMIST_WASM_SHA256 = "([0-9a-f]{64})"/.exec(source)?.[1];
const version = /TINYMIST_VERSION = "([^"]+)"/.exec(source)?.[1];
const origin = /export const RUNTIME_ORIGIN = "([^"]+)"/.exec(source)?.[1];
assert(digest, "runtimeArtifacts.ts must pin TINYMIST_WASM_SHA256");
assert(version, "runtimeArtifacts.ts must pin TINYMIST_VERSION");
assert(origin, "runtimeArtifacts.ts must pin RUNTIME_ORIGIN");
const vendor = new URL(`../../vscode/vendor/tinymist-${version}/tinymist_bg.wasm`, import.meta.url);
const localBytes = new Uint8Array(await readFile(vendor));
const localDigest = createHash("sha256").update(localBytes).digest("hex");
assert.equal(localDigest, digest, "vendored Tinymist WASM must match the pinned runtime digest");
assert(WebAssembly.validate(localBytes), "vendored Tinymist WASM must be valid");
console.log(JSON.stringify({
  delivery: "vendor-pin",
  url: vendor.pathname,
  bytes: localBytes.byteLength,
  sha256: localDigest,
}));

if (process.env.MMT_VERIFY_REMOTE_TINYMIST === "1") {
  const baseUrl = `${origin}/wasm/tinymist/${version}/${digest}/tinymist_bg.wasm`;
  const candidates = [
    { url: baseUrl, encoding: null },
    { url: `${baseUrl}.br?delivery=br-v1`, encoding: "br" },
  ];
  for (const candidate of candidates) {
    const response = await fetch(candidate.url, { cache: "no-store" });
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
    console.log(JSON.stringify({ delivery: "remote", url: candidate.url, bytes: bytes.byteLength, sha256: actualDigest }));
  }
}
