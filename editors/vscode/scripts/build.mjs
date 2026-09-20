import { createHash } from "node:crypto";
import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

await rm("dist", { recursive: true, force: true });

const tinymistPackage = process.env.TINYMIST_WEB_PKG
  ? path.resolve(process.env.TINYMIST_WEB_PKG)
  : undefined;
const tinymistWebSha256 = tinymistPackage
  ? createHash("sha256").update(await readFile(path.join(tinymistPackage, "tinymist_bg.wasm"))).digest("hex")
  : "";
const common = {
  bundle: true,
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
  define: { MMT_TINYMIST_WEB_SHA256: JSON.stringify(tinymistWebSha256) }
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs"
  }),
  build({
    ...common,
    entryPoints: ["src/extension.web.ts"],
    outfile: "dist/extension.web.js",
    platform: "browser",
    format: "cjs",
    define: {
      ...common.define,
      MMT_TINYMIST_WEB_AVAILABLE: JSON.stringify(Boolean(tinymistPackage))
    },
    loader: { ".wasm": "dataurl" }
  }),
  build({
    ...common,
    entryPoints: ["src/browserWorker.ts"],
    outfile: "dist/browserWorker.js",
    platform: "browser",
    format: "iife",
    define: {
      ...common.define,
      "import.meta.url": "self.location.href"
    },
    loader: { ".wasm": "file" }
  }),
  build({
    ...common,
    entryPoints: ["src/tinymistWorker.ts"],
    outfile: "dist/tinymistWorker.js",
    platform: "browser",
    format: "iife"
  }),
  build({
    ...common,
    entryPoints: ["src/test/suite/index.ts"],
    outfile: "dist/test/suite/index.js",
    platform: "browser",
    format: "cjs"
  }),
  build({
    ...common,
    entryPoints: ["src/test/suite/index.ts"],
    outfile: "dist/test/desktop/index.js",
    platform: "node",
    format: "cjs"
  }),
  build({
    ...common,
    entryPoints: ["src/test/processClient.ts"],
    outfile: "dist/test/processClient.js",
    platform: "node",
    format: "cjs"
  }),
  build({
    ...common,
    entryPoints: ["src/test/packageService.ts"],
    outfile: "dist/test/packageService.js",
    platform: "node",
    format: "cjs"
  }),
  build({
    ...common,
    entryPoints: ["src/test/packageTranscriptHost.ts"],
    outfile: "dist/test/packageTranscriptHost.js",
    platform: "browser",
    format: "iife",
    globalName: "MmtPackageTranscript"
  }),
  build({
    ...common,
    entryPoints: ["src/test/workerClient.ts"],
    outfile: "dist/test/workerClient.js",
    platform: "browser",
    format: "iife"
  })
]);

if (tinymistPackage) {
  const output = path.resolve("dist", "tinymist");
  await mkdir(output, { recursive: true });
  await Promise.all(
    ["tinymist.js", "tinymist_bg.wasm"].map((name) =>
      copyFile(path.join(tinymistPackage, name), path.join(output, name))
    )
  );
}
