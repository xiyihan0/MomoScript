import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

await rm("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info"
};
const tinymistPackage = process.env.TINYMIST_WEB_PKG
  ? path.resolve(process.env.TINYMIST_WEB_PKG)
  : undefined;

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
    define: { MMT_TINYMIST_WEB_AVAILABLE: JSON.stringify(Boolean(tinymistPackage)) },
    loader: { ".wasm": "file" }
  }),
  build({
    ...common,
    entryPoints: ["src/browserWorker.ts"],
    outfile: "dist/browserWorker.js",
    platform: "browser",
    format: "iife",
    define: { "import.meta.url": "self.location.href" },
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
