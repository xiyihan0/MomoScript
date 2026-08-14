import { createHash, randomBytes } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import * as https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_RUNTIME_ARTIFACT_SOURCES } from "../src/runtimeArtifacts.ts";

const cacheRoot = fileURLToPath(new URL("../.runtime-artifacts", import.meta.url));
const publicRoot = fileURLToPath(new URL("../public", import.meta.url));
const publicRuntimeRoot = fileURLToPath(new URL("../public/runtime", import.meta.url));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function validateArtifact(artifact, encoded) {
  if (encoded.byteLength !== artifact.encodedBytes) {
    throw new Error(`${artifact.id}: encoded size ${encoded.byteLength} does not match ${artifact.encodedBytes}`);
  }
  const encodedSha256 = sha256(encoded);
  if (encodedSha256 !== artifact.expectedEncodedSha256) {
    throw new Error(`${artifact.id}: encoded SHA-256 ${encodedSha256} does not match ${artifact.expectedEncodedSha256}`);
  }
  const raw = brotliDecompressSync(encoded);
  if (raw.byteLength !== artifact.rawBytes) {
    throw new Error(`${artifact.id}: decoded size ${raw.byteLength} does not match ${artifact.rawBytes}`);
  }
  const rawSha256 = sha256(raw);
  if (rawSha256 !== artifact.expectedRawSha256) {
    throw new Error(`${artifact.id}: decoded SHA-256 ${rawSha256} does not match ${artifact.expectedRawSha256}`);
  }
}

function downloadEncoded(sourceUrl, artifact) {
  return new Promise((resolve, reject) => {
    const request = https.get(sourceUrl, {
      headers: { "accept-encoding": "identity", "user-agent": "MomoScript-runtime-builder/1" },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${artifact.id}: download returned HTTP ${response.statusCode}`));
        return;
      }
      if (response.headers.location) {
        response.resume();
        reject(new Error(`${artifact.id}: runtime source redirected unexpectedly`));
        return;
      }
      if (response.headers["content-encoding"] !== "br") {
        response.resume();
        reject(new Error(`${artifact.id}: runtime source did not return Content-Encoding: br`));
        return;
      }
      const contentLength = Number(response.headers["content-length"]);
      if (contentLength !== artifact.encodedBytes) {
        response.resume();
        reject(new Error(`${artifact.id}: Content-Length ${contentLength} does not match ${artifact.encodedBytes}`));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.byteLength;
        if (received > artifact.encodedBytes) {
          request.destroy(new Error(`${artifact.id}: encoded body exceeds ${artifact.encodedBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks, received)));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function loadArtifact(source) {
  const { artifact, sourceUrl } = source;
  const cachePath = `${cacheRoot}/${artifact.expectedEncodedSha256}.brotli.bin`;
  try {
    const cached = await readFile(cachePath);
    validateArtifact(artifact, cached);
    return { artifact, cachePath, cache: "hit" };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await rm(cachePath, { force: true });
      console.warn(`${artifact.id}: discarded invalid local cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const encoded = await downloadEncoded(sourceUrl, artifact);
  validateArtifact(artifact, encoded);
  await mkdir(cacheRoot, { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, encoded, { flag: "wx" });
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { artifact, cachePath, cache: "download" };
}

const prepared = [];
for (const source of BUILD_RUNTIME_ARTIFACT_SOURCES) prepared.push(await loadArtifact(source));

await rm(publicRuntimeRoot, { recursive: true, force: true });
for (const entry of prepared) {
  const outputPath = path.resolve(publicRoot, `.${entry.artifact.url}`);
  if (!outputPath.startsWith(`${publicRuntimeRoot}${path.sep}`)) throw new Error(`${entry.artifact.id}: output escapes public/runtime`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await copyFile(entry.cachePath, outputPath);
  console.log(`${entry.artifact.id}: ${entry.cache} ${(entry.artifact.encodedBytes / 1048576).toFixed(2)} MiB -> ${entry.artifact.url}`);
}
