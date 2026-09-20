import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const pinPath = path.join(root, "third_party", "tinymist", "pin.json");
const pin = JSON.parse(await readFile(pinPath, "utf8"));
const revision = pin.upstream?.revision;
if (pin.schema !== "mmt-tinymist-pin.v1" || !/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error("Tinymist pin has no valid upstream revision");
}
const patchPath = `third_party/tinymist/patches/${mode === "package"
  ? "0001-mmt-host-package-callback.patch"
  : "0002-mmt-preview-renderer.patch"}`;
const entries = pin.patches.filter((entry) => entry.path === patchPath);
if (entries.length !== 1) throw new Error(`Tinymist pin must contain exactly one ${patchPath}`);
for (const entry of pin.patches) {
  if (entry === entries[0]) continue;
  const digest = sha256(await readFile(path.join(root, entry.path)));
  if (digest !== entry.sha256) throw new Error(`${entry.path}: sha256 ${digest} != ${entry.sha256}`);
}
const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: source });
if (head.trim() !== revision) throw new Error(`Tinymist source must be at ${revision}`);
let patch;
const destination = path.join(root, patchPath);
if (mode === "package") {
  ({ stdout: patch } = await exec(
    "git",
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--", "crates"],
    { cwd: source, maxBuffer: 16 * 1024 * 1024 }
  ));
  if (!patch.includes("mmt/typstPackageRequest.v1") || !patch.includes("package_callback.rs")) {
    throw new Error("source diff does not contain the versioned package callback patch");
  }
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
    await exec("git", ["add", "--intent-to-add", "--",
      "crates/tinymist/src/preview_renderer.rs",
      "crates/tinymist/src/preview_location.rs",
      "crates/tinymist/src/preview_text_geometry.rs",
      "crates/tinymist-query/src/fixtures/jump_nested_frame_round_trip/nested_baseline.typ"], {
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
    || !patch.includes("preview_text_geometry.rs")
    || !patch.includes("locatePoint")
    || !/hitTestText|HitTestText/.test(patch)
    || !/locateCaret|LocateCaret/.test(patch)
    || !/locateRange|LocateRange/.test(patch)) {
    throw new Error("source diff does not contain the versioned preview renderer and location-provider patch");
  }
}
const patchBytes = Buffer.from(patch, "utf8");
entries[0].sha256 = sha256(patchBytes);
const checksums = [
  ...pin.patches.map((entry) => `${entry.sha256}  ${path.relative(path.dirname(pinPath), path.join(root, entry.path))}`),
  ...Object.values(pin.artifacts).map((entry) => `${entry.sha256}  ${entry.relativePath}`)
].join("\n") + "\n";
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, patchBytes);
await writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
await writeFile(path.join(path.dirname(pinPath), "SHA256SUMS"), checksums);
console.log(JSON.stringify({ path: destination, sha256: entries[0].sha256, bytes: patchBytes.byteLength }));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
