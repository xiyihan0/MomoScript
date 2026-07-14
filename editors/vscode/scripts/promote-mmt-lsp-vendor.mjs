import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "wasm");
const vendor = path.join(root, "vendor", "mmt-lsp");
const artifacts = ["mmt_lsp.js", "mmt_lsp_bg.wasm", "mmt_lsp.d.ts"];

await mkdir(vendor, { recursive: true });
const checksums = [];
for (const name of artifacts) {
  const source = path.join(output, name);
  const target = path.join(vendor, name);
  await copyFile(source, target);
  const digest = createHash("sha256").update(await readFile(target)).digest("hex");
  checksums.push(`${digest}  ${name}`);
}

const checksumFile = path.join(vendor, "SHA256SUMS");
const temporary = `${checksumFile}.tmp-${process.pid}`;
await writeFile(temporary, `${checksums.join("\n")}\n`, "utf8");
await rename(temporary, checksumFile);
console.log(`promoted ${artifacts.length} MMT language-service artifacts`);
