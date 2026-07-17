import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const moduleSource = await readFile(new URL("../src/runtimeIdentity.ts", import.meta.url), "utf8");
const transpiled = await transform(moduleSource, { loader: "ts", format: "esm", target: "es2022" });
const identity = await import(`data:text/javascript;base64,${Buffer.from(transpiled.code).toString("base64")}`);
const fixtureUrl = new URL("../../../mmt_rs/tests/fixtures/runtime-identity.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const bytes = new TextEncoder();

const logicalSource = await identity.logicalSourceId(fixture.workspaceId, fixture.relativePath);
const sourceContent = await identity.sourceContentKey(logicalSource, bytes.encode(fixture.source));
const entryFile = {
  kind: "generated",
  dependencyOrigin: "authored",
  producerDigest: "producer-v1",
  canonicalOriginRelativePath: "main.typ"
};
const workspaceFile = {
  kind: "workspace",
  logicalWorkspaceId: fixture.workspaceId,
  canonicalWorkspaceRelativePath: "assets/avatar.png"
};
const packageFile = {
  kind: "package",
  namespace: "preview",
  name: "theme",
  version: "1.0.0",
  packageGenerationDigest: "pack-gen",
  canonicalPackageRelativePath: "lib.typ"
};
const files = new Map([
  [packageFile, await identity.canonicalBytesDigest("mmt-file-v1", [bytes.encode("theme")])],
  [entryFile, await identity.canonicalBytesDigest("mmt-file-v1", [bytes.encode("hello")])],
  [workspaceFile, await identity.canonicalBytesDigest("mmt-file-v1", [bytes.encode("png")])]
]);
const mappingDigest = await identity.derivedKey("mmt-source-map-v1", ["identity"]);
const project = await identity.projectSnapshotKey({
  logicalSource,
  sourceContent,
  entryFile,
  files,
  packageGenerations: new Map([["preview/theme:1.0.0", "pack-gen"]]),
  generatedDependencies: new Map([["template", "template-gen"]]),
  projectOptions: new Map([["compiledAt", "none"]]),
  sourceMapDigest: mappingDigest
});
const projection = await identity.projectionKey(sourceContent, "session-a", 7, entryFile, project, mappingDigest);
const materialization = await identity.materializationKey(projection, "pack", "plan", "bytes");
const runtime = await identity.runtimeArtifactKey("0.15.2", "compiler-wasm", "0.7.0", "renderer-wasm", "template", "fonts");
const render = await identity.renderKey(materialization, runtime, "options");
const actual = { logicalSource, sourceContent, project, projection, materialization, runtime, render };

for (const uri of fixture.mountUris) {
  const mounted = new URL(uri);
  const workspaceId = mounted.protocol === "file:" ? mounted.pathname.split("/").filter(Boolean)[0] : mounted.host;
  const segments = mounted.pathname.split("/").filter(Boolean);
  const relativePath = mounted.protocol === "file:" ? segments.slice(1).join("/") : segments.join("/");
  assert.equal(decodeURIComponent(relativePath), fixture.relativePath);
  assert.equal(await identity.logicalSourceId(workspaceId, decodeURIComponent(relativePath)), logicalSource);
}
assert.throws(() => identity.canonicalRelativePath(fixture.mountUris[0]), /Non-canonical/);
assert.throws(() => identity.canonicalRelativePath("file:/workspace/main.typ"), /Non-canonical/);
assert.deepEqual(actual, fixture.expected);
console.log(`runtime identity fixture ok: ${render}`);
