import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = JSON.parse(await readFile(path.join(root, "../../mmt_lsp/tests/fixtures/position-domains.json"), "utf8"));
const bundle = await build({
  stdin: {
    contents: "export * from './src/typstPosition.ts';",
    resolveDir: root,
    sourcefile: "position-domains-entry.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent"
});
const positions = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const {
  LineIndex,
  PositionConversionError,
  mmtClientPosition,
  parseProjectedPosition,
  retainedBackendPosition,
  validatePositionBearingPayload,
  wireBackendPosition
} = positions;

const index = new LineIndex(fixture.text);
for (const boundary of fixture.boundaries) {
  const client = mmtClientPosition({ line: boundary.line, character: boundary.utf8 }, "utf-8");
  const backend = index.convertClient(client, "utf-16");
  assert.deepEqual(wireBackendPosition(backend), { line: boundary.line, character: boundary.utf16 });
  assert.deepEqual(
    index.byteToClient(index.backendToByte(backend), "utf-8").value,
    client.value
  );
}

for (const family of fixture.families) {
  const first = fixture.boundaries[1];
  const last = fixture.boundaries.at(-2);
  const payload = {
    family,
    range: {
      start: index.convertClient(mmtClientPosition({ line: first.line, character: first.utf8 }, "utf-8"), "utf-16"),
      end: index.convertClient(mmtClientPosition({ line: last.line, character: last.utf8 }, "utf-8"), "utf-16")
    }
  };
  assert.equal(payload.range.start.encoding, "utf-16", `${family} start lost its domain`);
  assert.equal(payload.range.end.encoding, "utf-16", `${family} end lost its domain`);
}

function expectFailure(reason, action) {
  assert.throws(action, (error) => error instanceof PositionConversionError && error.reason === reason);
}
expectFailure("SplitUtf8CodePoint", () => {
  index.clientToByte(mmtClientPosition({ line: 0, character: 1 }, "utf-8"));
});
expectFailure("SplitUtf16Surrogate", () => {
  index.clientToByte(mmtClientPosition({ line: 0, character: 7 }, "utf-16"));
});
expectFailure("InvalidLine", () => {
  index.clientToByte(mmtClientPosition({ line: 99, character: 0 }, "utf-16"));
});

const retainedIdentity = {
  sourceContent: "source-content-7",
  projectDigest: "project-7",
  projectionKey: "projection-7"
};

const entryUri = "untitled:/retained/main-7.typ";
const route = parseProjectedPosition({
  entryUri,
  revision: 7,
  position: { line: 0, character: 8 },
  positionEncoding: "utf-16",
  ...retainedIdentity
});
const generation = {
  entryUri,
  revision: 7,
  files: [{ uri: entryUri, text: fixture.text }],
  ...retainedIdentity
};
assert.deepEqual(wireBackendPosition(retainedBackendPosition(route, generation).position), route.position);
expectFailure("AbsentGeneration", () => retainedBackendPosition(route, undefined));
expectFailure("StaleProjection", () => retainedBackendPosition(route, { ...generation, revision: 8 }));
expectFailure("ProjectionMismatch", () => retainedBackendPosition(route, { ...generation, entryUri: "untitled:/other.typ" }));
expectFailure("AbsentGeneration", () => retainedBackendPosition(route, { ...generation, files: [] }));
expectFailure("AmbiguousEncoding", () => parseProjectedPosition({ ...route, positionEncoding: "utf-32" }));

const validRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 8 }
};
const splitSurrogateRange = {
  start: { line: 0, character: 7 },
  end: { line: 0, character: 8 }
};
const reversedRange = {
  start: { line: 0, character: 8 },
  end: { line: 0, character: 0 }
};
expectFailure("SplitUtf16Surrogate", () => validatePositionBearingPayload(
  "completion",
  [{ label: "unsafe", textEdit: { range: splitSurrogateRange, newText: "x" } }],
  index,
  "utf-16"
));
expectFailure("InvalidCharacter", () => validatePositionBearingPayload(
  "hover",
  { contents: "unsafe", range: reversedRange },
  index,
  "utf-16"
));
expectFailure("InvalidLine", () => validatePositionBearingPayload(
  "diagnostics",
  [{ message: "unsafe", range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } } }],
  index,
  "utf-16"
));
expectFailure("SplitUtf16Surrogate", () => validatePositionBearingPayload(
  "symbols",
  [{ name: "unsafe", range: validRange, selectionRange: splitSurrogateRange }],
  index,
  "utf-16"
));
expectFailure("SplitUtf16Surrogate", () => validatePositionBearingPayload(
  "semanticTokens",
  { data: [0, 7, 1, 0, 0] },
  index,
  "utf-16"
));

console.log(JSON.stringify({ checked: true, boundaries: fixture.boundaries.length, families: fixture.families }));
