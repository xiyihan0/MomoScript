import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliDecompressSync } from "node:zlib";

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pinPath = path.join(root, "third_party", "tinymist", "pin.json");
const pin = JSON.parse(await readFile(pinPath, "utf8"));
const source = path.resolve(process.env.TINYMIST_SRC ?? "");
const mode = process.argv[2] ?? "verify";
if (!process.env.TINYMIST_SRC) throw new Error("TINYMIST_SRC must name a Tinymist checkout");
if (!new Set(["apply", "verify", "build-promote", "promote", "repin"]).has(mode)) {
  throw new Error("usage: node patch-tinymist-artifacts.mjs apply|verify|build-promote|promote|repin");
}
if (pin.schema !== "mmt-tinymist-pin.v1"
  || pin.toolchain?.rust !== "1.92.0"
  || pin.toolchain?.wasmPack !== "0.15.0") {
  throw new Error("Tinymist artifacts require the maintained Rust 1.92.0 / wasm-pack 0.15.0 pin");
}

const patches = pin.patches.map((entry) => ({
  ...entry,
  absolutePath: path.join(root, entry.path)
}));
for (const patch of patches) await verifyFile(patch.absolutePath, { sha256: patch.sha256 });
const { stdout: head } = await run("git", ["rev-parse", "HEAD"], source, true);
if (head.trim() !== pin.upstream.revision) {
  throw new Error(`Tinymist HEAD ${head.trim()} does not match ${pin.upstream.revision}`);
}

const finalPatch = patches.at(-1);
if (!finalPatch) throw new Error("Tinymist pin has no maintained patches");
const seriesApplied = await succeeds("git", ["apply", "--reverse", "--check", finalPatch.absolutePath], source);
if (!seriesApplied) {
  const { stdout: status } = await run("git", ["status", "--porcelain"], source, true);
  if (status.trim()) throw new Error("Tinymist checkout must be clean before applying the maintained patch series");
  for (const patch of patches) {
    await run("git", ["apply", "--check", patch.absolutePath], source);
    await run("git", ["apply", patch.absolutePath], source);
  }
}
if (!(await succeeds("git", ["apply", "--reverse", "--check", finalPatch.absolutePath], source))) {
  throw new Error(`maintained Tinymist patch series is not reversible after apply: ${finalPatch.path}`);
}

if (mode === "verify" || mode === "build-promote") {
  await requireVersion("rustc", [`+${pin.toolchain.rust}`, "--version"], /^rustc (\S+)/, pin.toolchain.rust);
}

if (mode === "verify") {
  await run("cargo", [`+${pin.toolchain.rust}`, "check", "-p", "tinymist", "--locked", "--no-default-features", "--features", "system,no-content-hint"], source);
  await run("cargo", [`+${pin.toolchain.rust}`, "check", "-p", "tinymist", "--locked", "--target", "wasm32-unknown-unknown", "--no-default-features", "--features", "web,no-content-hint"], source);
}

if (mode === "build-promote") {
  await requireVersion("wasm-pack", ["--version"], /^wasm-pack (\S+)/, pin.toolchain.wasmPack);
  // wasm-pack 0.15 uses PATH's wasm-opt before its unpinned download fallback.
  // Requiring this executable prevents both an accidental upgrade and fallback.
  await requireVersion("wasm-opt", ["--version"], /^wasm-opt version (\d+)(?:\s|$)/, "116");
  await run("cargo", [`+${pin.toolchain.rust}`, "build", "--locked", "--release", "--bin", "tinymist"], source);
  await run(
    "wasm-pack",
    ["build", "--target", "web", "--release", "--", "--locked", "--no-default-features", "--features", "web,no-content-hint"],
    path.join(source, pin.build.webWorkingDirectory),
    false,
    { RUSTUP_TOOLCHAIN: pin.toolchain.rust }
  );
}

