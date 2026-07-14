import assert from "node:assert/strict";
import { fetchSequenceOnce, sequenceFetchKey } from "../src/resourceFetchCache.ts";

const pending = new Map();
const url = new URL("https://packs.example/sequence.avifs");
const key = sequenceFetchKey(url, "abc123");
let loads = 0;
const loader = async () => {
  loads += 1;
  await Promise.resolve();
  return new Uint8Array([1, 2, 3]);
};
const [first, second] = await Promise.all([
  fetchSequenceOnce(pending, key, loader),
  fetchSequenceOnce(pending, key, loader)
]);
assert.equal(loads, 1, "concurrent frames must share one sequence download");
assert.equal(first, second, "the shared immutable bytes must be reused before per-Worker slicing");
assert.equal(await fetchSequenceOnce(pending, key, loader), first);
assert.equal(loads, 1, "resolved downloads must remain reusable within one materialization");

const rejected = new Map();
let attempts = 0;
const flaky = async () => {
  attempts += 1;
  if (attempts === 1) throw new Error("network failed");
  return new Uint8Array([4]);
};
await assert.rejects(fetchSequenceOnce(rejected, key, flaky), /network failed/);
assert.equal(rejected.size, 0, "rejected downloads must be evicted");
assert.deepEqual(await fetchSequenceOnce(rejected, key, flaky), new Uint8Array([4]));
assert.equal(attempts, 2);

console.log(JSON.stringify({ deduplicated: true, rejectedPromisesEvicted: true }));
