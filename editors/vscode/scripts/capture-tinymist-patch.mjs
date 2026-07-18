import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const source = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node capture-tinymist-patch.mjs <patched-tinymist-source>");
const revision = "3d63da4f93c54ddef0c63e1a6237d67aee13f5fe";
const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: source });
if (head.trim() !== revision) throw new Error(`Tinymist source must be at ${revision}`);
const { stdout: patch } = await exec(
  "git",
  ["diff", "--binary", "--full-index", "--no-ext-diff", "--", "crates"],
  { cwd: source, maxBuffer: 16 * 1024 * 1024 }
);
if (!patch.includes("mmt/typstPackageRequest.v1") || !patch.includes("package_callback.rs")) {
  throw new Error("source diff does not contain the versioned package callback patch");
}
const destination = path.join(root, "third_party", "tinymist", "patches", "0001-mmt-host-package-callback.patch");
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, patch);
console.log(destination);
