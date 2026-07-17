import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = await build({
  stdin: {
    contents: "export * from './src/typstProtocol.ts'; export * from './src/typstPosition.ts';",
    resolveDir: root,
    sourcefile: "response-identity-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent"
});
const identity = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const {
  PositionConversionError,
  SourceStaleTokenRegistry,
  captureTypstRequestIdentity,
  parseProjectedPosition,
  retainedBackendPosition,
  typstRequestIdentityIsCurrent
} = identity;

const uri = "file:///workspace/main.mmt";
const entryUri = "untitled:/mmt-projection/source/session/main-7.typ";
const project = {
  sourceContent: "source-content-a",
  projectDigest: "project-a",
  projectionKey: "projection-a",
  entryUri,
  revision: 7,
  files: [{ uri: entryUri, text: "#let 中文 = [é 😀]" }]
};
const tokens = new SourceStaleTokenRegistry();
const firstToken = tokens.open(uri, 1);
const request = captureTypstRequestIdentity(project, firstToken, 4);
const current = () => ({ project, staleToken: tokens.current(uri), backendGeneration: 4 });
assert.equal(typstRequestIdentityIsCurrent(request, current()), true);

const dependencyAdvanced = {
  ...project,
  projectDigest: "project-b",
  projectionKey: "projection-b"
};
assert.equal(
  typstRequestIdentityIsCurrent(request, { ...current(), project: dependencyAdvanced }),
  false,
  "unchanged document accepted a response for an older dependency graph"
);
assert.equal(
  typstRequestIdentityIsCurrent(request, { ...current(), backendGeneration: 5 }),
  false,
  "retired backend generation remained publishable"
);

tokens.close(uri);
const reopenedToken = tokens.open(uri, 1);
assert.notEqual(reopenedToken.documentIncarnation, firstToken.documentIncarnation);
assert.equal(
  typstRequestIdentityIsCurrent(request, current()),
  false,
  "close/reopen reused the old document incarnation"
);
const reopenedRequest = captureTypstRequestIdentity(project, reopenedToken, 4);
assert.deepEqual(
  {
    sourceContent: reopenedRequest.sourceContent,
    projectDigest: reopenedRequest.projectDigest,
    projectionKey: reopenedRequest.projectionKey
  },
  {
    sourceContent: request.sourceContent,
    projectDigest: request.projectDigest,
    projectionKey: request.projectionKey
  },
  "host URI/incarnation/version entered a canonical derived key"
);

const route = parseProjectedPosition({
  entryUri,
  revision: 7,
  position: { line: 0, character: 4 },
  positionEncoding: "utf-16",
  sourceContent: project.sourceContent,
  projectDigest: project.projectDigest,
  projectionKey: project.projectionKey
});
const retained = retainedBackendPosition(route, project);
assert.equal(retained.index.text, project.files[0].text);
assert.throws(
  () => retainedBackendPosition(route, dependencyAdvanced),
  (error) => error instanceof PositionConversionError && error.reason === "ProjectionMismatch"
);
assert.throws(
  () => retainedBackendPosition(route, { ...project, files: [] }),
  (error) => error instanceof PositionConversionError && error.reason === "AbsentGeneration"
);

console.log(JSON.stringify({ checked: true, closeRetirement: true, completeProjectGuard: true }));
