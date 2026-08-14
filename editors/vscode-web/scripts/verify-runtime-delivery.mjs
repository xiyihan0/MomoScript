import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import {
  BUILD_RUNTIME_ARTIFACT_SOURCES,
  BUNDLED_RUNTIME_ARTIFACTS,
} from "../src/runtimeArtifacts.ts";
import { isRuntimeArtifactDecodeResponse } from "../src/runtimeArtifactDecodeProtocol.ts";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const urls = new Set();
let encodedTotal = 0;
let rawTotal = 0;

assert.equal(BUNDLED_RUNTIME_ARTIFACTS.length, 4, "runtime catalog must contain the four required artifacts");
assert.equal(BUILD_RUNTIME_ARTIFACT_SOURCES.length, BUNDLED_RUNTIME_ARTIFACTS.length);

for (const artifact of BUNDLED_RUNTIME_ARTIFACTS) {
  assert.match(artifact.url, /^\/runtime\/[0-9a-f]{64}\/[^/]+[.]brotli[.]bin$/);
  assert(!urls.has(artifact.url), `runtime URL must be unique: ${artifact.url}`);
  urls.add(artifact.url);
  assert.equal(new URL(artifact.url, "https://workbench.invalid").origin, "https://workbench.invalid");

  const encoded = await readFile(new URL(`../public${artifact.url}`, import.meta.url));
  assert.equal(encoded.byteLength, artifact.encodedBytes, `${artifact.id} encoded size`);
  assert.equal(sha256(encoded), artifact.expectedEncodedSha256, `${artifact.id} encoded SHA-256`);

  const raw = brotliDecompressSync(encoded);
  assert.equal(raw.byteLength, artifact.rawBytes, `${artifact.id} decoded size`);
  assert.equal(sha256(raw), artifact.expectedRawSha256, `${artifact.id} decoded SHA-256`);
  if (artifact.mediaType === "application/wasm") {
    assert(WebAssembly.validate(raw), `${artifact.id} must decode to valid WebAssembly`);
  }
  encodedTotal += encoded.byteLength;
  rawTotal += raw.byteLength;
}

for (const source of BUILD_RUNTIME_ARTIFACT_SOURCES) {
  assert(BUNDLED_RUNTIME_ARTIFACTS.includes(source.artifact), `${source.artifact.id} source must use the runtime descriptor`);
  assert.equal(new URL(source.sourceUrl).protocol, "https:");
  assert.match(source.sourceUrl, /[.]br[?]delivery=br-v1$/);
}

const decoderPackage = JSON.parse(await readFile(
  new URL("../node_modules/tiny-brotli-dec-wasm/package.json", import.meta.url),
  "utf8",
));
assert.equal(decoderPackage.version, "1.0.1", "Brotli decoder version must remain pinned");
const decoderWasm = await readFile(
  new URL("../node_modules/tiny-brotli-dec-wasm/build/tiny-brotli-dec-wasm.wasm", import.meta.url),
);
assert(WebAssembly.validate(decoderWasm), "bundled Brotli decoder must be valid WebAssembly");
assert.equal(
  sha256(decoderWasm),
  "bfa2ce496f9d4030c18ce2839898edf69243f7e31b1e45d24f747fda92833c69",
  "bundled Brotli decoder SHA-256",
);

assert.equal(isRuntimeArtifactDecodeResponse({ type: "success", id: 1, bytes: new ArrayBuffer(1) }), true);
assert.equal(isRuntimeArtifactDecodeResponse({ type: "error", id: 2, error: "decode failed" }), true);
assert.equal(isRuntimeArtifactDecodeResponse({ type: "success", id: 0, bytes: new ArrayBuffer(1) }), false);
assert.equal(isRuntimeArtifactDecodeResponse({ type: "success", id: 1, bytes: new Uint8Array(1) }), false);
assert.equal(isRuntimeArtifactDecodeResponse({ type: "error", id: 1, error: "" }), false);
assert.equal(isRuntimeArtifactDecodeResponse({ type: "ready", id: 1 }), false);

console.log(JSON.stringify({
  delivery: "same-origin-brotli-bin",
  artifacts: BUNDLED_RUNTIME_ARTIFACTS.length,
  encodedBytes: encodedTotal,
  rawBytes: rawTotal,
  decoderVersion: decoderPackage.version,
  decoderBytes: decoderWasm.byteLength,
}));
