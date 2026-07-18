import assert from "node:assert/strict";
import {
  materializeProjectResources,
  MAX_PROJECT_RESOURCE_CONCURRENCY
} from "../../vscode/src/resourceMaterializer.ts";

const source = {
  manifestUrl: "https://packs.example/manifest.json",
  baseUrl: "https://packs.example/",
  json: "{}",
  cacheIdentity: "fixture"
};
const resource = (id, frame) => ({
  kind: "image-sequence",
  id,
  uri: `untitled:/resources/frame-${frame}.png`,
  packNamespace: "fixture",
  path: "same-sequence.avifs",
  frame,
  sha256: "abc123",
  size: [1, 1],
  frameCount: 2,
  container: "avifs",
  codec: "av1",
  alpha: true,
  profile: { codec: "aom" },
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
});
const project = {
  sourceUri: "mmtfs://workspace/story.mmt",
  sourceVersion: 1,
  revision: 1,
  entryUri: "untitled:/main.typ",
  files: [],
  full: true,
  resources: [resource(1, 0), resource(2, 1)]
};
const values = new Map();
const cache = {
  get: (key) => values.get(key),
  set: (key, value) => values.set(key, value)
};
let fetches = 0;
const decodedInputs = [];
let activeDecoders = 0;
let maxActiveDecoders = 0;
const dependencies = {
  resourceUrl: (_source, request) => new URL(request.path, source.baseUrl),
  fetch: async () => {
    fetches += 1;
    return new Uint8Array([1, 2, 3]);
  },
  decodeSequence: async (bytes, request) => {
    activeDecoders += 1;
    maxActiveDecoders = Math.max(maxActiveDecoders, activeDecoders);
    await Promise.resolve();
    decodedInputs.push([...bytes]);
    const transferred = bytes.buffer;
    structuredClone(transferred, { transfer: [transferred] });
    assert.equal(bytes.byteLength, 0, "the Worker simulation must detach its per-frame copy");
    activeDecoders -= 1;
    return new Uint8Array([request.frame + 10]);
  },
  encodeBase64: (bytes) => [...bytes].join(","),
  decodeBase64: (value) => Uint8Array.from(value.split(",").map(Number))
};
const result = await materializeProjectResources(
  project,
  new Map([["fixture", source]]),
  cache,
  new AbortController().signal,
  dependencies
);

assert.deepEqual(result.diagnostics, []);
assert.equal(fetches, 1, "two frames from one sequence must fetch the AVIFS once per materialization");
assert.deepEqual(decodedInputs, [[1, 2, 3], [1, 2, 3]], "each decoder must receive an intact copy");
assert.deepEqual(result.project.files.map((file) => file.dataBase64), ["10", "11"]);
assert.equal(MAX_PROJECT_RESOURCE_CONCURRENCY, 1);
assert.equal(maxActiveDecoders, 1, "resource decoders must remain sequential");

const countLimited = await materializeProjectResources(
  project,
  new Map([["fixture", source]]),
  { get: () => undefined, set: () => {} },
  new AbortController().signal,
  dependencies,
  { maxResources: 1, maxBytes: 100 }
);
assert.equal(countLimited.project.files.length, 0);
assert.match(countLimited.diagnostics[0].message, /2 resources; limit is 1/);
assert.equal(countLimited.diagnostics[0].phase, "fetch");
assert.equal(countLimited.diagnostics[0].range, undefined, "project-wide count budgets must stay document-level");

const byteLimited = await materializeProjectResources(
  { ...project, resources: [resource(3, 0)] },
  new Map([["fixture", source]]),
  { get: () => undefined, set: () => {} },
  new AbortController().signal,
  dependencies,
  { maxResources: 2, maxBytes: 5 }
);
assert.equal(byteLimited.project.files.length, 0);
assert.match(byteLimited.diagnostics[0].message, /memory budget exceeds 5 bytes/);
assert.equal(byteLimited.diagnostics[0].phase, "fetch");
assert.equal(byteLimited.diagnostics[0].range, undefined, "project-wide byte budgets must stay document-level");

const failedFetch = await materializeProjectResources(
  { ...project, resources: [resource(4, 0)] },
  new Map([["fixture", source]]),
  { get: () => undefined, set: () => {} },
  new AbortController().signal,
  { ...dependencies, fetch: async () => { throw new Error("network unavailable"); } }
);
assert.deepEqual(failedFetch.diagnostics.map(({ phase }) => phase), ["fetch"]);
assert.match(failedFetch.diagnostics[0].message, /network unavailable/);
assert.deepEqual(failedFetch.diagnostics[0].range, resource(4, 0).range);
assert.deepEqual(failedFetch.diagnostics[0].dependency, {
  kind: "image-sequence",
  id: 4,
  packNamespace: "fixture"
});

const failedDecode = await materializeProjectResources(
  { ...project, resources: [resource(5, 0)] },
  new Map([["fixture", source]]),
  { get: () => undefined, set: () => {} },
  new AbortController().signal,
  { ...dependencies, decodeSequence: async () => { throw new Error("invalid AVIFS"); } }
);
assert.deepEqual(failedDecode.diagnostics.map(({ phase }) => phase), ["decode"]);
assert.match(failedDecode.diagnostics[0].message, /invalid AVIFS/);
assert.deepEqual(failedDecode.diagnostics[0].range, resource(5, 0).range);
assert.equal(failedDecode.diagnostics[0].dependency.id, 5);

console.log(JSON.stringify({
  materializationFetches: fetches,
  decoderCopies: decodedInputs.length,
  maxActiveDecoders,
  countBudget: true,
  byteBudget: true,
  fetchPhase: true,
  decodePhase: true
}));
