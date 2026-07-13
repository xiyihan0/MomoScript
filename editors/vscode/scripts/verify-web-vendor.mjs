import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const expected = [
  ["vendor/tinymist-0.15.2/tinymist.js", 29_720, "f310d8ed520d6ec7000a695f4d15c6e1f1cda5be2ce3b61168f1d8ef7447caa9"],
  ["vendor/tinymist-0.15.2/tinymist_bg.wasm", 32_346_976, "d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454"],
  ["vendor/mmt-lsp/mmt_lsp.js", 9_174, "6c0e0f2e101e16e1afc4ef7ac5ec920740c268a0ddcfa09026249ec23bbc62e8"],
  ["vendor/mmt-lsp/mmt_lsp_bg.wasm", 1_583_955, "0045c91400ff605a57edd5abfcb5cbdf3cc9a28375ba5fe61c2af650a8969bb8"],
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

const wasmOutput = path.join(root, "wasm");
await mkdir(wasmOutput, { recursive: true });
for (const name of ["mmt_lsp.js", "mmt_lsp_bg.wasm", "mmt_lsp.d.ts"]) {
  await copyFile(path.join(root, "vendor", "mmt-lsp", name), path.join(wasmOutput, name));
}

console.log(`verified ${expected.length} browser language-service artifacts`);
