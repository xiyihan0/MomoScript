import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const pin = JSON.parse(await readFile(new URL("../../../third_party/tinymist/pin.json", import.meta.url), "utf8"));
const tinymistVendor = path.join("vendor", `tinymist-${pin.upstream.version}`);
const tinymistArtifacts = [pin.artifacts.webJs, pin.artifacts.webWasm].map((artifact) => ({
  name: path.basename(artifact.relativePath),
  size: artifact.size,
  digest: artifact.sha256
}));
const tinymistArtifactNames = tinymistArtifacts.map(({ name }) => name);
const tinymistChecksums = await readChecksumManifest(
  path.join(root, tinymistVendor, "SHA256SUMS"),
  "Tinymist"
);
requireExactChecksumEntries(tinymistChecksums, tinymistArtifactNames, "Tinymist");
for (const { name, digest } of tinymistArtifacts) {
  if (tinymistChecksums.get(name) !== digest) {
    throw new Error(`${tinymistVendor}/SHA256SUMS: ${name} does not match the maintained Tinymist pin`);
  }
}
const expected = [
  ...tinymistArtifacts.map(({ name, size, digest }) => [
    path.join(tinymistVendor, name),
    size,
    digest
  ]),
  ["vendor/fonts/NotoSansCJK-Regular.ttc", 19_484_784, "b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a"],
  ["vendor/fonts/NotoSansCJK-Bold.ttc", 20_050_760, "faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb"],
  ["vendor/fonts/DejaVuSansMono.ttf", 343_140, "c805f9436dbc268644c1d9584f01a601a653e028e08fd74b9b949f6cf8304d88"]
];

for (const [relative, size, digest] of expected) {
  const filename = path.join(root, relative);
  const metadata = await stat(filename);
  if (metadata.size !== size) throw new Error(`${relative}: expected ${size} bytes, got ${metadata.size}`);
  const actual = createHash("sha256").update(await readFile(filename)).digest("hex");
  if (actual !== digest) throw new Error(`${relative}: sha256 ${actual} does not match ${digest}`);
}

const mmtArtifacts = ["mmt_lsp.js", "mmt_lsp_bg.wasm", "mmt_lsp.d.ts"];
const mmtChecksums = await readChecksumManifest(
  path.join(root, "vendor", "mmt-lsp", "SHA256SUMS"),
  "MMT"
);
requireExactChecksumEntries(mmtChecksums, mmtArtifacts, "MMT");
for (const name of mmtArtifacts) {
  const filename = path.join(root, "vendor", "mmt-lsp", name);
  const actual = createHash("sha256").update(await readFile(filename)).digest("hex");
  const digest = mmtChecksums.get(name);
  if (actual !== digest) throw new Error(`vendor/mmt-lsp/${name}: sha256 ${actual} does not match ${digest}`);
}

const wasmOutput = path.join(root, "wasm");
await mkdir(wasmOutput, { recursive: true });
for (const name of mmtArtifacts) {
  await copyFile(path.join(root, "vendor", "mmt-lsp", name), path.join(wasmOutput, name));
}

console.log(`verified ${expected.length + mmtArtifacts.length} browser language-service artifacts`);

async function readChecksumManifest(filename, label) {
  const lines = (await readFile(filename, "utf8")).trim().split("\n").filter(Boolean);
  const checksums = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match) throw new Error(`invalid ${label} checksum line: ${line}`);
    if (checksums.has(match[2])) throw new Error(`duplicate ${label} checksum entry: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function requireExactChecksumEntries(checksums, expectedNames, label) {
  const expected = new Set(expectedNames);
  if (expected.size !== expectedNames.length) throw new Error(`${label} artifact names must be unique`);
  if (checksums.size !== expected.size || [...expected].some((name) => !checksums.has(name))) {
    throw new Error(`${label} checksum manifest must contain exactly: ${expectedNames.join(", ")}`);
  }
}
