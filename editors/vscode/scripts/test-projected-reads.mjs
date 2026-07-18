import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/test/projectedReads.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
  external: ["vscode"]
});
const output = result.outputFiles[0]?.text;
if (!output) throw new Error("Projected-read fixture did not build");
await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