let promotedArtifacts = pin.artifacts;
let runtimePublication;
if (mode === "build-promote" || mode === "promote" || mode === "repin") {
  const nativePath = path.join(source, pin.artifacts.native.relativePath);
  const jsPath = path.join(source, pin.artifacts.webJs.relativePath);
  const wasmPath = path.join(source, pin.artifacts.webWasm.relativePath);
  const nativeArtifact = await describeFile(nativePath);
  const jsArtifact = await describeFile(jsPath);
  const wasmArtifact = await describeFile(wasmPath);
  await requireVersion(nativePath, ["-V"], /^tinymist (\S+)/, pin.upstream.version);
  await run(process.execPath, ["--check", jsPath], source);
  if (!WebAssembly.validate(await readFile(wasmPath))) {
    throw new Error(`${wasmPath}: invalid WebAssembly module`);
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

  // Builds only stamp their own outputs. Canonical pin/vendor/runtime promotion
  // is a single explicit repin operation, including local immutable delivery.
  if (mode === "repin") {
    runtimePublication = await repinArtifacts(promotedArtifacts, nativePath, jsPath, wasmPath);
  }
}

console.log(JSON.stringify({ applied: true, mode, revision: pin.upstream.revision, artifacts: promotedArtifacts, runtimePublication }));

async function describeFile(filename) {
  const info = await stat(filename);
  if (!info.isFile() || info.size === 0) throw new Error(`${filename}: missing or empty artifact`);
  const bytes = await readFile(filename);
  if (bytes.byteLength !== info.size) throw new Error(`${filename}: artifact changed while reading`);
  return { sha256: sha256(bytes), size: bytes.byteLength };
}

async function verifyFile(filename, expected) {
  const artifact = await describeFile(filename);
  if (artifact.sha256 !== expected.sha256) throw new Error(`${filename}: sha256 ${artifact.sha256} != ${expected.sha256}`);
  if (expected.size !== undefined && artifact.size !== expected.size) {
    throw new Error(`${filename}: size mismatch`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireVersion(command, args, pattern, expected) {
  const { stdout } = await run(command, args, source, true);
  if (pattern.exec(stdout.trim())?.[1] !== expected) {
    throw new Error(`${command}: expected version ${expected}, received ${stdout.trim()}`);
  }
}

function replaceOnce(text, pattern, replacement, label) {
  if ([...text.matchAll(pattern)].length !== 1) {
    throw new Error(`runtimeArtifacts.ts must contain exactly one ${label}`);
  }
  return text.replace(pattern, typeof replacement === "function" ? replacement : () => replacement);
}

function updateTinymistDescriptor(text, update) {
  return replaceOnce(text, /export const TINYMIST_WASM_ARTIFACT = bundledArtifact\(\{\n([\s\S]*?)\n\}\);/g,
    (_, fields) => {
      if (!/^\s+id: "tinymist-wasm",$/m.test(fields)
        || !/^\s+encoding: "brotli",$/m.test(fields)
        || !/^\s+expectedRawSha256: TINYMIST_WASM_SHA256,$/m.test(fields)
        || !/^\s+mediaType: "application\/wasm",$/m.test(fields)) {
        throw new Error("runtimeArtifacts.ts has an unsupported Tinymist descriptor");
      }
      return `export const TINYMIST_WASM_ARTIFACT = bundledArtifact({\n${update(fields)}\n});`;
    }, "Tinymist runtime descriptor");
}

function updateDecodedRuntime(text, artifact) {
  text = replaceOnce(text, /^export const TINYMIST_VERSION = "[^"]+";$/gm,
    `export const TINYMIST_VERSION = ${JSON.stringify(pin.upstream.version)};`, "Tinymist version");
  text = replaceOnce(text, /^export const TINYMIST_WASM_SHA256 = "[0-9a-f]{64}";$/gm,
    `export const TINYMIST_WASM_SHA256 = "${artifact.sha256}";`, "Tinymist decoded digest");
  return updateTinymistDescriptor(text, (fields) => replaceOnce(fields, /^  rawBytes: [\d_]+,$/gm,
    `  rawBytes: ${artifact.size},`, "Tinymist decoded size"));
}

function updateEncodedRuntime(text, encoded, url) {
  text = updateTinymistDescriptor(text, (fields) => {
    fields = replaceOnce(fields, /^  url: "[^"]+",$/gm,
      `  url: ${JSON.stringify(url)},`, "Tinymist runtime URL");
    fields = replaceOnce(fields, /^  expectedEncodedSha256: "[0-9a-f]{64}",$/gm,
      `  expectedEncodedSha256: "${encoded.sha256}",`, "Tinymist encoded digest");
    return replaceOnce(fields, /^  encodedBytes: [\d_]+,$/gm,
      `  encodedBytes: ${encoded.bytes},`, "Tinymist encoded size");
  });
  // The decoded pin remains the sole authority for the CDN object path. The
  // publication manifest is checked against that path before this is called.
  return replaceOnce(text, /    artifact: TINYMIST_WASM_ARTIFACT,\n    sourceUrl: `[^\n]+`,/g,
    '    artifact: TINYMIST_WASM_ARTIFACT,\n    sourceUrl: `${RUNTIME_ORIGIN}/wasm/tinymist/${TINYMIST_VERSION}/${TINYMIST_WASM_SHA256}/tinymist_bg.wasm.br?delivery=br-v1`,',
    "Tinymist publication source");
}

async function readPublication(output, artifact) {
  const manifestPath = path.join(output, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const prefix = `wasm/tinymist/${pin.upstream.version}/${artifact.sha256}`;
  if (manifest.schema !== "mmt-runtime-publication.v1"
    || manifest.runtime !== "tinymist"
    || manifest.version !== pin.upstream.version
    || manifest.decodedSha256 !== artifact.sha256
    || manifest.decodedBytes !== artifact.size
    || manifest.objectPrefix !== prefix
    || !Array.isArray(manifest.objects)
    || manifest.objects.length !== 2) {
    throw new Error(`${manifestPath}: publication identity does not match the built Tinymist WASM`);
  }
  let encoded;
  let encodedBytes;
  for (const delivery of ["identity", "br-v1"]) {
    const objects = manifest.objects.filter((object) => object?.delivery === delivery);
    if (objects.length !== 1) throw new Error(`${manifestPath}: expected one ${delivery} object`);
    const object = objects[0];
    const name = delivery === "identity" ? "tinymist_bg.wasm" : "tinymist_bg.wasm.br";
    if (object.localPath !== path.join(output, name)
      || object.objectName !== `${prefix}/${name}`
      || !/^[0-9a-f]{64}$/.test(object.sha256)
      || !Number.isSafeInteger(object.bytes) || object.bytes <= 0
      || object.metadata?.["Content-Type"] !== "application/wasm"
      || object.metadata?.["Content-Encoding"] !== (delivery === "br-v1" ? "br" : undefined)
      || object.metadata?.["Cache-Control"] !== "public,max-age=31536000,immutable") {
      throw new Error(`${manifestPath}: invalid ${delivery} object`);
    }
    const bytes = await readFile(object.localPath);
    if (sha256(bytes) !== object.sha256 || bytes.byteLength !== object.bytes) {
      throw new Error(`${object.localPath}: publication bytes do not match the manifest`);
    }
    const decoded = delivery === "identity" ? bytes : brotliDecompressSync(bytes);
    if (decoded.byteLength !== artifact.size || sha256(decoded) !== artifact.sha256) {
      throw new Error(`${object.localPath}: decoded publication does not match the built Tinymist WASM`);
    }
    if (delivery === "br-v1") {
      encoded = object;
      encodedBytes = bytes;
    }
  }
  return { manifestPath, encoded, encodedBytes };
}

async function installImmutable(filename, bytes) {
  try {
    const existing = await readFile(filename);
    if (!existing.equals(bytes)) throw new Error(`${filename}: immutable artifact already exists with different bytes`);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes, { flag: "wx" });
}

async function repinArtifacts(artifacts, nativePath, jsPath, wasmPath) {
  const extensionRoot = path.join(root, "editors", "vscode");
  const fixtureRoot = path.join(extensionRoot, "src", "test", "fixtures");
  const runtimePath = path.join(root, "editors", "vscode-web", "src", "runtimeArtifacts.ts");
  const runtime = updateDecodedRuntime(await readFile(runtimePath, "utf8"), artifacts.webWasm);
  const vendor = path.join(extensionRoot, "vendor", `tinymist-${pin.upstream.version}`);
  const checksumsPath = path.join(root, "third_party", "tinymist", "SHA256SUMS");
  const nativeChecksumPath = path.join(fixtureRoot, "tinymist-native-patched.sha256");
  const nativeEvidencePath = path.join(fixtureRoot, "tinymist-native-evidence.json");
  const webEvidencePath = path.join(fixtureRoot, "tinymist-web-evidence.json");
  const navigationEvidencePath = path.join(fixtureRoot, "typst-navigation-evidence.json");
  const richQualificationPath = path.join(fixtureRoot, "tinymist-rich-provider-qualification.json");
  const capabilityManifestPath = path.join(fixtureRoot, "tinymist-capability-manifest.json");
  const artifactDecisionPath = path.join(fixtureRoot, "tinymist-artifact-decision.json");
  const providerQualificationPath = path.join(extensionRoot, "src", "tinymistProviderQualification.generated.ts");
  const output = path.join(root, ".tmp", "runtime-publication", "tinymist");
  const canonicalFiles = [
    pinPath, runtimePath, checksumsPath, nativeChecksumPath,
    path.join(vendor, "tinymist.js"), path.join(vendor, "tinymist_bg.wasm"), path.join(vendor, "SHA256SUMS"),
    nativeEvidencePath, webEvidencePath, navigationEvidencePath,
    richQualificationPath, capabilityManifestPath, artifactDecisionPath, providerQualificationPath
  ];
  const backup = await mkdtemp(path.join(tmpdir(), "mmt-tinymist-repin-"));
  const originals = new Map();
  try {
    for (const [index, filename] of canonicalFiles.entries()) {
      const saved = path.join(backup, String(index));
      try {
        await copyFile(filename, saved);
        originals.set(filename, saved);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        originals.set(filename, null);
      }
    }
    try {
      // The publication owner requires decoded runtime identity to agree with
      // the pin. Roll both back if preparation or any later promotion fails.
      await writeFile(pinPath, `${JSON.stringify({ ...pin, artifacts }, null, 2)}\n`);
      await writeFile(runtimePath, runtime);
      await run(process.execPath, [
        path.join(root, "tools", "cdn", "publish_tinymist_runtime.mjs"),
        "--source", wasmPath, "--output", output
      ], root);
      const publication = await readPublication(output, artifacts.webWasm);
      const url = `/runtime/${publication.encoded.sha256}/tinymist_bg.wasm.brotli.bin`;
      const promotedRuntime = updateEncodedRuntime(runtime, publication.encoded, url);
      const cachePath = path.join(root, "editors", "vscode-web", ".runtime-artifacts", `${publication.encoded.sha256}.brotli.bin`);
      const publicPath = path.join(root, "editors", "vscode-web", "public", url.slice(1));
      await installImmutable(cachePath, publication.encodedBytes);
      await installImmutable(publicPath, publication.encodedBytes);
      await mkdir(vendor, { recursive: true });
      await copyFile(jsPath, path.join(vendor, "tinymist.js"));
      await copyFile(wasmPath, path.join(vendor, "tinymist_bg.wasm"));
      await verifyFile(path.join(vendor, "tinymist.js"), artifacts.webJs);
      await verifyFile(path.join(vendor, "tinymist_bg.wasm"), artifacts.webWasm);
      await writeFile(path.join(vendor, "SHA256SUMS"),
        `${artifacts.webJs.sha256}  tinymist.js\n${artifacts.webWasm.sha256}  tinymist_bg.wasm\n`);
      await writeFile(nativeChecksumPath, `${artifacts.native.sha256}  tinymist\n`);
      await writeFile(checksumsPath, [
        ...patches.map((patch) => `${patch.sha256}  ${path.relative(path.dirname(pinPath), patch.absolutePath)}`),
        ...Object.values(artifacts).map((artifact) => `${artifact.sha256}  ${artifact.relativePath}`)
      ].join("\n") + "\n");
      await writeFile(runtimePath, promotedRuntime);
      const probeEnv = {
        TINYMIST_BIN: nativePath,
        TINYMIST_WEB_PKG: path.dirname(jsPath),
        TINYMIST_SHA256_FILE: path.join(path.dirname(nativePath), "tinymist-native-patched.sha256"),
        TINYMIST_WEB_SHA256_FILE: path.join(path.dirname(jsPath), "SHA256SUMS")
      };
      await run(process.execPath, [path.join(extensionRoot, "scripts", "build.mjs")],
        extensionRoot, false, probeEnv);
      await run(process.execPath, [path.join(extensionRoot, "dist", "test", "processClient.js")],
        extensionRoot, false, {
          ...probeEnv,
          UPDATE_TINYMIST_EVIDENCE: "1",
          UPDATE_TINYMIST_NATIVE_EVIDENCE: "1"
        });
      await run(process.execPath, [path.join(extensionRoot, "scripts", "test-tinymist-worker.mjs")],
        extensionRoot, false, { ...probeEnv, UPDATE_TINYMIST_EVIDENCE: "1" });
      await run(process.execPath, [path.join(extensionRoot, "scripts", "test-navigation-artifacts.mjs")],
        extensionRoot, false, { ...probeEnv, UPDATE_TINYMIST_NAVIGATION_EVIDENCE: "1" });
      const richEvidenceEnv = { ...probeEnv, UPDATE_TINYMIST_RICH_PROVIDER_EVIDENCE: "1" };
      await run(process.execPath, [path.join(extensionRoot, "scripts", "test-rich-provider-artifact.mjs"), "native"],
        extensionRoot, false, richEvidenceEnv);
      await run(process.execPath, [path.join(extensionRoot, "scripts", "test-rich-provider-artifact.mjs"), "worker"],
        extensionRoot, false, richEvidenceEnv);

      const qualification = JSON.parse(await readFile(richQualificationPath, "utf8"));
      qualification.artifacts = {
        ...qualification.artifacts,
        native: artifacts.native.sha256,
        web: artifacts.webWasm.sha256
      };
      await writeFile(richQualificationPath, `${JSON.stringify(qualification, null, 2)}\n`);

      await run(process.execPath, [path.join(extensionRoot, "scripts", "test-capability-manifest.mjs")],
        extensionRoot, false, { ...probeEnv, UPDATE_TINYMIST_CAPABILITY_MANIFEST: "1" });
      const capabilityManifest = JSON.parse(await readFile(capabilityManifestPath, "utf8"));
      const nativeIdentity = capabilityManifest.artifacts?.native;
      const webIdentity = capabilityManifest.artifacts?.web;
      if (nativeIdentity?.digest !== artifacts.native.sha256
        || webIdentity?.digest !== artifacts.webWasm.sha256
        || typeof nativeIdentity?.backendVersion !== "string"
        || nativeIdentity.backendVersion !== webIdentity?.backendVersion) {
        throw new Error("Tinymist capability manifest identity does not match the observed built artifacts");
      }

      const artifactDecision = JSON.parse(await readFile(artifactDecisionPath, "utf8"));
      artifactDecision.artifacts = {
        ...artifactDecision.artifacts,
        nativeDigest: nativeIdentity.digest,
        webDigest: webIdentity.digest,
        backendVersion: nativeIdentity.backendVersion
      };
      await writeFile(artifactDecisionPath, `${JSON.stringify(artifactDecision, null, 2)}\n`);
      await run(process.execPath, [path.join(extensionRoot, "scripts", "test-artifact-decision.mjs")],
        extensionRoot, false, probeEnv);
      return {
        manifestPath: publication.manifestPath,
        decodedSha256: artifacts.webWasm.sha256,
        encodedSha256: publication.encoded.sha256,
        encodedBytes: publication.encoded.bytes,
        url, cachePath, publicPath,
        published: false
      };
    } catch (error) {
      const failures = [error];
      for (const [filename, saved] of originals) {
        try {
          if (saved === null) await rm(filename, { force: true });
          else await copyFile(saved, filename);
        } catch (restoreError) {
          failures.push(restoreError);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Tinymist repin failed and canonical files could not all be restored");
      throw error;
    }
  } finally {
    await rm(backup, { recursive: true, force: true });
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
