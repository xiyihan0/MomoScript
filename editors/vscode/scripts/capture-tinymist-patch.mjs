import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const source = path.resolve(process.argv[2] ?? "");
const mode = process.argv[3] ?? "package";
if (!process.argv[2] || !["package", "renderer"].includes(mode)) {
  throw new Error("usage: node capture-tinymist-patch.mjs <patched-tinymist-source> [package|renderer]");
}
const revision = "e54ace4f49a84baf60d9d1b059fd0cab7a780295";
const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: source });
if (head.trim() !== revision) throw new Error(`Tinymist source must be at ${revision}`);
let patch;
let destination;
if (mode === "package") {
  ({ stdout: patch } = await exec(
    "git",
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--", "crates"],
    { cwd: source, maxBuffer: 16 * 1024 * 1024 }
  ));
  if (!patch.includes("mmt/typstPackageRequest.v1") || !patch.includes("package_callback.rs")) {
    throw new Error("source diff does not contain the versioned package callback patch");
  }
  destination = path.join(root, "third_party", "tinymist", "patches", "0001-mmt-host-package-callback.patch");
} else {
  const temporary = await mkdtemp(path.join(tmpdir(), "mmt-tinymist-patch-"));
  const index = path.join(temporary, "index");
  const environment = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await exec("git", ["read-tree", "HEAD"], { cwd: source, env: environment });
    const packagePatch = path.join(root, "third_party", "tinymist", "patches", "0001-mmt-host-package-callback.patch");
    await readFile(packagePatch);
    await exec("git", ["apply", "--cached", "--whitespace=nowarn", packagePatch], {
      cwd: source,
      env: environment,
      maxBuffer: 16 * 1024 * 1024
    });
    await exec("git", ["add", "--intent-to-add", "--", "crates/tinymist/src/preview_renderer.rs", "crates/tinymist/src/preview_location.rs"], {
      cwd: source,
      env: environment
    });
    ({ stdout: patch } = await exec(
      "git",
      ["diff", "--binary", "--full-index", "--no-ext-diff", "--", "Cargo.lock", "crates"],
      { cwd: source, env: environment, maxBuffer: 16 * 1024 * 1024 }
    ));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (!patch.includes("mmt/previewRenderer.v1")
    || !patch.includes("preview_renderer.rs")
    || !patch.includes("preview_location.rs")
    || !patch.includes("locatePoint")) {
    throw new Error("source diff does not contain the versioned preview renderer and location-provider patch");
  }
  destination = path.join(root, "third_party", "tinymist", "patches", "0002-mmt-preview-renderer.patch");
}
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, patch);
console.log(destination);
