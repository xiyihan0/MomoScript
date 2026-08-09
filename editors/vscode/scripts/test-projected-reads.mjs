import { readFile } from "node:fs/promises";

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
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const fixture = JSON.parse(await readFile(
  new URL("../../../mmt_rs/tests/fixtures/projection-mapping-kinds.json", import.meta.url),
  "utf8",
));
module.assertProjectionMappingKindFixture(fixture.wireKinds);
