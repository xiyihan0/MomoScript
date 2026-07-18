import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(root, "dist", "test", "projectedProviderPayload.mjs");
await build({
  entryPoints: [path.join(root, "src", "test", "projectedProviderPayload.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: output,
  logLevel: "silent"
});
await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
