import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = await build({
  stdin: {
    contents: "export * from './src/projectedEditProtocol.ts';",
    resolveDir: root,
    sourcefile: "projected-edit-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent"
});
const protocol = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
assert.equal(protocol.PROJECTED_EDIT_PROTOCOL_VERSION, 1);

const transaction = Object.freeze({
  protocolVersion: protocol.PROJECTED_EDIT_PROTOCOL_VERSION,
  documents: Object.freeze([Object.freeze({
    virtualUri: "mmtfs://projection/story.typ",
    sourceContent: "source-v1",
    projectionKey: "projection-v1",
    encoding: "utf-16"
  })]),
  edits: Object.freeze([
    Object.freeze({
      virtualUri: "mmtfs://projection/story.typ",
      range: Object.freeze({
        start: Object.freeze({ line: 0, character: 6 }),
        end: Object.freeze({ line: 0, character: 8 })
      }),
      newText: "safe"
    }),
    Object.freeze({
      virtualUri: "mmtfs://projection/story.typ",
      range: Object.freeze({
        start: Object.freeze({ line: 0, character: 7 }),
        end: Object.freeze({ line: 0, character: 9 })
      }),
      newText: "overlap"
    })
  ]),
  expectedVersions: Object.freeze([
    Object.freeze({ uri: "FILE://localhost/workspace/./story.mmt", version: 7 }),
    Object.freeze({ uri: "file:///workspace/%73tory.mmt", version: 7 })
  ])
});
assert.equal(transaction.documents[0].encoding, "utf-16");
assert.deepEqual(transaction.edits.map((edit) => edit.range.start.character), [6, 7]);
assert.equal(transaction.expectedVersions.length, 2, "URI aliases remain explicit for Rust duplicate rejection");

const failures = [
  { kind: "UnsafeEdit", reason: "CrossSegment" },
  { kind: "StaleProjection", reason: "DocumentVersionChanged" },
  { kind: "ReadOnlyTarget", uri: "file:///dependency.typ" },
  { kind: "CapabilityUnavailable" }
];
assert.deepEqual(failures.map((failure) => failure.kind), [
  "UnsafeEdit",
  "StaleProjection",
  "ReadOnlyTarget",
  "CapabilityUnavailable"
]);
console.log("projected edit protocol fixture: ok");
