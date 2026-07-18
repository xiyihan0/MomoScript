import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pinPath = path.join(root, "third_party", "tinymist", "pin.json");
const pin = JSON.parse(await readFile(pinPath, "utf8"));
const source = path.resolve(process.env.TINYMIST_SRC ?? "");
const mode = process.argv[2] ?? "verify";
if (!process.env.TINYMIST_SRC) throw new Error("TINYMIST_SRC must name a Tinymist checkout");
if (!new Set(["apply", "verify", "build-promote", "promote"]).has(mode)) {
  throw new Error("usage: node patch-tinymist-artifacts.mjs apply|verify|build-promote|promote");
}

const patchPath = path.join(root, pin.patch.path);
await verifyFile(patchPath, { sha256: pin.patch.sha256 });
const { stdout: head } = await run("git", ["rev-parse", "HEAD"], source, true);
if (head.trim() !== pin.upstream.revision) {
  throw new Error(`Tinymist HEAD ${head.trim()} does not match ${pin.upstream.revision}`);
}

const alreadyApplied = await succeeds("git", ["apply", "--reverse", "--check", patchPath], source);
if (!alreadyApplied) {
  const { stdout: status } = await run("git", ["status", "--porcelain"], source, true);
  if (status.trim()) throw new Error("Tinymist checkout must be clean before applying the maintained patch");
  await run("git", ["apply", "--check", patchPath], source);
  await run("git", ["apply", patchPath], source);
}
if (!(await succeeds("git", ["apply", "--reverse", "--check", patchPath], source))) {
  throw new Error("maintained Tinymist patch is not exactly reversible after apply");
}

if (mode === "verify") {
  await run("cargo", ["+1.92.0", "check", "-p", "tinymist", "--locked", "--no-default-features", "--features", "system,no-content-hint"], source);
  await run("cargo", ["+1.92.0", "check", "-p", "tinymist", "--locked", "--target", "wasm32-unknown-unknown", "--no-default-features", "--features", "web,no-content-hint"], source);
}

if (mode === "build-promote") {
  await run("cargo", ["+1.92.0", "build", "--locked", "--release", "--bin", "tinymist"], source);
  await run(
    "wasm-pack",
    ["build", "--target", "web", "--release", "--", "--locked", "--no-default-features", "--features", "web,no-content-hint"],
    path.join(source, pin.build.webWorkingDirectory),
    false,
    { RUSTUP_TOOLCHAIN: pin.toolchain.rust }
  );
}

let promotedArtifacts = pin.artifacts;
if (mode === "build-promote" || mode === "promote") {
  const nativePath = path.join(source, pin.artifacts.native.relativePath);
  const jsPath = path.join(source, pin.artifacts.webJs.relativePath);
  const wasmPath = path.join(source, pin.artifacts.webWasm.relativePath);
  const nativeArtifact = await describeFile(nativePath);
  const jsArtifact = await describeFile(jsPath);
  const wasmArtifact = await describeFile(wasmPath);
  for (const [filename, artifact] of [
    [nativePath, nativeArtifact],
    [jsPath, jsArtifact],
    [wasmPath, wasmArtifact]
  ]) {
    if (artifact.size === 0) throw new Error(`${filename}: empty artifact`);
  }

  await writeFile(
    path.join(path.dirname(nativePath), "tinymist-native-patched.sha256"),
    `${nativeArtifact.sha256}  tinymist\n`
  );
  await writeFile(
    path.join(path.dirname(jsPath), "SHA256SUMS"),
    `${jsArtifact.sha256}  tinymist.js\n${wasmArtifact.sha256}  tinymist_bg.wasm\n`
  );
  promotedArtifacts = {
    ...pin.artifacts,
    native: { ...pin.artifacts.native, ...nativeArtifact },
    webJs: { ...pin.artifacts.webJs, ...jsArtifact },
    webWasm: { ...pin.artifacts.webWasm, ...wasmArtifact }
  };

  const canonicalWeb = jsArtifact.sha256 === pin.artifacts.webJs.sha256
    && wasmArtifact.sha256 === pin.artifacts.webWasm.sha256;
  if (canonicalWeb) {
    const vendor = path.join(root, "editors", "vscode", "vendor", `tinymist-${pin.upstream.version}`);
    await copyFile(jsPath, path.join(vendor, "tinymist.js"));
    await copyFile(wasmPath, path.join(vendor, "tinymist_bg.wasm"));
    await writeFile(
      path.join(vendor, "SHA256SUMS"),
      `${pin.artifacts.webJs.sha256}  tinymist.js\n${pin.artifacts.webWasm.sha256}  tinymist_bg.wasm\n`
    );
  }

  // Keep this checked manifest canonical-only. Rebuilt native and Web artifacts
  // receive run-local checksum manifests beside their binaries above.
  await writeFile(
    path.join(root, "third_party", "tinymist", "SHA256SUMS"),
    [
      `${pin.patch.sha256}  patches/0001-mmt-host-package-callback.patch`,
      `${pin.artifacts.native.sha256}  ${pin.artifacts.native.relativePath}`,
      `${pin.artifacts.webJs.sha256}  ${pin.artifacts.webJs.relativePath}`,
      `${pin.artifacts.webWasm.sha256}  ${pin.artifacts.webWasm.relativePath}`
    ].join("\n") + "\n"
  );
}

console.log(JSON.stringify({ applied: true, mode, revision: pin.upstream.revision, artifacts: promotedArtifacts }));

async function describeFile(filename) {
  const bytes = await readFile(filename);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: (await stat(filename)).size
  };
}

async function verifyFile(filename, expected) {
  const bytes = await readFile(filename);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.sha256) throw new Error(`${filename}: sha256 ${digest} != ${expected.sha256}`);
  if (expected.size !== undefined && (await stat(filename)).size !== expected.size) {
    throw new Error(`${filename}: size mismatch`);
  }
}

async function succeeds(command, args, cwd) {
  try {
    await exec(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, cwd, capture = false, env = {}) {
  const options = {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
    ...(capture ? {} : { stdio: "inherit" })
  };
  if (capture) return await exec(command, args, options);
  return await new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error) => error ? reject(error) : resolve({ stdout: "", stderr: "" }));
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}
